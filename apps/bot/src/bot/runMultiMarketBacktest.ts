/**
 * Multi-market бэктест: прогоняет каждый снапшот как изолированный рынок
 * и агрегирует результаты.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Для каждого файла: `readSnapshotMeta()` → создать всю инфраструктуру с нуля →
 *    `BacktestEngine.run()` → settlement → собрать результат.
 * 2. После всех рынков: агрегация (total PnL, win rate, best/worst).
 *
 * ### Изоляция между рынками:
 * Каждый рынок получает свежие: ReplayClock, EventBus, Repositories,
 * PaperSimulator, Strategy, Portfolio, CryptoPriceStore. CEX/crypto market
 * history intentionally shared между рынками в хронологическом порядке, чтобы
 * continuous backtest видел тот же rolling context, что paper/live.
 *
 * ### Binance fallback:
 * В multi-market режиме Binance klines fallback **пропускается** —
 * meta из collect-data содержит priceToBeat и finalPrice (locked в BacktestEngine).
 *
 * @example
 * ```typescript
 * await runMultiMarketBacktest(resolvedPaths, config, 0);
 * ```
 */

import path from 'node:path';
import Decimal from 'decimal.js';
import { LogLevel } from '@polymarket/logger';
import type { ILogger } from '@polymarket/logger';
import { ReplayClock } from '@polymarket/time';
import { BacktestEngine } from '@polymarket/backtesting';
import {
  createDefaultCryptoSignalRegistry,
  CryptoMarketDataStore,
  CryptoPriceStore,
} from '@polymarket/market-state';
import { BookUpdateHandler } from '@polymarket/handlers';
import type { IBookRegistry } from '@polymarket/handlers';
import { OrderBook } from '@polymarket/order-book';
import type { OrderBook as OrderBookType } from '@polymarket/order-book';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Balance, Money, Price, Quantity, TimestampService } from '@polymarket/value-objects';
import {
  parseAccountId,
  KnownVenues,
  asPolymarketCtfToken,
} from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { parseCryptoMeta } from '@polymarket/exchange/adapters';
import type { InstrumentInfo } from '@polymarket/ports';
import { SimplePosition } from '@polymarket/use-cases';

import type { BotConfig } from '../config/BotConfig.js';
import { buildCoreInfra } from './buildCoreInfra.js';
import { subscribeToOrderEvents } from './buildEventLogger.js';
import { buildRepositories } from './buildRepositories.js';
import { buildProcessFillUseCase, buildOrderUseCases } from './buildUseCases.js';
import { buildPaperInfra, buildPaperSimulator } from './buildPaperMode.js';
import { buildMarketData } from './buildMarketData.js';
import { buildStrategyEngine } from './buildStrategyEngine.js';
import { readSnapshotMeta } from './readSnapshotMeta.js';
import { createStrategy } from '../strategyFactory.js';
import type { StrategyConfig } from '../strategyFactory.js';
import { SelectiveEntryStrategy } from '../strategies/SelectiveEntryStrategy.js';
import type { RiskParams } from '@polymarket/risk';
import { DecisionJournalRecorder } from '@polymarket/data-collection';
import type { IDecisionJournal } from '@polymarket/ports';

// ── Типы ────────────────────────────────────────────────────────────────────

/** Результат бэктеста одного рынка */
interface MarketBacktestResult {
  readonly file: string;
  readonly question?: string;
  readonly marketId: string;
  readonly instrumentId: string;
  readonly cryptoSymbol?: string;
  readonly strikePrice?: number;
  readonly resolutionPrice?: number;
  readonly resolution?: 'UP' | 'DOWN';
  readonly pnl: Decimal;
  readonly buys: number;
  readonly sells: number;
  readonly completedCycles: number;
  readonly bookEvents: number;
  readonly tradeEvents: number;
  readonly cexBookEvents: number;
  readonly cexTradeEvents: number;
  readonly errors: number;
  readonly durationMs: number;
  readonly buyAttempts: number;
  readonly cancelAfterPlace: number;
  readonly postOnlyRejects: number;
}

function matchesSnapshotFilter(
  rawMarket: Record<string, unknown> | undefined,
  config: BotConfig,
): boolean {
  if (
    (config.market.source !== 'snapshots' && config.market.source !== 'discovery') ||
    !config.market.filter
  ) {
    return true;
  }

  const filter = config.market.filter;
  const question = typeof rawMarket?.['question'] === 'string' ? rawMarket['question'].toLowerCase() : '';
  const eventStartRaw = typeof rawMarket?.['eventStartTime'] === 'string' ? rawMarket['eventStartTime'] : undefined;
  const endDateRaw = typeof rawMarket?.['endDate'] === 'string' ? rawMarket['endDate'] : undefined;
  const eventStartMs = eventStartRaw ? new Date(eventStartRaw).getTime() : NaN;
  const endDateMs = endDateRaw ? new Date(endDateRaw).getTime() : NaN;
  const durationMinutes = !Number.isNaN(eventStartMs) && !Number.isNaN(endDateMs)
    ? (endDateMs - eventStartMs) / 60_000
    : undefined;

  if (filter.requiredKeywords?.length) {
    if (!filter.requiredKeywords.every(keyword => question.includes(keyword.toLowerCase()))) return false;
  }
  if (filter.anyOfKeywords?.length) {
    if (!filter.anyOfKeywords.some(keyword => question.includes(keyword.toLowerCase()))) return false;
  }
  if (filter.excludedKeywords?.length) {
    if (filter.excludedKeywords.some(keyword => question.includes(keyword.toLowerCase()))) return false;
  }
  if (filter.minDurationMinutes !== undefined) {
    if (durationMinutes === undefined || durationMinutes < filter.minDurationMinutes) return false;
  }
  if (filter.maxDurationMinutes !== undefined) {
    if (durationMinutes === undefined || durationMinutes > filter.maxDurationMinutes) return false;
  }

  return true;
}

// ── SimpleBookRegistry (дубль из main.ts, нужен для BookUpdateHandler) ──────

/**
 * Простая in-memory реализация IBookRegistry для backtest режима.
 * @internal
 */
class SimpleBookRegistry implements IBookRegistry {
  private readonly _books = new Map<string, OrderBookType>();
  private _key(mId: MarketId, tId: InstrumentId): string { return `${String(mId)}:${String(tId)}`; }
  get(mId: MarketId, tId: InstrumentId): OrderBookType | undefined { return this._books.get(this._key(mId, tId)); }
  getOrCreate(mId: MarketId, tId: InstrumentId): OrderBookType {
    const key = this._key(mId, tId);
    let book = this._books.get(key);
    if (!book) { book = OrderBook.create(mId, String(tId)); this._books.set(key, book); }
    return book;
  }
  delete(mId: MarketId, tId: InstrumentId): void { this._books.delete(this._key(mId, tId)); }
  deleteMarket(mId: MarketId): void {
    const prefix = `${String(mId)}:`;
    for (const key of [...this._books.keys()]) { if (key.startsWith(prefix)) this._books.delete(key); }
  }
}

// ── Вспомогательные функции ─────────────────────────────────────────────────

/**
 * Строит RiskParams с параметрами по умолчанию для backtest режима.
 * @internal
 */
/**
 * Строит параметры risk-чека из конфигурации бота.
 *
 * @param config - Конфигурация бота
 * @returns RiskParams согласованные со стратегией
 */
function buildRiskParams(config: BotConfig): RiskParams {
  const params = config.strategyParams as unknown as Record<string, unknown>;
  const orderSize = params['orderSize'] instanceof Decimal
    ? (params['orderSize'] as Decimal).toNumber()
    : 10;
  const qMax = typeof params['qMax'] === 'number' ? (params['qMax'] as number) : 5;
  const initialBalance = config.resources.initialBalance;

  return {
    maxOpenOrders: 2,
    maxOrderNotional: new Decimal(initialBalance),
    maxPositionSize: new Decimal(qMax * orderSize),
    maxTotalExposure: new Decimal(initialBalance * 2),
    minAvailableBalance: new Decimal('1'),
    minTimeToExpiryMs: 0,
  };
}

/**
 * Создаёт начальный баланс для портфеля.
 * @internal
 */
function buildInitialBalance(
  initialBalance: number,
  accountId: NonNullable<ReturnType<typeof parseAccountId>>,
): Balance {
  return Balance.of(
    Money.of(new Decimal(initialBalance), 'USDC'),
    Money.of(new Decimal(0), 'USDC'),
    accountId,
    KnownVenues.POLYMARKET,
  );
}

interface SnapshotReplayOrderEntry {
  readonly filePath: string;
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Сортирует snapshot файлы по фактическому времени рынка, а не по файловому
 * порядку. Это важно для continuous CEX history: общий store не должен получать
 * будущие CEX события до более ранних рынков.
 */
async function sortSnapshotPathsForContinuousReplay(
  filePaths: readonly string[],
  outcomeIndex: 0 | 1,
): Promise<string[]> {
  const entries = await Promise.all(filePaths.map(async (filePath, index): Promise<SnapshotReplayOrderEntry> => {
    const meta = await readSnapshotMeta(filePath, outcomeIndex);
    const rawStart = typeof meta?.rawMarket?.['eventStartTime'] === 'string'
      ? meta.rawMarket['eventStartTime']
      : undefined;
    const rawEnd = typeof meta?.rawMarket?.['endDate'] === 'string'
      ? meta.rawMarket['endDate']
      : undefined;
    const startMs = rawStart ? new Date(rawStart).getTime() : NaN;
    const endMs = rawEnd ? new Date(rawEnd).getTime() : NaN;

    return {
      filePath,
      index,
      startMs: Number.isFinite(startMs) ? startMs : Number.POSITIVE_INFINITY,
      endMs: Number.isFinite(endMs) ? endMs : Number.POSITIVE_INFINITY,
    };
  }));

  entries.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    const byPath = a.filePath.localeCompare(b.filePath);
    return byPath !== 0 ? byPath : a.index - b.index;
  });

  return entries.map(entry => entry.filePath);
}

// ── Single-market бэктест ───────────────────────────────────────────────────

/**
 * Запускает изолированный бэктест одного рынка (одного снапшот-файла).
 *
 * @param filePath - Путь к .jsonl или .jsonl.gz файлу
 * @param config - Конфигурация бота (strategy, paper, resources, account)
 * @param outcomeIndex - Индекс outcome (0 = YES, 1 = NO)
 * @param parentLogger - Корневой логгер (создаётся child с контекстом рынка)
 * @returns Результат бэктеста или null если meta не найдена
 *
 * @remarks
 * Пересоздаёт всю инфраструктуру с нуля для полной изоляции:
 * ReplayClock, EventBus, Repositories, PaperSimulator, Strategy, Portfolio.
 */
async function runSingleMarketBacktest(
  filePath: string,
  config: BotConfig,
  outcomeIndex: 0 | 1,
  parentLogger: ILogger,
  sharedCryptoMarketDataStore: CryptoMarketDataStore,
  cexWarmupMs: number,
): Promise<MarketBacktestResult | null> {
  const fileName = path.basename(filePath);

  // 1. Читаем meta
  const meta = await readSnapshotMeta(filePath, outcomeIndex);
  if (!meta) {
    parentLogger.warn('Skipping file — no meta found', { file: fileName });
    return null;
  }

  const { marketId, instrumentId, asset, rawMarket, complementaryInstrumentId } = meta;
  if (!matchesSnapshotFilter(rawMarket, config)) {
    parentLogger.debug('Skipping snapshot by filter', {
      file: fileName,
      question: typeof rawMarket?.['question'] === 'string' ? rawMarket['question'] : undefined,
    });
    return null;
  }

  // 2. Создаём изолированную инфраструктуру
  const replayClock = new ReplayClock(new Date(0));
  const infra = buildCoreInfra({ clock: replayClock, logLevel: LogLevel.WARN });
  const { logger, eventBus } = infra;
  let journal: IDecisionJournal | undefined;
  if (config.recording?.enabled) {
    journal = new DecisionJournalRecorder(
      { journalDir: config.recording.journalDir },
      logger,
    );
  }

  const repos = buildRepositories();
  const { portfolioStore } = repos;
  const riskParams = buildRiskParams(config);

  const accountId = parseAccountId(config.account.accountId);
  if (!accountId) return null;

  // 3. Paper infra + simulator
  const { mockClient } = buildPaperInfra({ clock: replayClock });
  const { processFillUseCase, portfolioService } = buildProcessFillUseCase({ infra, repos });
  const { simulator, exchangeClient } = buildPaperSimulator({
    mockClient,
    processFillUseCase,
    portfolioStore: repos.portfolioStore,
    eventBus,
    clock: replayClock,
    logger,
    instrumentId,
    marketId,
    accountId,
    asset,
    config: config.paper,
  });
  // Регистрируем комплементарный рынок для auto-selection (если нужен)
  if (complementaryInstrumentId) {
    const compAst = asPolymarketCtfToken(String(complementaryInstrumentId));
    if (compAst) {
      exchangeClient.registerMarket(complementaryInstrumentId, marketId, accountId, compAst);
    }
  }

  const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
  const useCases = { processFillUseCase, portfolioService, ...orderUseCases };

  // 4. Market data + catalog
  const { marketDataStore, marketCatalog } = buildMarketData({ infra });

  // 5. Crypto price store
  const cryptoPriceStore = new CryptoPriceStore();
  const cryptoMarketDataStore = sharedCryptoMarketDataStore;
  const cryptoSignalRegistry = createDefaultCryptoSignalRegistry();
  const cryptoMeta = parseCryptoMeta(rawMarket);

  // 6. Strategy engine
  const engine = buildStrategyEngine({
    infra,
    repos,
    useCases,
    marketDataStore,
    marketCatalog,
    cryptoPriceStore,
    cryptoMarketDataStore,
    cryptoSignalRegistry,
  });

  // 7. Регистрация инструмента в каталоге
  const rawEndDateForInstrument = rawMarket?.['endDate'] as string | undefined;
  const endDateMsForInstrument = rawEndDateForInstrument ? new Date(rawEndDateForInstrument).getTime() : NaN;
  const expiresAtResult = TimestampService.create(!Number.isNaN(endDateMsForInstrument) ? endDateMsForInstrument : Date.now() + 86400_000);
  if (!expiresAtResult.ok) return null;
  const instrumentInfo: InstrumentInfo = {
    instrumentId,
    marketId,
    tickSize: Price.of(new Decimal('0.001')),
    minOrderSize: Quantity.of(new Decimal('1')),
    minOrderValue: Quantity.of(new Decimal('1')),
    active: true,
    expiresAt: expiresAtResult.value,
  };
  marketCatalog.register(instrumentInfo);

  // 8. Начальный портфель
  const initialBalanceDecimal = new Decimal(config.resources.initialBalance);
  const initialBalance = buildInitialBalance(config.resources.initialBalance, accountId);
  const portfolioResult = Portfolio.create({
    id: asPortfolioId(`portfolio:${config.account.accountId}`),
    accountId,
    balance: initialBalance,
  });
  if (!portfolioResult.ok) return null;
  portfolioStore.save(portfolioResult.value, 0);

  // 9. BookUpdateHandler
  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);

  // 10. Запуск сервисов
  marketDataStore.start();
  engine.orderEventBridge.start();
  simulator.start();
  engine.scheduler.start();

  // Минимальное логирование (без verbose per-book/trade)
  subscribeToOrderEvents(eventBus, logger, { bookLogEvery: 0, logTrades: false });

  // 11. Трекинг fills
  let buyCount = 0;
  let sellCount = 0;
  const orderToToken = new Map<string, string>();
  const orderToPriceCents = new Map<string, number>();
  const recordedFillIds = new Set<string>();

  eventBus.subscribe('ORDER_CREATED', (event) => {
    const tokenId = String(event.asset ?? '');
    const orderId = String(event.orderId);
    const priceCents = event.price.value().toNumber() * 100;
    if (tokenId) orderToToken.set(orderId, tokenId);
    orderToPriceCents.set(orderId, priceCents);
    journal?.recordOrder({
      marketId: tokenId,
      ts: Date.now(),
      orderId,
      side: event.side as 'BUY' | 'SELL',
      price: event.price.value().toFixed(4),
      size: event.size.value().toFixed(2),
    });
  });

  const computeSlippage = (
    orderId: string,
    fillPriceCents: number,
  ): { orderPriceCents: number; slippageCents: number } | undefined => {
    const orderPrice = orderToPriceCents.get(orderId);
    if (orderPrice === undefined) return undefined;
    return { orderPriceCents: orderPrice, slippageCents: fillPriceCents - orderPrice };
  };

  eventBus.subscribe('ORDER_FILLED', (event) => {
    const fillId = String(event.fill.id);
    if (recordedFillIds.has(fillId)) return;
    recordedFillIds.add(fillId);

    if (event.fill.side === 'BUY') buyCount++;
    else sellCount++;

    const price = event.fill.price.value();
    const size = event.fill.size.value();
    const orderId = String(event.orderId);
    const tokenId = orderToToken.get(orderId) ?? '';
    const slippage = computeSlippage(orderId, price.toNumber() * 100);
    journal?.recordFill({
      marketId: tokenId,
      ts: Date.now(),
      orderId,
      side: event.fill.side as 'BUY' | 'SELL',
      price: price.toFixed(4),
      size: size.toFixed(2),
      notional: price.times(size).toFixed(4),
      partial: false,
      ...slippage,
    });
    orderToPriceCents.delete(orderId);
  });

  eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    const fillId = String(event.fill.id);
    if (recordedFillIds.has(fillId)) return;
    recordedFillIds.add(fillId);

    if (event.fill.side === 'BUY') buyCount++;
    else sellCount++;

    const price = event.fill.price.value();
    const size = event.fill.size.value();
    const orderId = String(event.orderId);
    const tokenId = orderToToken.get(orderId) ?? '';
    const slippage = computeSlippage(orderId, price.toNumber() * 100);
    journal?.recordFill({
      marketId: tokenId,
      ts: Date.now(),
      orderId,
      side: event.fill.side as 'BUY' | 'SELL',
      price: price.toFixed(4),
      size: size.toFixed(2),
      notional: price.times(size).toFixed(4),
      partial: true,
      ...slippage,
    });
  });

  eventBus.subscribe('ORDER_FILLED', (event) => {
    void event;
  });

  // 12. Создаём и регистрируем стратегию
  const strategy = createStrategy(
    { type: config.strategy, params: config.strategyParams } as StrategyConfig,
    logger,
    journal,
    config.execution,
  );

  // Извлекаем eventStartTime / endDate из rawMarket (Gamma API)
  const rawEventStart = rawMarket?.['eventStartTime'] as string | undefined;
  const rawEndDate = rawMarket?.['endDate'] as string | undefined;
  const parsedEventStartMs = rawEventStart ? new Date(rawEventStart).getTime() : NaN;
  const parsedEndDateMs = rawEndDate ? new Date(rawEndDate).getTime() : NaN;

  const expirationMs = !Number.isNaN(parsedEndDateMs) ? parsedEndDateMs : Date.now() + 24 * 60 * 60 * 1000;
  const marketStub = { expirationMs } as Parameters<typeof engine.scheduler.register>[0]['market'];
  const eventStartMs = !Number.isNaN(parsedEventStartMs) ? parsedEventStartMs : undefined;

  // Определяем нужен ли dual-token режим (стратегии, которые могут выбирать UP/DOWN).
  const needsComplementary = config.strategy === 'adaptive-entry'
    || config.strategy === 'selective-entry'
    || config.strategy === 'calibrated-crowd'
    || config.strategy === 'calibrated-crowd-cex'
    || config.strategy === 'paired-cex-crowd'
    || config.strategy === 'baseline-paired-overlay';
  const complementaryAsset = needsComplementary && complementaryInstrumentId
    ? asPolymarketCtfToken(String(complementaryInstrumentId))
    : undefined;

  // Регистрируем комплементарный инструмент в каталоге (нужен для ExecutionEngine валидации)
  if (needsComplementary && complementaryInstrumentId) {
    const compInfo: InstrumentInfo = {
      instrumentId: complementaryInstrumentId,
      marketId,
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      minOrderValue: Quantity.of(new Decimal('1')),
      active: true,
      expiresAt: expiresAtResult.value,
    };
    marketCatalog.register(compInfo);
  }

  const regResult = await engine.scheduler.register({
    strategy, instrumentId, asset, accountId, market: marketStub,
    cryptoSymbol: cryptoMeta?.rtdsFilter,
    eventStartMs,
    complementaryInstrumentId: needsComplementary ? complementaryInstrumentId : undefined,
    complementaryAsset: complementaryAsset ?? undefined,
    additionalInstrumentIds: needsComplementary && complementaryInstrumentId ? [complementaryInstrumentId] : undefined,
  });
  if (!regResult.ok) return null;

  journal?.startSession({
    marketId: String(marketId),
    mode: 'paper',
    strategyType: config.strategy,
    strategyConfig: config.strategyParams as unknown as Record<string, unknown>,
    marketQuestion: typeof rawMarket?.['question'] === 'string' ? rawMarket['question'] : fileName,
    tokenIds: complementaryInstrumentId
      ? [String(instrumentId), String(complementaryInstrumentId)]
      : [String(instrumentId)],
    instrumentId: String(instrumentId),
    expiresAtMs: expirationMs,
    eventStartMs,
  });

  // 13. BacktestEngine — один файл
  const backtestEngine = new BacktestEngine(
    { filePaths: [filePath], outcomeIndex, replayComplementaryTrades: needsComplementary, cexWarmupMs },
    { bookUpdateHandler, eventBus, replayClock, logger, cryptoPriceStore, cryptoMarketDataStore, parseCryptoMeta },
  );
  const replayResult = await backtestEngine.run();

  // 14. Остановка
  await engine.scheduler.unregister(strategy.id);
  engine.scheduler.stop();
  engine.orderEventBridge.stop();
  simulator.stop();
  marketDataStore.stop();

  const selectiveStats = strategy instanceof SelectiveEntryStrategy
    ? strategy.stats
    : { buyAttempts: 0, cancelAfterPlace: 0 };
  const executionStats = engine.executionEngine.stats ?? {
    benignPostOnlyRejects: (engine.executionEngine as unknown as { _benignPostOnlyRejects?: number })._benignPostOnlyRejects ?? 0,
  };

  // 15. Settlement
  // Auto-selection: позиция может быть на primary ИЛИ complementary инструменте.
  // Проверяем оба, определяем outcomeIndex позиции для корректного settlement.
  if (cryptoMeta) {
    const resolution = cryptoPriceStore.getResolution(cryptoMeta.rtdsFilter);
    const portfolio = portfolioStore.get(accountId);

    // Ищем позицию: на primary или complementary инструменте
    const primaryPosition = portfolio?.getPosition(instrumentId);
    const compPosition = complementaryInstrumentId ? portfolio?.getPosition(complementaryInstrumentId) : undefined;
    const hasPrimary = primaryPosition && !primaryPosition.isClosed();
    const hasComp = compPosition && !compPosition.isClosed();
    const activePosition = hasPrimary ? primaryPosition : hasComp ? compPosition : undefined;
    const activeInstrumentId = hasPrimary ? instrumentId : hasComp ? complementaryInstrumentId! : instrumentId;
    // Для complementary токена outcomeIndex инвертирован
    const activeOutcomeIndex = hasPrimary ? outcomeIndex : hasComp ? (1 - outcomeIndex) as 0 | 1 : outcomeIndex;

    if (resolution && portfolio && activePosition && (hasPrimary || hasComp)) {
      // Известный исход — settlement по $1 (win) или $0 (lose)
      const qty = activePosition.quantity.value();
      const isWinning = (activeOutcomeIndex === 0 && resolution === 'UP') || (activeOutcomeIndex === 1 && resolution === 'DOWN');
      const settlementPrice = isWinning ? new Decimal(1) : new Decimal(0);
      const cashCredit = qty.times(settlementPrice);

      const closedPosition = new SimplePosition({
        instrumentId: activeInstrumentId,
        quantity: new Decimal(0),
        averageEntryPrice: activePosition.averageEntryPrice.value(),
        side: 'LONG' as const,
      });
      let updated = portfolio.upsertPosition(closedPosition);

      if (cashCredit.gt(0)) {
        const creditResult = updated.applyCredit(Money.of(cashCredit, 'USDC'));
        if (creditResult.ok) updated = creditResult.value;
      }

      const currentVersion = portfolioStore.getVersion(accountId);
      portfolioStore.save(updated, currentVersion);

      if (hasComp) {
        logger.debug('Settlement: position on complementary token (auto-selected)', {
          instrumentId: String(activeInstrumentId).slice(0, 12) + '…',
          outcomeIndex: activeOutcomeIndex,
          resolution,
          isWinning,
        });
      }
    } else if (!resolution && portfolio && activePosition && (hasPrimary || hasComp)) {
      // Unknown resolution — откат: возвращаем cash по средней цене входа,
      // как будто мы не торговали (рынок без резолва = skip)
      const qty = activePosition.quantity.value();
      const avgEntry = activePosition.averageEntryPrice.value();
      const refund = qty.times(avgEntry); // возвращаем потраченный cash

      const closedPosition = new SimplePosition({
        instrumentId: activeInstrumentId,
        quantity: new Decimal(0),
        averageEntryPrice: activePosition.averageEntryPrice.value(),
        side: 'LONG' as const,
      });
      let updated = portfolio.upsertPosition(closedPosition);

      if (refund.gt(0)) {
        const creditResult = updated.applyCredit(Money.of(refund, 'USDC'));
        if (creditResult.ok) updated = creditResult.value;
      }

      const currentVersion = portfolioStore.getVersion(accountId);
      portfolioStore.save(updated, currentVersion);

      logger.debug('Settlement: unknown resolution, refunding position', {
        qty: qty.toFixed(1),
        avgEntry: avgEntry.toFixed(4),
        refund: refund.toFixed(4),
      });
    }
  }

  // 16. Результат
  const finalPortfolio = portfolioStore.get(accountId);
  const available = finalPortfolio ? finalPortfolio.balance.available().value() : initialBalanceDecimal;
  const pnl = available.minus(initialBalanceDecimal);

  const cryptoSnap = cryptoMeta ? cryptoPriceStore.get(cryptoMeta.rtdsFilter) : undefined;
  const resolution = cryptoMeta ? cryptoPriceStore.getResolution(cryptoMeta.rtdsFilter) : undefined;
  journal?.recordResolution({
    marketId: String(marketId),
    ts: Date.now(),
    resolution: resolution ?? 'UNKNOWN',
    pnl: pnl.toFixed(4),
    settlementPrice: resolution === 'UP' || resolution === 'DOWN' ? '1.0000' : '0.0000',
  });
  await journal?.endSession(marketId, 'EXPIRED');
  await journal?.close();

  return {
    file: fileName,
    question: typeof rawMarket?.['question'] === 'string' ? rawMarket['question'] as string : undefined,
    marketId: String(marketId),
    instrumentId: String(instrumentId).slice(0, 12) + '…',
    cryptoSymbol: cryptoSnap?.symbol,
    strikePrice: cryptoSnap?.targetPrice,
    resolutionPrice: cryptoSnap?.resolutionPrice,
    resolution,
    pnl,
    buys: buyCount,
    sells: sellCount,
    completedCycles: Math.min(buyCount, sellCount),
    bookEvents: replayResult.bookEvents,
    tradeEvents: replayResult.tradeEvents,
    cexBookEvents: replayResult.cexBookEvents,
    cexTradeEvents: replayResult.cexTradeEvents,
    errors: replayResult.errors,
    durationMs: replayResult.durationMs,
    buyAttempts: selectiveStats.buyAttempts,
    cancelAfterPlace: selectiveStats.cancelAfterPlace,
    postOnlyRejects: executionStats.benignPostOnlyRejects,
  };
}

// ── Multi-market оркестратор ────────────────────────────────────────────────

/**
 * Запускает бэктест по всем снапшот-файлам последовательно и выводит агрегированный отчёт.
 *
 * @param resolvedPaths - Массив путей к снапшот-файлам
 * @param config - Конфигурация бота
 * @param outcomeIndex - Индекс outcome (0 = YES, 1 = NO)
 *
 * @remarks
 * Каждый файл прогоняется как изолированный рынок с чистым торговым состоянием,
 * но общим rolling crypto/CEX history store. Binance klines fallback
 * пропускается — meta из collect-data содержит priceToBeat и finalPrice.
 *
 * @example
 * ```typescript
 * await runMultiMarketBacktest(resolvedPaths, config, 0);
 * ```
 */
export async function runMultiMarketBacktest(
  resolvedPaths: string[],
  config: BotConfig,
  outcomeIndex: 0 | 1,
): Promise<void> {
  const startTime = Date.now();

  // Создаём корневой логгер для summary (не привязан к ReplayClock)
  const rootInfra = buildCoreInfra({ logLevel: LogLevel.WARN });
  const logger = rootInfra.logger;

  const orderedPaths = await sortSnapshotPathsForContinuousReplay(resolvedPaths, outcomeIndex);
  const sharedCryptoMarketDataStore = new CryptoMarketDataStore();

  logger.warn('=== MULTI-MARKET BACKTEST ===', {
    totalFiles: orderedPaths.length,
    strategy: config.strategy,
    outcomeIndex,
    initialBalance: config.resources.initialBalance,
    continuousCryptoHistory: true,
  });

  const results: MarketBacktestResult[] = [];
  let skipped = 0;
  let failed = 0;

  for (const [i, filePath] of orderedPaths.entries()) {
    try {
      const result = await runSingleMarketBacktest(
        filePath,
        config,
        outcomeIndex,
        logger,
        sharedCryptoMarketDataStore,
        i === 0 ? 30 * 60_000 : 0,
      );
      if (result) {
        results.push(result);
        const cumulativePnl = results.reduce((acc, item) => acc.plus(item.pnl), new Decimal(0));
        logger.warn('Market result', {
          file: result.file,
          question: result.question ?? 'unknown',
          resolution: result.resolution ?? 'unknown',
          strikePrice: result.strikePrice,
          resolutionPrice: result.resolutionPrice,
          pnl: `${result.pnl.gte(0) ? '+' : ''}${result.pnl.toFixed(4)} USDC`,
          cumulativePnl: `${cumulativePnl.gte(0) ? '+' : ''}${cumulativePnl.toFixed(4)} USDC`,
          fills: `${result.buys}B/${result.sells}S`,
          cycles: result.completedCycles,
          errors: result.errors,
        });
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      logger.error('Market backtest failed', {
        file: path.basename(filePath),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Progress log каждые 25 рынков
    if ((i + 1) % 25 === 0 || i === orderedPaths.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.warn('Progress', {
        completed: `${i + 1}/${orderedPaths.length}`,
        elapsed: `${elapsed}s`,
        wins: results.filter(r => r.pnl.gt(0)).length,
        losses: results.filter(r => r.pnl.lt(0)).length,
      });
    }
  }

  // ── Агрегация ───────────────────────────────────────────────────────────

  const totalDurationMs = Date.now() - startTime;

  if (results.length === 0) {
    logger.warn('=== NO RESULTS ===', { skipped, failed });
    return;
  }

  const wins = results.filter(r => r.pnl.gt(0));
  const losses = results.filter(r => r.pnl.lt(0));
  const neutral = results.filter(r => r.pnl.isZero());

  const totalPnl = results.reduce((acc, r) => acc.plus(r.pnl), new Decimal(0));
  const avgPnl = totalPnl.div(results.length);
  const totalFills = results.reduce((acc, r) => acc + r.buys + r.sells, 0);
  const totalCycles = results.reduce((acc, r) => acc + r.completedCycles, 0);
  const totalCexBookEvents = results.reduce((acc, r) => acc + r.cexBookEvents, 0);
  const totalCexTradeEvents = results.reduce((acc, r) => acc + r.cexTradeEvents, 0);
  const buyAttempts = results.reduce((acc, r) => acc + r.buyAttempts, 0);
  const cancelAfterPlace = results.reduce((acc, r) => acc + r.cancelAfterPlace, 0);
  const postOnlyRejects = results.reduce((acc, r) => acc + r.postOnlyRejects, 0);

  // Сортировка по PnL для best/worst
  const sorted = [...results].sort((a, b) => b.pnl.minus(a.pnl).toNumber());
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;

  const winRate = wins.length + losses.length > 0
    ? (wins.length / (wins.length + losses.length) * 100).toFixed(1)
    : '0.0';

  // ── Summary log ─────────────────────────────────────────────────────────

  logger.warn('=== MULTI-MARKET BACKTEST SUMMARY ===', {
    markets: results.length,
    skipped,
    failed,
    wins: wins.length,
    losses: losses.length,
    neutral: neutral.length,
    winRate: `${winRate}%`,
    totalPnl: `${totalPnl.gte(0) ? '+' : ''}${totalPnl.toFixed(4)} USDC`,
    avgPnl: `${avgPnl.gte(0) ? '+' : ''}${avgPnl.toFixed(4)} USDC`,
    bestPnl: `${best.pnl.gte(0) ? '+' : ''}${best.pnl.toFixed(4)} (${best.file.slice(0, 50)})`,
    worstPnl: `${worst.pnl.gte(0) ? '+' : ''}${worst.pnl.toFixed(4)} (${worst.file.slice(0, 50)})`,
    buyAttempts,
    postOnlyRejects,
    cancelAfterPlace,
    totalFills,
    totalCycles,
    totalCexBookEvents,
    totalCexTradeEvents,
    totalDuration: `${(totalDurationMs / 1000).toFixed(1)}s`,
    avgPerMarket: `${(totalDurationMs / results.length).toFixed(0)}ms`,
  });

  // Strategy config
  logger.warn('Strategy config', {
    type: config.strategy,
    ...config.strategyParams,
    execution: config.execution,
  });

  // Per-market results (sorted by PnL, top 10 + bottom 10)
  const topN = 10;
  const topWins = sorted.slice(0, topN);
  const topLosses = sorted.slice(-topN).reverse();

  logger.warn(`Top ${topN} winners`, {
    markets: topWins.map((r, i) => ({
      rank: i + 1,
      pnl: `${r.pnl.gte(0) ? '+' : ''}${r.pnl.toFixed(4)}`,
      cycles: `${r.buys}B/${r.sells}S`,
      resolution: r.resolution ?? '?',
      file: r.file.slice(0, 60),
    })),
  });

  logger.warn(`Top ${topN} losers`, {
    markets: topLosses.map((r, i) => ({
      rank: results.length - topN + i + 1,
      pnl: `${r.pnl.gte(0) ? '+' : ''}${r.pnl.toFixed(4)}`,
      cycles: `${r.buys}B/${r.sells}S`,
      resolution: r.resolution ?? '?',
      file: r.file.slice(0, 60),
    })),
  });

  // Distribution by resolution
  const upMarkets = results.filter(r => r.resolution === 'UP');
  const downMarkets = results.filter(r => r.resolution === 'DOWN');
  const unknownMarkets = results.filter(r => !r.resolution);
  const unknownPnl = unknownMarkets.reduce((a, r) => a.plus(r.pnl), new Decimal(0));
  const knownResults = results.filter(r => r.resolution);
  const knownPnl = knownResults.reduce((a, r) => a.plus(r.pnl), new Decimal(0));

  logger.warn('Resolution breakdown', {
    UP: {
      count: upMarkets.length,
      avgPnl: upMarkets.length > 0
        ? upMarkets.reduce((a, r) => a.plus(r.pnl), new Decimal(0)).div(upMarkets.length).toFixed(4)
        : '-',
    },
    DOWN: {
      count: downMarkets.length,
      avgPnl: downMarkets.length > 0
        ? downMarkets.reduce((a, r) => a.plus(r.pnl), new Decimal(0)).div(downMarkets.length).toFixed(4)
        : '-',
    },
    unknown: unknownMarkets.length,
    unknownPnl: unknownMarkets.length > 0
      ? `${unknownPnl.gte(0) ? '+' : ''}${unknownPnl.toFixed(4)} USDC`
      : '-',
    adjustedPnl: knownResults.length > 0
      ? `${knownPnl.gte(0) ? '+' : ''}${knownPnl.toFixed(4)} USDC (excl unknown)`
      : '-',
  });
}

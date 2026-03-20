/**
 * Точка входа торгового бота Polymarket.
 *
 * @remarks
 * ### Источники конфигурации:
 * - ENV `MODE` — режим работы: `live | paper | backtest` (обязательно)
 * - ENV `STRATEGY` — переопределение типа стратегии (опционально)
 * - ENV `CONFIG` — путь к JSON файлу конфигурации (по умолчанию `./config.json`)
 *
 * ### Алгоритм инициализации:
 * 1. Парсинг и валидация конфигурации (parseConfig)
 * 2. Разветвление по MODE:
 *    - `paper`    — LiveClock, fixed market config, работает до SIGINT/SIGTERM
 *    - `backtest` — ReplayClock, snapshot market config, завершается после прогона
 *    - `live`     — TODO Phase D
 *
 * ### Пример запуска (paper):
 * ```bash
 * MODE=paper CONFIG=configs/dumb-paper.json node --loader ts-node/esm src/main.ts
 * ```
 *
 * ### Пример запуска (backtest):
 * ```bash
 * MODE=backtest CONFIG=configs/backtest-dumb.json node --loader ts-node/esm src/main.ts
 * ```
 */

import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import Decimal from 'decimal.js';
import { LogLevel } from '@polymarket/logger';
import { PolymarketWsAdapter, PolymarketWebSocketManager } from '@polymarket/exchange/ws';
import { MarketDataFeedAdapter, PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { IMarketFilterConfig } from '@polymarket/ports';
import {
  asInstrumentId,
  asMarketId,
  asPolymarketCtfToken,
  parseAccountId,
  KnownVenues,
} from '@polymarket/ids';
import type { InstrumentId, MarketId, AssetId } from '@polymarket/ids';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Balance, Money, Price, Quantity, TimestampService } from '@polymarket/value-objects';
import { ReplayClock } from '@polymarket/time';
import { BacktestEngine } from '@polymarket/backtesting';
import { BookUpdateHandler } from '@polymarket/handlers';
import type { IBookRegistry } from '@polymarket/handlers';
import { OrderBook } from '@polymarket/order-book';
import type { OrderBook as OrderBookType } from '@polymarket/order-book';

import { DnsOverride } from '@polymarket/exchange/dns';
import { parseConfig } from './config/parseConfig.js';
import { buildCoreInfra } from './bot/buildCoreInfra.js';
import { subscribeToOrderEvents } from './bot/buildEventLogger.js';
import { buildRepositories } from './bot/buildRepositories.js';
import {
  buildProcessFillUseCase,
  buildOrderUseCases,
} from './bot/buildUseCases.js';
import { buildPaperInfra, buildPaperSimulator } from './bot/buildPaperMode.js';
import { buildLiveInfra } from './bot/buildLiveInfra.js';
import type { LiveCredentials } from './bot/buildLiveInfra.js';
import { buildMarketData } from './bot/buildMarketData.js';
import { buildStrategyEngine } from './bot/buildStrategyEngine.js';
import { FillOrchestrator } from '@polymarket/orchestrators';
import { createStrategy } from './strategyFactory.js';
import type { StrategyConfig } from './strategyFactory.js';
import type { RiskParams } from '@polymarket/risk';
import type { InstrumentInfo } from '@polymarket/ports';

// ── SimpleBookRegistry ─────────────────────────────────────────────────────────

/**
 * Простая in-memory реализация IBookRegistry для backtest режима.
 *
 * @remarks
 * Хранит стаканы в Map по ключу `${marketId}:${instrumentId}`.
 * При отсутствии стакана `getOrCreate` создаёт новый `OrderBook`.
 */
class SimpleBookRegistry implements IBookRegistry {
  private readonly _books = new Map<string, OrderBookType>();

  private _key(mId: MarketId, tId: InstrumentId): string {
    return `${String(mId)}:${String(tId)}`;
  }

  get(mId: MarketId, tId: InstrumentId): OrderBookType | undefined {
    return this._books.get(this._key(mId, tId));
  }

  getOrCreate(mId: MarketId, tId: InstrumentId): OrderBookType {
    const key = this._key(mId, tId);
    let book = this._books.get(key);
    if (!book) {
      book = OrderBook.create(mId, String(tId));
      this._books.set(key, book);
    }
    return book;
  }

  delete(mId: MarketId, tId: InstrumentId): void {
    this._books.delete(this._key(mId, tId));
  }

  deleteMarket(mId: MarketId): void {
    const prefix = `${String(mId)}:`;
    for (const key of [...this._books.keys()]) {
      if (key.startsWith(prefix)) this._books.delete(key);
    }
  }
}

// ── Шаг 1: Парсинг конфигурации ──────────────────────────────────────────────

const configResult = parseConfig(process.env);

if (!configResult.ok) {
  for (const err of configResult.errors) {
    console.error(`[Config] ${err}`);
  }
  process.exit(1);
}

const { mode, config } = configResult.value;

// ── Шаг 1.5: DNS Override ─────────────────────────────────────────────────────
// Всегда включён — резолвит IP через Cloudflare DoH (1.1.1.1) в обход провайдерского DNS.
// NODE_TLS_REJECT_UNAUTHORIZED=0 — обход self-signed TLS (только dev, задаётся в .env).
// Создаём временный logger только для DNS — основной будет создан внутри runPaper/runBacktest.
{
  const { ColorConsoleLogger, LogLevel: LL } = await import('@polymarket/logger');
  const { LiveClock: LC } = await import('@polymarket/time');
  const _dnsLogger = new ColorConsoleLogger(new LC(), LL.INFO);
  const dnsOverride = new DnsOverride(_dnsLogger);

  try {
    await dnsOverride.install([
      'gamma-api.polymarket.com',
      'clob.polymarket.com',
      'data-api.polymarket.com',
      'ws-subscriptions-clob.polymarket.com',
    ]);
  } catch (err) {
    _dnsLogger.warn('DNS override install failed, continuing with system DNS', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// ── Шаг 2: Разветвление по MODE ───────────────────────────────────────────────

if (mode === 'paper') {
  await runPaper();
} else if (mode === 'backtest') {
  await runBacktest();
  process.exit(0);
} else if (mode === 'live') {
  await runLive();
} else {
  console.error(`[Bot] Unknown MODE="${String(mode)}". Valid: live | paper | backtest`);
  process.exit(1);
}

// ── Реализация paper режима ────────────────────────────────────────────────────

/**
 * Запускает бота в paper режиме: LiveClock, fixed или discovery market config.
 *
 * @remarks
 * ### Алгоритм (discovery mode):
 * 1. Начальный discovery → открываем первый рынок
 * 2. Цикл проверки истечения каждые 5 сек (checkExpiredMarket):
 *    - При истечении: scheduler.unregister() → CANCEL_ALL открытых ордеров
 *    - Отписка от WS, blacklist рынка, поиск следующего из кэша
 * 3. Цикл обновления кэша каждые scanPauseMs (scheduleScanLoop)
 *
 * ### Алгоритм (fixed mode):
 * 1. Открываем указанный рынок
 * 2. При истечении (по умолчанию +24h): graceful shutdown с CANCEL_ALL
 *
 * ### Ротация рынков (discovery):
 * - PaperExchangeClient.setMarket() обновляет контекст без пересоздания цепочки
 * - StrategyScheduler.unregister() → BaseStrategy.stop() → [{ type: 'CANCEL_ALL' }]
 *   → ExecutionEngine.execute() → CancelOrderUseCase → PaperExchangeClient.cancelOrder()
 *   → PaperFillSimulator.removeOrder()
 * - После unregister стратегия может быть re-registered с новым instrumentId
 */
async function runPaper(): Promise<void> {
  if (config.market.source !== 'fixed' && config.market.source !== 'discovery') {
    console.error('[Bot] paper mode requires market.source=fixed or market.source=discovery');
    process.exit(1);
  }

  const infra = buildCoreInfra({ logLevel: LogLevel.INFO });
  const { clock, logger, eventBus } = infra;

  // ── Resolve первый рынок ──────────────────────────────────────────────────
  // Мутабельное состояние текущего рынка (обновляется при ротации)
  let activeInstrumentId: InstrumentId;  // фильтр trade bridge обновляется автоматически
  let currentTokenIdStr: string;
  let currentMarketId: MarketId;
  let currentAsset: AssetId;
  let currentMarketExpiresAtMs: number;

  // Discovery-специфичное состояние
  type DiscoveryAdapter = PolymarketMarketDiscoveryAdapter;
  let discoveryAdapter: DiscoveryAdapter | null = null;
  let currentDiscoveryCandidate: import('@polymarket/ports').DiscoveredMarket | null = null;
  const closedMarkets = new Set<string>();
  let isShuttingDown = false;
  let expiryCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  let scanTimeoutId: ReturnType<typeof setTimeout> | null = null;

  if (config.market.source === 'fixed') {
    const mc = config.market;
    const mid = asMarketId(mc.marketId);
    if (!mid) {
      logger.fatal('Invalid market.marketId', { marketId: mc.marketId });
      process.exit(1);
    }
    // Деривация tokenId из hex condition_id + outcomeIndex.
    // Polymarket CTF токены: conditionId × 2 + outcomeIndex (BigInt арифметика).
    const hexId = mc.marketId.replace(/^0x/i, '');
    const tokenBigInt = BigInt('0x' + hexId) * 2n + BigInt(mc.outcomeIndex);
    currentTokenIdStr = tokenBigInt.toString();
    const iId = asInstrumentId(currentTokenIdStr);
    const ast = asPolymarketCtfToken(currentTokenIdStr);
    if (!iId || !ast) {
      logger.fatal('Cannot derive instrumentId', { tokenIdStr: currentTokenIdStr });
      process.exit(1);
    }
    currentMarketId = mid;
    activeInstrumentId = iId;
    currentAsset = ast;
    // Для fixed-source реальное время экспирации неизвестно без API-вызова → +24h как безопасный дефолт
    currentMarketExpiresAtMs = Date.now() + 24 * 60 * 60 * 1000;
  } else {
    // Discovery mode: создаём адаптер один раз — он будет использоваться для ротации
    const mc = config.market;
    const filterConfig: IMarketFilterConfig = {
      minTimeToExpiryHours: mc.filter.minTimeToExpiryHours ?? 0,
      minSpread: 0,
      minLiquidity: mc.filter.minLiquidity ?? 0,
      maxMarketsToReturn: 10,  // берём несколько кандидатов для ротации
      anyOfKeywords: mc.filter.anyOfKeywords,
      requiredKeywords: mc.filter.requiredKeywords,
      excludedKeywords: mc.filter.excludedKeywords,
    };
    logger.info('Starting market discovery', { filter: filterConfig });

    const marketDataClient = new PolymarketMarketDataRestClient(
      { baseUrl: 'https://gamma-api.polymarket.com' },
      logger,
    );
    discoveryAdapter = new PolymarketMarketDiscoveryAdapter(
      marketDataClient,
      new MarketFilter(),
      new MarketScorer(clock),
      filterConfig,
      logger,
    );

    // Начальный discovery
    await discoveryAdapter.refresh();
    const candidates = await discoveryAdapter.findCandidates();
    const validCandidates = candidates.filter(c => c.expiresAt.toNumber() > Date.now());
    if (validCandidates.length === 0) {
      logger.fatal('No markets found matching discovery filter', { filter: filterConfig });
      process.exit(1);
    }

    const candidate = validCandidates[0]!;
    const tStr = candidate.allTokenIds?.[mc.outcomeIndex] ?? String(candidate.instrumentId);
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.fatal('Cannot create instrument from discovered market', { tokenIdStr: tStr });
      process.exit(1);
    }
    currentMarketId = candidate.marketId;
    activeInstrumentId = iId;
    currentAsset = ast;
    currentTokenIdStr = tStr;
    currentMarketExpiresAtMs = candidate.expiresAt.toNumber();
    currentDiscoveryCandidate = candidate;

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Initial market discovered', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(currentMarketId),
      tokenId: tStr,
      liquidity: candidate.liquidity.toFixed(0),
      expiresAt: new Date(currentMarketExpiresAtMs).toISOString(),
      hoursToExpiry: ((currentMarketExpiresAtMs - Date.now()) / 3_600_000).toFixed(2),
    });
  }

  logger.info('Bot starting in paper mode', {
    strategy: config.strategy,
    marketId: String(currentMarketId),
    initialBalance: config.resources.initialBalance,
  });

  const repos = buildRepositories();
  const { portfolioStore } = repos;

  const riskParams: RiskParams = buildRiskParams();

  const accountId = parseAccountId(config.account.accountId);
  if (!accountId) {
    logger.fatal('Invalid account.accountId', { accountId: config.account.accountId });
    process.exit(1);
  }

  // Chicken-and-egg: MockExchangeClient → ProcessFillUseCase → Simulator → PaperExchangeClient
  const { mockClient } = buildPaperInfra({ clock });
  const { processFillUseCase } = buildProcessFillUseCase({ infra, repos });

  const { simulator, exchangeClient } = buildPaperSimulator({
    mockClient,
    processFillUseCase,
    eventBus,
    clock,
    logger,
    instrumentId: activeInstrumentId,
    marketId: currentMarketId,
    accountId,
    asset: currentAsset,
    config: config.paper,
  });

  const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
  const useCases = { processFillUseCase, ...orderUseCases };

  const { marketDataStore, marketCatalog } = buildMarketData({ infra });
  const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });

  // BookUpdateHandler — конвертирует WS snapshots в BOOK_UPDATED события
  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);

  // Polymarket WebSocket — live рыночные данные
  const wsManager = new PolymarketWebSocketManager(
    { url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market' },
    logger,
  );
  const wsAdapter = new PolymarketWsAdapter(wsManager, logger);

  // MarketDataFeedAdapter — маршрутизирует orderbook snapshots → BookUpdateHandler → BOOK_UPDATED
  const marketDataFeedAdapter = new MarketDataFeedAdapter(wsAdapter, bookUpdateHandler, logger);

  // Trade bridge — публичные трейды → TRADE_RECEIVED (для tape-based fills в PaperFillSimulator)
  // Использует activeInstrumentId (мутабельная ссылка) — автоматически фильтрует по текущему рынку
  wsAdapter.onTradeEvent(async (dto) => {
    const tradeInstrumentId = asInstrumentId(dto.asset_id);
    if (!tradeInstrumentId || String(tradeInstrumentId) !== String(activeInstrumentId)) return;
    const tsResult = TimestampService.create(Number(dto.timestamp));
    if (!tsResult.ok) return;
    try {
      await eventBus.publish({
        type: 'TRADE_RECEIVED',
        instrumentId: tradeInstrumentId,
        price: Price.of(new Decimal(dto.price)),
        size: Quantity.of(new Decimal(dto.size)),
        side: dto.side,
        timestamp: tsResult.value,
      });
    } catch {
      // невалидные уровни пропускаем (price=0 или price=1 на закрывающихся рынках)
    }
  });

  // Начальный портфель
  const initialBalance = buildInitialBalance(config.resources.initialBalance, accountId);
  const portfolioResult = Portfolio.create({
    id: asPortfolioId(`portfolio:${config.account.accountId}`),
    accountId,
    balance: initialBalance,
  });
  if (!portfolioResult.ok) {
    logger.fatal('Failed to create portfolio', { error: String(portfolioResult.error) });
    process.exit(1);
  }
  portfolioStore.save(portfolioResult.value, 0);

  // Стратегия создаётся один раз — stateless, пересоздавать не нужно
  const strategy = createStrategy({ type: config.strategy, params: config.strategyParams } as StrategyConfig, logger);

  // ── Хелперы ротации рынков (только для discovery) ─────────────────────────

  /**
   * Регистрирует инструмент в каталоге и стратегию в планировщике.
   *
   * @param instrumentId - Инструмент нового рынка
   * @param marketId - ID нового рынка
   * @param asset - Торговый актив нового рынка
   * @param expiresAtMs - UTC timestamp истечения рынка
   */
  async function registerMarketAndStrategy(
    instrumentId: InstrumentId,
    marketId: MarketId,
    asset: AssetId,
    expiresAtMs: number,
  ): Promise<boolean> {
    const expiresAtResult = TimestampService.create(expiresAtMs);
    if (!expiresAtResult.ok) {
      logger.error('Failed to create expiresAt timestamp', { expiresAtMs });
      return false;
    }
    marketCatalog.register({
      instrumentId,
      marketId,
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      minOrderValue: Quantity.of(new Decimal('1')),
      active: true,
      expiresAt: expiresAtResult.value,
    });

    const marketStub = { expirationMs: expiresAtMs } as Parameters<typeof engine.scheduler.register>[0]['market'];
    const regResult = await engine.scheduler.register({ strategy, instrumentId, asset, accountId: accountId!, market: marketStub });
    if (!regResult.ok) {
      logger.error('Failed to register strategy', { error: String(regResult.error) });
      return false;
    }
    return true;
  }

  /**
   * Переключает бота на новый рынок:
   * 1. Обновляет exchangeClient (без пересоздания цепочки use cases)
   * 2. Обновляет мутабельные переменные состояния
   * 3. Регистрирует инструмент в каталоге + стратегию в планировщике
   * 4. Подписывается на WS для нового токена
   *
   * @param candidate - Новый рынок из discovery
   */
  async function openMarket(candidate: import('@polymarket/ports').DiscoveredMarket): Promise<void> {
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const tStr = candidate.allTokenIds?.[mc.outcomeIndex] ?? String(candidate.instrumentId);
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.error('Cannot create instrument for candidate', { tokenIdStr: tStr, marketId: String(candidate.marketId) });
      return;
    }

    const expiresMs = candidate.expiresAt.toNumber();

    // Обновляем exchange client для нового рынка (без пересоздания use cases)
    exchangeClient.setMarket(iId, candidate.marketId, accountId!, ast);

    // Сбрасываем историю fills для нового рынка
    fillHistory = [];
    marketOpenMs = Date.now();

    // Обновляем мутабельное состояние (trade bridge фильтрует по activeInstrumentId)
    activeInstrumentId = iId;
    currentTokenIdStr = tStr;
    currentMarketId = candidate.marketId;
    currentAsset = ast;
    currentMarketExpiresAtMs = expiresMs;
    currentDiscoveryCandidate = candidate;

    // Подписываемся на новый токен до регистрации стратегии
    await wsAdapter.subscribeToToken(tStr);

    const ok = await registerMarketAndStrategy(iId, candidate.marketId, ast, expiresMs);
    if (!ok) return;

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Market opened', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(candidate.marketId),
      tokenId: tStr,
      expiresAt: new Date(expiresMs).toISOString(),
      hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
    });
  }

  /**
   * Закрывает текущий рынок:
   * 1. scheduler.unregister() → strategy.stop() → CANCEL_ALL открытых ордеров
   * 2. Отписка от WS токена
   * 3. Удаление из каталога
   * 4. При EXPIRED — добавляем в blacklist чтобы не открыть снова
   *
   * @param reason - Причина закрытия
   */
  async function closeCurrentMarket(reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const savedTokenIdStr = currentTokenIdStr;
    const savedMarketId = currentMarketId;
    const savedInstrumentId = activeInstrumentId;

    logger.info('Closing market', { reason, marketId: String(savedMarketId), question: currentDiscoveryCandidate?.question });

    // Снимаем стратегию → автоматически отменяет все открытые ордера через CANCEL_ALL
    // (включая BUY и SELL — оба типа ордеров снимаются перед сводкой)
    await engine.scheduler.unregister(strategy.id);

    // Сводка ПОСЛЕ unregister чтобы finalUsdcReserved отображал 0 (ордера уже отменены)
    printMarketSummary(currentDiscoveryCandidate?.question ?? String(savedMarketId));

    // Отписываемся от WS для старого токена
    await wsAdapter.unsubscribeFromToken(savedTokenIdStr);

    // Удаляем из каталога
    marketCatalog.remove(savedInstrumentId);

    if (reason === 'EXPIRED') {
      // Blacklist: Gamma API может ещё долго возвращать этот рынок как active
      closedMarkets.add(String(savedMarketId));
    }

    currentDiscoveryCandidate = null;
    logger.info('Market closed', { reason, marketId: String(savedMarketId) });
  }

  /**
   * Ищет следующий валидный рынок из кэша discovery и открывает его.
   *
   * @remarks
   * Не делает новый API-запрос — читает из кэша. Кэш обновляется в scheduleScanLoop.
   * Пропускает истёкшие и закрытые (blacklisted) рынки.
   */
  async function fillMarketSlot(): Promise<void> {
    if (!discoveryAdapter) return;

    let candidates: readonly import('@polymarket/ports').DiscoveredMarket[];
    try {
      candidates = await discoveryAdapter.findCandidates();
    } catch (err) {
      logger.error('Failed to read candidates from discovery cache', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const nowMs = Date.now();
    for (const c of candidates) {
      const key = String(c.marketId);
      if (closedMarkets.has(key)) continue;
      if (c.expiresAt.toNumber() <= nowMs + MIN_VIABLE_TRADING_MS) continue;
      await openMarket(c);
      return;
    }

    logger.warn('No valid market candidates in cache, waiting for next scan');
  }

  /**
   * Количество миллисекунд до истечения рынка, при котором начинаем закрытие.
   *
   * @remarks
   * 5 сек достаточно чтобы CancelOrderUseCase успел снять все ордера до реального expiry.
   * BUY и SELL ордера отменяются через CANCEL_ALL при scheduler.unregister().
   */
  const CANCEL_BEFORE_EXPIRY_MS = 5_000;

  /**
   * Минимальное время жизни рынка (мс) для переключения.
   *
   * @remarks
   * Рынки с остатком < 30 сек не имеют смысла: ротация + подписка WS + первый тик
   * занимают ~5 сек, плюс CANCEL_BEFORE_EXPIRY_MS=5 сек на закрытие.
   * Без фильтра fillMarketSlot() может открыть рынок с 3 сек жизни,
   * который сразу истечёт → бесполезный цикл ротации.
   */
  const MIN_VIABLE_TRADING_MS = 30_000;

  /**
   * Проверяет истечение текущего рынка и переключает на следующий.
   *
   * @remarks
   * Вызывается каждые 5 сек. Закрывает рынок за CANCEL_BEFORE_EXPIRY_MS до истечения
   * чтобы успеть снять все ордера (BUY и SELL) до реального expiry.
   */
  async function checkExpiredMarket(): Promise<void> {
    if (isShuttingDown || !currentDiscoveryCandidate) return;
    if (currentMarketExpiresAtMs - Date.now() <= CANCEL_BEFORE_EXPIRY_MS) {
      const msTillExpiry = currentMarketExpiresAtMs - Date.now();
      logger.info('Market expiring soon, closing early to cancel orders', {
        marketId: String(currentMarketId),
        expiresAt: new Date(currentMarketExpiresAtMs).toISOString(),
        msTillExpiry: Math.max(0, msTillExpiry),
      });
      await closeCurrentMarket('EXPIRED');
      await fillMarketSlot();
    }
  }

  /**
   * Периодически обновляет кэш discovery (пауза после завершения запроса).
   *
   * @remarks
   * Не знает о текущем рынке — просто обновляет кэш.
   * fillMarketSlot() читает из этого кэша при смене рынка.
   */
  async function scheduleScanLoop(): Promise<void> {
    if (isShuttingDown || !discoveryAdapter) return;
    try {
      await discoveryAdapter.refresh();
      logger.debug('Discovery cache refreshed');
    } catch (err) {
      logger.error('Market discovery refresh failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
    if (!isShuttingDown) {
      const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
      scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);
    }
  }

  // ── Запуск ────────────────────────────────────────────────────────────────
  marketDataStore.start();
  engine.orderEventBridge.start();
  simulator.start();
  engine.scheduler.start();
  marketDataFeedAdapter.start();

  // ── Real-time logging (единый формат для paper/backtest/live) ─────────────
  subscribeToOrderEvents(eventBus, logger, {
    logBook: false,
    logTrades: false,
    getPortfolioSnapshot: () => {
      const portfolio = portfolioStore.get(accountId!);
      if (!portfolio) return undefined;
      const position = portfolio.getPosition(activeInstrumentId);
      const qty = position?.quantity.value();
      return {
        tokenQty: (qty ?? new Decimal(0)).toFixed(2),
        avgEntry: position ? position.averageEntryPrice.value().toFixed(4) : undefined,
        usdc: portfolio.balance.available().value().toFixed(2),
        reserved: portfolio.balance.reserved().value().toFixed(2),
      };
    },
  });

  // ── Трекинг истории fills для сводки по рынку ───────────────────────────────

  /** Запись об исполненном ордере (полностью или частично до отмены) */
  interface FillRecord {
    side: 'BUY' | 'SELL';
    /** Суммарный объём всех partial + final fill */
    size: string;
    /** Средневзвешенная цена по всем fills */
    price: string;
    notional: string;
    at: string;
    /** true если ордер был отменён с частичным заполнением */
    partial?: boolean;
  }

  /** Аккумулятор частичных fills до ORDER_FILLED или ORDER_CANCELLED */
  interface PartialAccum {
    side: 'BUY' | 'SELL';
    totalSize: Decimal;
    totalNotional: Decimal;
    firstAt: string;
  }

  let fillHistory: FillRecord[] = [];
  let marketOpenMs = Date.now();

  // orderId → аккумулятор частичных fills
  const _partialAccum = new Map<string, PartialAccum>();

  // Накапливаем partial fills по orderId
  eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    const id = String(event.orderId);
    const existing = _partialAccum.get(id);
    const fillSize = event.fill.size.value();
    const fillNotional = fillSize.times(event.fill.price.value());
    if (existing) {
      existing.totalSize = existing.totalSize.plus(fillSize);
      existing.totalNotional = existing.totalNotional.plus(fillNotional);
    } else {
      _partialAccum.set(id, {
        side: event.fill.side as 'BUY' | 'SELL',
        totalSize: fillSize,
        totalNotional: fillNotional,
        firstAt: clock.now().toISOString().slice(11, 19),
      });
    }
  });

  // ORDER_FILLED: суммируем с накопленными partial, записываем итог
  eventBus.subscribe('ORDER_FILLED', (event) => {
    const id = String(event.orderId);
    const accum = _partialAccum.get(id);
    _partialAccum.delete(id);

    const lastSize = event.fill.size.value();
    const totalSize = (accum?.totalSize ?? new Decimal(0)).plus(lastSize);
    const totalNotional = (accum?.totalNotional ?? new Decimal(0))
      .plus(lastSize.times(event.fill.price.value()));
    const avgPrice = totalNotional.div(totalSize);

    fillHistory.push({
      side: event.fill.side as 'BUY' | 'SELL',
      size: totalSize.toFixed(2),
      price: avgPrice.toFixed(4),
      notional: totalNotional.toFixed(2),
      at: accum?.firstAt ?? clock.now().toISOString().slice(11, 19),
    });
  });

  // ORDER_CANCELLED: если был частично заполнен — записываем как partial fill
  eventBus.subscribe('ORDER_CANCELLED', (event) => {
    const id = String(event.orderId);
    const accum = _partialAccum.get(id);
    if (!accum || accum.totalSize.lte(0)) return;
    _partialAccum.delete(id);

    const avgPrice = accum.totalNotional.div(accum.totalSize);
    fillHistory.push({
      side: accum.side,
      size: accum.totalSize.toFixed(2),
      price: avgPrice.toFixed(4),
      notional: accum.totalNotional.toFixed(2),
      at: accum.firstAt,
      partial: true,
    });
  });

  /**
   * Выводит сводку по всем fills на текущем рынке.
   *
   * @param marketQuestion - Название рынка для заголовка
   *
   * @remarks
   * Вызывается при закрытии рынка (истечение или shutdown).
   * Показывает циклы BUY→SELL с PnL по каждому, суммарный PnL,
   * финальный баланс токенов и USDC.
   */
  function printMarketSummary(marketQuestion: string): void {
    if (fillHistory.length === 0) {
      logger.info('=== Market summary: no fills ===', { market: marketQuestion });
      return;
    }

    const durationMs = Date.now() - marketOpenMs;
    const durMin = Math.floor(durationMs / 60_000);
    const durSec = Math.round((durationMs % 60_000) / 1000);

    const buys  = fillHistory.filter(f => f.side === 'BUY');
    const sells = fillHistory.filter(f => f.side === 'SELL');

    const cycles = buys.map((buy, i) => {
      const sell = sells[i];
      const buyLabel = `${buy.size}@${buy.price}${buy.partial ? '(partial)' : ''} [${buy.at}]`;
      if (!sell) return { buy: buyLabel, sell: '(open)', pnl: '-' };
      const pnl = new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(buy.size));
      const sellLabel = `${sell.size}@${sell.price}${sell.partial ? '(partial)' : ''} [${sell.at}]`;
      return {
        buy:  buyLabel,
        sell: sellLabel,
        pnl:  (pnl.gte(0) ? '+' : '') + pnl.toFixed(4) + ' USDC',
      };
    });

    const totalPnl = sells.reduce((acc, sell, i) => {
      const buy = buys[i];
      if (!buy) return acc;
      return acc.plus(new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(sell.size)));
    }, new Decimal(0));

    const portfolio = portfolioStore.get(accountId!);
    const position  = portfolio?.getPosition(activeInstrumentId);

    logger.warn('=== Market summary ===', {
      market:       marketQuestion,
      duration:     `${durMin}m${durSec}s`,
      buys:         buys.length,
      sells:        sells.length,
      openCycles:   buys.length - sells.length,
      totalPnl:     (totalPnl.gte(0) ? '+' : '') + totalPnl.toFixed(4) + ' USDC',
      cycles,
      finalTokens:  position?.quantity.value().toFixed(2) ?? '0.00',
      finalUsdcFree:    portfolio?.balance.available().value().toFixed(2) ?? '-',
      finalUsdcReserved: portfolio?.balance.reserved().value().toFixed(2) ?? '-',
    });
  }

  // Регистрируем первый рынок
  const ok = await registerMarketAndStrategy(activeInstrumentId, currentMarketId, currentAsset, currentMarketExpiresAtMs);
  if (!ok) {
    logger.fatal('Failed to register initial strategy');
    process.exit(1);
  }

  // Подключаемся к WS и подписываемся на первый токен
  await wsAdapter.subscribeToToken(currentTokenIdStr);
  try {
    await wsAdapter.connect();
  } catch (err) {
    logger.error('Failed to connect to Polymarket WS, retrying in background', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    // Адаптер сам переподключится — это не фатальная ошибка
  }

  logger.info('Bot is running in paper mode', {
    strategy: config.strategy,
    strategyId: strategy.id,
    marketId: String(currentMarketId),
    tokenId: currentTokenIdStr,
    expiresAt: new Date(currentMarketExpiresAtMs).toISOString(),
    hoursToExpiry: ((currentMarketExpiresAtMs - Date.now()) / 3_600_000).toFixed(2),
  });

  // Запускаем ротацию только для discovery режима
  if (discoveryAdapter) {
    // Цикл 1: проверка истечения + переключение рынка каждые 5 сек
    expiryCheckIntervalId = setInterval(() => { void checkExpiredMarket(); }, 5_000);
    // Цикл 2: обновление кэша discovery (пауза после завершения)
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);
    logger.info('Market rotation enabled', {
      expiryCheckMs: 5_000,
      scanPauseMs: mc.scanPauseMs ?? 60_000,
    });
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    if (expiryCheckIntervalId) { clearInterval(expiryCheckIntervalId); expiryCheckIntervalId = null; }
    if (scanTimeoutId) { clearTimeout(scanTimeoutId); scanTimeoutId = null; }

    try {
      // Сводка по текущему рынку перед остановкой
      printMarketSummary(currentDiscoveryCandidate?.question ?? String(currentMarketId));

      // Снимаем стратегию (отменяет все открытые ордера через CANCEL_ALL)
      await engine.scheduler.unregister(strategy.id);
      engine.scheduler.stop();
      engine.orderEventBridge.stop();
      simulator.stop();
      marketDataFeedAdapter.stop();
      await wsAdapter.disconnect();
      marketDataStore.stop();
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error('Error during shutdown', { err: err instanceof Error ? err : new Error(String(err)) });
    }
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ── Реализация backtest режима ─────────────────────────────────────────────────

/**
 * Запускает бота в backtest режиме: ReplayClock, snapshot market config.
 *
 * @remarks
 * Читает meta из первого JSONL снапшота для получения marketId и tokenId,
 * прогоняет BacktestEngine, выводит результаты и завершается.
 * Market.source должен быть 'snapshots'.
 */
async function runBacktest(): Promise<void> {
  if (config.market.source !== 'snapshots') {
    console.error('[Bot] backtest mode requires market.source=snapshots');
    process.exit(1);
  }

  const marketConfig = config.market;
  const snapshotPath = marketConfig.paths[0];
  const outcomeIndex = marketConfig.outcomeIndex ?? 1;

  if (!snapshotPath) {
    console.error('[Bot] market.paths must be non-empty for backtest mode');
    process.exit(1);
  }

  // Читаем meta из снапшота
  const metaResult = await readSnapshotMeta(snapshotPath, outcomeIndex);
  if (!metaResult) {
    console.error('[Bot] No meta line found in snapshot:', snapshotPath);
    process.exit(1);
  }

  const { marketId, instrumentId, asset } = metaResult;

  const replayClock = new ReplayClock(new Date(0));
  const infra = buildCoreInfra({ clock: replayClock, logLevel: LogLevel.INFO });
  const { logger, eventBus } = infra;

  logger.warn('Bot starting in backtest mode', {
    snapshot: path.basename(snapshotPath),
    outcomeIndex,
    marketId: String(marketId),
    instrumentId: String(instrumentId),
    initialBalance: config.resources.initialBalance,
  });

  const repos = buildRepositories();
  const { portfolioStore, orderRepo } = repos;

  const riskParams: RiskParams = buildRiskParams();

  const accountId = parseAccountId(config.account.accountId);
  if (!accountId) {
    logger.fatal('Invalid account.accountId', { accountId: config.account.accountId });
    process.exit(1);
  }

  // Chicken-and-egg
  const { mockClient } = buildPaperInfra({ clock: replayClock });
  const { processFillUseCase } = buildProcessFillUseCase({ infra, repos });

  const { simulator, exchangeClient } = buildPaperSimulator({
    mockClient,
    processFillUseCase,
    eventBus,
    clock: replayClock,
    logger,
    instrumentId,
    marketId,
    accountId,
    asset,
    config: config.paper,
  });

  const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
  const useCases = { processFillUseCase, ...orderUseCases };

  const { marketDataStore, marketCatalog } = buildMarketData({ infra });
  const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });

  // Регистрируем инструмент в каталоге (нужен BookUpdateHandler для маппинга tokenId → marketId)
  const expiresAtResult = TimestampService.create(Date.now() + 86400_000);
  if (!expiresAtResult.ok) {
    logger.fatal('Failed to create expiresAt timestamp');
    process.exit(1);
  }
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

  // Начальный портфель
  const initialBalanceDecimal = new Decimal(config.resources.initialBalance);
  const initialBalance = buildInitialBalance(config.resources.initialBalance, accountId);
  const portfolioResult = Portfolio.create({
    id: asPortfolioId(`portfolio:${config.account.accountId}`),
    accountId,
    balance: initialBalance,
  });
  if (!portfolioResult.ok) {
    logger.fatal('Failed to create portfolio', { error: String(portfolioResult.error) });
    process.exit(1);
  }
  portfolioStore.save(portfolioResult.value, 0);

  // BookUpdateHandler + BacktestEngine
  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);

  // Запуск
  marketDataStore.start();
  engine.orderEventBridge.start();
  simulator.start();
  engine.scheduler.start();

  // ── Единое логирование (paper/backtest/live) ───────────────────────────────
  // bookLogEvery=100 т.к. в backtest тысячи событий в секунду; logTrades=false
  subscribeToOrderEvents(eventBus, logger, { bookLogEvery: 100, logTrades: false });

  // ── Трекинг для отчёта backtest ────────────────────────────────────────────
  //
  // Отдельные подписки ТОЛЬКО для сбора данных (без логирования —
  // логирование уже выполняет subscribeToOrderEvents выше).
  // lastMarketEvent — прокси: что вызвало последний тик / fill.
  type MarketEventType = 'BOOK' | 'TRADE' | 'FILL';
  let lastMarketEvent: MarketEventType = 'BOOK';
  let bookSnapshotCount = 0;

  interface OrderMeta {
    placedAt: Date;
    placedBook: number;
    side: string;
    price: Decimal;
    size: Decimal;
    triggerReason: MarketEventType;
  }
  const orderMeta = new Map<string, OrderMeta>();

  interface FillRecord {
    orderId: string;
    side: string;
    price: string;
    size: string;
    notional: string;
    placedAt: Date;
    filledAt: Date;
    booksWaited: number;
    triggerReason: MarketEventType;
    fillSource: MarketEventType;
  }
  const executedFills: FillRecord[] = [];

  // Трекинг BOOK: счётчик + lastMarketEvent (без вывода — логирует subscribeToOrderEvents)
  eventBus.subscribe('BOOK_UPDATED', (_event) => {
    bookSnapshotCount++;
    lastMarketEvent = 'BOOK';
  });

  // Трекинг TRADE: lastMarketEvent (без вывода)
  eventBus.subscribe('TRADE_RECEIVED', (_event) => {
    lastMarketEvent = 'TRADE';
  });

  // Трекинг ORDER_CREATED: сохраняем мета для отчёта
  eventBus.subscribe('ORDER_CREATED', (event) => {
    orderMeta.set(String(event.orderId), {
      placedAt: replayClock.now(),
      placedBook: bookSnapshotCount,
      side: event.side,
      price: event.price.value(),
      size: event.size.value(),
      triggerReason: lastMarketEvent,
    });
  });

  // Трекинг ORDER_PARTIALLY_FILLED: собираем для отчёта
  const partialFills: Array<{ orderId: string; side: string; price: string; size: string; at: string }> = [];
  eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    partialFills.push({
      orderId: String(event.orderId).slice(0, 12) + '…',
      side: event.fill.side,
      price: event.fill.price.value().toFixed(4),
      size: event.fill.size.value().toFixed(2),
      at: replayClock.now().toISOString().slice(11, 19),
    });
  });

  // Трекинг ORDER_FILLED: сохраняем для отчёта, обновляем lastMarketEvent
  eventBus.subscribe('ORDER_FILLED', (event) => {
    const filledAt = replayClock.now();
    const orderId = String(event.orderId);
    const meta = orderMeta.get(orderId);
    const booksWaited = bookSnapshotCount - (meta?.placedBook ?? bookSnapshotCount);
    const fillSource = lastMarketEvent;
    lastMarketEvent = 'FILL';
    executedFills.push({
      orderId: orderId.slice(0, 12) + '…',
      side: event.fill.side,
      price: event.fill.price.value().toFixed(4),
      size: event.fill.size.value().toFixed(2),
      notional: event.fill.price.value().times(event.fill.size.value()).toFixed(4),
      placedAt: meta?.placedAt ?? filledAt,
      filledAt,
      booksWaited,
      triggerReason: meta?.triggerReason ?? 'BOOK',
      fillSource,
    });
  });

  const strategy = createStrategy({ type: config.strategy, params: config.strategyParams } as StrategyConfig, logger);
  const expirationMs = Date.now() + 24 * 60 * 60 * 1000;
  const marketStub = { expirationMs } as Parameters<typeof engine.scheduler.register>[0]['market'];

  const regResult = await engine.scheduler.register({ strategy, instrumentId, asset, accountId, market: marketStub });
  if (!regResult.ok) {
    logger.fatal('Failed to register strategy', { error: String(regResult.error) });
    process.exit(1);
  }

  const backtestEngine = new BacktestEngine(
    { filePaths: [snapshotPath], outcomeIndex },
    { bookUpdateHandler, eventBus, replayClock, logger },
  );

  const replayResult = await backtestEngine.run();

  // Остановка
  await engine.scheduler.unregister(strategy.id);
  engine.scheduler.stop();
  engine.orderEventBridge.stop();
  simulator.stop();
  marketDataStore.stop();

  // Результаты
  const orders = await orderRepo.getAll();
  const finalPortfolio = portfolioStore.get(accountId)!;
  const available = finalPortfolio.balance.available().value();
  const reserved = finalPortfolio.balance.reserved().value();
  const pnl = available.minus(initialBalanceDecimal);
  const pnlSign = pnl.gte(0) ? '+' : '';
  const totalPositionCost = [...finalPortfolio.positions.values()].reduce(
    (acc, p) => acc.plus(p.quantity.value().times(p.averageEntryPrice.value())),
    new Decimal(0),
  );

  logger.warn('=== BACKTEST RESULTS ===', {
    snapshot: path.basename(snapshotPath),
    outcome: outcomeIndex === 0 ? 'YES' : 'NO',
    bookEvents: replayResult.bookEvents,
    tradeEvents: replayResult.tradeEvents,
    errors: replayResult.errors,
    durationMs: replayResult.durationMs,
  });

  logger.warn('Strategy config', { type: config.strategy, ...config.strategyParams });

  logger.warn('Orders placed (open at end)', {
    count: orders.length,
    orders: orders.map(o => ({
      side: o.side,
      price: o.price.value().toFixed(4),
      size: o.size.value().toFixed(2),
      status: o.status,
    })),
  });

  // Построить сводку циклов BUY → SELL по порядку
  const buys = executedFills.filter(f => f.side === 'BUY');
  const sells = executedFills.filter(f => f.side === 'SELL');

  function fmtMs(ms: number): string {
    if (ms < 0) return `${ms}s(!)`;
    if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
    return `${Math.round(ms / 1000)}s`;
  }

  const cycles = buys.map((buy, i) => {
    const sell = sells[i];
    const waitMs = buy.filledAt.getTime() - buy.placedAt.getTime();
    const holdMs = sell ? sell.filledAt.getTime() - buy.filledAt.getTime() : null;
    const cyclePnl = sell
      ? new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(sell.size))
      : null;
    return {
      // BUY: что вызвало тик, время размещения и fill, сколько books ждал
      buyTrigger: buy.triggerReason,
      buyPlaced: buy.placedAt.toISOString().slice(11, 19),
      buyFilled: buy.filledAt.toISOString().slice(11, 19),
      buyPrice: buy.price,
      buyFillSource: buy.fillSource,
      buyBooksWaited: buy.booksWaited,
      buyWaitMs: fmtMs(waitMs),
      // SELL: аналогично
      sellTrigger: sell?.triggerReason ?? '-',
      sellFilled: sell ? sell.filledAt.toISOString().slice(11, 19) : '-',
      sellPrice: sell?.price ?? '-',
      sellFillSource: sell?.fillSource ?? '-',
      sellBooksWaited: sell?.booksWaited ?? '-',
      // Итог цикла
      held: holdMs !== null ? fmtMs(holdMs) : 'open',
      pnl: cyclePnl ? (cyclePnl.gte(0) ? '+' : '') + cyclePnl.toFixed(4) : '-',
    };
  });

  const buyCount = buys.length;
  const sellCount = sells.length;

  logger.warn('Executed cycles', {
    totalFills: executedFills.length,
    buys: buyCount,
    sells: sellCount,
    partialFills: partialFills.length,
    totalBooks: bookSnapshotCount,
    cycles,
  });

  if (partialFills.length > 0) {
    logger.warn('Partial fills (tape накапливает размер)', { partialFills });
  }

  logger.warn('Portfolio', {
    initialBalance: initialBalanceDecimal.toFixed(2),
    available: available.toFixed(4),
    reserved: reserved.toFixed(4),
    positionCost: totalPositionCost.toFixed(4),
    totalValue: available.plus(reserved).plus(totalPositionCost).toFixed(4),
    pnl: `${pnlSign}${pnl.toFixed(4)} USDC`,
    openPositions: [...finalPortfolio.positions.values()].map(p => ({
      token: String(p.instrumentId).slice(0, 10) + '…',
      qty: p.quantity.value().toFixed(2),
      avgEntry: p.averageEntryPrice.value().toFixed(4),
    })),
  });
}

// ── Реализация live режима ─────────────────────────────────────────────────────

/**
 * Запускает бота в live режиме: реальные ордера на Polymarket.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Валидация credentials из ENV
 * 2. Discovery рынка (fixed или discovery — аналогично paper режиму)
 * 3. Создание live инфраструктуры (REST stack + recovery services + WS user channel)
 * 4. Recovery: баланс с биржи через portfolioReplayService, сверка ордеров
 * 5. WS подключение (market data + user channel для fills)
 * 6. Запуск стратегии + ротация рынков (только для discovery)
 * 7. Polling fallback: reconcileTradesUseCase каждые 60 сек (safety net)
 *
 * ### Балансирование:
 * - Начальный баланс берётся с биржи через `portfolioReplayService.replay()`.
 * - `resources.initialBalance` из конфига игнорируется в live режиме.
 *
 * ### Ротация рынков:
 * - `source=discovery`: автоматическая ротация при истечении рынка.
 * - `source=fixed`: одиночный рынок без ротации.
 */
async function runLive(): Promise<void> {

  // ── Credentials из ENV ───────────────────────────────────────────────────

  const privateKey = process.env['PRIVATE_KEY'];
  const apiKey = process.env['POLYMARKET_API_KEY'];
  const apiSecret = process.env['POLYMARKET_API_SECRET'];
  const apiPassphrase = process.env['POLYMARKET_API_PASSPHRASE'];

  if (!privateKey || !apiKey || !apiSecret || !apiPassphrase) {
    console.error('[Bot] live mode requires PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE');
    process.exit(1);
  }

  const credentials: LiveCredentials = {
    privateKey,
    funderAddress: process.env['FUNDER_ADDRESS'] || undefined,
    apiKey,
    apiSecret,
    apiPassphrase,
  };

  // ── Core infra ───────────────────────────────────────────────────────────

  const infra = buildCoreInfra({ logLevel: LogLevel.INFO });
  const { clock, logger, eventBus } = infra;

  // ── Resolve первый рынок ──────────────────────────────────────────────────
  // Мутабельное состояние текущего рынка (обновляется при ротации)
  let activeInstrumentId: InstrumentId;
  let currentTokenIdStr: string;
  let currentMarketId: MarketId;
  let currentAsset: AssetId;
  let currentMarketExpiresAtMs: number;
  // Торговые параметры инструмента — обновляются из DiscoveredMarket при ротации
  let currentTickSize: Price = Price.of(new Decimal('0.001'));
  let currentMinOrderSize: Quantity = Quantity.of(new Decimal('1'));

  // Discovery-специфичное состояние
  type DiscoveryAdapter = PolymarketMarketDiscoveryAdapter;
  let discoveryAdapter: DiscoveryAdapter | null = null;
  let currentDiscoveryCandidate: import('@polymarket/ports').DiscoveredMarket | null = null;
  const closedMarkets = new Set<string>();
  let isShuttingDown = false;
  let expiryCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  let scanTimeoutId: ReturnType<typeof setTimeout> | null = null;

  if (config.market.source === 'fixed') {
    const mc = config.market;
    const mid = asMarketId(mc.marketId);
    if (!mid) {
      console.error(`[Bot] Invalid market.marketId: ${mc.marketId}`);
      process.exit(1);
    }
    const hexId = mc.marketId.replace(/^0x/i, '');
    const tokenBigInt = BigInt('0x' + hexId) * 2n + BigInt(mc.outcomeIndex);
    currentTokenIdStr = tokenBigInt.toString();
    const iId = asInstrumentId(currentTokenIdStr);
    const ast = asPolymarketCtfToken(currentTokenIdStr);
    if (!iId || !ast) {
      logger.fatal('Cannot derive instrumentId', { tokenIdStr: currentTokenIdStr });
      process.exit(1);
    }
    currentMarketId = mid;
    activeInstrumentId = iId;
    currentAsset = ast;
    currentMarketExpiresAtMs = Date.now() + 24 * 60 * 60 * 1000;
  } else if (config.market.source === 'discovery') {
    const mc = config.market;
    const filterConfig: IMarketFilterConfig = {
      minTimeToExpiryHours: mc.filter.minTimeToExpiryHours ?? 0,
      minSpread: 0,
      minLiquidity: mc.filter.minLiquidity ?? 0,
      maxMarketsToReturn: 10,
      anyOfKeywords: mc.filter.anyOfKeywords,
      requiredKeywords: mc.filter.requiredKeywords,
      excludedKeywords: mc.filter.excludedKeywords,
    };
    logger.info('Starting market discovery', { filter: filterConfig });

    const marketDataClient = new PolymarketMarketDataRestClient(
      { baseUrl: 'https://gamma-api.polymarket.com' },
      logger,
    );
    discoveryAdapter = new PolymarketMarketDiscoveryAdapter(
      marketDataClient,
      new MarketFilter(),
      new MarketScorer(clock),
      filterConfig,
      logger,
    );

    await discoveryAdapter.refresh();
    const candidates = await discoveryAdapter.findCandidates();
    const validCandidates = candidates.filter(c => c.expiresAt.toNumber() > Date.now());
    if (validCandidates.length === 0) {
      logger.fatal('No markets found matching discovery filter', { filter: filterConfig });
      process.exit(1);
    }

    const candidate = validCandidates[0]!;
    const tStr = candidate.allTokenIds?.[mc.outcomeIndex] ?? String(candidate.instrumentId);
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.fatal('Cannot create instrument from discovered market', { tokenIdStr: tStr });
      process.exit(1);
    }
    currentMarketId = candidate.marketId;
    activeInstrumentId = iId;
    currentAsset = ast;
    currentTokenIdStr = tStr;
    currentMarketExpiresAtMs = candidate.expiresAt.toNumber();
    // Торговые параметры из Gamma API — используются в registerMarketAndStrategy
    currentTickSize = candidate.tickSize;
    currentMinOrderSize = candidate.minOrderSize;
    currentDiscoveryCandidate = candidate;

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Initial market discovered', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(currentMarketId),
      tokenId: tStr,
      liquidity: candidate.liquidity.toFixed(0),
      expiresAt: new Date(currentMarketExpiresAtMs).toISOString(),
      hoursToExpiry: ((currentMarketExpiresAtMs - Date.now()) / 3_600_000).toFixed(2),
    });
  } else {
    console.error('[Bot] live mode supports market.source=fixed or market.source=discovery');
    process.exit(1);
  }

  logger.info('Bot starting in live mode', {
    strategy: config.strategy,
    marketId: String(currentMarketId),
    funderAddress: credentials.funderAddress ?? '(signer)',
  });

  const accountId = parseAccountId(config.account.accountId);
  if (!accountId) {
    logger.fatal('Invalid account.accountId', { accountId: config.account.accountId });
    process.exit(1);
  }

  const repos = buildRepositories();
  const { portfolioStore } = repos;
  const riskParams = buildRiskParams();

  // ── Live инфраструктура ──────────────────────────────────────────────────
  //
  // Polymarket использует ДВА отдельных WS endpoint:
  //   /ws/market — рыночные данные (orderbook, trades); принимает assets_ids
  //   /ws/user   — user events (fills, order lifecycle); принимает auth
  // Оба endpoint принимают ТОЛЬКО ОДНО subscription-сообщение на соединение,
  // поэтому нельзя слать market и user подписку на одно и то же соединение.

  const marketWsManager = new PolymarketWebSocketManager(
    { url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market' },
    logger,
  );
  const marketWsAdapter = new PolymarketWsAdapter(marketWsManager, logger);

  const userWsManager = new PolymarketWebSocketManager(
    { url: 'wss://ws-subscriptions-clob.polymarket.com/ws/user' },
    logger,
  );
  const userWsAdapter = new PolymarketWsAdapter(userWsManager, logger);

  const { processFillUseCase } = buildProcessFillUseCase({ infra, repos });

  const liveInfra = buildLiveInfra({
    credentials,
    infra,
    repos,
    processFillUseCase,
    userWsAdapter,
    accountId,
  });

  const useCases = {
    processFillUseCase,
    ...buildOrderUseCases({
      infra,
      repos,
      exchangeClient: liveInfra.exchangeClient,
      riskParams,
    }),
  };

  // ── FillOrchestrator: FILL_RECEIVED → ProcessFillUseCase ─────────────────
  // Без него WS fills публикуются в eventBus, но никто их не обрабатывает
  const fillOrchestrator = new FillOrchestrator({
    eventBus,
    processFill: processFillUseCase,
    logger,
  });
  fillOrchestrator.register();

  // ── Market data + strategy engine ────────────────────────────────────────

  const { marketDataStore, marketCatalog } = buildMarketData({ infra });
  const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });

  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);
  const marketDataFeedAdapter = new MarketDataFeedAdapter(marketWsAdapter, bookUpdateHandler, logger);

  // Trade bridge — публичные трейды → TRADE_RECEIVED (для tape-based аналитики)
  // activeInstrumentId мутабельная — автоматически переключается при ротации рынка
  marketWsAdapter.onTradeEvent(async (dto) => {
    const tradeInstrumentId = asInstrumentId(dto.asset_id);
    if (!tradeInstrumentId || String(tradeInstrumentId) !== String(activeInstrumentId)) return;
    const tsResult = TimestampService.create(Number(dto.timestamp));
    if (!tsResult.ok) return;
    try {
      await eventBus.publish({
        type: 'TRADE_RECEIVED',
        instrumentId: tradeInstrumentId,
        price: Price.of(new Decimal(dto.price)),
        size: Quantity.of(new Decimal(dto.size)),
        side: dto.side,
        timestamp: tsResult.value,
      });
    } catch {
      // невалидные уровни пропускаем
    }
  });

  // ── Стратегия (создаётся один раз — stateless) ───────────────────────────

  const strategy = createStrategy({ type: config.strategy, params: config.strategyParams } as StrategyConfig, logger);

  // ── Хелперы ротации рынков ───────────────────────────────────────────────

  /**
   * Регистрирует инструмент в каталоге и стратегию в планировщике.
   */
  async function registerMarketAndStrategy(
    instrumentId: InstrumentId,
    marketId: MarketId,
    asset: AssetId,
    expiresAtMs: number,
  ): Promise<boolean> {
    const expiresAtResult = TimestampService.create(expiresAtMs);
    if (!expiresAtResult.ok) {
      logger.error('Failed to create expiresAt timestamp', { expiresAtMs });
      return false;
    }
    // Используем currentTickSize/currentMinOrderSize — обновляются из кандидата в openMarket
    marketCatalog.register({
      instrumentId,
      marketId,
      tickSize: currentTickSize,
      minOrderSize: currentMinOrderSize,
      minOrderValue: Quantity.of(new Decimal('1')), // Polymarket: BUY-ордера >= $1
      active: true,
      expiresAt: expiresAtResult.value,
    });

    const marketStub = { expirationMs: expiresAtMs } as Parameters<typeof engine.scheduler.register>[0]['market'];
    const regResult = await engine.scheduler.register({ strategy, instrumentId, asset, accountId: accountId!, market: marketStub });
    if (!regResult.ok) {
      logger.error('Failed to register strategy', { error: String(regResult.error) });
      return false;
    }
    return true;
  }

  /**
   * Переключает бота на новый рынок из discovery.
   * В live режиме после переключения запускается сверка ордеров.
   */
  async function openMarket(candidate: import('@polymarket/ports').DiscoveredMarket): Promise<void> {
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const tStr = candidate.allTokenIds?.[mc.outcomeIndex] ?? String(candidate.instrumentId);
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.error('Cannot create instrument for candidate', { tokenIdStr: tStr, marketId: String(candidate.marketId) });
      return;
    }

    const expiresMs = candidate.expiresAt.toNumber();

    fillHistory = [];
    marketOpenMs = Date.now();

    activeInstrumentId = iId;
    currentTokenIdStr = tStr;
    currentMarketId = candidate.marketId;
    currentAsset = ast;
    currentMarketExpiresAtMs = expiresMs;
    // Обновляем торговые параметры из Gamma API — используются в registerMarketAndStrategy
    currentTickSize = candidate.tickSize;
    currentMinOrderSize = candidate.minOrderSize;
    currentDiscoveryCandidate = candidate;

    await marketWsAdapter.subscribeToToken(tStr);

    const ok = await registerMarketAndStrategy(iId, candidate.marketId, ast, expiresMs);
    if (!ok) return;

    // Сверяем ордера с биржей после переключения на новый рынок
    try {
      await liveInfra.orderReconciler.reconcile(accountId!);
    } catch (err) {
      logger.warn('Order reconciliation after market switch failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Market opened', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(candidate.marketId),
      tokenId: tStr,
      expiresAt: new Date(expiresMs).toISOString(),
      hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
    });
  }

  /**
   * Закрывает текущий рынок: отменяет все ордера, отписывается от WS, удаляет из каталога.
   */
  async function closeCurrentMarket(reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const savedTokenIdStr = currentTokenIdStr;
    const savedMarketId = currentMarketId;
    const savedInstrumentId = activeInstrumentId;

    logger.info('Closing market', { reason, marketId: String(savedMarketId), question: currentDiscoveryCandidate?.question });

    await engine.scheduler.unregister(strategy.id);
    printMarketSummary(currentDiscoveryCandidate?.question ?? String(savedMarketId));

    await marketWsAdapter.unsubscribeFromToken(savedTokenIdStr);
    marketCatalog.remove(savedInstrumentId);

    if (reason === 'EXPIRED') {
      closedMarkets.add(String(savedMarketId));
    }

    currentDiscoveryCandidate = null;
    logger.info('Market closed', { reason, marketId: String(savedMarketId) });
  }

  /**
   * Ищет следующий валидный рынок из кэша discovery и открывает его.
   */
  async function fillMarketSlot(): Promise<void> {
    if (!discoveryAdapter) return;

    let candidates: readonly import('@polymarket/ports').DiscoveredMarket[];
    try {
      candidates = await discoveryAdapter.findCandidates();
    } catch (err) {
      logger.error('Failed to read candidates from discovery cache', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const nowMs = Date.now();
    for (const c of candidates) {
      const key = String(c.marketId);
      if (closedMarkets.has(key)) continue;
      if (c.expiresAt.toNumber() <= nowMs + MIN_VIABLE_TRADING_MS) continue;
      await openMarket(c);
      return;
    }

    logger.warn('No valid market candidates in cache, waiting for next scan');
  }

  /** Закрываем рынок за 5 сек до истечения чтобы успеть снять ордера. */
  const CANCEL_BEFORE_EXPIRY_MS = 5_000;

  /**
   * Минимальное время жизни рынка (мс) для переключения.
   *
   * @remarks
   * Рынки с остатком < 30 сек не имеют смысла: ротация + подписка WS + первый тик
   * занимают ~5 сек, плюс CANCEL_BEFORE_EXPIRY_MS=5 сек на закрытие.
   */
  const MIN_VIABLE_TRADING_MS = 30_000;

  /**
   * Проверяет истечение текущего рынка и переключает на следующий.
   */
  async function checkExpiredMarket(): Promise<void> {
    if (isShuttingDown || !currentDiscoveryCandidate) return;
    if (currentMarketExpiresAtMs - Date.now() <= CANCEL_BEFORE_EXPIRY_MS) {
      const msTillExpiry = currentMarketExpiresAtMs - Date.now();
      logger.info('Market expiring soon, closing early to cancel orders', {
        marketId: String(currentMarketId),
        expiresAt: new Date(currentMarketExpiresAtMs).toISOString(),
        msTillExpiry: Math.max(0, msTillExpiry),
      });
      await closeCurrentMarket('EXPIRED');
      await fillMarketSlot();
    }
  }

  /**
   * Периодически обновляет кэш discovery (пауза после завершения запроса).
   */
  async function scheduleScanLoop(): Promise<void> {
    if (isShuttingDown || !discoveryAdapter) return;
    try {
      await discoveryAdapter.refresh();
      logger.debug('Discovery cache refreshed');
    } catch (err) {
      logger.error('Market discovery refresh failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
    if (!isShuttingDown) {
      const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
      scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);
    }
  }

  // ── Трекинг fills для сводки по рынку ────────────────────────────────────

  interface FillRecord {
    side: 'BUY' | 'SELL';
    size: string;
    price: string;
    notional: string;
    at: string;
    partial?: boolean;
  }

  interface PartialAccum {
    side: 'BUY' | 'SELL';
    totalSize: Decimal;
    totalNotional: Decimal;
    firstAt: string;
  }

  let fillHistory: FillRecord[] = [];
  let marketOpenMs = Date.now();
  const _partialAccum = new Map<string, PartialAccum>();

  eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    const id = String(event.orderId);
    const existing = _partialAccum.get(id);
    const fillSize = event.fill.size.value();
    const fillNotional = fillSize.times(event.fill.price.value());
    if (existing) {
      existing.totalSize = existing.totalSize.plus(fillSize);
      existing.totalNotional = existing.totalNotional.plus(fillNotional);
    } else {
      _partialAccum.set(id, { side: event.fill.side as 'BUY' | 'SELL', totalSize: fillSize, totalNotional: fillNotional, firstAt: clock.now().toISOString().slice(11, 19) });
    }
  });

  eventBus.subscribe('ORDER_FILLED', (event) => {
    const id = String(event.orderId);
    const accum = _partialAccum.get(id);
    _partialAccum.delete(id);
    const lastSize = event.fill.size.value();
    const totalSize = (accum?.totalSize ?? new Decimal(0)).plus(lastSize);
    const totalNotional = (accum?.totalNotional ?? new Decimal(0)).plus(lastSize.times(event.fill.price.value()));
    const avgPrice = totalNotional.div(totalSize);
    fillHistory.push({ side: event.fill.side as 'BUY' | 'SELL', size: totalSize.toFixed(2), price: avgPrice.toFixed(4), notional: totalNotional.toFixed(2), at: accum?.firstAt ?? clock.now().toISOString().slice(11, 19) });
  });

  eventBus.subscribe('ORDER_CANCELLED', (event) => {
    const id = String(event.orderId);
    const accum = _partialAccum.get(id);
    if (!accum || accum.totalSize.lte(0)) return;
    _partialAccum.delete(id);
    const avgPrice = accum.totalNotional.div(accum.totalSize);
    fillHistory.push({ side: accum.side, size: accum.totalSize.toFixed(2), price: avgPrice.toFixed(4), notional: accum.totalNotional.toFixed(2), at: accum.firstAt, partial: true });
  });

  /**
   * Выводит сводку по всем fills текущего рынка.
   */
  function printMarketSummary(marketQuestion: string): void {
    if (fillHistory.length === 0) {
      logger.info('=== Market summary: no fills ===', { market: marketQuestion });
      return;
    }
    const durationMs = Date.now() - marketOpenMs;
    const durMin = Math.floor(durationMs / 60_000);
    const durSec = Math.round((durationMs % 60_000) / 1000);
    const buys  = fillHistory.filter(f => f.side === 'BUY');
    const sells = fillHistory.filter(f => f.side === 'SELL');
    const cycles = buys.map((buy, i) => {
      const sell = sells[i];
      const buyLabel = `${buy.size}@${buy.price}${buy.partial ? '(partial)' : ''} [${buy.at}]`;
      if (!sell) return { buy: buyLabel, sell: '(open)', pnl: '-' };
      const pnl = new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(buy.size));
      return { buy: buyLabel, sell: `${sell.size}@${sell.price}${sell.partial ? '(partial)' : ''} [${sell.at}]`, pnl: (pnl.gte(0) ? '+' : '') + pnl.toFixed(4) + ' USDC' };
    });
    const totalPnl = sells.reduce((acc, sell, i) => {
      const buy = buys[i];
      if (!buy) return acc;
      return acc.plus(new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(sell.size)));
    }, new Decimal(0));
    const portfolio = portfolioStore.get(accountId!);
    const position  = portfolio?.getPosition(activeInstrumentId);
    logger.warn('=== Market summary ===', {
      market: marketQuestion,
      duration: `${durMin}m${durSec}s`,
      buys: buys.length,
      sells: sells.length,
      openCycles: buys.length - sells.length,
      totalPnl: (totalPnl.gte(0) ? '+' : '') + totalPnl.toFixed(4) + ' USDC',
      cycles,
      finalTokens: position?.quantity.value().toFixed(2) ?? '0.00',
      finalUsdcFree: portfolio?.balance.available().value().toFixed(2) ?? '-',
      finalUsdcReserved: portfolio?.balance.reserved().value().toFixed(2) ?? '-',
    });
  }

  // ── Real-time logging ─────────────────────────────────────────────────────

  subscribeToOrderEvents(eventBus, logger, {
    logBook: false,
    logTrades: false,
    getPortfolioSnapshot: () => {
      const portfolio = portfolioStore.get(accountId!);
      if (!portfolio) return undefined;
      const position = portfolio.getPosition(activeInstrumentId);
      const qty = position?.quantity.value();
      return {
        tokenQty: (qty ?? new Decimal(0)).toFixed(2),
        avgEntry: position ? position.averageEntryPrice.value().toFixed(4) : undefined,
        usdc: portfolio.balance.available().value().toFixed(2),
        reserved: portfolio.balance.reserved().value().toFixed(2),
      };
    },
  });

  // ── Recovery: баланс с биржи + сверка ордеров ────────────────────────────

  logger.info('Starting recovery: fetching balance from exchange + order reconciliation');
  try {
    await liveInfra.portfolioReplayService.replay(accountId);
    const portfolio = portfolioStore.get(accountId);
    if (portfolio) {
      logger.info('Portfolio initialised from exchange balance', {
        usdc: portfolio.balance.available().value().toFixed(2),
      });
    }
  } catch (err) {
    logger.error('Portfolio replay failed — starting with zero balance', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    const fallbackBalance = buildInitialBalance(0, accountId);
    const portfolioResult = Portfolio.create({
      id: asPortfolioId(`portfolio:${config.account.accountId}`),
      accountId,
      balance: fallbackBalance,
    });
    if (portfolioResult.ok) portfolioStore.save(portfolioResult.value, 0);
  }

  try {
    await liveInfra.orderReconciler.reconcile(accountId);
  } catch (err) {
    logger.warn('Order reconciliation failed — continuing', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }

  // ── Запуск ───────────────────────────────────────────────────────────────

  marketDataStore.start();
  engine.orderEventBridge.start();
  engine.scheduler.start();

  const ok = await registerMarketAndStrategy(activeInstrumentId, currentMarketId, currentAsset, currentMarketExpiresAtMs);
  if (!ok) {
    logger.fatal('Failed to register initial strategy');
    process.exit(1);
  }

  // ── WS подключение (два отдельных соединения) ────────────────────────────
  //
  // /ws/market — рыночные данные (orderbook, trades)
  await marketWsAdapter.subscribeToToken(currentTokenIdStr);
  try {
    await marketWsAdapter.connect();
  } catch (err) {
    logger.error('Failed to connect to market WS, retrying in background', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }

  // /ws/user — user events (fills, order lifecycle)
  await userWsAdapter.subscribeUserChannel({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    passphrase: credentials.apiPassphrase,
  });
  try {
    await userWsAdapter.connect();
  } catch (err) {
    logger.error('Failed to connect to user WS, retrying in background', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }

  marketDataFeedAdapter.start();
  liveInfra.userEventFeedAdapter.start();

  // ── REST polling fallback (safety net) ───────────────────────────────────

  const RECONCILE_INTERVAL_MS = 5_000;
  const reconcileIntervalId = setInterval(() => {
    void liveInfra.reconcileTradesUseCase.execute({ accountId }).then((result) => {
      if (!result.ok) {
        logger.warn('Periodic fill reconciliation failed', { error: result.error.message });
      }
    });
  }, RECONCILE_INTERVAL_MS);

  logger.info('Bot is running in live mode', {
    strategy: config.strategy,
    strategyId: strategy.id,
    marketId: String(currentMarketId),
    tokenId: currentTokenIdStr,
    source: config.market.source,
    reconcileIntervalSec: RECONCILE_INTERVAL_MS / 1000,
  });

  // ── Ротация рынков (только для discovery) ────────────────────────────────

  if (discoveryAdapter) {
    expiryCheckIntervalId = setInterval(() => { void checkExpiredMarket(); }, 5_000);
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);
    logger.info('Market rotation enabled', {
      expiryCheckMs: 5_000,
      scanPauseMs: mc.scanPauseMs ?? 60_000,
    });
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    if (expiryCheckIntervalId) { clearInterval(expiryCheckIntervalId); expiryCheckIntervalId = null; }
    if (scanTimeoutId) { clearTimeout(scanTimeoutId); scanTimeoutId = null; }
    clearInterval(reconcileIntervalId);

    try {
      printMarketSummary(currentDiscoveryCandidate?.question ?? String(currentMarketId));
      await engine.scheduler.unregister(strategy.id);
      engine.scheduler.stop();
      engine.orderEventBridge.stop();
      fillOrchestrator.unregister();
      liveInfra.userEventFeedAdapter.stop();
      marketDataFeedAdapter.stop();
      await marketWsAdapter.disconnect();
      await userWsAdapter.disconnect();
      marketDataStore.stop();
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error('Error during shutdown', { err: err instanceof Error ? err : new Error(String(err)) });
    }
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ── Вспомогательные функции ────────────────────────────────────────────────────

/**
 * Строит RiskParams с параметрами по умолчанию для paper/backtest режима.
 *
 * @returns Параметры риск-контроля
 */
function buildRiskParams(): RiskParams {
  return {
    maxOpenOrders: 2,
    maxOrderNotional: new Decimal('100'),
    maxPositionSize: new Decimal('20'),
    maxTotalExposure: new Decimal('2000'),
    minAvailableBalance: new Decimal('1'),
    minTimeToExpiryMs: 30_000, // не открывать BUY за < 30 сек до экспирации
  };
}

/**
 * Создаёт начальный баланс для портфеля.
 *
 * @param initialBalance - Начальный баланс в USDC
 * @param accountId - ID аккаунта
 * @returns Balance объект
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

/**
 * Читает первую meta-строку из JSONL снапшота и извлекает marketId и instrumentId.
 *
 * @param filePath - Путь к JSONL файлу
 * @param outcomeIndex - Индекс outcome (0 = YES, 1 = NO)
 * @returns Объект с marketId, instrumentId, asset или null если meta не найдена
 */
async function readSnapshotMeta(
  filePath: string,
  outcomeIndex: 0 | 1,
): Promise<{ marketId: MarketId; instrumentId: InstrumentId; asset: AssetId } | null> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw['t'] === 'meta') {
      rl.close();
      const marketId = asMarketId(raw['marketId'] as string);
      const tokenIds = raw['tokenIds'] as string[];
      const tokenId = tokenIds[outcomeIndex];
      if (!marketId || !tokenId) return null;
      const instrumentId = asInstrumentId(tokenId);
      const asset = asPolymarketCtfToken(tokenId);
      if (!instrumentId || !asset) return null;
      return { marketId, instrumentId, asset };
    }
  }

  rl.close();
  return null;
}


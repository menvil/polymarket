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
  assetIdToInstrumentId,
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
import { SimplePosition } from '@polymarket/use-cases';
import { createStrategy } from './strategyFactory.js';
import type { StrategyConfig } from './strategyFactory.js';
import type { IStrategy } from '@polymarket/strategy';
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

  // ── Типы для мульти-маркетных слотов (paper) ──────────────────────────────

  interface PaperFillRecord {
    side: 'BUY' | 'SELL';
    size: string;
    price: string;
    notional: string;
    at: string;
    partial?: boolean;
  }

  interface PaperPartialAccum {
    side: 'BUY' | 'SELL';
    totalSize: Decimal;
    totalNotional: Decimal;
    firstAt: string;
  }

  /**
   * Слот активного рынка в paper-режиме.
   *
   * @remarks
   * Аналогичен ActiveMarketSlot в runLive, но без tickSize/minOrderSize
   * (paper использует дефолты).
   */
  interface PaperMarketSlot {
    readonly instrumentId: InstrumentId;
    readonly marketId: MarketId;
    readonly asset: AssetId;
    readonly tokenIdStr: string;
    readonly expiresAtMs: number;
    readonly candidate: import('@polymarket/ports').DiscoveredMarket | null;
    readonly strategy: IStrategy;
    fillHistory: PaperFillRecord[];
    partialAccum: Map<string, PaperPartialAccum>;
    openedAt: number;
  }

  // ── Мульти-маркетное состояние (paper) ──────────────────────────────────────

  /** Активные рыночные слоты: key = tokenIdStr */
  const activeMarkets = new Map<string, PaperMarketSlot>();
  /** Маппинг orderId → tokenIdStr для роутинга fill-событий в правильный слот */
  const orderToSlot = new Map<string, string>();
  /** Счётчик для уникальных strategy ID */
  let _slotCounter = 0;

  const maxConcurrentMarkets = config.resources.maxConcurrentMarkets;
  const minCapitalPerMarket = config.resources.minCapitalPerMarket;

  // Discovery-специфичное состояние
  type DiscoveryAdapter = PolymarketMarketDiscoveryAdapter;
  let discoveryAdapter: DiscoveryAdapter | null = null;
  const closedMarkets = new Set<string>();
  let isShuttingDown = false;
  let expiryCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  let scanTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let _rotationInProgress = false;

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
    const tStr = tokenBigInt.toString();
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.fatal('Cannot derive instrumentId', { tokenIdStr: tStr });
      process.exit(1);
    }
    const fixedStrategy = createStrategy(
      { type: config.strategy, id: `${config.strategy}-slot-${_slotCounter++}`, params: config.strategyParams } as StrategyConfig,
      logger,
    );
    activeMarkets.set(tStr, {
      instrumentId: iId,
      marketId: mid,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      candidate: null,
      strategy: fixedStrategy,
      fillHistory: [],
      partialAccum: new Map(),
      openedAt: Date.now(),
    });
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
    const discoveryStrategy = createStrategy(
      { type: config.strategy, id: `${config.strategy}-slot-${_slotCounter++}`, params: config.strategyParams } as StrategyConfig,
      logger,
    );
    const expiresMs = candidate.expiresAt.toNumber();
    activeMarkets.set(tStr, {
      instrumentId: iId,
      marketId: candidate.marketId,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: expiresMs,
      candidate,
      strategy: discoveryStrategy,
      fillHistory: [],
      partialAccum: new Map(),
      openedAt: Date.now(),
    });

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Initial market discovered', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(candidate.marketId),
      tokenId: tStr,
      liquidity: candidate.liquidity.toFixed(0),
      expiresAt: new Date(expiresMs).toISOString(),
      hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
    });
  }

  const firstSlot = activeMarkets.values().next().value!;
  logger.info('Bot starting in paper mode', {
    strategy: config.strategy,
    marketId: String(firstSlot.marketId),
    maxConcurrentMarkets,
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
  const { processFillUseCase, portfolioService } = buildProcessFillUseCase({ infra, repos });

  const { simulator, exchangeClient } = buildPaperSimulator({
    mockClient,
    processFillUseCase,
    eventBus,
    clock,
    logger,
    instrumentId: firstSlot.instrumentId,
    marketId: firstSlot.marketId,
    accountId,
    asset: firstSlot.asset,
    config: config.paper,
  });

  const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
  const useCases = { processFillUseCase, portfolioService, ...orderUseCases };

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
  // Фильтруем только трейды по активным рынкам
  wsAdapter.onTradeEvent(async (dto) => {
    if (!activeMarkets.has(dto.asset_id)) return;
    const tradeInstrumentId = asInstrumentId(dto.asset_id);
    if (!tradeInstrumentId) return;
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

  // ── Хелперы ротации рынков ──────────────────────────────────────────────

  /**
   * Регистрирует инструмент в каталоге и стратегию в планировщике.
   *
   * @param slot - Слот активного рынка
   * @returns true если регистрация успешна
   */
  async function registerMarketAndStrategy(slot: PaperMarketSlot): Promise<boolean> {
    const expiresAtResult = TimestampService.create(slot.expiresAtMs);
    if (!expiresAtResult.ok) {
      logger.error('Failed to create expiresAt timestamp', { expiresAtMs: slot.expiresAtMs });
      return false;
    }
    marketCatalog.register({
      instrumentId: slot.instrumentId,
      marketId: slot.marketId,
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      minOrderValue: Quantity.of(new Decimal('1')),
      active: true,
      expiresAt: expiresAtResult.value,
    });

    const marketStub = { expirationMs: slot.expiresAtMs } as Parameters<typeof engine.scheduler.register>[0]['market'];
    const regResult = await engine.scheduler.register({
      strategy: slot.strategy,
      instrumentId: slot.instrumentId,
      asset: slot.asset,
      accountId: accountId!,
      market: marketStub,
    });
    if (!regResult.ok) {
      logger.error('Failed to register strategy', { error: String(regResult.error) });
      return false;
    }
    return true;
  }

  /**
   * Открывает новый рыночный слот из discovery-кандидата (paper).
   *
   * @param candidate - Кандидат рынка
   * @returns true если рынок успешно открыт
   */
  async function openMarket(candidate: import('@polymarket/ports').DiscoveredMarket): Promise<boolean> {
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const tStr = candidate.allTokenIds?.[mc.outcomeIndex] ?? String(candidate.instrumentId);
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.error('Cannot create instrument for candidate', { tokenIdStr: tStr, marketId: String(candidate.marketId) });
      return false;
    }

    // Проверяем доступный капитал
    const portfolio = portfolioStore.get(accountId!);
    if (portfolio) {
      const available = portfolio.balance.available().value();
      if (available.lt(minCapitalPerMarket)) {
        logger.warn('Insufficient capital for new market slot', {
          available: available.toFixed(2),
          minCapitalPerMarket,
          marketId: String(candidate.marketId),
        });
        return false;
      }
    }

    const expiresMs = candidate.expiresAt.toNumber();
    const slotStrategy = createStrategy(
      { type: config.strategy, id: `${config.strategy}-slot-${_slotCounter++}`, params: config.strategyParams } as StrategyConfig,
      logger,
    );

    const slot: PaperMarketSlot = {
      instrumentId: iId,
      marketId: candidate.marketId,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: expiresMs,
      candidate,
      strategy: slotStrategy,
      fillHistory: [],
      partialAccum: new Map(),
      openedAt: Date.now(),
    };

    // Регистрируем рынок в PaperExchangeClient для маршрутизации ордеров
    exchangeClient.registerMarket(iId, candidate.marketId, accountId!, ast);

    activeMarkets.set(tStr, slot);
    await wsAdapter.subscribeToToken(tStr);

    const ok = await registerMarketAndStrategy(slot);
    if (!ok) {
      activeMarkets.delete(tStr);
      return false;
    }

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Market opened', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(candidate.marketId),
      tokenId: tStr,
      activeSlots: activeMarkets.size,
      maxSlots: maxConcurrentMarkets,
      expiresAt: new Date(expiresMs).toISOString(),
      hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
    });
    return true;
  }

  /**
   * Закрывает конкретный рыночный слот (paper).
   *
   * @param tokenIdStr - Ключ слота
   * @param reason - Причина закрытия
   */
  async function closeMarket(tokenIdStr: string, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const slot = activeMarkets.get(tokenIdStr);
    if (!slot) return;

    logger.info('Closing market', { reason, marketId: String(slot.marketId), question: slot.candidate?.question });

    // Снимаем стратегию → автоматически отменяет все открытые ордера через CANCEL_ALL
    await engine.scheduler.unregister(slot.strategy.id);

    // Сводка ПОСЛЕ unregister чтобы finalUsdcReserved отображал 0 (ордера уже отменены)
    printMarketSummary(slot);

    await wsAdapter.unsubscribeFromToken(tokenIdStr);
    marketCatalog.remove(slot.instrumentId);

    if (reason === 'EXPIRED') {
      closedMarkets.add(String(slot.marketId));
    }

    // Очистить orderToSlot для этого слота
    for (const [orderId, slotKey] of orderToSlot) {
      if (slotKey === tokenIdStr) orderToSlot.delete(orderId);
    }

    activeMarkets.delete(tokenIdStr);
    logger.info('Market closed', { reason, marketId: String(slot.marketId), activeSlots: activeMarkets.size });
  }

  /**
   * Заполняет свободные слоты рынками из кэша discovery (paper).
   *
   * @remarks
   * Открывает кандидатов пока `activeMarkets.size < maxConcurrentMarkets`.
   * Не делает новый API-запрос — читает из кэша.
   */
  async function fillMarketSlots(): Promise<void> {
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

    const activeMarketIds = new Set<string>();
    for (const slot of activeMarkets.values()) {
      activeMarketIds.add(String(slot.marketId));
    }

    const nowMs = Date.now();
    for (const c of candidates) {
      if (activeMarkets.size >= maxConcurrentMarkets) break;

      const key = String(c.marketId);
      if (closedMarkets.has(key)) continue;
      if (activeMarketIds.has(key)) continue;
      if (c.expiresAt.toNumber() <= nowMs + MIN_VIABLE_TRADING_MS) continue;

      const opened = await openMarket(c);
      if (opened) activeMarketIds.add(key);
    }

    if (activeMarkets.size === 0) {
      logger.warn('No valid market candidates in cache, waiting for next scan');
    }
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
   * Проверяет истечение всех активных рынков и заполняет освободившиеся слоты (paper).
   *
   * @remarks
   * Reentrancy guard: `_rotationInProgress` предотвращает параллельные вызовы.
   */
  async function checkExpiredMarkets(): Promise<void> {
    if (isShuttingDown || _rotationInProgress) return;
    _rotationInProgress = true;
    try {
      const nowMs = Date.now();
      const expiredTokens: string[] = [];
      for (const [tokenIdStr, slot] of activeMarkets) {
        if (!slot.candidate) continue; // fixed-рынки не истекают
        if (slot.expiresAtMs - nowMs <= CANCEL_BEFORE_EXPIRY_MS) {
          logger.info('Market expiring soon, closing early to cancel orders', {
            marketId: String(slot.marketId),
            expiresAt: new Date(slot.expiresAtMs).toISOString(),
            msTillExpiry: Math.max(0, slot.expiresAtMs - nowMs),
          });
          expiredTokens.push(tokenIdStr);
        }
      }
      for (const tokenIdStr of expiredTokens) {
        await closeMarket(tokenIdStr, 'EXPIRED');
      }
      if (expiredTokens.length > 0) {
        await fillMarketSlots();
      }
    } finally {
      _rotationInProgress = false;
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
      let totalQty = new Decimal(0);
      let avgEntry: string | undefined;
      for (const slot of activeMarkets.values()) {
        const position = portfolio.getPosition(slot.instrumentId);
        if (position) {
          totalQty = totalQty.plus(position.quantity.value());
          if (!avgEntry) avgEntry = position.averageEntryPrice.value().toFixed(4);
        }
      }
      return {
        tokenQty: totalQty.toFixed(2),
        avgEntry,
        usdc: portfolio.balance.available().value().toFixed(2),
        reserved: portfolio.balance.reserved().value().toFixed(2),
      };
    },
  });

  // ── Трекинг fills для сводки по рынку (per-slot, paper) ───────────────────

  /** Роутинг ORDER_CREATED → orderToSlot для привязки ордера к слоту */
  eventBus.subscribe('ORDER_CREATED', (event) => {
    const iId = assetIdToInstrumentId(event.asset);
    const tokenIdStr = iId ? String(iId) : undefined;
    if (tokenIdStr && activeMarkets.has(tokenIdStr)) {
      orderToSlot.set(String(event.orderId), tokenIdStr);
    }
  });

  /** Хелпер: найти слот по orderId через orderToSlot */
  function findSlotByOrderId(orderId: string): PaperMarketSlot | undefined {
    const tokenIdStr = orderToSlot.get(orderId);
    return tokenIdStr ? activeMarkets.get(tokenIdStr) : undefined;
  }

  eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    const id = String(event.orderId);
    const slot = findSlotByOrderId(id);
    if (!slot) return;
    const existing = slot.partialAccum.get(id);
    const fillSize = event.fill.size.value();
    const fillNotional = fillSize.times(event.fill.price.value());
    if (existing) {
      existing.totalSize = existing.totalSize.plus(fillSize);
      existing.totalNotional = existing.totalNotional.plus(fillNotional);
    } else {
      slot.partialAccum.set(id, {
        side: event.fill.side as 'BUY' | 'SELL',
        totalSize: fillSize,
        totalNotional: fillNotional,
        firstAt: clock.now().toISOString().slice(11, 19),
      });
    }
  });

  eventBus.subscribe('ORDER_FILLED', (event) => {
    const id = String(event.orderId);
    const slot = findSlotByOrderId(id);
    if (!slot) return;
    const accum = slot.partialAccum.get(id);
    slot.partialAccum.delete(id);
    const lastSize = event.fill.size.value();
    const totalSize = (accum?.totalSize ?? new Decimal(0)).plus(lastSize);
    const totalNotional = (accum?.totalNotional ?? new Decimal(0))
      .plus(lastSize.times(event.fill.price.value()));
    const avgPrice = totalNotional.div(totalSize);
    slot.fillHistory.push({
      side: event.fill.side as 'BUY' | 'SELL',
      size: totalSize.toFixed(2),
      price: avgPrice.toFixed(4),
      notional: totalNotional.toFixed(2),
      at: accum?.firstAt ?? clock.now().toISOString().slice(11, 19),
    });
  });

  eventBus.subscribe('ORDER_CANCELLED', (event) => {
    const id = String(event.orderId);
    const slot = findSlotByOrderId(id);
    if (!slot) return;
    const accum = slot.partialAccum.get(id);
    if (!accum || accum.totalSize.lte(0)) return;
    slot.partialAccum.delete(id);
    const avgPrice = accum.totalNotional.div(accum.totalSize);
    slot.fillHistory.push({
      side: accum.side,
      size: accum.totalSize.toFixed(2),
      price: avgPrice.toFixed(4),
      notional: accum.totalNotional.toFixed(2),
      at: accum.firstAt,
      partial: true,
    });
  });

  /**
   * Выводит сводку по всем fills конкретного рыночного слота (paper).
   *
   * @param slot - Слот активного рынка
   */
  function printMarketSummary(slot: PaperMarketSlot): void {
    const marketQuestion = slot.candidate?.question ?? String(slot.marketId);
    if (slot.fillHistory.length === 0) {
      logger.info('=== Market summary: no fills ===', { market: marketQuestion });
      return;
    }

    const durationMs = Date.now() - slot.openedAt;
    const durMin = Math.floor(durationMs / 60_000);
    const durSec = Math.round((durationMs % 60_000) / 1000);

    const buys  = slot.fillHistory.filter(f => f.side === 'BUY');
    const sells = slot.fillHistory.filter(f => f.side === 'SELL');

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
    const position  = portfolio?.getPosition(slot.instrumentId);

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

  // Регистрируем все начальные слоты
  for (const slot of activeMarkets.values()) {
    const ok = await registerMarketAndStrategy(slot);
    if (!ok) {
      logger.fatal('Failed to register initial strategy', { marketId: String(slot.marketId) });
      process.exit(1);
    }
  }

  // Подключаемся к WS и подписываемся на все токены
  for (const slot of activeMarkets.values()) {
    await wsAdapter.subscribeToToken(slot.tokenIdStr);
  }
  try {
    await wsAdapter.connect();
  } catch (err) {
    logger.error('Failed to connect to Polymarket WS, retrying in background', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    // Адаптер сам переподключится — это не фатальная ошибка
  }

  const activeSlotIds = Array.from(activeMarkets.values()).map(s => s.strategy.id);
  logger.info('Bot is running in paper mode', {
    strategy: config.strategy,
    strategyIds: activeSlotIds,
    activeSlots: activeMarkets.size,
    maxConcurrentMarkets,
    source: config.market.source,
  });

  // Запускаем ротацию только для discovery режима
  if (discoveryAdapter) {
    expiryCheckIntervalId = setInterval(() => { void checkExpiredMarkets(); }, 5_000);
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);

    // Если maxConcurrentMarkets > 1, заполняем оставшиеся слоты
    if (maxConcurrentMarkets > 1) {
      void fillMarketSlots();
    }

    logger.info('Market rotation enabled', {
      expiryCheckMs: 5_000,
      scanPauseMs: mc.scanPauseMs ?? 60_000,
      maxConcurrentMarkets,
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
      // Закрываем все активные слоты: сводка + unregister стратегий
      for (const slot of activeMarkets.values()) {
        printMarketSummary(slot);
        await engine.scheduler.unregister(slot.strategy.id);
      }
      activeMarkets.clear();
      orderToSlot.clear();

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
  const { processFillUseCase, portfolioService } = buildProcessFillUseCase({ infra, repos });

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
  const useCases = { processFillUseCase, portfolioService, ...orderUseCases };

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

  // ── Типы для мульти-маркетных слотов ──────────────────────────────────────

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

  /**
   * Слот активного рынка — хранит всё состояние, привязанное к конкретному рынку.
   *
   * @remarks
   * Каждый рынок получает свой слот при открытии и удаляется из Map при закрытии.
   * Стратегия создаётся индивидуально для каждого слота с уникальным ID.
   */
  interface ActiveMarketSlot {
    readonly instrumentId: InstrumentId;
    readonly marketId: MarketId;
    readonly asset: AssetId;
    readonly tokenIdStr: string;
    readonly expiresAtMs: number;
    readonly tickSize: Price;
    readonly minOrderSize: Quantity;
    readonly candidate: import('@polymarket/ports').DiscoveredMarket | null;
    readonly strategy: IStrategy;
    fillHistory: FillRecord[];
    partialAccum: Map<string, PartialAccum>;
    openedAt: number;
  }

  // ── Мульти-маркетное состояние ──────────────────────────────────────────────

  /** Активные рыночные слоты: key = tokenIdStr */
  const activeMarkets = new Map<string, ActiveMarketSlot>();
  /** Маппинг orderId → tokenIdStr для роутинга fill-событий в правильный слот */
  const orderToSlot = new Map<string, string>();
  /** Счётчик для уникальных strategy ID (монотонно растёт, не уменьшается) */
  let _slotCounter = 0;

  const maxConcurrentMarkets = config.resources.maxConcurrentMarkets;
  const minCapitalPerMarket = config.resources.minCapitalPerMarket;

  // Discovery-специфичное состояние
  type DiscoveryAdapter = PolymarketMarketDiscoveryAdapter;
  let discoveryAdapter: DiscoveryAdapter | null = null;
  const closedMarkets = new Set<string>();
  let isShuttingDown = false;
  let expiryCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  let scanTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let _rotationInProgress = false;

  if (config.market.source === 'fixed') {
    const mc = config.market;
    const mid = asMarketId(mc.marketId);
    if (!mid) {
      console.error(`[Bot] Invalid market.marketId: ${mc.marketId}`);
      process.exit(1);
    }
    const hexId = mc.marketId.replace(/^0x/i, '');
    const tokenBigInt = BigInt('0x' + hexId) * 2n + BigInt(mc.outcomeIndex);
    const tStr = tokenBigInt.toString();
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.fatal('Cannot derive instrumentId', { tokenIdStr: tStr });
      process.exit(1);
    }
    const fixedStrategy = createStrategy(
      { type: config.strategy, id: `${config.strategy}-slot-${_slotCounter++}`, params: config.strategyParams } as StrategyConfig,
      logger,
    );
    activeMarkets.set(tStr, {
      instrumentId: iId,
      marketId: mid,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      candidate: null,
      strategy: fixedStrategy,
      fillHistory: [],
      partialAccum: new Map(),
      openedAt: Date.now(),
    });
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
    const discoveryStrategy = createStrategy(
      { type: config.strategy, id: `${config.strategy}-slot-${_slotCounter++}`, params: config.strategyParams } as StrategyConfig,
      logger,
    );
    const expiresMs = candidate.expiresAt.toNumber();
    activeMarkets.set(tStr, {
      instrumentId: iId,
      marketId: candidate.marketId,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: expiresMs,
      tickSize: candidate.tickSize,
      minOrderSize: candidate.minOrderSize,
      candidate,
      strategy: discoveryStrategy,
      fillHistory: [],
      partialAccum: new Map(),
      openedAt: Date.now(),
    });

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Initial market discovered', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(candidate.marketId),
      tokenId: tStr,
      liquidity: candidate.liquidity.toFixed(0),
      expiresAt: new Date(expiresMs).toISOString(),
      hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
    });
  } else {
    console.error('[Bot] live mode supports market.source=fixed or market.source=discovery');
    process.exit(1);
  }

  const firstSlot = activeMarkets.values().next().value!;
  logger.info('Bot starting in live mode', {
    strategy: config.strategy,
    marketId: String(firstSlot.marketId),
    maxConcurrentMarkets,
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

  const { processFillUseCase, portfolioService } = buildProcessFillUseCase({ infra, repos });

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
    portfolioService,
    ...buildOrderUseCases({
      infra,
      repos,
      exchangeClient: liveInfra.exchangeClient,
      riskParams,
    }),
  };

  // ── FillOrchestrator: FILL_RECEIVED → ProcessFillUseCase ─────────────────
  // FILL_RECEIVED публикуется на MATCHED (early processing) — Portfolio обновляется сразу.
  // FILL_FAILED → portfolioService.reverseFill() откатывает Portfolio при on-chain revert.
  const fillOrchestrator = new FillOrchestrator({
    eventBus,
    processFill: processFillUseCase,
    orderStateStore: repos.orderRepo,
    portfolioService,
    logger,
  });
  fillOrchestrator.register();

  // ── Market data + strategy engine ────────────────────────────────────────

  const { marketDataStore, marketCatalog } = buildMarketData({ infra });

  // ITokenBalanceChecker: при SELL rejection проверяем реальный баланс/allowance токена на CLOB.
  // Диагностика: отличает settlement lag (balance=0) от allowance проблемы (allowance=0).
  const tokenBalanceChecker = {
    async getTokenBalanceAllowance(tokenId: string) {
      try {
        return await liveInfra.balanceRestClient.getOutcomeTokenBalanceAllowance(tokenId);
      } catch {
        return undefined;
      }
    },
  };

  const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog, tokenBalanceChecker });

  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);
  const marketDataFeedAdapter = new MarketDataFeedAdapter(marketWsAdapter, bookUpdateHandler, logger);

  // Trade bridge — публичные трейды → TRADE_RECEIVED (для tape-based аналитики)
  // Фильтруем только трейды по активным рынкам
  marketWsAdapter.onTradeEvent(async (dto) => {
    if (!activeMarkets.has(dto.asset_id)) return;
    const tradeInstrumentId = asInstrumentId(dto.asset_id);
    if (!tradeInstrumentId) return;
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

  // ── Хелперы ротации рынков ───────────────────────────────────────────────

  /**
   * Регистрирует инструмент в каталоге и стратегию в планировщике.
   *
   * @param slot - Слот активного рынка с торговыми параметрами и стратегией
   * @returns true если регистрация успешна
   */
  async function registerMarketAndStrategy(slot: ActiveMarketSlot): Promise<boolean> {
    const expiresAtResult = TimestampService.create(slot.expiresAtMs);
    if (!expiresAtResult.ok) {
      logger.error('Failed to create expiresAt timestamp', { expiresAtMs: slot.expiresAtMs });
      return false;
    }
    marketCatalog.register({
      instrumentId: slot.instrumentId,
      marketId: slot.marketId,
      tickSize: slot.tickSize,
      minOrderSize: slot.minOrderSize,
      minOrderValue: Quantity.of(new Decimal('1')), // Polymarket: BUY-ордера >= $1
      active: true,
      expiresAt: expiresAtResult.value,
    });

    const marketStub = { expirationMs: slot.expiresAtMs } as Parameters<typeof engine.scheduler.register>[0]['market'];
    const regResult = await engine.scheduler.register({
      strategy: slot.strategy,
      instrumentId: slot.instrumentId,
      asset: slot.asset,
      accountId: accountId!,
      market: marketStub,
    });
    if (!regResult.ok) {
      logger.error('Failed to register strategy', { error: String(regResult.error) });
      return false;
    }
    return true;
  }

  /**
   * Открывает новый рыночный слот из discovery-кандидата.
   *
   * @remarks
   * Создаёт стратегию с уникальным ID, добавляет слот в activeMarkets,
   * подписывается на WS и регистрирует в каталоге + планировщике.
   * Не заменяет глобальные переменные — каждый слот автономен.
   *
   * @param candidate - Обнаруженный кандидат рынка
   * @returns true если рынок успешно открыт
   */
  async function openMarket(candidate: import('@polymarket/ports').DiscoveredMarket): Promise<boolean> {
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const tStr = candidate.allTokenIds?.[mc.outcomeIndex] ?? String(candidate.instrumentId);
    const iId = asInstrumentId(tStr);
    const ast = asPolymarketCtfToken(tStr);
    if (!iId || !ast) {
      logger.error('Cannot create instrument for candidate', { tokenIdStr: tStr, marketId: String(candidate.marketId) });
      return false;
    }

    // Проверяем доступный капитал
    const portfolio = portfolioStore.get(accountId!);
    if (portfolio) {
      const available = portfolio.balance.available().value();
      if (available.lt(minCapitalPerMarket)) {
        logger.warn('Insufficient capital for new market slot', {
          available: available.toFixed(2),
          minCapitalPerMarket,
          marketId: String(candidate.marketId),
        });
        return false;
      }
    }

    const expiresMs = candidate.expiresAt.toNumber();
    const slotStrategy = createStrategy(
      { type: config.strategy, id: `${config.strategy}-slot-${_slotCounter++}`, params: config.strategyParams } as StrategyConfig,
      logger,
    );

    const slot: ActiveMarketSlot = {
      instrumentId: iId,
      marketId: candidate.marketId,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: expiresMs,
      tickSize: candidate.tickSize,
      minOrderSize: candidate.minOrderSize,
      candidate,
      strategy: slotStrategy,
      fillHistory: [],
      partialAccum: new Map(),
      openedAt: Date.now(),
    };

    activeMarkets.set(tStr, slot);
    await marketWsAdapter.subscribeToToken(tStr);

    const ok = await registerMarketAndStrategy(slot);
    if (!ok) {
      activeMarkets.delete(tStr);
      return false;
    }

    // Сверяем ордера с биржей после открытия нового рынка
    try {
      await liveInfra.orderReconciler.reconcile(accountId!);
    } catch (err) {
      logger.warn('Order reconciliation after market open failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    const slug = candidate.rawMarket?.['slug'] as string | undefined;
    logger.info('Market opened', {
      question: candidate.question,
      slug: slug ?? '(no slug)',
      marketId: String(candidate.marketId),
      tokenId: tStr,
      activeSlots: activeMarkets.size,
      maxSlots: maxConcurrentMarkets,
      expiresAt: new Date(expiresMs).toISOString(),
      hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
    });
    return true;
  }

  /**
   * Закрывает конкретный рыночный слот: отменяет ордера, отписывается от WS, удаляет из каталога.
   *
   * @param tokenIdStr - Ключ слота (tokenIdStr)
   * @param reason - Причина закрытия
   */
  async function closeMarket(tokenIdStr: string, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const slot = activeMarkets.get(tokenIdStr);
    if (!slot) return;

    logger.info('Closing market', { reason, marketId: String(slot.marketId), question: slot.candidate?.question });

    await engine.scheduler.unregister(slot.strategy.id);
    printMarketSummary(slot);

    await marketWsAdapter.unsubscribeFromToken(tokenIdStr);
    marketCatalog.remove(slot.instrumentId);

    if (reason === 'EXPIRED') {
      closedMarkets.add(String(slot.marketId));
    }

    // Очистить orderToSlot для этого слота
    for (const [orderId, slotKey] of orderToSlot) {
      if (slotKey === tokenIdStr) orderToSlot.delete(orderId);
    }

    activeMarkets.delete(tokenIdStr);
    logger.info('Market closed', { reason, marketId: String(slot.marketId), activeSlots: activeMarkets.size });
  }

  /**
   * Заполняет свободные слоты рынками из кэша discovery.
   *
   * @remarks
   * Открывает кандидатов пока `activeMarkets.size < maxConcurrentMarkets`.
   * Пропускает уже активные (по marketId), закрытые и истёкшие рынки.
   */
  async function fillMarketSlots(): Promise<void> {
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

    // Собираем marketId всех активных слотов для дедупликации
    const activeMarketIds = new Set<string>();
    for (const slot of activeMarkets.values()) {
      activeMarketIds.add(String(slot.marketId));
    }

    const nowMs = Date.now();
    for (const c of candidates) {
      if (activeMarkets.size >= maxConcurrentMarkets) break;

      const key = String(c.marketId);
      if (closedMarkets.has(key)) continue;
      if (activeMarketIds.has(key)) continue;
      if (c.expiresAt.toNumber() <= nowMs + MIN_VIABLE_TRADING_MS) continue;

      const opened = await openMarket(c);
      if (opened) activeMarketIds.add(key);
    }

    if (activeMarkets.size === 0) {
      logger.warn('No valid market candidates in cache, waiting for next scan');
    }
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
   * Проверяет истечение всех активных рынков и заполняет освободившиеся слоты.
   *
   * @remarks
   * Reentrancy guard: `_rotationInProgress` предотвращает параллельные вызовы.
   */
  async function checkExpiredMarkets(): Promise<void> {
    if (isShuttingDown || _rotationInProgress) return;
    _rotationInProgress = true;
    try {
      const nowMs = Date.now();
      const expiredTokens: string[] = [];
      for (const [tokenIdStr, slot] of activeMarkets) {
        if (!slot.candidate) continue; // fixed-рынки не истекают
        if (slot.expiresAtMs - nowMs <= CANCEL_BEFORE_EXPIRY_MS) {
          logger.info('Market expiring soon, closing early to cancel orders', {
            marketId: String(slot.marketId),
            expiresAt: new Date(slot.expiresAtMs).toISOString(),
            msTillExpiry: Math.max(0, slot.expiresAtMs - nowMs),
          });
          expiredTokens.push(tokenIdStr);
        }
      }
      for (const tokenIdStr of expiredTokens) {
        await closeMarket(tokenIdStr, 'EXPIRED');
      }
      if (expiredTokens.length > 0) {
        await fillMarketSlots();
      }
    } finally {
      _rotationInProgress = false;
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

  // ── Трекинг fills для сводки по рынку (per-slot) ─────────────────────────

  /** Роутинг ORDER_CREATED → orderToSlot для привязки ордера к слоту */
  eventBus.subscribe('ORDER_CREATED', (event) => {
    const iId = assetIdToInstrumentId(event.asset);
    const tokenIdStr = iId ? String(iId) : undefined;
    if (tokenIdStr && activeMarkets.has(tokenIdStr)) {
      orderToSlot.set(String(event.orderId), tokenIdStr);
    }
  });

  /** Хелпер: найти слот по orderId через orderToSlot */
  function findSlotByOrderId(orderId: string): ActiveMarketSlot | undefined {
    const tokenIdStr = orderToSlot.get(orderId);
    return tokenIdStr ? activeMarkets.get(tokenIdStr) : undefined;
  }

  eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    const id = String(event.orderId);
    const slot = findSlotByOrderId(id);
    if (!slot) return;
    const existing = slot.partialAccum.get(id);
    const fillSize = event.fill.size.value();
    const fillNotional = fillSize.times(event.fill.price.value());
    if (existing) {
      existing.totalSize = existing.totalSize.plus(fillSize);
      existing.totalNotional = existing.totalNotional.plus(fillNotional);
    } else {
      slot.partialAccum.set(id, { side: event.fill.side as 'BUY' | 'SELL', totalSize: fillSize, totalNotional: fillNotional, firstAt: clock.now().toISOString().slice(11, 19) });
    }
  });

  eventBus.subscribe('ORDER_FILLED', (event) => {
    const id = String(event.orderId);
    const slot = findSlotByOrderId(id);
    if (!slot) return;
    const accum = slot.partialAccum.get(id);
    slot.partialAccum.delete(id);
    const lastSize = event.fill.size.value();
    const totalSize = (accum?.totalSize ?? new Decimal(0)).plus(lastSize);
    const totalNotional = (accum?.totalNotional ?? new Decimal(0)).plus(lastSize.times(event.fill.price.value()));
    const avgPrice = totalNotional.div(totalSize);
    slot.fillHistory.push({ side: event.fill.side as 'BUY' | 'SELL', size: totalSize.toFixed(2), price: avgPrice.toFixed(4), notional: totalNotional.toFixed(2), at: accum?.firstAt ?? clock.now().toISOString().slice(11, 19) });
  });

  eventBus.subscribe('ORDER_CANCELLED', (event) => {
    const id = String(event.orderId);
    const slot = findSlotByOrderId(id);
    if (!slot) return;
    const accum = slot.partialAccum.get(id);
    if (!accum || accum.totalSize.lte(0)) return;
    slot.partialAccum.delete(id);
    const avgPrice = accum.totalNotional.div(accum.totalSize);
    slot.fillHistory.push({ side: accum.side, size: accum.totalSize.toFixed(2), price: avgPrice.toFixed(4), notional: accum.totalNotional.toFixed(2), at: accum.firstAt, partial: true });
  });

  /**
   * Выводит сводку по всем fills конкретного рыночного слота.
   *
   * @param slot - Слот активного рынка
   */
  function printMarketSummary(slot: ActiveMarketSlot): void {
    const marketQuestion = slot.candidate?.question ?? String(slot.marketId);
    if (slot.fillHistory.length === 0) {
      logger.info('=== Market summary: no fills ===', { market: marketQuestion });
      return;
    }
    const durationMs = Date.now() - slot.openedAt;
    const durMin = Math.floor(durationMs / 60_000);
    const durSec = Math.round((durationMs % 60_000) / 1000);
    const buys  = slot.fillHistory.filter(f => f.side === 'BUY');
    const sells = slot.fillHistory.filter(f => f.side === 'SELL');
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
    const position  = portfolio?.getPosition(slot.instrumentId);
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
      // Агрегируем позиции по всем активным слотам
      let totalQty = new Decimal(0);
      let avgEntry: string | undefined;
      for (const slot of activeMarkets.values()) {
        const position = portfolio.getPosition(slot.instrumentId);
        if (position) {
          totalQty = totalQty.plus(position.quantity.value());
          if (!avgEntry) avgEntry = position.averageEntryPrice.value().toFixed(4);
        }
      }
      return {
        tokenQty: totalQty.toFixed(2),
        avgEntry,
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

  // Регистрируем все начальные слоты
  for (const slot of activeMarkets.values()) {
    const ok = await registerMarketAndStrategy(slot);
    if (!ok) {
      logger.fatal('Failed to register initial strategy', { marketId: String(slot.marketId) });
      process.exit(1);
    }
  }

  // ── WS подключение (два отдельных соединения) ────────────────────────────
  //
  // /ws/market — рыночные данные (orderbook, trades)
  for (const slot of activeMarkets.values()) {
    await marketWsAdapter.subscribeToToken(slot.tokenIdStr);
  }
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

  // ── Token balance reconciliation (CLOB → Portfolio sync) ───────────────
  // ВРЕМЕННО ОТКЛЮЧЕНО: будет включено позже для тестирования трёх режимов:
  // 1. Только события (WS fills)
  // 2. Только периодические запросы (polling CLOB balance)
  // 3. Совмещённый режим (события + polling для ускорения)
  //
  // Периодически сверяем баланс токенов на CLOB с позицией в Portfolio.
  // Если CLOB показывает больше токенов → корректируем Portfolio.
  // Цель: подхватить fills которые не дошли по WS (MATCHED/MINED застряли,
  // WS drop без reconnect, или fill вообще не пришёл).

  const TOKEN_BALANCE_SYNC_INTERVAL_MS = 30_000;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _tokenBalanceSyncDisabled = TOKEN_BALANCE_SYNC_INTERVAL_MS; // сохраняем константу
  /* TOKEN_BALANCE_SYNC — DISABLED
  const tokenBalanceSyncId = setInterval(() => {
    void (async () => {
      try {
        const tokenId = currentTokenIdStr;
        const instrumentId = activeInstrumentId;
        const portfolio = portfolioStore.get(accountId);
        if (!portfolio) return;

        const clobResult = await liveInfra.balanceRestClient.getOutcomeTokenBalance(tokenId);
        const clobBalance = new Decimal(clobResult);
        const portfolioPosition = portfolio.getPosition(instrumentId);
        const portfolioQty = portfolioPosition?.quantity.value() ?? new Decimal(0);

        // Разница значима если > 0.01 (порог dust для SELL precision)
        const diff = clobBalance.minus(portfolioQty);
        if (diff.abs().lte('0.01')) return;

        if (diff.gt(0)) {
          // CLOB показывает больше токенов → пропущенный fill.
          // Корректируем Portfolio: создаём позицию с CLOB балансом.
          // Entry price берём из существующей позиции или используем 0 (unknown).
          const entryPrice = portfolioPosition?.averageEntryPrice.value() ?? new Decimal(0);
          const newPosition = new SimplePosition({
            instrumentId,
            quantity: clobBalance,
            averageEntryPrice: entryPrice.isZero() ? new Decimal('0.50') : entryPrice,
            side: 'LONG' as const,
          });
          const updated = portfolio.upsertPosition(newPosition);
          portfolioStore.save(updated, 0);
          logger.warn('Token balance reconciled: CLOB > Portfolio', {
            tokenId: tokenId.substring(0, 16) + '...',
            clobBalance: clobBalance.toFixed(4),
            portfolioQty: portfolioQty.toFixed(4),
            diff: diff.toFixed(4),
            newQty: clobBalance.toFixed(4),
          });
        } else {
          // Portfolio показывает больше чем CLOB → возможно settlement ещё не завершился.
          // Логируем для диагностики, но НЕ корректируем (settlement может догнать).
          logger.debug('Token balance check: Portfolio > CLOB (possible pending settlement)', {
            tokenId: tokenId.substring(0, 16) + '...',
            clobBalance: clobBalance.toFixed(4),
            portfolioQty: portfolioQty.toFixed(4),
            diff: diff.toFixed(4),
          });
        }
      } catch (err) {
        logger.debug('Token balance sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, TOKEN_BALANCE_SYNC_INTERVAL_MS);
  TOKEN_BALANCE_SYNC — DISABLED */

  const activeSlotIds = Array.from(activeMarkets.values()).map(s => s.strategy.id);
  logger.info('Bot is running in live mode', {
    strategy: config.strategy,
    strategyIds: activeSlotIds,
    activeSlots: activeMarkets.size,
    maxConcurrentMarkets,
    source: config.market.source,
    reconcileIntervalSec: RECONCILE_INTERVAL_MS / 1000,
    // tokenBalanceSyncSec: TOKEN_BALANCE_SYNC_INTERVAL_MS / 1000, // DISABLED
  });

  // ── Ротация рынков (только для discovery) ────────────────────────────────

  if (discoveryAdapter) {
    expiryCheckIntervalId = setInterval(() => { void checkExpiredMarkets(); }, 5_000);
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);

    // Если maxConcurrentMarkets > 1, заполняем оставшиеся слоты после WS connect
    if (maxConcurrentMarkets > 1) {
      void fillMarketSlots();
    }

    logger.info('Market rotation enabled', {
      expiryCheckMs: 5_000,
      scanPauseMs: mc.scanPauseMs ?? 60_000,
      maxConcurrentMarkets,
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
    // clearInterval(tokenBalanceSyncId); // DISABLED — token balance sync

    try {
      // Закрываем все активные слоты: сводка + unregister стратегий
      for (const slot of activeMarkets.values()) {
        printMarketSummary(slot);
        await engine.scheduler.unregister(slot.strategy.id);
      }
      activeMarkets.clear();
      orderToSlot.clear();

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


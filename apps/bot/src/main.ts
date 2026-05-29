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
import * as fs from 'node:fs';
import Decimal from 'decimal.js';
import { LogLevel } from '@polymarket/logger';
import type { ILogger } from '@polymarket/logger';
import { PolymarketWsAdapter, PolymarketWebSocketManager } from '@polymarket/exchange/ws';
import { MarketDataFeedAdapter, PolymarketMarketDiscoveryAdapter, parseCryptoMeta, computeInterval, BinanceKlinesClient } from '@polymarket/exchange/adapters';
import type { CryptoMarketMeta } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { RtdsWebSocketClient } from '@polymarket/exchange/ws';
import {
  createDefaultCryptoSignalRegistry,
  CryptoMarketDataStore,
  CryptoPriceStore,
} from '@polymarket/market-state';
import type { CexVenue as StoreCexVenue } from '@polymarket/market-state';
import { CexCollectorService } from '@polymarket/cex-market-data';
import type { CexCollectorConfig, CexNormalizedEvent } from '@polymarket/cex-market-data';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { DiscoveredMarket, IMarketFilterConfig } from '@polymarket/ports';
import {
  asInstrumentId,
  asMarketId,
  asOrderId,
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
import type { BotConfig } from './config/BotConfig.js';
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
import { buildRecording, type RecordingInfra } from './bot/buildRecording.js';
import { CryptoSubscriptionManager } from './bot/CryptoSubscriptionManager.js';
import { PolymarketRedeemer } from './bot/PolymarketRedeemer.js';
import { AutoRedeemer } from './bot/AutoRedeemer.js';
import { buildMarketData } from './bot/buildMarketData.js';
import { buildStrategyEngine } from './bot/buildStrategyEngine.js';
import { readSnapshotMeta } from './bot/readSnapshotMeta.js';
import { runMultiMarketBacktest } from './bot/runMultiMarketBacktest.js';
import { FillOrchestrator } from '@polymarket/orchestrators';
import { SimplePosition } from '@polymarket/portfolio';
import { createStrategy } from './strategyFactory.js';
import type { StrategyConfig } from './strategyFactory.js';
import { selectStrategyForMarket } from './strategyRouter.js';
import type { RiskParams } from '@polymarket/risk';
import type { InstrumentInfo } from '@polymarket/ports';
import { MarketPairMatcher } from '@polymarket/cross-market';
import type { MarketInfo } from '@polymarket/cross-market';
import type { ArbTradeExecutionReport, CrossMarketArbConfig } from './strategies/CrossMarketArbStrategy.js';
import { CrossMarketArbStrategy } from './strategies/CrossMarketArbStrategy.js';
import { SelectiveEntryStrategy } from './strategies/SelectiveEntryStrategy.js';
import { MarketRotation, MIN_VIABLE_TRADING_MS } from './bot/MarketRotation.js';
import type { MarketSlot } from './bot/MarketRotation.js';

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
      'ws-live-data.polymarket.com',
      'relayer-v2.polymarket.com',
      'polygon-bor-rpc.publicnode.com',
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

  // ── Recording (опциональная запись рыночных данных и журнала решений) ──────
  const recording = buildRecording(config.recording, logger);

  // ── Мульти-маркетное состояние (paper) ──────────────────────────────────────
  // MarketRotation создаётся после buildStrategyEngine (нужен engine).
  // Промежуточные коллекции для initial market setup (до создания rotation).
  const maxConcurrentMarkets = config.resources.maxConcurrentMarkets;
  const minCapitalPerMarket = config.resources.minCapitalPerMarket;
  let _slotCounter = 0;
  const initialSlots = new Map<string, MarketSlot>();
  const initialCompTokens = new Set<string>();
  let discoveryAdapter: PolymarketMarketDiscoveryAdapter | null = null;

  // ── Crypto price infrastructure (paper) ────────────────────────────────
  const cryptoPriceStore = new CryptoPriceStore();
  const cryptoMarketDataStore = new CryptoMarketDataStore();
  const cryptoSignalRegistry = createDefaultCryptoSignalRegistry();
  const paperCexService = createBotCexService(config, logger, cryptoMarketDataStore, recording ?? undefined);
  const binanceClient = new BinanceKlinesClient(logger);
  const rtdsClient = new RtdsWebSocketClient(
    { url: 'wss://ws-live-data.polymarket.com' },
    logger,
  );

  // RTDS → CryptoPriceStore wiring
  // Передаём ВСЕ цены (Chainlink + Binance) — стратегия сама выбирает source.
  //
  // Chainlink strike price fallback: если targetPrice ещё не установлен
  // (Gamma API не вернула priceToBeat, Binance kline не доступен),
  // первая Chainlink цена после eventStartTime используется как strike.
  // Chainlink strike price fallback:
  // Map: rtdsFilter → eventStartTimeMs. Первая Chainlink цена с ts >= eventStartTime = strike.
  const pendingChainlinkStrike = new Map<string, number>(); // symbol → eventStartTimeMs
  /** Менеджер RTDS подписок paper mode (subscribe/deferred cleanup) */
  const paperCryptoSubs = new CryptoSubscriptionManager(rtdsClient, logger);
  let lastCryptoPriceLogMs = 0;
  const CRYPTO_PRICE_LOG_INTERVAL_MS = 30_000;
  // Recording: подключаем запись крипто-цен из RTDS
  recording?.wireToRtds(rtdsClient);

  rtdsClient.onPrice((symbol, price, ts) => {
    cryptoPriceStore.updatePrice(symbol, price, ts);
    cryptoMarketDataStore.updatePrice({ symbol, price, timestampMs: ts, receivedTsMs: Date.now() });

    // Периодический лог крипто-цен (раз в 30с) — символ активного рынка или арб-пары
    if (symbol.includes('/')) {
      const isActiveSymbol = Array.from(activeMarkets.values()).some(s => s.cryptoMeta?.rtdsFilter === symbol)
        || Array.from(activeArbPairs.values()).some(p => p.easySlot.cryptoMeta?.rtdsFilter === symbol);
      if (isActiveSymbol) {
        const now = Date.now();
        if (now - lastCryptoPriceLogMs >= CRYPTO_PRICE_LOG_INTERVAL_MS) {
          lastCryptoPriceLogMs = now;
          const snap = cryptoPriceStore.get(symbol);
          logger.info('Crypto price update', {
            symbol,
            price: price.toFixed(2),
            targetPrice: snap?.targetPrice?.toFixed(2) ?? '-',
            source: 'chainlink',
          });
        }
      }
    }

    // Chainlink strike fallback: первая Chainlink цена после eventStartTime
    if (symbol.includes('/') && pendingChainlinkStrike.has(symbol)) {
      const eventStartMs = pendingChainlinkStrike.get(symbol)!;
      if (ts >= eventStartMs) {
        cryptoPriceStore.setTargetPrice(symbol, price);
        pendingChainlinkStrike.delete(symbol);
        logger.info('Strike price from Chainlink RTDS (first after eventStart)', {
          symbol,
          strikePrice: price,
          chainlinkTs: new Date(ts).toISOString(),
          eventStartTime: new Date(eventStartMs).toISOString(),
        });
      }
    }

    // Арб-пары: определяем strike для easy и hard рынков из первой Chainlink цены
    // после eventStartTime каждого рынка. Easy и hard имеют разные startTime → разные strikes.
    if (symbol.includes('/')) {
      for (const pair of activeArbPairs.values()) {
        // Проверяем что символ соответствует этой паре (e.g. 'btc/usd' для BTC пары)
        const pairSymbol = pair.easySlot.cryptoMeta?.rtdsFilter;
        if (!pairSymbol || pairSymbol !== symbol) continue;

        // Диагностика: логируем почему strike не назначается
        if (!pair.easyStrikeLocked || !pair.hardStrikeLocked) {
          const nowWall = Date.now();
          // Логируем только раз в 60с чтобы не спамить
          const diagKey = `_lastStrikeDiagMs_${pair.pairId}`;
          const lastDiag = (pair as any)[diagKey] ?? 0;
          if (nowWall - lastDiag > 60_000) {
            (pair as any)[diagKey] = nowWall;
            logger.debug('Strike assignment check', {
              pairId: pair.pairId.slice(0, 30) + '...',
              symbol,
              chainlinkTs: ts,
              chainlinkTsIso: new Date(ts).toISOString(),
              easyStartMs: pair.easyStartMs,
              easyStartIso: pair.easyStartMs > 0 ? new Date(pair.easyStartMs).toISOString() : 'N/A',
              hardStartMs: pair.hardStartMs,
              hardStartIso: pair.hardStartMs > 0 ? new Date(pair.hardStartMs).toISOString() : 'N/A',
              easyLocked: pair.easyStrikeLocked,
              hardLocked: pair.hardStrikeLocked,
              easyReady: !pair.easyStrikeLocked && pair.easyStartMs > 0 && ts >= pair.easyStartMs,
              hardReady: !pair.hardStrikeLocked && pair.hardStartMs > 0 && ts >= pair.hardStartMs,
            });
          }
        }

        // easy (15m) = peer market → peerStrike (2nd arg)
        if (!pair.easyStrikeLocked && pair.easyStartMs > 0 && ts >= pair.easyStartMs) {
          pair.easyStrikeLocked = true;
          pair.strategy.updateStrikes(null, price);
          logger.info('Arb peer (easy) strike from Chainlink', {
            pairId: pair.pairId,
            peerStrike: price,
            assignment: pair.strategy.assignment,
            chainlinkTs: new Date(ts).toISOString(),
            eventStartTime: new Date(pair.easyStartMs).toISOString(),
          });
        }
        // hard (5m) = slot market → slotStrike (1st arg)
        if (!pair.hardStrikeLocked && pair.hardStartMs > 0 && ts >= pair.hardStartMs) {
          pair.hardStrikeLocked = true;
          pair.strategy.updateStrikes(price, null);
          logger.info('Arb slot (hard) strike from Chainlink', {
            pairId: pair.pairId,
            slotStrike: price,
            assignment: pair.strategy.assignment,
            chainlinkTs: new Date(ts).toISOString(),
            eventStartTime: new Date(pair.hardStartMs).toISOString(),
          });
        }
      }

      // Warming пара: назначаем strikes из Chainlink (стратегии ещё нет — сохраняем в warming)
      if (warmingArbPair) {
        const wp = warmingArbPair;
        const wpSymbol = wp.easyCryptoMeta?.rtdsFilter;
        if (wpSymbol && wpSymbol === symbol) {
          if (!wp.easyStrikeLocked && wp.easyStartMs > 0 && ts >= wp.easyStartMs) {
            wp.easyStrikeLocked = true;
            wp.easyStrike = price;
            logger.info('Warming pair: easy strike from Chainlink', {
              pairId: wp.pairId,
              easyStrike: price,
              chainlinkTs: new Date(ts).toISOString(),
            });
          }
          if (!wp.hardStrikeLocked && wp.hardStartMs > 0 && ts >= wp.hardStartMs) {
            wp.hardStrikeLocked = true;
            wp.hardStrike = price;
            logger.info('Warming pair: hard strike from Chainlink', {
              pairId: wp.pairId,
              hardStrike: price,
              chainlinkTs: new Date(ts).toISOString(),
            });
          }
        }
      }
    }
  });

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
    const fixedSelection = selectStrategyForMarket(config, {
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    });
    if (!fixedSelection) {
      logger.fatal('No strategy rule matches fixed market');
      process.exit(1);
    }
    const fixedStrategy = createStrategy(
      { type: fixedSelection.strategy, id: `${fixedSelection.strategy}-slot-${_slotCounter++}`, params: fixedSelection.strategyParams } as StrategyConfig,
      logger,
      recording?.journal,
      config.execution,
    );
    initialSlots.set(tStr, {
      instrumentId: iId,
      marketId: mid,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      candidate: null,
      strategy: fixedStrategy,
      cryptoMeta: undefined,
      outcomeIndex: (config.market as { outcomeIndex?: number }).outcomeIndex as 0 | 1 ?? 0,
      fillHistory: [],
      partialAccum: new Map(),
        directPartialAccum: new Map(),
      openedAt: Date.now(),
    });
  } else {
    // Discovery mode: создаём адаптер один раз — он будет использоваться для ротации
    const mc = config.market;
    const filterConfig: IMarketFilterConfig = {
      minTimeToExpiryHours: mc.filter.minTimeToExpiryHours ?? 0,
      minSpread: 0,
      minLiquidity: mc.filter.minLiquidity ?? 0,
      maxMarketsToReturn: 100,  // берём несколько кандидатов для ротации
      anyOfKeywords: mc.filter.anyOfKeywords,
      requiredKeywords: mc.filter.requiredKeywords,
      excludedKeywords: mc.filter.excludedKeywords,
      minDurationMinutes: mc.filter.minDurationMinutes,
      maxDurationMinutes: mc.filter.maxDurationMinutes,
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

    // Initial market будет открыт через rotation.fillMarketSlots() после создания rotation.
    await discoveryAdapter.refresh();

  }

  // Для non-arb: firstSlot обязателен. Для arb: placeholder — будет перезаписан через registerMarket().
  const firstSlot = initialSlots.values().next().value;
  const placeholderInstrumentId = firstSlot?.instrumentId ?? asInstrumentId('1')!;
  const placeholderMarketId = firstSlot?.marketId ?? asMarketId('0x0000000000000000000000000000000000000000000000000000000000000001')!;
  const placeholderAsset = firstSlot?.asset ?? asPolymarketCtfToken('1')!;

  logger.info('Bot starting', {
    mode: 'paper',
    strategy: config.strategyRules?.length ? 'multi-strategy' : config.strategy,
    ...(config.strategyRules?.length ? { rules: config.strategyRules.map(r => r.label) } : {}),
    marketId: firstSlot ? String(firstSlot.marketId) : '(arb: deferred)',
    maxConcurrentMarkets,
    initialBalance: config.resources.initialBalance,
    account: config.account.accountId,
  });

  const repos = buildRepositories();
  const { portfolioStore } = repos;

  const riskParams: RiskParams = buildRiskParams(config);

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
    portfolioStore,
    eventBus,
    clock,
    logger,
    instrumentId: placeholderInstrumentId,
    marketId: placeholderMarketId,
    accountId,
    asset: placeholderAsset,
    config: config.paper,
  });

  const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
  const useCases = { processFillUseCase, portfolioService, ...orderUseCases };

  const { marketDataStore, marketCatalog } = buildMarketData({ infra });
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

  if (paperCexService) {
    await paperCexService.cleanup();
    paperCexService.start();
  }

  // BookUpdateHandler — конвертирует WS snapshots в BOOK_UPDATED события
  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);

  // Polymarket WebSocket — live рыночные данные
  const wsManager = new PolymarketWebSocketManager(
    { url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market' },
    logger,
  );
  const wsAdapter = new PolymarketWsAdapter(wsManager, logger);

  // ── MarketRotation (единый модуль ротации для paper) ───────────────────
  const rotation = new MarketRotation({
    logger,
    clock,
    eventBus,
    portfolioStore,
    accountId: accountId!,
    wsAdapter,
    cryptoPriceStore,
    cryptoSubs: paperCryptoSubs,
    pendingChainlinkStrike,
    binanceClient,
    engine,
    marketCatalog,
    recording,
    config,
    maxConcurrentMarkets,
    minCapitalPerMarket,
    mode: 'paper',
    exchangeClient,
  });
  // Fixed market: переносим initial slot; Discovery: rotation сам откроет через fillMarketSlots
  for (const [key, slot] of initialSlots) rotation.activeMarkets.set(key, slot);
  for (const compToken of initialCompTokens) rotation.activeCompTokens.add(compToken);
  if (discoveryAdapter) {
    rotation.setDiscoveryAdapter(discoveryAdapter);
    if (config.strategy !== 'cross-market-arb') {
      await rotation.fillMarketSlots();
      if (rotation.activeMarkets.size === 0) {
        logger.fatal('No markets found matching discovery filter at startup');
        process.exit(1);
      }
    }
  }
  const activeMarkets = rotation.activeMarkets;
  const activeCompTokens = rotation.activeCompTokens;
  const closedMarkets = rotation.closedMarkets;
  const orderToSlot = rotation.orderToSlot;

  // MarketDataFeedAdapter — маршрутизирует orderbook snapshots → BookUpdateHandler → BOOK_UPDATED
  const marketDataFeedAdapter = new MarketDataFeedAdapter(wsAdapter, bookUpdateHandler, logger);

  // Recording: подключаем запись ВС сырых WS-сообщений (тот же подход что collect-data)
  recording?.wireToWs(wsAdapter);
  recording?.wireToEventBus(eventBus, (asset) => {
    const iId = assetIdToInstrumentId(asset as Parameters<typeof assetIdToInstrumentId>[0]);
    return iId ? String(iId) : undefined;
  });

  // Trade bridge — публичные трейды → TRADE_RECEIVED (для tape-based fills в PaperFillSimulator)
  // Фильтруем трейды по активным рынкам и комплементарным токенам (для dual-token стратегий)
  wsAdapter.onTradeEvent(async (dto) => {
    if (!activeMarkets.has(dto.asset_id) && !activeCompTokens.has(dto.asset_id)) return;
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


  // ── Ротация рынков — управляется через MarketRotation ──────────────────
  // registerMarketAndStrategy, openMarket, closeMarket, fillMarketSlots,
  // checkExpiredMarkets, scheduleScanLoop — все в rotation.


  // ── Кросс-маркетный арбитраж (paper) ────────────────────────────────────

  /**
   * Слот пассивного рынка (easy нога арб-пары).
   *
   * @remarks
   * Easy рынок не имеет стратегии — данные читаются через MarketDataStore.getTopOfBook().
   * Ордера на easy ногу размещаются через callback в CrossMarketArbStrategy.
   */
  interface ArbEasySlot {
    readonly instrumentId: InstrumentId;
    readonly marketId: MarketId;
    readonly asset: AssetId;
    readonly tokenIdStr: string;
    readonly candidate: import('@polymarket/ports').DiscoveredMarket;
    readonly cryptoMeta: CryptoMarketMeta | undefined;
  }

  /**
   * Арбитражная пара: easy + hard рынок.
   *
   * @remarks
   * hard слот живёт в `activeMarkets` (имеет стратегию).
   * easy слот — пассивный (только WS-подписка + marketCatalog).
   */
  interface ArbPairSlot {
    readonly pairId: string;
    readonly easySlot: ArbEasySlot;
    readonly hardTokenIdStr: string;
    /** hardDown токен (BUY нога UP арбитража) — нужен для WS-отписки при закрытии */
    readonly hardDownTokenIdStr: string;
    /** easyDown токен (BUY нога DOWN арбитража) — нужен для WS-отписки при закрытии */
    readonly easyDownTokenIdStr: string | undefined;
    readonly expiresAtMs: number;
    /** Стратегия арб-пары — для обновления strikes из Chainlink RTDS */
    readonly strategy: CrossMarketArbStrategy;
    /** eventStartTimeMs easy рынка (для определения strike) */
    readonly easyStartMs: number;
    /** eventStartTimeMs hard рынка (для определения strike) */
    readonly hardStartMs: number;
    /** Уже получен easy strike */
    easyStrikeLocked: boolean;
    /** Уже получен hard strike */
    hardStrikeLocked: boolean;
  }

  /**
   * Пара в «зоне прогрева»: WS + RTDS подписки активны, книги ордеров заполняются,
   * strikes назначаются из Chainlink — но стратегия ещё НЕ создана.
   *
   * @remarks
   * Warming pair не занимает слот в `activeMarkets` и не считается при проверке
   * `maxConcurrentMarkets`. При промоушне (`promoteWarmPair()`) все данные уже готовы —
   * создаётся только стратегия + callback + scheduler registration.
   */
  interface WarmingArbPair {
    readonly pairId: string;
    readonly easyCandidate: import('@polymarket/ports').DiscoveredMarket;
    readonly hardCandidate: import('@polymarket/ports').DiscoveredMarket;
    readonly easyUpTokenStr: string;
    readonly hardUpTokenStr: string;
    readonly hardDownTokenStr: string;
    readonly easyDownTokenStr: string | undefined;
    readonly easyIId: InstrumentId;
    readonly hardUpIId: InstrumentId;
    readonly hardDownIId: InstrumentId;
    readonly easyDownIId: InstrumentId | undefined;
    readonly easyAst: AssetId;
    readonly hardUpAst: AssetId;
    readonly hardDownAst: AssetId;
    readonly easyCryptoMeta: CryptoMarketMeta | undefined;
    readonly hardCryptoMeta: CryptoMarketMeta | undefined;
    readonly expiresAtMs: number;
    readonly easyStartMs: number;
    readonly hardStartMs: number;
    /** Strike от Chainlink уже получен для easy рынка */
    easyStrikeLocked: boolean;
    /** Strike от Chainlink уже получен для hard рынка */
    hardStrikeLocked: boolean;
    /** Текущий easy strike (назначается из Chainlink RTDS) */
    easyStrike: number | null;
    /** Текущий hard strike (назначается из Chainlink RTDS) */
    hardStrike: number | null;
  }

  /** Активные арб-пары: key = pairId */
  const activeArbPairs = new Map<string, ArbPairSlot>();
  /** Маппинг hardTokenIdStr → pairId для быстрого поиска */
  const hardTokenToArbPair = new Map<string, string>();
  /** Пара в зоне прогрева (максимум одна) — WS/RTDS подписки активны, стратегии нет */
  let warmingArbPair: WarmingArbPair | null = null;
  /** За сколько мс до expiry начинать прогрев следующей пары (используется в custom arb check) */
  /** Счётчик для easy leg ордеров */
  let _arbOrderCounter = 0;
  const isArbMode = config.strategy === 'cross-market-arb';

  const pairMatcher = new MarketPairMatcher();

  /**
   * Открывает арбитражную пару (easy + hard) из двух discovery-кандидатов.
   *
   * @param easyCandidate - Кандидат easy рынка (длинная дюрация, напр. 15m)
   * @param hardCandidate - Кандидат hard рынка (короткая дюрация, напр. 5m)
   * @returns true если пара успешно открыта
   *
   * @remarks
   * ### Алгоритм:
   * 1. Деривация tokenId, instrumentId, asset для обоих рынков
   * 2. Подписка обоих токенов на WS
   * 3. Регистрация обоих в marketCatalog (для BookUpdateHandler → BOOK_UPDATED → MarketDataStore)
   * 4. Регистрация обоих в exchangeClient (для маршрутизации ордеров)
   * 5. Создание CrossMarketArbStrategy на hard рынке
   * 6. Установка easy leg callback: PlaceOrderUseCase.execute() для BUY easy_Up
   * 7. Регистрация стратегии в SchedulerS
   */
  async function openArbPair(
    easyCandidate: import('@polymarket/ports').DiscoveredMarket,
    hardCandidate: import('@polymarket/ports').DiscoveredMarket,
  ): Promise<boolean> {
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const arbConfig = config.strategyParams as CrossMarketArbConfig;

    // ── Деривация токенов ────────────────────────────────────────────────
    // Easy Up (outcomeIndex=0) и Hard Up (outcomeIndex=0) — для чтения orderbook.
    // Hard Down (outcomeIndex=1) — для размещения BUY hard_Down ордера.
    const easyUpTokenStr = easyCandidate.allTokenIds?.[mc.outcomeIndex] ?? String(easyCandidate.instrumentId);
    const hardUpTokenStr = hardCandidate.allTokenIds?.[mc.outcomeIndex] ?? String(hardCandidate.instrumentId);
    const hardDownIndex = mc.outcomeIndex === 0 ? 1 : 0;
    const hardDownTokenStr = hardCandidate.allTokenIds?.[hardDownIndex];

    if (!hardDownTokenStr) {
      logger.error('Cannot find hard Down token (allTokenIds missing)', {
        hardMarketId: String(hardCandidate.marketId),
        allTokenIds: hardCandidate.allTokenIds,
      });
      return false;
    }

    const easyIId = asInstrumentId(easyUpTokenStr);
    const hardUpIId = asInstrumentId(hardUpTokenStr);
    const hardDownIId = asInstrumentId(hardDownTokenStr);
    const easyAst = asPolymarketCtfToken(easyUpTokenStr);
    const hardUpAst = asPolymarketCtfToken(hardUpTokenStr);
    const hardDownAst = asPolymarketCtfToken(hardDownTokenStr);

    if (!easyIId || !hardUpIId || !hardDownIId || !easyAst || !hardUpAst || !hardDownAst) {
      logger.error('Cannot derive instrumentIds for arb pair', {
        easyToken: easyUpTokenStr, hardUpToken: hardUpTokenStr, hardDownToken: hardDownTokenStr,
      });
      return false;
    }

    // Проверяем доступный капитал
    const portfolio = portfolioStore.get(accountId!);
    if (portfolio) {
      const available = portfolio.balance.available().value();
      if (available.lt(minCapitalPerMarket)) {
        logger.warn('Insufficient capital for arb pair', {
          available: available.toFixed(2), minCapitalPerMarket,
        });
        return false;
      }
    }

    // ── Метаданные и strike prices ─────────────────────────────────────
    const easyCryptoMeta = parseCryptoMeta(easyCandidate.rawMarket);
    const hardCryptoMeta = parseCryptoMeta(hardCandidate.rawMarket);

    const easyStrike = easyCryptoMeta?.priceToBeat ?? null;
    const hardStrike = hardCryptoMeta?.priceToBeat ?? null;

    // Пропускаем пару если рынок уже начался а strike неизвестен —
    // мы не были подписаны на RTDS до старта и пропустили opening price.
    // Следующий scan подхватит пару с будущим startTime.
    const nowMs = Date.now();
    if (easyStrike === null && easyCryptoMeta?.eventStartTimeMs && easyCryptoMeta.eventStartTimeMs <= nowMs) {
      logger.debug('Easy market already started without strike, skipping pair', {
        easyQuestion: easyCandidate.question,
        startedAt: new Date(easyCryptoMeta.eventStartTimeMs).toISOString(),
      });
      return false;
    }
    if (hardStrike === null && hardCryptoMeta?.eventStartTimeMs && hardCryptoMeta.eventStartTimeMs <= nowMs) {
      logger.debug('Hard market already started without strike, skipping pair', {
        hardQuestion: hardCandidate.question,
        startedAt: new Date(hardCryptoMeta.eventStartTimeMs).toISOString(),
      });
      return false;
    }

    // easyDown токен нужен если после strike-swap 15m окажется hard-рынком.
    const easyDownIndex = mc.outcomeIndex === 0 ? 1 : 0;
    const easyDownTokenStr = easyCandidate.allTokenIds?.[easyDownIndex];
    const easyDownIId = easyDownTokenStr ? asInstrumentId(easyDownTokenStr) : undefined;
    const easyDownAst = easyDownTokenStr ? asPolymarketCtfToken(easyDownTokenStr) : undefined;

    // Регистрируем easyDown в exchangeClient (нужен для hardDown ноги после swap).
    if (easyDownIId && easyDownAst) {
      exchangeClient.registerMarket(easyDownIId, easyCandidate.marketId, accountId!, easyDownAst);
    }

    openArbRecording(easyCandidate, [easyUpTokenStr, easyDownTokenStr], easyCryptoMeta);
    openArbRecording(hardCandidate, [hardUpTokenStr, hardDownTokenStr], hardCryptoMeta);

    // ── Создание стратегии ──────────────────────────────────────────────
    // Стратегия зарегистрирована на hard (5m) = slot market.
    // Easy (15m) = peer market, читается из MarketDataStore.
    // slotStrike = hard (5m) strike, peerStrike = easy (15m) strike.
    // После получения обоих strikes стратегия сама назначит easy/hard по strike'ам.
    const strategyId = `cross-market-arb-slot-${_slotCounter++}`;
    const fullArbConfig: CrossMarketArbConfig = {
      peerInstrumentId: easyIId,
      slotDownInstrumentId: hardDownIId,
      peerDownInstrumentId: easyDownIId,
      minSpreadAfterFees: arbConfig.minSpreadAfterFees ?? 0.005,
      maxPositionUnits: arbConfig.maxPositionUnits ?? 50,
      maxDepth: arbConfig.maxDepth ?? 1,
      slotStrike: hardStrike,   // hard (5m) = slot market
      peerStrike: easyStrike,   // easy (15m) = peer market
      bookStalenessMs: arbConfig.bookStalenessMs ?? 1500,
      auditMode: arbConfig.auditMode ?? false,
      executionOrderType: arbConfig.executionOrderType ?? 'FAK',
      executionReconcileDelayMs: arbConfig.executionReconcileDelayMs ?? 750,
      executionRepairDelayMs: arbConfig.executionRepairDelayMs ?? 750,
      // feeModel по умолчанию = FEE_MODEL_CURRENT (в DivergenceDetector)
    };

    const arbStrategy = new CrossMarketArbStrategy(
      fullArbConfig,
      marketDataStore,  // ITopOfBookReader — MarketDataStore реализует getTopOfBook()
      strategyId,
      logger,
    );

    /**
     * Атомарный callback: размещает обе ноги арбитража.
     *
     * @remarks
     * Обе ноги размещаются параллельно. Если хотя бы одна отклонена:
     * - Успешная нога отменяется через CancelOrderUseCase
     * - Возвращается false → стратегия сбрасывает окно
     *
     * @returns true если обе ноги успешно размещены
     */
    arbStrategy.setTradeCallback(async (plan): Promise<ArbTradeExecutionReport> => {
      const currentPortfolio = portfolioStore.get(accountId!);
      const plannedSize = plan.size.value().toNumber();
      const emptyReport = (repairState: ArbTradeExecutionReport['repairState']): ArbTradeExecutionReport => ({
        accepted: false,
        repairState,
        plannedSize,
        easyFilledSize: 0,
        hardFilledSize: 0,
        balancedSize: 0,
        unhedgedSize: 0,
      });
      if (!currentPortfolio) return emptyReport('REJECTED');

      const easyOrderId = asOrderId(`arb-easy-${_arbOrderCounter++}-${Date.now()}`);
      const hardOrderId = asOrderId(`arb-hard-${_arbOrderCounter++}-${Date.now()}`);
      if (!easyOrderId || !hardOrderId) return emptyReport('REJECTED');

      const resolveLeg = (instrumentId: InstrumentId): { asset: ReturnType<typeof asPolymarketCtfToken>; instrumentId: InstrumentId } | undefined => {
        const id = String(instrumentId);
        if (id === String(easyIId)) return { asset: easyAst, instrumentId: easyIId };
        if (easyDownIId && easyDownAst && id === String(easyDownIId)) return { asset: easyDownAst, instrumentId: easyDownIId };
        if (id === String(hardUpIId)) return { asset: hardUpAst, instrumentId: hardUpIId };
        if (id === String(hardDownIId)) return { asset: hardDownAst, instrumentId: hardDownIId };
        return undefined;
      };

      const easyLeg = resolveLeg(plan.easyInstrumentId);
      const hardLeg = resolveLeg(plan.hardInstrumentId);
      const easyLegAst = easyLeg?.asset;
      const easyLegIId = easyLeg?.instrumentId;
      const hardLegAst = hardLeg?.asset;
      const hardLegIId = hardLeg?.instrumentId;

      if (!easyLegAst || !easyLegIId || !hardLegAst || !hardLegIId) {
        logger.error('Missing token IDs for arb plan', {
          direction: plan.direction,
          easyInstrumentId: String(plan.easyInstrumentId),
          hardInstrumentId: String(plan.hardInstrumentId),
        });
        return emptyReport('REJECTED');
      }

      const sizeNum = plannedSize;
      const requiredCash = sizeNum * (plan.estimatedCostPerUnit + plan.estimatedFeePerUnit);
      const availableCash = currentPortfolio.balance.available().value().toNumber();
      if (availableCash < requiredCash) {
        logger.warn('Insufficient cash for arb two-leg buy', {
          availableCash: availableCash.toFixed(2),
          requiredCash: requiredCash.toFixed(2),
          easyPrice: plan.easyPrice.value().toFixed(4),
          hardPrice: plan.hardPrice.value().toFixed(4),
          size: plan.size.value().toFixed(0),
          estimatedFeePerUnit: plan.estimatedFeePerUnit.toFixed(4),
        });
        return emptyReport('REJECTED');
      }

      const orderType = arbConfig.executionOrderType ?? 'FAK';
      const reconcileDelayMs = arbConfig.executionReconcileDelayMs ?? 750;
      const repairDelayMs = arbConfig.executionRepairDelayMs ?? 750;
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const qtyOf = (instrumentId: InstrumentId): number =>
        portfolioStore.get(accountId!)
          ?.getPosition(instrumentId)
          ?.quantity.value().toNumber() ?? 0;
      const beforeEasyQty = qtyOf(easyLegIId);
      const beforeHardQty = qtyOf(hardLegIId);
      const cancelIfPlaced = async (orderId: ReturnType<typeof asOrderId> | undefined, reason: string): Promise<void> => {
        if (!orderId) return;
        await orderUseCases.cancelOrderUseCase.execute({ orderId, accountId: accountId!, reason });
      };
      const snapshotReport = (repairState: ArbTradeExecutionReport['repairState']): ArbTradeExecutionReport => {
        const easyFilledSize = Math.max(0, qtyOf(easyLegIId) - beforeEasyQty);
        const hardFilledSize = Math.max(0, qtyOf(hardLegIId) - beforeHardQty);
        const balancedSize = Math.min(easyFilledSize, hardFilledSize);
        const unhedgedSize = Math.abs(easyFilledSize - hardFilledSize);
        const actualNotional = easyFilledSize * plan.easyPrice.value().toNumber()
          + hardFilledSize * plan.hardPrice.value().toNumber();
        const actualFees = balancedSize * plan.estimatedFeePerUnit;
        const conservativeSettlementValue = balancedSize;
        return {
          accepted: balancedSize > 0 && unhedgedSize < 0.000001,
          repairState,
          plannedSize,
          easyFilledSize,
          hardFilledSize,
          balancedSize,
          unhedgedSize,
          actualNotional,
          actualFees,
          conservativeSettlementValue,
          conservativePnl: conservativeSettlementValue - actualNotional - actualFees,
        };
      };

      // Размещаем обе ноги параллельно
      const [easyResult, hardResult] = await Promise.all([
        orderUseCases.placeOrderUseCase.execute({
          orderId: easyOrderId,
          accountId: accountId!,
          asset: easyLegAst,
          instrumentId: easyLegIId,
          side: 'BUY',
          price: plan.easyPrice,
          size: plan.size,
          orderType,
          strategyId,
          portfolio: currentPortfolio,
          openOrdersCount: 0,
        }),
        orderUseCases.placeOrderUseCase.execute({
          orderId: hardOrderId,
          accountId: accountId!,
          asset: hardLegAst,
          instrumentId: hardLegIId,
          side: 'BUY',
          price: plan.hardPrice,
          size: plan.size,
          orderType,
          strategyId,
          portfolio: currentPortfolio,
          openOrdersCount: 0,
        }),
      ]);

      const easyOk = easyResult.ok;
      const hardOk = hardResult.ok;

      if (easyOk && hardOk) {
        logger.info('Both arb legs placed', {
          easyOrderId: String(easyResult.value),
          hardOrderId: String(hardResult.value),
          easyPrice: plan.easyPrice.value().toFixed(4),
          hardPrice: plan.hardPrice.value().toFixed(4),
          size: plan.size.value().toFixed(0),
          direction: plan.direction,
          estimatedCostPerUnit: plan.estimatedCostPerUnit.toFixed(4),
          estimatedFeePerUnit: plan.estimatedFeePerUnit.toFixed(4),
          estimatedPnlPerUnit: plan.estimatedPnlPerUnit.toFixed(4),
          easyBookAgeMs: plan.easyBookAgeMs,
          hardBookAgeMs: plan.hardBookAgeMs,
          auditDepthLevels: plan.auditDepthLevels,
        });
        await sleep(reconcileDelayMs);
        await Promise.all([
          cancelIfPlaced(easyResult.value, 'arb reconciliation'),
          cancelIfPlaced(hardResult.value, 'arb reconciliation'),
        ]);

        let report = snapshotReport('BALANCED');
        if (report.balancedSize <= 0 && report.unhedgedSize <= 0) return { ...report, accepted: false, repairState: 'NO_FILL' };
        if (report.unhedgedSize <= 0.000001) return report;

        logger.warn('Arb execution unbalanced, attempting rebalance', {
          easyFilledSize: report.easyFilledSize.toFixed(4),
          hardFilledSize: report.hardFilledSize.toFixed(4),
          unhedgedSize: report.unhedgedSize.toFixed(4),
        });

        const missingEasy = report.easyFilledSize < report.hardFilledSize;
        const rebalanceOrderId = asOrderId(`arb-rebalance-${_arbOrderCounter++}-${Date.now()}`);
        if (rebalanceOrderId) {
          const rebalanceLegAst = missingEasy ? easyLegAst : hardLegAst;
          const rebalanceLegIId = missingEasy ? easyLegIId : hardLegIId;
          const rebalancePrice = missingEasy ? plan.easyPrice : plan.hardPrice;
          const repairPortfolio = portfolioStore.get(accountId!);
          if (repairPortfolio) {
            await orderUseCases.placeOrderUseCase.execute({
              orderId: rebalanceOrderId,
              accountId: accountId!,
              asset: rebalanceLegAst,
              instrumentId: rebalanceLegIId,
              side: 'BUY',
              price: rebalancePrice,
              size: Quantity.of(new Decimal(report.unhedgedSize)),
              orderType,
              strategyId,
              portfolio: repairPortfolio,
              openOrdersCount: 0,
            });
            await sleep(repairDelayMs);
            await cancelIfPlaced(rebalanceOrderId, 'arb rebalance reconciliation');
            report = snapshotReport('REBALANCED');
            if (report.unhedgedSize <= 0.000001) return { ...report, accepted: report.balancedSize > 0 };
          }
        }

        logger.warn('Arb rebalance incomplete, unwinding surplus leg', {
          easyFilledSize: report.easyFilledSize.toFixed(4),
          hardFilledSize: report.hardFilledSize.toFixed(4),
          unhedgedSize: report.unhedgedSize.toFixed(4),
        });

        const surplusEasy = report.easyFilledSize > report.hardFilledSize;
        const unwindOrderId = asOrderId(`arb-unwind-${_arbOrderCounter++}-${Date.now()}`);
        if (unwindOrderId && report.unhedgedSize > 0) {
          const unwindLegAst = surplusEasy ? easyLegAst : hardLegAst;
          const unwindLegIId = surplusEasy ? easyLegIId : hardLegIId;
          const unwindPortfolio = portfolioStore.get(accountId!);
          if (unwindPortfolio) {
            await orderUseCases.placeOrderUseCase.execute({
              orderId: unwindOrderId,
              accountId: accountId!,
              asset: unwindLegAst,
              instrumentId: unwindLegIId,
              side: 'SELL',
              price: Price.of(new Decimal('0.01')),
              size: Quantity.of(new Decimal(report.unhedgedSize)),
              orderType,
              strategyId,
              portfolio: unwindPortfolio,
              openOrdersCount: 0,
            });
            await sleep(repairDelayMs);
            await cancelIfPlaced(unwindOrderId, 'arb unwind reconciliation');
            report = snapshotReport('UNWOUND');
            return { ...report, accepted: report.balancedSize > 0 && report.unhedgedSize <= 0.000001 };
          }
        }

        return { ...report, repairState: 'FAILED_REPAIR', accepted: report.balancedSize > 0 && report.unhedgedSize <= 0.000001 };
      }

      // Частичный успех → отменяем успешную ногу
      const easyErr = !easyResult.ok ? String(easyResult.error) : undefined;
      const hardErr = !hardResult.ok ? String(hardResult.error) : undefined;

      if (easyOk && !hardOk) {
        logger.warn('Hard leg rejected, cancelling easy leg', {
          easyOrderId: String(easyResult.value),
          hardError: hardErr,
        });
        await orderUseCases.cancelOrderUseCase.execute({
          orderId: easyResult.value,
          accountId: accountId!,
          reason: 'arb partial placement rejected',
        });
      } else if (!easyOk && hardOk) {
        logger.warn('Easy leg rejected, cancelling hard leg', {
          hardOrderId: String(hardResult.value),
          easyError: easyErr,
        });
        await orderUseCases.cancelOrderUseCase.execute({
          orderId: hardResult.value,
          accountId: accountId!,
          reason: 'arb partial placement rejected',
        });
      } else {
        logger.warn('Both arb legs rejected', {
          easyError: easyErr,
          hardError: hardErr,
        });
      }

      return emptyReport('REJECTED');
    });

    // ── Регистрация в инфраструктуре ──────────────────────────────────
    // Регистрируем все 3 токена в exchangeClient для маршрутизации ордеров:
    // easy_Up (BUY), hard_Up (orderbook reading), hard_Down (BUY)
    exchangeClient.registerMarket(easyIId, easyCandidate.marketId, accountId!, easyAst);
    exchangeClient.registerMarket(hardUpIId, hardCandidate.marketId, accountId!, hardUpAst);
    exchangeClient.registerMarket(hardDownIId, hardCandidate.marketId, accountId!, hardDownAst);

    const hardExpiresMs = hardCandidate.expiresAt.toNumber();

    // Регистрируем easy в marketCatalog (для BookUpdateHandler → MarketDataStore)
    const easyExpiresAtResult = TimestampService.create(easyCandidate.expiresAt.toNumber());
    if (easyExpiresAtResult.ok) {
      marketCatalog.register({
        instrumentId: easyIId,
        marketId: easyCandidate.marketId,
        tickSize: Price.of(new Decimal('0.001')),
        minOrderSize: Quantity.of(new Decimal('1')),
        minOrderValue: Quantity.of(new Decimal('1')),
        active: true,
        expiresAt: easyExpiresAtResult.value,
      });
    }

    // Подписка всех токенов на WS: easy_Up, hard_Up (orderbook), hard_Down, easy_Down (для fills)
    await wsAdapter.subscribeToToken(easyUpTokenStr);
    await wsAdapter.subscribeToToken(hardUpTokenStr);
    if (easyDownTokenStr) await wsAdapter.subscribeToToken(easyDownTokenStr);
    await wsAdapter.subscribeToToken(hardDownTokenStr);

    // Подписка RTDS для крипто-цен (hard рынок — основной)
    if (hardCryptoMeta) {
      if (hardCryptoMeta.priceToBeat !== undefined) {
        cryptoPriceStore.setTargetPrice(hardCryptoMeta.rtdsFilter, hardCryptoMeta.priceToBeat);
      }
      for (const sub of hardCryptoMeta.rtdsSubscriptions) {
        rtdsClient.subscribe(sub.topic, sub.filter);
      }
    }
    if (easyCryptoMeta) {
      for (const sub of easyCryptoMeta.rtdsSubscriptions) {
        rtdsClient.subscribe(sub.topic, sub.filter);
      }
    }

    // Регистрируем hard_Down в marketCatalog (для BookUpdateHandler + fill routing)
    const hardDownExpiresAtResult = TimestampService.create(hardExpiresMs);
    if (hardDownExpiresAtResult.ok) {
      marketCatalog.register({
        instrumentId: hardDownIId,
        marketId: hardCandidate.marketId,
        tickSize: Price.of(new Decimal('0.001')),
        minOrderSize: Quantity.of(new Decimal('1')),
        minOrderValue: Quantity.of(new Decimal('1')),
        active: true,
        expiresAt: hardDownExpiresAtResult.value,
      });
    }

    // Регистрируем easy_Down в marketCatalog (для BookUpdateHandler — нужен при DOWN направлении)
    if (easyDownIId) {
      const easyDownExpiresAtResult = TimestampService.create(easyCandidate.expiresAt.toNumber());
      if (easyDownExpiresAtResult.ok) {
        marketCatalog.register({
          instrumentId: easyDownIId,
          marketId: easyCandidate.marketId,
          tickSize: Price.of(new Decimal('0.001')),
          minOrderSize: Quantity.of(new Decimal('1')),
          minOrderValue: Quantity.of(new Decimal('1')),
          active: true,
          expiresAt: easyDownExpiresAtResult.value,
        });
      }
    }

    // ── Hard Up слот → activeMarkets (со стратегией, читает hard_Up orderbook) ───
    // additionalInstrumentIds: easy_Up — чтобы стратегия тикала при обновлении easy book тоже.
    // Без этого стратегия тикает только при обновлении hard book и может пропустить
    // расхождение, возникшее из-за движения easy книги.
    const hardSlot: MarketSlot = {
      instrumentId: hardUpIId,
      marketId: hardCandidate.marketId,
      asset: hardUpAst,
      tokenIdStr: hardUpTokenStr,
      expiresAtMs: hardExpiresMs,
      candidate: hardCandidate,
      strategy: arbStrategy,
      cryptoMeta: hardCryptoMeta,
      additionalInstrumentIds: [easyIId],
      outcomeIndex: mc.outcomeIndex,
      fillHistory: [],
      partialAccum: new Map(),
        directPartialAccum: new Map(),
      openedAt: Date.now(),
    };

    activeMarkets.set(hardUpTokenStr, hardSlot);
    const regOk = await rotation.registerMarketAndStrategy(hardSlot);
    if (!regOk) {
      activeMarkets.delete(hardUpTokenStr);
      return false;
    }

    // ── Easy слот → пассивный (без стратегии) ────────────────────────
    const pairId = `arb-${easyUpTokenStr}-${hardUpTokenStr}`;
    const easyStartMs = easyCryptoMeta?.eventStartTimeMs ?? 0;
    const hardStartMs = hardCryptoMeta?.eventStartTimeMs ?? 0;

    const arbPair: ArbPairSlot = {
      pairId,
      easySlot: {
        instrumentId: easyIId,
        marketId: easyCandidate.marketId,
        asset: easyAst,
        tokenIdStr: easyUpTokenStr,
        candidate: easyCandidate,
        cryptoMeta: easyCryptoMeta,
      },
      hardTokenIdStr: hardUpTokenStr,
      hardDownTokenIdStr: hardDownTokenStr,
      easyDownTokenIdStr: easyDownTokenStr,
      expiresAtMs: hardExpiresMs,
      strategy: arbStrategy,
      easyStartMs,
      hardStartMs,
      easyStrikeLocked: easyStrike !== null,
      hardStrikeLocked: hardStrike !== null,
    };

    activeArbPairs.set(pairId, arbPair);
    hardTokenToArbPair.set(hardUpTokenStr, pairId);

    logger.info('Arb pair opened', {
      pairId,
      easyQuestion: easyCandidate.question,
      hardQuestion: hardCandidate.question,
      easyUpToken: easyUpTokenStr.slice(0, 12) + '...',
      hardUpToken: hardUpTokenStr.slice(0, 12) + '...',
      hardDownToken: hardDownTokenStr.slice(0, 12) + '...',
      easyStrike: easyStrike?.toFixed(2) ?? '-',
      hardStrike: hardStrike?.toFixed(2) ?? '-',
      expiresAt: new Date(hardExpiresMs).toISOString(),
      easyStartMs,
      hardStartMs,
      easyStartTime: easyStartMs > 0 ? new Date(easyStartMs).toISOString() : 'N/A',
      hardStartTime: hardStartMs > 0 ? new Date(hardStartMs).toISOString() : 'N/A',
      easyCryptoMetaPresent: !!easyCryptoMeta,
      hardCryptoMetaPresent: !!hardCryptoMeta,
      easyRtdsFilter: easyCryptoMeta?.rtdsFilter ?? 'N/A',
      hardRtdsFilter: hardCryptoMeta?.rtdsFilter ?? 'N/A',
    });

    return true;
  }

  /**
   * Закрывает арбитражную пару: easy slot + hard slot.
   *
   * @param pairId - ID пары
   * @param reason - Причина закрытия
   */
  async function closeArbPair(pairId: string, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const pair = activeArbPairs.get(pairId);
    if (!pair) return;

    logger.info('Closing arb pair', { pairId, reason });

    // Собираем метрики ДО закрытия (closeMarket удалит hard слот)
    const metrics = pair.strategy.getMetrics();
    const hardSlot = activeMarkets.get(pair.hardTokenIdStr);
    const easyQuestion = pair.easySlot.candidate?.question ?? pairId;
    const hardQuestion = hardSlot?.candidate?.question ?? pair.hardTokenIdStr;
    const openedAt = hardSlot?.openedAt ?? Date.now();
    const durationMs = Date.now() - openedAt;
    const durationSec = Math.max(0, Math.round(durationMs / 1000));
    const durMin = Math.floor(durationSec / 60);
    const durSec = durationSec % 60;

    // Закрываем hard слот (через стандартный closeMarket — НЕ печатает отдельный summary)
    // Сначала unregister стратегию и WS отписку без summary
    if (hardSlot) {
      await engine.scheduler.unregister(hardSlot.strategy.id);
      await wsAdapter.unsubscribeFromToken(pair.hardTokenIdStr);
      marketCatalog.remove(hardSlot.instrumentId);
      if (hardSlot.cryptoMeta) {
        // Не отписываемся от RTDS если warming/promoted пара использует тот же topic
        const warmingUsesRtds = warmingArbPair?.hardCryptoMeta?.rtdsTopic === hardSlot.cryptoMeta.rtdsTopic;
        if (!warmingUsesRtds) {
          rtdsClient.unsubscribe(hardSlot.cryptoMeta.rtdsTopic, hardSlot.cryptoMeta.rtdsFilter);
        }
        pendingChainlinkStrike.delete(hardSlot.cryptoMeta.rtdsFilter);
      }
      for (const [orderId, slotKey] of orderToSlot) {
        if (slotKey === pair.hardTokenIdStr) orderToSlot.delete(orderId);
      }
      if (reason === 'EXPIRED') closedMarkets.add(String(hardSlot.marketId));
      activeMarkets.delete(pair.hardTokenIdStr);
    }

    // Закрываем easy слот + hardDown + easyDown: WS отписка + marketCatalog
    await wsAdapter.unsubscribeFromToken(pair.easySlot.tokenIdStr);
    await wsAdapter.unsubscribeFromToken(pair.hardDownTokenIdStr);
    if (pair.easyDownTokenIdStr) await wsAdapter.unsubscribeFromToken(pair.easyDownTokenIdStr);
    marketCatalog.remove(pair.easySlot.instrumentId);
    const hardDownIIdForRemoval = asInstrumentId(pair.hardDownTokenIdStr);
    if (hardDownIIdForRemoval) marketCatalog.remove(hardDownIIdForRemoval);
    if (pair.easyDownTokenIdStr) {
      const easyDownIIdForRemoval = asInstrumentId(pair.easyDownTokenIdStr);
      if (easyDownIIdForRemoval) marketCatalog.remove(easyDownIIdForRemoval);
    }

    if (pair.easySlot.cryptoMeta) {
      const warmingUsesEasyRtds = warmingArbPair?.easyCryptoMeta?.rtdsTopic === pair.easySlot.cryptoMeta.rtdsTopic;
      if (!warmingUsesEasyRtds) {
        rtdsClient.unsubscribe(pair.easySlot.cryptoMeta.rtdsTopic, pair.easySlot.cryptoMeta.rtdsFilter);
      }
    }

    // ── Settlement: закрываем все арб-позиции и зачисляем settlement ────────
    // Арбитраж покупает два токена. Каждый resolves по своему рынку:
    // winning token = $1, losing = $0. В сумме гарантированно ≥$1 (≤$2 при windfall).
    let totalSettlementCash = new Decimal(0);
    let settledLegs = 0;
    if (reason === 'EXPIRED') {
      const portfolio = portfolioStore.get(accountId!);
      if (portfolio) {
        // Определяем исход каждого рынка по BTC цене vs per-market strike.
        // CryptoPriceStore.getResolution() хранит ОДИН targetPrice per asset —
        // не подходит для арбитража (два рынка, разные strikes, один актив).
        // Берём strikes из стратегии и текущую Chainlink цену напрямую.
        const arbStrikes = pair.strategy.getStrikes();
        const cryptoSymbol = pair.easySlot.cryptoMeta?.rtdsFilter ?? hardSlot?.cryptoMeta?.rtdsFilter;
        const btcSnap = cryptoSymbol ? cryptoPriceStore.get(cryptoSymbol) : undefined;
        const btcPrice = btcSnap?.chainlink?.price ?? btcSnap?.currentPrice;

        let easyResolution: 'UP' | 'DOWN' | undefined;
        let hardResolution: 'UP' | 'DOWN' | undefined;
        if (arbStrikes && btcPrice !== undefined) {
          easyResolution = btcPrice >= arbStrikes.easyStrike ? 'UP' : 'DOWN';
          hardResolution = btcPrice >= arbStrikes.hardStrike ? 'UP' : 'DOWN';
          logger.info('Arb settlement resolution', {
            btcPrice,
            easyStrike: arbStrikes.easyStrike,
            hardStrike: arbStrikes.hardStrike,
            easyResolution,
            hardResolution,
          });
        } else {
          logger.warn('Cannot determine arb resolution — missing strikes or BTC price', {
            hasStrikes: !!arbStrikes,
            hasBtcPrice: btcPrice !== undefined,
            cryptoSymbol,
          });
        }

        // Список всех арб-токенов и их settlement:
        // token resolves to $1 if market resolution matches token direction
        const arbTokens: Array<{ instrumentId: InstrumentId; tokenIdStr: string; market: 'easy' | 'hard'; isUp: boolean; resolution: string | undefined }> = [
          { instrumentId: pair.easySlot.instrumentId, tokenIdStr: pair.easySlot.tokenIdStr, market: 'easy', isUp: true, resolution: easyResolution },
        ];
        if (pair.easyDownTokenIdStr) {
          const eDnId = asInstrumentId(pair.easyDownTokenIdStr);
          if (eDnId) arbTokens.push({ instrumentId: eDnId, tokenIdStr: pair.easyDownTokenIdStr, market: 'easy', isUp: false, resolution: easyResolution });
        }
        const hUpId = hardSlot?.instrumentId;
        if (hUpId) arbTokens.push({ instrumentId: hUpId, tokenIdStr: pair.hardTokenIdStr, market: 'hard', isUp: true, resolution: hardResolution });
        const hDnId = asInstrumentId(pair.hardDownTokenIdStr);
        if (hDnId) arbTokens.push({ instrumentId: hDnId, tokenIdStr: pair.hardDownTokenIdStr, market: 'hard', isUp: false, resolution: hardResolution });

        let updated = portfolio;
        for (const tok of arbTokens) {
          const position = updated.getPosition(tok.instrumentId);
          if (!position || position.isClosed()) continue;

          const qty = position.quantity.value();
          const isWinning = tok.resolution
            ? (tok.isUp && tok.resolution === 'UP') || (!tok.isUp && tok.resolution === 'DOWN')
            : false;
          const settlementPrice = isWinning ? new Decimal(1) : new Decimal(0);
          const credit = qty.times(settlementPrice);

          logger.info('Arb leg settlement', {
            pairId: pairId.slice(0, 30) + '...',
            tokenIdStr: tok.tokenIdStr.slice(0, 12) + '...',
            market: tok.market,
            isUp: tok.isUp,
            resolution: tok.resolution ?? 'unknown',
            isWinning,
            qty: qty.toFixed(2),
            credit: credit.toFixed(4),
          });

          // Закрываем позицию
          const closedPosition = new SimplePosition({
            instrumentId: tok.instrumentId,
            quantity: new Decimal(0),
            averageEntryPrice: position.averageEntryPrice.value(),
            side: 'LONG' as const,
          });
          updated = updated.upsertPosition(closedPosition);

          if (credit.gt(0)) {
            const creditResult = updated.applyCredit(Money.of(credit, 'USDC'));
            if (creditResult.ok) updated = creditResult.value;
          }
          totalSettlementCash = totalSettlementCash.plus(credit);
          settledLegs++;
        }

        // Сохраняем portfolio
        const ver = portfolioStore.getVersion(accountId!);
        const saveRes = portfolioStore.save(updated, ver);
        if (!saveRes.ok) {
          logger.error('Arb settlement portfolio save failed', { expected: ver });
        }
      }
    }

    // Арб-парная сводка
    const bestObserved = metrics['bestObserved'] as Record<string, unknown> | null | undefined;
    const auditEventCounts = metrics['auditEventCounts'] as Record<string, unknown> | undefined;
    const assignment = metrics['assignment'] ?? 'unknown';
    const strikeEasyMarket = assignment === 'SLOT_IS_EASY' ? hardQuestion : easyQuestion;
    const strikeHardMarket = assignment === 'SLOT_IS_EASY' ? easyQuestion : hardQuestion;
    const formatMetricNumber = (value: unknown, digits: number): string | null =>
      typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : null;
    logger.warn('=== Arb pair summary ===', {
      pairId,
      longWindowMarket: easyQuestion,
      shortWindowMarket: hardQuestion,
      strikeEasyMarket,
      strikeHardMarket,
      duration: `${durMin}m${durSec}s`,
      assignment,
      ticks: metrics['tickCount'] ?? 0,
      divergences: metrics['divergenceCount'] ?? 0,
      trades: metrics['tradeCount'] ?? 0,
      acceptedSettlementFaceValue: formatMetricNumber(metrics['acceptedSettlementFaceValue'], 4),
      acceptedPlannedCost: formatMetricNumber(metrics['acceptedPlannedCost'], 4),
      acceptedPlannedFees: formatMetricNumber(metrics['acceptedPlannedFees'], 4),
      acceptedPlannedAllInCost: formatMetricNumber(metrics['acceptedPlannedAllInCost'], 4),
      actualNotional: formatMetricNumber(metrics['actualNotional'], 4),
      actualFees: formatMetricNumber(metrics['actualFees'], 4),
      actualConservativePnl: formatMetricNumber(metrics['actualConservativePnl'], 4),
      unhedgedExecutionCount: metrics['unhedgedExecutionCount'] ?? 0,
      failedRepairCount: metrics['failedRepairCount'] ?? 0,
      repairStateCounts: metrics['repairStateCounts'] ?? {},
      freshEvaluations: metrics['freshEvaluations'] ?? 0,
      grossCrossSamples: metrics['grossCrossSamples'] ?? 0,
      netSignalSamples: metrics['netSignalSamples'] ?? 0,
      skipMissingBook: auditEventCounts?.['SKIP_MISSING_BOOK'] ?? 0,
      skipStaleBook: auditEventCounts?.['SKIP_STALE_BOOK'] ?? 0,
      noSignal: auditEventCounts?.['NO_SIGNAL'] ?? 0,
      skipCapacity: auditEventCounts?.['SKIP_CAPACITY'] ?? 0,
      skipBalance: auditEventCounts?.['SKIP_BALANCE'] ?? 0,
      signalAccepted: auditEventCounts?.['SIGNAL_ACCEPTED'] ?? 0,
      bestObservedAt: bestObserved?.['observedAt'] ?? null,
      bestObservedPnlPerUnit: formatMetricNumber(bestObserved?.['pnlPerUnit'], 5),
      bestObservedCostPerUnit: formatMetricNumber(bestObserved?.['costPerUnit'], 5),
      bestObservedFeePerUnit: formatMetricNumber(bestObserved?.['feePerUnit'], 5),
      bestObservedSize: bestObserved?.['execSize'] ?? null,
      bestObservedExecutableCost: typeof bestObserved?.['costPerUnit'] === 'number' && typeof bestObserved?.['execSize'] === 'number'
        ? ((bestObserved['costPerUnit'] as number) * (bestObserved['execSize'] as number)).toFixed(4)
        : null,
      bestObservedPotentialPnl: typeof bestObserved?.['pnlPerUnit'] === 'number' && typeof bestObserved?.['execSize'] === 'number'
        ? ((bestObserved['pnlPerUnit'] as number) * (bestObserved['execSize'] as number)).toFixed(4)
        : null,
      bestObservedEasyAgeMs: bestObserved?.['easyBookAgeMs'] ?? null,
      bestObservedHardAgeMs: bestObserved?.['hardBookAgeMs'] ?? null,
      estimatedPnl: typeof metrics['totalPnlEstimate'] === 'object'
        ? (metrics['totalPnlEstimate'] as { toFixed: (n: number) => string }).toFixed(4)
        : String(metrics['totalPnlEstimate'] ?? 0),
      settlementCash: totalSettlementCash.toFixed(4),
      settledLegs,
      longWindowStrike: pair.easyStrikeLocked ? 'set' : 'pending',
      shortWindowStrike: pair.hardStrikeLocked ? 'set' : 'pending',
      reason,
    });

    if (recording) {
      if (hardSlot) await recording.closeMarket(hardSlot.marketId, reason);
      await recording.closeMarket(pair.easySlot.marketId, reason);
    }

    hardTokenToArbPair.delete(pair.hardTokenIdStr);
    activeArbPairs.delete(pairId);
  }

  function openArbRecording(
    candidate: DiscoveredMarket,
    tokenIds: readonly (string | undefined)[],
    cryptoMeta: ReturnType<typeof parseCryptoMeta>,
  ): void {
    if (!recording) return;

    const expiresAtResult = TimestampService.create(candidate.expiresAt.toNumber());
    if (!expiresAtResult.ok) return;

    const startsAtResult = cryptoMeta?.eventStartTimeMs
      ? TimestampService.create(cryptoMeta.eventStartTimeMs)
      : undefined;

    recording.openMarket(candidate, {
      marketId: candidate.marketId,
      question: candidate.question ?? String(candidate.marketId),
      tokenIds: tokenIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
      startsAt: startsAtResult?.ok ? startsAtResult.value : undefined,
      expiresAt: expiresAtResult.value,
      rawMarket: candidate.rawMarket,
    }, 'paper');
  }

  /**
   * Очищает ресурсы warming-пары: WS-отписка, marketCatalog, RTDS.
   *
   * @param reason - Причина очистки (для логирования)
   *
   * @remarks
   * Вызывается при shutdown, при протухании warming пары,
   * или при замене на новую warming пару.
   */
  function cleanupWarmingPair(reason: string): void {
    if (!warmingArbPair) return;
    const w = warmingArbPair;

    logger.debug('Cleaning up warming pair', { pairId: w.pairId, reason });

    // WS отписка всех токенов
    void wsAdapter.unsubscribeFromToken(w.easyUpTokenStr);
    void wsAdapter.unsubscribeFromToken(w.hardUpTokenStr);
    void wsAdapter.unsubscribeFromToken(w.hardDownTokenStr);
    if (w.easyDownTokenStr) void wsAdapter.unsubscribeFromToken(w.easyDownTokenStr);

    // marketCatalog cleanup
    marketCatalog.remove(w.easyIId);
    marketCatalog.remove(w.hardUpIId);
    marketCatalog.remove(w.hardDownIId);
    if (w.easyDownIId) marketCatalog.remove(w.easyDownIId);

    // RTDS отписка
    if (w.hardCryptoMeta) {
      rtdsClient.unsubscribe(w.hardCryptoMeta.rtdsTopic, w.hardCryptoMeta.rtdsFilter);
      pendingChainlinkStrike.delete(w.hardCryptoMeta.rtdsFilter);
    }
    if (w.easyCryptoMeta) {
      rtdsClient.unsubscribe(w.easyCryptoMeta.rtdsTopic, w.easyCryptoMeta.rtdsFilter);
    }

    warmingArbPair = null;
  }

  /**
   * Промоутит warming пару в активную: создаёт стратегию, callback, регистрирует в scheduler.
   *
   * @returns true если пара успешно промоутилась
   *
   * @remarks
   * WS, marketCatalog, RTDS, exchangeClient уже настроены в warmNextArbPair().
   * Здесь только: стратегия + trade callback + activeMarkets + activeArbPairs.
   * Strikes из Chainlink уже могут быть назначены (warming пара получала их).
   */
  async function promoteWarmPair(): Promise<boolean> {
    if (!warmingArbPair) return false;
    const w = warmingArbPair;
    warmingArbPair = null; // забираем ownership

    const arbConfig = config.strategyParams as CrossMarketArbConfig;

    // Проверяем что пара ещё жизнеспособна
    const nowMs = Date.now();
    if (w.expiresAtMs <= nowMs + MIN_VIABLE_TRADING_MS) {
      logger.debug('Warming pair expired before promotion, discarding', { pairId: w.pairId });
      // Очистка ресурсов — вручную, т.к. warmingArbPair уже null
      void wsAdapter.unsubscribeFromToken(w.easyUpTokenStr);
      void wsAdapter.unsubscribeFromToken(w.hardUpTokenStr);
      void wsAdapter.unsubscribeFromToken(w.hardDownTokenStr);
      if (w.easyDownTokenStr) void wsAdapter.unsubscribeFromToken(w.easyDownTokenStr);
      marketCatalog.remove(w.easyIId);
      marketCatalog.remove(w.hardUpIId);
      marketCatalog.remove(w.hardDownIId);
      if (w.easyDownIId) marketCatalog.remove(w.easyDownIId);
      if (w.hardCryptoMeta) rtdsClient.unsubscribe(w.hardCryptoMeta.rtdsTopic, w.hardCryptoMeta.rtdsFilter);
      if (w.easyCryptoMeta) rtdsClient.unsubscribe(w.easyCryptoMeta.rtdsTopic, w.easyCryptoMeta.rtdsFilter);
      return false;
    }

    // Проверяем капитал
    const portfolio = portfolioStore.get(accountId!);
    if (portfolio) {
      const available = portfolio.balance.available().value();
      if (available.lt(minCapitalPerMarket)) {
        logger.warn('Insufficient capital for promoting warm pair', {
          available: available.toFixed(2), minCapitalPerMarket,
        });
        return false;
      }
    }

    // ── Создание стратегии (strikes уже получены из Chainlink во время warming) ─
    const strategyId = `cross-market-arb-slot-${_slotCounter++}`;
    const fullArbConfig: CrossMarketArbConfig = {
      peerInstrumentId: w.easyIId,
      slotDownInstrumentId: w.hardDownIId,
      peerDownInstrumentId: w.easyDownIId,
      minSpreadAfterFees: arbConfig.minSpreadAfterFees ?? 0.005,
      maxPositionUnits: arbConfig.maxPositionUnits ?? 50,
      maxDepth: arbConfig.maxDepth ?? 1,
      slotStrike: w.hardStrike,
      peerStrike: w.easyStrike,
      bookStalenessMs: arbConfig.bookStalenessMs ?? 1500,
      auditMode: arbConfig.auditMode ?? false,
      executionOrderType: arbConfig.executionOrderType ?? 'FAK',
      executionReconcileDelayMs: arbConfig.executionReconcileDelayMs ?? 750,
      executionRepairDelayMs: arbConfig.executionRepairDelayMs ?? 750,
    };

    const arbStrategy = new CrossMarketArbStrategy(
      fullArbConfig,
      marketDataStore,
      strategyId,
      logger,
    );

    // ── Trade callback (идентичен openArbPair) ──────────────────────────
    const easyDownAst = w.easyDownTokenStr ? asPolymarketCtfToken(w.easyDownTokenStr) : undefined;
    if (w.easyDownIId && easyDownAst) {
      exchangeClient.registerMarket(w.easyDownIId, w.easyCandidate.marketId, accountId!, easyDownAst);
    }

    openArbRecording(w.easyCandidate, [w.easyUpTokenStr, w.easyDownTokenStr], w.easyCryptoMeta);
    openArbRecording(w.hardCandidate, [w.hardUpTokenStr, w.hardDownTokenStr], w.hardCryptoMeta);

    arbStrategy.setTradeCallback(async (plan): Promise<ArbTradeExecutionReport> => {
      const currentPortfolio = portfolioStore.get(accountId!);
      const plannedSize = plan.size.value().toNumber();
      const emptyReport = (repairState: ArbTradeExecutionReport['repairState']): ArbTradeExecutionReport => ({
        accepted: false,
        repairState,
        plannedSize,
        easyFilledSize: 0,
        hardFilledSize: 0,
        balancedSize: 0,
        unhedgedSize: 0,
      });
      if (!currentPortfolio) return emptyReport('REJECTED');

      const easyOrderId = asOrderId(`arb-easy-${_arbOrderCounter++}-${Date.now()}`);
      const hardOrderId = asOrderId(`arb-hard-${_arbOrderCounter++}-${Date.now()}`);
      if (!easyOrderId || !hardOrderId) return emptyReport('REJECTED');

      const resolveLeg = (instrumentId: InstrumentId): { asset: ReturnType<typeof asPolymarketCtfToken>; instrumentId: InstrumentId } | undefined => {
        const id = String(instrumentId);
        if (id === String(w.easyIId)) return { asset: w.easyAst, instrumentId: w.easyIId };
        if (w.easyDownIId && easyDownAst && id === String(w.easyDownIId)) return { asset: easyDownAst, instrumentId: w.easyDownIId };
        if (id === String(w.hardUpIId)) return { asset: w.hardUpAst, instrumentId: w.hardUpIId };
        if (id === String(w.hardDownIId)) return { asset: w.hardDownAst, instrumentId: w.hardDownIId };
        return undefined;
      };

      const easyLeg = resolveLeg(plan.easyInstrumentId);
      const hardLeg = resolveLeg(plan.hardInstrumentId);
      const easyLegAst = easyLeg?.asset;
      const easyLegIId = easyLeg?.instrumentId;
      const hardLegAst = hardLeg?.asset;
      const hardLegIId = hardLeg?.instrumentId;

      if (!easyLegAst || !easyLegIId || !hardLegAst || !hardLegIId) {
        logger.error('Missing token IDs for arb plan', {
          direction: plan.direction,
          easyInstrumentId: String(plan.easyInstrumentId),
          hardInstrumentId: String(plan.hardInstrumentId),
        });
        return emptyReport('REJECTED');
      }

      const sizeNum = plannedSize;
      const requiredCash = sizeNum * (plan.estimatedCostPerUnit + plan.estimatedFeePerUnit);
      const availableCash = currentPortfolio.balance.available().value().toNumber();
      if (availableCash < requiredCash) {
        logger.warn('Insufficient cash for arb two-leg buy', {
          availableCash: availableCash.toFixed(2),
          requiredCash: requiredCash.toFixed(2),
          easyPrice: plan.easyPrice.value().toFixed(4),
          hardPrice: plan.hardPrice.value().toFixed(4),
          size: plan.size.value().toFixed(0),
          estimatedFeePerUnit: plan.estimatedFeePerUnit.toFixed(4),
        });
        return emptyReport('REJECTED');
      }

      const orderType = arbConfig.executionOrderType ?? 'FAK';
      const reconcileDelayMs = arbConfig.executionReconcileDelayMs ?? 750;
      const repairDelayMs = arbConfig.executionRepairDelayMs ?? 750;
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const qtyOf = (instrumentId: InstrumentId): number =>
        portfolioStore.get(accountId!)
          ?.getPosition(instrumentId)
          ?.quantity.value().toNumber() ?? 0;
      const beforeEasyQty = qtyOf(easyLegIId);
      const beforeHardQty = qtyOf(hardLegIId);
      const cancelIfPlaced = async (orderId: ReturnType<typeof asOrderId> | undefined, reason: string): Promise<void> => {
        if (!orderId) return;
        await orderUseCases.cancelOrderUseCase.execute({ orderId, accountId: accountId!, reason });
      };
      const snapshotReport = (repairState: ArbTradeExecutionReport['repairState']): ArbTradeExecutionReport => {
        const easyFilledSize = Math.max(0, qtyOf(easyLegIId) - beforeEasyQty);
        const hardFilledSize = Math.max(0, qtyOf(hardLegIId) - beforeHardQty);
        const balancedSize = Math.min(easyFilledSize, hardFilledSize);
        const unhedgedSize = Math.abs(easyFilledSize - hardFilledSize);
        const actualNotional = easyFilledSize * plan.easyPrice.value().toNumber()
          + hardFilledSize * plan.hardPrice.value().toNumber();
        const actualFees = balancedSize * plan.estimatedFeePerUnit;
        const conservativeSettlementValue = balancedSize;
        return {
          accepted: balancedSize > 0 && unhedgedSize < 0.000001,
          repairState,
          plannedSize,
          easyFilledSize,
          hardFilledSize,
          balancedSize,
          unhedgedSize,
          actualNotional,
          actualFees,
          conservativeSettlementValue,
          conservativePnl: conservativeSettlementValue - actualNotional - actualFees,
        };
      };

      const [easyResult, hardResult] = await Promise.all([
        orderUseCases.placeOrderUseCase.execute({
          orderId: easyOrderId,
          accountId: accountId!,
          asset: easyLegAst,
          instrumentId: easyLegIId,
          side: 'BUY',
          price: plan.easyPrice,
          size: plan.size,
          orderType,
          strategyId,
          portfolio: currentPortfolio,
          openOrdersCount: 0,
        }),
        orderUseCases.placeOrderUseCase.execute({
          orderId: hardOrderId,
          accountId: accountId!,
          asset: hardLegAst,
          instrumentId: hardLegIId,
          side: 'BUY',
          price: plan.hardPrice,
          size: plan.size,
          orderType,
          strategyId,
          portfolio: currentPortfolio,
          openOrdersCount: 0,
        }),
      ]);

      const easyOk = easyResult.ok;
      const hardOk = hardResult.ok;

      if (easyOk && hardOk) {
        logger.info('Both arb legs placed', {
          easyOrderId: String(easyResult.value),
          hardOrderId: String(hardResult.value),
          easyPrice: plan.easyPrice.value().toFixed(4),
          hardPrice: plan.hardPrice.value().toFixed(4),
          size: plan.size.value().toFixed(0),
          direction: plan.direction,
          estimatedCostPerUnit: plan.estimatedCostPerUnit.toFixed(4),
          estimatedFeePerUnit: plan.estimatedFeePerUnit.toFixed(4),
          estimatedPnlPerUnit: plan.estimatedPnlPerUnit.toFixed(4),
          easyBookAgeMs: plan.easyBookAgeMs,
          hardBookAgeMs: plan.hardBookAgeMs,
          auditDepthLevels: plan.auditDepthLevels,
        });
        await sleep(reconcileDelayMs);
        await Promise.all([
          cancelIfPlaced(easyResult.value, 'arb reconciliation'),
          cancelIfPlaced(hardResult.value, 'arb reconciliation'),
        ]);

        let report = snapshotReport('BALANCED');
        if (report.balancedSize <= 0 && report.unhedgedSize <= 0) return { ...report, accepted: false, repairState: 'NO_FILL' };
        if (report.unhedgedSize <= 0.000001) return report;

        logger.warn('Arb execution unbalanced, attempting rebalance', {
          easyFilledSize: report.easyFilledSize.toFixed(4),
          hardFilledSize: report.hardFilledSize.toFixed(4),
          unhedgedSize: report.unhedgedSize.toFixed(4),
        });

        const missingEasy = report.easyFilledSize < report.hardFilledSize;
        const rebalanceOrderId = asOrderId(`arb-rebalance-${_arbOrderCounter++}-${Date.now()}`);
        if (rebalanceOrderId) {
          const rebalanceLegAst = missingEasy ? easyLegAst : hardLegAst;
          const rebalanceLegIId = missingEasy ? easyLegIId : hardLegIId;
          const rebalancePrice = missingEasy ? plan.easyPrice : plan.hardPrice;
          const repairPortfolio = portfolioStore.get(accountId!);
          if (repairPortfolio) {
            await orderUseCases.placeOrderUseCase.execute({
              orderId: rebalanceOrderId,
              accountId: accountId!,
              asset: rebalanceLegAst,
              instrumentId: rebalanceLegIId,
              side: 'BUY',
              price: rebalancePrice,
              size: Quantity.of(new Decimal(report.unhedgedSize)),
              orderType,
              strategyId,
              portfolio: repairPortfolio,
              openOrdersCount: 0,
            });
            await sleep(repairDelayMs);
            await cancelIfPlaced(rebalanceOrderId, 'arb rebalance reconciliation');
            report = snapshotReport('REBALANCED');
            if (report.unhedgedSize <= 0.000001) return { ...report, accepted: report.balancedSize > 0 };
          }
        }

        logger.warn('Arb rebalance incomplete, unwinding surplus leg', {
          easyFilledSize: report.easyFilledSize.toFixed(4),
          hardFilledSize: report.hardFilledSize.toFixed(4),
          unhedgedSize: report.unhedgedSize.toFixed(4),
        });

        const surplusEasy = report.easyFilledSize > report.hardFilledSize;
        const unwindOrderId = asOrderId(`arb-unwind-${_arbOrderCounter++}-${Date.now()}`);
        if (unwindOrderId && report.unhedgedSize > 0) {
          const unwindLegAst = surplusEasy ? easyLegAst : hardLegAst;
          const unwindLegIId = surplusEasy ? easyLegIId : hardLegIId;
          const unwindPortfolio = portfolioStore.get(accountId!);
          if (unwindPortfolio) {
            await orderUseCases.placeOrderUseCase.execute({
              orderId: unwindOrderId,
              accountId: accountId!,
              asset: unwindLegAst,
              instrumentId: unwindLegIId,
              side: 'SELL',
              price: Price.of(new Decimal('0.01')),
              size: Quantity.of(new Decimal(report.unhedgedSize)),
              orderType,
              strategyId,
              portfolio: unwindPortfolio,
              openOrdersCount: 0,
            });
            await sleep(repairDelayMs);
            await cancelIfPlaced(unwindOrderId, 'arb unwind reconciliation');
            report = snapshotReport('UNWOUND');
            return { ...report, accepted: report.balancedSize > 0 && report.unhedgedSize <= 0.000001 };
          }
        }

        return { ...report, repairState: 'FAILED_REPAIR', accepted: report.balancedSize > 0 && report.unhedgedSize <= 0.000001 };
      }

      const easyErr = !easyResult.ok ? String(easyResult.error) : undefined;
      const hardErr = !hardResult.ok ? String(hardResult.error) : undefined;

      if (easyOk && !hardOk) {
        logger.warn('Hard leg rejected, cancelling easy leg', {
          easyOrderId: String(easyResult.value),
          hardError: hardErr,
        });
        await orderUseCases.cancelOrderUseCase.execute({
          orderId: easyResult.value,
          accountId: accountId!,
          reason: 'arb partial placement rejected',
        });
      } else if (!easyOk && hardOk) {
        logger.warn('Easy leg rejected, cancelling hard leg', {
          hardOrderId: String(hardResult.value),
          easyError: easyErr,
        });
        await orderUseCases.cancelOrderUseCase.execute({
          orderId: hardResult.value,
          accountId: accountId!,
          reason: 'arb partial placement rejected',
        });
      } else {
        logger.warn('Both arb legs rejected', {
          easyError: easyErr,
          hardError: hardErr,
        });
      }

      return emptyReport('REJECTED');
    });

    // ── activeMarkets + activeArbPairs (WS/catalog/RTDS уже настроены) ──
    const arbMc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const hardSlot: MarketSlot = {
      instrumentId: w.hardUpIId,
      marketId: w.hardCandidate.marketId,
      asset: w.hardUpAst,
      tokenIdStr: w.hardUpTokenStr,
      expiresAtMs: w.expiresAtMs,
      candidate: w.hardCandidate,
      strategy: arbStrategy,
      cryptoMeta: w.hardCryptoMeta,
      additionalInstrumentIds: [w.easyIId],
      outcomeIndex: arbMc.outcomeIndex,
      fillHistory: [],
      partialAccum: new Map(),
        directPartialAccum: new Map(),
      openedAt: Date.now(),
    };

    activeMarkets.set(w.hardUpTokenStr, hardSlot);
    const regOk = await rotation.registerMarketAndStrategy(hardSlot);
    if (!regOk) {
      activeMarkets.delete(w.hardUpTokenStr);
      return false;
    }

    const arbPair: ArbPairSlot = {
      pairId: w.pairId,
      easySlot: {
        instrumentId: w.easyIId,
        marketId: w.easyCandidate.marketId,
        asset: w.easyAst,
        tokenIdStr: w.easyUpTokenStr,
        candidate: w.easyCandidate,
        cryptoMeta: w.easyCryptoMeta,
      },
      hardTokenIdStr: w.hardUpTokenStr,
      hardDownTokenIdStr: w.hardDownTokenStr,
      easyDownTokenIdStr: w.easyDownTokenStr,
      expiresAtMs: w.expiresAtMs,
      strategy: arbStrategy,
      easyStartMs: w.easyStartMs,
      hardStartMs: w.hardStartMs,
      easyStrikeLocked: w.easyStrikeLocked,
      hardStrikeLocked: w.hardStrikeLocked,
    };

    activeArbPairs.set(w.pairId, arbPair);
    hardTokenToArbPair.set(w.hardUpTokenStr, w.pairId);

    logger.info('Promoted warming pair to active', {
      pairId: w.pairId,
      easyQuestion: w.easyCandidate.question,
      hardQuestion: w.hardCandidate.question,
      easyStrike: w.easyStrike?.toFixed(2) ?? 'pending',
      hardStrike: w.hardStrike?.toFixed(2) ?? 'pending',
      easyStrikeLocked: w.easyStrikeLocked,
      hardStrikeLocked: w.hardStrikeLocked,
      ttlSec: Math.round((w.expiresAtMs - Date.now()) / 1000),
    });

    return true;
  }

  /**
   * Прогревает следующую арб-пару: подписка WS + RTDS, регистрация в marketCatalog.
   * Стратегия НЕ создаётся — это произойдёт в `promoteWarmPair()`.
   *
   * @returns true если warming пара успешно создана
   *
   * @remarks
   * ### Алгоритм:
   * 1. Запрашиваем кандидатов из discovery кэша
   * 2. Парсим тикеры, находим пары через MarketPairMatcher
   * 3. Выбираем первую подходящую пару (не expired, не в blacklist, не активную)
   * 4. Деривируем токены, подписываемся на WS + RTDS
   * 5. Регистрируем в marketCatalog (BookUpdateHandler начнёт заполнять книги)
   * 6. Chainlink callback будет назначать strikes для warming пары
   *
   * ### Что НЕ делаем:
   * - Не создаём стратегию (нет расхода памяти на tick processing)
   * - Не регистрируем в scheduler (нет CPU на пустые тики)
   * - Не считаем как активный слот (не блокирует maxConcurrentMarkets)
   */
  async function warmNextArbPair(): Promise<boolean> {
    if (warmingArbPair) return false; // уже есть warming пара
    if (!discoveryAdapter || !isArbMode) return false;

    let candidates: readonly import('@polymarket/ports').DiscoveredMarket[];
    try {
      candidates = await discoveryAdapter.findCandidates();
    } catch (err) {
      logger.error('Failed to read candidates for arb warming', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }

    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const nowMs = Date.now();

    // Конвертируем кандидатов в MarketInfo (тот же код что в fillArbSlots)
    const marketInfos: (MarketInfo & { _candidate: import('@polymarket/ports').DiscoveredMarket })[] = [];
    for (const c of candidates) {
      const ticker = (c.rawMarket?.['events'] as readonly Record<string, unknown>[] | undefined)?.[0]?.['ticker'] as string | undefined;
      if (!ticker) continue;

      const parsed = MarketPairMatcher.parseTicker(ticker);
      if (!parsed) continue;

      const endDateStr = c.rawMarket?.['endDate'] as string | undefined;
      if (!endDateStr) continue;
      const endDateMs = new Date(endDateStr).getTime();
      if (Number.isNaN(endDateMs)) continue;

      const tStr = c.allTokenIds?.[mc.outcomeIndex] ?? String(c.instrumentId);
      const iId = asInstrumentId(tStr);
      if (!iId) continue;

      const cryptoMeta = parseCryptoMeta(c.rawMarket);

      marketInfos.push({
        asset: parsed.asset,
        recurrence: parsed.recurrence,
        endDate: endDateStr,
        startDate: new Date(parsed.startEpoch * 1000).toISOString(),
        startEpochMs: parsed.startEpoch * 1000,
        endEpochMs: endDateMs,
        instrumentId: iId,
        filePath: '',
        ticker,
        priceToBeat: cryptoMeta?.priceToBeat,
        _candidate: c,
      });
    }

    if (marketInfos.length < 2) return false;

    const pairs = pairMatcher.findPairs(marketInfos);
    const activeHardTokens = new Set(hardTokenToArbPair.keys());

    // Warming пара должна expires ПОСЛЕ всех текущих активных пар
    let latestActiveExpiryMs = 0;
    for (const ap of activeArbPairs.values()) {
      if (ap.expiresAtMs > latestActiveExpiryMs) latestActiveExpiryMs = ap.expiresAtMs;
    }

    logger.debug('Warming: scanning pairs', {
      pairsFound: pairs.length,
      latestActiveExpiry: latestActiveExpiryMs > 0 ? new Date(latestActiveExpiryMs).toISOString() : 'none',
      pairs: pairs.slice(0, 8).map(p => ({
        type: p.pairType,
        hardTicker: p.hard.ticker,
        endDate: p.hard.endDate,
        ttlSec: Math.round((p.hard.endEpochMs - nowMs) / 1000),
      })),
    });

    for (const pair of pairs) {
      // Warming пара должна иметь достаточно времени для торговли
      if (pair.hard.endEpochMs <= nowMs + MIN_VIABLE_TRADING_MS) continue;

      // Пропускаем пары которые expires до или одновременно с текущей активной
      if (latestActiveExpiryMs > 0 && pair.hard.endEpochMs <= latestActiveExpiryMs) continue;

      const easyCand = marketInfos.find(m => m.instrumentId === pair.easy.instrumentId)?._candidate;
      const hardCand = marketInfos.find(m => m.instrumentId === pair.hard.instrumentId)?._candidate;
      if (!easyCand || !hardCand) continue;

      const hardTStr = hardCand.allTokenIds?.[mc.outcomeIndex] ?? String(hardCand.instrumentId);
      // Не прогреваем уже активную или закрытую пару
      if (activeHardTokens.has(hardTStr)) continue;
      if (closedMarkets.has(String(hardCand.marketId))) continue;

      // ── Деривация токенов (как в openArbPair) ─────────────────────────
      const easyUpTokenStr = easyCand.allTokenIds?.[mc.outcomeIndex] ?? String(easyCand.instrumentId);
      const hardUpTokenStr = hardTStr;
      const hardDownIndex = mc.outcomeIndex === 0 ? 1 : 0;
      const hardDownTokenStr = hardCand.allTokenIds?.[hardDownIndex];
      if (!hardDownTokenStr) continue;

      const easyDownTokenStr = easyCand.allTokenIds?.[hardDownIndex];

      const easyIId = asInstrumentId(easyUpTokenStr);
      const hardUpIId = asInstrumentId(hardUpTokenStr);
      const hardDownIId = asInstrumentId(hardDownTokenStr);
      const easyDownIId = easyDownTokenStr ? asInstrumentId(easyDownTokenStr) : undefined;
      const easyAst = asPolymarketCtfToken(easyUpTokenStr);
      const hardUpAst = asPolymarketCtfToken(hardUpTokenStr);
      const hardDownAst = asPolymarketCtfToken(hardDownTokenStr);

      if (!easyIId || !hardUpIId || !hardDownIId || !easyAst || !hardUpAst || !hardDownAst) continue;

      const easyCryptoMeta = parseCryptoMeta(easyCand.rawMarket);
      const hardCryptoMeta = parseCryptoMeta(hardCand.rawMarket);
      const hardExpiresMs = hardCand.expiresAt.toNumber();
      const easyStartMs = easyCryptoMeta?.eventStartTimeMs ?? 0;
      const hardStartMs = hardCryptoMeta?.eventStartTimeMs ?? 0;

      // ── WS подписка (книги начнут заполняться) ────────────────────────
      await wsAdapter.subscribeToToken(easyUpTokenStr);
      await wsAdapter.subscribeToToken(hardUpTokenStr);
      await wsAdapter.subscribeToToken(hardDownTokenStr);
      if (easyDownTokenStr) await wsAdapter.subscribeToToken(easyDownTokenStr);

      // ── marketCatalog регистрация (BookUpdateHandler → MarketDataStore) ─
      const easyExpiresAtResult = TimestampService.create(easyCand.expiresAt.toNumber());
      if (easyExpiresAtResult.ok) {
        marketCatalog.register({
          instrumentId: easyIId,
          marketId: easyCand.marketId,
          tickSize: Price.of(new Decimal('0.001')),
          minOrderSize: Quantity.of(new Decimal('1')),
          minOrderValue: Quantity.of(new Decimal('1')),
          active: true,
          expiresAt: easyExpiresAtResult.value,
        });
      }
      const hardUpExpiresAtResult = TimestampService.create(hardExpiresMs);
      if (hardUpExpiresAtResult.ok) {
        marketCatalog.register({
          instrumentId: hardUpIId,
          marketId: hardCand.marketId,
          tickSize: Price.of(new Decimal('0.001')),
          minOrderSize: Quantity.of(new Decimal('1')),
          minOrderValue: Quantity.of(new Decimal('1')),
          active: true,
          expiresAt: hardUpExpiresAtResult.value,
        });
      }
      const hardDownExpiresAtResult = TimestampService.create(hardExpiresMs);
      if (hardDownExpiresAtResult.ok) {
        marketCatalog.register({
          instrumentId: hardDownIId,
          marketId: hardCand.marketId,
          tickSize: Price.of(new Decimal('0.001')),
          minOrderSize: Quantity.of(new Decimal('1')),
          minOrderValue: Quantity.of(new Decimal('1')),
          active: true,
          expiresAt: hardDownExpiresAtResult.value,
        });
      }
      if (easyDownIId && easyDownTokenStr) {
        const easyDownExpiresAtResult = TimestampService.create(easyCand.expiresAt.toNumber());
        if (easyDownExpiresAtResult.ok) {
          marketCatalog.register({
            instrumentId: easyDownIId,
            marketId: easyCand.marketId,
            tickSize: Price.of(new Decimal('0.001')),
            minOrderSize: Quantity.of(new Decimal('1')),
            minOrderValue: Quantity.of(new Decimal('1')),
            active: true,
            expiresAt: easyDownExpiresAtResult.value,
          });
        }
      }

      // ── RTDS подписка для Chainlink strikes ───────────────────────────
      if (hardCryptoMeta) {
        for (const sub of hardCryptoMeta.rtdsSubscriptions) {
          rtdsClient.subscribe(sub.topic, sub.filter);
        }
      }
      if (easyCryptoMeta) {
        for (const sub of easyCryptoMeta.rtdsSubscriptions) {
          rtdsClient.subscribe(sub.topic, sub.filter);
        }
      }

      // ── exchangeClient регистрация (для маршрутизации ордеров при promote) ─
      exchangeClient.registerMarket(easyIId, easyCand.marketId, accountId!, easyAst);
      exchangeClient.registerMarket(hardUpIId, hardCand.marketId, accountId!, hardUpAst);
      exchangeClient.registerMarket(hardDownIId, hardCand.marketId, accountId!, hardDownAst);

      // Сохраняем warming пару
      const pairId = `arb-${easyUpTokenStr}-${hardUpTokenStr}`;
      warmingArbPair = {
        pairId,
        easyCandidate: easyCand,
        hardCandidate: hardCand,
        easyUpTokenStr,
        hardUpTokenStr,
        hardDownTokenStr,
        easyDownTokenStr,
        easyIId,
        hardUpIId,
        hardDownIId,
        easyDownIId,
        easyAst,
        hardUpAst,
        hardDownAst,
        easyCryptoMeta,
        hardCryptoMeta,
        expiresAtMs: hardExpiresMs,
        easyStartMs,
        hardStartMs,
        easyStrikeLocked: false,
        hardStrikeLocked: false,
        easyStrike: easyCryptoMeta?.priceToBeat ?? null,
        hardStrike: hardCryptoMeta?.priceToBeat ?? null,
      };

      // Если strike уже известен из API — отмечаем
      if (warmingArbPair.easyStrike !== null) warmingArbPair.easyStrikeLocked = true;
      if (warmingArbPair.hardStrike !== null) warmingArbPair.hardStrikeLocked = true;

      logger.info('Warming next arb pair', {
        pairId,
        easyQuestion: easyCand.question,
        hardQuestion: hardCand.question,
        expiresAt: new Date(hardExpiresMs).toISOString(),
        easyStartTime: easyStartMs > 0 ? new Date(easyStartMs).toISOString() : 'N/A',
        hardStartTime: hardStartMs > 0 ? new Date(hardStartMs).toISOString() : 'N/A',
        easyStrike: warmingArbPair.easyStrike?.toFixed(2) ?? 'pending',
        hardStrike: warmingArbPair.hardStrike?.toFixed(2) ?? 'pending',
      });

      return true;
    }

    return false;
  }

  /**
   * Проверяет, есть ли более близкая пара для warming, и заменяет текущую.
   *
   * @remarks
   * Вызывается из scheduleScanLoop после каждого discovery refresh.
   * Если текущая warming пара далеко (>= 30 мин до expiry), а в кэше
   * появилась более близкая — заменяем: cleanup старой → warm новой.
   * Если warming пары нет вообще — вызываем warmNextArbPair().
   */
  async function tryUpgradeWarmingPair(): Promise<void> {
    if (!warmingArbPair) {
      // Нет warming — пробуем создать
      await warmNextArbPair();
      return;
    }

    const nowMs = Date.now();

    // Если warming пара уже протухла — чистим и пробуем новую
    if (warmingArbPair.expiresAtMs <= nowMs + MIN_VIABLE_TRADING_MS) {
      logger.debug('Warming pair expired, replacing', { pairId: warmingArbPair.pairId });
      cleanupWarmingPair('EXPIRED_BEFORE_PROMOTION');
      await warmNextArbPair();
      return;
    }

    // Если warming пара expires до активной — она бесполезна, заменяем
    let latestActiveExpiryMs = 0;
    for (const ap of activeArbPairs.values()) {
      if (ap.expiresAtMs > latestActiveExpiryMs) latestActiveExpiryMs = ap.expiresAtMs;
    }
    if (latestActiveExpiryMs > 0 && warmingArbPair.expiresAtMs <= latestActiveExpiryMs) {
      logger.debug('Warming pair expires before active pair, replacing', {
        warmingExpires: new Date(warmingArbPair.expiresAtMs).toISOString(),
        activeExpires: new Date(latestActiveExpiryMs).toISOString(),
      });
      cleanupWarmingPair('EXPIRES_BEFORE_ACTIVE');
      await warmNextArbPair();
      return;
    }

    // Если warming пара скоро стартует (< 5 мин до expiry) — не трогаем, уже оптимальная
    if (warmingArbPair.expiresAtMs - nowMs < 20 * 60_000) return;

    // Ищем более близкую пару в кэше
    if (!discoveryAdapter) return;

    let candidates: readonly import('@polymarket/ports').DiscoveredMarket[];
    try {
      candidates = await discoveryAdapter.findCandidates();
    } catch { return; }

    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const marketInfos: (MarketInfo & { _candidate: import('@polymarket/ports').DiscoveredMarket })[] = [];
    for (const c of candidates) {
      const ticker = (c.rawMarket?.['events'] as readonly Record<string, unknown>[] | undefined)?.[0]?.['ticker'] as string | undefined;
      if (!ticker) continue;
      const parsed = MarketPairMatcher.parseTicker(ticker);
      if (!parsed) continue;
      const endDateStr = c.rawMarket?.['endDate'] as string | undefined;
      if (!endDateStr) continue;
      const endDateMs = new Date(endDateStr).getTime();
      if (Number.isNaN(endDateMs)) continue;
      const tStr = c.allTokenIds?.[mc.outcomeIndex] ?? String(c.instrumentId);
      const iId = asInstrumentId(tStr);
      if (!iId) continue;
      const cryptoMeta = parseCryptoMeta(c.rawMarket);
      marketInfos.push({
        asset: parsed.asset, recurrence: parsed.recurrence,
        endDate: endDateStr,
        startDate: new Date(parsed.startEpoch * 1000).toISOString(),
        startEpochMs: parsed.startEpoch * 1000,
        endEpochMs: endDateMs,
        instrumentId: iId,
        filePath: '', ticker, priceToBeat: cryptoMeta?.priceToBeat, _candidate: c,
      });
    }

    if (marketInfos.length < 2) return;

    const pairs = pairMatcher.findPairs(marketInfos); // уже отсортированы по endEpochMs asc
    const activeHardTokens = new Set(hardTokenToArbPair.keys());

    for (const pair of pairs) {
      if (pair.hard.endEpochMs <= nowMs + MIN_VIABLE_TRADING_MS) continue;
      // Кандидат должен expires ПОСЛЕ активной пары (иначе warmNextArbPair его отфильтрует)
      if (latestActiveExpiryMs > 0 && pair.hard.endEpochMs <= latestActiveExpiryMs) continue;

      const hardCand = marketInfos.find(m => m.instrumentId === pair.hard.instrumentId)?._candidate;
      if (!hardCand) continue;
      const hardTStr = hardCand.allTokenIds?.[mc.outcomeIndex] ?? String(hardCand.instrumentId);
      if (activeHardTokens.has(hardTStr)) continue;
      if (closedMarkets.has(String(hardCand.marketId))) continue;

      // Нашли ближайшую доступную пару — ближе текущей warming?
      if (pair.hard.endEpochMs < warmingArbPair!.expiresAtMs) {
        // Проверяем что это действительно ДРУГАЯ пара
        if (warmingArbPair!.hardUpTokenStr === hardTStr) {
          // Та же пара — upgrade не нужен
          return;
        }
        logger.info('Upgrading warming pair to closer one', {
          oldPairId: warmingArbPair!.pairId,
          oldExpiresAt: new Date(warmingArbPair!.expiresAtMs).toISOString(),
          newEndDate: pair.hard.endDate,
          newHardToken: hardTStr,
        });
        cleanupWarmingPair('UPGRADE');
        await warmNextArbPair(); // подберёт ближайшую
      }
      return; // проверили первую подходящую — выходим
    }
  }
  // Ссылка на tryUpgradeWarmingPair — вызывается из scheduleScanLoop (для арб-режима).
  // TODO: Восстановить вызов из scan loop после полной миграции арб-кода в MarketRotation.
  void tryUpgradeWarmingPair;

  /**
   * Заполняет слоты арбитражными парами из кэша discovery.
   *
   * @remarks
   * ### Алгоритм:
   * 1. Получаем все кандидаты из discovery кэша
   * 2. Парсим тикеры через MarketPairMatcher.parseTicker()
   * 3. Группируем в MarketInfo[] и находим пары через pairMatcher.findPairs()
   * 4. Для каждой пары проверяем: не открыта ли уже, не в blacklist, не истекла
   * 5. Открываем пару через openArbPair()
   */
  async function fillArbSlots(): Promise<void> {
    if (!discoveryAdapter || !isArbMode) return;

    let candidates: readonly import('@polymarket/ports').DiscoveredMarket[];
    try {
      candidates = await discoveryAdapter.findCandidates();
    } catch (err) {
      logger.error('Failed to read candidates for arb discovery', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const nowMs = Date.now();

    // Конвертируем кандидатов в MarketInfo через parseTicker
    const marketInfos: (MarketInfo & { _candidate: import('@polymarket/ports').DiscoveredMarket })[] = [];
    for (const c of candidates) {
      const ticker = (c.rawMarket?.['events'] as readonly Record<string, unknown>[] | undefined)?.[0]?.['ticker'] as string | undefined;
      if (!ticker) continue;

      const parsed = MarketPairMatcher.parseTicker(ticker);
      if (!parsed) continue;

      // endDate берём из Gamma API (авторитетный источник), НЕ вычисляем из тикера.
      // Тикер содержит startEpoch, а нам нужен endDate для матчинга пар.
      const endDateStr = c.rawMarket?.['endDate'] as string | undefined;
      if (!endDateStr) continue;
      const endDateMs = new Date(endDateStr).getTime();
      if (Number.isNaN(endDateMs)) continue;

      const tStr = c.allTokenIds?.[mc.outcomeIndex] ?? String(c.instrumentId);
      const iId = asInstrumentId(tStr);
      if (!iId) continue;

      const cryptoMeta = parseCryptoMeta(c.rawMarket);

      marketInfos.push({
        asset: parsed.asset,
        recurrence: parsed.recurrence,
        endDate: endDateStr,
        startDate: new Date(parsed.startEpoch * 1000).toISOString(),
        startEpochMs: parsed.startEpoch * 1000,
        endEpochMs: endDateMs,
        instrumentId: iId,
        filePath: '',
        ticker,
        priceToBeat: cryptoMeta?.priceToBeat,
        _candidate: c,
      });
    }

    if (marketInfos.length < 2) {
      logger.debug('Arb discovery: not enough parseable candidates for pairing', {
        totalCandidates: candidates.length,
        parsedMarketInfos: marketInfos.length,
      });
      return;
    }

    const pairs = pairMatcher.findPairs(marketInfos);

    // Диагностика: логируем все найденные пары для дебага выбора
    logger.info('Arb pair candidates from discovery', {
      totalCandidates: candidates.length,
      parsedInfos: marketInfos.length,
      pairsFound: pairs.length,
      pairs: pairs.map(p => ({
        type: p.pairType,
        easyTicker: p.easy.ticker,
        hardTicker: p.hard.ticker,
        endDate: p.hard.endDate,
        endEpochMs: p.hard.endEpochMs,
        ttlSec: Math.round((p.hard.endEpochMs - nowMs) / 1000),
      })),
    });

    // Текущие активные hard токены
    const activeHardTokens = new Set(hardTokenToArbPair.keys());

    let skippedExpired = 0;
    let skippedActive = 0;
    let skippedBlacklist = 0;
    let skippedFull = 0;
    let selectedPairEndDate: string | undefined;

    for (const pair of pairs) {
      if (activeMarkets.size >= maxConcurrentMarkets) { skippedFull++; continue; }

      // Проверяем не истекла ли пара
      if (pair.hard.endEpochMs <= nowMs + MIN_VIABLE_TRADING_MS) { skippedExpired++; continue; }

      // Ищем кандидатов по instrumentId
      const easyCand = marketInfos.find(m => m.instrumentId === pair.easy.instrumentId)?._candidate;
      const hardCand = marketInfos.find(m => m.instrumentId === pair.hard.instrumentId)?._candidate;
      if (!easyCand || !hardCand) continue;

      const hardTStr = hardCand.allTokenIds?.[mc.outcomeIndex] ?? String(hardCand.instrumentId);
      if (activeHardTokens.has(hardTStr)) { skippedActive++; continue; }
      if (closedMarkets.has(String(hardCand.marketId))) { skippedBlacklist++; continue; }

      if (!selectedPairEndDate) {
        selectedPairEndDate = pair.hard.endDate;
        logger.info('Arb pair selected for activation', {
          pairType: pair.pairType,
          endDate: pair.hard.endDate,
          ttlSec: Math.round((pair.hard.endEpochMs - nowMs) / 1000),
          easyTicker: pair.easy.ticker,
          hardTicker: pair.hard.ticker,
        });
      }

      const opened = await openArbPair(easyCand, hardCand);
      if (opened) {
        activeHardTokens.add(hardTStr);
      }
    }

    if (activeArbPairs.size === 0 && isArbMode) {
      logger.warn('No arb pairs found in discovery cache', {
        candidates: candidates.length,
        parsedInfos: marketInfos.length,
        pairsFound: pairs.length,
        skippedExpired,
        skippedActive,
        skippedBlacklist,
        skippedFull,
        closedMarketsCount: closedMarkets.size,
      });
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
        // Позиция на комплементарном токене (auto-selection)
        if (slot.complementaryInstrumentId) {
          const compPos = portfolio.getPosition(slot.complementaryInstrumentId);
          if (compPos) {
            totalQty = totalQty.plus(compPos.quantity.value());
            if (!avgEntry) avgEntry = compPos.averageEntryPrice.value().toFixed(4);
          }
        }
      }
      // Арб-позиции: easy + hardDown инструменты (не в activeMarkets)
      for (const pair of activeArbPairs.values()) {
        const easyPos = portfolio.getPosition(pair.easySlot.instrumentId);
        if (easyPos) {
          totalQty = totalQty.plus(easyPos.quantity.value());
          if (!avgEntry) avgEntry = easyPos.averageEntryPrice.value().toFixed(4);
        }
        const hardDownIId = asInstrumentId(pair.hardDownTokenIdStr);
        if (hardDownIId) {
          const hdPos = portfolio.getPosition(hardDownIId);
          if (hdPos) {
            totalQty = totalQty.plus(hdPos.quantity.value());
            if (!avgEntry) avgEntry = hdPos.averageEntryPrice.value().toFixed(4);
          }
        }
      }
      return {
        tokenQty: totalQty.toFixed(2),
        avgEntry,
        usdc: portfolio.balance.available().value().toFixed(2),
        reserved: portfolio.balance.reserved().value().toFixed(2),
      };
    },
    getTokenLabel: (asset: unknown) => {
      const iId = assetIdToInstrumentId(asset as Parameters<typeof assetIdToInstrumentId>[0]);
      if (!iId) return undefined;
      const tokenIdStr = String(iId);
      if (activeMarkets.has(tokenIdStr)) return 'UP';
      if (activeCompTokens.has(tokenIdStr)) return 'DOWN';
      return undefined;
    },
  });


  // Fill tracking — управляется через MarketRotation
  rotation.registerFillTracking();


  // Регистрируем все начальные слоты
  for (const slot of activeMarkets.values()) {
    const ok = await rotation.registerMarketAndStrategy(slot);
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

  // Подключаемся к RTDS для крипто-цен.
  // В арб-режиме всегда подключаемся (крипто-рынки будут открыты позже через fillArbSlots).
  const hasCryptoMarkets = isArbMode || Array.from(activeMarkets.values()).some(s => s.cryptoMeta !== undefined);
  if (hasCryptoMarkets) {
    try {
      await rtdsClient.connect();
    } catch (err) {
      logger.warn('Failed to connect to RTDS, crypto prices unavailable', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const activeSlotIds = Array.from(activeMarkets.values()).map(s => s.strategy.id);
  logger.info('Bot is running in paper mode', {
    strategy: config.strategyRules?.length ? 'multi-strategy' : config.strategy,
    ...(config.strategyRules?.length ? { rules: config.strategyRules.map(r => r.label) } : {}),
    strategyIds: activeSlotIds,
    activeSlots: activeMarkets.size,
    maxConcurrentMarkets,
    source: config.market.source,
  });

  // Запускаем ротацию только для discovery режима
  if (rotation.discoveryAdapter) {
    if (isArbMode) {
      // Арб-режим: кастомный expiry check (arb pair → closeArbPair)
      let _arbRotationInProgress = false;
      let _arbStatusCounter = 0;
      const CANCEL_BEFORE_EXPIRY_MS = 5_000;
      const WARM_AHEAD_MS = 60_000;
      setInterval(() => {
        if (rotation.isShuttingDown || _arbRotationInProgress) return;
        _arbRotationInProgress = true;
        void (async () => {
          try {
            const nowMs = Date.now();
            // Арб-статус (каждые ~30с = 6 × 5с)
            if (++_arbStatusCounter % 6 === 0) {
              for (const [pairId, pair] of activeArbPairs) {
                const easyBook = marketDataStore.getTopOfBook(pair.easySlot.instrumentId);
                const hardSlot = activeMarkets.get(pair.hardTokenIdStr);
                const hardBook = hardSlot ? marketDataStore.getTopOfBook(hardSlot.instrumentId) : undefined;
                const metrics = hardSlot?.strategy?.getMetrics?.() as Record<string, unknown> | undefined;
                const ttlSec = Math.max(0, Math.round((pair.expiresAtMs - nowMs) / 1000));
                logger.info('Arb pair status', {
                  pairId, ttlSec,
                  ticks: metrics?.['tickCount'] ?? 0,
                  divergences: metrics?.['divergenceCount'] ?? 0,
                  trades: metrics?.['tradeCount'] ?? 0,
                  easyBid: easyBook?.bestBid?.value().toFixed(2) ?? '-',
                  easyAsk: easyBook?.bestAsk?.value().toFixed(2) ?? '-',
                  hardBid: hardBook?.bestBid?.value().toFixed(2) ?? '-',
                  hardAsk: hardBook?.bestAsk?.value().toFixed(2) ?? '-',
                });
              }
            }
            const expiredTokens: string[] = [];
            for (const [tokenIdStr, slot] of activeMarkets) {
              if (!slot.candidate) continue;
              if (slot.expiresAtMs - nowMs <= CANCEL_BEFORE_EXPIRY_MS) expiredTokens.push(tokenIdStr);
            }
            for (const tokenIdStr of expiredTokens) {
              const arbPairId = hardTokenToArbPair.get(tokenIdStr);
              if (arbPairId) {
                await closeArbPair(arbPairId, 'EXPIRED');
              } else {
                await rotation.closeMarket(tokenIdStr, 'EXPIRED');
              }
            }
            if (expiredTokens.length > 0) {
              const promoted = await promoteWarmPair();
              if (!promoted) await fillArbSlots();
              await warmNextArbPair();
            }
            // Прогреваем если до expiry < WARM_AHEAD_MS
            if (!warmingArbPair && activeArbPairs.size > 0) {
              let earliestExpiryMs = Infinity;
              for (const pair of activeArbPairs.values()) {
                if (pair.expiresAtMs < earliestExpiryMs) earliestExpiryMs = pair.expiresAtMs;
              }
              if (earliestExpiryMs - nowMs <= WARM_AHEAD_MS && earliestExpiryMs - nowMs > 0) {
                await warmNextArbPair();
              }
            }
          } finally { _arbRotationInProgress = false; }
        })();
      }, 5_000);
      void fillArbSlots();
    } else {
      rotation.startExpiryCheck();
      if (maxConcurrentMarkets > 1) void rotation.fillMarketSlots();
    }

    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    void rotation.scheduleScanLoop();

    logger.info('Market rotation enabled', {
      expiryCheckMs: 5_000,
      scanPauseMs: mc.scanPauseMs ?? 60_000,
      maxConcurrentMarkets,
      arbMode: isArbMode,
    });
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    if (rotation.isShuttingDown) return;
    rotation.isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    rotation.stopTimers();

    try {
      // Очищаем warming пару (если есть)
      cleanupWarmingPair('SHUTDOWN');

      // Закрываем арб-пары (easy slot cleanup)
      for (const pairId of [...activeArbPairs.keys()]) {
        await closeArbPair(pairId, 'SHUTDOWN');
      }

      // Закрываем все активные слоты через rotation
      for (const tokenIdStr of [...activeMarkets.keys()]) {
        await rotation.closeMarket(tokenIdStr, 'SHUTDOWN');
      }

      engine.scheduler.stop();
      engine.orderEventBridge.stop();
      simulator.stop();
      marketDataFeedAdapter.stop();
      await wsAdapter.disconnect();
      rtdsClient.disconnect();
      await paperCexService?.stop();
      marketDataStore.stop();
      await recording?.close();
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
  if (config.market.source !== 'snapshots' && config.market.source !== 'discovery') {
    console.error('[Bot] backtest mode requires market.source=snapshots or market.source=discovery');
    process.exit(1);
  }

  const marketConfig = config.market;
  const outcomeIndex = marketConfig.outcomeIndex ?? 1;

  const snapshotPaths = 'paths' in marketConfig ? marketConfig.paths : undefined;
  if (!snapshotPaths || snapshotPaths.length === 0) {
    console.error('[Bot] market.paths must be non-empty for backtest mode');
    process.exit(1);
  }

  // Резолв glob-паттернов в paths (поддержка *, **, и конкретных файлов)
  const resolvedPaths = await resolveSnapshotPaths(snapshotPaths);
  if (resolvedPaths.length === 0) {
    console.error('[Bot] No snapshot files found for paths:', snapshotPaths);
    process.exit(1);
  }

  // Discovery-over-snapshots и multi-market mode используют единый runner,
  // чтобы filter применялся одинаково ко всем snapshot-файлам.
  if (config.market.source === 'discovery' || resolvedPaths.length > 1) {
    await runMultiMarketBacktest(resolvedPaths, config, outcomeIndex as 0 | 1);
    return;
  }

  const snapshotPath = resolvedPaths[0]!;

  // Читаем meta из первого снапшота
  const metaResult = await readSnapshotMeta(snapshotPath, outcomeIndex);
  if (!metaResult) {
    console.error('[Bot] No meta line found in snapshot:', snapshotPath);
    process.exit(1);
  }

  const { marketId, instrumentId, asset, rawMarket: snapshotRawMarket } = metaResult;

  const replayClock = new ReplayClock(new Date(0));
  const infra = buildCoreInfra({ clock: replayClock, logLevel: LogLevel.INFO });
  const { logger, eventBus } = infra;

  logger.warn('Bot starting in backtest mode', {
    files: resolvedPaths.length,
    firstSnapshot: path.basename(snapshotPath),
    outcomeIndex,
    marketId: String(marketId),
    instrumentId: String(instrumentId),
    initialBalance: config.resources.initialBalance,
  });

  if (resolvedPaths.length > 1) {
    logger.info('Backtest snapshot files', {
      paths: resolvedPaths.map((p) => path.basename(p)),
    });
  }

  const repos = buildRepositories();
  const { portfolioStore, orderRepo } = repos;

  const riskParams: RiskParams = buildRiskParams(config);

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
    portfolioStore,
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

  // ── Crypto price infrastructure (backtest) ──────────────────────────────
  const backtestCryptoPriceStore = new CryptoPriceStore();
  const backtestCryptoMarketDataStore = new CryptoMarketDataStore();
  const backtestCryptoSignalRegistry = createDefaultCryptoSignalRegistry();
  const backtestCryptoMeta = parseCryptoMeta(snapshotRawMarket);

  if (backtestCryptoMeta) {
    logger.info('Crypto market detected in snapshot', {
      source: backtestCryptoMeta.source,
      symbol: backtestCryptoMeta.binanceSymbol,
      rtdsFilter: backtestCryptoMeta.rtdsFilter,
    });
  }

  const engine = buildStrategyEngine({
    infra,
    repos,
    useCases,
    marketDataStore,
    marketCatalog,
    cryptoPriceStore: backtestCryptoPriceStore,
    cryptoMarketDataStore: backtestCryptoMarketDataStore,
    cryptoSignalRegistry: backtestCryptoSignalRegistry,
  });

  // Регистрируем инструмент в каталоге (нужен BookUpdateHandler для маппинга tokenId → marketId)
  const rawEndDateForInstrument = snapshotRawMarket?.['endDate'] as string | undefined;
  const parsedEndDateMs = rawEndDateForInstrument ? new Date(rawEndDateForInstrument).getTime() : NaN;
  const realExpirationMs = !Number.isNaN(parsedEndDateMs) ? parsedEndDateMs : Date.now() + 86400_000;
  const expiresAtResult = TimestampService.create(realExpirationMs);
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

  const strategy = createStrategy(
    { type: config.strategy, params: config.strategyParams } as StrategyConfig,
    logger,
    undefined,
    config.execution,
  );

  // Извлекаем eventStartTime / endDate из rawMarket (Gamma API) — есть у любого рынка, не только крипто
  const rawEventStart = snapshotRawMarket?.['eventStartTime'] as string | undefined;
  const rawEndDate = snapshotRawMarket?.['endDate'] as string | undefined;
  const snapshotEventStartMs = rawEventStart ? new Date(rawEventStart).getTime() : undefined;
  const snapshotEndDateMs = rawEndDate ? new Date(rawEndDate).getTime() : undefined;

  const expirationMs = snapshotEndDateMs && !Number.isNaN(snapshotEndDateMs)
    ? snapshotEndDateMs
    : Date.now() + 24 * 60 * 60 * 1000;
  const marketStub = { expirationMs } as Parameters<typeof engine.scheduler.register>[0]['market'];

  const eventStartMs = snapshotEventStartMs && !Number.isNaN(snapshotEventStartMs)
    ? snapshotEventStartMs
    : undefined;

  const regResult = await engine.scheduler.register({
    strategy, instrumentId, asset, accountId, market: marketStub,
    cryptoSymbol: backtestCryptoMeta?.rtdsFilter,
    eventStartMs,
  });
  if (!regResult.ok) {
    logger.fatal('Failed to register strategy', { error: String(regResult.error) });
    process.exit(1);
  }

  const backtestEngine = new BacktestEngine(
    { filePaths: resolvedPaths, outcomeIndex },
    {
      bookUpdateHandler,
      eventBus,
      replayClock,
      logger,
      cryptoPriceStore: backtestCryptoPriceStore,
      cryptoMarketDataStore: backtestCryptoMarketDataStore,
      parseCryptoMeta,
    },
  );

  const replayResult = await backtestEngine.run();

  // Fallback: если после replay нет targetPrice или crypto_price — Binance klines
  if (backtestCryptoMeta) {
    const snap = backtestCryptoPriceStore.get(backtestCryptoMeta.rtdsFilter);
    const needTarget = !snap?.targetPrice;
    const needPrices = replayResult.cryptoPriceEvents === 0;

    if (needTarget || needPrices) {
      logger.info('Backtest crypto fallback needed', {
        needTarget,
        needPrices,
        symbol: backtestCryptoMeta.rtdsFilter,
      });
      const backtestBinanceClient = new BinanceKlinesClient(logger);
      try {
        const interval = computeInterval(backtestCryptoMeta.endDateMs - backtestCryptoMeta.eventStartTimeMs);
        const kline = await backtestBinanceClient.getKline(
          backtestCryptoMeta.binanceSymbol,
          backtestCryptoMeta.eventStartTimeMs,
          interval,
        );
        if (needTarget) {
          backtestCryptoPriceStore.setTargetPrice(backtestCryptoMeta.rtdsFilter, kline.open);
        }
        if (needPrices) {
          backtestCryptoPriceStore.updatePrice(backtestCryptoMeta.rtdsFilter, kline.close, backtestCryptoMeta.endDateMs);
        }
        backtestCryptoPriceStore.setResolutionPrice(backtestCryptoMeta.rtdsFilter, kline.close);
        logger.info('Binance klines fallback applied', {
          symbol: backtestCryptoMeta.binanceSymbol,
          strikePrice: needTarget ? kline.open : snap?.targetPrice,
          resolutionPrice: kline.close,
        });
      } catch (err) {
        logger.warn('Binance klines fallback failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Остановка
  await engine.scheduler.unregister(strategy.id);
  engine.scheduler.stop();
  engine.orderEventBridge.stop();
  simulator.stop();
  marketDataStore.stop();

  // Settlement при наличии крипто-рынка с известным исходом
  if (backtestCryptoMeta) {
    const resolution = backtestCryptoPriceStore.getResolution(backtestCryptoMeta.rtdsFilter);
    if (resolution) {
      const portfolio = portfolioStore.get(accountId)!;
      const position = portfolio.getPosition(instrumentId);
      if (position && !position.isClosed()) {
        const qty = position.quantity.value();
        const isWinning = (outcomeIndex === 0 && resolution === 'UP') || (outcomeIndex === 1 && resolution === 'DOWN');
        const settlementPrice = isWinning ? new Decimal(1) : new Decimal(0);
        const cashCredit = qty.times(settlementPrice);

        // Удаляем позицию (settled)
        const closedPosition = new SimplePosition({
          instrumentId,
          quantity: new Decimal(0),
          averageEntryPrice: position.averageEntryPrice.value(),
          side: 'LONG' as const,
        });
        let updated = portfolio.upsertPosition(closedPosition);

        // Зачисляем settlement cash
        if (cashCredit.gt(0)) {
          const creditResult = updated.applyCredit(Money.of(cashCredit, 'USDC'));
          if (creditResult.ok) updated = creditResult.value;
        }

        const currentVersion = portfolioStore.getVersion(accountId);
        const saveResult = portfolioStore.save(updated, currentVersion);
        if (!saveResult.ok) {
          logger.error('Settlement portfolio save failed (version conflict)', {
            expected: currentVersion,
          });
        }
        logger.info(`Market resolved ${resolution} — settlement @ $${settlementPrice} for ${qty.toFixed(2)} tokens`, {
          symbol: backtestCryptoMeta.rtdsFilter,
          resolution,
          settlementPrice: settlementPrice.toFixed(2),
          cashCredit: cashCredit.toFixed(4),
          outcomeIndex,
        });
      }
    }
  }

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

  // Crypto price summary
  const cryptoSnap = backtestCryptoMeta ? backtestCryptoPriceStore.get(backtestCryptoMeta.rtdsFilter) : undefined;
  const cryptoResolution = backtestCryptoMeta ? backtestCryptoPriceStore.getResolution(backtestCryptoMeta.rtdsFilter) : undefined;

  logger.warn('=== BACKTEST RESULTS ===', {
    snapshot: path.basename(snapshotPath),
    outcome: outcomeIndex === 0 ? 'YES' : 'NO',
    bookEvents: replayResult.bookEvents,
    tradeEvents: replayResult.tradeEvents,
    cryptoPriceEvents: replayResult.cryptoPriceEvents,
    cexBookEvents: replayResult.cexBookEvents,
    cexTradeEvents: replayResult.cexTradeEvents,
    errors: replayResult.errors,
    durationMs: replayResult.durationMs,
    ...(cryptoSnap ? {
      cryptoSymbol: cryptoSnap.symbol,
      strikePrice: cryptoSnap.targetPrice,
      resolutionPrice: cryptoSnap.resolutionPrice,
      cryptoResolution,
    } : {}),
  });

  if (config.strategyRules?.length) {
    logger.warn('Multi-strategy config', {
      rules: config.strategyRules.map(r => ({ label: r.label, strategy: r.strategy, match: r.match })),
    });
  } else {
    logger.warn('Strategy config', { type: config.strategy, ...config.strategyParams, execution: config.execution });
  }

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
  const selectiveStats = strategy instanceof SelectiveEntryStrategy
    ? strategy.stats
    : { buyAttempts: 0, cancelAfterPlace: 0 };
  const executionStats = engine.executionEngine.stats ?? {
    benignPostOnlyRejects: (engine.executionEngine as unknown as { _benignPostOnlyRejects?: number })._benignPostOnlyRejects ?? 0,
  };

  logger.warn('Executed cycles', {
    totalFills: executedFills.length,
    buys: buyCount,
    sells: sellCount,
    buyAttempts: selectiveStats.buyAttempts,
    postOnlyRejects: executionStats.benignPostOnlyRejects,
    cancelAfterPlace: selectiveStats.cancelAfterPlace,
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
 * 3. Создание live инфраструктуры (REST stack + startup use-cases + WS user channel)
 * 4. Startup: баланс с биржи через initializePortfolioUseCase, сверка ордеров
 * 5. WS подключение (market data + user channel для fills)
 * 6. Запуск стратегии + ротация рынков (только для discovery)
 * 7. Polling fallback: reconcileTradesUseCase каждые 60 сек (safety net)
 *
 * ### Балансирование:
 * - Начальный баланс берётся с биржи через `initializePortfolioUseCase.execute()`.
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
    builderCode: process.env['BUILDER_CODE'] || undefined,
  };

  // ── Core infra ───────────────────────────────────────────────────────────

  const infra = buildCoreInfra({ logLevel: LogLevel.INFO });
  const { clock, logger, eventBus } = infra;

  // ── Recording (опциональная запись рыночных данных и журнала решений) ──────
  const recording = buildRecording(config.recording, logger);

  // ── Авто-клейм (redeem) settled позиций через Builder Relayer (gasless) ──
  let redeemer: PolymarketRedeemer | undefined;
  try {
    redeemer = PolymarketRedeemer.fromEnv(logger);
    logger.info('Auto-redeemer initialized (gasless via Builder Relayer)');
  } catch (err) {
    logger.warn('Auto-redeemer not available (missing BUILDER_API_KEY/SECRET/PASSPHRASE)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Фоновый авто-клейм всех settled рынков ──────────────────────────────
  let autoRedeemer: AutoRedeemer | undefined;
  try {
    autoRedeemer = AutoRedeemer.fromEnv(logger);
    autoRedeemer.start();
    logger.info('Background auto-redeemer started (checks every 5 min)');
  } catch (err) {
    logger.warn('Background auto-redeemer not available', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Мульти-маркетное состояние (live) ──────────────────────────────────────
  // MarketRotation создаётся после engine. Промежуточные переменные для early setup.
  const maxConcurrentMarkets = config.resources.maxConcurrentMarkets;
  const minCapitalPerMarket = config.resources.minCapitalPerMarket;
  const isLiveArbMode = config.strategy === 'cross-market-arb';
  let _slotCounter = 0;
  let _liveArbOrderCounter = 0;
  const initialSlots = new Map<string, MarketSlot>();
  const initialCompTokens = new Set<string>();
  const liveActiveArbPairs = new Map<string, {
    pairId: string;
    easyInstrumentId: InstrumentId;
    easyMarketId: MarketId;
    easyAsset: AssetId;
    easyTokenIdStr: string;
    hardUpInstrumentId: InstrumentId;
    hardUpMarketId: MarketId;
    hardUpAsset: AssetId;
    hardUpTokenIdStr: string;
    hardDownInstrumentId: InstrumentId;
    hardDownAsset: AssetId;
    hardDownTokenIdStr: string;
    easyDownInstrumentId?: InstrumentId;
    easyDownAsset?: AssetId;
    easyDownTokenIdStr?: string;
    expiresAtMs: number;
    strategy: CrossMarketArbStrategy;
    easyCryptoMeta: CryptoMarketMeta | undefined;
    hardCryptoMeta: CryptoMarketMeta | undefined;
    easyStartMs: number;
    hardStartMs: number;
    easyStrikeLocked: boolean;
    hardStrikeLocked: boolean;
    easyQuestion: string;
    hardQuestion: string;
    openedAtMs: number;
  }>();
  let discoveryAdapter: PolymarketMarketDiscoveryAdapter | null = null;

  // ── Crypto price infrastructure (live) ─────────────────────────────────
  const liveCryptoPriceStore = new CryptoPriceStore();
  const liveCryptoMarketDataStore = new CryptoMarketDataStore();
  const liveCryptoSignalRegistry = createDefaultCryptoSignalRegistry();
  const liveCexService = createBotCexService(config, logger, liveCryptoMarketDataStore, recording ?? undefined);
  const liveBinanceClient = new BinanceKlinesClient(logger);
  const liveRtdsClient = new RtdsWebSocketClient(
    { url: 'wss://ws-live-data.polymarket.com' },
    logger,
  );

  // RTDS → CryptoPriceStore wiring
  // Chainlink strike price fallback (аналогично paper mode):
  // Map: rtdsFilter → eventStartTimeMs. Первая Chainlink цена с ts >= eventStartTime = strike.
  const livePendingChainlinkStrike = new Map<string, number>();

  /** Менеджер RTDS подписок live mode (subscribe/deferred cleanup) */
  const liveCryptoSubs = new CryptoSubscriptionManager(liveRtdsClient, logger);
  let liveLastCryptoPriceLogMs = 0;
  const CRYPTO_PRICE_LOG_INTERVAL_MS = 30_000;
  // Recording: подключаем запись крипто-цен из RTDS
  recording?.wireToRtds(liveRtdsClient);

  liveRtdsClient.onPrice((symbol, price, ts) => {
    liveCryptoPriceStore.updatePrice(symbol, price, ts);
    liveCryptoMarketDataStore.updatePrice({ symbol, price, timestampMs: ts, receivedTsMs: Date.now() });

    // Периодический лог крипто-цен (раз в 30с) — только символ активного рынка
    if (symbol.includes('/')) {
      const isActiveSymbol = Array.from(activeMarkets.values()).some(s => s.cryptoMeta?.rtdsFilter === symbol);
      if (isActiveSymbol) {
        const now = Date.now();
        if (now - liveLastCryptoPriceLogMs >= CRYPTO_PRICE_LOG_INTERVAL_MS) {
          liveLastCryptoPriceLogMs = now;
          const snap = liveCryptoPriceStore.get(symbol);
          logger.info('Crypto price update', {
            symbol,
            price: price.toFixed(2),
            targetPrice: snap?.targetPrice?.toFixed(2) ?? '-',
            source: 'chainlink',
          });
        }
      }
    }

    // Chainlink strike fallback: первая Chainlink цена после eventStartTime
    if (symbol.includes('/') && livePendingChainlinkStrike.has(symbol)) {
      const eventStartMs = livePendingChainlinkStrike.get(symbol)!;
      if (ts >= eventStartMs) {
        liveCryptoPriceStore.setTargetPrice(symbol, price);
        livePendingChainlinkStrike.delete(symbol);
        logger.info('Strike price from Chainlink RTDS (first after eventStart, live)', {
          symbol,
          strikePrice: price,
          chainlinkTs: new Date(ts).toISOString(),
          eventStartTime: new Date(eventStartMs).toISOString(),
        });
      }
    }

    if (symbol.includes('/')) {
      for (const pair of liveActiveArbPairs.values()) {
        const pairSymbol = pair.easyCryptoMeta?.rtdsFilter;
        if (!pairSymbol || pairSymbol !== symbol) continue;

        if (!pair.easyStrikeLocked && pair.easyStartMs > 0 && ts >= pair.easyStartMs) {
          pair.easyStrikeLocked = true;
          pair.strategy.updateStrikes(null, price);
          logger.info('Arb peer (easy) strike from Chainlink (live)', {
            pairId: pair.pairId,
            peerStrike: price,
            assignment: pair.strategy.assignment,
            chainlinkTs: new Date(ts).toISOString(),
          });
        }
        if (!pair.hardStrikeLocked && pair.hardStartMs > 0 && ts >= pair.hardStartMs) {
          pair.hardStrikeLocked = true;
          pair.strategy.updateStrikes(price, null);
          logger.info('Arb slot (hard) strike from Chainlink (live)', {
            pairId: pair.pairId,
            slotStrike: price,
            assignment: pair.strategy.assignment,
            chainlinkTs: new Date(ts).toISOString(),
          });
        }
      }
    }

  });

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
    const liveFixedSelection = selectStrategyForMarket(config, {
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    });
    if (!liveFixedSelection) {
      logger.fatal('No strategy rule matches fixed market');
      process.exit(1);
    }
    const fixedStrategy = createStrategy(
      { type: liveFixedSelection.strategy, id: `${liveFixedSelection.strategy}-slot-${_slotCounter++}`, params: liveFixedSelection.strategyParams } as StrategyConfig,
      logger,
      undefined,
      config.execution,
    );
    initialSlots.set(tStr, {
      instrumentId: iId,
      marketId: mid,
      asset: ast,
      tokenIdStr: tStr,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      tickSize: Price.of(new Decimal('0.001')),
      minOrderSize: Quantity.of(new Decimal('1')),
      candidate: null,
      strategy: fixedStrategy,
      cryptoMeta: undefined,
      outcomeIndex: (config.market as { outcomeIndex?: number }).outcomeIndex as 0 | 1 ?? 0,
      fillHistory: [],
      partialAccum: new Map(),
        directPartialAccum: new Map(),
      openedAt: Date.now(),
    });
  } else if (config.market.source === 'discovery') {
    const mc = config.market;
    const filterConfig: IMarketFilterConfig = {
      minTimeToExpiryHours: mc.filter.minTimeToExpiryHours ?? 0,
      minSpread: 0,
      minLiquidity: mc.filter.minLiquidity ?? 0,
      maxMarketsToReturn: 100,
      anyOfKeywords: mc.filter.anyOfKeywords,
      requiredKeywords: mc.filter.requiredKeywords,
      excludedKeywords: mc.filter.excludedKeywords,
      minDurationMinutes: mc.filter.minDurationMinutes,
      maxDurationMinutes: mc.filter.maxDurationMinutes,
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
    // Initial market будет открыт через rotation.fillMarketSlots() после создания rotation.

  } else {
    console.error('[Bot] live mode supports market.source=fixed or market.source=discovery');
    process.exit(1);
  }

  const firstSlot = initialSlots.values().next().value;
  logger.info('Bot starting', {
    mode: 'live',
    strategy: config.strategyRules?.length ? 'multi-strategy' : config.strategy,
    ...(config.strategyRules?.length ? { rules: config.strategyRules.map(r => r.label) } : {}),
    marketId: firstSlot ? String(firstSlot.marketId) : '(discovery: deferred)',
    maxConcurrentMarkets,
    account: config.account.accountId,
    funderAddress: credentials.funderAddress ?? '(signer)',
  });

  const accountId = parseAccountId(config.account.accountId);
  if (!accountId) {
    logger.fatal('Invalid account.accountId', { accountId: config.account.accountId });
    process.exit(1);
  }

  const repos = buildRepositories();
  const { portfolioStore } = repos;
  const riskParams = buildRiskParams(config);

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

  const orderUseCases = buildOrderUseCases({
    infra,
    repos,
    exchangeClient: liveInfra.exchangeClient,
    riskParams,
  });
  const useCases = {
    processFillUseCase,
    portfolioService,
    ...orderUseCases,
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

  const engine = buildStrategyEngine({
    infra,
    repos,
    useCases,
    marketDataStore,
    marketCatalog,
    tokenBalanceChecker,
    cryptoPriceStore: liveCryptoPriceStore,
    cryptoMarketDataStore: liveCryptoMarketDataStore,
    cryptoSignalRegistry: liveCryptoSignalRegistry,
  });

  if (liveCexService) {
    await liveCexService.cleanup();
    liveCexService.start();
  }

  // ── MarketRotation (единый модуль ротации для live) ────────────────────
  const rotation = new MarketRotation({
    logger,
    clock,
    eventBus,
    portfolioStore,
    accountId,
    wsAdapter: marketWsAdapter,
    cryptoPriceStore: liveCryptoPriceStore,
    cryptoSubs: liveCryptoSubs,
    pendingChainlinkStrike: livePendingChainlinkStrike,
    binanceClient: liveBinanceClient,
    engine,
    marketCatalog,
    recording,
    config,
    maxConcurrentMarkets,
    minCapitalPerMarket,
    mode: 'live',
    orderReconciler: liveInfra.orderReconciler,
    redeemer,
  });
  // Fixed market: переносим initial slot; Discovery: rotation сам откроет через fillMarketSlots
  for (const [key, slot] of initialSlots) rotation.activeMarkets.set(key, slot);
  for (const compToken of initialCompTokens) rotation.activeCompTokens.add(compToken);
  if (discoveryAdapter) {
    rotation.setDiscoveryAdapter(discoveryAdapter);
    if (!isLiveArbMode) {
      // Открываем первый рынок через единый код rotation.fillMarketSlots()
      await rotation.fillMarketSlots();
    }
    if (!isLiveArbMode && rotation.activeMarkets.size === 0) {
      logger.fatal('No markets found matching discovery filter at startup');
      process.exit(1);
    }
  }
  const activeMarkets = rotation.activeMarkets;
  const activeCompTokens = rotation.activeCompTokens;

  async function openLiveArbPair(easyCandidate: DiscoveredMarket, hardCandidate: DiscoveredMarket): Promise<boolean> {
    const portfolio = portfolioStore.get(accountId!);
    if (portfolio && portfolio.balance.available().value().lt(minCapitalPerMarket)) {
      logger.warn('Insufficient capital for live arb pair', {
        available: portfolio.balance.available().value().toFixed(2),
        minCapitalPerMarket,
      });
      return false;
    }

    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const easyUpTokenStr = easyCandidate.allTokenIds?.[mc.outcomeIndex] ?? String(easyCandidate.instrumentId);
    const hardUpTokenStr = hardCandidate.allTokenIds?.[mc.outcomeIndex] ?? String(hardCandidate.instrumentId);
    const downIndex = mc.outcomeIndex === 0 ? 1 : 0;
    const hardDownTokenStr = hardCandidate.allTokenIds?.[downIndex];
    const easyDownTokenStr = easyCandidate.allTokenIds?.[downIndex];
    if (!hardDownTokenStr) return false;

    const easyIId = asInstrumentId(easyUpTokenStr);
    const hardUpIId = asInstrumentId(hardUpTokenStr);
    const hardDownIId = asInstrumentId(hardDownTokenStr);
    const easyDownIId = easyDownTokenStr ? asInstrumentId(easyDownTokenStr) : undefined;
    const easyAst = asPolymarketCtfToken(easyUpTokenStr);
    const hardUpAst = asPolymarketCtfToken(hardUpTokenStr);
    const hardDownAst = asPolymarketCtfToken(hardDownTokenStr);
    const easyDownAst = easyDownTokenStr ? asPolymarketCtfToken(easyDownTokenStr) : undefined;
    if (!easyIId || !hardUpIId || !hardDownIId || !easyAst || !hardUpAst || !hardDownAst) return false;

    const easyCryptoMeta = parseCryptoMeta(easyCandidate.rawMarket);
    const hardCryptoMeta = parseCryptoMeta(hardCandidate.rawMarket);
    const hardExpiresMs = hardCandidate.expiresAt.toNumber();
    const easyStartMs = easyCryptoMeta?.eventStartTimeMs ?? 0;
    const hardStartMs = hardCryptoMeta?.eventStartTimeMs ?? 0;
    const strategyId = `cross-market-arb-live-slot-${_slotCounter++}`;
    const arbConfig = config.strategyParams as CrossMarketArbConfig;
    const fullArbConfig: CrossMarketArbConfig = {
      peerInstrumentId: easyIId,
      slotDownInstrumentId: hardDownIId,
      peerDownInstrumentId: easyDownIId,
      minSpreadAfterFees: arbConfig.minSpreadAfterFees ?? 0.005,
      maxPositionUnits: arbConfig.maxPositionUnits ?? 5,
      maxDepth: arbConfig.maxDepth ?? 1,
      slotStrike: hardCryptoMeta?.priceToBeat ?? null,
      peerStrike: easyCryptoMeta?.priceToBeat ?? null,
      bookStalenessMs: arbConfig.bookStalenessMs ?? 1500,
      auditMode: arbConfig.auditMode ?? false,
      executionOrderType: arbConfig.executionOrderType ?? 'FAK',
      executionReconcileDelayMs: arbConfig.executionReconcileDelayMs ?? 750,
      executionRepairDelayMs: arbConfig.executionRepairDelayMs ?? 750,
    };
    const arbStrategy = new CrossMarketArbStrategy(fullArbConfig, marketDataStore, strategyId, logger);

    // Флаг: hedge-ордер размещён и ждём fill — предотвращает double-hedge между тиками
    let hedgePending = false;
    arbStrategy.setTradeCallback(async (plan): Promise<ArbTradeExecutionReport> => {
      const currentPortfolio = portfolioStore.get(accountId!);
      const plannedSize = plan.size.value().toNumber();
      const emptyReport = (repairState: ArbTradeExecutionReport['repairState']): ArbTradeExecutionReport => ({
        accepted: false,
        repairState,
        plannedSize,
        easyFilledSize: 0,
        hardFilledSize: 0,
        balancedSize: 0,
        unhedgedSize: 0,
      });
      if (!currentPortfolio) return emptyReport('REJECTED');

      const resolveLeg = (instrumentId: InstrumentId): { asset: AssetId; instrumentId: InstrumentId } | undefined => {
        const id = String(instrumentId);
        if (id === String(easyIId)) return { asset: easyAst, instrumentId: easyIId };
        if (easyDownIId && easyDownAst && id === String(easyDownIId)) return { asset: easyDownAst, instrumentId: easyDownIId };
        if (id === String(hardUpIId)) return { asset: hardUpAst, instrumentId: hardUpIId };
        if (id === String(hardDownIId)) return { asset: hardDownAst, instrumentId: hardDownIId };
        return undefined;
      };
      const easyLeg = resolveLeg(plan.easyInstrumentId);
      const hardLeg = resolveLeg(plan.hardInstrumentId);
      if (!easyLeg || !hardLeg) return emptyReport('REJECTED');

      // Detect hedge mode first: одна нога есть, другая отсутствует (split FAK race condition).
      // В hedge mode пропускаем обычные cash/notional/capacity guards — используем отдельный путь.
      const existingEasyQty = currentPortfolio.getPosition(easyLeg.instrumentId)?.quantity.value().toNumber() ?? 0;
      const existingHardQty = currentPortfolio.getPosition(hardLeg.instrumentId)?.quantity.value().toNumber() ?? 0;
      const maxPos = fullArbConfig.maxPositionUnits;
      const isUnhedgedHard = existingHardQty > 0.000001 && existingEasyQty < 0.000001;
      const isUnhedgedEasy = existingEasyQty > 0.000001 && existingHardQty < 0.000001;
      const isHedgeMode = isUnhedgedHard || isUnhedgedEasy;

      if (!isHedgeMode) {
        const requiredCash = plannedSize * (plan.estimatedCostPerUnit + plan.estimatedFeePerUnit);
        const availableCash = currentPortfolio.balance.available().value().toNumber();
        if (availableCash < requiredCash) return emptyReport('REJECTED');

        // Polymarket min order notional = $1. Reject plan до размещения ордеров.
        const minOrderNotional = 1.0;
        const easyNotional = plan.easyPrice.value().toNumber() * plannedSize;
        const hardNotional = plan.hardPrice.value().toNumber() * plannedSize;
        if (easyNotional < minOrderNotional || hardNotional < minOrderNotional) {
          logger.warn('Arb plan rejected: order notional below $1 minimum', {
            easyNotional: easyNotional.toFixed(4),
            hardNotional: hardNotional.toFixed(4),
            plannedSize,
          });
          return emptyReport('REJECTED');
        }

        // Защита от повторного входа: реальные позиции могут опережать _currentPositionUnits
        // если предыдущий коллбэк вернул accepted:false после частичного fill.
        if (existingEasyQty + plannedSize > maxPos || existingHardQty + plannedSize > maxPos) {
          logger.warn('Arb plan rejected: position already at or near limit', {
            existingEasyQty,
            existingHardQty,
            plannedSize,
            maxPositionUnits: maxPos,
          });
          return emptyReport('REJECTED');
        }
      }

      const orderType = arbConfig.executionOrderType ?? 'FAK';
      const reconcileDelayMs = arbConfig.executionReconcileDelayMs ?? 750;
      const repairDelayMs = arbConfig.executionRepairDelayMs ?? 750;
      // Ждём fills для указанных ордеров через WS или истечения таймаута (что раньше).
      // Позволяет выйти из ожидания раньше reconcileDelayMs если все ноги уже matched.
      const waitForOrdersMatchedOrTimeout = (orderIds: readonly string[], timeoutMs: number): Promise<void> =>
        new Promise<void>((resolve) => {
          const remaining = new Set(orderIds);
          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsub();
            resolve();
          };
          const unsub = eventBus.subscribe('FILL_RECEIVED', (event) => {
            remaining.delete(String(event.fill.orderId));
            if (remaining.size === 0) done();
          });
          timer = setTimeout(done, timeoutMs);
        });
      const qtyOf = (instrumentId: InstrumentId): number =>
        portfolioStore.get(accountId!)?.getPosition(instrumentId)?.quantity.value().toNumber() ?? 0;
      const beforeEasyQty = qtyOf(easyLeg.instrumentId);
      const beforeHardQty = qtyOf(hardLeg.instrumentId);
      const cancelIfPlaced = async (orderId: ReturnType<typeof asOrderId> | undefined, reason: string): Promise<void> => {
        if (!orderId) return;
        await orderUseCases.cancelOrderUseCase.execute({ orderId, accountId: accountId!, reason });
      };
      const snapshotReport = (repairState: ArbTradeExecutionReport['repairState']): ArbTradeExecutionReport => {
        const easyFilledSize = Math.max(0, qtyOf(easyLeg.instrumentId) - beforeEasyQty);
        const hardFilledSize = Math.max(0, qtyOf(hardLeg.instrumentId) - beforeHardQty);
        const balancedSize = Math.min(easyFilledSize, hardFilledSize);
        const unhedgedSize = Math.abs(easyFilledSize - hardFilledSize);
        const actualNotional = easyFilledSize * plan.easyPrice.value().toNumber()
          + hardFilledSize * plan.hardPrice.value().toNumber();
        const actualFees = balancedSize * plan.estimatedFeePerUnit;
        const conservativeSettlementValue = balancedSize;
        return {
          accepted: balancedSize > 0 && unhedgedSize < 0.000001,
          repairState,
          plannedSize,
          easyFilledSize,
          hardFilledSize,
          balancedSize,
          unhedgedSize,
          actualNotional,
          actualFees,
          conservativeSettlementValue,
          conservativePnl: conservativeSettlementValue - actualNotional - actualFees,
        };
      };

      // Hedge mode: одна нога куплена, второй нет — размещаем только недостающую FAK.
      // Повторяется каждый тик пока hedge не заполнится или рынок не закроется.
      if (isHedgeMode) {
        if (hedgePending) {
          logger.debug('Arb hedge skipped: hedge order already pending');
          return emptyReport('REJECTED');
        }
        const missingLeg = isUnhedgedHard ? easyLeg : hardLeg;
        const existingQty = isUnhedgedHard ? existingHardQty : existingEasyQty;
        const hedgeSizeNum = Math.max(1, Math.min(Math.floor(existingQty), maxPos));
        const missingLegTob = marketDataStore.getTopOfBook(missingLeg.instrumentId);
        const currentAsk = missingLegTob?.bestAsk?.value().toNumber() ?? null;
        const maxHedgePrice = 0.75;
        const hedgeBuffer = 0.03;
        if (currentAsk === null) {
          logger.warn('Arb hedge skipped: no book data for missing leg', {
            missingLeg: isUnhedgedHard ? 'EASY' : 'HARD',
            instrumentId: String(missingLeg.instrumentId),
          });
          return emptyReport('REJECTED');
        }
        if (currentAsk > maxHedgePrice) {
          logger.warn('Arb hedge skipped: ask above ceiling', {
            missingLeg: isUnhedgedHard ? 'EASY' : 'HARD',
            currentAsk: currentAsk.toFixed(4),
            maxHedgePrice,
          });
          return emptyReport('REJECTED');
        }
        const hedgePriceNum = Math.min(currentAsk + hedgeBuffer, 0.99);
        const hedgeNotional = hedgePriceNum * hedgeSizeNum;
        if (hedgeNotional < 1.0) {
          logger.warn('Arb hedge skipped: notional below $1 minimum', {
            missingLeg: isUnhedgedHard ? 'EASY' : 'HARD',
            hedgeNotional: hedgeNotional.toFixed(4),
            hedgeSizeNum,
            hedgePriceNum: hedgePriceNum.toFixed(4),
          });
          return emptyReport('REJECTED');
        }
        logger.warn('Arb hedge mode: placing single FAK for missing leg', {
          missingLeg: isUnhedgedHard ? 'EASY' : 'HARD',
          instrumentId: String(missingLeg.instrumentId),
          currentAsk: currentAsk.toFixed(4),
          hedgePrice: hedgePriceNum.toFixed(4),
          hedgeSizeNum,
          existingEasyQty: existingEasyQty.toFixed(4),
          existingHardQty: existingHardQty.toFixed(4),
        });
        const hedgeBeforeQty = qtyOf(missingLeg.instrumentId);
        hedgePending = true;
        try {
          const hedgeOrderId = asOrderId(`arb-live-hedge-${_liveArbOrderCounter++}-${Date.now()}`);
          if (!hedgeOrderId) return emptyReport('REJECTED');
          const hedgePortfolio = portfolioStore.get(accountId!);
          if (!hedgePortfolio) return emptyReport('REJECTED');
          const hedgePriceVO = Price.of(new Decimal(hedgePriceNum.toFixed(4)));
          const hedgeSizeVO = Quantity.of(new Decimal(hedgeSizeNum));
          const hedgeResult = await orderUseCases.placeOrderUseCase.execute({
            orderId: hedgeOrderId,
            accountId: accountId!,
            asset: missingLeg.asset,
            instrumentId: missingLeg.instrumentId,
            side: 'BUY',
            price: hedgePriceVO,
            size: hedgeSizeVO,
            orderType: 'FAK',
            strategyId,
            portfolio: hedgePortfolio,
            openOrdersCount: 0,
          });
          if (!hedgeResult.ok) return emptyReport('REJECTED');
          await waitForOrdersMatchedOrTimeout([String(hedgeOrderId)], reconcileDelayMs);
          await cancelIfPlaced(hedgeResult.value, 'arb hedge reconciliation');
          await liveInfra.reconcileTradesUseCase.execute({ accountId: accountId! });
          const hedgeFilledQty = Math.max(0, qtyOf(missingLeg.instrumentId) - hedgeBeforeQty);
          const totalEasyQty = isUnhedgedHard ? hedgeFilledQty : existingEasyQty;
          const totalHardQty = isUnhedgedHard ? existingHardQty : hedgeFilledQty;
          const balancedSize = Math.min(totalEasyQty, totalHardQty);
          const unhedgedSize = Math.abs(totalEasyQty - totalHardQty);
          logger.warn('Arb hedge result', {
            missingLeg: isUnhedgedHard ? 'EASY' : 'HARD',
            hedgeFilledQty: hedgeFilledQty.toFixed(4),
            balancedSize: balancedSize.toFixed(4),
            unhedgedSize: unhedgedSize.toFixed(4),
            hedgePrice: hedgePriceNum.toFixed(4),
          });
          return {
            accepted: balancedSize > 0,
            repairState: hedgeFilledQty > 0 ? 'REBALANCED' : 'FAILED_REPAIR',
            plannedSize,
            easyFilledSize: totalEasyQty,
            hardFilledSize: totalHardQty,
            balancedSize,
            unhedgedSize,
            actualNotional: hedgeFilledQty * hedgePriceNum,
            actualFees: balancedSize * plan.estimatedFeePerUnit,
            conservativeSettlementValue: balancedSize,
            conservativePnl: balancedSize - hedgeFilledQty * hedgePriceNum - balancedSize * plan.estimatedFeePerUnit,
          };
        } finally {
          hedgePending = false;
        }
      }

      const easyOrderId = asOrderId(`arb-live-easy-${_liveArbOrderCounter++}-${Date.now()}`);
      const hardOrderId = asOrderId(`arb-live-hard-${_liveArbOrderCounter++}-${Date.now()}`);
      if (!easyOrderId || !hardOrderId) return emptyReport('REJECTED');
      const [easyResult, hardResult] = await Promise.all([
        orderUseCases.placeOrderUseCase.execute({
          orderId: easyOrderId,
          accountId: accountId!,
          asset: easyLeg.asset,
          instrumentId: easyLeg.instrumentId,
          side: 'BUY',
          price: plan.easyPrice,
          size: plan.size,
          orderType,
          strategyId,
          portfolio: currentPortfolio,
          openOrdersCount: 0,
        }),
        orderUseCases.placeOrderUseCase.execute({
          orderId: hardOrderId,
          accountId: accountId!,
          asset: hardLeg.asset,
          instrumentId: hardLeg.instrumentId,
          side: 'BUY',
          price: plan.hardPrice,
          size: plan.size,
          orderType,
          strategyId,
          portfolio: currentPortfolio,
          openOrdersCount: 0,
        }),
      ]);

      if (!easyResult.ok || !hardResult.ok) {
        if (easyResult.ok) await cancelIfPlaced(easyResult.value, 'arb partial placement rejected');
        if (hardResult.ok) await cancelIfPlaced(hardResult.value, 'arb partial placement rejected');
        return emptyReport('REJECTED');
      }

      // Ждём пока обе ноги matched (WS) или истечёт reconcileDelayMs (whichever first)
      await waitForOrdersMatchedOrTimeout(
        [String(easyOrderId), String(hardOrderId)],
        reconcileDelayMs,
      );
      // Отменяем оба GTC-ордера: заполненные игнорируют cancel, незаполненные снимаются
      await Promise.all([
        cancelIfPlaced(easyResult.value, 'arb reconciliation'),
        cancelIfPlaced(hardResult.value, 'arb reconciliation'),
      ]);
      await liveInfra.reconcileTradesUseCase.execute({ accountId: accountId! });
      let report = snapshotReport('BALANCED');
      if (report.balancedSize <= 0 && report.unhedgedSize <= 0) return { ...report, accepted: false, repairState: 'NO_FILL' };
      if (report.unhedgedSize <= 0.000001) return report;

      // Второй reconcile: ловим WS-fills с задержкой (Polymarket REST может запаздывать на 1-3с)
      await liveInfra.reconcileTradesUseCase.execute({ accountId: accountId! });
      report = snapshotReport('BALANCED');
      if (report.unhedgedSize <= 0.000001) return report;

      // Одна нога не заполнилась. Rebalance по актуальной TOB-цене — plan-цена уже устарела.
      const missingEasy = report.easyFilledSize < report.hardFilledSize;
      const rebalanceLeg = missingEasy ? easyLeg : hardLeg;
      const missingLegTob = marketDataStore.getTopOfBook(rebalanceLeg.instrumentId);
      const rebalancePrice: Price = missingLegTob?.bestAsk ?? (missingEasy ? plan.easyPrice : plan.hardPrice);
      const rebalancePriceNum = rebalancePrice.value().toNumber();

      // Проверяем прибыльность repair по ТЕКУЩЕЙ книге: читаем обе ноги из marketDataStore.
      // plan-цены устарели — рынок мог сдвинуться за время reconcileDelayMs.
      // Вопрос: если купить обе ноги прямо сейчас по текущим аск-ценам — есть ли ещё арб?
      const filledLegInstrument = missingEasy ? hardLeg.instrumentId : easyLeg.instrumentId;
      const filledLegTob = marketDataStore.getTopOfBook(filledLegInstrument);
      const filledLegFallback = missingEasy
        ? plan.hardPrice.value().toNumber()
        : plan.easyPrice.value().toNumber();
      const filledLegCurrentAsk = filledLegTob?.bestAsk?.value().toNumber() ?? filledLegFallback;
      const combinedCostIfRepair = filledLegCurrentAsk + rebalancePriceNum;
      const repairIsProfitable = combinedCostIfRepair < 1.0 - (fullArbConfig.minSpreadAfterFees ?? 0.001);

      if (!repairIsProfitable) {
        logger.warn('Arb repair skipped: combined cost unprofitable at current book, unwinding filled leg', {
          missingLeg: missingEasy ? 'EASY' : 'HARD',
          filledLegCurrentAsk: filledLegCurrentAsk.toFixed(4),
          rebalancePrice: rebalancePriceNum.toFixed(4),
          combinedCostIfRepair: combinedCostIfRepair.toFixed(4),
          minSpreadRequired: fullArbConfig.minSpreadAfterFees ?? 0.001,
          unhedgedSize: report.unhedgedSize,
        });
        report = { ...report, repairState: 'NEEDS_UNWIND' };
      } else {
        // Фиксируем baseline ДО repair: исключает поздние WS-fills оригинального ордера из счёта
        const repairBaseEasyQty = qtyOf(easyLeg.instrumentId);
        const repairBaseHardQty = qtyOf(hardLeg.instrumentId);

        const rebalanceOrderId = asOrderId(`arb-live-rebalance-${_liveArbOrderCounter++}-${Date.now()}`);
        if (rebalanceOrderId) {
          const repairPortfolio = portfolioStore.get(accountId!);
          if (repairPortfolio) {
            logger.info('Arb rebalance: placing repair leg at current TOB price', {
              missingLeg: missingEasy ? 'EASY' : 'HARD',
              instrumentId: String(rebalanceLeg.instrumentId),
              rebalancePrice: rebalancePriceNum.toFixed(4),
              stalePlanPrice: missingEasy
                ? plan.easyPrice.value().toFixed(4)
                : plan.hardPrice.value().toFixed(4),
              combinedCostIfRepair: combinedCostIfRepair.toFixed(4),
              unhedgedSize: report.unhedgedSize,
            });
            await orderUseCases.placeOrderUseCase.execute({
              orderId: rebalanceOrderId,
              accountId: accountId!,
              asset: rebalanceLeg.asset,
              instrumentId: rebalanceLeg.instrumentId,
              side: 'BUY',
              price: rebalancePrice,
              size: Quantity.of(new Decimal(report.unhedgedSize)),
              orderType: 'FAK',
              strategyId,
              portfolio: repairPortfolio,
              openOrdersCount: 0,
            });
            await waitForOrdersMatchedOrTimeout([String(rebalanceOrderId)], repairDelayMs);
            await cancelIfPlaced(rebalanceOrderId, 'arb rebalance reconciliation');
            await liveInfra.reconcileTradesUseCase.execute({ accountId: accountId! });

            // Инкрементальный подсчёт: только fills repair-фазы + оригинальные из первого отчёта.
            // Предотвращает двойной счёт если поздний WS-fill оригинала пришёл во время repair-окна.
            const repairEasyFill = Math.max(0, qtyOf(easyLeg.instrumentId) - repairBaseEasyQty);
            const repairHardFill = Math.max(0, qtyOf(hardLeg.instrumentId) - repairBaseHardQty);
            const totalEasyFilled = report.easyFilledSize + repairEasyFill;
            const totalHardFilled = report.hardFilledSize + repairHardFill;
            const rebalancedSize = Math.min(totalEasyFilled, totalHardFilled);
            const rebalancedUnhedged = Math.abs(totalEasyFilled - totalHardFilled);
            // Нотионал: оригинальные fills по plan-цене + repair-fills по фактической rebalancePrice
            const repairLegFills = missingEasy ? repairEasyFill : repairHardFill;
            const rebalancedNotional =
              report.easyFilledSize * plan.easyPrice.value().toNumber()
              + report.hardFilledSize * plan.hardPrice.value().toNumber()
              + repairLegFills * rebalancePriceNum;
            report = {
              accepted: rebalancedSize > 0 && rebalancedUnhedged < 0.000001,
              repairState: 'REBALANCED',
              plannedSize,
              easyFilledSize: totalEasyFilled,
              hardFilledSize: totalHardFilled,
              balancedSize: rebalancedSize,
              unhedgedSize: rebalancedUnhedged,
              actualNotional: rebalancedNotional,
              actualFees: rebalancedSize * plan.estimatedFeePerUnit,
              conservativeSettlementValue: rebalancedSize,
              conservativePnl: rebalancedSize - rebalancedNotional - rebalancedSize * plan.estimatedFeePerUnit,
            };
            if (report.unhedgedSize <= 0.000001) return { ...report, accepted: report.balancedSize > 0 };
          }
        }
      }

      // Всё ещё несбалансировано — агрессивная продажа избыточной ноги по best bid
      const surplusEasy = report.easyFilledSize > report.hardFilledSize;
      const unwindOrderId = asOrderId(`arb-live-unwind-${_liveArbOrderCounter++}-${Date.now()}`);
      if (unwindOrderId && report.unhedgedSize > 0) {
        const unwindLeg = surplusEasy ? easyLeg : hardLeg;
        const unwindPortfolio = portfolioStore.get(accountId!);
        if (unwindPortfolio) {
          await orderUseCases.placeOrderUseCase.execute({
            orderId: unwindOrderId,
            accountId: accountId!,
            asset: unwindLeg.asset,
            instrumentId: unwindLeg.instrumentId,
            side: 'SELL',
            price: Price.of(new Decimal('0.01')),
            size: Quantity.of(new Decimal(report.unhedgedSize)),
            orderType: 'FAK',
            strategyId,
            portfolio: unwindPortfolio,
            openOrdersCount: 0,
          });
          await waitForOrdersMatchedOrTimeout([String(unwindOrderId)], repairDelayMs);
          await cancelIfPlaced(unwindOrderId, 'arb unwind reconciliation');
          await liveInfra.reconcileTradesUseCase.execute({ accountId: accountId! });
          report = snapshotReport('UNWOUND');
          return { ...report, accepted: report.balancedSize > 0 && report.unhedgedSize <= 0.000001 };
        }
      }
      return { ...report, repairState: 'FAILED_REPAIR', accepted: false };
    });

    const expiresAtResult = TimestampService.create(hardExpiresMs);
    const easyExpiresAtResult = TimestampService.create(easyCandidate.expiresAt.toNumber());
    if (!expiresAtResult.ok || !easyExpiresAtResult.ok) return false;
    for (const item of [
      { instrumentId: easyIId, marketId: easyCandidate.marketId, expiresAt: easyExpiresAtResult.value },
      { instrumentId: hardUpIId, marketId: hardCandidate.marketId, expiresAt: expiresAtResult.value },
      { instrumentId: hardDownIId, marketId: hardCandidate.marketId, expiresAt: expiresAtResult.value },
      ...(easyDownIId ? [{ instrumentId: easyDownIId, marketId: easyCandidate.marketId, expiresAt: easyExpiresAtResult.value }] : []),
    ]) {
      marketCatalog.register({
        instrumentId: item.instrumentId,
        marketId: item.marketId,
        tickSize: Price.of(new Decimal('0.001')),
        minOrderSize: Quantity.of(new Decimal('1')),
        minOrderValue: Quantity.of(new Decimal('1')),
        active: true,
        expiresAt: item.expiresAt,
      });
    }

    const hardSlot: MarketSlot = {
      instrumentId: hardUpIId,
      marketId: hardCandidate.marketId,
      asset: hardUpAst,
      tokenIdStr: hardUpTokenStr,
      expiresAtMs: hardExpiresMs,
      candidate: hardCandidate,
      strategy: arbStrategy,
      cryptoMeta: hardCryptoMeta,
      additionalInstrumentIds: [easyIId, hardDownIId, ...(easyDownIId ? [easyDownIId] : [])],
      outcomeIndex: mc.outcomeIndex,
      fillHistory: [],
      partialAccum: new Map(),
      directPartialAccum: new Map(),
      openedAt: Date.now(),
    };
    activeMarkets.set(hardUpTokenStr, hardSlot);
    const registered = await rotation.registerMarketAndStrategy(hardSlot);
    if (!registered) {
      activeMarkets.delete(hardUpTokenStr);
      return false;
    }
    activeCompTokens.add(easyUpTokenStr);
    activeCompTokens.add(hardDownTokenStr);
    if (easyDownTokenStr) activeCompTokens.add(easyDownTokenStr);

    await marketWsAdapter.subscribeToToken(easyUpTokenStr);
    await marketWsAdapter.subscribeToToken(hardUpTokenStr);
    await marketWsAdapter.subscribeToToken(hardDownTokenStr);
    if (easyDownTokenStr) await marketWsAdapter.subscribeToToken(easyDownTokenStr);

    for (const meta of [easyCryptoMeta, hardCryptoMeta]) {
      if (!meta) continue;
      for (const sub of meta.rtdsSubscriptions) liveRtdsClient.subscribe(sub.topic, sub.filter);
    }

    const easyStartsAtResult = easyStartMs > 0 ? TimestampService.create(easyStartMs) : undefined;
    const hardStartsAtResult = hardStartMs > 0 ? TimestampService.create(hardStartMs) : undefined;

    recording?.openMarket(easyCandidate, {
      marketId: easyCandidate.marketId,
      question: easyCandidate.question ?? String(easyCandidate.marketId),
      tokenIds: [easyUpTokenStr, easyDownTokenStr].filter((id): id is string => !!id),
      startsAt: easyStartsAtResult?.ok ? easyStartsAtResult.value : undefined,
      expiresAt: easyExpiresAtResult.value,
      rawMarket: easyCandidate.rawMarket,
    }, 'live');
    recording?.openMarket(hardCandidate, {
      marketId: hardCandidate.marketId,
      question: hardCandidate.question ?? String(hardCandidate.marketId),
      tokenIds: [hardUpTokenStr, hardDownTokenStr],
      startsAt: hardStartsAtResult?.ok ? hardStartsAtResult.value : undefined,
      expiresAt: expiresAtResult.value,
      rawMarket: hardCandidate.rawMarket,
    }, 'live');

    const pairId = `arb-live-${easyUpTokenStr}-${hardUpTokenStr}`;
    liveActiveArbPairs.set(pairId, {
      pairId,
      easyInstrumentId: easyIId,
      easyMarketId: easyCandidate.marketId,
      easyAsset: easyAst,
      easyTokenIdStr: easyUpTokenStr,
      hardUpInstrumentId: hardUpIId,
      hardUpMarketId: hardCandidate.marketId,
      hardUpAsset: hardUpAst,
      hardUpTokenIdStr: hardUpTokenStr,
      hardDownInstrumentId: hardDownIId,
      hardDownAsset: hardDownAst,
      hardDownTokenIdStr: hardDownTokenStr,
      easyDownInstrumentId: easyDownIId,
      easyDownAsset: easyDownAst,
      easyDownTokenIdStr: easyDownTokenStr,
      expiresAtMs: hardExpiresMs,
      strategy: arbStrategy,
      easyCryptoMeta,
      hardCryptoMeta,
      easyStartMs,
      hardStartMs,
      easyStrikeLocked: easyCryptoMeta?.priceToBeat !== undefined,
      hardStrikeLocked: hardCryptoMeta?.priceToBeat !== undefined,
      easyQuestion: easyCandidate.question ?? String(easyCandidate.marketId),
      hardQuestion: hardCandidate.question ?? String(hardCandidate.marketId),
      openedAtMs: Date.now(),
    });

    logger.warn('Live arb pair opened', {
      pairId,
      easy: easyCandidate.question,
      hard: hardCandidate.question,
      maxPositionUnits: fullArbConfig.maxPositionUnits,
      executionOrderType: fullArbConfig.executionOrderType,
    });
    return true;
  }

  async function fillLiveArbSlots(): Promise<void> {
    if (!discoveryAdapter || !isLiveArbMode || activeMarkets.size >= maxConcurrentMarkets) return;
    const candidates = await discoveryAdapter.findCandidates();
    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    const nowMs = Date.now();
    const marketInfos: (MarketInfo & { _candidate: DiscoveredMarket })[] = [];
    for (const c of candidates) {
      const ticker = (c.rawMarket?.['events'] as readonly Record<string, unknown>[] | undefined)?.[0]?.['ticker'] as string | undefined;
      if (!ticker) continue;
      const parsed = MarketPairMatcher.parseTicker(ticker);
      if (!parsed) continue;
      const endDateStr = c.rawMarket?.['endDate'] as string | undefined;
      if (!endDateStr) continue;
      const endDateMs = new Date(endDateStr).getTime();
      if (Number.isNaN(endDateMs)) continue;
      const tokenId = c.allTokenIds?.[mc.outcomeIndex] ?? String(c.instrumentId);
      const instrumentId = asInstrumentId(tokenId);
      if (!instrumentId) continue;
      const cryptoMeta = parseCryptoMeta(c.rawMarket);
      marketInfos.push({
        asset: parsed.asset,
        recurrence: parsed.recurrence,
        endDate: endDateStr,
        startDate: new Date(parsed.startEpoch * 1000).toISOString(),
        startEpochMs: parsed.startEpoch * 1000,
        endEpochMs: endDateMs,
        instrumentId,
        filePath: '',
        ticker,
        priceToBeat: cryptoMeta?.priceToBeat,
        _candidate: c,
      });
    }
    const pairMatcher = new MarketPairMatcher();
    const pairs = pairMatcher.findPairs(marketInfos);
    for (const pair of pairs) {
      if (pair.hard.endEpochMs <= nowMs + MIN_VIABLE_TRADING_MS) continue;
      const easyCandidate = marketInfos.find(m => m.instrumentId === pair.easy.instrumentId)?._candidate;
      const hardCandidate = marketInfos.find(m => m.instrumentId === pair.hard.instrumentId)?._candidate;
      if (!easyCandidate || !hardCandidate) continue;
      const opened = await openLiveArbPair(easyCandidate, hardCandidate);
      if (opened) return;
    }
    logger.warn('No live arb pairs found in discovery cache', {
      candidates: candidates.length,
      parsedInfos: marketInfos.length,
      pairsFound: pairs.length,
    });
  }

  /**
   * Закрывает живую арб-пару: отменяет ордера hard-слота через scheduler,
   * снимает WS/RTDS подписки, удаляет из каталогов.
   *
   * @param pairId - Идентификатор пары из `liveActiveArbPairs`
   * @param reason - Причина закрытия: 'EXPIRED' | 'SHUTDOWN'
   *
   * @remarks
   * Для hard-слота делегирует в `rotation.closeMarket()` — он отменяет ордера
   * (через `engine.scheduler.unregister`), запускает settlement и удаляет слот
   * из `activeMarkets`. Для остальных токенов (easy up/down, hard down) выполняет
   * WS-отписку и очистку `marketCatalog` вручную.
   */
  async function closeLiveArbPair(pairId: string, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const pair = liveActiveArbPairs.get(pairId);
    if (!pair) return;

    const durMs = Date.now() - pair.openedAtMs;
    const durMin = Math.floor(durMs / 60_000);
    const durSec = Math.floor((durMs % 60_000) / 1000);
    const metrics = pair.strategy.getMetrics() as Record<string, unknown>;
    const bestObserved = metrics['bestObserved'] as Record<string, unknown> | null | undefined;
    const auditEventCounts = metrics['auditEventCounts'] as Record<string, unknown> | undefined;
    const assignment = metrics['assignment'] ?? 'unknown';
    const strikeEasyMarket = assignment === 'SLOT_IS_EASY' ? pair.hardQuestion : pair.easyQuestion;
    const strikeHardMarket = assignment === 'SLOT_IS_EASY' ? pair.easyQuestion : pair.hardQuestion;
    const fmtN = (v: unknown, d: number): string | null =>
      typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : null;
    logger.warn('=== Live arb pair summary ===', {
      pairId,
      longWindowMarket: pair.easyQuestion,
      shortWindowMarket: pair.hardQuestion,
      strikeEasyMarket,
      strikeHardMarket,
      duration: `${durMin}m${durSec}s`,
      assignment,
      ticks: metrics['tickCount'] ?? 0,
      divergences: metrics['divergenceCount'] ?? 0,
      trades: metrics['tradeCount'] ?? 0,
      acceptedSettlementFaceValue: fmtN(metrics['acceptedSettlementFaceValue'], 4),
      acceptedPlannedCost: fmtN(metrics['acceptedPlannedCost'], 4),
      acceptedPlannedFees: fmtN(metrics['acceptedPlannedFees'], 4),
      acceptedPlannedAllInCost: fmtN(metrics['acceptedPlannedAllInCost'], 4),
      actualNotional: fmtN(metrics['actualNotional'], 4),
      actualFees: fmtN(metrics['actualFees'], 4),
      actualConservativePnl: fmtN(metrics['actualConservativePnl'], 4),
      unhedgedExecutionCount: metrics['unhedgedExecutionCount'] ?? 0,
      failedRepairCount: metrics['failedRepairCount'] ?? 0,
      repairStateCounts: metrics['repairStateCounts'] ?? {},
      freshEvaluations: metrics['freshEvaluations'] ?? 0,
      grossCrossSamples: metrics['grossCrossSamples'] ?? 0,
      netSignalSamples: metrics['netSignalSamples'] ?? 0,
      skipMissingBook: auditEventCounts?.['SKIP_MISSING_BOOK'] ?? 0,
      skipStaleBook: auditEventCounts?.['SKIP_STALE_BOOK'] ?? 0,
      noSignal: auditEventCounts?.['NO_SIGNAL'] ?? 0,
      skipCapacity: auditEventCounts?.['SKIP_CAPACITY'] ?? 0,
      skipBalance: auditEventCounts?.['SKIP_BALANCE'] ?? 0,
      signalAccepted: auditEventCounts?.['SIGNAL_ACCEPTED'] ?? 0,
      bestObservedAt: bestObserved?.['observedAt'] ?? null,
      bestObservedPnlPerUnit: fmtN(bestObserved?.['pnlPerUnit'], 5),
      bestObservedCostPerUnit: fmtN(bestObserved?.['costPerUnit'], 5),
      bestObservedFeePerUnit: fmtN(bestObserved?.['feePerUnit'], 5),
      bestObservedSize: bestObserved?.['execSize'] ?? null,
      bestObservedExecutableCost: typeof bestObserved?.['costPerUnit'] === 'number' && typeof bestObserved?.['execSize'] === 'number'
        ? ((bestObserved['costPerUnit'] as number) * (bestObserved['execSize'] as number)).toFixed(4)
        : null,
      bestObservedPotentialPnl: typeof bestObserved?.['pnlPerUnit'] === 'number' && typeof bestObserved?.['execSize'] === 'number'
        ? ((bestObserved['pnlPerUnit'] as number) * (bestObserved['execSize'] as number)).toFixed(4)
        : null,
      bestObservedEasyAgeMs: bestObserved?.['easyBookAgeMs'] ?? null,
      bestObservedHardAgeMs: bestObserved?.['hardBookAgeMs'] ?? null,
      estimatedPnl: typeof metrics['totalPnlEstimate'] === 'object'
        ? (metrics['totalPnlEstimate'] as { toFixed: (n: number) => string }).toFixed(4)
        : String(metrics['totalPnlEstimate'] ?? 0),
      longWindowStrike: pair.easyStrikeLocked ? 'set' : 'pending',
      shortWindowStrike: pair.hardStrikeLocked ? 'set' : 'pending',
      reason,
    });

    logger.info('Closing live arb pair', { pairId, reason });

    // Hard-слот — полный teardown через rotation (cancel orders, settlement, activeMarkets.delete)
    if (activeMarkets.has(pair.hardUpTokenIdStr)) {
      await rotation.closeMarket(pair.hardUpTokenIdStr, reason);
    }

    // Easy UP + Down, Hard Down — WS-отписка и marketCatalog
    await marketWsAdapter.unsubscribeFromToken(pair.easyTokenIdStr);
    await marketWsAdapter.unsubscribeFromToken(pair.hardDownTokenIdStr);
    if (pair.easyDownTokenIdStr) await marketWsAdapter.unsubscribeFromToken(pair.easyDownTokenIdStr);

    marketCatalog.remove(pair.easyInstrumentId);
    marketCatalog.remove(pair.hardDownInstrumentId);
    if (pair.easyDownInstrumentId) marketCatalog.remove(pair.easyDownInstrumentId);

    // activeCompTokens cleanup
    activeCompTokens.delete(pair.easyTokenIdStr);
    activeCompTokens.delete(pair.hardDownTokenIdStr);
    if (pair.easyDownTokenIdStr) activeCompTokens.delete(pair.easyDownTokenIdStr);

    // RTDS unsubscribe — только если другие активные пары не используют тот же topic
    for (const meta of [pair.easyCryptoMeta, pair.hardCryptoMeta]) {
      if (!meta) continue;
      const stillUsed = Array.from(liveActiveArbPairs.values()).some(
        p => p.pairId !== pairId && (
          p.easyCryptoMeta?.rtdsTopic === meta.rtdsTopic ||
          p.hardCryptoMeta?.rtdsTopic === meta.rtdsTopic
        ),
      );
      if (!stillUsed) liveRtdsClient.unsubscribe(meta.rtdsTopic, meta.rtdsFilter);
    }

    liveActiveArbPairs.delete(pairId);
    logger.info('Live arb pair closed', { pairId, reason, activePairs: liveActiveArbPairs.size });
  }

  const bookRegistry = new SimpleBookRegistry();
  const bookUpdateHandler = new BookUpdateHandler(bookRegistry, eventBus, marketCatalog, logger);
  const marketDataFeedAdapter = new MarketDataFeedAdapter(marketWsAdapter, bookUpdateHandler, logger);

  // Recording: подключаем запись всех сырых WS-сообщений
  recording?.wireToWs(marketWsAdapter);
  recording?.wireToEventBus(eventBus, (asset) => {
    const iId = assetIdToInstrumentId(asset as Parameters<typeof assetIdToInstrumentId>[0]);
    return iId ? String(iId) : undefined;
  });

  // Trade bridge — публичные трейды → TRADE_RECEIVED (для tape-based аналитики)
  // Фильтруем трейды по активным рынкам и комплементарным токенам (для dual-token стратегий)
  marketWsAdapter.onTradeEvent(async (dto) => {
    if (!activeMarkets.has(dto.asset_id) && !activeCompTokens.has(dto.asset_id)) return;
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


  // ── Ротация рынков — управляется через MarketRotation ──────────────────
  // registerMarketAndStrategy, openMarket, closeMarket, fillMarketSlots,
  // checkExpiredMarkets, scheduleScanLoop, printMarketSummary — все в rotation.
  rotation.registerFillTracking();


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
    getTokenLabel: (asset: unknown) => {
      const iId = assetIdToInstrumentId(asset as Parameters<typeof assetIdToInstrumentId>[0]);
      if (!iId) return undefined;
      const tokenIdStr = String(iId);
      if (activeMarkets.has(tokenIdStr)) return 'UP';
      if (activeCompTokens.has(tokenIdStr)) return 'DOWN';
      return undefined;
    },
  });

  // ── Startup: баланс с биржи + сверка ордеров ─────────────────────────────

  logger.info('Starting: fetching balance from exchange + order reconciliation');
  const initResult = await liveInfra.initializePortfolioUseCase.execute(accountId);
  if (!initResult.ok) {
    logger.error('Portfolio initialization failed — starting with zero balance', {
      error: initResult.error.message,
    });
    const fallbackBalance = buildInitialBalance(0, accountId);
    const portfolioResult = Portfolio.create({
      id: asPortfolioId(`portfolio:${config.account.accountId}`),
      accountId,
      balance: fallbackBalance,
    });
    if (portfolioResult.ok) portfolioStore.save(portfolioResult.value, 0);
  } else {
    const portfolio = portfolioStore.get(accountId);
    if (portfolio) {
      logger.info('Portfolio initialised from exchange balance', {
        usdc: portfolio.balance.available().value().toFixed(2),
      });
    }
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

  if (isLiveArbMode) {
    await fillLiveArbSlots();
    if (activeMarkets.size === 0) {
      logger.fatal('No live arb pairs found matching discovery filter at startup');
      process.exit(1);
    }
  }

  // Регистрируем все начальные слоты (arb-режим: регистрация уже сделана внутри openLiveArbPair)
  if (!isLiveArbMode) {
    for (const slot of activeMarkets.values()) {
      const ok = await rotation.registerMarketAndStrategy(slot);
      if (!ok) {
        logger.fatal('Failed to register initial strategy', { marketId: String(slot.marketId) });
        process.exit(1);
      }
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

  // Подключаемся к RTDS для крипто-цен (live)
  // В arb-режиме всегда подключаемся — крипто-подписки уже сделаны в openLiveArbPair
  const liveHasCryptoMarkets = isLiveArbMode || Array.from(activeMarkets.values()).some(s => s.cryptoMeta !== undefined);
  if (liveHasCryptoMarkets) {
    try {
      await liveRtdsClient.connect();
    } catch (err) {
      logger.warn('Failed to connect to RTDS, crypto prices unavailable', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
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

  // ── Периодическая синхронизация USDC-баланса с venue ──────────────────
  // Каждые 60 секунд запрашиваем актуальный баланс с venue (REST API).
  // Учитывает settled позиции (claim) и внешние зачисления.
  // Не трогает reserved — только корректирует available при расхождении.

  const BALANCE_SYNC_INTERVAL_MS = 60_000;
  const balanceSyncIntervalId = setInterval(() => {
    void (async () => {
      try {
        const venueBalance = await liveInfra.currentBalanceProvider.getUsdcBalance(accountId);
        const portfolio = portfolioStore.get(accountId);
        if (!portfolio) return;

        const localAvailable = portfolio.balance.available().value();
        const localReserved = portfolio.balance.reserved().value();
        // Venue возвращает total available (не включает reserved в ордерах).
        // Наш local total = available + reserved.
        // Если venue total > local available → зачислились средства (settlement/deposit).
        // Корректируем: new_available = venue_balance - local_reserved
        const expectedAvailable = venueBalance.minus(localReserved);
        const diff = expectedAvailable.minus(localAvailable);

        // Порог: игнорируем расхождения < 0.01 USDC (dust)
        if (diff.abs().lte('0.01')) return;

        const version = portfolioStore.getVersion?.(accountId) ?? 0;

        if (diff.gt(0)) {
          // Venue показывает больше → зачислились средства (settlement, deposit)
          const creditResult = portfolio.applyCredit(Money.of(diff, 'USDC'));
          if (creditResult.ok) {
            const saveRes = portfolioStore.save(creditResult.value, version);
            if (saveRes.ok) {
              logger.info('Balance synced from venue: credited', {
                venueTotalUsdc: venueBalance.toFixed(2),
                localAvailable: localAvailable.toFixed(2),
                localReserved: localReserved.toFixed(2),
                credited: diff.toFixed(2),
                newAvailable: expectedAvailable.toFixed(2),
              });
            } else {
              logger.debug('Balance sync credit: version conflict (will retry next cycle)', {
                diff: diff.toFixed(2),
              });
            }
          }
        } else {
          // Venue показывает меньше → local portfolio завышен.
          // Причины: fill cost не списался (version conflict в applyFill),
          // или venue ещё не обновился после settlement/deposit.
          //
          // Корректируем прямой установкой available = venue - reserved,
          // но только если нет открытых ордеров (reserved=0) — иначе venue
          // не учитывает in-flight fills и корректировать рано.
          if (localReserved.isZero()) {
            const debitResult = portfolio.applyDirectDebit(Money.of(diff.abs(), 'USDC'));
            if (debitResult.ok) {
              const saveRes = portfolioStore.save(debitResult.value, version);
              if (saveRes.ok) {
                logger.warn('Balance synced from venue: debited (local was inflated)', {
                  venueTotalUsdc: venueBalance.toFixed(2),
                  localAvailable: localAvailable.toFixed(2),
                  debited: diff.abs().toFixed(2),
                  newAvailable: expectedAvailable.toFixed(2),
                });
              }
            }
          } else {
            logger.debug('Balance sync: venue < local, skipping (has reserved)', {
              venueTotalUsdc: venueBalance.toFixed(2),
              localAvailable: localAvailable.toFixed(2),
              localReserved: localReserved.toFixed(2),
              diff: diff.toFixed(2),
            });
          }
        }
      } catch (err) {
        logger.debug('Balance sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, BALANCE_SYNC_INTERVAL_MS);

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

  /* TOKEN_BALANCE_SYNC — DISABLED (interval was 30_000ms)
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
    strategy: config.strategyRules?.length ? 'multi-strategy' : config.strategy,
    ...(config.strategyRules?.length ? { rules: config.strategyRules.map(r => r.label) } : {}),
    strategyIds: activeSlotIds,
    activeSlots: activeMarkets.size,
    maxConcurrentMarkets,
    source: config.market.source,
    reconcileIntervalSec: RECONCILE_INTERVAL_MS / 1000,
    // tokenBalanceSyncSec: TOKEN_BALANCE_SYNC_INTERVAL_MS / 1000, // DISABLED
  });

  // ── Ротация рынков (только для discovery) ────────────────────────────────

  if (rotation.discoveryAdapter) {
    if (!isLiveArbMode) {
      rotation.startExpiryCheck();
      void rotation.scheduleScanLoop();

      if (maxConcurrentMarkets > 1) {
        void rotation.fillMarketSlots();
      }
    }

    const mc = config.market as import('./config/BotConfig.js').DiscoveryMarketConfig;
    logger.info('Market rotation enabled', {
      expiryCheckMs: 5_000,
      scanPauseMs: mc.scanPauseMs ?? 60_000,
      maxConcurrentMarkets,
      arbMode: isLiveArbMode,
    });
  }

  // ── Live arb expiry monitoring ────────────────────────────────────────────
  // Проверяем expiry каждые 5s; при истечении закрываем пару и ищем новую.
  // Статус-лог — каждые ~30s (6 × 5s тиков).

  let _liveArbExpiryIntervalId: ReturnType<typeof setInterval> | undefined;
  if (isLiveArbMode) {
    const CANCEL_BEFORE_EXPIRY_MS = 5_000;
    let _liveArbRotationInProgress = false;
    let _liveArbStatusCounter = 0;

    _liveArbExpiryIntervalId = setInterval(() => {
      if (rotation.isShuttingDown || _liveArbRotationInProgress) return;
      _liveArbRotationInProgress = true;
      void (async () => {
        try {
          const nowMs = Date.now();

          // Статус-лог каждые ~30с
          if (++_liveArbStatusCounter % 6 === 0) {
            for (const pair of liveActiveArbPairs.values()) {
              const hardSlot = activeMarkets.get(pair.hardUpTokenIdStr);
              const metrics = hardSlot?.strategy?.getMetrics?.() as Record<string, unknown> | undefined;
              const assignment = (metrics?.['assignment'] ?? null) as 'SLOT_IS_EASY' | 'PEER_IS_EASY' | null;

              // Читаем все четыре книги: peer_UP, peer_DOWN, slot_UP, slot_DOWN
              const peerUpBook   = marketDataStore.getTopOfBook(pair.easyInstrumentId);
              const slotDownBook = marketDataStore.getTopOfBook(pair.hardDownInstrumentId);
              const slotUpBook   = marketDataStore.getTopOfBook(pair.hardUpInstrumentId);
              const peerDownBook = pair.easyDownInstrumentId
                ? marketDataStore.getTopOfBook(pair.easyDownInstrumentId)
                : undefined;

              // Реальные ноги зависят от assignment:
              //   PEER_IS_EASY → buy peer_UP + slot_DOWN  (нормальное направление UP)
              //   SLOT_IS_EASY → buy slot_UP + peer_DOWN  (обратное направление DOWN)
              //   null         → ещё не определено
              let leg1Ask: number | null = null;
              let leg2Ask: number | null = null;
              let leg1Label: string;
              let leg2Label: string;

              if (assignment === 'SLOT_IS_EASY') {
                // slot_UP ask: читаем напрямую или считаем как 1 - slot_DOWN bid
                leg1Ask = slotUpBook?.bestAsk?.value().toNumber()
                  ?? (slotDownBook?.bestBid?.value().toNumber() != null
                    ? 1 - slotDownBook!.bestBid!.value().toNumber()
                    : null);
                // peer_DOWN ask: читаем напрямую или считаем как 1 - peer_UP bid
                leg2Ask = peerDownBook?.bestAsk?.value().toNumber()
                  ?? (peerUpBook?.bestBid?.value().toNumber() != null
                    ? 1 - peerUpBook!.bestBid!.value().toNumber()
                    : null);
                leg1Label = 'slotUpAsk';
                leg2Label = 'peerDownAsk';
              } else {
                // PEER_IS_EASY или null — показываем стандартное направление
                leg1Ask = peerUpBook?.bestAsk?.value().toNumber() ?? null;
                leg2Ask = slotDownBook?.bestAsk?.value().toNumber() ?? null;
                leg1Label = 'peerUpAsk';
                leg2Label = 'slotDownAsk';
              }

              const grossSpread = leg1Ask !== null && leg2Ask !== null
                ? (1 - leg1Ask - leg2Ask).toFixed(4)
                : null;

              const ttlSec = Math.max(0, Math.round((pair.expiresAtMs - nowMs) / 1000));
              const auditCounts = metrics?.['auditEventCounts'] as Record<string, number> | undefined;
              const hardStartsInSec = pair.hardStrikeLocked
                ? null
                : pair.hardStartMs > 0
                  ? Math.max(0, Math.round((pair.hardStartMs - nowMs) / 1000))
                  : null;

              logger.info('Live arb pair status', {
                pairId: pair.pairId,
                ttlSec,
                ticks: metrics?.['tickCount'] ?? 0,
                divergences: metrics?.['divergenceCount'] ?? 0,
                trades: metrics?.['tradeCount'] ?? 0,
                // direction-aware legs
                direction: assignment === 'SLOT_IS_EASY' ? 'DOWN' : assignment === 'PEER_IS_EASY' ? 'UP' : null,
                [leg1Label]: leg1Ask?.toFixed(4) ?? '-',
                [leg2Label]: leg2Ask?.toFixed(4) ?? '-',
                grossSpread,
                // raw books для диагностики
                peerUpBid: peerUpBook?.bestBid?.value().toFixed(4) ?? '-',
                peerUpAsk: peerUpBook?.bestAsk?.value().toFixed(4) ?? '-',
                slotDownBid: slotDownBook?.bestBid?.value().toFixed(4) ?? '-',
                slotDownAsk: slotDownBook?.bestAsk?.value().toFixed(4) ?? '-',
                // strike/assignment state
                assignment,
                easyStrikeLocked: pair.easyStrikeLocked,
                hardStrikeLocked: pair.hardStrikeLocked,
                slotStrike: (metrics?.['slotStrike'] as number | null | undefined) ?? null,
                peerStrike: (metrics?.['peerStrike'] as number | null | undefined) ?? null,
                hardStartsInSec,
                skipStale: auditCounts?.['SKIP_STALE_BOOK'] ?? 0,
                skipMissing: auditCounts?.['SKIP_MISSING_BOOK'] ?? 0,
                noSignal: auditCounts?.['NO_SIGNAL'] ?? 0,
                auditMode: metrics?.['auditMode'] ?? false,
              });
            }
          }

          // Expiry check
          const expiredPairIds = [...liveActiveArbPairs.values()]
            .filter(p => p.expiresAtMs - nowMs <= CANCEL_BEFORE_EXPIRY_MS)
            .map(p => p.pairId);

          for (const expiredPairId of expiredPairIds) {
            await closeLiveArbPair(expiredPairId, 'EXPIRED');
          }

          if (expiredPairIds.length > 0) {
            await fillLiveArbSlots();
          }
        } finally {
          _liveArbRotationInProgress = false;
        }
      })();
    }, 5_000);
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (rotation.isShuttingDown) return;
    rotation.isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    rotation.stopTimers();
    clearInterval(reconcileIntervalId);
    clearInterval(balanceSyncIntervalId);
    if (_liveArbExpiryIntervalId !== undefined) clearInterval(_liveArbExpiryIntervalId);
    // clearInterval(tokenBalanceSyncId); // DISABLED — token balance sync
    autoRedeemer?.stop();

    try {
      if (isLiveArbMode) {
        for (const pairId of [...liveActiveArbPairs.keys()]) {
          await closeLiveArbPair(pairId, 'SHUTDOWN');
        }
      } else {
        // Закрываем все активные слоты через rotation
        for (const tokenIdStr of [...activeMarkets.keys()]) {
          await rotation.closeMarket(tokenIdStr, 'SHUTDOWN');
        }
      }

      engine.scheduler.stop();
      engine.orderEventBridge.stop();
      fillOrchestrator.unregister();
      liveInfra.userEventFeedAdapter.stop();
      marketDataFeedAdapter.stop();
      await marketWsAdapter.disconnect();
      await userWsAdapter.disconnect();
      liveRtdsClient.disconnect();
      await liveCexService?.stop();
      marketDataStore.stop();
      await recording?.close();
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

function createBotCexService(
  botConfig: BotConfig,
  logger: ILogger,
  cryptoMarketDataStore: CryptoMarketDataStore,
  recording?: RecordingInfra,
): CexCollectorService | null {
  const cexConfig = botConfig.cex;
  if (!cexConfig?.enabled) return null;

  const outputDir = cexConfig.outputDir
    ?? (botConfig.recording?.enabled ? botConfig.recording.outputDir : undefined);

  const collectorConfig: CexCollectorConfig = {
    exchanges: cexConfig.exchanges,
    outputDir,
    compression: cexConfig.compression ?? botConfig.recording?.compression ?? 'gzip',
    windowMinutes: cexConfig.windowMinutes,
    bufferSize: cexConfig.bufferSize,
    flushIntervalMs: cexConfig.flushIntervalMs,
    sinks: [
      (event) => routeCexEventToCryptoStore(event, cryptoMarketDataStore),
      ...(recording ? [(event: CexNormalizedEvent) => recording.recordCexEvent(event)] : []),
    ],
  };

  logger.info('CEX feed configured for bot', {
    exchanges: Object.keys(cexConfig.exchanges),
    memorySink: true,
    snapshotRecording: recording !== undefined,
    diskRecording: outputDir !== undefined,
    outputDir: outputDir ?? '-',
  });

  return new CexCollectorService(collectorConfig, logger);
}

function routeCexEventToCryptoStore(
  event: CexNormalizedEvent,
  store: CryptoMarketDataStore,
): void {
  const venue = toStoreCexVenue(event.venue);
  if (!venue) return;

  if (event.t === 'cex_ob') {
    store.updateCexBook({
      venue,
      symbol: event.symbol,
      exchangeTsMs: event.exchangeTs,
      receivedTsMs: event.receivedTs,
      bids: event.bids,
      asks: event.asks,
    });
    return;
  }

  store.updateCexTrade({
    venue,
    symbol: event.symbol,
    exchangeTsMs: event.exchangeTs,
    receivedTsMs: event.receivedTs,
    price: event.price,
    size: event.size,
    side: event.side,
  });
}

function toStoreCexVenue(venue: string): StoreCexVenue | undefined {
  if (
    venue === 'binance' ||
    venue === 'coinbase' ||
    venue === 'okx' ||
    venue === 'cryptocom' ||
    venue === 'kraken'
  ) {
    return venue;
  }
  return undefined;
}

/**
 * Строит RiskParams с параметрами по умолчанию для paper/backtest режима.
 *
 * @returns Параметры риск-контроля
 */
/**
 * Строит параметры risk-чека на основе конфигурации бота.
 *
 * @param config - Конфигурация бота (стратегия + ресурсы)
 * @returns RiskParams согласованные со стратегией
 *
 * @remarks
 * Параметры вычисляются из конфига, чтобы risk checker не конфликтовал со стратегией:
 * - `maxPositionSize` = qMax × orderSize (AS) или orderSize × 5 (dumb)
 * - `maxOrderNotional` = orderSize × 1 (максимальная стоимость одного ордера)
 * - `maxTotalExposure` = initialBalance × 2 (с запасом на нереализованные позиции)
 * - `minTimeToExpiryMs` = hardStopSec × 1000 (синхронизировано с hard stop стратегии)
 */
function buildRiskParams(config?: import('./config/BotConfig.js').BotConfig): RiskParams {
  const params = config?.strategyParams as unknown as Record<string, unknown> | undefined;
  if (config?.strategy === 'cross-market-arb') {
    const maxPositionUnits = typeof params?.['maxPositionUnits'] === 'number'
      ? (params['maxPositionUnits'] as number)
      : 5;
    const initialBalance = config.resources.initialBalance ?? 30;
    return {
      maxOpenOrders: 6,
      maxOrderNotional: new Decimal(initialBalance),
      maxPositionSize: new Decimal(maxPositionUnits),
      maxTotalExposure: new Decimal(initialBalance),
      minAvailableBalance: new Decimal('1'),
      minTimeToExpiryMs: 0,
    };
  }
  const orderSize = params?.['orderSize'] instanceof Decimal
    ? (params['orderSize'] as Decimal).toNumber()
    : 10;
  const qMax = typeof params?.['qMax'] === 'number' ? (params['qMax'] as number) : 5;
  const initialBalance = config?.resources.initialBalance ?? 100;

  return {
    maxOpenOrders: 2,
    maxOrderNotional: new Decimal(initialBalance),
    maxPositionSize: new Decimal(qMax * orderSize),
    maxTotalExposure: new Decimal(initialBalance * 2),
    minAvailableBalance: new Decimal('1'),
    // Стратегия сама управляет timing (unwind phase), risk checker не блокирует по времени
    minTimeToExpiryMs: 0,
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
 * Резолвит пути к снапшотам с поддержкой директорий и glob-like паттернов.
 *
 * @param patterns - Массив путей: конкретный файл, директория, или паттерн с `*`
 * @returns Отсортированный массив абсолютных путей к .jsonl/.jsonl.gz файлам
 *
 * @remarks
 * Поддерживает:
 * - Конкретный файл: `snapshots/2026-03-11/Bitcoin.jsonl.gz`
 * - Директория (все файлы): `snapshots/2026-03-11/` или `snapshots/2026-03-11/*`
 * - Рекурсивный обход: `snapshots/**` или `snapshots/`
 * Фильтрует только .jsonl и .jsonl.gz файлы, сортирует по имени.
 *
 * @example
 * ```typescript
 * const files = await resolveSnapshotPaths(['snapshots/2026-03-11/*']);
 * // → ['/.../Bitcoin_Up.jsonl.gz', '/.../Ethereum_Up.jsonl.gz']
 * ```
 */
async function resolveSnapshotPaths(patterns: string[]): Promise<string[]> {
  const results: string[] = [];
  const isSnapshotFile = (f: string) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz');

  for (const pattern of patterns) {
    // Паттерн с * → определяем директорию и рекурсивность
    if (pattern.includes('*')) {
      const recursive = pattern.includes('**');
      // Берём директорию как часть пути до последнего / перед первым *
      const firstStar = pattern.indexOf('*');
      const prefix = pattern.substring(0, firstStar);
      const lastSep = prefix.lastIndexOf(path.sep) >= 0 ? prefix.lastIndexOf(path.sep) : prefix.lastIndexOf('/');
      const dir = path.resolve(lastSep >= 0 ? prefix.substring(0, lastSep) : '.');
      if (!fs.existsSync(dir)) continue;
      const candidates: string[] = [];
      const patternRegex = globPatternToRegex(path.resolve(pattern));
      collectFiles(dir, recursive, candidates, isSnapshotFile);
      results.push(...candidates.filter(filePath => patternRegex.test(filePath)));
    } else {
      const resolved = path.resolve(pattern);
      if (!fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        // Директория → рекурсивно собираем файлы
        collectFiles(resolved, true, results, isSnapshotFile);
      } else if (isSnapshotFile(resolved)) {
        results.push(resolved);
      }
    }
  }

  results.sort();
  return results;
}

function globPatternToRegex(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join('/');
  let source = '^';

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  return new RegExp(`${source}$`);
}

/**
 * Рекурсивно собирает файлы из директории.
 *
 * @param dir - Путь к директории
 * @param recursive - Обходить поддиректории
 * @param out - Массив для результатов
 * @param filter - Фильтр по имени файла
 */
function collectFiles(
  dir: string,
  recursive: boolean,
  out: string[],
  filter: (f: string) => boolean,
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      collectFiles(full, recursive, out, filter);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && filter(full)) {
      out.push(full);
    }
  }
}

// readSnapshotMeta() извлечена в ./bot/readSnapshotMeta.ts

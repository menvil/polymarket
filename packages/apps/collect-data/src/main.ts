/**
 * Скрипт сбора рыночных данных Polymarket.
 *
 * @remarks
 * Автономный data-collector без торговой логики.
 * Подписывается на WS-события выбранных рынков и пишет снапшоты на диск.
 *
 * ### Алгоритм:
 * 1. Загрузить конфигурацию из .env
 * 2. Инициализировать DataRecorder, WS-адаптер, PolymarketMarketDiscoveryAdapter
 * 3. Начальный дискавери → зарегистрировать рынки + подписаться на WS
 * 4. Цикл пересканирования каждые `MARKET_SCAN_PAUSE_MS`:
 *    - Найти новые рынки → зарегистрировать + подписаться
 * 5. Цикл проверки истечений каждые 60 сек:
 *    - Финализировать истёкшие рынки → отписаться от WS
 * 6. Graceful shutdown (SIGINT / SIGTERM):
 *    - Остановить feed → закрыть recorder → отключить WS
 *
 * ### Запуск:
 * ```bash
 * # Dev (с hot-reload):
 * npm run dev
 *
 * # Production (после npm run build):
 * npm start
 * ```
 */

import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import { DataRecorder, NDJSONFormatter, GzipCompressor } from '@polymarket/data-collection';
import { PolymarketWebSocketManager } from '@polymarket/exchange/ws';
import { PolymarketWsAdapter } from '@polymarket/exchange/ws';
import { MarketDataFeedAdapter, PolymarketMarketDiscoveryAdapter, parseCryptoMeta, computeInterval, BinanceKlinesClient } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { DnsOverride } from '@polymarket/exchange/dns';
import { RtdsWebSocketClient } from '@polymarket/exchange/ws';
import type { DiscoveredMarket } from '@polymarket/ports';
import { loadConfig } from './config.js';

// ─── Запуск ──────────────────────────────────────────────────────────────────

const config = loadConfig();

const logLevelMap: Record<string, LogLevel> = {
  TRACE: LogLevel.TRACE,
  DEBUG: LogLevel.DEBUG,
  INFO:  LogLevel.INFO,
  WARN:  LogLevel.WARN,
  ERROR: LogLevel.ERROR,
  FATAL: LogLevel.FATAL,
};
const logLevel = logLevelMap[process.env['LOG_LEVEL'] ?? 'INFO'] ?? LogLevel.INFO;
const clock = new LiveClock();
const logger = new ColorConsoleLogger(clock, logLevel);

logger.info('Starting Polymarket data collector', {
  outputDir:   config.outputDir,
  maxMarkets:  config.maxMarkets,
  compression: config.compression,
  wsUrl:       config.wsUrl,
});

// ─── DNS Override ─────────────────────────────────────────────────────────────
// Опционально: патчим dns.lookup ДО любых сетевых вызовов.
// Включается через DNS_OVERRIDE_ENABLED=true в .env (для машин с заблокированным DNS).
// На серверах с нормальным DNS оставляем false — никаких изменений в поведении.
const dnsOverride = new DnsOverride(logger);
if (config.dnsOverrideEnabled) {
  try {
    await dnsOverride.install([
      'gamma-api.polymarket.com',
      'clob.polymarket.com',
      'data-api.polymarket.com',
      'ws-subscriptions-clob.polymarket.com',
      'ws-live-data.polymarket.com',
    ]);
  } catch (err) {
    logger.warn('DNS override install failed, continuing with system DNS', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
} else {
  logger.debug('DNS override disabled (DNS_OVERRIDE_ENABLED != true)');
}

// ─── Зависимости ──────────────────────────────────────────────────────────────

// DataRecorder: пишет сырые WS-события в NDJSON-файлы
const recorder = new DataRecorder(
  {
    outputDir:      config.outputDir,
    bufferSize:     config.bufferSize,
    flushIntervalMs: config.flushIntervalMs,
    compression:    config.compression,
  },
  new NDJSONFormatter(),
  config.compression === 'gzip' ? new GzipCompressor() : null,
  logger,
);

// WS-транспорт
const wsManager = new PolymarketWebSocketManager(
  { url: config.wsUrl, reconnectDelay: config.wsReconnectDelayMs },
  logger,
);
const ws = new PolymarketWsAdapter(wsManager, logger);

// Market feed: bookHandler = null (только WS lifecycle — reconnect, etc.)
const feed = new MarketDataFeedAdapter(ws, null, logger);

// Записываем сырые WS-сообщения в оригинальном wire-формате (до DTO-маппинга)
ws.onRawMessage((tokenId, rawMsg) => {
  recorder.recordEvent(tokenId, rawMsg);
});

// Market discovery: Gamma API → фильтрация → скоринг
const marketDataClient = new PolymarketMarketDataRestClient(
  { baseUrl: config.gammaApiBaseUrl },
  logger,
);

const filterConfig = {
  minTimeToExpiryHours: config.minTimeToExpiryHours,
  minSpread:            config.minSpread,
  minLiquidity:         config.minLiquidity,
  maxMarketsToReturn:   config.maxMarkets,
  requiredKeywords:     config.requiredKeywords,
  anyOfKeywords:        config.anyOfKeywords,
  excludedKeywords:     config.excludedKeywords,
};

const discovery = new PolymarketMarketDiscoveryAdapter(
  marketDataClient,
  new MarketFilter(),
  new MarketScorer(clock),
  filterConfig,
  logger,
);

// ─── RTDS (реал-тайм крипто-цены) ─────────────────────────────────────────────

const rtdsClient = new RtdsWebSocketClient(
  { url: 'wss://ws-live-data.polymarket.com' },
  logger,
);
const binanceClient = new BinanceKlinesClient(logger);

/**
 * RTDS symbol → Set<tokenId> для маршрутизации записи цен.
 *
 * @remarks
 * Set, а не одиночный tokenId: несколько рынков могут следить за одним символом
 * одновременно (BTC 430-445 и BTC 435-440). Каждый получает свою копию crypto_price.
 */
const symbolToTokenIds = new Map<string, Set<string>>();

// RTDS → recorder wiring: записываем крипто-цены в тот же .jsonl файл
// source определяем по формату символа: 'btc/usd' → chainlink, 'btcusdt' → binance
rtdsClient.onPrice((symbol, price, ts) => {
  const tokenIds = symbolToTokenIds.get(symbol);
  if (!tokenIds || tokenIds.size === 0) return;
  const source = symbol.includes('/') ? 'chainlink' : 'binance';
  for (const tokenId of tokenIds) {
    recorder.recordEvent(tokenId, { t: 'crypto_price', symbol, price, ts, source });
  }
});

// ─── Состояние ────────────────────────────────────────────────────────────────

/** tokenId → DiscoveredMarket для O(1) проверки подписан ли уже */
const subscribedTokens = new Map<string, DiscoveredMarket>();
/** marketId → DiscoveredMarket для проверки истечений */
const subscribedMarkets = new Map<string, DiscoveredMarket>();
/**
 * Рынки, постоянно закрытые как EXPIRED в рамках этой сессии.
 * Предотвращает повторную регистрацию рынков которые Gamma API
 * продолжает возвращать active=true даже после истечения.
 */
const closedMarkets = new Set<string>();
/** Отложенные таймеры запроса strike price (marketId → timer) */
const pendingStrikeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Хелперы ──────────────────────────────────────────────────────────────────

/**
 * Регистрирует новый рынок: recorder + WS subscription.
 *
 * @param candidate - Кандидат из PolymarketMarketDiscoveryAdapter
 *
 * @remarks
 * Пропускает рынки, которые:
 * - уже подписаны (`subscribedTokens`)
 * - закрыты как EXPIRED в этой сессии (`closedMarkets`)
 * - уже истекли по `expiresAt` (Gamma API может возвращать active=true для истёкших рынков)
 */
async function openMarket(candidate: DiscoveredMarket): Promise<void> {
  const marketKey = String(candidate.marketId);
  const upTokenId = String(candidate.instrumentId);

  if (subscribedTokens.has(upTokenId)) return; // уже подписаны

  // Рынок уже был закрыт как EXPIRED в этой сессии — не открываем снова.
  // Gamma API может продолжать возвращать active=true для истёкших рынков.
  if (closedMarkets.has(marketKey)) return;

  // Рынок уже истёк — пропускаем, чтобы не начинать запись данных которые
  // не успеют накопиться до истечения.
  if (candidate.expiresAt.toNumber() <= Date.now()) {
    logger.debug('Skipping already-expired market', {
      marketId: marketKey,
      question: candidate.question,
      expiresAt: new Date(candidate.expiresAt.toNumber()).toISOString(),
    });
    return;
  }

  // Все токены рынка (UP + DOWN если доступны, иначе только UP)
  const allTokenIds = candidate.allTokenIds?.length
    ? candidate.allTokenIds.map(String)
    : [upTokenId];

  // Помечаем токены ДО первого await — защита от race condition
  // при повторном вызове scanAndSubscribe() во время ожидания подписки.
  for (const tokenId of allTokenIds) {
    subscribedTokens.set(tokenId, candidate);
  }
  subscribedMarkets.set(marketKey, candidate);

  recorder.registerMarket({
    marketId:  candidate.marketId,
    question:  candidate.question,
    tokenIds:  allTokenIds,
    expiresAt: candidate.expiresAt,
    rawMarket: candidate.rawMarket,
  });

  for (const tokenId of allTokenIds) {
    await ws.subscribeToToken(tokenId);
  }

  // Подписка на RTDS для крипто-рынков + запись strike price
  const cryptoMeta = parseCryptoMeta(candidate.rawMarket);
  if (cryptoMeta) {
    // Подписываемся на ОБА topic (Binance + Chainlink) — RTDS может
    // отправлять цены на любой из них в зависимости от символа
    for (const sub of cryptoMeta.rtdsSubscriptions) {
      rtdsClient.subscribe(sub.topic, sub.filter);
      // Маппинг symbol → tokenIds для маршрутизации в recorder
      let ids = symbolToTokenIds.get(sub.filter);
      if (!ids) { ids = new Set(); symbolToTokenIds.set(sub.filter, ids); }
      ids.add(allTokenIds[0]!);
    }

    // Strike price = candle open на eventStartTime.
    // Свеча появляется на Binance только ПОСЛЕ eventStartTime,
    // поэтому запрашиваем с задержкой (eventStartTime + 5с).
    const delayMs = Math.max(0, cryptoMeta.eventStartTimeMs - Date.now()) + 5_000;
    const strikeMeta = { ...cryptoMeta };
    const strikeTokenId = allTokenIds[0]!;
    const strikeTimer = setTimeout(() => {
      void (async () => {
        try {
          const interval = computeInterval(strikeMeta.endDateMs - strikeMeta.eventStartTimeMs);
          const kline = await binanceClient.getKline(strikeMeta.binanceSymbol, strikeMeta.eventStartTimeMs, interval);
          recorder.recordEvent(strikeTokenId, {
            t: 'strike_price',
            ts: strikeMeta.eventStartTimeMs,
            symbol: strikeMeta.rtdsFilter,
            strikePrice: kline.open,
            binanceSymbol: strikeMeta.binanceSymbol,
            interval,
          });
          logger.info('Strike price recorded', {
            symbol: strikeMeta.rtdsFilter,
            strikePrice: kline.open,
            eventStartTime: new Date(strikeMeta.eventStartTimeMs).toISOString(),
          });
        } catch (err) {
          logger.warn('Failed to fetch strike price from Binance', {
            symbol: strikeMeta.binanceSymbol,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, delayMs);
    strikeTimer.unref();
    pendingStrikeTimers.set(marketKey, strikeTimer);

    logger.info('RTDS subscriptions added for crypto market', {
      subscriptions: cryptoMeta.rtdsSubscriptions.map((s) => `${s.topic}:${s.filter}`),
      source: cryptoMeta.source,
    });
  }

  logger.info('Market opened for collection', {
    question: candidate.question,
    marketId: marketKey,
    tokenIds: allTokenIds,
    expiresAt: new Date(candidate.expiresAt.toNumber()).toISOString(),
    isCrypto: !!cryptoMeta,
  });
}

/**
 * Финализирует истёкший рынок: сбрасывает буфер, сжимает файл, отписывается от WS.
 *
 * @param candidate - Ранее зарегистрированный рынок
 * @param reason - Причина закрытия
 *
 * @remarks
 * При `reason === 'EXPIRED'` рынок добавляется в `closedMarkets` —
 * постоянный blacklist для предотвращения повторной регистрации.
 */
async function closeMarket(candidate: DiscoveredMarket, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
  const marketKey  = String(candidate.marketId);

  // Отменяем отложенный запрос strike price если ещё не выполнен
  const strikeTimer = pendingStrikeTimers.get(marketKey);
  if (strikeTimer) { clearTimeout(strikeTimer); pendingStrikeTimers.delete(marketKey); }

  const allTokenIds = candidate.allTokenIds?.length
    ? candidate.allTokenIds.map(String)
    : [String(candidate.instrumentId)];

  for (const tokenId of allTokenIds) {
    subscribedTokens.delete(tokenId);
    await ws.unsubscribeFromToken(tokenId);
  }
  subscribedMarkets.delete(marketKey);

  // Записываем market_resolved для крипто-рынков при EXPIRED
  const closeCryptoMeta = parseCryptoMeta(candidate.rawMarket);
  if (closeCryptoMeta && reason === 'EXPIRED') {
    try {
      const interval = computeInterval(closeCryptoMeta.endDateMs - closeCryptoMeta.eventStartTimeMs);
      const kline = await binanceClient.getKline(closeCryptoMeta.binanceSymbol, closeCryptoMeta.eventStartTimeMs, interval);
      const outcome = kline.close >= kline.open ? 'UP' : 'DOWN';
      const winningTokenIndex = outcome === 'UP' ? 0 : 1;
      recorder.recordEvent(allTokenIds[0]!, {
        t: 'market_resolved',
        ts: closeCryptoMeta.endDateMs,
        symbol: closeCryptoMeta.rtdsFilter,
        strikePrice: kline.open,
        resolutionPrice: kline.close,
        outcome,
        winningTokenIndex,
      });
      logger.info('Market resolved event recorded', {
        symbol: closeCryptoMeta.rtdsFilter,
        strikePrice: kline.open,
        resolutionPrice: kline.close,
        outcome,
      });
    } catch (err) {
      logger.warn('Failed to record market_resolved event', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Удаляем tokenId из маппинга для каждой подписки
    // Если другие рынки ещё используют тот же символ — оставляем подписку
    for (const sub of closeCryptoMeta.rtdsSubscriptions) {
      const ids = symbolToTokenIds.get(sub.filter);
      if (ids) {
        ids.delete(allTokenIds[0]!);
        if (ids.size === 0) {
          symbolToTokenIds.delete(sub.filter);
          rtdsClient.unsubscribe(sub.topic, sub.filter);
        }
      }
    }
  }

  // Запоминаем рынок как постоянно закрытый при EXPIRED,
  // чтобы scanAndSubscribe не открыл его снова (Gamma API может
  // возвращать active=true ещё долго после истечения рынка).
  if (reason === 'EXPIRED') {
    closedMarkets.add(marketKey);
  }

  await recorder.finalizeMarket(candidate.marketId, reason);

  logger.info('Market closed', {
    question: candidate.question,
    marketId: marketKey,
    reason,
  });
}

// ─── Дискавери ────────────────────────────────────────────────────────────────

/**
 * Обновляет кэш кандидатов из Gamma API.
 *
 * @remarks
 * Независимый процесс — не знает о занятых/свободных слотах.
 * Просто запрашивает рынки, фильтрует, сортирует, кладёт 30 лучших в кэш.
 * Вызывается по таймеру (пауза 30с после завершения).
 */
async function refreshDiscoveryCache(): Promise<void> {
  logger.debug('Refreshing market discovery cache...');
  try {
    await discovery.refresh();
  } catch (err) {
    logger.error('Market discovery refresh failed', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Заполняет свободные слоты рынками из кэша дискавери.
 *
 * @remarks
 * Независимый процесс — не запускает новое сканирование.
 * Читает кэш, берёт первые N кандидатов которые ещё не подписаны.
 * Вызывается при старте и после закрытия истёкших рынков.
 */
async function fillMarketSlots(): Promise<void> {
  const remaining = config.maxMarkets - subscribedMarkets.size;
  if (remaining <= 0) return;

  let candidates: readonly DiscoveredMarket[];
  try {
    candidates = await discovery.findCandidates();
  } catch (err) {
    logger.error('Failed to read candidates from cache', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }

  let opened = 0;
  for (const candidate of candidates) {
    if (opened >= remaining) break;
    const tokenId   = String(candidate.instrumentId);
    const marketKey = String(candidate.marketId);

    if (subscribedTokens.has(tokenId)) continue;
    if (closedMarkets.has(marketKey)) continue;
    if (candidate.expiresAt.toNumber() <= Date.now()) continue;

    await openMarket(candidate);
    opened++;
  }

  if (opened > 0) {
    logger.info('Market slots filled from cache', {
      opened,
      total:      subscribedMarkets.size,
      maxMarkets: config.maxMarkets,
    });
  }
}

// ─── Проверка истечений ───────────────────────────────────────────────────────

/**
 * Проверяет истёкшие рынки и финализирует их.
 *
 * @remarks
 * Рынок считается истёкшим, когда `expiresAt <= Date.now()`.
 * Вызывается каждые 60 сек.
 */
async function checkExpiredMarkets(): Promise<void> {
  const nowMs = Date.now();
  const expired: DiscoveredMarket[] = [];

  for (const candidate of subscribedMarkets.values()) {
    if (candidate.expiresAt.toNumber() <= nowMs) {
      expired.push(candidate);
    }
  }

  for (const candidate of expired) {
    await closeMarket(candidate, 'EXPIRED');
  }

  if (expired.length > 0) {
    logger.info('Expired markets finalized', { count: expired.length });
    // Слоты освободились — берём замены из кэша (без нового API-запроса).
    await fillMarketSlots();
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;
let scanTimeoutId: ReturnType<typeof setTimeout> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  if (scanTimeoutId) { clearTimeout(scanTimeoutId); scanTimeoutId = null; }
  clearInterval(expiryInterval);

  feed.stop();

  // Финализируем все активные рынки (SHUTDOWN — не сжимаем)
  for (const candidate of [...subscribedMarkets.values()]) {
    try {
      await closeMarket(candidate, 'SHUTDOWN');
    } catch (err) {
      logger.warn('Error closing market on shutdown', {
        marketId: String(candidate.marketId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  await recorder.close();
  await ws.disconnect();
  rtdsClient.disconnect();
  dnsOverride.uninstall();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ─── Main ─────────────────────────────────────────────────────────────────────

// Удаляем незавершённые файлы от предыдущего запуска
await recorder.cleanup();

// Начальный дискавери до подключения WS (чтобы подписки были готовы):
// сначала заполняем кэш, потом берём рынки из кэша.
await refreshDiscoveryCache();
await fillMarketSlots();

// Подключаем WS и запускаем feed
// connect() может режектить при первоначальной ошибке TLS/сети —
// не падаем, BaseWebSocketTransport сам запустит авто-реконнект
try {
  await ws.connect();
} catch (err) {
  logger.warn('Initial WS connection failed, will retry automatically', {
    err: err instanceof Error ? err : new Error(String(err)),
  });
}
feed.start();

// Подключаем RTDS для крипто-цен
try {
  await rtdsClient.connect();
} catch (err) {
  logger.warn('Initial RTDS connection failed, crypto prices unavailable', {
    err: err instanceof Error ? err.message : String(err),
  });
}

logger.info('Feed started, collecting data', {
  markets: subscribedMarkets.size,
});

// Процесс 1: обновление кэша дискавери (пауза ПОСЛЕ завершения).
// Не знает о слотах — просто обновляет кэш каждые ~30с.
async function scheduleScanLoop(): Promise<void> {
  if (isShuttingDown) return;
  await refreshDiscoveryCache();
  if (!isShuttingDown) {
    scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, config.marketScanPauseMs);
  }
}
scanTimeoutId = setTimeout(() => { void scheduleScanLoop(); }, config.marketScanPauseMs);

// Процесс 2: закрытие истёкших + заполнение слотов из кэша (каждые 5 сек).
// Не знает о сканировании — только читает кэш и управляет слотами.
const expiryInterval = setInterval(() => {
  void checkExpiredMarkets();
}, 5_000);

logger.info('Collector running. Press Ctrl+C to stop.', {
  scanEveryMs:   config.marketScanPauseMs,
  expiryCheckMs: 5_000,
  outputDir:     config.outputDir,
});

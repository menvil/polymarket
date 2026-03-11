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
import { MarketDataFeedAdapter, PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { DnsOverride } from '@polymarket/exchange/dns';
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
const logger = new ColorConsoleLogger(new LiveClock(), logLevel);

logger.info('Starting Polymarket data collector', {
  outputDir:   config.outputDir,
  maxMarkets:  config.maxMarkets,
  compression: config.compression,
  wsUrl:       config.wsUrl,
});

// ─── DNS Override ─────────────────────────────────────────────────────────────
// Патчим dns.lookup ДО любых сетевых вызовов.
// Использует DoH через 1.1.1.1 (по IP, без DNS-резолвинга у провайдера).
// Работает прозрачно для fetch() и WebSocket — оба используют undici внутри.
const dnsOverride = new DnsOverride(logger);
try {
  await dnsOverride.install([
    'gamma-api.polymarket.com',
    'clob.polymarket.com',
    'data-api.polymarket.com',
    'ws-subscriptions-clob.polymarket.com',
  ]);
} catch (err) {
  logger.warn('DNS override install failed, continuing with system DNS', {
    err: err instanceof Error ? err.message : String(err),
  });
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
  minDailyVolume:       config.minDailyVolume,
  maxMarketsToReturn:   config.maxMarkets,
  requiredKeywords:     config.requiredKeywords,
  anyOfKeywords:        config.anyOfKeywords,
  excludedKeywords:     config.excludedKeywords,
};

const discovery = new PolymarketMarketDiscoveryAdapter(
  marketDataClient,
  new MarketFilter(),
  new MarketScorer(),
  filterConfig,
  logger,
);

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

  logger.info('Market opened for collection', {
    question: candidate.question,
    marketId: marketKey,
    tokenIds: allTokenIds,
    expiresAt: new Date(candidate.expiresAt.toNumber()).toISOString(),
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
  const allTokenIds = candidate.allTokenIds?.length
    ? candidate.allTokenIds.map(String)
    : [String(candidate.instrumentId)];

  for (const tokenId of allTokenIds) {
    subscribedTokens.delete(tokenId);
    await ws.unsubscribeFromToken(tokenId);
  }
  subscribedMarkets.delete(marketKey);

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
 * Сканирует рынки через Gamma API и открывает новые до maxMarkets.
 *
 * @remarks
 * Вызывается при старте и периодически каждые `marketScanPauseMs`.
 */
async function scanAndSubscribe(): Promise<void> {
  logger.debug('Scanning for markets...', { current: subscribedMarkets.size });

  let candidates: readonly DiscoveredMarket[];
  try {
    candidates = await discovery.findCandidates();
  } catch (err) {
    logger.error('Market discovery failed', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return;
  }

  const remaining = config.maxMarkets - subscribedMarkets.size;
  if (remaining <= 0) {
    logger.debug('Max markets reached, skipping scan', { maxMarkets: config.maxMarkets });
    return;
  }

  let opened = 0;
  for (const candidate of candidates) {
    if (opened >= remaining) break;
    const tokenId   = String(candidate.instrumentId);
    const marketKey = String(candidate.marketId);

    // Пропускаем уже подписанные, закрытые и истёкшие рынки
    // (дублируем проверки из openMarket чтобы не инкрементировать opened зря)
    if (subscribedTokens.has(tokenId)) continue;
    if (closedMarkets.has(marketKey)) continue;
    if (candidate.expiresAt.toNumber() <= Date.now()) continue;

    await openMarket(candidate);
    opened++;
  }

  logger.info('Scan complete', {
    found:      candidates.length,
    opened,
    total:      subscribedMarkets.size,
    maxMarkets: config.maxMarkets,
  });
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
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  clearInterval(scanInterval);
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
  dnsOverride.uninstall();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ─── Main ─────────────────────────────────────────────────────────────────────

// Удаляем незавершённые файлы от предыдущего запуска
await recorder.cleanup();

// Начальный дискавери до подключения WS (чтобы подписки были готовы)
await scanAndSubscribe();

// Подключаем WS и запускаем feed
// connect() может режектить при первоначальной ошибке TLS/сети —
// не падаем, BaseWebSocketTransport сам запустит авто-реконнект
try {
  await ws.connect();
} catch (err) {
  logger.warn('Initial WS connection failed, will retry automatically', {
    err: err instanceof Error ? err.message : String(err),
  });
}
feed.start();

logger.info('Feed started, collecting data', {
  markets: subscribedMarkets.size,
});

// Периодический ресканинг новых рынков
const scanInterval = setInterval(() => {
  void scanAndSubscribe();
}, config.marketScanPauseMs);

// Периодическая проверка истёкших рынков (каждые 60 сек)
const expiryInterval = setInterval(() => {
  void checkExpiredMarkets();
}, 60_000);

logger.info('Collector running. Press Ctrl+C to stop.', {
  scanEveryMs:   config.marketScanPauseMs,
  expiryCheckMs: 60_000,
  outputDir:     config.outputDir,
});

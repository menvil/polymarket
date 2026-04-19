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

import Decimal from 'decimal.js';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import { DataRecorder, NDJSONFormatter, GzipCompressor } from '@polymarket/data-collection';
import { PolymarketWebSocketManager } from '@polymarket/exchange/ws';
import { PolymarketWsAdapter } from '@polymarket/exchange/ws';
import { MarketDataFeedAdapter, PolymarketMarketDiscoveryAdapter, parseCryptoMeta } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { DnsOverride } from '@polymarket/exchange/dns';
import { RtdsWebSocketClient } from '@polymarket/exchange/ws';
import type { DiscoveredMarket } from '@polymarket/ports';
import type { MarketId } from '@polymarket/ids';
import { Timestamp } from '@polymarket/value-objects';
import { loadConfig } from './config.js';
import { CexCollectorService } from '@polymarket/cex-market-data';
import type { CexCollectorConfig } from '@polymarket/cex-market-data';

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
  cexEnabled:  config.cexConfig !== null,
});

// ─── CEX коллектор (опционально) ────────────────────────────────────────────
let cexService: CexCollectorService | null = null;

if (config.cexConfig) {
  try {
    const exchanges = JSON.parse(config.cexConfig) as CexCollectorConfig['exchanges'];
    const cexCollectorConfig: CexCollectorConfig = {
      exchanges,
      outputDir: config.outputDir,
      compression: config.compression,
    };
    cexService = new CexCollectorService(cexCollectorConfig, logger);
    logger.info('CEX collector configured', { exchanges: Object.keys(exchanges) });
    // Чистим артефакты от предыдущего краш-запуска до старта
    await cexService.cleanup();
    // Запускаем сразу — CEX независим от Polymarket инициализации
    cexService.start();
  } catch (err) {
    logger.error('Failed to parse CEX_CONFIG — CEX collector disabled', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

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
    sourceSubDir:   config.sourceSubDir,
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
/** marketId → timestamp закрытия (ms). Очищается периодически — записи старше 24ч удаляются. */
const closedMarkets = new Map<string, number>();
const CLOSED_MARKETS_TTL_MS = 24 * 60 * 60_000; // 24 часа

/**
 * Очередь отложенного обогащения meta: рынки ожидающие priceToBeat из API.
 *
 * @remarks
 * При EXPIRED крипто-рынок добавляется сюда вместо немедленного finalize.
 * Background таймер каждые 30 сек проверяет API — как только priceToBeat
 * появятся оба, обновляет meta и финализирует. По таймауту — финализируем
 * с тем что есть (бэктест fallback на Binance kline для недостающих).
 *
 * На каждом retry обновляем meta если появились новые данные.
 * При shutdown — финализируем pending как EXPIRED (архивируем с данными).
 */
interface PendingEnrichment {
  readonly marketId: MarketId;
  readonly slug: string;
  readonly symbol: string;
  readonly question: string;
  readonly startedAt: number;
  attempts: number;
  /** Последнее известное состояние — чтобы обновлять meta только при изменениях */
  lastPriceToBeat: number | undefined;
  lastFinalPrice: number | undefined;
}
const pendingEnrichment = new Map<string, PendingEnrichment>();
let enrichmentRun: Promise<void> | null = null;

const ENRICHMENT_MAX_WAIT_MS = 15 * 60_000; // 15 минут
const ENRICHMENT_INTERVAL_MS = 30_000;      // проверяем каждые 30 сек

/**
 * Проверяет pending enrichment очередь: re-fetch API, обновляет meta, финализирует.
 *
 * @remarks
 * Вызывается по таймеру каждые 30 сек. Для каждого pending рынка:
 * 1. Re-fetch Gamma API по slug
 * 2. Всегда перезаписываем первую строку файла свежими данными API
 * 3. Если ОБА поля (priceToBeat + finalPrice) есть → finalizeMarket (архив)
 * 4. Если timeout → finalizeMarket с тем что есть (бэктест fallback)
 */
async function processEnrichmentQueue(): Promise<void> {
  if (isShuttingDown) return;
  if (pendingEnrichment.size === 0) return;

  for (const [marketKey, pe] of [...pendingEnrichment]) {
    if (isShuttingDown) return;
    pe.attempts++;
    const elapsed = Date.now() - pe.startedAt;

    try {
      const updatedMarket = await marketDataClient.getMarketInfo(pe.slug);
      if (isShuttingDown) return;
      const updatedCrypto = parseCryptoMeta(updatedMarket as unknown as Record<string, unknown>);

      // Всегда перезаписываем meta свежими данными API
      await recorder.updateMarketMeta(
        pe.marketId,
        updatedMarket as unknown as Record<string, unknown>,
      );

      pe.lastPriceToBeat = updatedCrypto?.priceToBeat;
      pe.lastFinalPrice = updatedCrypto?.finalPrice;

      logger.debug('Enrichment meta updated', {
        symbol: pe.symbol,
        priceToBeat: pe.lastPriceToBeat,
        finalPrice: pe.lastFinalPrice,
        attempts: pe.attempts,
      });

      // Оба поля есть — финализируем (архивируем)
      if (pe.lastPriceToBeat !== undefined && pe.lastFinalPrice !== undefined) {
        await recorder.finalizeMarket(pe.marketId, 'EXPIRED');
        pendingEnrichment.delete(marketKey);
        logger.info('Market fully enriched and finalized', {
          question: pe.question,
          symbol: pe.symbol,
          priceToBeat: pe.lastPriceToBeat,
          finalPrice: pe.lastFinalPrice,
          attempts: pe.attempts,
          elapsedMs: elapsed,
        });
        continue;
      }
    } catch (err) {
      logger.debug('Enrichment re-fetch failed (will retry)', {
        slug: pe.slug,
        attempt: pe.attempts,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Timeout — финализируем с тем что есть
    if (elapsed >= ENRICHMENT_MAX_WAIT_MS) {
      await recorder.finalizeMarket(pe.marketId, 'EXPIRED');
      pendingEnrichment.delete(marketKey);
      logger.warn('Market finalized on timeout (incomplete enrichment)', {
        question: pe.question,
        symbol: pe.symbol,
        priceToBeat: pe.lastPriceToBeat,
        finalPrice: pe.lastFinalPrice,
        attempts: pe.attempts,
        elapsedMs: elapsed,
      });
    }
  }
}

function runEnrichmentQueueOnce(): void {
  if (enrichmentRun) return;
  enrichmentRun = processEnrichmentQueue()
    .catch((err) => {
      logger.warn('Enrichment queue pass failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      enrichmentRun = null;
    });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

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

  // startsAt = момент вызова openMarket() — начинаем запись СЕЙЧАС при переключении на рынок
  const startsAt = Timestamp.of(new Decimal(Date.now()));

  recorder.registerMarket({
    marketId:  candidate.marketId,
    question:  candidate.question,
    tokenIds:  allTokenIds,
    startsAt,
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

  const allTokenIds = candidate.allTokenIds?.length
    ? candidate.allTokenIds.map(String)
    : [String(candidate.instrumentId)];

  for (const tokenId of allTokenIds) {
    subscribedTokens.delete(tokenId);
    await ws.unsubscribeFromToken(tokenId);
  }
  subscribedMarkets.delete(marketKey);

  // Для крипто-рынков: убираем RTDS подписки
  const closeCryptoMeta = parseCryptoMeta(candidate.rawMarket);
  if (closeCryptoMeta) {
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
    closedMarkets.set(marketKey, Date.now());
  }

  if (reason === 'SHUTDOWN' || !closeCryptoMeta) {
    // SHUTDOWN: файлы удалит recorder.close() — здесь только снимаем подписки.
    // Не-крипто EXPIRED: финализируем сразу (нет нужды в обогащении).
    if (reason !== 'SHUTDOWN') {
      await recorder.finalizeMarket(candidate.marketId, reason);
    }
    logger.info('Market closed', { question: candidate.question, marketId: marketKey, reason });
    return;
  }

  // Крипто-рынок EXPIRED — откладываем finalize до получения priceToBeat.
  // Слот уже освобождён (subscribedMarkets.delete выше) → новые рынки открываются сразу.
  const slug = (candidate.rawMarket as Record<string, unknown>)?.['slug'] as string | undefined;
  if (!slug) {
    await recorder.finalizeMarket(candidate.marketId, reason);
    logger.info('Market closed (no slug for enrichment)', { marketId: marketKey });
    return;
  }

  pendingEnrichment.set(marketKey, {
    marketId: candidate.marketId,
    slug,
    symbol: closeCryptoMeta.rtdsFilter,
    question: candidate.question,
    startedAt: Date.now(),
    attempts: 0,
    lastPriceToBeat: undefined,
    lastFinalPrice: undefined,
  });
  logger.info('Market expired, waiting for priceToBeat enrichment', {
    question: candidate.question,
    marketId: marketKey,
    slug,
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

  const nowMs = Date.now();
  const MIN_TIME_TO_START_MS = 2 * 60_000; // минимум 2 минуты до начала рынка

  let opened = 0;
  for (const candidate of candidates) {
    if (opened >= remaining) break;
    const tokenId   = String(candidate.instrumentId);
    const marketKey = String(candidate.marketId);

    if (subscribedTokens.has(tokenId)) continue;
    if (closedMarkets.has(marketKey)) continue;

    const expiresAtMs = candidate.expiresAt.toNumber();
    if (expiresAtMs <= nowMs) continue; // уже истёк

    // Определяем длительность рынка из eventStartMs (если есть)
    // Для крипто-рынков это обычно 5 или 15 минут
    const durationMs = candidate.eventStartMs
      ? expiresAtMs - candidate.eventStartMs
      : 15 * 60_000; // fallback: 15 минут

    // Вычисляем примерное время начала: expiresAt - duration
    const estimatedStartMs = expiresAtMs - durationMs;
    const timeToStartMs = estimatedStartMs - nowMs;

    // Пропускаем рынки, которые уже начались или начнутся слишком скоро
    if (timeToStartMs < MIN_TIME_TO_START_MS) {
      logger.debug('Skipping market (already started or starts too soon)', {
        question: candidate.question,
        expiresAt: new Date(expiresAtMs).toISOString(),
        estimatedStart: new Date(estimatedStartMs).toISOString(),
        timeToStartMin: (timeToStartMs / 60_000).toFixed(1),
      });
      continue;
    }

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
let expiryInterval: ReturnType<typeof setInterval> | null = null;
let enrichmentInterval: ReturnType<typeof setInterval> | null = null;
let closedMarketsCleanupInterval: ReturnType<typeof setInterval> | null = null;
let memoryLogInterval: ReturnType<typeof setInterval> | null = null;
let expiryRunInProgress = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Удерживаем event loop живым пока идёт async cleanup.
  // Без этого Node.js может выйти сразу после очистки таймеров —
  // до того как file I/O в finalizeMarket успеет выполниться.
  const keepAlive = setInterval(() => {}, 500);

  logger.info(`Received ${signal}, shutting down...`);

  try {
    if (scanTimeoutId) { clearTimeout(scanTimeoutId); scanTimeoutId = null; }
    if (expiryInterval) { clearInterval(expiryInterval); expiryInterval = null; }
    if (enrichmentInterval) { clearInterval(enrichmentInterval); enrichmentInterval = null; }
    if (closedMarketsCleanupInterval) { clearInterval(closedMarketsCleanupInterval); closedMarketsCleanupInterval = null; }
    if (memoryLogInterval) { clearInterval(memoryLogInterval); memoryLogInterval = null; }

    // Сначала останавливаем ingestion новых данных, чтобы не было новых записей
    // в recorder пока завершаем pending enrichment и закрываем рынки.
    feed.stop();

    // Если enrichment-pass уже идёт в фоне, не конфликтуем с ним по тем же файлам.
    if (enrichmentRun) {
      try {
        await withTimeout(enrichmentRun, 15_000, 'in-flight enrichment pass');
      } catch (err) {
        logger.warn('Timed out waiting for in-flight enrichment pass during shutdown', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Pending enrichment рынки уже сняты с WS/RTDS, но их writer'ы остаются открыты.
    // На shutdown не архивируем их по одному: этот path может зависнуть внутри
    // finalizeMarket()/gzip и заблокировать весь shutdown. Вместо этого оставляем
    // удаление на общий recorder.close(), который закроет stream'ы и удалит все
    // незавершённые .jsonl файлы disk-scan'ом.
    if (pendingEnrichment.size > 0) {
      logger.info('Dropping pending enrichment on shutdown — incomplete files will be deleted by recorder.close()', {
        count: pendingEnrichment.size,
      });
      pendingEnrichment.clear();
    }

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

    const shutdownTasks: Array<Promise<void>> = [];

    if (cexService) {
      shutdownTasks.push((async () => {
        try {
          await withTimeout(cexService.stop(), 15_000, 'cexService.stop');
          logger.info('CEX service stop complete');
        } catch (err) {
          logger.warn('Error stopping CEX service', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      })());
    }

    shutdownTasks.push((async () => {
      try {
        await withTimeout(recorder.close(), 15_000, 'recorder.close');
        logger.info('Recorder close complete');
      } catch (err) {
        logger.warn('Error closing recorder', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })());

    await Promise.allSettled(shutdownTasks);

    try {
      await ws.disconnect();
    } catch (err) {
      logger.warn('Error disconnecting WS', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    rtdsClient.disconnect();
    dnsOverride.uninstall();
  } finally {
    clearInterval(keepAlive);
    logger.info('Shutdown complete');
    process.exit(exitCode);
  }
}

process.on('SIGINT',  () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

// Подавляем автоматический process.exit(1) от unhandled rejections во время shutdown.
// CcxtSymbolWatcher now consumes late watch rejections internally; this remains
// as a defensive shutdown guard for other background tasks.
process.on('unhandledRejection', (reason) => {
  logger.warn('Unhandled promise rejection (suppressed to allow clean shutdown)', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

// Если процесс падает через uncaughtException, обычный SIGINT/SIGTERM shutdown
// не запускается и незавершённые .jsonl останутся до следующего старта.
// Пытаемся выполнить тот же cleanup best-effort, затем выходим с code=1.
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception — attempting graceful shutdown', {
    err: error,
  });
  void shutdown('UNCAUGHT_EXCEPTION', 1);
});

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
expiryInterval = setInterval(() => {
  if (expiryRunInProgress) {
    logger.debug('Skipping expired markets check: previous run is still in progress');
    return;
  }

  expiryRunInProgress = true;
  void checkExpiredMarkets()
    .catch((err) => {
      logger.warn('Expired markets check failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    })
    .finally(() => {
      expiryRunInProgress = false;
    });
}, 5_000);

// Background enrichment: проверяем priceToBeat каждые 30 сек
enrichmentInterval = setInterval(() => {
  runEnrichmentQueueOnce();
}, ENRICHMENT_INTERVAL_MS);

// Периодический лог потребления памяти (каждую минуту).
// Помогает ловить утечки и видеть эффект плановых рестартов ccxt-инстансов.
// Дополнительно: по SIGUSR2 пишем heap snapshot в cwd для офлайн-анализа.
const MEMORY_LOG_INTERVAL_MS = 60_000;
const MB = 1024 * 1024;
memoryLogInterval = setInterval(() => {
  const m = process.memoryUsage();
  logger.info('Memory usage', {
    rssMb:          +(m.rss / MB).toFixed(1),
    heapUsedMb:     +(m.heapUsed / MB).toFixed(1),
    heapTotalMb:    +(m.heapTotal / MB).toFixed(1),
    externalMb:     +(m.external / MB).toFixed(1),
    arrayBuffersMb: +(m.arrayBuffers / MB).toFixed(1),
    markets:        subscribedMarkets.size,
    pendingEnrich:  pendingEnrichment.size,
  });
}, MEMORY_LOG_INTERVAL_MS);

process.on('SIGUSR2', () => {
  void (async () => {
    try {
      const { writeHeapSnapshot } = await import('v8');
      const file = `heap-${Date.now()}.heapsnapshot`;
      writeHeapSnapshot(file);
      logger.info('Heap snapshot written', { file });
    } catch (err) {
      logger.warn('Failed to write heap snapshot', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

// Очистка closedMarkets от записей старше 24ч (каждый час)
closedMarketsCleanupInterval = setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, closedAt] of closedMarkets) {
    if (now - closedAt >= CLOSED_MARKETS_TTL_MS) {
      closedMarkets.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logger.debug('Cleaned up stale closedMarkets entries', { removed, remaining: closedMarkets.size });
  }
}, 60 * 60_000);

logger.info('Collector running. Press Ctrl+C to stop.', {
  scanEveryMs:   config.marketScanPauseMs,
  expiryCheckMs: 5_000,
  outputDir:     config.outputDir,
});

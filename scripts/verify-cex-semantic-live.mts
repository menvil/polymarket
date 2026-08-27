/**
 * DEVELOPMENT-ONLY live-верификация CEX Semantic Adapter (MR-D).
 *
 * @remarks
 * Тонкий consumer уже существующей production-фабрики контура — собственной
 * composition, собственных source-ов и второго подключения к биржам здесь
 * НЕТ:
 *
 * ```text
 *            createDataCollector(...)          ← та же фабрика, что у production
 *                     ↓
 *        общий ExternalMessageBus
 *        ├── ExternalMessageRecorder            (уже внутри фабрики)
 *        └── CexSemanticAdapter                 ← добавляет этот скрипт
 *                     ↓
 *               тестовый EventBus
 *                     ↓
 *                 наблюдатель
 * ```
 *
 * Скрипт ТОЛЬКО конфигурирует, подписывается и печатает свидетельства. Он
 * не преобразует payload, не строит новую observability и не является
 * production-компонентом: `apps/collect-data` остаётся collect-only.
 *
 * Что доказывает прогон:
 * 1. запись сырых данных продолжает работать при живом semantic-адаптере;
 * 2. наблюдения стакана каждой биржи дают canonical `Orderbook<AssetPrice>`;
 * 3. лучшие цены raw-наблюдения и canonical-книги СОВПАДАЮТ точно;
 * 4. поля реальных сделок переносятся без выдумывания идентичности;
 * 5. одинаковый символ на разных биржах не делит состояние и нумерацию;
 * 6. состояние ограничено и освобождается явным cleanup.
 *
 * Биржи и пары — подмножество production-конфига коллектора
 * (`apps/collect-data/cex-config.json`). Polymarket-ingress выключен: MR-D
 * касается ТОЛЬКО CEX-границы, и лишний поток только зашумил бы
 * свидетельства (полный контур проверяет CHECKPOINT #2).
 *
 * Env-переменные:
 * - `CEX_SEMANTIC_MINUTES` — длительность прогона (default 6);
 * - `CEX_SEMANTIC_SAMPLES` — сколько сверок печатать на биржу (default 2).
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * npx tsx scripts/verify-cex-semantic-live.mts
 * ```
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConsoleLogger, LogLevel, type ILogger } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { EventBus } from '@polymarket/event-bus';
import type { EventBusEvent } from '@polymarket/event-bus';
import { CexSemanticAdapter } from '@polymarket/cex-semantic-adapter';
import { createDataCollector } from '@polymarket/collect-data/runtime';
import type { ContourMessage, DataCollectorConfig } from '@polymarket/collect-data/runtime';
import type { VenueId } from '@polymarket/ids';

const RUN_MINUTES = Number(process.env['CEX_SEMANTIC_MINUTES'] ?? '6');
const SAMPLES_PER_VENUE = Number(process.env['CEX_SEMANTIC_SAMPLES'] ?? '2');

/** Биржи прогона — подмножество production-конфига коллектора. */
const EXCHANGES = ['binance', 'okx', 'bybit', 'coinbase', 'kraken', 'cryptocom'] as const;

/**
 * Конфигурация verification-прогона (НЕ production defaults).
 *
 * @param runDir - Изолированный корень датасетов прогона
 * @returns Конфигурация production-фабрики контура
 *
 * @remarks
 * Polymarket-discovery отключён нулевым `maxMarkets`: MR-D проверяет
 * CEX-границу, и рынки предсказаний в свидетельствах не участвуют.
 * Плановый рестарт транспорта оставлен production-овским (15 минут) —
 * уменьшать его ради «красивого» прогона нельзя.
 */
function verificationConfig(runDir: string): DataCollectorConfig {
  return {
    outputDir: runDir,
    polymarket: {
      sourceSubDir: 'polymarket',
      bufferSize: 200,
      flushIntervalMs: 5_000,
      compression: 'gzip',
    },
    discovery: {
      filter: {
        minTimeToExpiryHours: 0,
        minSpread: 0,
        minLiquidity: 0,
        maxMarketsToReturn: 0,
        requiredKeywords: ['__cex_only_run__'],
        anyOfKeywords: [],
        excludedKeywords: [],
      },
    },
    collection: {
      maxMarkets: 0,
      minTimeToStartMs: 30_000,
      discoveryRefreshMs: 300_000,
      runtimeTickMs: 5_000,
    },
    finalization: { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 60_000 },
    cex: {
      sources: EXCHANGES.map((exchangeId) => ({
        exchangeId,
        marketType: 'spot' as const,
        symbols: ['BTC/USDT', 'ETH/USDT'],
        watchOrderbook: true,
        watchTrades: true,
        orderbookDepth: exchangeId === 'bybit' ? 50 : 10,
        restartIntervalMs: 900_000,
        orderbookMethod: 'watch' as const,
      })),
      bufferSize: 200,
      flushIntervalMs: 2_000,
      compression: 'gzip',
    },
  };
}

/** Свидетельства по одной бирже. */
interface VenueEvidence {
  rawBooks: number;
  rawTrades: number;
  semanticDepth: number;
  semanticUpdated: number;
  semanticTrades: number;
  instruments: Set<string>;
  maxSequence: number;
}

/** Сверка «сырое наблюдение против canonical книги». */
interface BookParity {
  readonly venueId: string;
  readonly instrumentId: string;
  readonly rawBestBid: string;
  readonly rawBestAsk: string;
  readonly canonicalBestBid: string;
  readonly canonicalBestAsk: string;
  readonly match: boolean;
}

/** Сверка «сырая сделка против canonical события». */
interface TradeParity {
  readonly venueId: string;
  readonly rawId: string;
  readonly canonicalId: string;
  readonly rawPrice: string;
  readonly canonicalPrice: string;
  readonly rawAmount: string;
  readonly canonicalAmount: string;
  readonly rawSide: string;
  readonly canonicalSide: string;
  readonly rawTs: string;
  readonly canonicalTs: string;
  readonly match: boolean;
}

/** Пустая запись свидетельств биржи. */
function emptyEvidence(): VenueEvidence {
  return {
    rawBooks: 0,
    rawTrades: 0,
    semanticDepth: 0,
    semanticUpdated: 0,
    semanticTrades: 0,
    instruments: new Set<string>(),
    maxSequence: 0,
  };
}

async function main(): Promise<void> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cex-semantic-live-'));
  const clock = new LiveClock();
  const logger: ILogger = new ConsoleLogger(clock, LogLevel.WARN);

  // ── Общий raw bus создаётся ЗДЕСЬ и передаётся фабрике ────────────────
  // Так consumer подписывается ДО старта ingress, не завися от API
  // коллектора: recorder уже внутри фабрики, adapter добавляется рядом.
  const bus = new ExternalMessageBus<ContourMessage>();
  const { collector } = createDataCollector({
    config: verificationConfig(runDir),
    logger,
    clock,
    bus,
  });

  // ── Второй независимый потребитель того же bus ────────────────────────
  const eventBus = new EventBus(logger);
  const adapter = new CexSemanticAdapter({
    bus,
    eventBus,
    metadataGenerator: new MessageMetadataGenerator({
      clock,
      highResolutionClock: new LiveHighResolutionClock(),
    }),
    logger,
  });

  // ── Наблюдатели ───────────────────────────────────────────────────────
  const evidence = new Map<string, VenueEvidence>();
  const bookParity: BookParity[] = [];
  const tradeParity: TradeParity[] = [];
  const bookSamplesTaken = new Map<string, number>();
  const tradeSamplesTaken = new Map<string, number>();
  const causality = { total: 0, children: 0 };
  /** Последнее сырое наблюдение стакана по инструменту — для сверки. */
  const pendingRawBook = new Map<string, { bid: string; ask: string }>();
  /** Последняя сырая сделка по бирже — для сверки. */
  const pendingRawTrade = new Map<string, Record<string, unknown>>();
  let rawRecorderDeliveries = 0;
  let maxActiveStates = 0;

  const venueOf = (exchangeId: string): string => exchangeId.toUpperCase();
  const evidenceFor = (venue: string): VenueEvidence => {
    let entry = evidence.get(venue);
    if (entry === undefined) {
      entry = emptyEvidence();
      evidence.set(venue, entry);
    }
    return entry;
  };
  const instrumentKey = (venue: string, instrument: string): string => `${venue} ${instrument}`;

  // Независимые подписки на raw bus — свидетельство, что запись сырых
  // данных продолжает получать сообщения при живом адаптере
  bus.subscribe('CEX_ORDERBOOK', (message) => {
    rawRecorderDeliveries++;
    const { exchangeId, marketType, symbol, orderBook } = message.payload;
    const venue = venueOf(exchangeId);
    evidenceFor(venue).rawBooks++;

    const bids = orderBook.bids as readonly (readonly unknown[])[] | undefined;
    const asks = orderBook.asks as readonly (readonly unknown[])[] | undefined;
    const bestBid = bids?.[0]?.[0];
    const bestAsk = asks?.[0]?.[0];
    if (bestBid === undefined || bestAsk === undefined) return;
    // Сырое значение печатается СВОИМ представлением (JS-число как его
    // отдал CCXT) — сверка идёт против него, а не против нашей же строки
    pendingRawBook.set(instrumentKey(venue, `${marketType}:${symbol}`), {
      bid: String(bestBid),
      ask: String(bestAsk),
    });
  });

  bus.subscribe('CEX_TRADE', (message) => {
    rawRecorderDeliveries++;
    const { exchangeId, trade } = message.payload;
    const venue = venueOf(exchangeId);
    evidenceFor(venue).rawTrades++;
    pendingRawTrade.set(venue, trade as Record<string, unknown>);
  });

  const record = (event: EventBusEvent): void => {
    causality.total++;
    if (event.metadata.causationId !== undefined) causality.children++;
  };

  eventBus.subscribe('BOOK_DEPTH', (event) => {
    record(event);
    const venue = String(event.payload.venueId);
    const instrument = String(event.payload.instrumentId);
    const entry = evidenceFor(venue);
    entry.semanticDepth++;
    entry.instruments.add(instrument);

    const key = instrumentKey(venue, instrument);
    const raw = pendingRawBook.get(key);
    const taken = bookSamplesTaken.get(venue) ?? 0;
    if (raw === undefined || taken >= SAMPLES_PER_VENUE) return;
    pendingRawBook.delete(key);
    bookSamplesTaken.set(venue, taken + 1);

    const canonicalBid = event.payload.snapshot.getBestBid()?.value().toString() ?? '—';
    const canonicalAsk = event.payload.snapshot.getBestAsk()?.value().toString() ?? '—';
    bookParity.push({
      venueId: venue,
      instrumentId: instrument,
      rawBestBid: raw.bid,
      rawBestAsk: raw.ask,
      canonicalBestBid: canonicalBid,
      canonicalBestAsk: canonicalAsk,
      // Точное равенство десятичных значений: сырое число и canonical
      // Decimal обязаны совпасть символ в символ
      match: raw.bid === canonicalBid && raw.ask === canonicalAsk,
    });
  });

  eventBus.subscribe('BOOK_UPDATED', (event) => {
    record(event);
    const entry = evidenceFor(String(event.payload.venueId));
    entry.semanticUpdated++;
    entry.maxSequence = Math.max(entry.maxSequence, event.payload.sequenceNumber);
  });

  eventBus.subscribe('TRADE_RECEIVED', (event) => {
    record(event);
    const venue = String(event.payload.venueId);
    evidenceFor(venue).semanticTrades++;

    const raw = pendingRawTrade.get(venue);
    const taken = tradeSamplesTaken.get(venue) ?? 0;
    if (raw === undefined || taken >= SAMPLES_PER_VENUE) return;
    pendingRawTrade.delete(venue);
    tradeSamplesTaken.set(venue, taken + 1);

    const rawId = raw['id'] === undefined || raw['id'] === null ? '—' : String(raw['id']);
    const canonicalId = event.payload.venueTradeId ?? '—';
    const rawPrice = String(raw['price']);
    const canonicalPrice = event.payload.price.value().toString();
    const rawAmount = String(raw['amount']);
    const canonicalAmount = event.payload.size.value().toString();
    const rawSide = String(raw['side']);
    const canonicalSide = event.payload.side;
    const rawTs = String(raw['timestamp']);
    const canonicalTs = String(event.payload.timestamp.toNumber());

    tradeParity.push({
      venueId: venue,
      rawId,
      canonicalId: String(canonicalId),
      rawPrice,
      canonicalPrice,
      rawAmount,
      canonicalAmount,
      rawSide,
      canonicalSide,
      rawTs,
      canonicalTs,
      match:
        rawId === String(canonicalId) &&
        rawPrice === canonicalPrice &&
        rawAmount === canonicalAmount &&
        rawSide.toUpperCase() === canonicalSide &&
        rawTs === canonicalTs,
    });
  });

  // ── Прогон ────────────────────────────────────────────────────────────
  adapter.start();
  await collector.start();

  const startedAt = Date.now();
  const deadline = startedAt + RUN_MINUTES * 60_000;
  console.log(`\nCEX SEMANTIC LIVE: running ${String(RUN_MINUTES)} min, output ${runDir}\n`);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const stats = adapter.getStats();
    maxActiveStates = Math.max(maxActiveStates, stats.activeInstrumentStates);
    console.log(
      `  [${String(Math.round((Date.now() - startedAt) / 1000))}s] ` +
        `raw=${String(stats.rawMessagesSeen)} ` +
        `books=${String(stats.orderBooksReceived)}/${String(stats.orderBooksPublished)} ` +
        `top=${String(stats.bookUpdatedPublished)} ` +
        `bad=${String(stats.invalidOrderBooks)} ` +
        `trades=${String(stats.tradesReceived)}/${String(stats.tradesPublished)} ` +
        `dup=${String(stats.duplicateTrades)} ` +
        `states=${String(stats.activeInstrumentStates)}`,
    );
  }

  const finalStats = adapter.getStats();
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  // Здоровье сырого контура снимается ДО остановки: semantic-адаптер не
  // имеет права ухудшать надёжность сбора
  const collectorStatus = collector.status();

  // Свидетельство «запись сырых данных работает» снимается ДО остановки
  const archives = fs.existsSync(runDir)
    ? fs
        .readdirSync(runDir, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.jsonl') || file.endsWith('.jsonl.gz'))
    : [];
  const archiveBytes = archives.reduce((total, file) => {
    const full = path.join(runDir, file);
    return total + (fs.existsSync(full) ? fs.statSync(full).size : 0);
  }, 0);

  // ── Демонстрация явного cleanup ───────────────────────────────────────
  const statesBeforeCleanup = finalStats.activeInstrumentStates;
  let forgotten = 0;
  for (const venue of evidence.keys()) {
    forgotten += adapter.forgetVenue(venue as VenueId);
  }
  const statesAfterCleanup = adapter.getStats().activeInstrumentStates;

  await collector.close();
  adapter.close();

  // ── Отчёт ─────────────────────────────────────────────────────────────
  console.log('\n══════════ CEX SEMANTIC LIVE EVIDENCE ══════════');
  console.log(`duration                  ${String(durationSec)}s`);
  console.log(`raw messages seen         ${String(finalStats.rawMessagesSeen)}`);
  console.log(`raw recorder deliveries   ${String(rawRecorderDeliveries)} (independent subscriber)`);
  console.log(`books received/published  ${String(finalStats.orderBooksReceived)} / ${String(finalStats.orderBooksPublished)}`);
  console.log(`invalid / crossed books   ${String(finalStats.invalidOrderBooks)} / ${String(finalStats.crossedOrderBooks)}`);
  console.log(`BOOK_UPDATED published    ${String(finalStats.bookUpdatedPublished)}`);
  console.log(`trades received/published ${String(finalStats.tradesReceived)} / ${String(finalStats.tradesPublished)}`);
  console.log(`trades invalid            ${String(finalStats.invalidTrades)}`);
  console.log(`trades missing id/amt/side ${String(finalStats.tradesMissingId)} / ${String(finalStats.tradesMissingAmount)} / ${String(finalStats.tradesMissingSide)}`);
  console.log(`trades missing venue ts   ${String(finalStats.tradesMissingVenueTimestamp)}`);
  console.log(`duplicate trades skipped  ${String(finalStats.duplicateTrades)}`);
  console.log(`invalid identities        ${String(finalStats.invalidIdentities)}`);
  console.log(`publish failures          ${String(finalStats.semanticPublishFailures)}`);
  console.log(`active states max/final   ${String(maxActiveStates)} / ${String(statesBeforeCleanup)}`);
  console.log(`after explicit cleanup    ${String(statesAfterCleanup)} (forgot ${String(forgotten)})`);

  console.log('\n— per venue —');
  console.log(
    `  ${'venue'.padEnd(11)}${'rawOB'.padStart(7)}${'semOB'.padStart(7)}${'top'.padStart(7)}` +
      `${'rawTr'.padStart(7)}${'semTr'.padStart(7)}${'seq'.padStart(6)}  instruments`,
  );
  for (const [venue, e] of [...evidence].sort()) {
    console.log(
      `  ${venue.padEnd(11)}${String(e.rawBooks).padStart(7)}${String(e.semanticDepth).padStart(7)}` +
        `${String(e.semanticUpdated).padStart(7)}${String(e.rawTrades).padStart(7)}` +
        `${String(e.semanticTrades).padStart(7)}${String(e.maxSequence).padStart(6)}` +
        `  ${[...e.instruments].join(', ')}`,
    );
  }

  console.log('\n— orderbook parity (raw best vs canonical best) —');
  let bookMatched = 0;
  for (const p of bookParity) {
    if (p.match) bookMatched++;
    console.log(
      `  ${p.venueId.padEnd(11)}${p.instrumentId.padEnd(18)}` +
        `raw ${p.rawBestBid}/${p.rawBestAsk}  canonical ${p.canonicalBestBid}/${p.canonicalBestAsk}` +
        `  ${p.match ? 'MATCH' : 'MISMATCH'}`,
    );
  }
  console.log(`  matched ${String(bookMatched)}/${String(bookParity.length)}`);

  console.log('\n— trade parity (raw vs canonical) —');
  let tradeMatched = 0;
  for (const p of tradeParity) {
    if (p.match) tradeMatched++;
    console.log(
      `  ${p.venueId.padEnd(11)}id ${p.rawId}→${p.canonicalId}  ` +
        `px ${p.rawPrice}→${p.canonicalPrice}  amt ${p.rawAmount}→${p.canonicalAmount}  ` +
        `side ${p.rawSide}→${p.canonicalSide}  ts ${p.rawTs}→${p.canonicalTs}  ` +
        `${p.match ? 'MATCH' : 'MISMATCH'}`,
    );
  }
  console.log(`  matched ${String(tradeMatched)}/${String(tradeParity.length)}`);

  console.log('\n— raw contour health (semantic adapter must not degrade it) —');
  console.log(`  cex messages routed      ${String(collectorStatus.recorderCex.cexMessagesRouted)}`);
  console.log(`  cex records accepted     ${String(collectorStatus.recorderCex.cexRecordsAccepted)}`);
  console.log(`  cex write failures       ${String(collectorStatus.recorderCex.cexWriteFailures)}`);
  console.log(`  cex handler errors       ${String(collectorStatus.recorderCex.cexHandlerErrors)}`);
  console.log(`  cex records dropped      ${String(collectorStatus.recorderCex.cexRecordsDroppedInactive)}`);
  console.log(`  cex partitions completed ${String(collectorStatus.cexWindows.partitionsCompleted)}`);
  console.log(`  cex rotation failures    ${String(collectorStatus.cexWindows.rotationFailures)}`);
  console.log(`  cex stream close fails   ${String(collectorStatus.cexWindows.streamCloseFailures)}`);
  console.log(`  cex compression failures ${String(collectorStatus.cexWindows.compressionFailures)}`);
  console.log(`  bus published/dispatched ${String(collectorStatus.bus.publishedTotal)} / ${String(collectorStatus.bus.dispatchedTotal)}`);
  console.log(`  bus rejected publications ${String(collectorStatus.bus.rejectedPublicationsTotal)}`);
  console.log(`  bus handler errors       ${String(collectorStatus.bus.handlerErrorsTotal)}`);
  console.log(
    `  cex sources failed       ${String(collectorStatus.sources.cex.filter((s) => s.hasFailed).length)}/${String(collectorStatus.sources.cex.length)}`,
  );

  console.log(
    `\ncausality: ${String(causality.children)}/${String(causality.total)} semantic events are children of a raw observation`,
  );
  console.log(
    `raw archive files (before shutdown): ${String(archives.length)}, ${String(archiveBytes)} bytes`,
  );
  console.log('════════════════════════════════════════════════\n');
}

await main();

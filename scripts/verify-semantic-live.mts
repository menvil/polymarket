/**
 * DEVELOPMENT-ONLY live-верификация Polymarket Semantic Adapter (MR-C).
 *
 * @remarks
 * Тонкий consumer уже существующей production-фабрики контура — собственной
 * composition, собственных source-ов и второго WS-подключения здесь НЕТ:
 *
 * ```text
 *            createDataCollector(...)          ← та же фабрика, что у production
 *                     ↓
 *        общий ExternalMessageBus
 *        ├── ExternalMessageRecorder            (уже внутри фабрики)
 *        └── PolymarketSemanticAdapter          ← добавляет этот скрипт
 *                     ↓
 *               тестовый EventBus
 *                     ↓
 *                 наблюдатель
 * ```
 *
 * Скрипт ТОЛЬКО конфигурирует, подписывается и печатает свидетельства.
 * Он не преобразует payload, не строит новую observability и не является
 * production-компонентом: `apps/collect-data` остаётся collect-only.
 *
 * Что доказывает прогон:
 * 1. запись сырых данных продолжает работать при живом semantic-адаптере;
 * 2. `book` и `price_change` дают canonical `Orderbook` (BOOK_DEPTH);
 * 3. реконструированные best bid/ask СОВПАДАЮТ с объявленными источником;
 * 4. оба outcome-токена рынка живут независимо;
 * 5. Binance / Chainlink / Chainlink TWAP дают референсные наблюдения,
 *    и цена актива НЕ проходит через prediction `Price`;
 * 6. состояние реконструкции ограничено и освобождается явным cleanup.
 *
 * Env-переменные:
 * - `SEMANTIC_MINUTES` — длительность прогона (default 6);
 * - `SEMANTIC_MAX_MARKETS` — сколько рынков собирать (default 2).
 *
 * Запуск:
 * ```bash
 * npx tsx scripts/verify-semantic-live.mts
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
import { PolymarketSemanticAdapter } from '@polymarket/polymarket-semantic-adapter';
import { createDataCollector } from '@polymarket/collect-data/runtime';
import type { ContourMessage, DataCollectorConfig } from '@polymarket/collect-data/runtime';
import { asMarketId } from '@polymarket/ids';
import { PriceService } from '@polymarket/value-objects';

const RUN_MINUTES = Number(process.env['SEMANTIC_MINUTES'] ?? '6');
const MAX_MARKETS = Number(process.env['SEMANTIC_MAX_MARKETS'] ?? '2');

/**
 * Конфигурация verification-прогона (НЕ production defaults).
 *
 * @param runDir - Изолированный корень датасетов прогона
 * @returns Конфигурация production-фабрики контура
 *
 * @remarks
 * Широкий discovery-фильтр и нулевые пороги нужны, чтобы активный
 * Up/Down-рынок BTC гарантированно попал в окно прогона. CEX выключен —
 * MR-C касается ТОЛЬКО Polymarket-границы, и лишний ingress только зашумил
 * бы свидетельства.
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
        maxMarketsToReturn: MAX_MARKETS * 3,
        requiredKeywords: ['up or down'],
        anyOfKeywords: ['bitcoin', 'ethereum'],
        excludedKeywords: [],
      },
    },
    collection: {
      maxMarkets: MAX_MARKETS,
      minTimeToStartMs: 30_000,
      discoveryRefreshMs: 30_000,
      runtimeTickMs: 5_000,
    },
    finalization: { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 5 * 60_000 },
    cex: { sources: [], bufferSize: 200, flushIntervalMs: 2_000, compression: 'gzip' },
  };
}

/** Сверка одной дельты: что объявил источник против того, что собрали мы. */
interface BestComparison {
  readonly token: string;
  readonly sourceBestBid: string;
  readonly sourceBestAsk: string;
  readonly rebuiltBestBid: string;
  readonly rebuiltBestAsk: string;
  readonly match: boolean;
}

async function main(): Promise<void> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-live-'));
  const clock = new LiveClock();
  const logger: ILogger = new ConsoleLogger(clock, LogLevel.WARN);

  // ── Общий raw bus создаётся ЗДЕСЬ и передаётся фабрике ────────────────
  // Именно так consumer подписывается ДО старта ingress, не завися от API
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
  const adapter = new PolymarketSemanticAdapter({
    bus,
    eventBus,
    metadataGenerator: new MessageMetadataGenerator({
      clock,
      highResolutionClock: new LiveHighResolutionClock(),
    }),
    logger,
  });

  // ── Наблюдатели ───────────────────────────────────────────────────────
  const semantic = new Map<string, number>();
  const tokensSeen = new Map<string, { depth: number; updated: number }>();
  const referenceByFeed = new Map<string, { count: number; sample: string }>();
  const marketsSeen = new Set<string>();
  const causalityChecked = { total: 0, children: 0 };
  const bookByToken = new Map<
    string,
    { bestBid: string | undefined; bestAsk: string | undefined }
  >();
  const comparisons: BestComparison[] = [];
  let rawRecorderDeliveries = 0;
  let maxActiveStates = 0;

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  /** Очередь утверждений источника, ожидающих сверки с semantic-выходом. */
  const comparisonQueue = new Map<
    string,
    { bestBid: string | undefined; bestAsk: string | undefined }[]
  >();

  /**
   * Приводит объявленную источником цену к канонической форме.
   *
   * @param raw - Десятичная строка vendor-а либо `undefined`
   * @returns Каноническая decimal-строка либо `—` для «стороны нет»
   *
   * @remarks
   * Сверка идёт ровно тем же путём, что и в адаптере: через `Price` VO, а
   * не лексическим сравнением строк — `"0.50"` и `"0.5"` это одна цена.
   * Значение, которое `Price` принять не может (практически `"0"`),
   * означает «уровней на стороне нет».
   */
  const canonicalBest = (raw: string | undefined): string => {
    if (raw === undefined) return '—';
    const parsed = PriceService.create(raw);
    return parsed.ok ? parsed.value.value().toString() : '—';
  };

  // Независимая подписка на raw bus — свидетельство, что запись сырых
  // данных продолжает получать сообщения при живом адаптере
  bus.subscribe('POLYMARKET_MARKET', (message) => {
    rawRecorderDeliveries++;
    const event = message.payload;
    if (event.type !== 'price_change') return;
    // Сохраняем объявленные источником best bid/ask последнего изменения
    // токена — их и сверим с реконструкцией
    for (const change of event.payload.priceChanges) {
      const token = String(change.tokenId);
      const pending = comparisonQueue.get(token) ?? [];
      pending.push({
        bestBid: change.bestBid ?? undefined,
        bestAsk: change.bestAsk ?? undefined,
      });
      comparisonQueue.set(token, pending);
    }
  });

  const record = (event: EventBusEvent): void => {
    bump(semantic, event.type);
    causalityChecked.total++;
    if (event.metadata.causationId !== undefined) causalityChecked.children++;
  };

  eventBus.subscribe('BOOK_DEPTH', (event) => {
    record(event);
    const token = String(event.payload.instrumentId);
    const seen = tokensSeen.get(token) ?? { depth: 0, updated: 0 };
    seen.depth++;
    tokensSeen.set(token, seen);
    marketsSeen.add(String(event.payload.snapshot.instrumentId));

    const rebuilt = {
      bestBid: event.payload.snapshot.getBestBid()?.value().toString(),
      bestAsk: event.payload.snapshot.getBestAsk()?.value().toString(),
    };
    bookByToken.set(token, rebuilt);

    // Сверяем с ближайшим необработанным утверждением источника
    const pending = comparisonQueue.get(token);
    const claim = pending?.shift();
    if (claim === undefined || comparisons.length >= 12) return;
    if (claim.bestBid === undefined && claim.bestAsk === undefined) return;

    const sourceBid = canonicalBest(claim.bestBid);
    const sourceAsk = canonicalBest(claim.bestAsk);
    const ourBid = rebuilt.bestBid ?? '—';
    const ourAsk = rebuilt.bestAsk ?? '—';

    comparisons.push({
      token: `${token.slice(0, 10)}…`,
      sourceBestBid: sourceBid,
      sourceBestAsk: sourceAsk,
      rebuiltBestBid: ourBid,
      rebuiltBestAsk: ourAsk,
      match: sourceBid === ourBid && sourceAsk === ourAsk,
    });
  });

  eventBus.subscribe('BOOK_UPDATED', (event) => {
    record(event);
    const token = String(event.payload.instrumentId);
    const seen = tokensSeen.get(token) ?? { depth: 0, updated: 0 };
    seen.updated++;
    tokensSeen.set(token, seen);
    marketsSeen.add(String(event.payload.marketId));
  });

  eventBus.subscribe('TRADE_RECEIVED', (event) => {
    record(event);
    if ((semantic.get('TRADE_RECEIVED') ?? 0) <= 3) {
      console.log(
        `  TRADE sample: ${String(event.payload.instrumentId).slice(0, 10)}… ` +
          `${event.payload.side} ${event.payload.size.value().toString()} @ ` +
          `${event.payload.price.value().toString()}`,
      );
    }
  });

  eventBus.subscribe('TICK_SIZE_CHANGED', (event) => {
    record(event);
    console.log(
      `  TICK_SIZE: ${event.payload.oldTickSize?.value().toString() ?? '—'} → ` +
        `${event.payload.newTickSize.value().toString()}`,
    );
  });

  eventBus.subscribe('REFERENCE_PRICE_UPDATED', (event) => {
    record(event);
    const feed =
      event.payload.feed.kind === 'TWAP'
        ? `${String(event.payload.sourceId)} twap${String(event.payload.feed.windowSeconds)}`
        : String(event.payload.sourceId);
    const entry = referenceByFeed.get(feed) ?? { count: 0, sample: '' };
    entry.count++;
    entry.sample = `${event.payload.symbol} = ${event.payload.value.value().toString()}`;
    referenceByFeed.set(feed, entry);
  });

  // ── Прогон ────────────────────────────────────────────────────────────
  adapter.start();
  await collector.start();

  const startedAt = Date.now();
  const deadline = startedAt + RUN_MINUTES * 60_000;
  console.log(`\nSEMANTIC LIVE: running ${String(RUN_MINUTES)} min, output ${runDir}\n`);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const stats = adapter.getStats();
    maxActiveStates = Math.max(maxActiveStates, stats.activeBookStates);
    console.log(
      `  [${String(Math.round((Date.now() - startedAt) / 1000))}s] ` +
        `raw=${String(stats.rawMessagesSeen)} books=${String(stats.booksReceived)}/${String(stats.booksPublished)} ` +
        `pc=${String(stats.priceChangesReceived)}/${String(stats.priceChangesApplied)} ` +
        `desync=${String(stats.desyncs)}/${String(stats.resyncs)} ` +
        `trades=${String(stats.tradesReceived)}/${String(stats.tradesPublished)} ` +
        `refs=${String(stats.referenceBinance)}/${String(stats.referenceChainlink)}/${String(stats.referenceTwap)} ` +
        `states=${String(stats.activeBookStates)}`,
    );
  }

  const finalStats = adapter.getStats();
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  // Свидетельство «запись сырых данных работает» снимается ДО остановки:
  // сессии рынков, брошенные на shutdown, не архивируются (сбор не дошёл до
  // SEAL), поэтому после `collector.close()` каталог законно пуст.
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
  const statesBeforeCleanup = finalStats.activeBookStates;
  let forgotten = 0;
  for (const market of marketsSeen) {
    const marketId = asMarketId(market);
    if (marketId !== undefined) forgotten += adapter.forgetMarket(marketId);
  }
  const statesAfterCleanup = adapter.getStats().activeBookStates;

  await collector.close();
  adapter.close();

  // ── Отчёт ─────────────────────────────────────────────────────────────
  console.log('\n══════════ SEMANTIC LIVE EVIDENCE ══════════');
  console.log(`duration                 ${String(durationSec)}s`);
  console.log(`raw messages seen        ${String(finalStats.rawMessagesSeen)}`);
  console.log(`raw recorder deliveries  ${String(rawRecorderDeliveries)} (independent subscriber)`);
  console.log(`books received/published ${String(finalStats.booksReceived)} / ${String(finalStats.booksPublished)}`);
  console.log(`price_change recv/applied ${String(finalStats.priceChangesReceived)} / ${String(finalStats.priceChangesApplied)}`);
  console.log(`delta before snapshot    ${String(finalStats.deltaBeforeSnapshot)}`);
  console.log(`desyncs / resyncs        ${String(finalStats.desyncs)} / ${String(finalStats.resyncs)}`);
  console.log(`trades recv/pub/no-size  ${String(finalStats.tradesReceived)} / ${String(finalStats.tradesPublished)} / ${String(finalStats.tradesMissingSize)}`);
  console.log(`tick size changes        ${String(finalStats.tickSizeChanges)}`);
  console.log(`reference bin/cl/twap    ${String(finalStats.referenceBinance)} / ${String(finalStats.referenceChainlink)} / ${String(finalStats.referenceTwap)}`);
  console.log(`invalid payloads         ${String(finalStats.invalidPayloads)}`);
  console.log(`unknown market events    ${String(finalStats.unknownMarketEvents)}`);
  console.log(`publish failures         ${String(finalStats.semanticPublishFailures)}`);
  console.log(`backward vendor ts       ${String(finalStats.backwardVendorTimestamps)}`);
  console.log(`active states max/final  ${String(maxActiveStates)} / ${String(statesBeforeCleanup)}`);
  console.log(`after explicit cleanup   ${String(statesAfterCleanup)} (forgot ${String(forgotten)})`);

  console.log('\n— semantic events —');
  for (const [type, count] of [...semantic].sort()) {
    console.log(`  ${type.padEnd(24)} ${String(count)}`);
  }

  console.log('\n— per-token independence —');
  for (const [token, counts] of tokensSeen) {
    console.log(`  ${token.slice(0, 16)}…  BOOK_DEPTH=${String(counts.depth)} BOOK_UPDATED=${String(counts.updated)}`);
  }

  console.log('\n— reference price feeds —');
  for (const [feed, entry] of referenceByFeed) {
    console.log(`  ${feed.padEnd(38)} n=${String(entry.count).padStart(4)}  ${entry.sample}`);
  }

  console.log('\n— source best vs reconstructed best —');
  let matched = 0;
  for (const c of comparisons) {
    if (c.match) matched++;
    console.log(
      `  ${c.token}  source ${c.sourceBestBid}/${c.sourceBestAsk}` +
        `  rebuilt ${c.rebuiltBestBid}/${c.rebuiltBestAsk}  ${c.match ? 'MATCH' : 'MISMATCH'}`,
    );
  }
  console.log(`  matched ${String(matched)}/${String(comparisons.length)}`);

  console.log(`\ncausality: ${String(causalityChecked.children)}/${String(causalityChecked.total)} semantic events are children of a raw observation`);

  console.log(
    `raw archive files (before shutdown): ${String(archives.length)}, ${String(archiveBytes)} bytes`,
  );
  for (const file of archives) console.log(`  ${file}`);
  console.log('════════════════════════════════════════════\n');
}

await main();

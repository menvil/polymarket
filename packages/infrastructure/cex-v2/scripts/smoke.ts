/**
 * DEVELOPMENT-ONLY live E2E smoke N-005 (PART 28).
 *
 * @remarks
 * Полный НОВЫЙ CEX collection path против реальной публичной биржи
 * (без credentials):
 *
 * ```text
 * CCXT Pro (binance spot)
 *      ↓
 * CexSource
 *      ↓ CEX_ORDERBOOK / CEX_TRADE
 * ОБЩИЙ ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>
 *      ↓
 * ОДИН ExternalMessageRecorder (обе политики; Polymarket-storage inert)
 *      ↓
 * CexWindowRecorder (тестовое короткое окно)
 *      ↓
 * JSONL → завершённые .jsonl.gz партиции → readback + JSON parse
 * ```
 *
 * Окно записи смоука — ТЕСТОВОЕ (15s), чтобы детерминированно получить
 * завершённую gzip-партицию за ~1 минуту; production default (5 минут)
 * не меняется.
 *
 * Скрипт — dev-only композиция ПОВЕРХ пакетов контура: импорты
 * recorder/storage/polymarket-типов разрешаются workspace-hoisting-ом и
 * сознательно НЕ объявляются зависимостями cex-v2 (production-манифест
 * пакета остаётся чистым; dependency boundary src/ это не затрагивает).
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * npx tsx packages/infrastructure/cex-v2/scripts/smoke.ts
 * ```
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import {
  CexWindowRecorder,
  DataRecorder,
  GzipCompressor,
  NDJSONFormatter,
} from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { CexSource } from '../src/index.js';
import type { CexExternalMessage } from '../src/index.js';

const EXCHANGE_ID = 'binance';
const MARKET_TYPE = 'spot' as const;
const SYMBOLS = ['BTC/USDT', 'ETH/USDT'] as const;
/** Тестовое окно смоука (production default 5 минут не меняется). */
const WINDOW_MS = 15_000;
/** Длительность прослушивания: выравнивание + ≥1 полное окно + запас. */
const LISTEN_MS = 50_000;

function fail(message: string): never {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

async function main(): Promise<void> {
  const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
  const cexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n005-smoke-cex-'));
  const polymarketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n005-smoke-poly-'));
  console.log(`CEX partitions dir: ${cexDir}`);

  // ── ОДИН общий bus контура (union обоих sources) ──
  const bus = new ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock: new LiveClock(),
    highResolutionClock: new LiveHighResolutionClock(),
  });

  // ── ОДИН Recorder service с обеими политиками ──
  const polymarketStorage = new DataRecorder(
    {
      outputDir: polymarketDir,
      sourceSubDir: 'polymarket',
      bufferSize: 100,
      flushIntervalMs: 10_000,
      compression: 'gzip',
      formatVersion: 2,
    },
    new NDJSONFormatter(),
    new GzipCompressor(),
    logger,
  );
  const cexStorage = new CexWindowRecorder(
    {
      outputDir: cexDir,
      compression: 'gzip',
      windowMinutes: WINDOW_MS / 60_000,
      bufferSize: 200,
      flushIntervalMs: 1_000,
    },
    logger,
  );
  await cexStorage.cleanup();
  const recorder = new ExternalMessageRecorder({
    bus,
    storage: polymarketStorage,
    logger,
    cex: { bus, storage: cexStorage },
  });
  recorder.start();

  // Независимые счётчики сообщений на том же bus
  let orderbookMessages = 0;
  let tradeMessages = 0;
  const seenSymbols = new Set<string>();
  bus.subscribe('CEX_ORDERBOOK', (message) => {
    orderbookMessages++;
    seenSymbols.add(message.payload.symbol);
  });
  bus.subscribe('CEX_TRADE', (message) => {
    tradeMessages++;
    seenSymbols.add(message.payload.symbol);
  });

  // ── CexSource против реальной биржи ──
  const source = new CexSource({
    config: {
      exchangeId: EXCHANGE_ID,
      marketType: MARKET_TYPE,
      symbols: [...SYMBOLS],
      watchOrderbook: true,
      watchTrades: true,
      orderbookDepth: 10,
    },
    bus,
    metadataGenerator,
    logger,
  });
  source.start();
  console.log(`Listening for ${LISTEN_MS / 1000}s (window=${WINDOW_MS / 1000}s)...`);
  await new Promise((resolve) => setTimeout(resolve, LISTEN_MS));

  // ── Graceful shutdown контура ──
  await source.close();
  if (source.hasFailed) fail('source entered failed state during smoke');
  const drainResult = await bus.drain();
  if (!drainResult.ok) fail(`bus drain rejected: ${drainResult.error.message}`);
  const statsBeforeClose = recorder.getCexStats();
  await recorder.close();
  await bus.close();
  const sourceStats = source.getStats();
  const storageStats = cexStorage.getStats();

  // ── Verification ──
  console.log('\n── Results ──');
  console.log(`CEX_ORDERBOOK messages: ${orderbookMessages}`);
  console.log(`CEX_TRADE messages: ${tradeMessages}`);
  console.log(`symbols observed: ${[...seenSymbols].join(', ')}`);
  console.log(`recorder cex stats: ${JSON.stringify(statsBeforeClose)}`);
  console.log(`source stats: ${JSON.stringify(sourceStats)}`);
  console.log(`window storage stats: ${JSON.stringify(storageStats)}`);

  if (orderbookMessages === 0) fail('no CEX_ORDERBOOK messages were published');
  if (tradeMessages === 0) fail('no CEX_TRADE messages were published');
  if (statsBeforeClose.cexRecordsAccepted === 0) fail('recorder accepted no CEX records');
  if (statsBeforeClose.cexWriteFailures > 0 || statsBeforeClose.cexHandlerErrors > 0) {
    fail(`recorder observed failures: ${JSON.stringify(statsBeforeClose)}`);
  }
  if (sourceStats.orderbookSnapshotFailures > 0 || sourceStats.tradeSnapshotFailures > 0) {
    fail(`snapshot failures detected: ${JSON.stringify(sourceStats)}`);
  }
  if (
    storageStats.rotationFailures > 0 ||
    storageStats.streamCloseFailures > 0 ||
    storageStats.compressionFailures > 0
  ) {
    fail(`window storage failures detected: ${JSON.stringify(storageStats)}`);
  }
  if (storageStats.partitionsCompleted === 0) fail('no partitions were completed');

  const allFiles = listTree(cexDir);
  const archives = allFiles.filter((file) => file.endsWith('.jsonl.gz'));
  const incomplete = allFiles.filter((file) => file.endsWith('.jsonl') && !file.endsWith('.jsonl.gz'));
  console.log(`completed partitions (.jsonl.gz): ${archives.length}`);
  for (const file of archives) {
    console.log(`  ${path.relative(cexDir, file)}`);
  }
  if (archives.length === 0) fail('no completed gzip partitions were produced');
  if (archives.length !== storageStats.partitionsCompleted) {
    fail(
      `completed-partition invariant broken: ${archives.length} archives vs ` +
        `${storageStats.partitionsCompleted} partitionsCompleted`,
    );
  }
  if (incomplete.length > 0) {
    fail(`incomplete .jsonl left after close: ${incomplete.join(', ')}`);
  }

  // Readback: gzip валиден, каждая строка — JSON payload с routing identity
  let totalLines = 0;
  let orderbookLines = 0;
  let tradeLines = 0;
  for (const archive of archives) {
    const lines = zlib
      .gunzipSync(fs.readFileSync(archive))
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .filter((line) => line.length > 0);
    if (lines.length === 0) fail(`empty completed partition: ${archive}`);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed['exchangeId'] !== EXCHANGE_ID) {
        fail(`unexpected exchangeId in ${archive}: ${String(parsed['exchangeId'])}`);
      }
      if (typeof parsed['symbol'] !== 'string') fail(`missing symbol in ${archive}`);
      if ('metadata' in parsed || 'messageId' in parsed) {
        fail(`envelope leaked into payload line in ${archive}`);
      }
      const isOrderbook = 'orderBook' in parsed;
      const isTrade = 'trade' in parsed;
      if (!isOrderbook && !isTrade) fail(`line is neither orderbook nor trade in ${archive}`);
      if (isOrderbook && !archive.includes('_orderbook_')) {
        fail(`orderbook line leaked into trades partition: ${archive}`);
      }
      if (isTrade && !archive.includes('_trades_')) {
        fail(`trade line leaked into orderbook partition: ${archive}`);
      }
      if (isOrderbook) orderbookLines++;
      if (isTrade) tradeLines++;
    }
    totalLines += lines.length;
  }
  console.log(
    `readback: ${totalLines} lines parsed (orderbook=${orderbookLines}, trades=${tradeLines})`,
  );
  if (orderbookLines === 0) fail('no orderbook lines inside completed partitions');

  fs.rmSync(polymarketDir, { recursive: true, force: true });
  console.log('\nSMOKE PASSED');
  console.log(`Partitions kept for inspection at: ${cexDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('SMOKE FAILED with error:', error);
    process.exit(1);
  });

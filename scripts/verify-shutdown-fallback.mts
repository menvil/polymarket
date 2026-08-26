/**
 * DEVELOPMENT-ONLY verification: fallback при остановке ДО официальной резолюции.
 *
 * @remarks
 * ### Что доказывает
 *
 * Сценарий, ради которого MR-B вводил fallback: рынок истёк, официальной
 * резолюции Gamma ещё нет (она приходит через 1-6 минут), процесс
 * останавливается. Раньше это давало `.jsonl.gz` со статусом `timeout` и
 * неизвестным победителем. Теперь итог обязан быть выведен из записанного
 * settlement-потока, помечен `trigger = 'shutdown'`, а процесс — завершиться
 * сам.
 *
 * ```text
 * старт → сбор → expiry рынка → boundary grace → seal
 *                                    ↓ БЕЗ ожидания Gamma
 *                              collector.close()
 *                                    ↓
 *                     FALLBACK COMPLETE (trigger=shutdown) → .jsonl.gz
 * ```
 *
 * Контур поднимается ТОЙ ЖЕ production-фабрикой `createDataCollector`, что и
 * `main.ts`: production-алгоритм не подменяется (никаких «режимов проверки»).
 * Скрипт лишь выбирает момент остановки — сразу после истечения рынка.
 *
 * Env-переменные:
 * - `SHUTDOWN_OUTPUT_ROOT` — корень output (default `data/mrb-shutdown`);
 * - `SHUTDOWN_MAX_MINUTES` — предел ожидания истечения (default 20);
 * - `SHUTDOWN_GRACE_SECONDS` — пауза после expiry до остановки (default 12);
 *   она должна перекрывать boundary grace (5 с) и seal, но НЕ дотягивать до
 *   типичной официальной резолюции (1-6 мин).
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * npx tsx scripts/verify-shutdown-fallback.mts
 * ```
 *
 * Выход: 0 — fallback-архив с известным победителем создан; 1 — иначе.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { createDataCollector } from '@polymarket/collect-data/runtime';
import type { DataCollectorConfig } from '@polymarket/collect-data/runtime';

const OUTPUT_ROOT = process.env['SHUTDOWN_OUTPUT_ROOT'] ?? path.join('data', 'mrb-shutdown');
const MAX_MINUTES = Number(process.env['SHUTDOWN_MAX_MINUTES'] ?? '20');
const GRACE_SECONDS = Number(process.env['SHUTDOWN_GRACE_SECONDS'] ?? '12');

const outputDir = path.join(OUTPUT_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outputDir, { recursive: true });

const clock = new LiveClock();
const logger = new ConsoleLogger(clock, LogLevel.INFO);

const config: DataCollectorConfig = {
  outputDir,
  polymarket: {
    sourceSubDir: 'polymarket',
    bufferSize: 100,
    flushIntervalMs: 5_000,
    compression: 'gzip',
  },
  cex: {
    sources: [], // CEX не нужен: проверяется резолюция Polymarket-архива
    compression: 'gzip',
    bufferSize: 100,
    flushIntervalMs: 5_000,
  },
  discovery: {
    filter: {
      minTimeToExpiryHours: 0,
      minSpread: 0,
      minLiquidity: 0,
      maxMarketsToReturn: 6,
      requiredKeywords: ['up or down'],
      anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
      excludedKeywords: [],
    },
  },
  collection: {
    maxMarkets: 2,
    minTimeToStartMs: 30_000,
    discoveryRefreshMs: 30_000,
    runtimeTickMs: 2_000,
  },
  // Production-дефолты: бюджет ожидания официальной резолюции НЕ уменьшается —
  // сценарий проверяет именно остановку ДО его исчерпания
  finalization: { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 60 * 60_000 },
};

const { collector } = createDataCollector({ config, logger, clock });

await collector.start();
logger.info('SHUTDOWN-FALLBACK: collector started', { outputDir });

const deadlineMs = Date.now() + MAX_MINUTES * 60_000;
let expiredAtMs: number | undefined;

// Ждём, пока хотя бы один рынок войдёт в финализацию (то есть истечёт)
collector.onMarketLifecycle((event) => {
  if (event.kind === 'FINALIZING' && expiredAtMs === undefined) {
    expiredAtMs = Date.now();
    logger.info('SHUTDOWN-FALLBACK: market expired, starting shutdown countdown', {
      marketId: String(event.marketId),
      question: event.question,
      graceSeconds: GRACE_SECONDS,
    });
  }
});

while (Date.now() < deadlineMs) {
  if (expiredAtMs !== undefined && Date.now() - expiredAtMs >= GRACE_SECONDS * 1_000) {
    break;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1_000);
  });
}

if (expiredAtMs === undefined) {
  logger.error('SHUTDOWN-FALLBACK: no market expired within deadline');
  await collector.close();
  process.exit(1);
}

// КРИТИЧНО: drain() НЕ вызывается — именно этим сценарий и отличается.
// Официальная резолюция Gamma к этому моменту заведомо не пришла.
logger.info('SHUTDOWN-FALLBACK: closing collector WITHOUT waiting for official resolution');
const closeStartedMs = Date.now();
await collector.close();
logger.info('SHUTDOWN-FALLBACK: collector closed', { durationMs: Date.now() - closeStartedMs });

// ── Проверка артефактов ────────────────────────────────────────────────
function listArchives(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listArchives(full));
    else if (entry.name.endsWith('.jsonl.gz')) found.push(full);
  }
  return found;
}
function listIncomplete(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listIncomplete(full));
    else if (entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}

const archives = listArchives(outputDir);
const incomplete = listIncomplete(outputDir);
console.log('\n=== SHUTDOWN FALLBACK RESULT ===');
console.log(`archives: ${String(archives.length)}   incomplete .jsonl left: ${String(incomplete.length)}`);
console.log(`finalizer: ${JSON.stringify(collector.status().finalization)}`);

let ok = false;
for (const file of archives) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const header = JSON.parse(text.split('\n', 1)[0]!) as Record<string, unknown>;
  const m = (header['m'] ?? {}) as Record<string, unknown>;
  const finalization = (m['finalization'] ?? {}) as Record<string, unknown>;
  const winning = finalization['winning'] as Record<string, unknown> | undefined;
  const provenance = (finalization['provenance'] ?? {}) as Record<string, unknown>;
  const twapLines = text
    .split('\n')
    .filter((line) => line.includes('"prices.crypto.chainlink.twap"')).length;

  console.log(`\n${path.basename(file)}`);
  console.log(`  question: ${String(m['question'])}`);
  console.log(`  status: ${String(finalization['status'])}`);
  console.log(
    `  winner: ${String(winning?.['label'])} idx=${String(winning?.['outcomeIndex'])} source=${String(winning?.['source'])}`,
  );
  console.log(
    `  provenance: ${String(provenance['resolution'])} trigger=${String(provenance['fallbackTrigger'])}`,
  );
  console.log(`  evidence: ${JSON.stringify(provenance['evidence'])}`);
  console.log(`  recorded TWAP lines: ${String(twapLines)}`);

  if (
    finalization['status'] === 'complete' &&
    winning?.['label'] !== undefined &&
    winning['instrumentId'] !== undefined &&
    winning['outcomeIndex'] !== undefined &&
    provenance['resolution'] !== undefined
  ) {
    ok = true;
  }
}

if (!ok) {
  console.log('\n✗ no completed archive with a known winner was produced');
  process.exit(1);
}
console.log('\n✓ shutdown produced a completed archive with a known winner');
process.exit(0);

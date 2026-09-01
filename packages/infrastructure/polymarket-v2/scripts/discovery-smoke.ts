/**
 * DEVELOPMENT-ONLY live smoke: один обход Polymarket V2 Discovery.
 *
 * @remarks
 * Проверяет против ПУБЛИЧНЫХ endpoints Polymarket (без credentials), что
 * реальный vendor-каталог превращается в canonical universe:
 *
 * - bounded-пагинация каталога и окно `endDate`;
 * - классификация семейства `CRYPTO_UP_DOWN` на реальных данных;
 * - точное `startsAt` из `event.schedule.startTime` для каждого рынка;
 * - экономия точечных запросов события (кэш + дедупликация).
 *
 * Это НЕ Collector: скрипт НЕ открывает WS-подписок, ничего не пишет и
 * завершается сам. Печатает диагностику обхода и найденные серии.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей — `npm run build`
 * в пакете строит их через project references):
 *
 * ```bash
 * npx tsx packages/infrastructure/polymarket-v2/scripts/discovery-smoke.ts
 * # окно обзора в часах (по умолчанию 6)
 * DISCOVERY_WINDOW_HOURS=2 npx tsx packages/infrastructure/polymarket-v2/scripts/discovery-smoke.ts
 * ```
 */
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import { PolymarketMarketDiscovery } from '../src/index.js';

/** Окно обзора `endDate` в часах (ближайшие серии, а не весь мир). */
const WINDOW_HOURS = Number(process.env['DISCOVERY_WINDOW_HOURS'] ?? '6');

/** `HH:MM` в UTC — компактная разметка окна серии в отчёте. */
function hhmm(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

/** Человекочитаемая длительность серии (`5m`, `15m`, `1h`). */
function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes % 60 === 0 && minutes >= 60 ? `${String(minutes / 60)}h` : `${String(minutes)}m`;
}

/** Группирует записи по ключу, сохраняя порядок появления. */
function groupBy(
  entries: readonly MarketDiscoveryEntry[],
  key: (entry: MarketDiscoveryEntry) => string,
): Map<string, MarketDiscoveryEntry[]> {
  const groups = new Map<string, MarketDiscoveryEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(key(entry));
    if (bucket === undefined) {
      groups.set(key(entry), [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return groups;
}

async function main(): Promise<void> {
  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.INFO);

  const discovery = new PolymarketMarketDiscovery(
    { client: createPublicClient(), clock, logger },
    { endDateWindowMs: WINDOW_HOURS * 60 * 60_000 },
  );

  // Первый обход — холодный кэш событий; второй — проверка того, что
  // расписания переиспользуются, а не запрашиваются заново.
  const coldStartedMs = Date.now();
  const refreshed = await discovery.refresh({ force: true });
  const coldElapsedMs = Date.now() - coldStartedMs;
  const coldDiagnostics = discovery.getSnapshot().diagnostics;

  const warmStartedMs = Date.now();
  await discovery.refresh({ force: true });
  const warmElapsedMs = Date.now() - warmStartedMs;
  const snapshot = discovery.getSnapshot();

  const lines: string[] = [
    '',
    'Polymarket V2 Discovery',
    '',
    `windowHours: ${String(WINDOW_HOURS)}`,
    `refreshed: ${String(refreshed)}`,
    `cold pass: ${String(coldElapsedMs)} ms, eventFetches=${String(coldDiagnostics.eventFetches)}`,
    `warm pass: ${String(warmElapsedMs)} ms, eventFetches=${String(snapshot.diagnostics.eventFetches)}` +
      `, eventCacheHits=${String(snapshot.diagnostics.eventCacheHits)}`,
    `observedAt: ${snapshot.observedAt.toISO()}`,
    '',
  ];
  for (const [name, value] of Object.entries(snapshot.diagnostics)) {
    lines.push(`${name}: ${String(value)}`);
  }
  lines.push('');

  const byAsset = groupBy(snapshot.entries, (entry) => String(entry.market.crypto?.asset ?? '—'));
  for (const [asset, group] of [...byAsset].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${asset.toUpperCase()}: ${String(group.length)}`);
    for (const entry of group) {
      lines.push(
        `  ${hhmm(entry.market.startsAt.toNumber())}–${hhmm(entry.market.expiresAt.toNumber())}` +
          `  ${humanDuration(entry.market.duration().toNumber())}` +
          `  liq=${entry.metrics.liquidity.value().toFixed(0)}` +
          `  ${entry.market.outcomes.map((outcome) => outcome.label).join('/')}`,
      );
    }
    lines.push('');
  }

  const byDuration = groupBy(snapshot.entries, (entry) =>
    humanDuration(entry.market.duration().toNumber()),
  );
  lines.push('by duration:');
  for (const [duration, group] of byDuration) {
    lines.push(`  ${duration}: ${String(group.length)}`);
  }

  // Инвариант MR: ни одного рынка с угаданным расписанием — все startsAt
  // подтверждены событием, иначе рынок в universe не попал бы вовсе.
  const withoutSchedule = snapshot.entries.filter(
    (entry) => !entry.market.startsAt.isBefore(entry.market.expiresAt),
  );
  lines.push('', `markets with invalid schedule: ${String(withoutSchedule.length)}`);

  // eslint-disable-next-line no-console -- отчёт smoke-скрипта, а не логи сервиса
  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  console.error('Discovery smoke failed:', error);
  process.exitCode = 1;
});

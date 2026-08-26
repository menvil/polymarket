/**
 * DEVELOPMENT-ONLY verification: официальный итог vs выведенный из архива.
 *
 * @remarks
 * ### Зачем
 *
 * Fallback-деривация срабатывает в production РЕДКО — только когда Gamma не
 * успел опубликовать резолюцию. Ждать такого случая, чтобы убедиться в её
 * правильности, поздно. Поэтому по каждому завершённому архиву считается
 * ТЕНЕВОЙ результат: «что дал бы fallback, если бы официального итога не
 * было?» — и сверяется с фактическим официальным победителем.
 *
 * ```text
 * .jsonl.gz архив
 *    ├── header.finalization.winning        ← официальный итог (эталон)
 *    └── записанные строки TWAP-потока
 *            ↓ deriveWinnerFromRecordedTwap  ← ТА ЖЕ production-функция
 *        теневой итог                        → сравнение
 * ```
 *
 * ### Почему это честная проверка
 *
 * Скрипт НЕ содержит собственной копии правила расчёта: он импортирует
 * ровно ту функцию, которой пользуется `MarketFinalizer`. Расхождение
 * означает дефект production-кода, а не расхождение двух реализаций.
 * Production-алгоритм при этом не меняется (никаких «checkpoint-режимов»).
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * npx tsx scripts/verify-twap-parity.mts data/mrb-soak
 * ```
 *
 * Выход: код 0 — расхождений нет; 1 — найдено расхождение официального и
 * теневого победителя (или структурное нарушение инварианта архива).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { deriveWinnerFromRecordedTwap } from '@polymarket/market-finalizer';
import type { PolymarketTwapRtdsFeed } from '@polymarket/polymarket-v2';

const ROOT = process.argv[2] ?? path.join('data', 'mrb-soak');

/** Разобранный архив рынка в объёме, нужном сверке. */
interface ArchiveFacts {
  readonly file: string;
  readonly question: string;
  readonly settlement:
    | { readonly symbol: string; readonly windowSeconds: 30 | 60; readonly resolutionSource: string }
    | undefined;
  readonly status: string | undefined;
  readonly winningLabel: string | undefined;
  readonly winningInstrumentId: string | undefined;
  readonly winningOutcomeIndex: number | undefined;
  readonly winningSource: string | undefined;
  readonly provenance: string | undefined;
  readonly fallbackTrigger: string | undefined;
  readonly officialPriceToBeat: string | undefined;
  readonly officialFinalPrice: string | undefined;
  readonly priceProvenance: { priceToBeat?: string; finalPrice?: string };
  readonly outcomes: ReadonlyArray<{ label: string; instrumentId: string }>;
  readonly marketStartMs: number | undefined;
  readonly marketEndMs: number | undefined;
  /** Записанные строки settlement-потока рынка. */
  readonly twapLines: readonly string[];
  /** Счётчики строк по topic (доказательство состава датасета). */
  readonly lineCounts: Record<string, number>;
}

/** Рекурсивно собирает завершённые архивы Polymarket. */
function listArchives(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listArchives(full));
    } else if (entry.name.endsWith('.jsonl.gz') && full.includes('polymarket')) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Разбирает архив: header + строки settlement-потока. */
function readArchive(file: string): ArchiveFacts {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const m = (header['m'] ?? {}) as Record<string, unknown>;
  const finalization = (m['finalization'] ?? {}) as Record<string, unknown>;
  const winning = finalization['winning'] as Record<string, unknown> | undefined;
  const provenance = (finalization['provenance'] ?? {}) as Record<string, unknown>;
  const crypto = (finalization['crypto'] ?? {}) as Record<string, unknown>;
  const marketCrypto = (m['crypto'] ?? {}) as Record<string, unknown>;
  const settlementRaw = marketCrypto['settlement'] as Record<string, unknown> | undefined;
  const timing = (m['timing'] ?? {}) as Record<string, unknown>;

  // Окно сужается ЯВНОЙ проверкой по vendor-домену: архив — внешние данные,
  // и «просто число» здесь принимать нельзя
  const rawWindow = settlementRaw?.['windowSeconds'];
  const windowSeconds: 30 | 60 | undefined =
    rawWindow === 30 ? 30 : rawWindow === 60 ? 60 : undefined;
  const settlement =
    settlementRaw !== undefined &&
    typeof settlementRaw['symbol'] === 'string' &&
    windowSeconds !== undefined
      ? {
          symbol: settlementRaw['symbol'],
          windowSeconds,
          resolutionSource: String(settlementRaw['resolutionSource'] ?? ''),
        }
      : undefined;

  const lineCounts: Record<string, number> = {};
  const twapLines: string[] = [];
  for (const line of lines.slice(1)) {
    let topic = 'unknown';
    try {
      topic = String((JSON.parse(line) as { topic?: unknown }).topic ?? 'unknown');
    } catch {
      topic = 'malformed';
    }
    lineCounts[topic] = (lineCounts[topic] ?? 0) + 1;
    if (topic === 'prices.crypto.chainlink.twap') {
      twapLines.push(line);
    }
  }

  const outcomesRaw = (finalization['outcomes'] ?? m['outcomes'] ?? []) as ReadonlyArray<
    Record<string, unknown>
  >;

  return {
    file,
    question: String(m['question'] ?? ''),
    settlement,
    status: finalization['status'] !== undefined ? String(finalization['status']) : undefined,
    winningLabel: winning !== undefined ? String(winning['label']) : undefined,
    winningInstrumentId:
      winning?.['instrumentId'] !== undefined ? String(winning['instrumentId']) : undefined,
    winningOutcomeIndex:
      typeof winning?.['outcomeIndex'] === 'number' ? winning['outcomeIndex'] : undefined,
    winningSource: winning?.['source'] !== undefined ? String(winning['source']) : undefined,
    provenance:
      provenance['resolution'] !== undefined ? String(provenance['resolution']) : undefined,
    fallbackTrigger:
      provenance['fallbackTrigger'] !== undefined
        ? String(provenance['fallbackTrigger'])
        : undefined,
    officialPriceToBeat:
      crypto['priceToBeat'] !== undefined ? String(crypto['priceToBeat']) : undefined,
    officialFinalPrice:
      crypto['finalPrice'] !== undefined ? String(crypto['finalPrice']) : undefined,
    priceProvenance: {
      ...(provenance['priceToBeat'] !== undefined
        ? { priceToBeat: String(provenance['priceToBeat']) }
        : {}),
      ...(provenance['finalPrice'] !== undefined
        ? { finalPrice: String(provenance['finalPrice']) }
        : {}),
    },
    outcomes: outcomesRaw.map((outcome) => ({
      label: String(outcome['label']),
      instrumentId: String(outcome['instrumentId']),
    })),
    marketStartMs: typeof timing['eventStartsAt'] === 'number' ? timing['eventStartsAt'] : undefined,
    marketEndMs: typeof timing['expiresAt'] === 'number' ? timing['expiresAt'] : undefined,
    twapLines,
    lineCounts,
  };
}

const archives = listArchives(ROOT).map(readArchive);
if (archives.length === 0) {
  console.log(`no Polymarket archives under ${ROOT}`);
  process.exit(0);
}

let violations = 0;
let compared = 0;
let matched = 0;

console.log(`\n=== ARCHIVE CONTENT (${String(archives.length)}) ===`);
for (const archive of archives) {
  console.log(`\n${path.basename(archive.file)}`);
  console.log(`  question: ${archive.question}`);
  console.log(
    `  settlement: ${
      archive.settlement === undefined
        ? '(none)'
        : `${archive.settlement.symbol} @ ${String(archive.settlement.windowSeconds)}s  ← ${archive.settlement.resolutionSource}`
    }`,
  );
  console.log(`  lines: ${JSON.stringify(archive.lineCounts)}`);
  console.log(
    `  finalization: status=${String(archive.status)} provenance=${String(archive.provenance)}` +
      `${archive.fallbackTrigger !== undefined ? ` trigger=${archive.fallbackTrigger}` : ''}`,
  );
  console.log(
    `  winner: label=${String(archive.winningLabel)} outcomeIndex=${String(archive.winningOutcomeIndex)}` +
      ` source=${String(archive.winningSource)} instrumentId=${String(archive.winningInstrumentId).slice(0, 18)}…`,
  );
  console.log(
    `  prices: priceToBeat=${String(archive.officialPriceToBeat)} (${archive.priceProvenance.priceToBeat ?? '-'})` +
      ` finalPrice=${String(archive.officialFinalPrice)} (${archive.priceProvenance.finalPrice ?? '-'})`,
  );

  // ── Инвариант архива (MR-B PART 49) ────────────────────────────────────
  if (archive.settlement !== undefined) {
    if (archive.winningLabel === undefined) {
      console.log('  ✗ VIOLATION: TWAP-архив без победителя');
      violations++;
    }
    if (archive.winningInstrumentId === undefined || archive.winningOutcomeIndex === undefined) {
      console.log('  ✗ VIOLATION: победитель без machine-usable identity');
      violations++;
    }
    if (archive.provenance === undefined) {
      console.log('  ✗ VIOLATION: нет resolution provenance');
      violations++;
    }
    if (archive.status === 'timeout') {
      console.log('  ✗ VIOLATION: timeout-статус у поддержанного TWAP-рынка');
      violations++;
    }
    if ((archive.lineCounts['prices.crypto.chainlink.twap'] ?? 0) === 0) {
      console.log('  ✗ VIOLATION: settlement-поток не записан в архив');
      violations++;
    }
  }

  // ── Теневая деривация (PART 79/80) ─────────────────────────────────────
  if (
    archive.settlement === undefined ||
    archive.marketStartMs === undefined ||
    archive.marketEndMs === undefined
  ) {
    continue;
  }
  const feed: PolymarketTwapRtdsFeed = {
    topic: 'prices.crypto.chainlink.twap',
    symbol: archive.settlement.symbol,
    windowSeconds: archive.settlement.windowSeconds,
  };
  // Теневой расчёт БЕЗ официального priceToBeat: именно так работал бы
  // fallback, если бы Gamma не дал вообще ничего
  const shadow = deriveWinnerFromRecordedTwap(
    archive.twapLines,
    feed,
    archive.marketStartMs,
    archive.marketEndMs,
  );
  if (shadow === undefined) {
    console.log('  shadow: деривация недоступна (границы не покрыты рядом)');
    continue;
  }
  const shadowOutcome = archive.outcomes.find((outcome) => outcome.label === shadow.label);
  console.log(
    `  shadow: label=${shadow.label} priceToBeat=${shadow.priceToBeat.value} finalPrice=${shadow.finalPrice.value} obs=${String(shadow.observations)}`,
  );

  if (archive.provenance !== 'official') {
    continue; // сверять теневой с самим собой смысла нет
  }
  compared++;
  const labelMatch = shadow.label === archive.winningLabel;
  const tokenMatch = shadowOutcome?.instrumentId === archive.winningInstrumentId;
  if (labelMatch && tokenMatch) {
    matched++;
    console.log('  ✓ PARITY: теневой итог совпал с официальным (label + instrumentId)');
  } else {
    violations++;
    console.log(
      `  ✗ PARITY MISMATCH: official=${String(archive.winningLabel)} shadow=${shadow.label}` +
        ` (instrumentId match: ${String(tokenMatch)})`,
    );
  }
  // Насколько близок финиш — такие рынки наиболее ценны (PART 81)
  if (archive.officialPriceToBeat !== undefined) {
    const gap = Math.abs(Number(shadow.finalPrice.value) - Number(archive.officialPriceToBeat));
    console.log(`  |finalPrice − priceToBeat| = ${gap.toFixed(4)}`);
  }
}

console.log('\n=== PARITY SUMMARY ===');
console.log(`archives: ${String(archives.length)}`);
console.log(`twap archives: ${String(archives.filter((a) => a.settlement !== undefined).length)}`);
console.log(`shadow-compared vs official: ${String(compared)}`);
console.log(`matched: ${String(matched)}`);
console.log(`violations: ${String(violations)}`);
process.exit(violations > 0 ? 1 : 0);

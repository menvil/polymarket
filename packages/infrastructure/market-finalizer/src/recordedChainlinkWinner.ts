/**
 * Приблизительная деривация победителя Up/Down-рынка из ЗАПИСАННОГО
 * chainlink-ряда (winner-ladder ступень `recorded-rtds`).
 *
 * @remarks
 * Применяется ТОЛЬКО когда официальных данных нет вообще (ни resolved
 * settlement-цен, ни `priceToBeat`/`finalPrice`) — решение user 2026-08-25:
 * «когда вообще ничего нет — скалькулировать из записанного и пометить,
 * что приблизительно».
 *
 * Аппроксимация official-формулы (`TWAP >= priceToBeat → Up`):
 * - `startValue` — первое записанное наблюдение с source-timestamp в окне
 *   рынка (fallback: последнее наблюдение ДО старта);
 * - `endValue` — среднее наблюдений последних 60 секунд окна (равномерный
 *   1 Гц каденс фида делает арифметическое среднее эквивалентом
 *   time-weighted; fallback: последнее наблюдение до expiry);
 * - `endValue >= startValue → Up`, иначе `Down` (tie = Up — правило
 *   description Up/Down-серий).
 *
 * Результат ВСЕГДА помечается `exact: false`: секундные тики — не
 * официальный оракульный TWAP, на близких финишах возможно расхождение.
 * Точность — Decimal-helpers vendor-boundary (`Number()` не используется).
 */
import { compareDecimalStrings, meanOfDecimalStrings } from '@polymarket/polymarket-v2';
import { decodeDetachedArchiveLine } from '@polymarket/raw-archive-format';

/** Длина финального окна аппроксимации TWAP (мс). */
const END_TWAP_WINDOW_MS = 60_000;

/** Итог приблизительной деривации из записанного ряда. */
export interface RecordedRtdsDerivation {
  /** Метка победителя по правилу `endValue >= startValue → Up`. */
  readonly label: 'Up' | 'Down';
  /** Значение-основание на старте окна (точная десятичная строка). */
  readonly startValue: string;
  /** Значение-основание на конце окна (среднее последних 60s). */
  readonly endValue: string;
  /** Количество распарсенных наблюдений ряда. */
  readonly observations: number;
}

/** Распарсенное наблюдение записанной строки chainlink-фида. */
interface ChainlinkObservation {
  readonly timestampMs: number;
  readonly value: string;
}

/**
 * Разбирает записанные payload-строки chainlink-фида в наблюдения.
 *
 * @param lines - Строки датасета (уже отфильтрованные по topic/symbol)
 * @returns Наблюдения, отсортированные по source-timestamp
 */
function parseObservations(lines: readonly string[]): ChainlinkObservation[] {
  const observations: ChainlinkObservation[] = [];
  for (const line of lines) {
    // Строки приходят из sealed-датасета УЖЕ без header-а, поэтому объявленный
    // формат недоступен: декодер снимает конверт V2 структурно, а legacy-строку
    // отдаёт как есть (см. decodeDetachedArchiveLine)
    const decoded = decodeDetachedArchiveLine(line);
    if (decoded === undefined) {
      continue; // малформированная строка: деривация best-effort
    }
    const parsed = decoded.payload as {
      topic?: unknown;
      payload?: { timestamp?: unknown; value?: unknown };
    } | null;
    if (parsed === null || parsed.topic !== 'prices.crypto.chainlink') {
      continue;
    }
    const timestampMs = parsed.payload?.timestamp;
    const value = parsed.payload?.value;
    if (typeof timestampMs !== 'number' || typeof value !== 'string' || value.length === 0) {
      continue;
    }
    observations.push({ timestampMs, value });
  }
  observations.sort((left, right) => left.timestampMs - right.timestampMs);
  return observations;
}

/**
 * Выводит приблизительного победителя из записанного chainlink-ряда.
 *
 * @param lines - Payload-строки chainlink-фида рынка (payload-инвариант:
 *   ровно то, что видел бы replay)
 * @param eventStartsAtMs - Официальный старт окна рынка (epoch ms)
 * @param expiresAtMs - Официальный конец окна рынка (epoch ms)
 * @returns Деривация с основаниями либо `undefined`, если ряд не позволяет
 *   вывести результат (нет наблюдений в нужных участках/не парсится)
 *
 * @example
 * ```typescript
 * const derived = deriveWinnerFromRecordedChainlink(lines, startMs, endMs);
 * // → { label: 'Up', startValue: '79299.54…', endValue: '79341.21…', observations: 954 }
 * ```
 */
export function deriveWinnerFromRecordedChainlink(
  lines: readonly string[],
  eventStartsAtMs: number,
  expiresAtMs: number,
): RecordedRtdsDerivation | undefined {
  if (expiresAtMs <= eventStartsAtMs) {
    return undefined;
  }
  const observations = parseObservations(lines);
  if (observations.length === 0) {
    return undefined;
  }

  // startValue: первое наблюдение внутри окна; fallback — последнее до старта
  const inWindow = observations.filter(
    (observation) =>
      observation.timestampMs >= eventStartsAtMs && observation.timestampMs < expiresAtMs,
  );
  const beforeStart = observations.filter(
    (observation) => observation.timestampMs < eventStartsAtMs,
  );
  const startValue = inWindow[0]?.value ?? beforeStart[beforeStart.length - 1]?.value;
  if (startValue === undefined) {
    return undefined;
  }

  // endValue: среднее последних 60s окна; fallback — последнее наблюдение до expiry
  const endWindow = inWindow.filter(
    (observation) => observation.timestampMs >= expiresAtMs - END_TWAP_WINDOW_MS,
  );
  const beforeExpiry = observations.filter(
    (observation) => observation.timestampMs < expiresAtMs,
  );
  const endValue =
    meanOfDecimalStrings(endWindow.map((observation) => observation.value)) ??
    beforeExpiry[beforeExpiry.length - 1]?.value;
  if (endValue === undefined) {
    return undefined;
  }

  const comparison = compareDecimalStrings(endValue, startValue);
  if (comparison === undefined) {
    return undefined;
  }
  return {
    label: comparison >= 0 ? 'Up' : 'Down',
    startValue,
    endValue,
    observations: observations.length,
  };
}

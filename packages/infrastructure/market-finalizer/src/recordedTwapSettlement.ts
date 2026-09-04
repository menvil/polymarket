/**
 * Deterministic-деривация итога Up/Down-рынка из ЗАПИСАННОГО settlement-ряда
 * Chainlink TWAP (winner-ladder ступень `recorded-twap`).
 *
 * @remarks
 * ### Правило рынка — измеренное, а не предположенное
 *
 * Live-характеризация 2026-08-26 (рынок `btc-updown-5m` 13:45–13:50Z,
 * фид `prices.crypto.chainlink.twap` / `btc/usd` / окно 60 с) показала
 * ТОЧНОЕ совпадение официальных чисел Gamma с наблюдениями потока:
 *
 * ```text
 * priceToBeat 78449.05813530706  == наблюдение с payload.timestamp == eventStartTime
 *                                   (78449.05813530705395712)
 * finalPrice  78400.7017548936   == наблюдение с payload.timestamp == endDate
 *                                   (78400.701754893592952832)
 * итог: finalPrice < priceToBeat → Down; Gamma резолвил Down=1 / Up=0
 * ```
 *
 * Отсюда правило деривации: значения берутся по ТОЧНОМУ vendor-timestamp
 * границ рынка, а сравнение — `finalPrice >= priceToBeat → Up` (tie = Up,
 * дословно из description серии).
 *
 * ### Почему точное совпадение, а не «ближайшее наблюдение»
 *
 * 1. Оракул берёт значение НА границе; соседняя секунда — уже другое число,
 *    и на близком финише оно способно перевернуть исход.
 * 2. Наблюдение на `end + 1s` в замере ДУБЛИРОВАЛО граничное значение —
 *    «ближайшее по времени» стало бы неоднозначным выбором из двух равных.
 *
 * Поэтому отсутствие граничного наблюдения — это «fallback недоступен», а
 * НЕ повод взять соседнее. Лучше не создать архив, чем создать архив с
 * победителем, которого рынок не присуждал.
 *
 * ### Источник данных — сам архив
 *
 * Читаются payload-строки ЗАМОРОЖЕННОГО датасета рынка, то есть ровно те,
 * которые увидит replay (MR-B PART 26): расчёт и архив опираются на ОДНО И
 * ТО ЖЕ наблюдение, скрытого второго источника не существует.
 *
 * Точность — Decimal-helpers vendor-boundary; `Number()`/`parseFloat()` не
 * используются нигде на этом пути.
 */
import { compareDecimalStrings, isFiniteDecimalString } from '@polymarket/polymarket-v2';
import type { PolymarketTwapRtdsFeed } from '@polymarket/polymarket-v2';
import { decodeDetachedArchiveLine } from '@polymarket/raw-archive-format';

/**
 * Наблюдение settlement-потока, использованное как основание итога.
 */
export interface TwapSettlementObservation {
  /** Vendor-timestamp наблюдения (epoch ms). */
  readonly timestampMs: number;
  /** Точная десятичная строка значения TWAP (как отдал SDK). */
  readonly value: string;
}

/** Итог deterministic-деривации из записанного settlement-ряда. */
export interface RecordedTwapDerivation {
  /** Метка победителя по правилу `finalPrice >= priceToBeat → Up`. */
  readonly label: 'Up' | 'Down';
  /** Наблюдение на ОТКРЫТИИ окна рынка (эталон `priceToBeat`). */
  readonly priceToBeat: TwapSettlementObservation;
  /**
   * Что ФАКТИЧЕСКИ послужило эталоном открытия.
   *
   * @remarks
   * Не «был ли передан официальный `priceToBeat`», а «был ли он
   * использован»: непригодное официальное значение (`"NaN"`, `"pending"`)
   * молча отбрасывается в пользу записанного наблюдения, и выдавать такой
   * результат за официальный нельзя — provenance существует ровно затем,
   * чтобы этого не происходило.
   */
  readonly priceToBeatSource: 'official' | 'recorded';
  /** Наблюдение на ЗАКРЫТИИ окна рынка (эталон `finalPrice`). */
  readonly finalPrice: TwapSettlementObservation;
  /** Сколько наблюдений фида нашлось в датасете. */
  readonly observations: number;
}

/**
 * Разбирает записанные payload-строки settlement-фида в наблюдения.
 *
 * @param lines - Строки датасета (уже отфильтрованные вызывающим)
 * @param feed - Settlement-фид рынка (symbol + окно)
 * @returns Наблюдения ТОЛЬКО этого фида, по возрастанию vendor-timestamp
 *
 * @remarks
 * Сверка `topic`/`symbol`/`windowSeconds` выполняется ПОВТОРНО по
 * содержимому строки: дешёвый строковый фильтр чтения мог пропустить
 * строку соседнего окна (подстрока `"windowSeconds":6` встречается и в
 * `60`, и в `6`), а перепутать окна здесь — значит посчитать итог не тем
 * потоком, которым рынок рассчитывается.
 */
function parseSettlementObservations(
  lines: readonly string[],
  feed: PolymarketTwapRtdsFeed,
): TwapSettlementObservation[] {
  const observations: TwapSettlementObservation[] = [];
  for (const line of lines) {
    // Строки приходят из sealed-датасета УЖЕ без header-а: конверт V2 снимается
    // структурно, legacy-строка отдаётся как есть (decodeDetachedArchiveLine)
    const decoded = decodeDetachedArchiveLine(line);
    if (decoded === undefined) {
      continue; // малформированная строка не может быть основанием
    }
    const parsed = decoded.payload as {
      topic?: unknown;
      payload?: {
        symbol?: unknown;
        timestamp?: unknown;
        value?: unknown;
        windowSeconds?: unknown;
      };
    } | null;
    if (parsed === null || parsed.topic !== feed.topic) {
      continue;
    }
    const payload = parsed.payload;
    if (
      payload?.symbol !== feed.symbol ||
      payload.windowSeconds !== feed.windowSeconds ||
      typeof payload.timestamp !== 'number' ||
      typeof payload.value !== 'string' ||
      payload.value.length === 0
    ) {
      continue;
    }
    observations.push({ timestampMs: payload.timestamp, value: payload.value });
  }
  observations.sort((left, right) => left.timestampMs - right.timestampMs);
  return observations;
}

/**
 * Находит наблюдение с ТОЧНО заданным vendor-timestamp.
 *
 * @param observations - Наблюдения фида
 * @param timestampMs - Граница рынка (epoch ms)
 * @returns Наблюдение либо `undefined`
 *
 * @remarks
 * Дубликаты одного timestamp дают одно и то же значение (поток
 * переопубликовывает то же число), поэтому первое совпадение достаточно.
 */
function observationAt(
  observations: readonly TwapSettlementObservation[],
  timestampMs: number,
): TwapSettlementObservation | undefined {
  return observations.find((observation) => observation.timestampMs === timestampMs);
}

/**
 * Выводит победителя Up/Down-рынка из записанного settlement-ряда TWAP.
 *
 * @param lines - Payload-строки датасета рынка
 * @param feed - Settlement-фид рынка (символ + окно из его дескриптора)
 * @param marketStartMs - Официальное открытие окна рынка (`eventStartTime`)
 * @param marketEndMs - Официальное закрытие окна рынка (`endDate`)
 * @param officialPriceToBeat - Официальный `priceToBeat`, если Gamma его уже
 *   дал: он ИМЕЕТ приоритет над записанным наблюдением открытия
 * @returns Деривация с обоими основаниями либо `undefined`, если хотя бы
 *   одно граничное наблюдение отсутствует/непригодно
 *
 * @remarks
 * Официальное значение никогда не подменяется записанным (MR-B PART 31):
 * если `officialPriceToBeat` передан и парсится, эталоном открытия
 * становится он, а записанное наблюдение открытия остаётся required —
 * его наличие доказывает, что ряд действительно покрывает окно рынка.
 *
 * @example
 * ```typescript
 * const derived = deriveWinnerFromRecordedTwap(
 *   lines,
 *   { topic: 'prices.crypto.chainlink.twap', symbol: 'btc/usd', windowSeconds: 60 },
 *   Date.parse('2026-08-26T13:45:00Z'),
 *   Date.parse('2026-08-26T13:50:00Z'),
 * );
 * // → { label: 'Down', priceToBeat: {…78449.058…}, finalPrice: {…78400.701…} }
 * ```
 */
export function deriveWinnerFromRecordedTwap(
  lines: readonly string[],
  feed: PolymarketTwapRtdsFeed,
  marketStartMs: number,
  marketEndMs: number,
  officialPriceToBeat?: string,
): RecordedTwapDerivation | undefined {
  if (!Number.isFinite(marketStartMs) || !Number.isFinite(marketEndMs)) {
    return undefined;
  }
  if (marketEndMs <= marketStartMs) {
    return undefined;
  }
  const observations = parseSettlementObservations(lines, feed);
  if (observations.length === 0) {
    return undefined;
  }

  const openObservation = observationAt(observations, marketStartMs);
  const closeObservation = observationAt(observations, marketEndMs);
  if (openObservation === undefined || closeObservation === undefined) {
    return undefined; // граница не покрыта рядом — деривация недоступна
  }

  // Официальный эталон открытия приоритетнее записанного (PART 31) — но
  // только если он ПРИГОДЕН: непригодное значение отбрасывается, и результат
  // обязан честно назваться выведенным
  const useOfficial =
    officialPriceToBeat !== undefined && isFiniteDecimalString(officialPriceToBeat);
  const priceToBeat: TwapSettlementObservation = useOfficial
    ? { timestampMs: openObservation.timestampMs, value: officialPriceToBeat }
    : openObservation;

  const comparison = compareDecimalStrings(closeObservation.value, priceToBeat.value);
  if (comparison === undefined) {
    return undefined; // нефинитные/непарсимые значения — итога нет
  }
  return {
    label: comparison >= 0 ? 'Up' : 'Down',
    priceToBeat,
    priceToBeatSource: useOfficial ? 'official' : 'recorded',
    finalPrice: closeObservation,
    observations: observations.length,
  };
}

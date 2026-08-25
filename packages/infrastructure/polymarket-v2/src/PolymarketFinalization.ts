/**
 * Vendor-boundary извлечение данных финализации рынка (N-004 PART 18/20/21).
 *
 * @remarks
 * ### Live-характеризация (2026-08-24, SDK 0.6.0, PART 62)
 *
 * Для завершившегося `btc-updown-5m-*` официальный SDK возвращает:
 *
 * - `fetchEvent().metadata` (vendor `eventMetadata`):
 *   `{"finalPrice": 78325.4503724296, "priceToBeat": 78027.33965248794}` —
 *   значения приходят как **JSON numbers** (typeof number);
 * - `fetchMarket().outcomes.{yes,no}.price` — **DecimalString**
 *   (`"1"`/`"0"` у resolved-рынка, `"0.995"`/`"0.005"` до резолюции);
 * - `fetchMarket().resolution.umaResolutionStatus` — `"resolved"` после
 *   резолюции (лаг ~1-6 мин после endDate), до неё `null`;
 * - `fetchMarket().state.closedTime` — строка НЕ-ISO формата
 *   (`"2026-08-24 11:41:25+00"`) — переносится как opaque vendor string.
 *
 * ### Точность (PART 19)
 *
 * Числовые значения НЕ конвертируются в JS number для проверок/сравнений:
 * vendor JSON number сериализуется его точным десятичным представлением
 * (`String(n)` — exact shortest round-trip double), vendor-строки проходят
 * as-is. `Number(...)`/`parseFloat(...)` не используются. Сравнение
 * settlement-цен выполняется через `Decimal`, без потери точности.
 *
 * ### Vendor yes/no (PART 20)
 *
 * SDK именует свойства первого/второго binary-исхода `yes`/`no` даже когда
 * реальные labels — `Up`/`Down`; эти имена свойств не покидают данный
 * маппинг — наружу уходит нейтральный список исходов с canonical
 * `InstrumentId`.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal-сравнение settlement-цен на vendor-границе без потери точности (см. remarks)
import Decimal from 'decimal.js';
import type { Market } from '@polymarket/bindings/gamma';
import { asInstrumentId } from '@polymarket/ids';
import type { InstrumentId } from '@polymarket/ids';

/**
 * Официальные крипто-значения финализации из Gamma `Event.metadata`.
 *
 * @remarks
 * Значения — точные десятичные строки vendor-представления (JSON-safe,
 * precision-preserving). Отсутствие поля означает, что Gamma его ещё не
 * опубликовал (priceToBeat появляется после старта события, finalPrice —
 * после его конца).
 */
export interface PolymarketCryptoFinalization {
  /** Официальный strike price (`eventMetadata.priceToBeat`). */
  readonly priceToBeat?: string;
  /** Официальная финальная цена (`eventMetadata.finalPrice`). */
  readonly finalPrice?: string;
}

/**
 * Финальный исход рынка в нейтральной форме (без vendor yes/no).
 */
export interface PolymarketFinalOutcome {
  /** Метка исхода как её отдал SDK (`Up`/`Down`/`Yes`/...). */
  readonly label: string;
  /** Canonical identity инструмента исхода. */
  readonly instrumentId: InstrumentId;
  /** Цена исхода (vendor DecimalString as-is; отсутствует, если Gamma не дал). */
  readonly price?: string;
}

/**
 * Приводит vendor-значение metadata к точной десятичной строке.
 *
 * @param value - Значение `Event.metadata[key]` (характеризовано: number)
 * @returns Точная строка либо `undefined`, если значение отсутствует/непригодно
 */
function toExactDecimalString(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Извлекает крипто-данные финализации из Gamma `Event.metadata`.
 *
 * @param metadata - `Event.metadata` официального SDK (может отсутствовать)
 * @returns Typed-результат с точными строковыми значениями; поля
 *   отсутствуют, пока Gamma их не опубликовал
 *
 * @remarks
 * ЕДИНСТВЕННОЕ место чтения `metadata['priceToBeat']`/`metadata['finalPrice']`
 * (PART 18) — finalizer/бектест по этим ключам в vendor-объект не лезут.
 *
 * @example
 * ```typescript
 * const crypto = extractCryptoFinalization(freshEvent.metadata);
 * const complete = crypto.priceToBeat !== undefined && crypto.finalPrice !== undefined;
 * ```
 */
export function extractCryptoFinalization(
  metadata: Record<string, unknown> | null | undefined,
): PolymarketCryptoFinalization {
  if (metadata === null || metadata === undefined) {
    return {};
  }
  const priceToBeat = toExactDecimalString(metadata['priceToBeat']);
  const finalPrice = toExactDecimalString(metadata['finalPrice']);
  return {
    ...(priceToBeat !== undefined ? { priceToBeat } : {}),
    ...(finalPrice !== undefined ? { finalPrice } : {}),
  };
}

/**
 * Маппирует исходы normalized Market в нейтральный финальный список.
 *
 * @param market - Normalized Market официального SDK (обычно СВЕЖИЙ fetch)
 * @returns Исходы в vendor-порядке с canonical identity и точными ценами
 *
 * @remarks
 * Vendor mapping boundary: `outcomes.yes`/`outcomes.no` читаются только
 * здесь; исход без CLOB-токена или с невалидным InstrumentId опускается
 * (подписать/зачесть его всё равно нельзя).
 */
export function mapFinalOutcomes(
  market: Pick<Market, 'outcomes'>,
): readonly PolymarketFinalOutcome[] {
  const sdkOutcomes = [market.outcomes.yes, market.outcomes.no];
  const outcomes: PolymarketFinalOutcome[] = [];
  for (const sdkOutcome of sdkOutcomes) {
    if (sdkOutcome.tokenId === null) {
      continue;
    }
    const instrumentId = asInstrumentId(String(sdkOutcome.tokenId));
    if (instrumentId === undefined) {
      continue;
    }
    const price = sdkOutcome.price;
    outcomes.push({
      label: sdkOutcome.label,
      instrumentId,
      ...(price !== null && price !== undefined ? { price: String(price) } : {}),
    });
  }
  return outcomes;
}

/**
 * Выводит победивший исход ТОЛЬКО при однозначных settlement-ценах.
 *
 * @param outcomes - Финальные исходы ({@link mapFinalOutcomes})
 * @param umaResolutionStatus - `resolution.umaResolutionStatus` свежего Market
 * @returns Победивший исход либо `undefined`, если результат неоднозначен
 *
 * @remarks
 * Правило (характеризовано live, PART 21): рынок resolved И ровно один
 * исход имеет цену, Decimal-равную 1, а ВСЕ остальные — Decimal-равную 0.
 * Никаких эвристик вида `price > 0.9`/«первый исход = UP»: до резолюции
 * цены вида `0.995` победителя НЕ дают. Settlement truth не придумывается.
 */
export function deriveWinningOutcome(
  outcomes: readonly PolymarketFinalOutcome[],
  umaResolutionStatus: string | null | undefined,
): PolymarketFinalOutcome | undefined {
  if (umaResolutionStatus !== 'resolved' || outcomes.length === 0) {
    return undefined;
  }
  let winner: PolymarketFinalOutcome | undefined;
  for (const outcome of outcomes) {
    if (outcome.price === undefined) {
      return undefined; // неполные цены — результат неоднозначен
    }
    let price: Decimal;
    try {
      price = new Decimal(outcome.price);
    } catch {
      return undefined;
    }
    if (price.equals(1)) {
      if (winner !== undefined) {
        return undefined; // два «победителя» — неоднозначно
      }
      winner = outcome;
    } else if (!price.equals(0)) {
      return undefined; // не-settlement цена — неоднозначно
    }
  }
  return winner;
}

/**
 * Выводит победителя Up/Down-рынка по официальным крипто-ценам Gamma.
 *
 * @param outcomes - Финальные исходы ({@link mapFinalOutcomes})
 * @param crypto - Официальные значения `priceToBeat`/`finalPrice`
 * @returns Победивший исход либо `undefined`, если деривация неприменима
 *
 * @remarks
 * Ступень 2 winner-ladder (после {@link deriveWinningOutcome}): применяет
 * ПРАВИЛО САМОГО РЫНКА к официальным числам оракула — из них же следует
 * UMA-резолюция. Правило (текст description «Up or Down»-серий,
 * подтверждено live 2026-08-25): *«resolve to "Up" if … greater than
 * **or equal to** [price to beat], otherwise "Down"»* — то есть
 * `finalPrice >= priceToBeat → Up` (tie = Up).
 *
 * Guards (лучше отсутствие победителя, чем неверный):
 * - ровно два исхода с метками строго `Up`/`Down` (правило других серий
 *   может отличаться — на них деривация не распространяется);
 * - обе цены присутствуют и парсятся Decimal-ом (без `Number()` — политика
 *   точности модуля).
 *
 * @example
 * ```typescript
 * const winner = deriveWinnerFromCryptoPrices(outcomes, {
 *   priceToBeat: '79233.50451521577',
 *   finalPrice: '79237.63456493833',
 * }); // → исход с label 'Up'
 * ```
 */
export function deriveWinnerFromCryptoPrices(
  outcomes: readonly PolymarketFinalOutcome[],
  crypto: PolymarketCryptoFinalization,
): PolymarketFinalOutcome | undefined {
  if (crypto.priceToBeat === undefined || crypto.finalPrice === undefined) {
    return undefined;
  }
  if (outcomes.length !== 2) {
    return undefined;
  }
  const up = outcomes.find((outcome) => outcome.label === 'Up');
  const down = outcomes.find((outcome) => outcome.label === 'Down');
  if (up === undefined || down === undefined) {
    return undefined;
  }
  let priceToBeat: Decimal;
  let finalPrice: Decimal;
  try {
    priceToBeat = new Decimal(crypto.priceToBeat);
    finalPrice = new Decimal(crypto.finalPrice);
  } catch {
    return undefined;
  }
  return finalPrice.gte(priceToBeat) ? up : down;
}

/**
 * Сравнивает два точных десятичных строковых значения.
 *
 * @param left - Левое значение (десятичная строка)
 * @param right - Правое значение (десятичная строка)
 * @returns `-1` | `0` | `1` либо `undefined`, если строки не парсятся
 *
 * @remarks
 * Экспортируемый Decimal-helper vendor-boundary: потребители (например,
 * приблизительная деривация победителя из записанного RTDS в finalizer-е)
 * не тянут собственную зависимость decimal.js и не используют `Number()`.
 */
export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 | undefined {
  try {
    const result = new Decimal(left).comparedTo(new Decimal(right));
    return result === 0 ? 0 : result > 0 ? 1 : -1;
  } catch {
    return undefined;
  }
}

/**
 * Среднее арифметическое точных десятичных строковых значений.
 *
 * @param values - Непустой список десятичных строк
 * @returns Точная строка среднего либо `undefined` (пустой список/не парсится)
 *
 * @remarks
 * Для аппроксимации TWAP по равномерному (1 Гц) ряду наблюдений
 * записанного RTDS: равномерный каденс делает арифметическое среднее
 * эквивалентом time-weighted среднего.
 */
export function meanOfDecimalStrings(values: readonly string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }
  try {
    let sum = new Decimal(0);
    for (const value of values) {
      sum = sum.plus(new Decimal(value));
    }
    return sum.div(values.length).toString();
  } catch {
    return undefined;
  }
}

/**
 * MarketSnapshot — доменно-типизированный data carrier канонического Market
 *
 * @remarks
 * Чистый тип данных: без методов, без доменной логики, все поля readonly.
 * Использует canonical VO (`MarketId`, `VenueId`, `Timestamp`, `InstrumentId`,
 * `MarketState`), а не примитивы — на границе Domain/Application типы не
 * деградируют обратно в строки и числа.
 *
 * ### Два разных «представления» и зачем нужны оба
 * ```text
 * MarketSnapshot — доменные типы, in-memory (Market ⇄ snapshot)
 * MarketJSON     — примитивы, wire/БД (см. MarketJSON.ts)
 * ```
 *
 * ### Pipeline из сериализованных данных
 * ```text
 * unknown JSON → MarketParser.from() → MarketSnapshot → Market.fromSnapshot() → Market
 * ```
 *
 * ### Round-trip in-memory
 * ```text
 * Market → MarketViewModel.toSnapshot() → MarketSnapshot → Market.fromSnapshot() → Market
 * ```
 *
 * @example
 * ```typescript
 * const snapshot = MarketViewModel.toSnapshot(market);
 * const restored = Market.fromSnapshot(snapshot);
 * ```
 */

import type { Timestamp } from '@polymarket/timestamp';
import type { MarketId, VenueId } from '@polymarket/ids';
import type { MarketSlug } from '../value-objects/MarketSlug.js';
import type { MarketState } from '../value-objects/MarketState.js';
import type { MarketOutcome } from '../value-objects/MarketOutcome.js';
import type { MarketFamily } from '../value-objects/MarketFamily.js';
import type { CryptoUpDownSpec } from '../value-objects/MarketSpec.js';

/**
 * MarketSnapshot — доменно-типизированное представление состояния рынка
 *
 * @remarks
 * Структурно идентичен `MarketProps` — поэтому `Market.fromSnapshot()`
 * сводится к `Market.create(snapshot)` без промежуточных преобразований.
 */
export interface MarketSnapshot {
  /** Идентификатор рынка в пространстве имён площадки */
  readonly id: MarketId;
  /** Площадка, на которой наблюдается рынок */
  readonly venueId: VenueId;
  /** URL-safe слаг рынка, если площадка его публикует */
  readonly slug?: MarketSlug;
  /** Вопрос рынка */
  readonly question: string;
  /** Запланированное начало торгов */
  readonly startsAt: Timestamp;
  /** Запланированное окончание торгов */
  readonly expiresAt: Timestamp;
  /** Подтверждённое внешнее состояние рынка */
  readonly state: MarketState;
  /** Исходы рынка: ровно два */
  readonly outcomes: readonly [MarketOutcome, MarketOutcome];
  /** Семейство рынка */
  readonly family: MarketFamily;
  /** Спецификация семейства `CRYPTO_UP_DOWN` */
  readonly crypto?: CryptoUpDownSpec;
}

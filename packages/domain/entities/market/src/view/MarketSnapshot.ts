/**
 * MarketSnapshot — доменно-типизированный data carrier для Market entity
 *
 * @remarks
 * Чистый тип данных без методов и доменной логики.
 * Использует доменные типы (MarketId, MarketSlug, OutcomeToken, MarketState) — не строки.
 *
 * ### Применение:
 * - Промежуточный тип в pipeline реконструкции из внешних источников
 * - In-memory представление для round-trip (Market → snapshot → Market)
 *
 * ### Pipeline из внешних данных (JSON → Market):
 * ```
 * raw JSON → MarketParser.from() → MarketSnapshot → Market.fromSnapshot() → Market
 * ```
 *
 * ### Round-trip из Market (in-memory):
 * ```
 * Market → MarketViewModel.toSnapshot() → MarketSnapshot → Market.fromSnapshot() → Market
 * ```
 *
 * @example
 * ```typescript
 * // Market → snapshot (сериализация)
 * const snapshot = MarketViewModel.toSnapshot(market);
 *
 * // snapshot → Market (реконструкция)
 * const marketResult = Market.fromSnapshot(snapshot);
 * ```
 */

import type { MarketId } from '@polymarket/ids';
import type { OutcomeToken } from '@polymarket/value-objects/outcome-token';
import type { MarketSlug } from '../value-objects/MarketSlug.js';
import type { MarketState } from '../value-objects/MarketState.js';

/**
 * MarketSnapshot — доменно-типизированный data carrier состояния рынка
 *
 * @remarks
 * Структурно идентичен MarketProps — поэтому Market.fromSnapshot() = Market.create(snapshot).
 * Все поля readonly, нет методов.
 */
export interface MarketSnapshot {
  /** Идентификатор рынка */
  readonly id: MarketId;
  /** URL-safe слаг */
  readonly slug: MarketSlug;
  /** Вопрос рынка */
  readonly question: string;
  /** Исходы рынка */
  readonly outcomes: readonly [
    { readonly token: OutcomeToken; readonly index: 0; readonly name: string },
    { readonly token: OutcomeToken; readonly index: 1; readonly name: string },
  ];
  /** Время истечения в миллисекундах (Unix timestamp) */
  readonly expirationMs: number;
  /** Состояние рынка */
  readonly state: MarketState;
}

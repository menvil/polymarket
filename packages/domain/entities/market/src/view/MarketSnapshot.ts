/**
 * MarketSnapshot — plain-object представление Market для персистентности
 *
 * @remarks
 * Чистый тип данных без доменной логики.
 * Все поля — примитивы, совместимые с JSON.
 *
 * ### Применение:
 * - Хранение в БД / Redis / localStorage
 * - Передача по API
 * - Промежуточный тип в pipeline реконструкции
 *
 * ### Pipeline реконструкции:
 * ```
 * raw → MarketParser.from() → MarketSnapshot → Market.fromSnapshot() → Market
 * ```
 *
 * @example
 * ```typescript
 * // Market → snapshot (сериализация)
 * const snapshot = MarketViewModel.toSnapshot(market);
 * await db.save(snapshot);
 *
 * // raw → MarketSnapshot → Market (реконструкция)
 * const snapshotResult = MarketParser.from(await db.load(id));
 * if (snapshotResult.ok) {
 *   const market = Market.fromSnapshot(snapshotResult.value);
 * }
 * ```
 */

import type { OutcomeTokenJSON } from '@polymarket/value-objects/outcome-token';

/**
 * MarketSnapshot — сериализованное состояние рынка
 */
export interface MarketSnapshot {
  /** Идентификатор рынка */
  readonly id: string;
  /** URL-safe слаг */
  readonly slug: string;
  /** Вопрос рынка */
  readonly question: string;
  /** Исходы рынка */
  readonly outcomes: readonly [
    { readonly token: OutcomeTokenJSON; readonly index: 0; readonly name: string },
    { readonly token: OutcomeTokenJSON; readonly index: 1; readonly name: string },
  ];
  /** Дата истечения в ISO 8601 */
  readonly expirationDate: string;
  /** Состояние рынка */
  readonly state:
    | { readonly status: 'ACTIVE' }
    | { readonly status: 'CLOSED' }
    | { readonly status: 'RESOLVED'; readonly resolvedOutcomeIndex: 0 | 1 };
}

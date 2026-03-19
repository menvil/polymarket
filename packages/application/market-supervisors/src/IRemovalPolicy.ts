/**
 * Политика удаления рынков.
 *
 * @remarks
 * `IRemovalPolicy` — Strategy pattern для определения, какие рынки закрывать.
 * Координатор передаёт список активных рынков в политику, политика возвращает
 * список рынков для закрытия.
 *
 * ### Встроенные реализации:
 * - `ExpirationRemovalPolicy` — закрывает рынки по истечении срока
 *
 * ### Расширение:
 * Новые политики реализуют `IRemovalPolicy` и передаются в `MarketExpiryMonitor`.
 */
import type { MarketId } from '@polymarket/ids';
import type { Timestamp, Money } from '@polymarket/value-objects';

/**
 * Контекст активного рынка для оценки политикой.
 *
 * @remarks
 * Содержит все данные, необходимые для принятия решения о закрытии рынка.
 */
export interface MarketContext {
  /** ID рынка */
  readonly marketId: MarketId;
  /** Время истечения рынка (когда рынок закрывается на бирже) */
  readonly expiresAt: Timestamp;
  /** Аллоцированный баланс для рынка */
  readonly allocatedBalance: Money;
  /** Реализованный PnL за время торговли */
  readonly realizedPnL: Money;
  /** Количество открытых ордеров */
  readonly openOrdersCount: number;
}

/**
 * Политика удаления рынков.
 *
 * @example
 * ```typescript
 * class RiskRemovalPolicy implements IRemovalPolicy {
 *   evaluate(markets: readonly MarketContext[]): readonly MarketId[] {
 *     return markets
 *       .filter(m => m.realizedPnL.value().lessThan(-100))
 *       .map(m => m.marketId);
 *   }
 * }
 * ```
 */
export interface IRemovalPolicy {
  /**
   * Определяет, какие рынки нужно закрыть.
   *
   * @param markets - Список активных рынков
   * @returns Список ID рынков для закрытия (может быть пустым)
   *
   * @remarks
   * Должен быть чистым и быстрым (не делать I/O).
   */
  evaluate(markets: readonly MarketContext[]): readonly MarketId[];
}

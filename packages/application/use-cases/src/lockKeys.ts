/**
 * Namespaced lock-key helpers для `IKeyedMutex`.
 *
 * @remarks
 * Раньше lock-ключи были plain strings (`accountIdToString(id)`, `String(orderId)`,
 * `String(instrumentId)`). Без namespace возможна ложная коллизия: если
 * `String(orderId) === String(instrumentId)` для разных сущностей, два несвязанных
 * lock-набора пересеклись бы и сериализовались зря (или, хуже, пересечение по
 * accountId было бы неотличимо от пересечения по orderId).
 *
 * Namespace-префиксы (`account:` / `order:` / `instrument:`) гарантируют, что
 * ключи пересекаются ТОЛЬКО когда относятся к одной и той же сущности одного типа.
 *
 * ### Пересечения lock-наборов (сохранены):
 * - Place:  `[account, instrument]`
 * - Fill:   `[account, order, instrument]`
 * - Cancel: `[account, order, instrument]`
 * - Update: `[account, order]` (+ instrument если доступен)
 *
 * Все наборы включают `account:*`, поэтому операции одного аккаунта сериализуются;
 * order/instrument сужают до конкретного ордера/инструмента.
 */
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import { accountIdToString } from '@polymarket/ids';

/** Namespaced lock-key фабрики. */
export const lockKey = {
  /** `account:<canonical accountId>` */
  account: (id: AccountId): string => `account:${accountIdToString(id)}`,
  /** `order:<orderId>` */
  order: (id: OrderId): string => `order:${String(id)}`,
  /** `instrument:<instrumentId>` */
  instrument: (id: InstrumentId | string): string => `instrument:${String(id)}`,
} as const;

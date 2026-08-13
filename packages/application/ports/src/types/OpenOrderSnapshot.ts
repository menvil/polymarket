/**
 * Снимок открытого ордера от биржи.
 *
 * @remarks
 * Используется `IExchangeClient.getOpenOrders()` для получения списка открытых ордеров.
 * Является read-only проекцией состояния ордера на бирже в конкретный момент времени.
 *
 * Отличие от доменного `Order`:
 * - `OpenOrderSnapshot` — flat DTO от биржи (infrastructure boundary)
 * - `Order` — доменный агрегат с историей состояния
 *
 * Используется в:
 * - `ReconcileOrdersUseCase` — сверка локальных ордеров с биржевыми
 */
import type { OrderId, AssetId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import type { AccountId } from '@polymarket/ids';

/**
 * Снимок открытого ордера от биржи (read-only projection).
 *
 * @example
 * ```typescript
 * const snapshot: OpenOrderSnapshot = {
 *   orderId: asOrderId('venue:POLYMARKET:abc123'),
 *   accountId: parseAccountId('venue:POLYMARKET:0x...'),
 *   asset: { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'abc' },
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   filledSize: Quantity.of(new Decimal('30')),
 *   status: 'PARTIALLY_FILLED',
 *   createdAt: timestamp,
 * };
 * ```
 */
export interface OpenOrderSnapshot {
  /** ID ордера на бирже */
  readonly orderId: OrderId;
  /** ID аккаунта владельца */
  readonly accountId: AccountId;
  /** Токен для торговли */
  readonly asset: AssetId;
  /** Сторона ордера */
  readonly side: Side;
  /** Цена ордера */
  readonly price: Price;
  /** Полный объём ордера */
  readonly size: Quantity;
  /** Исполненный объём */
  readonly filledSize: Quantity;
  /** Статус ордера (только открытые состояния) */
  readonly status: 'OPEN' | 'PARTIALLY_FILLED';
  /** Время создания ордера */
  readonly createdAt: Timestamp;
}

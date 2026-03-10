/**
 * Снимок исполнения сделки от биржи.
 *
 * @remarks
 * Используется `IExchangeClient.getTrades()` для получения списка исполненных сделок.
 * Является read-only проекцией fill-события на бирже.
 *
 * Имя `VenueTradeSnapshot` выбрано намеренно, чтобы не конфликтовать с доменным
 * `TradeSnapshot` из `@polymarket/trade` (market print vs our execution).
 *
 * Используется в:
 * - `ReconcileTradesUseCase` — сверка исполнений с локальными записями
 */
import type { FillId, OrderId, AssetId, AccountId, MarketId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';

/**
 * Снимок комиссии внутри VenueTradeSnapshot.
 */
export interface FeeSnapshot {
  /** Размер комиссии */
  readonly amount: Quantity;
  /** Актив комиссии */
  readonly asset: AssetId;
}

/**
 * Снимок исполненной сделки от биржи (read-only projection).
 *
 * @example
 * ```typescript
 * const snapshot: VenueTradeSnapshot = {
 *   fillId: asFillId('fill:abc123'),
 *   orderId: asOrderId('venue:POLYMARKET:abc123'),
 *   accountId: parseAccountId('venue:POLYMARKET:0x...'),
 *   asset: { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'abc' },
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('30')),
 *   fee: { amount: Quantity.of(new Decimal('0.1')), asset: usdcAssetId },
 *   executedAt: timestamp,
 * };
 * ```
 */
export interface VenueTradeSnapshot {
  /** Уникальный ID исполнения */
  readonly fillId: FillId;
  /** ID родительского ордера */
  readonly orderId: OrderId;
  /** ID аккаунта трейдера */
  readonly accountId: AccountId;
  /** ID рынка (condition_id) */
  readonly marketId: MarketId;
  /** Токен для торговли */
  readonly asset: AssetId;
  /** Сторона сделки */
  readonly side: Side;
  /** Цена исполнения */
  readonly price: Price;
  /** Объём исполнения */
  readonly size: Quantity;
  /** Комиссия сделки */
  readonly fee: FeeSnapshot;
  /** Время исполнения */
  readonly executedAt: Timestamp;
}

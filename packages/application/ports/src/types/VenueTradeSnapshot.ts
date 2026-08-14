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
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

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
 * Статус сделки на блокчейне.
 *
 * @remarks
 * Жизненный цикл fill на Polygon:
 * - `MATCHED`   — fill передан executor service (матчер подтвердил), НЕ on-chain
 * - `MINED`     — транзакция включена в блок, но finality не достигнута
 * - `CONFIRMED` — finality достигнута, токены реально в кошельке ✓
 * - `RETRYING`  — транзакция упала, executor повторяет
 * - `FAILED`    — транзакция окончательно не прошла, токены НЕ переданы
 */
export type VenueTradeStatus = 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';

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
  /**
   * On-chain статус сделки.
   *
   * @remarks
   * Только `CONFIRMED` гарантирует что токены реально в кошельке — для live-processing
   * через `FillOrchestrator`/`ProcessFillUseCase` `MATCHED` считается «рано» и не должен
   * применяться к Portfolio до подтверждения.
   *
   * Исключение: `ReconcileTradesUseCase` (сверка после рестарта) намеренно обрабатывает
   * И `CONFIRMED`, И `MATCHED` — чтобы не потерять fill, если MATCHED пришёл через WS
   * до рестарта, а CONFIRMED ещё не наступил (race condition при recovery). Это осознанное
   * исключение из общего правила «MATCHED ещё рано», а не расхождение с контрактом.
   *
   * `undefined` — статус не был возвращён биржей (старый API).
   */
  readonly status?: VenueTradeStatus;
}

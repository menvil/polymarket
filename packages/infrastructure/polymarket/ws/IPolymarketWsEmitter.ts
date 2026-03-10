/**
 * IPolymarketWsEmitter — контракт для подписки на raw WS-события Polymarket.
 *
 * @remarks
 * Намеренно raw — без доменной обработки.
 * Передаёт типизированные DTO напрямую из wire-формата Polymarket.
 *
 * ### Принципы:
 * - Каждый метод регистрирует callback и возвращает unsubscribe-функцию.
 * - Callbacks асинхронны (`Promise<void>`) — адаптер await-ит их при dispatch.
 * - Polymarket orderbook channel шлёт ТОЛЬКО полные снапшоты ('book' events).
 *   'price_change' events — batch-уведомления о ценах, не дельты стакана.
 *   `onOrderbookDelta()` отсутствует намеренно.
 *
 * ### Поток данных:
 * ```
 * PolymarketWsClient (raw bytes)
 *   → WsMessageMapper.parseWsMessage()  (raw → DTO)
 *   → IPolymarketWsEmitter.dispatch()   (DTO → callbacks)
 *   → MarketDataFeedAdapter             (Phase 8 bridge)
 *   → BookUpdateHandler / FillEventHandler (Phase 3)
 * ```
 *
 * @example
 * ```typescript
 * const unsub = emitter.onOrderbookSnapshot(async (dto) => {
 *   await handler.handleFullState(dto.market, dto.asset_id, dto.bids, dto.asks);
 * });
 *
 * // Позже при cleanup:
 * unsub();
 * ```
 */

import type { WsOrderbookSnapshotDto } from './dto/WsOrderbookDto.js';
import type { WsTradeDto } from './dto/WsTradeDto.js';
import type { WsUserFillDto, WsOrderUpdateDto } from './dto/WsUserEventDto.js';

/**
 * Контракт raw event emitter для Polymarket WebSocket.
 *
 * @remarks
 * Реализуется `PolymarketWsAdapter`.
 * Bridge-адаптеры (MarketDataFeedAdapter, UserEventFeedAdapter) из Phase 8
 * подписываются через этот интерфейс.
 */
export interface IPolymarketWsEmitter {
  /**
   * Полный снапшот стакана (type='book').
   *
   * @param cb - Callback для обработки снапшота
   * @returns Функция отписки
   *
   * @remarks
   * Polymarket шлёт периодически — это единственный тип обновлений стакана.
   */
  onOrderbookSnapshot(cb: (dto: WsOrderbookSnapshotDto) => Promise<void>): () => void;

  /**
   * Публичный трейд (type='trade').
   *
   * @param cb - Callback для обработки трейда
   * @returns Функция отписки
   */
  onTradeEvent(cb: (dto: WsTradeDto) => Promise<void>): () => void;

  /**
   * Fill из user-channel (исполнение нашего ордера).
   *
   * @param cb - Callback для обработки fill
   * @returns Функция отписки
   */
  onUserFill(cb: (dto: WsUserFillDto) => Promise<void>): () => void;

  /**
   * Обновление статуса ордера из user-channel.
   *
   * @param cb - Callback для обработки обновления
   * @returns Функция отписки
   */
  onOrderUpdate(cb: (dto: WsOrderUpdateDto) => Promise<void>): () => void;

  /**
   * Событие reconnect — BookUpdateHandler должен инвалидировать кэш стаканов.
   *
   * @param cb - Callback без аргументов
   * @returns Функция отписки
   */
  onReconnect(cb: () => void): () => void;
}

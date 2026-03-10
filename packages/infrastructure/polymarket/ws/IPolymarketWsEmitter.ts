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
 * ### Два канала:
 * - **Market channel** (`type: 'market'`): orderbook snapshots + public trades. Без аутентификации.
 * - **User channel** (`type: 'user'`): fills конкретного трейдера + order lifecycle. Требует API-ключ.
 *   Активируется через `subscribeUserChannel(config)`.
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
 * // User channel:
 * await emitter.subscribeUserChannel({ apiKey: '...', secret: '...', passphrase: '...' });
 * emitter.onUserFill(async (dto) => { ... });
 *
 * // Позже при cleanup:
 * unsub();
 * ```
 */

import type { WsOrderbookSnapshotDto } from './dto/WsOrderbookDto.js';
import type { WsTradeDto } from './dto/WsTradeDto.js';
import type { WsUserFillDto, WsOrderUpdateDto } from './dto/WsUserEventDto.js';

/**
 * Конфигурация для аутентификации в Polymarket user channel.
 *
 * @remarks
 * User channel требует подписи API-ключом.
 * Credentials передаются в subscription message как поле `auth`.
 *
 * @example
 * ```typescript
 * const config: UserChannelConfig = {
 *   apiKey: 'your-api-key',
 *   secret: 'your-api-secret',
 *   passphrase: 'your-passphrase',
 * };
 * await emitter.subscribeUserChannel(config);
 * ```
 */
export interface UserChannelConfig {
  /** Polymarket API key */
  readonly apiKey: string;
  /** Polymarket API secret (для подписи запроса) */
  readonly secret: string;
  /** Polymarket API passphrase */
  readonly passphrase: string;
}

/**
 * Контракт raw event emitter для Polymarket WebSocket.
 *
 * @remarks
 * Реализуется `PolymarketWsAdapter`.
 * Bridge-адаптеры (MarketDataFeedAdapter, UserEventFeedAdapter) из Phase 8
 * подписываются через этот интерфейс.
 *
 * Для получения fill/order событий — вызовите `subscribeUserChannel()` после connect().
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

  /**
   * Подписывается на Polymarket user channel (fills + order lifecycle).
   *
   * @param config - Credentials для аутентификации в user channel
   * @returns Promise, который разрешается после отправки subscription message
   *
   * @remarks
   * User channel передаёт:
   * - `event_type: "trade"` с `taker_order_id` → WsUserFillDto (callback: onUserFill)
   * - `event_type: "order"` → WsOrderUpdateDto (callback: onOrderUpdate)
   *
   * Subscription message формат:
   * ```json
   * { "type": "user", "auth": { "apiKey": "...", "secret": "...", "passphrase": "..." } }
   * ```
   *
   * Вызывать после `connect()`. При reconnect — переподписка происходит автоматически.
   *
   * @throws {Error} Если адаптер уничтожен
   *
   * @example
   * ```typescript
   * await emitter.connect();
   * await emitter.subscribeUserChannel({ apiKey, secret, passphrase });
   * emitter.onUserFill(async (dto) => {
   *   await fillHandler.handle(dto, accountId);
   * });
   * ```
   */
  subscribeUserChannel(config: UserChannelConfig): Promise<void>;
}

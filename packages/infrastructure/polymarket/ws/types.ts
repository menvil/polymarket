/**
 * Polymarket WebSocket types
 *
 * @remarks
 * Contains Polymarket-specific WebSocket message formats and subscription parameters.
 * Based on actual Polymarket CLOB WebSocket API.
 *
 * API Documentation:
 * - Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Format: JSON messages with event_type field
 *
 * @module infrastructure/polymarket/ws/types
 */

/**
 * Polymarket subscription parameters
 *
 * @remarks
 * Polymarket uses a simple subscription format:
 * - assets_ids: Array of token IDs (as numeric strings)
 * - type: Subscription type ('market' or 'user')
 *
 * Format sent to WebSocket:
 * ```json
 * {
 *   "assets_ids": ["67704255197116168826604911233626301865010283966205730455742704536521111535950", ...],
 *   "type": "market"
 * }
 * ```
 *
 * @example
 * ```typescript
 * const params: PolymarketSubscriptionParams = {
 *   assets_ids: [
 *     '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *     '28257334928283890303635192969230584167951485435421345229067758649928042311681',
 *   ],
 *   type: 'market',
 * };
 * ```
 */
export interface PolymarketSubscriptionParams {
  /**
   * Массив ID активов (token IDs) для подписки
   *
   * @remarks
   * - Token ID — очень длинные числовые строки (77 цифр)
   * - Должны быть валидными token ID маркетов Polymarket
   * - Дубликаты удаляются автоматически
   * - Каждый токен представляет одну сторону бинарного маркета (YES или NO)
   *
   * @example
   * ['67704255197116168826604911233626301865010283966205730455742704536521111535950']
   */
  assets_ids: string[];

  /**
   * Тип подписки
   *
   * @remarks
   * - 'market': Подписка на рыночные данные (стакан, сделки)
   * - 'user': Подписка на user-specific события (fills, ордера)
   *
   * Наиболее распространён 'market' для маркет-мейкинга / торговых ботов.
   */
  type: 'market' | 'user';
}

/**
 * Polymarket WebSocket message (incoming)
 *
 * @remarks
 * All messages from Polymarket WebSocket have an event_type field.
 * Additional fields depend on the event type.
 *
 * Event Types:
 * - **Data events** (have asset_id): book, trade, last_trade_price
 * - **Control events** (no asset_id): pong, error, subscribed, unsubscribed
 * - **Ignored events**: price_change, tick_size_change
 *
 * @example
 * ```typescript
 * // Orderbook update
 * const book: PolymarketWSMessage = {
 *   event_type: 'book',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   bids: [{ price: '0.52', size: '100' }],
 *   asks: [{ price: '0.53', size: '150' }],
 *   timestamp: 1766875759895,
 * };
 *
 * // Trade update
 * const trade: PolymarketWSMessage = {
 *   event_type: 'trade',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   price: '0.52',
 *   size: '50',
 *   side: 'BUY',
 *   timestamp: 1766875759895,
 * };
 *
 * // Pong (control message)
 * const pong: PolymarketWSMessage = {
 *   event_type: 'pong',
 * };
 *
 * // Error (control message)
 * const error: PolymarketWSMessage = {
 *   event_type: 'error',
 *   message: 'Invalid token ID',
 * };
 * ```
 */
export interface PolymarketWSMessage {
  /**
   * Тип события
   *
   * @remarks
   * Определяет, как парсить остальную часть сообщения.
   *
   * События с данными:
   * - book: Снапшот/обновление стакана
   * - trade: Исполнение сделки
   * - last_trade_price: Обновление последней цены сделки
   *
   * Управляющие события:
   * - pong: Ответ на heartbeat
   * - error: Сообщение об ошибке
   * - subscribed: Подтверждение подписки
   * - unsubscribed: Подтверждение отписки
   *
   * Игнорируемые события:
   * - price_change: Уведомления об изменении цен (пакетные)
   * - tick_size_change: Изменение конфигурации шага цены
   */
  event_type: 'book' | 'trade' | 'last_trade_price' | 'pong' | 'error' | 'subscribed' | 'unsubscribed' | 'price_change' | 'tick_size_change';

  /**
   * ID актива (token ID)
   *
   * @remarks
   * Присутствует только в событиях с данными (book, trade, last_trade_price).
   * Отсутствует в управляющих событиях (pong, error, subscribed).
   *
   * 77-значная числовая строка, представляющая конкретный исход маркета.
   *
   * @example
   * '67704255197116168826604911233626301865010283966205730455742704536521111535950'
   */
  asset_id?: string;

  /**
   * Биды (для событий стакана)
   *
   * @remarks
   * Массив объектов { price: string, size: string }.
   * Цены — десятичные строки (например, '0.52').
   * Размеры — десятичные строки (например, '100.5').
   *
   * Отсортированы по убыванию цены (лучший бид первым).
   *
   * @example
   * [{ price: '0.52', size: '100' }, { price: '0.51', size: '200' }]
   */
  bids?: Array<{ price: string; size: string }>;

  /**
   * Аски (для событий стакана)
   *
   * @remarks
   * Массив объектов { price: string, size: string }.
   * Отсортированы по возрастанию цены (лучший аск первым).
   *
   * @example
   * [{ price: '0.53', size: '150' }, { price: '0.54', size: '250' }]
   */
  asks?: Array<{ price: string; size: string }>;

  /**
   * Цена сделки (для событий сделки)
   *
   * @remarks
   * Десятичная строка, представляющая цену исполнения.
   *
   * @example
   * '0.52'
   */
  price?: string;

  /**
   * Размер сделки (для событий сделки)
   *
   * @remarks
   * Десятичная строка, представляющая объём сделки.
   *
   * @example
   * '50.5'
   */
  size?: string;

  /**
   * Сторона сделки (для событий сделки)
   *
   * @remarks
   * - BUY: Агрессивная покупка (тейкер купил у мейкера)
   * - SELL: Агрессивная продажа (тейкер продал мейкеру)
   *
   * С точки зрения тейкера.
   */
  side?: 'BUY' | 'SELL';

  /**
   * Временна́я метка (Unix миллисекунды)
   *
   * @remarks
   * Присутствует для событий с данными (book, trade).
   * Представляет момент возникновения события на бирже.
   *
   * @example
   * 1766875759895
   */
  timestamp?: number;

  /**
   * Сообщение об ошибке (для событий ошибки)
   *
   * @remarks
   * Человекочитаемое описание ошибки.
   *
   * @example
   * 'Invalid token ID'
   */
  message?: string;
}

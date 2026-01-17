/**
 * Типы WebSocket для Polymarket
 *
 * @remarks
 * Содержит форматы WebSocket сообщений и параметры подписки специфичные для Polymarket.
 * Основано на реальном Polymarket CLOB WebSocket API.
 *
 * Документация API:
 * - Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Формат: JSON сообщения с полем event_type
 *
 * @module infrastructure/polymarket/ws/types
 */

/**
 * Параметры подписки Polymarket
 *
 * @remarks
 * Polymarket использует простой формат подписки:
 * - assets_ids: Массив ID токенов (в виде числовых строк)
 * - type: Тип подписки ('market' или 'user')
 *
 * Формат отправляемый в WebSocket:
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
   * Массив ID активов (ID токенов) для подписки
   *
   * @remarks
   * - ID токенов - очень длинные числовые строки (77 цифр)
   * - Должны быть валидными ID токенов с маркетов Polymarket
   * - Дубликаты будут удалены автоматически
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
   * - 'market': Подписка на данные маркета (orderbook, трейды)
   * - 'user': Подписка на события специфичные для пользователя (исполнения, ордера)
   *
   * Наиболее часто используется 'market' для маркет-мейкинга / торговых ботов.
   */
  type: 'market' | 'user';
}

/**
 * Входящее WebSocket сообщение Polymarket
 *
 * @remarks
 * Все сообщения от Polymarket WebSocket имеют поле event_type.
 * Дополнительные поля зависят от типа события.
 *
 * Типы событий:
 * - **Data события** (имеют asset_id): book, trade, last_trade_price
 * - **Контрольные события** (нет asset_id): pong, error, subscribed, unsubscribed
 * - **Игнорируемые события**: price_change, tick_size_change
 *
 * @example
 * ```typescript
 * // Обновление orderbook
 * const book: PolymarketWSMessage = {
 *   event_type: 'book',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   bids: [{ price: '0.52', size: '100' }],
 *   asks: [{ price: '0.53', size: '150' }],
 *   timestamp: 1766875759895,
 * };
 *
 * // Обновление trade
 * const trade: PolymarketWSMessage = {
 *   event_type: 'trade',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   price: '0.52',
 *   size: '50',
 *   side: 'BUY',
 *   timestamp: 1766875759895,
 * };
 *
 * // Pong (контрольное сообщение)
 * const pong: PolymarketWSMessage = {
 *   event_type: 'pong',
 * };
 *
 * // Error (контрольное сообщение)
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
   * Определяет как парсить остальную часть сообщения.
   *
   * Data события:
   * - book: Снимок/обновление orderbook
   * - trade: Исполнение трейда
   * - last_trade_price: Обновление цены последнего трейда
   *
   * Контрольные события:
   * - pong: Ответ на heartbeat
   * - error: Сообщение об ошибке
   * - subscribed: Подтверждение подписки
   * - unsubscribed: Подтверждение отписки
   *
   * Игнорируемые события:
   * - price_change: Уведомления об изменении цен (пакетные)
   * - tick_size_change: Изменение конфигурации tick size
   */
  event_type: 'book' | 'trade' | 'last_trade_price' | 'pong' | 'error' | 'subscribed' | 'unsubscribed' | 'price_change' | 'tick_size_change';

  /**
   * ID актива (ID токена)
   *
   * @remarks
   * Присутствует только для data событий (book, trade, last_trade_price).
   * Отсутствует для контрольных событий (pong, error, subscribed).
   *
   * 77-значная числовая строка представляющая конкретный исход маркета.
   *
   * @example
   * '67704255197116168826604911233626301865010283966205730455742704536521111535950'
   */
  asset_id?: string;

  /**
   * Биды (для событий orderbook)
   *
   * @remarks
   * Массив объектов { price: string, size: string }.
   * Цены - десятичные строки (например, '0.52').
   * Размеры - десятичные строки (например, '100.5').
   *
   * Отсортированы по цене по убыванию (лучший бид первым).
   *
   * @example
   * [{ price: '0.52', size: '100' }, { price: '0.51', size: '200' }]
   */
  bids?: Array<{ price: string; size: string }>;

  /**
   * Аски (для событий orderbook)
   *
   * @remarks
   * Массив объектов { price: string, size: string }.
   * Отсортированы по цене по возрастанию (лучший аск первым).
   *
   * @example
   * [{ price: '0.53', size: '150' }, { price: '0.54', size: '250' }]
   */
  asks?: Array<{ price: string; size: string }>;

  /**
   * Цена трейда (для событий trade)
   *
   * @remarks
   * Десятичная строка представляющая цену исполнения.
   *
   * @example
   * '0.52'
   */
  price?: string;

  /**
   * Размер трейда (для событий trade)
   *
   * @remarks
   * Десятичная строка представляющая количество трейда.
   *
   * @example
   * '50.5'
   */
  size?: string;

  /**
   * Сторона трейда (для событий trade)
   *
   * @remarks
   * - BUY: Агрессивная покупка (тейкер купил у мейкера)
   * - SELL: Агрессивная продажа (тейкер продал мейкеру)
   *
   * Это с точки зрения тейкера.
   */
  side?: 'BUY' | 'SELL';

  /**
   * Временная метка (Unix миллисекунды)
   *
   * @remarks
   * Присутствует для data событий (book, trade).
   * Представляет когда событие произошло на бирже.
   *
   * @example
   * 1766875759895
   */
  timestamp?: number;

  /**
   * Сообщение об ошибке (для событий error)
   *
   * @remarks
   * Человекочитаемое описание ошибки.
   *
   * @example
   * 'Invalid token ID'
   */
  message?: string;
}

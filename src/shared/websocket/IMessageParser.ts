/**
 * IMessageParser - Интерфейс для парсинга ВХОДЯЩИХ WebSocket сообщений
 *
 * @remarks
 * Ответственность: Преобразование сырых WebSocket сообщений в структурированные доменные события.
 * Это ВХОДЯЩАЯ половина обработки сообщений (в паре с IMessageFormatter для исходящих).
 *
 * Решение по дизайну:
 * - Отделён от IMessageFormatter для следования Single Responsibility Principle
 * - IMessageParser обрабатывает парсинг входящих сообщений (сервер → клиент)
 * - IMessageFormatter обрабатывает форматирование subscribe/unsubscribe (клиент → сервер)
 *
 * Каждая биржа реализует этот интерфейс со своей специфичной логикой парсинга:
 * - Polymarket: Парсит { event_type: 'book' | 'trade' | 'pong' | ... }
 * - Binance: Парсит { e: 'depthUpdate' | 'trade' | ... }
 * - Kraken: Парсит { event: 'heartbeat' | ... } и array payloads
 *
 * Ключевые ответственности:
 * 1. **parseMessage()**: Преобразовать сырые данные в ParsedMessage (или null для управляющих сообщений)
 * 2. **isPongMessage()**: Обнаружить heartbeat/pong ответы
 * 3. **isErrorMessage()**: Обнаружить сообщения об ошибках
 * 4. **extractErrorMessage()**: Извлечь человекочитаемый текст ошибки
 *
 * @example
 * ```typescript
 * // Реализация Polymarket
 * class PolymarketMessageParser implements IMessageParser {
 *   parseMessage(data: unknown): ParsedMessage | null {
 *     const msg = data as PolymarketWSMessage;
 *     if (msg.event_type === 'book') {
 *       return {
 *         type: 'orderbook',
 *         channelId: msg.asset_id,
 *         payload: msg,
 *       };
 *     }
 *     return null; // Управляющее сообщение (pong, subscribed, и т.д.)
 *   }
 * }
 *
 * // Использование в BaseWebSocketTransport
 * const parsed = this.parser.parseMessage(JSON.parse(rawData));
 * if (parsed) {
 *   this.emit(parsed.type, parsed.payload);
 * }
 * ```
 *
 * @module shared/websocket/IMessageParser
 */

import type { ParsedMessage } from './types.js';

/**
 * Интерфейс для парсинга входящих WebSocket сообщений
 *
 * @remarks
 * Реализации должны:
 * - Парсить специфичные для биржи форматы сообщений
 * - Возвращать ParsedMessage для событий данных (orderbook, trade, ticker, и т.д.)
 * - Возвращать null для управляющих сообщений (pong, subscribed, error, и т.д.)
 * - Обнаруживать heartbeat/pong сообщения
 * - Обнаруживать и извлекать сообщения об ошибках
 *
 * Принципы дизайна:
 * - **Мягкая обработка ошибок**: Возвращать null для непарсируемых сообщений (не выбрасывать)
 * - **Логирование**: Логировать предупреждения для неожиданных форматов
 * - **Типобезопасность**: Валидировать структуру сообщения перед обращением к полям
 * - **Производительность**: Быстрый парсинг (< 1мс типично)
 *
 * Управляющие сообщения vs Сообщения данных:
 * - **Управляющие сообщения** (возвращать null): pong, subscribed, unsubscribed, error
 * - **Сообщения данных** (возвращать ParsedMessage): orderbook, trade, ticker, и т.д.
 *
 * Это разделение позволяет BaseWebSocketTransport:
 * - Обрабатывать управляющие сообщения внутренне (heartbeat, подписки, ошибки)
 * - Эмитить сообщения данных в прикладной слой
 */
export interface IMessageParser {
  /**
   * Парсит входящее WebSocket сообщение
   *
   * @param data - Сырые данные сообщения (обычно распарсенный JSON объект)
   * @returns ParsedMessage для событий данных, null для управляющих сообщений или непарсируемых данных
   *
   * @remarks
   * Дерево решений:
   * 1. Проверить является ли сообщение управляющим (pong, subscribed, error) → вернуть null
   * 2. Проверить является ли сообщение событием данных (orderbook, trade) → вернуть ParsedMessage
   * 3. Проверить является ли сообщение malformed/неполным → залогировать предупреждение, вернуть null
   *
   * Управляющие сообщения (возвращать null):
   * - Heartbeat/pong ответы (обрабатываются BaseWebSocketTransport)
   * - Подтверждения подписки (логируются, но не эмитятся)
   * - Сообщения об ошибках (обрабатываются isErrorMessage/extractErrorMessage)
   *
   * Сообщения данных (возвращать ParsedMessage):
   * - Обновления orderbook → { type: 'orderbook', channelId: '123', payload: {...} }
   * - События trade → { type: 'trade', channelId: '123', payload: {...} }
   * - Кастомные события → { type: 'custom', channelId: '123', payload: {...} }
   *
   * Обработка ошибок:
   * - Невалидные/непарсируемые данные → залогировать предупреждение, вернуть null (не выбрасывать)
   * - Отсутствующие обязательные поля → залогировать предупреждение, вернуть null
   * - Никогда не выбрасывать исключения (parseMessage вызывается в горячем пути)
   *
   * @example
   * ```typescript
   * // Polymarket
   * const parsed = parser.parseMessage({
   *   event_type: 'book',
   *   asset_id: '123',
   *   bids: [...],
   *   asks: [...],
   * });
   * // Возвращает: { type: 'orderbook', channelId: '123', payload: {...} }
   *
   * const pong = parser.parseMessage({ event_type: 'pong' });
   * // Возвращает: null (управляющее сообщение)
   *
   * // Binance
   * const parsed = parser.parseMessage({
   *   e: 'depthUpdate',
   *   s: 'BTCUSDT',
   *   b: [...],
   *   a: [...],
   * });
   * // Возвращает: { type: 'orderbook', channelId: 'BTCUSDT', payload: {...} }
   * ```
   */
  parseMessage(data: unknown): ParsedMessage | null;

  /**
   * Проверяет является ли сообщение pong/heartbeat ответом
   *
   * @param data - Сырые данные сообщения
   * @returns true если это heartbeat/pong сообщение
   *
   * @remarks
   * Используется BaseWebSocketTransport для:
   * - Сброса таймаута heartbeat
   * - Подтверждения что соединение живо
   * - Избежания обработки pong как события данных
   *
   * Примеры для бирж:
   * - Polymarket: { event_type: 'pong' }
   * - Binance: { e: 'ping' } или { result: null, id: <pingId> }
   * - Kraken: { event: 'heartbeat' }
   *
   * @example
   * ```typescript
   * if (parser.isPongMessage(data)) {
   *   this.resetHeartbeatTimeout();
   *   return; // Не обрабатывать как событие данных
   * }
   * ```
   */
  isPongMessage(data: unknown): boolean;

  /**
   * Проверяет является ли сообщение сообщением об ошибке
   *
   * @param data - Сырые данные сообщения
   * @returns true если это сообщение об ошибке
   *
   * @remarks
   * Используется BaseWebSocketTransport для:
   * - Обнаружения ошибок биржи
   * - Эмитирования события 'error' с извлечённым сообщением
   * - Логирования деталей ошибки
   *
   * Примеры для бирж:
   * - Polymarket: { event_type: 'error', message: '...' }
   * - Binance: { error: { code: -1100, msg: '...' } }
   * - Kraken: { errorMessage: '...' }
   *
   * @example
   * ```typescript
   * if (parser.isErrorMessage(data)) {
   *   const errMsg = parser.extractErrorMessage(data);
   *   this.logger.error('WebSocket error', { error: errMsg });
   *   this.emit('error', new Error(errMsg));
   * }
   * ```
   */
  isErrorMessage(data: unknown): boolean;

  /**
   * Извлекает человекочитаемое сообщение об ошибке
   *
   * @param data - Сырые данные сообщения (должно быть сообщением об ошибке)
   * @returns Строка сообщения об ошибке, или undefined если не ошибка или сообщение недоступно
   *
   * @remarks
   * Вызывается после того как isErrorMessage() вернул true.
   * Извлекает фактический текст ошибки из специфичного для биржи формата ошибки.
   *
   * Fallback поведение:
   * - Если сообщение об ошибке не найдено → вернуть 'Unknown error'
   * - Если данные не ошибка → вернуть undefined
   * - Никогда не выбрасывать исключения
   *
   * Примеры для бирж:
   * - Polymarket: Извлечь поле message
   * - Binance: Извлечь поле error.msg
   * - Kraken: Извлечь поле errorMessage
   *
   * @example
   * ```typescript
   * // Polymarket
   * const msg = parser.extractErrorMessage({ event_type: 'error', message: 'Invalid token' });
   * // Возвращает: 'Invalid token'
   *
   * // Binance
   * const msg = parser.extractErrorMessage({ error: { code: -1100, msg: 'Invalid symbol' } });
   * // Возвращает: 'Invalid symbol'
   * ```
   */
  extractErrorMessage(data: unknown): string | undefined;
}
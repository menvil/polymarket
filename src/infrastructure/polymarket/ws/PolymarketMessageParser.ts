/**
 * PolymarketMessageParser - Парсит входящие WebSocket сообщения от Polymarket
 *
 * @remarks
 * Отвечает за парсинг ВХОДЯЩИХ сообщений от Polymarket WebSocket.
 * Это ВХОДЯЩАЯ половина (в паре с PolymarketMessageFormatter для исходящих).
 *
 * Типы сообщений Polymarket:
 * - **Data события** (имеют asset_id): book, trade, last_trade_price
 * - **Контрольные события** (нет asset_id): pong, error, subscribed, unsubscribed
 * - **Игнорируемые события**: price_change, tick_size_change
 *
 * Основные обязанности:
 * - Парсить data события → возвращать ParsedMessage
 * - Обнаруживать контрольные события → возвращать null
 * - Обнаруживать pong сообщения (для heartbeat)
 * - Обнаруживать сообщения об ошибках (для обработки ошибок)
 * - Извлекать текст ошибки из сообщений об ошибках
 *
 * Правила парсинга:
 * - Контрольные сообщения (pong, error, subscribed) → возвращать null
 * - Data сообщения без asset_id → логировать предупреждение, возвращать null
 * - Data сообщения с asset_id → возвращать ParsedMessage
 * - Невалидные/неполные сообщения → логировать предупреждение, возвращать null
 * - Никогда не бросать исключения (graceful обработка)
 *
 * @example
 * ```typescript
 * const parser = new PolymarketMessageParser(logger);
 *
 * // Сообщение orderbook
 * const parsed = parser.parseMessage({
 *   event_type: 'book',
 *   asset_id: '67704255...',
 *   bids: [{ price: '0.52', size: '100' }],
 *   asks: [{ price: '0.53', size: '150' }],
 * });
 * // Возвращает: { type: 'orderbook', channelId: '67704255...', payload: {...} }
 *
 * // Pong сообщение (контрольное)
 * const parsed = parser.parseMessage({ event_type: 'pong' });
 * // Возвращает: null (контрольное сообщение, обрабатывается транспортом)
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketMessageParser
 */

import type { IMessageParser } from '../../../shared/websocket/IMessageParser.js';
import type { ParsedMessage } from '../../../shared/websocket/types.js';
import type { PolymarketWSMessage } from './types.js';
import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Реализация парсера сообщений Polymarket
 *
 * @remarks
 * Реализует IMessageParser для Polymarket CLOB WebSocket API.
 *
 * Возможности:
 * - Парсит все типы сообщений Polymarket
 * - Обрабатывает контрольные сообщения (pong, error, subscribed)
 * - Валидирует структуру data сообщений
 * - Graceful обработка ошибок (никогда не бросает исключения)
 *
 * Обработка ошибок:
 * - Невалидные сообщения → логировать предупреждение, возвращать null
 * - Отсутствующие поля → логировать предупреждение, возвращать null
 * - Никогда не бросает исключения (graceful обработка)
 */
export class PolymarketMessageParser implements IMessageParser {
  /** Контрольные события (без asset_id) - обрабатываются транспортом */
  private static readonly CONTROL_EVENTS: readonly string[] = ['pong', 'error', 'subscribed', 'unsubscribed'];
  /** Игнорируемые события (не нужны для торговли) */
  private static readonly IGNORED_EVENTS: readonly string[] = ['price_change', 'tick_size_change'];

  private readonly logger: ILogger;

  /**
   * Создает новый парсер сообщений Polymarket
   *
   * @param logger - Экземпляр логгера
   *
   * @throws {Error} Если logger равен null
   *
   * @example
   * ```typescript
   * const parser = new PolymarketMessageParser(logger);
   * ```
   */
  constructor(logger: ILogger) {
    if (!logger) {
      throw new Error('logger is required');
    }

    this.logger = logger.child ? logger.child('PolymarketMessageParser') : logger;
  }

  /**
   * Парсит входящее сообщение Polymarket
   *
   * @param data - Сырые данные сообщения (распарсенный JSON объект)
   * @returns ParsedMessage для data событий, null для контрольных сообщений или невалидных данных
   *
   * @remarks
   * Поток решений:
   * 1. Извлечь event_type из сообщения
   * 2. Проверить является ли контрольным сообщением (pong, error, subscribed, unsubscribed) → вернуть null
   * 3. Проверить является ли игнорируемым сообщением (price_change, tick_size_change) → вернуть null
   * 4. Проверить имеет ли data сообщение asset_id → если нет, вернуть null
   * 5. Распарсить data сообщение в зависимости от event_type:
   *    - book → валидировать bids/asks, вернуть 'orderbook'
   *    - trade → валидировать price/size, вернуть 'trade'
   *    - last_trade_price → вернуть 'trade'
   * 6. Неизвестный event_type → логировать предупреждение, вернуть null
   *
   * Контрольные сообщения (возвращают null):
   * - pong: Ответ на heartbeat
   * - error: Уведомление об ошибке
   * - subscribed: Подтверждение подписки
   * - unsubscribed: Подтверждение отписки
   *
   * Игнорируемые сообщения (возвращают null):
   * - price_change: Пакетные изменения цен (не нужны для торговли)
   * - tick_size_change: Изменения конфигурации маркета (не нужны для торговли)
   *
   * Data сообщения (возвращают ParsedMessage):
   * - book: { type: 'orderbook', channelId: asset_id, payload: message }
   * - trade: { type: 'trade', channelId: asset_id, payload: message }
   * - last_trade_price: { type: 'trade', channelId: asset_id, payload: message }
   *
   * Валидация:
   * - Data сообщения ДОЛЖНЫ иметь asset_id → иначе вернуть null
   * - book сообщения ДОЛЖНЫ иметь bids И asks → иначе вернуть null
   * - trade сообщения ДОЛЖНЫ иметь price И size → иначе вернуть null
   *
   * @example
   * ```typescript
   * // Обновление orderbook
   * const parsed = parser.parseMessage({
   *   event_type: 'book',
   *   asset_id: '67704255...',
   *   bids: [{ price: '0.52', size: '100' }],
   *   asks: [{ price: '0.53', size: '150' }],
   *   timestamp: 1766875759895,
   * });
   * // Возвращает: { type: 'orderbook', channelId: '67704255...', payload: {...} }
   *
   * // Обновление trade
   * const parsed = parser.parseMessage({
   *   event_type: 'trade',
   *   asset_id: '67704255...',
   *   price: '0.52',
   *   size: '50',
   *   side: 'BUY',
   *   timestamp: 1766875759895,
   * });
   * // Возвращает: { type: 'trade', channelId: '67704255...', payload: {...} }
   *
   * // Pong (контрольное сообщение)
   * const parsed = parser.parseMessage({ event_type: 'pong' });
   * // Возвращает: null
   *
   * // Невалидное сообщение (отсутствует asset_id)
   * const parsed = parser.parseMessage({ event_type: 'book' });
   * // Возвращает: null (логирует предупреждение)
   * ```
   */
  parseMessage(data: unknown): ParsedMessage | null {
    try {
      const message = data as PolymarketWSMessage;
      const eventType = message.event_type;

      if (!eventType) {
        this.logger.trace('Message without event_type', { message });
        return null;
      }

      const eventTypeLower = eventType.toLowerCase();

      // Контрольные сообщения (без asset_id) - обрабатываются транспортом
      if (PolymarketMessageParser.CONTROL_EVENTS.includes(eventTypeLower)) {
        return null;
      }

      // Игнорируемые события (не нужны для торговли)
      if (PolymarketMessageParser.IGNORED_EVENTS.includes(eventTypeLower)) {
        this.logger.trace(`Skipping ${eventType} event`);
        return null;
      }

      // Data сообщения ДОЛЖНЫ иметь asset_id
      if (!message.asset_id) {
        this.logger.warn('Data message without asset_id', { eventType, message });
        return null;
      }

      // Парсим событие orderbook
      if (eventType === 'book') {
        // Валидируем обязательные поля
        if (!message.bids || !message.asks) {
          this.logger.warn('Orderbook message missing bids or asks', { message });
          return null;
        }

        return {
          type: 'orderbook',
          channelId: message.asset_id,
          payload: message,
        };
      }

      // Парсим событие trade
      if (eventType === 'trade' || eventType === 'last_trade_price') {
        // Валидируем обязательные поля
        if (!message.price || !message.size) {
          this.logger.trace('Trade message missing price or size', { eventType, message });
          return null;
        }

        return {
          type: 'trade',
          channelId: message.asset_id,
          payload: message,
        };
      }

      // Неизвестный тип события
      this.logger.debug('Unknown event type', {
        eventType,
        asset_id: message.asset_id?.substring(0, 16),
      });
      return null;
    } catch (error) {
      this.logger.error('Failed to parse message', { error, data });
      return null;
    }
  }

  /**
   * Проверяет является ли сообщение ответом pong/heartbeat
   *
   * @param data - Сырые данные сообщения
   * @returns true если это pong сообщение
   *
   * @remarks
   * Polymarket отправляет { event_type: 'pong' } в ответ на ping.
   * Используется BaseWebSocketTransport для сброса таймаута heartbeat.
   *
   * @example
   * ```typescript
   * const isPong = parser.isPongMessage({ event_type: 'pong' });
   * // Возвращает: true
   *
   * const isPong = parser.isPongMessage({ event_type: 'book', ... });
   * // Возвращает: false
   * ```
   */
  isPongMessage(data: unknown): boolean {
    const message = data as PolymarketWSMessage;
    return message.event_type === 'pong';
  }

  /**
   * Проверяет является ли сообщение сообщением об ошибке
   *
   * @param data - Сырые данные сообщения
   * @returns true если это сообщение об ошибке
   *
   * @remarks
   * Polymarket отправляет { event_type: 'error', message: '...' } для ошибок.
   * Используется BaseWebSocketTransport для эмиссии событий ошибок.
   *
   * @example
   * ```typescript
   * const isError = parser.isErrorMessage({ event_type: 'error', message: 'Invalid token' });
   * // Возвращает: true
   *
   * const isError = parser.isErrorMessage({ event_type: 'book', ... });
   * // Возвращает: false
   * ```
   */
  isErrorMessage(data: unknown): boolean {
    const message = data as PolymarketWSMessage;
    return message.event_type === 'error';
  }

  /**
   * Извлекает человекочитаемое сообщение об ошибке
   *
   * @param data - Сырые данные сообщения (должно быть сообщением об ошибке)
   * @returns Строка сообщения об ошибке, или undefined если это не ошибка
   *
   * @remarks
   * Формат ошибки Polymarket: { event_type: 'error', message: '...' }
   * Извлекает поле message.
   *
   * Запасной вариант:
   * - Если поле message отсутствует → вернуть 'Unknown error'
   * - Если это не сообщение об ошибке → вернуть undefined
   *
   * @example
   * ```typescript
   * const errMsg = parser.extractErrorMessage({
   *   event_type: 'error',
   *   message: 'Invalid token ID',
   * });
   * // Возвращает: 'Invalid token ID'
   *
   * const errMsg = parser.extractErrorMessage({ event_type: 'error' });
   * // Возвращает: 'Unknown error'
   *
   * const errMsg = parser.extractErrorMessage({ event_type: 'book', ... });
   * // Возвращает: undefined
   * ```
   */
  extractErrorMessage(data: unknown): string | undefined {
    const message = data as PolymarketWSMessage;

    if (message.event_type !== 'error') {
      return undefined;
    }

    return message.message || 'Unknown error';
  }
}

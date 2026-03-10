/**
 * PolymarketMessageParser — парсит входящие WebSocket-сообщения Polymarket
 *
 * @remarks
 * Отвечает за разбор ВХОДЯЩИХ сообщений из WebSocket Polymarket.
 * Это ВХОДЯЩАЯ половина (в паре с PolymarketMessageFormatter для исходящих).
 *
 * Типы сообщений Polymarket:
 * - **События с данными** (имеют asset_id): book, trade, last_trade_price
 * - **Управляющие события** (без asset_id): pong, error, subscribed, unsubscribed
 * - **Игнорируемые события**: price_change, tick_size_change
 *
 * Ключевые обязанности:
 * - Парсинг событий с данными → возврат ParsedMessage
 * - Обнаружение управляющих событий → возврат null
 * - Обнаружение pong-сообщений (для heartbeat)
 * - Обнаружение сообщений об ошибках (для обработки ошибок)
 * - Извлечение текста ошибки из сообщений об ошибках
 *
 * Правила парсинга:
 * - Управляющие сообщения (pong, error, subscribed) → возврат null
 * - Сообщения с данными без asset_id → логирование предупреждения, возврат null
 * - Сообщения с данными и asset_id → возврат ParsedMessage
 * - Невалидные/неполные сообщения → логирование предупреждения, возврат null
 * - Никогда не бросает исключений (graceful degradation)
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
 * // Pong-сообщение (управляющее)
 * const parsed = parser.parseMessage({ event_type: 'pong' });
 * // Возвращает: null (управляющее сообщение, обрабатывается транспортом)
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketMessageParser
 */

import type { IMessageParser } from '../stubs/shared/websocket/IMessageParser.js';
import type { ParsedMessage } from '../stubs/shared/websocket/types.js';
import type { PolymarketWSMessage } from './types.js';
import type { ILogger } from '@polymarket/logger';

/**
 * Реализация парсера сообщений Polymarket
 *
 * @remarks
 * Реализует IMessageParser для WebSocket API Polymarket CLOB.
 *
 * Возможности:
 * - Парсинг всех типов сообщений Polymarket
 * - Обработка управляющих сообщений (pong, error, subscribed)
 * - Валидация структуры сообщений с данными
 * - Graceful обработка ошибок (никогда не бросает)
 *
 * Обработка ошибок:
 * - Невалидные сообщения → логирование предупреждения, возврат null
 * - Отсутствующие поля → логирование предупреждения, возврат null
 * - Никогда не бросает исключений (graceful degradation)
 */
export class PolymarketMessageParser implements IMessageParser {
  private readonly logger: ILogger;

  /**
   * Создаёт новый парсер сообщений Polymarket
   *
   * @param logger - Экземпляр logger
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

    this.logger = logger.child({ component: 'PolymarketMessageParser' });
  }

  /**
   * Парсит входящее сообщение Polymarket
   *
   * @param data - Raw данные сообщения (распарсенный JSON-объект)
   * @returns ParsedMessage для событий с данными, null для управляющих или невалидных
   *
   * @remarks
   * Процесс принятия решений:
   * 1. Извлечь event_type из сообщения
   * 2. Проверить, является ли управляющим (pong, error, subscribed, unsubscribed) → вернуть null
   * 3. Проверить, является ли игнорируемым (price_change, tick_size_change) → вернуть null
   * 4. Проверить наличие asset_id в сообщении с данными → если нет, вернуть null
   * 5. Парсить сообщение с данными по event_type:
   *    - book → валидировать bids/asks, вернуть 'orderbook'
   *    - trade → валидировать price/size, вернуть 'trade'
   *    - last_trade_price → вернуть 'trade'
   * 6. Неизвестный event_type → логирование предупреждения, вернуть null
   *
   * Управляющие сообщения (возврат null):
   * - pong: Ответ на heartbeat
   * - error: Уведомление об ошибке
   * - subscribed: Подтверждение подписки
   * - unsubscribed: Подтверждение отписки
   *
   * Игнорируемые сообщения (возврат null):
   * - price_change: Пакетные изменения цен (не нужны для торговли)
   * - tick_size_change: Изменения конфигурации рынка (не нужны для торговли)
   *
   * Сообщения с данными (возврат ParsedMessage):
   * - book: { type: 'orderbook', channelId: asset_id, payload: message }
   * - trade: { type: 'trade', channelId: asset_id, payload: message }
   * - last_trade_price: { type: 'trade', channelId: asset_id, payload: message }
   *
   * Валидация:
   * - Сообщения с данными ДОЛЖНЫ иметь asset_id → иначе вернуть null
   * - Сообщения book ДОЛЖНЫ иметь bids И asks → иначе вернуть null
   * - Сообщения trade ДОЛЖНЫ иметь price И size → иначе вернуть null
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
   * // Pong (управляющее сообщение)
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

      // Управляющие сообщения (без asset_id) — обрабатываются транспортом
      if (eventType === 'pong' || eventType === 'error' || eventType === 'subscribed' || eventType === 'unsubscribed') {
        // Обрабатываются BaseWebSocketTransport (isPongMessage, isErrorMessage)
        return null;
      }

      // Игнорируемые события (не нужны для торговли)
      if (eventType === 'price_change') {
        // price_change содержит массив price_changes, а не единственный asset_id
        // Пропускаем — не нужно для торговли или сбора данных
        this.logger.trace('Skipping price_change event', {
          market: (message as any).market?.substring(0, 16) + '...',
          changes: (message as any).price_changes?.length,
        });
        return null;
      }

      if (eventType === 'tick_size_change') {
        // tick_size_change — пропускаем, не нужно для торговли или сбора данных
        this.logger.trace('Skipping tick_size_change event', {
          market: (message as any).market?.substring(0, 16) + '...',
        });
        return null;
      }

      // Сообщения с данными ДОЛЖНЫ иметь asset_id
      if (!message.asset_id) {
        this.logger.warn('Data message without asset_id', { eventType, message });
        return null;
      }

      // Парсим событие стакана
      if (eventType === 'book') {
        // Проверяем обязательные поля
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

      // Парсим событие сделки
      if (eventType === 'trade' || eventType === 'last_trade_price') {
        // Проверяем обязательные поля
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
      this.logger.error('Failed to parse message', { err: error instanceof Error ? error : new Error(String(error)), data });
      return null;
    }
  }

  /**
   * Проверяет, является ли сообщение ответом pong/heartbeat
   *
   * @param data - Raw данные сообщения
   * @returns true если это pong-сообщение
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
   * Проверяет, является ли сообщение сообщением об ошибке
   *
   * @param data - Raw данные сообщения
   * @returns true если это сообщение об ошибке
   *
   * @remarks
   * Polymarket отправляет { event_type: 'error', message: '...' } при ошибках.
   * Используется BaseWebSocketTransport для эмиссии событий ошибки.
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
   * @param data - Raw данные сообщения (должно быть сообщением об ошибке)
   * @returns Строка с описанием ошибки, или undefined если это не ошибка
   *
   * @remarks
   * Формат ошибки Polymarket: { event_type: 'error', message: '...' }
   * Извлекает поле message.
   *
   * Запасные варианты:
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

/**
 * IMessageFormatter - Интерфейс для форматирования ИСХОДЯЩИХ WebSocket сообщений
 *
 * @remarks
 * Ответственность: Преобразование доменных запросов подписки в специфичный для биржи wire-формат.
 * Это ИСХОДЯЩАЯ половина обработки сообщений (в паре с IMessageParser для входящих).
 *
 * Решение по дизайну:
 * - Отделён от IMessageParser для следования Single Responsibility Principle
 * - IMessageFormatter обрабатывает форматирование subscribe/unsubscribe (клиент → сервер)
 * - IMessageParser обрабатывает парсинг входящих сообщений (сервер → клиент)
 *
 * Каждая биржа реализует этот интерфейс со своим специфичным форматом:
 * - Polymarket: JSON с { assets_ids: [...], type: 'market' }
 * - Binance: JSON с { method: 'SUBSCRIBE', params: [...] }
 * - Kraken: JSON с { event: 'subscribe', pair: [...], subscription: {...} }
 *
 * @example
 * ```typescript
 * // Реализация Polymarket
 * class PolymarketMessageFormatter implements IMessageFormatter {
 *   formatSubscription(channel: string, params: SubscriptionParams): string {
 *     return JSON.stringify({
 *       assets_ids: params.assets_ids,
 *       type: 'market',
 *     });
 *   }
 * }
 *
 * // Использование в BaseWebSocketTransport
 * const message = this.formatter.formatSubscription('market', { assets_ids: ['123'] });
 * this.ws.send(message);
 * ```
 *
 * @module shared/websocket/IMessageFormatter
 */

import type { SubscriptionParams } from './types.js';

/**
 * Интерфейс для форматирования исходящих WebSocket сообщений
 *
 * @remarks
 * Реализации должны:
 * - Преобразовывать generic SubscriptionParams в специфичный для биржи формат
 * - Возвращать готовую к отправке строку (обычно результат JSON.stringify)
 * - Валидировать параметры и выбрасывать понятные ошибки если невалидны
 * - Обрабатывать специфичные для биржи особенности (например, Polymarket требует числовые строки)
 *
 * Обработка ошибок:
 * - Выбрасывать Error для невалидных параметров (ловится BaseWebSocketTransport)
 * - Логировать предупреждения для подозрительного, но валидного ввода
 * - Никогда не возвращать null/undefined (всегда возвращать валидную строку или выбрасывать)
 *
 * SLA:
 * - Синхронная операция (async не нужен для форматирования)
 * - Быстрое выполнение (< 1мс типично)
 * - Детерминистичный вывод (одни параметры → один вывод)
 */
export interface IMessageFormatter {
  /**
   * Форматирует запрос подписки
   *
   * @param channel - Имя канала (специфично для биржи, например, 'market', 'depth', 'trade')
   * @param params - Параметры подписки (специфичная для биржи структура)
   * @returns Отформатированная строка сообщения готовая к отправке через WebSocket
   * @throws {Error} Если параметры невалидны или отсутствуют обязательные поля
   *
   * @remarks
   * Параметр channel может игнорироваться некоторыми биржами (например, Polymarket не использует его).
   * Другие биржи могут использовать его для определения структуры сообщения (например, Binance).
   *
   * Валидация:
   * - Проверить наличие обязательных полей
   * - Валидировать форматы полей (например, числовые строки, валидные enum)
   * - Удалить дубликаты если применимо
   * - Выбрасывать описательные ошибки для невалидного ввода
   *
   * @example
   * ```typescript
   * // Polymarket
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['123', '456'],
   *   type: 'market',
   * });
   * // Возвращает: '{"assets_ids":["123","456"],"type":"market"}'
   *
   * // Binance
   * const msg = formatter.formatSubscription('depth', {
   *   symbol: 'BTCUSDT',
   *   levels: 20,
   * });
   * // Возвращает: '{"method":"SUBSCRIBE","params":["btcusdt@depth20"],"id":1}'
   * ```
   */
  formatSubscription(channel: string, params: SubscriptionParams): string;

  /**
   * Форматирует запрос отписки
   *
   * @param channel - Имя канала
   * @param params - Параметры отписки (обычно такие же как для подписки)
   * @returns Отформатированная строка сообщения готовая к отправке через WebSocket
   * @throws {Error} Если параметры невалидны
   *
   * @remarks
   * Некоторые биржи используют одинаковый формат для subscribe/unsubscribe (например, Polymarket).
   * Другие используют разные типы сообщений (например, Binance использует method: 'UNSUBSCRIBE').
   *
   * Примечание по реализации:
   * - Если формат unsubscribe идентичен subscribe, делегировать в formatSubscription()
   * - Если отличается, реализовать отдельную логику
   *
   * @example
   * ```typescript
   * // Polymarket (такой же как subscribe)
   * const msg = formatter.formatUnsubscription('market', {
   *   assets_ids: ['123'],
   * });
   *
   * // Binance (другой method)
   * const msg = formatter.formatUnsubscription('depth', {
   *   symbol: 'BTCUSDT',
   * });
   * // Возвращает: '{"method":"UNSUBSCRIBE","params":["btcusdt@depth20"],"id":2}'
   * ```
   */
  formatUnsubscription(channel: string, params: SubscriptionParams): string;
}
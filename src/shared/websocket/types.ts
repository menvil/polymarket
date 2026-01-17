/**
 * Общие WebSocket типы для exchange-agnostic транспортного слоя
 *
 * @remarks
 * Эти типы используются во всех WebSocket реализациях независимо от биржи.
 * Специфичные для биржи типы должны быть определены в отдельных модулях.
 *
 * @module shared/websocket/types
 */

/**
 * Статус WebSocket соединения
 *
 * @remarks
 * Состояния жизненного цикла:
 * - disconnected: Начальное состояние, не подключён
 * - connecting: Попытка подключения в процессе
 * - connected: Успешно подключён и готов
 * - reconnecting: Потеря соединения, попытка переподключения
 * - closed: Окончательно закрыт, без переподключения
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/**
 * Базовая конфигурация WebSocket
 *
 * @remarks
 * Общие опции конфигурации для любого WebSocket транспорта.
 * Специфичные для биржи конфиги могут расширять этот интерфейс.
 *
 * @example
 * ```typescript
 * const config: BaseWebSocketConfig = {
 *   url: 'wss://example.com/ws',
 *   reconnectDelay: 1000,
 *   maxReconnectDelay: 30000,
 *   heartbeatInterval: 30000,
 *   heartbeatTimeout: 10000,
 * };
 * ```
 */
export interface BaseWebSocketConfig {
  /** URL WebSocket сервера (wss:// или ws://) */
  url: string;

  /** Начальная задержка переподключения в миллисекундах */
  reconnectDelay?: number;

  /** Максимальная задержка переподключения (для экспоненциального backoff) */
  maxReconnectDelay?: number;

  /** Интервал heartbeat/ping в миллисекундах */
  heartbeatInterval?: number;

  /** Таймаут heartbeat (до признания соединения мёртвым) */
  heartbeatTimeout?: number;
}

/**
 * Распарсенное WebSocket сообщение (exchange-agnostic)
 *
 * @remarks
 * Представляет успешно распарсенное сообщение данных от биржи.
 * Реализации IMessageParser возвращают эту структуру.
 *
 * Поток:
 * 1. Приходят сырые WebSocket данные
 * 2. IMessageParser.parseMessage() преобразует их в ParsedMessage
 * 3. BaseWebSocketTransport эмитит событие на основе `type`
 *
 * @example
 * ```typescript
 * const parsed: ParsedMessage = {
 *   type: 'orderbook',
 *   channelId: '123',
 *   payload: { bids: [...], asks: [...] },
 * };
 * ```
 */
export interface ParsedMessage {
  /**
   * Тип события (например, 'orderbook', 'trade', 'ticker')
   *
   * @remarks
   * Это значение определяет какое событие будет эмитировано:
   * - 'orderbook' → emit('orderbook', payload)
   * - 'trade' → emit('trade', payload)
   * - Кастомные типы разрешены
   */
  type: string;

  /**
   * Идентификатор канала/актива/символа
   *
   * @remarks
   * Определяет к какому рынку/активу относится это сообщение.
   * Формат зависит от биржи (например, Polymarket использует asset_id, Binance использует symbol).
   */
  channelId: string;

  /**
   * Распарсенный payload сообщения
   *
   * @remarks
   * Структура данных специфична для биржи.
   * Типобезопасность - ответственность потребляющего кода.
   */
  payload: unknown;
}

/**
 * Общие параметры подписки
 *
 * @remarks
 * Карта ключ-значение для конфигурации подписки.
 * Специфичные для биржи реализации определяют фактическую структуру.
 *
 * Примеры:
 * - Polymarket: { assets_ids: string[], type: 'market' }
 * - Binance: { symbol: string, channel: 'depth' }
 *
 * @example
 * ```typescript
 * const params: SubscriptionParams = {
 *   assets_ids: ['123', '456'],
 *   type: 'market',
 * };
 * ```
 */
export interface SubscriptionParams {
  [key: string]: unknown;
}
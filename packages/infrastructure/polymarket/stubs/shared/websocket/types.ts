/**
 * Stub типов для shared/websocket.
 *
 * @remarks
 * INTERNAL STUB — используется до реализации shared/websocket в Phase 0.5.
 */

/** Статус соединения WebSocket */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** Параметры подписки */
export interface SubscriptionParams {
  [key: string]: unknown;
}

/** Распарсенное сообщение */
export interface ParsedMessage {
  type: string;
  channelId: string;
  payload: unknown;
}

/** Базовая конфигурация WebSocket транспорта */
export interface BaseWebSocketConfig {
  url: string;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  maxReconnectAttempts?: number;
}

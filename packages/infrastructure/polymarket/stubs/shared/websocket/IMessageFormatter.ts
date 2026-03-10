/**
 * Stub для IMessageFormatter.
 *
 * @remarks
 * INTERNAL STUB — используется до реализации shared/websocket в Phase 0.5.
 */
import type { SubscriptionParams } from './types.js';

/** Интерфейс форматтера исходящих сообщений */
export interface IMessageFormatter {
  formatSubscription(channel: string, params: SubscriptionParams): string;
  formatUnsubscription(channel: string, params: SubscriptionParams): string;
}

/**
 * Stub для IMessageParser.
 *
 * @remarks
 * INTERNAL STUB — используется до реализации shared/websocket в Phase 0.5.
 */
import type { ParsedMessage } from './types.js';

/** Интерфейс парсера входящих сообщений */
export interface IMessageParser {
  parseMessage(data: unknown): ParsedMessage | null;
  isPong?(data: unknown): boolean;
  isError?(data: unknown): boolean;
  getErrorText?(data: unknown): string | null;
}

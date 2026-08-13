/**
 * CriticalHandlerError — critical-flagged подписчик EventBus выбросил исключение
 *
 * @remarks
 * Выбрасывается когда handler, подписанный с `{ critical: true }`, бросает при
 * обработке события (`EventBus._dispatch()`). Исходное значение (любого типа — handler
 * может бросить не только `Error`) сохраняется в `context.originalError` для диагностики;
 * `message` содержит только факт и тип события, не детали исходной ошибки.
 *
 * В отличие от `QueueOverflowError` — это не операционное состояние самого EventBus
 * (очередь/лимит), а пробрасывание ошибки чужого кода (подписчика). Отдельный класс,
 * не переиспользование `QueueOverflowError`, поскольку семантика разная: caller,
 * получивший `Err(QueueOverflowError)`, может решить подождать и повторить; caller,
 * получивший `Err(CriticalHandlerError)`, имеет дело с багом в конкретном подписчике.
 * severity: 'high' — critical-подписчики по определению отмечены как критичные для
 * бизнес-логики (см. `IEventBus.subscribe`'s `options.critical`).
 *
 * @example
 * ```typescript
 * import { CriticalHandlerError } from '@polymarket/errors/event-bus';
 *
 * const result = await eventBus.publish(event);
 * if (!result.ok && result.error instanceof CriticalHandlerError) {
 *   logger.error('Critical handler failed', {
 *     eventType: result.error.context?.eventType,
 *     original: result.error.context?.originalError,
 *   });
 * }
 * ```
 */

import { TradingError } from '../base/TradingError.js';
import type { ErrorSeverity } from '../base/index.js';

/**
 * Ошибка critical-подписчика EventBus.
 *
 * @remarks
 * Полное описание семантики и пример использования — см. докблок модуля выше.
 */
export class CriticalHandlerError extends TradingError {
  public readonly severity: ErrorSeverity = 'high';

  /** @internal */
  public static readonly code = 'CRITICAL_HANDLER_ERROR';
}

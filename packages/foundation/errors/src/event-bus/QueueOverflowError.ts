/**
 * QueueOverflowError — очередь EventBus переполнена
 *
 * @remarks
 * Выбрасывается когда `EventBus.publish()`/`publishAll()` не может поставить событие(я)
 * в очередь (превышен `maxQueueSize`), либо когда `_drainQueue()` упирается в
 * `maxEventsPerDrain` (возможный бесконечный цикл событий, часть событий не обработана).
 *
 * В отличие от `ValidationError` — это не ошибка входных данных, а операционное
 * состояние системы (очередь физически переполнена под нагрузкой), поэтому наследует
 * `TradingError` напрямую, по аналогии с `PortfolioOperationError`.
 * severity: 'high' — потерянные/непоставленные события означают риск рассинхронизации
 * состояния (пропущенный fill, необработанное обновление ордера).
 *
 * @example
 * ```typescript
 * import { QueueOverflowError } from '@polymarket/errors/event-bus';
 *
 * throw new QueueOverflowError(
 *   `EventBus queue overflow (${maxQueueSize}): cannot enqueue ${event.type}`,
 *   { context: { maxQueueSize, eventType: event.type } },
 * );
 * ```
 */

import { TradingError } from '../base/TradingError.js';
import type { ErrorSeverity } from '../base/index.js';

export class QueueOverflowError extends TradingError {
  public readonly severity: ErrorSeverity = 'high';

  /** @internal */
  public static readonly code = 'QUEUE_OVERFLOW_ERROR';
}

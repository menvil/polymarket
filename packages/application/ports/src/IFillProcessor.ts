/**
 * Порт: обработка fill-события (применение к Order + Portfolio + Ledger).
 *
 * @remarks
 * IFillProcessor — интерфейс для ProcessFillUseCase. Позволяет FillOrchestrator
 * зависеть от абстракции, а не от конкретного use-case из @polymarket/use-cases.
 *
 * Реализуется ProcessFillUseCase из @polymarket/use-cases.
 *
 * @example
 * ```typescript
 * const processor: IFillProcessor = processFillUseCase;
 * const result = await processor.execute(fill);
 * if (!result.ok) {
 *   logger.error('Fill processing failed', { error: result.error.message });
 * }
 * ```
 */

import type { Result } from '@polymarket/result';
import type { TradingError } from '@polymarket/errors';
import type { Fill } from '@polymarket/fill';
import type { MessageMetadata } from '@polymarket/messages';

/** Порт обработки fill-события — см. описание модуля выше. */
export interface IFillProcessor {
  /**
   * Обрабатывает fill: применяет к ордеру, портфелю и леджеру.
   *
   * @param fill - Fill для обработки
   * @param parentMetadata - Metadata сообщения-триггера (обычно FILL_RECEIVED) —
   *   события, порождённые обработкой, становятся его child в causal chain
   *   (M-003); без него порождённые события — root
   * @returns Ok если обработка успешна, Err с описанием ошибки
   */
  execute(fill: Fill, parentMetadata?: MessageMetadata): Promise<Result<void, TradingError>>;
}

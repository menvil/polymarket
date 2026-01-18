/**
 * MarketDataErrorEvent
 *
 * @remarks
 * Domain event для ошибок обработки market-data.
 * Эмитится когда aggregate.apply() нарушает инварианты или происходят другие ошибки.
 *
 * Использование:
 * - Мониторинг качества данных от биржи
 * - Логирование проблем с данными
 * - Алерты для операторов
 * - Статистика ошибок
 *
 * @example
 * ```typescript
 * // Invariant violation
 * const error = new MarketDataErrorEvent(
 *   'asset-123',
 *   'INVARIANT_VIOLATION',
 *   'Trade price 0.6 outside spread [0.52, 0.53]',
 *   {
 *     invariant: 'trade_price_within_spread',
 *     tradePrice: 0.6,
 *     spread: [0.52, 0.53]
 *   }
 * );
 *
 * // Processing error
 * const error2 = new MarketDataErrorEvent(
 *   'asset-456',
 *   'PROCESSING_ERROR',
 *   'Failed to create Price value object',
 *   { rawPrice: 'invalid', error: 'InvalidPriceError' }
 * );
 * ```
 */

import { DomainEvent } from './DomainEvent.js';

/**
 * Error type classification
 *
 * @remarks
 * - INVARIANT_VIOLATION: Нарушение бизнес-правил (time regression, price out of spread)
 * - PROCESSING_ERROR: Ошибка обработки события (invalid data, parsing error)
 * - UNKNOWN: Неизвестная ошибка
 */
export type MarketDataErrorType =
  | 'INVARIANT_VIOLATION'
  | 'PROCESSING_ERROR'
  | 'UNKNOWN';

/**
 * MarketDataErrorEvent
 *
 * @remarks
 * Domain event representing an error during market-data processing.
 */
export class MarketDataErrorEvent extends DomainEvent {
  /**
   * Создаёт новый MarketDataErrorEvent
   *
   * @param assetId - Asset ID where error occurred
   * @param errorType - Type of error
   * @param message - Error message
   * @param details - Additional error details (optional)
   * @param timestamp - When error occurred (defaults to now)
   *
   * @example
   * ```typescript
   * const event = new MarketDataErrorEvent(
   *   'asset-123',
   *   'INVARIANT_VIOLATION',
   *   'Time regression detected',
   *   { lastTime: '2024-01-01T12:00:00Z', newTime: '2024-01-01T11:59:00Z' }
   * );
   * ```
   */
  constructor(
    public readonly assetId: string,
    public readonly errorType: MarketDataErrorType,
    public readonly message: string,
    public readonly details?: Record<string, unknown>,
    timestamp: Date = new Date()
  ) {
    super('MarketDataError', timestamp);
  }

  /**
   * Gets error data for serialization
   *
   * @returns Error data object
   */
  protected getData(): Record<string, unknown> {
    return {
      assetId: this.assetId,
      errorType: this.errorType,
      message: this.message,
      details: this.details ?? null,
    };
  }

  /**
   * Checks if error is invariant violation
   *
   * @returns True if error is INVARIANT_VIOLATION
   *
   * @example
   * ```typescript
   * if (event.isInvariantViolation()) {
   *   console.log('Data quality issue from exchange');
   * }
   * ```
   */
  public isInvariantViolation(): boolean {
    return this.errorType === 'INVARIANT_VIOLATION';
  }

  /**
   * Checks if error is processing error
   *
   * @returns True if error is PROCESSING_ERROR
   *
   * @example
   * ```typescript
   * if (event.isProcessingError()) {
   *   console.log('Failed to process event');
   * }
   * ```
   */
  public isProcessingError(): boolean {
    return this.errorType === 'PROCESSING_ERROR';
  }

  /**
   * Converts to string representation
   *
   * @returns String representation
   *
   * @example
   * ```typescript
   * console.log(event.toString());
   * // "MarketDataError[asset-123]: INVARIANT_VIOLATION - Trade price outside spread"
   * ```
   */
  public toString(): string {
    return `MarketDataError[${this.assetId}]: ${this.errorType} - ${this.message}`;
  }
}

/**
 * OrderRejectedEvent - событие отклонения ордера
 *
 * @remarks
 * Публикуется когда биржа отклонила ордер (API error или WebSocket rejection).
 *
 * Причины rejection:
 * - Insufficient balance
 * - Invalid price/size
 * - Market constraints violation
 * - Rate limit exceeded
 * - Network error
 *
 * Используется для:
 * - Обновления OrderRepository (mark as REJECTED)
 * - Logging и debugging
 * - Metrics collection (rejection rate)
 * - Learning from errors (update constraints)
 */

import { DomainEvent } from './DomainEvent.js';

export class OrderRejectedEvent extends DomainEvent {
  constructor(
    public readonly orderId: string,
    public readonly reason: string,
    public readonly errorCode?: string,
    timestamp: Date = new Date()
  ) {
    super('OrderRejected', timestamp);
  }

  public isInsufficientBalance(): boolean {
    return (
      this.errorCode === 'INSUFFICIENT_BALANCE' ||
      this.reason.toLowerCase().includes('insufficient') ||
      this.reason.toLowerCase().includes('balance')
    );
  }

  public isConstraintsViolation(): boolean {
    const lowerReason = this.reason.toLowerCase();
    return (
      this.errorCode === 'CONSTRAINTS_VIOLATION' ||
      lowerReason.includes('min') ||
      lowerReason.includes('max') ||
      lowerReason.includes('tick') ||
      lowerReason.includes('size')
    );
  }

  protected getData(): Record<string, unknown> {
    return {
      orderId: this.orderId,
      reason: this.reason,
      errorCode: this.errorCode,
      isInsufficientBalance: this.isInsufficientBalance(),
      isConstraintsViolation: this.isConstraintsViolation(),
    };
  }

  public override toString(): string {
    return `OrderRejectedEvent[${this.orderId}] ${this.errorCode ? '(' + this.errorCode + ') ' : ''}${this.reason}`;
  }
}

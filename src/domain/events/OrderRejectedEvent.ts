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

  /**
   * Точные фразы для определения ошибок баланса (высокий приоритет, без false positives)
   */
  private static readonly BALANCE_PHRASES: string[] = [
    'insufficient balance',
    'insufficient_balance',
    'not enough balance',
    'low balance',
  ];

  /**
   * Гибкие паттерны для ошибок баланса (ловят вариации)
   */
  private static readonly BALANCE_PATTERNS: RegExp[] = [
    /\binsufficient\s+(funds|margin|collateral)\b/i,
    /\b(not\s+enough|no)\s+(funds|margin|collateral)\b/i,
    /\bbalance\s+(too\s+low|is\s+low)\b/i,
  ];

  /**
   * Точные фразы для нарушений ограничений (высокий приоритет)
   */
  private static readonly CONSTRAINTS_PHRASES: string[] = [
    'min size',
    'max size',
    'tick size',
    'minimum size',
    'maximum size',
    'minimum order',
    'maximum order',
  ];

  /**
   * Гибкие паттерны для нарушений ограничений
   */
  private static readonly CONSTRAINTS_PATTERNS: RegExp[] = [
    /\b(below|above|exceeds?)\s+(min|max|minimum|maximum|limit)\b/i,
    /\bsize\s+(too\s+)?(small|large|big)\b/i,
    /\b(order|amount|qty)\s+(too\s+)?(small|large|big)\b/i,
    /\bviolat(es?|ion)\s+(min|max|constraint|limit)\b/i,
  ];

  public isInsufficientBalance(): boolean {
    if (this.errorCode === 'INSUFFICIENT_BALANCE') {
      return true;
    }

    if (!this.reason) {
      return false;
    }

    const lowerReason = this.reason.toLowerCase();

    // Сначала проверяем точные фразы (быстро, без regex overhead)
    if (OrderRejectedEvent.BALANCE_PHRASES.some(phrase => lowerReason.includes(phrase))) {
      return true;
    }

    // Затем гибкие паттерны для вариаций
    return OrderRejectedEvent.BALANCE_PATTERNS.some(pattern => pattern.test(this.reason));
  }

  public isConstraintsViolation(): boolean {
    if (this.errorCode === 'CONSTRAINTS_VIOLATION') {
      return true;
    }

    if (!this.reason) {
      return false;
    }

    const lowerReason = this.reason.toLowerCase();

    // Сначала проверяем точные фразы
    if (OrderRejectedEvent.CONSTRAINTS_PHRASES.some(phrase => lowerReason.includes(phrase))) {
      return true;
    }

    // Затем гибкие паттерны
    return OrderRejectedEvent.CONSTRAINTS_PATTERNS.some(pattern => pattern.test(this.reason));
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

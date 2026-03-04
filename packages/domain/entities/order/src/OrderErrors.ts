/**
 * Ошибки домена Order
 */

export class OrderError extends Error {
  public readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'OrderError';
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

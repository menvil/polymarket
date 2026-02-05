/**
 * OrderId - идентификатор ордера
 *
 * @remarks
 * Branded type для type safety.
 *
 * Может быть:
 * - Venue order ID (от биржи)
 * - Internal order ID (наш внутренний)
 *
 * @example
 * ```typescript
 * const orderId = 'order_123abc' as OrderId;
 * ```
 */
export type OrderId = string & { readonly __brand: 'OrderId' };

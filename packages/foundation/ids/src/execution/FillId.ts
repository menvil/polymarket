/**
 * FillId - идентификатор исполнения (fill/trade)
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет уникальный ID исполнения ордера.
 *
 * @example
 * ```typescript
 * const fillId = 'fill_456def' as FillId;
 * ```
 */
export type FillId = string & { readonly __brand: 'FillId' };

/**
 * OrderbookValidationError - ошибка валидации данных orderbook
 *
 * @remarks
 * Используется в OrderbookNormalizer при парсинге и нормализации сырых данных.
 * Низкая severity — это ошибки входных данных, не системные сбои.
 *
 * Возникает при:
 * - Некорректном или отсутствующем marketId/tokenId
 * - Некорректных price/quantity в уровнях (не число, NaN)
 * - Невалидном формате массивов bids/asks
 * - Ошибках создания Price/Quantity Value Objects из сырых данных
 *
 * @example
 * ```typescript
 * import { OrderbookValidationError } from '@polymarket/errors/orderbook';
 *
 * return Err(new OrderbookValidationError('Missing or invalid marketId', {
 *   context: { field: 'marketId', value: raw.marketId },
 * }));
 * ```
 */

import { TradingError } from '../base/TradingError.js';

/**
 * Ошибка валидации orderbook
 *
 * @remarks
 * Extends TradingError из @polymarket/errors.
 * Severity 'low' — ошибки входных данных, не системные сбои.
 */
export class OrderbookValidationError extends TradingError {
  public static readonly code = 'ORDERBOOK_VALIDATION_ERROR';
  public override readonly severity = 'low' as const;
}

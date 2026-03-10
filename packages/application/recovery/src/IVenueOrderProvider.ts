/**
 * Порт: провайдер активных ордеров от venue.
 *
 * @remarks
 * Используется OrderReconciler для получения актуального списка
 * открытых ордеров с биржи для сверки с локальным репозиторием.
 *
 * Реализация в infrastructure layer:
 * `PolymarketVenueOrderAdapter` → `PolymarketOrderRestClient.getOpenOrders()`
 *
 * @example
 * ```typescript
 * const venueOrderIds = await venueOrderProvider.getOpenOrderIds();
 * // → ['0xabc123', '0xdef456']
 * ```
 */

/**
 * Порт: получение ID активных (открытых) ордеров от venue.
 */
export interface IVenueOrderProvider {
  /**
   * Возвращает ID всех открытых ордеров на venue.
   *
   * @returns Массив ID активных ордеров (open/partially_filled)
   * @throws При ошибке REST API
   */
  getOpenOrderIds(): Promise<readonly string[]>;
}

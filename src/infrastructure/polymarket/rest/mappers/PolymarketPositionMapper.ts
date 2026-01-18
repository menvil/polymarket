/**
 * Маппер позиций Polymarket
 *
 * @remarks
 * Преобразует сырые ответы API Polymarket по позициям в доменные типы.
 *
 * Преобразования:
 * - Конвертация строк → чисел
 * - Нормализация имён полей
 * - Безопасные значения по умолчанию для отсутствующих полей
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketPositionMapper();
 *
 * // Формат Data API (числа, не строки)
 * const rawPosition = {
 *   asset: '0x123',
 *   conditionId: 'market-456',
 *   size: 50.5,
 *   avgPrice: 0.52,
 *   currentValue: 52.5,
 *   cashPnl: 10.5,
 *   percentPnl: 0.2,
 * };
 *
 * const normalized = mapper.toDomainPosition(rawPosition);
 * // { tokenId: '0x123', marketId: 'market-456', size: 50.5, averagePrice: 0.52, ... }
 * ```
 */

import type { PositionResponse as ApiPositionResponse } from '../clients/PolymarketPositionsRestClient.js';
import type { PositionResponse } from '../../../exchange/types/PositionResponse.js';

/**
 * Маппер позиций Polymarket
 */
export class PolymarketPositionMapper {

  /**
   * Преобразует ответ API позиции в формат домена
   *
   * @param response - Сырой ответ API из Data API
   * @returns Нормализованная доменная позиция
   *
   * @remarks
   * Формат ответа Data API (числа, не строки):
   * - asset: ID токена
   * - size: Размер позиции (количество акций)
   * - avgPrice: Средняя цена входа
   * - cashPnl: Реализованный PnL
   *
   * @example
   * ```typescript
   * const rawPosition = {
   *   asset: '0x123',
   *   conditionId: 'market-456', // API возвращает conditionId
   *   size: 50.5,
   *   avgPrice: 0.52,
   *   currentValue: 52.5,
   *   cashPnl: 10.5,
   *   percentPnl: 0.2,
   * };
   *
   * const normalized = mapper.toDomainPosition(rawPosition);
   * console.log(normalized.marketId); // 'market-456' (маппится из conditionId)
   * console.log(normalized.size); // 50.5
   * ```
   */
  toDomainPosition(response: ApiPositionResponse): PositionResponse {
    // ✅ Safe defaults: защита от null/undefined → NaN
    // Data API возвращает числа напрямую, но поля могут отсутствовать
    const size = response.size ?? 0;
    const averagePrice = response.avgPrice ?? 0;
    const realizedPnl = response.cashPnl ?? 0;
    const currentValue = response.currentValue ?? 0;

    // Data API не возвращает unrealizedPnl отдельно, вычисляем из currentValue
    // currentValue = size * currentPrice, поэтому unrealized = (currentValue - size * avgPrice)
    // Используем safe values для предотвращения NaN
    const unrealizedPnl = currentValue - size * averagePrice;

    return {
      tokenId: response.asset ?? '',
      marketId: response.conditionId ?? '', // API возвращает conditionId, маппим на marketId
      size,
      averagePrice,
      realizedPnl,
      unrealizedPnl,
      updatedAt: Date.now(), // Data API не возвращает timestamp
    };
  }

  /**
   * Преобразует несколько ответов API позиций в формат домена
   *
   * @param responses - Массив сырых ответов API
   * @returns Массив нормализованных доменных позиций
   *
   * @example
   * ```typescript
   * const rawPositions = await positionsClient.getPositions();
   * const normalized = mapper.toDomainPositions(rawPositions);
   *
   * console.log(`Total positions: ${normalized.length}`);
   * ```
   */
  toDomainPositions(responses: ApiPositionResponse[]): PositionResponse[] {
    return responses.map((response) => this.toDomainPosition(response));
  }
}

/**
 * Маппер позиций Polymarket
 *
 * @remarks
 * Преобразует необработанные ответы API Polymarket по позициям в доменные типы.
 *
 * Преобразования:
 * - Конвертация строки → число
 * - Нормализация имён полей
 * - Безопасные значения по умолчанию для отсутствующих полей
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketPositionMapper();
 *
 * const rawPosition = {
 *   tokenId: '0x123',
 *   quantity: '50.5',
 *   side: 'YES',
 *   averagePrice: '0.52',
 *   realizedPnl: '10.5',
 *   unrealizedPnl: '5.25',
 * };
 *
 * const normalized = mapper.toDomainPosition(rawPosition);
 * // { tokenId: '0x123', size: 50.5, averagePrice: 0.52, ... }
 * ```
 */

import type { PositionResponse as ApiPositionResponse } from '../clients/PolymarketPositionsRestClient.js';
import type { PositionResponse } from '../../ports/IPortfolioAdapter.js';

/**
 * Маппер позиций Polymarket
 */
export class PolymarketPositionMapper {

  /**
   * Преобразовать ответ API по позиции в доменный формат
   *
   * @param response - Необработанный ответ API из Data API
   * @returns Нормализованная доменная позиция
   *
   * @remarks
   * Формат ответа Data API (числа, не строки):
   * - asset: идентификатор токена
   * - size: размер позиции (количество акций)
   * - avgPrice: средняя цена входа
   * - cashPnl: реализованный PnL
   *
   * @example
   * ```typescript
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
   * console.log(normalized.size); // 50.5
   * ```
   */
  toDomainPosition(response: ApiPositionResponse): PositionResponse {
    // Data API возвращает числа напрямую, парсинг не нужен
    const size = response.size;
    const averagePrice = response.avgPrice;
    const realizedPnl = response.cashPnl;

    // Data API не возвращает unrealizedPnl отдельно — вычисляем из currentValue
    // currentValue = size * currentPrice, поэтому unrealized = (currentValue - size * avgPrice)
    const unrealizedPnl = response.currentValue - size * averagePrice;

    return {
      tokenId: response.asset,
      conditionId: response.conditionId, // Передаём для сопоставления со стратегией
      size,
      averagePrice,
      realizedPnl,
      unrealizedPnl,
      updatedAt: Date.now(), // Data API не возвращает временну́ю метку
    };
  }

  /**
   * Преобразовать несколько ответов API по позициям в доменный формат
   *
   * @param responses - Массив необработанных ответов API
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

/**
 * REST-клиент позиций Polymarket
 *
 * @remarks
 * Обрабатывает endpoint /positions Data API:
 * - GET https://data-api.polymarket.com/positions - Получить позиции пользователя
 *
 * **КРИТИЧНО**: Использует Data API (data-api.polymarket.com), НЕ CLOB API!
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется маппером в вышестоящих слоях.
 *
 * **ВАЖНО**: Позиции — это ИСПОЛНЕННЫЕ сделки, НЕ открытые ордера.
 * Для открытых ордеров используйте PolymarketOrdersRestClient.
 *
 * @example
 * ```typescript
 * const dataApiClient = new PolymarketDataApiClient({ baseUrl: 'https://data-api.polymarket.com' }, logger);
 * const client = new PolymarketPositionsRestClient(dataApiClient, userAddress, logger);
 *
 * const positions = await client.getPositions();
 * console.log(`Total positions: ${positions.length}`);
 *
 * const tokenPositions = await client.getPositions('condition-id-123');
 * console.log(`Market positions: ${tokenPositions.length}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketDataApiClient } from '../PolymarketDataApiClient.js';

/**
 * Ответ с позицией (сырой формат Data API)
 *
 * @remarks
 * Из https://data-api.polymarket.com/positions
 */
export interface PositionResponse {
  /** Идентификатор токена актива */
  asset: string;

  /** Идентификатор условия (маркет) */
  conditionId: string;

  /** Размер позиции (количество акций) */
  size: number;

  /** Средняя цена входа */
  avgPrice: number;

  /** Текущая рыночная стоимость */
  currentValue: number;

  /** PnL в денежном выражении */
  cashPnl: number;

  /** PnL в процентах */
  percentPnl: number;

  /** Метаданные маркета (вложенный объект из API) */
  market?: any;
}

/**
 * REST-клиент позиций Polymarket
 */
export class PolymarketPositionsRestClient {
  constructor(
    private readonly dataApiClient: PolymarketDataApiClient,
    private readonly userAddress: string,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить позиции пользователя
   *
   * @param conditionId - Необязательно: фильтр по condition ID маркета
   * @returns Массив позиций
   * @throws {Error} При ошибке API-вызова
   *
   * @remarks
   * Использует Data API (data-api.polymarket.com), НЕ CLOB API.
   * Возвращает исполненные сделки, НЕ открытые ордера.
   * Возвращает сырой ответ API (массив позиций).
   *
   * API Endpoint: GET https://data-api.polymarket.com/positions
   * Параметры:
   * - user: Адрес кошелька пользователя (обязательно)
   * - market: Фильтр по condition ID (необязательно)
   *
   * @example
   * ```typescript
   * // Все позиции пользователя
   * const allPositions = await client.getPositions();
   * console.log(`Total positions: ${allPositions.length}`);
   *
   * // Позиции для конкретного маркета
   * const marketPositions = await client.getPositions('condition-id-123');
   * console.log(`Market positions: ${marketPositions.length}`);
   * ```
   */
  async getPositions(conditionId?: string): Promise<PositionResponse[]> {
    this.logger.debug('Getting positions from Data API', {
      user: this.userAddress,
      market: conditionId,
    });

    const params: Record<string, string> = {
      user: this.userAddress, // КРИТИЧНО: Data API использует 'user', не 'address'
    };

    if (conditionId) {
      params.market = conditionId; // КРИТИЧНО: Data API использует 'market' (conditionId), не 'tokenId'
    }

    // Data API возвращает массив напрямую, не обёрнутый в {positions: []}
    const positions = await this.dataApiClient.get<PositionResponse[]>('/positions', params);

    this.logger.debug('Positions retrieved from Data API', {
      count: positions.length,
    });

    // Детальное логирование позиций для отладки инвентаря
    this.logger.info('GET /positions FULL RESPONSE', {
      count: positions.length,
      user: this.userAddress.substring(0, 12) + '...',
      marketFilter: conditionId || 'ALL',
      positions: positions.length > 0 ? JSON.stringify(positions, null, 2) : 'NO POSITIONS',
    });

    return positions;
  }

  /**
   * Получить позицию для конкретного актива (токена)
   *
   * @param assetId - Идентификатор токена актива
   * @returns Ответ с позицией или undefined если не найдена
   * @throws {Error} При ошибке API-вызова
   *
   * @remarks
   * Запрашивает все позиции пользователя и фильтрует по ID актива.
   * Для лучшей производительности используйте фильтр по маркету в getPositions().
   *
   * @example
   * ```typescript
   * const position = await client.getPositionForAsset('token-id-123');
   *
   * if (position) {
   *   console.log(`Size: ${position.size}`);
   *   console.log(`Avg price: ${position.avgPrice}`);
   *   console.log(`Cash PnL: ${position.cashPnl}`);
   * }
   * ```
   */
  async getPositionForAsset(assetId: string): Promise<PositionResponse | undefined> {
    this.logger.debug('Getting position for asset', { asset: assetId });

    // Получаем все позиции (без фильтра по маркету)
    const positions = await this.getPositions();

    // Фильтруем по ID актива
    const position = positions.find((p) => p.asset === assetId);

    if (position) {
      this.logger.debug('Position found', {
        asset: assetId,
        size: position.size,
        cashPnl: position.cashPnl,
      });
    } else {
      this.logger.debug('Position not found', { asset: assetId });
    }

    return position;
  }
}

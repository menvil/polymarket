/**
 * REST-клиент для позиций Polymarket
 *
 * @remarks
 * Обрабатывает эндпоинт Data API /positions:
 * - GET https://data-api.polymarket.com/positions - Получить позиции пользователя
 *
 * **КРИТИЧНО**: Использует Data API (data-api.polymarket.com), НЕ CLOB API!
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется мапперами на более высоких уровнях.
 *
 * **ВАЖНО**: Позиции - это ИСПОЛНЕННЫЕ сделки, НЕ открытые ордера.
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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketDataApiClient } from '../PolymarketDataApiClient.js';

/**
 * Ответ с позицией (сырой формат Data API)
 *
 * @remarks
 * Из https://data-api.polymarket.com/positions
 */
export interface PositionResponse {
  /** ID токена актива */
  asset: string;

  /** ID условия (рынок) */
  conditionId: string;

  /** Размер позиции (количество акций) */
  size: number;

  /** Средняя цена входа */
  avgPrice: number;

  /** Текущая рыночная стоимость */
  currentValue: number;

  /** Денежная прибыль/убыток */
  cashPnl: number;

  /** Процентная прибыль/убыток */
  percentPnl: number;

  /** Метаданные рынка (вложенный объект из API) */
  market?: any;
}

/**
 * REST-клиент для позиций Polymarket
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
   * @param conditionId - Опционально: фильтр по ID условия рынка
   * @returns Массив позиций
   * @throws {Error} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Использует Data API (data-api.polymarket.com), НЕ CLOB API.
   * Возвращает исполненные сделки, НЕ открытые ордера.
   * Возвращает сырой ответ API (массив позиций).
   *
   * API Эндпоинт: GET https://data-api.polymarket.com/positions
   * Параметры:
   * - user: Адрес кошелька пользователя (обязательно)
   * - market: Фильтр по ID условия (опционально)
   *
   * @example
   * ```typescript
   * // All positions for user
   * const allPositions = await client.getPositions();
   * console.log(`Total positions: ${allPositions.length}`);
   *
   * // Positions for specific market
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
      user: this.userAddress, // КРИТИЧНО: Data API использует 'user', а не 'address'
    };

    if (conditionId) {
      params.market = conditionId; // КРИТИЧНО: Data API использует 'market' (conditionId), а не 'tokenId'
    }

    // Data API возвращает массив напрямую, не обернутый в {positions: []}
    const positions = await this.dataApiClient.get<PositionResponse[]>('/positions', params);

    this.logger.debug('Positions retrieved from Data API', {
      count: positions.length,
    });

    // ✅ v6.2: Детальное логирование позиций для отладки инвентаря
    this.logger.info('📦 GET /positions FULL RESPONSE', {
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
   * @param assetId - ID токена актива
   * @returns Ответ с позицией или undefined, если не найдена
   * @throws {Error} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Получает все позиции пользователя и фильтрует по ID актива.
   * Для лучшей производительности используйте фильтрацию по рынку в getPositions().
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

    // Получить все позиции (без фильтра по рынку)
    const positions = await this.getPositions();

    // Отфильтровать по ID актива
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

/**
 * PositionProvider - adapter для получения позиций через PolymarketPositionRestClient
 *
 * @remarks
 * Реализует IPositionProvider интерфейс для ValidationContextProvider.
 * Делает HTTP запросы к Polymarket API для получения позиций.
 *
 * @example
 * ```typescript
 * const positionProvider = new PositionProvider(positionClient, logger, maxPositionLimit);
 * const state = await positionProvider.getPositionState('token-yes');
 * console.log(`Position: ${state.currentPosition}, Limit: ${state.positionLimit}`);
 * ```
 */

import type { IPositionProvider } from '../../../../application/execution/ValidationContextProvider.js';
import type { PolymarketPositionRestClient } from '../../clients/PolymarketPositionRestClient.js';
import type { ILogger } from '../../../../domain/ports/ILogger.js';

/**
 * PositionProvider - adapter для IPositionProvider
 *
 * @remarks
 * Использует PolymarketPositionRestClient для HTTP запросов.
 * Position limit настраивается через конфигурацию (risk management).
 */
export class PositionProvider implements IPositionProvider {
  /**
   * Создаёт PositionProvider
   *
   * @param positionClient - REST client для получения позиций
   * @param logger - Logger для structured logging
   * @param maxPositionLimit - Максимальный размер позиции (risk management)
   *
   * @remarks
   * maxPositionLimit - это risk management constraint.
   * Устанавливается через конфигурацию (например, из env или config file).
   *
   * @example
   * ```typescript
   * const provider = new PositionProvider(client, logger, 10000);
   * ```
   */
  constructor(
    private readonly positionClient: PolymarketPositionRestClient,
    private readonly logger: ILogger,
    private readonly maxPositionLimit: number
  ) {}

  /**
   * Получает текущую позицию для токена
   *
   * @param tokenId - Token ID
   * @returns Position state (current position + limit)
   *
   * @remarks
   * Делает HTTP запрос к Polymarket API.
   * Возвращает:
   * - currentPosition: текущая позиция (+ для long, - для short)
   * - positionLimit: максимальный размер позиции (abs)
   * - unrealizedPnl: нереализованный P&L (optional)
   *
   * ВАЖНО:
   * - positionLimit берётся из конфигурации (maxPositionLimit)
   * - currentPosition берётся из API
   *
   * @example
   * ```typescript
   * const state = await provider.getPositionState('0x123...');
   * // {
   * //   currentPosition: 500,
   * //   positionLimit: 10000,
   * //   unrealizedPnl: 12.34
   * // }
   * ```
   */
  public async getPositionState(tokenId: string): Promise<{
    currentPosition: number;
    positionLimit: number;
    unrealizedPnl?: number;
  }> {
    try {
      // positionClient.getPosition(tokenId) возвращает position info
      const position = await this.positionClient.getPosition(tokenId);

      // If no position exists, return 0
      if (!position) {
        this.logger.debug('[PositionProvider] No position found', {
          tokenId: tokenId.substring(0, 16) + '...',
        });

        return {
          currentPosition: 0,
          positionLimit: this.maxPositionLimit,
        };
      }

      // Parse position size (может быть положительным или отрицательным)
      const currentPosition = parseFloat(position.size);
      const unrealizedPnl = position.unrealizedPnl
        ? parseFloat(position.unrealizedPnl)
        : undefined;

      this.logger.debug('[PositionProvider] Position fetched', {
        tokenId: tokenId.substring(0, 16) + '...',
        currentPosition,
        positionLimit: this.maxPositionLimit,
        unrealizedPnl,
      });

      return {
        currentPosition,
        positionLimit: this.maxPositionLimit,
        unrealizedPnl,
      };
    } catch (error) {
      this.logger.error('[PositionProvider] Failed to fetch position', {
        tokenId: tokenId.substring(0, 16) + '...',
        error: error instanceof Error ? error.message : String(error),
      });

      // Re-throw error (caller will handle it)
      throw error;
    }
  }
}

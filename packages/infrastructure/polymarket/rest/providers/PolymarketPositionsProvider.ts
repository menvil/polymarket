/**
 * Провайдер позиций Polymarket (множественное число!)
 *
 * @remarks
 * Реализует интерфейс IPositionsProvider.
 * Использует PolymarketPositionsRestClient + PolymarketPositionMapper.
 *
 * **ВАЖНО**: Это множественное число "Positions" (не единственное "Position"),
 * поскольку управляет несколькими позициями.
 *
 * Обязанности:
 * - Получение данных позиций из API
 * - Нормализация данных с помощью маппера
 * - Возврат позиций в доменном формате
 *
 * @example
 * ```typescript
 * const provider = new PolymarketPositionsProvider(
 *   positionsClient,
 *   mapper,
 *   logger
 * );
 *
 * const positions = await provider.getPositions();
 * console.log(`Total positions: ${positions.length}`);
 *
 * const state = await provider.getPositionState('0x123');
 * console.log(`Current: ${state.currentPosition}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type {
  IPositionsProvider,
  PositionResponse,
  PositionState,
} from '../../ports/IPositionsProvider.js';
import type { PolymarketPositionsRestClient } from '../clients/PolymarketPositionsRestClient.js';
import type { PolymarketPositionMapper } from '../mappers/PolymarketPositionMapper.js';

/**
 * Провайдер позиций Polymarket (множественное число!)
 *
 * @remarks
 * Реализует IPositionsProvider для Polymarket.
 */
export class PolymarketPositionsProvider implements IPositionsProvider {
  constructor(
    private readonly positionsClient: PolymarketPositionsRestClient,
    private readonly mapper: PolymarketPositionMapper,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить текущие позиции (исполненные сделки)
   *
   * @param tokenId - Опционально: фильтр по идентификатору токена
   * @returns Массив позиций
   * @throws {ApiError} При ошибке вызова API
   *
   * @remarks
   * Возвращает исполненные сделки, НЕ открытые ордера.
   *
   * @example
   * ```typescript
   * const positions = await provider.getPositions();
   * console.log(`Total positions: ${positions.length}`);
   *
   * const btcPositions = await provider.getPositions('BTC-USD');
   * console.log(`BTC position: ${btcPositions[0].size}`);
   * ```
   */
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    this.logger.debug('Getting positions', { tokenId });

    // Дублирующий лог удалён (логируется в PolymarketPositionsRestClient)
    const rawPositions = await this.positionsClient.getPositions(tokenId);
    const normalized = this.mapper.toDomainPositions(rawPositions);
    return normalized;
  }

  /**
   * Получить состояние позиции для конкретного токена
   *
   * @param tokenId - Идентификатор токена
   * @returns Состояние позиции с лимитами
   * @throws {ApiError} При ошибке вызова API
   *
   * @remarks
   * Используется для валидации перед размещением ордеров.
   * Проверяет текущий размер позиции и лимиты.
   *
   * @example
   * ```typescript
   * const state = await provider.getPositionState('0x123');
   *
   * if (state.canIncrease) {
   *   console.log(`Can increase position up to ${state.positionLimit}`);
   * }
   * ```
   */
  async getPositionState(tokenId: string): Promise<PositionState> {
    this.logger.debug('Getting position state', { tokenId });

    const rawPosition = await this.positionsClient.getPositionForAsset(tokenId);

    const currentPosition = rawPosition
      ? this.mapper.toDomainPosition(rawPosition).size
      : 0;

    // Лимит позиции по умолчанию (можно настроить)
    const positionLimit = 1000;

    const canIncrease = Math.abs(currentPosition) < positionLimit;
    const canDecrease = currentPosition !== 0;

    this.logger.debug('Position state retrieved', {
      tokenId,
      currentPosition,
      positionLimit,
      canIncrease,
      canDecrease,
    });

    return {
      currentPosition,
      positionLimit,
      canIncrease,
      canDecrease,
    };
  }

  /**
   * Получить суммарный нереализованный PnL по всем позициям
   *
   * @returns Суммарный нереализованный PnL
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const unrealizedPnl = await provider.getTotalUnrealizedPnl();
   * console.log(`Total unrealized PnL: ${unrealizedPnl}`);
   * ```
   */
  async getTotalUnrealizedPnl(): Promise<number> {
    this.logger.debug('Getting total unrealized PnL');

    const positions = await this.getPositions();
    const totalUnrealizedPnl = positions.reduce(
      (sum, position) => sum + position.unrealizedPnl,
      0
    );

    this.logger.debug('Total unrealized PnL calculated', {
      totalUnrealizedPnl,
      positionsCount: positions.length,
    });

    return totalUnrealizedPnl;
  }

  /**
   * Получить суммарный реализованный PnL по всем позициям
   *
   * @returns Суммарный реализованный PnL
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const realizedPnl = await provider.getTotalRealizedPnl();
   * console.log(`Total realized PnL: ${realizedPnl}`);
   * ```
   */
  async getTotalRealizedPnl(): Promise<number> {
    this.logger.debug('Getting total realized PnL');

    const positions = await this.getPositions();
    const totalRealizedPnl = positions.reduce(
      (sum, position) => sum + position.realizedPnl,
      0
    );

    this.logger.debug('Total realized PnL calculated', {
      totalRealizedPnl,
      positionsCount: positions.length,
    });

    return totalRealizedPnl;
  }
}

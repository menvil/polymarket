/**
 * Порт провайдера позиций.
 */

/** Позиция по токену */
export interface PositionResponse {
  tokenId: string;
  size: number;
  averagePrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  conditionId?: string;
  updatedAt?: number;
}

/** Текущее состояние позиции */
export interface PositionState {
  currentPosition: number;
  positionLimit: number;
  canIncrease: boolean;
  canDecrease: boolean;
  averageEntryPrice?: number;
}

/**
 * Интерфейс для получения позиций пользователя.
 */
export interface IPositionsProvider {
  getPositions(tokenId?: string): Promise<PositionResponse[]>;
  getPositionState(tokenId: string): Promise<PositionState | undefined>;
}

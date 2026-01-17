/**
 * Унифицированный тип ответа с позицией
 *
 * @remarks
 * Общий тип для всех интерфейсов, работающих с позициями:
 * - IPositionsProvider (чтение позиций)
 * - IPortfolioAdapter (адаптер портфеля)
 *
 * Нормализованный формат для любой биржи.
 */
export interface PositionResponse {
  /** ID токена */
  tokenId: string;

  /** Market ID - используется для сопоставления со стратегией */
  marketId?: string;

  /** Размер позиции (положительный = long, отрицательный = short) */
  size: number;

  /** Средняя цена входа */
  averagePrice: number;

  /** Реализованный PnL */
  realizedPnl: number;

  /** Нереализованный PnL */
  unrealizedPnl: number;

  /** Временная метка последнего обновления (мс) */
  updatedAt: number;
}

/**
 * Состояние позиции (для валидации)
 */
export interface PositionState {
  /** Текущий размер позиции */
  currentPosition: number;

  /** Лимит позиции (макс размер) */
  positionLimit: number;

  /** Можно ли увеличить позицию */
  canIncrease: boolean;

  /** Можно ли уменьшить позицию */
  canDecrease: boolean;
}
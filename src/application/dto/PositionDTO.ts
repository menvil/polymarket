/**
 * Position Data Transfer Object
 *
 * @remarks
 * DTO для передачи данных о позиции между слоями.
 *
 * @example
 * ```typescript
 * const positionDTO: PositionDTO = {
 *   tokenId: 'token-yes',
 *   side: 'YES',
 *   totalQuantity: 100,
 *   averageEntryPrice: 0.65,
 *   currentPrice: 0.70,
 *   unrealizedPnL: 5.0,
 *   unrealizedPnLPercent: 7.69,
 *   costBasis: 65.0,
 *   marketValue: 70.0,
 *   lotCount: 2
 * };
 * ```
 */

/**
 * Position DTO interface
 */
export interface PositionDTO {
  /** ID токена */
  tokenId: string;

  /** Сторона (YES или NO) */
  side: 'YES' | 'NO';

  /** Общее количество */
  totalQuantity: number;

  /** Средняя цена входа */
  averageEntryPrice: number;

  /** Текущая рыночная цена */
  currentPrice?: number;

  /** Нереализованный P&L в USDC */
  unrealizedPnL: number;

  /** Нереализованный P&L в процентах */
  unrealizedPnLPercent: number;

  /** Cost basis (сумма покупки) */
  costBasis: number;

  /** Текущая рыночная стоимость */
  marketValue: number;

  /** Количество лотов */
  lotCount: number;

  /** Информация о лотах (опционально) */
  lots?: PositionLotDTO[];
}

/**
 * Position Lot DTO
 */
export interface PositionLotDTO {
  /** ID лота */
  lotId: string;

  /** Количество */
  quantity: number;

  /** Цена входа */
  entryPrice: number;

  /** Время создания */
  timestamp: string;

  /** Cost basis лота */
  costBasis: number;

  /** Unrealized P&L лота */
  unrealizedPnL?: number;
}

/**
 * Конвертирует Position entity в PositionDTO
 *
 * @param position - Position entity
 * @param currentPrice - Текущая рыночная цена
 * @returns PositionDTO
 */
export function toPositionDTO(position: any, currentPrice?: number): PositionDTO {
  const pnl = currentPrice
    ? position.calculateUnrealizedPnL({ value: currentPrice })
    : { amount: 0 };

  const costBasis = position.getTotalCost().amount;
  const marketValue = currentPrice
    ? position.totalQuantity.value * currentPrice
    : costBasis;

  const pnlPercent = costBasis > 0 ? (pnl.amount / costBasis) * 100 : 0;

  return {
    tokenId: position.tokenId,
    side: position.side,
    totalQuantity: position.totalQuantity.value,
    averageEntryPrice: position.averageEntryPrice.value,
    currentPrice,
    unrealizedPnL: pnl.amount,
    unrealizedPnLPercent: pnlPercent,
    costBasis,
    marketValue,
    lotCount: position.getLotCount(),
    lots: position.lots.map((lot: any) => toPositionLotDTO(lot, currentPrice)),
  };
}

/**
 * Конвертирует PositionLot в DTO
 */
export function toPositionLotDTO(
  lot: any,
  currentPrice?: number
): PositionLotDTO {
  const pnl = currentPrice
    ? lot.calculateUnrealizedPnL({ value: currentPrice })
    : undefined;

  return {
    lotId: lot.lotId,
    quantity: lot.quantity.value,
    entryPrice: lot.entryPrice.value,
    timestamp: lot.timestamp.toISOString(),
    costBasis: lot.calculateCost().amount,
    unrealizedPnL: pnl?.amount,
  };
}

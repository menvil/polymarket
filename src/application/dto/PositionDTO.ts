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
 * Convert a Position entity into a PositionDTO.
 *
 * When `currentPrice` is provided, unrealized P&L, market value, and per-lot unrealized P&L are computed from that price; when omitted, unrealized P&L defaults to 0 and market value falls back to the position's cost basis.
 *
 * @param position - The Position entity to convert
 * @param currentPrice - Optional current market price used to calculate unrealized P&L and market value
 * @returns A PositionDTO containing tokenId, side, totalQuantity, averageEntryPrice, optional currentPrice, unrealizedPnL, unrealizedPnLPercent, costBasis, marketValue, lotCount, and an optional `lots` array
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
 * Converts a PositionLot entity into a PositionLotDTO.
 *
 * @param lot - Position lot entity to convert
 * @param currentPrice - Optional current market price used to compute unrealized P&L
 * @returns A PositionLotDTO containing `lotId`, `quantity`, `entryPrice`, ISO `timestamp`, `costBasis`, and optional `unrealizedPnL` when `currentPrice` is provided
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
/**
 * Portfolio Data Transfer Object
 *
 * @remarks
 * DTO для передачи данных о портфеле.
 *
 * @example
 * ```typescript
 * const portfolioDTO: PortfolioDTO = {
 *   id: 'portfolio-1',
 *   cash: 935.0,
 *   reservedCash: 65.0,
 *   availableCash: 870.0,
 *   totalValue: 1005.0,
 *   totalUnrealizedPnL: 5.0,
 *   totalUnrealizedPnLPercent: 0.5,
 *   positionCount: 2,
 *   positions: [...]
 * };
 * ```
 */
import { PositionDTO } from './PositionDTO.js';

/**
 * Portfolio DTO interface
 */
export interface PortfolioDTO {
  /** ID портфеля */
  id: string;

  /** Общий cash в USDC */
  cash: number;

  /** Резервированный cash (для BUY ордеров) */
  reservedCash: number;

  /** Доступный cash */
  availableCash: number;

  /** Общая стоимость портфеля (cash + positions) */
  totalValue: number;

  /** Общий нереализованный P&L */
  totalUnrealizedPnL: number;

  /** Общий нереализованный P&L в процентах */
  totalUnrealizedPnLPercent: number;

  /** Количество позиций */
  positionCount: number;

  /** Массив позиций */
  positions: PositionDTO[];

  /** Время снапшота */
  timestamp?: string;
}

/**
 * Convert a Portfolio entity into a transport-friendly PortfolioDTO containing per-position metrics and aggregated totals.
 *
 * @param portfolio - Domain Portfolio entity to convert
 * @param marketPrices - Map of current prices keyed by tokenId used to compute each position's market value and unrealized PnL
 * @returns A PortfolioDTO containing id, cash balances, positions (with pricing, cost basis, market value, unrealized PnL, and lot count), aggregated totals (total value, total unrealized PnL and percent), position count, and an ISO timestamp
 */
export function toPortfolioDTO(
  portfolio: any,
  marketPrices: Map<string, number>
): PortfolioDTO {
  const positions: PositionDTO[] = [];

  for (const [tokenId, position] of portfolio.positions.entries()) {
    const currentPrice = marketPrices.get(tokenId);
    positions.push({
      tokenId: position.tokenId,
      side: position.side,
      totalQuantity: position.totalQuantity.value,
      averageEntryPrice: position.averageEntryPrice.value,
      currentPrice,
      unrealizedPnL: currentPrice
        ? position.calculateUnrealizedPnL({ value: currentPrice }).amount
        : 0,
      unrealizedPnLPercent: 0, // будет вычислено ниже
      costBasis: position.getTotalCost().amount,
      marketValue: currentPrice ? position.totalQuantity.value * currentPrice : 0,
      lotCount: position.getLotCount(),
    });
  }

  // Вычисляем суммы
  const totalUnrealizedPnL = positions.reduce(
    (sum, p) => sum + p.unrealizedPnL,
    0
  );
  const totalCostBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const totalMarketValue = positions.reduce((sum, p) => sum + p.marketValue, 0);

  const totalValue = portfolio.cash.amount + totalMarketValue;
  const totalUnrealizedPnLPercent =
    totalCostBasis > 0 ? (totalUnrealizedPnL / totalCostBasis) * 100 : 0;

  return {
    id: portfolio.id,
    cash: portfolio.cash.amount,
    reservedCash: portfolio.reservedCash.amount,
    availableCash: portfolio.availableCash.amount,
    totalValue,
    totalUnrealizedPnL,
    totalUnrealizedPnLPercent,
    positionCount: portfolio.positions.size,
    positions,
    timestamp: new Date().toISOString(),
  };
}
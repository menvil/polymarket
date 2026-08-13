/**
 * Порт управления портфелем.
 *
 * @remarks
 * Инфраструктурный интерфейс — реализуется PolymarketPortfolioAdapter.
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

/** Параметры для проверки возможности размещения ордера */
export interface CanPlaceOrderParams {
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
}

/** Результат проверки возможности размещения ордера */
export type CanPlaceOrderResult =
  | {
      ok: true;
      normalizedSize: number;
      normalizedPrice: number;
      priceTick: number;
    }
  | { ok: false; reason: string };

/**
 * Интерфейс для работы с портфелем (баланс, позиции, проверки).
 */
export interface IPortfolioAdapter {
  getBalance(): Promise<number>;
  getOutcomeBalance(tokenId: string): Promise<number>;
  getPositions(tokenId?: string): Promise<PositionResponse[]>;
  canPlaceOrder(params: CanPlaceOrderParams): Promise<CanPlaceOrderResult>;
}

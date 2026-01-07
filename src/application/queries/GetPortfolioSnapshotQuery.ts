/**
 * GetPortfolioSnapshotQuery - запрос снапшота портфеля
 *
 * @remarks
 * Query pattern для получения текущего состояния портфеля.
 * Queries только читают данные, не изменяют состояние.
 *
 * @example
 * ```typescript
 * const query = new GetPortfolioSnapshotQuery('session-1');
 * const handler = new GetPortfolioSnapshotHandler(...);
 * const snapshot = await handler.execute(query);
 * ```
 */
import { PortfolioDTO, toPortfolioDTO } from '../dto/PortfolioDTO.js';
import { IMarketDataFeed } from '../../domain/ports/IMarketDataFeed.js';
import { ILogger } from '../../domain/ports/ILogger.js';

/**
 * GetPortfolioSnapshot query
 */
export class GetPortfolioSnapshotQuery {
  /**
   * @param sessionId - ID торговой сессии
   * @param includePositionDetails - Включить детали лотов (по умолчанию false)
   */
  constructor(
    public readonly sessionId: string,
    public readonly includePositionDetails: boolean = false
  ) {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new Error('sessionId is required');
    }
  }
}

/**
 * GetPortfolioSnapshot handler
 *
 * @remarks
 * Обрабатывает запрос снапшота:
 * 1. Находит торговую сессию
 * 2. Получает текущие рыночные цены
 * 3. Вычисляет unrealized P&L для всех позиций
 * 4. Формирует PortfolioDTO
 */
export class GetPortfolioSnapshotHandler {
  private logger: ILogger;

  constructor(
    private readonly marketDataFeed: IMarketDataFeed,
    baseLogger: ILogger
  ) {
    this.logger = baseLogger.child?.('GetPortfolioSnapshotHandler') || baseLogger;
  }

  /**
   * Выполняет запрос снапшота портфеля
   *
   * @param query - Query для получения снапшота
   * @param session - TradingSession (передаётся извне для простоты)
   * @returns PortfolioDTO с текущим состоянием
   */
  async execute(query: GetPortfolioSnapshotQuery, session: any): Promise<PortfolioDTO> {
    this.logger.info('Executing GetPortfolioSnapshotQuery', {
      sessionId: query.sessionId,
      includeDetails: query.includePositionDetails,
    });

    try {
      // 1. Получаем текущие цены для всех позиций
      const marketPrices = new Map<string, number>();
      
      for (const [tokenId] of session.portfolio.positions.entries()) {
        try {
          // Получаем orderbook для токена
          const orderbook = await this.marketDataFeed.getOrderbook(session.market.id);
          const midPrice = orderbook.getMidPrice();
          
          if (midPrice) {
            marketPrices.set(tokenId, midPrice.value);
          }
        } catch (error) {
          this.logger.warn('Failed to get price for token', {
            tokenId,
            error,
          });
        }
      }

      this.logger.debug('Market prices fetched', {
        priceCount: marketPrices.size,
      });

      // 2. Конвертируем в DTO
      const portfolioDTO = toPortfolioDTO(session.portfolio, marketPrices);

      this.logger.info('Portfolio snapshot generated', {
        sessionId: query.sessionId,
        totalValue: portfolioDTO.totalValue,
        positionCount: portfolioDTO.positionCount,
      });

      return portfolioDTO;
    } catch (error) {
      this.logger.error('Failed to get portfolio snapshot', {
        error,
        query,
      });
      throw error;
    }
  }
}

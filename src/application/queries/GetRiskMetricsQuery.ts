/**
 * GetRiskMetricsQuery - запрос метрик риска
 *
 * @remarks
 * Query для получения текущих метрик риска торговой сессии.
 *
 * @example
 * ```typescript
 * const query = new GetRiskMetricsQuery('session-1');
 * const metrics = await handler.execute(query);
 * console.log(`Risk status: ${metrics.status}`);
 * ```
 */
import { ILogger } from '../../domain/ports/ILogger.js';
import { ConfigLoader } from '../../infrastructure/config/ConfigLoader.js';

/**
 * Risk metrics DTO
 */
export interface RiskMetricsDTO {
  /** Статус риска */
  status: 'NORMAL' | 'WARNING' | 'PANIC';

  /** Режим торговли */
  mode: 'QUOTE' | 'INVENTORY' | 'PANIC';

  /** Срочность (0-1) */
  urgency: number;

  /** Чистая позиция (YES - NO) */
  netPosition: number;

  /** Валовая позиция (YES + NO) */
  grossPosition: number;

  /** Нереализованный P&L */
  unrealizedPnL: number;

  /** Максимальный лимит чистой позиции */
  maxNetPosition: number;

  /** Максимальный лимит валовой позиции */
  maxGrossPosition: number;

  /** Порог максимального убытка */
  maxLossThreshold: number;

  /** Использование лимита чистой позиции (%) */
  netPositionUtilization: number;

  /** Использование лимита валовой позиции (%) */
  grossPositionUtilization: number;

  /** Время до истечения рынка (ms) */
  timeToExpiry: number;

  /** Время до истечения (минуты) */
  timeToExpiryMinutes: number;

  /** Причина текущего статуса */
  statusReason?: string;

  /** Рекомендации */
  recommendations: string[];
}

/**
 * GetRiskMetrics query
 */
export class GetRiskMetricsQuery {
  constructor(public readonly sessionId: string) {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new Error('sessionId is required');
    }
  }
}

/**
 * GetRiskMetrics handler
 *
 * @remarks
 * Обрабатывает запрос метрик риска:
 * 1. Получает состояние RiskExposure из сессии
 * 2. Вычисляет дополнительные метрики
 * 3. Формирует рекомендации
 * 4. Возвращает RiskMetricsDTO
 */
export class GetRiskMetricsHandler {
  private logger: ILogger;

  constructor(baseLogger: ILogger) {
    this.logger = baseLogger.child?.('GetRiskMetricsHandler') || baseLogger;
  }

  /**
   * Выполняет запрос метрик риска
   *
   * @param query - Query
   * @param session - TradingSession
   * @returns RiskMetricsDTO
   */
  async execute(query: GetRiskMetricsQuery, session: any): Promise<RiskMetricsDTO> {
    this.logger.info('Executing GetRiskMetricsQuery', {
      sessionId: query.sessionId,
    });

    try {
      const risk = session.riskExposure;
      const portfolio = session.portfolio;
      const market = session.market;

      // Вычисляем метрики
      const netPosition = portfolio.netPosition || 0;
      const grossPosition = portfolio.grossPosition || 0;

      // Лимиты из .env конфигурации
      const riskConfig = ConfigLoader.getInstance().getRiskConfig();
      const maxNetPosition = riskConfig.maxNetPosition;
      const maxGrossPosition = riskConfig.maxGrossPosition;
      const maxLossThreshold = 100; // TODO: вынести в .env

      const netUtilization = (Math.abs(netPosition) / maxNetPosition) * 100;
      const grossUtilization = (grossPosition / maxGrossPosition) * 100;

      const timeToExpiry = market.timeToExpiry();
      const timeToExpiryMinutes = Math.floor(timeToExpiry / 60000);

      // Формируем рекомендации
      const recommendations: string[] = [];

      if (risk.status === 'PANIC') {
        recommendations.push('🚨 IMMEDIATE ACTION: Close all positions');
        recommendations.push('Stop placing new orders');
      } else if (risk.status === 'WARNING') {
        recommendations.push('⚠️ Reduce position size');
        recommendations.push('Monitor P&L closely');
      }

      if (timeToExpiryMinutes < 60) {
        recommendations.push(`⏰ Market expires in ${timeToExpiryMinutes} minutes`);
        recommendations.push('Consider closing positions before expiry');
      }

      if (netUtilization > 80) {
        recommendations.push(
          `📊 Net position at ${netUtilization.toFixed(0)}% of limit`
        );
      }

      if (grossUtilization > 80) {
        recommendations.push(
          `📊 Gross position at ${grossUtilization.toFixed(0)}% of limit`
        );
      }

      const metrics: RiskMetricsDTO = {
        status: risk.status || 'NORMAL',
        mode: risk.mode || 'QUOTE',
        urgency: risk.urgency || 0,
        netPosition,
        grossPosition,
        unrealizedPnL: 0, // TODO: вычислить из portfolio
        maxNetPosition,
        maxGrossPosition,
        maxLossThreshold,
        netPositionUtilization: netUtilization,
        grossPositionUtilization: grossUtilization,
        timeToExpiry,
        timeToExpiryMinutes,
        statusReason: risk.statusReason,
        recommendations,
      };

      this.logger.info('Risk metrics generated', {
        sessionId: query.sessionId,
        status: metrics.status,
        urgency: metrics.urgency,
      });

      return metrics;
    } catch (error) {
      this.logger.error('Failed to get risk metrics', {
        error,
        query,
      });
      throw error;
    }
  }
}

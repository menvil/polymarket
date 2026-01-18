/**
 * Политика баланса Polymarket
 *
 * @remarks
 * Проверяет, достаточно ли у пользователя USDC и токенов исхода для размещения ордера.
 *
 * Эта политика используется PortfolioAdapter.canPlaceOrder() для валидации
 * баланса ПЕРЕД отправкой ордера в API.
 *
 * Логика валидации:
 * - Ордер на покупку (BUY): требует USDC (price * size)
 * - Ордер на продажу (SELL): требует токены исхода (size)
 *
 * @example
 * ```typescript
 * const policy = new PolymarketBalancePolicy(balanceProvider, logger);
 *
 * const result = await policy.checkBalance({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (!result.ok) {
 *   console.error(result.reason);
 *   // "Insufficient USDC: have 50, need 52"
 * }
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { IBalanceProvider } from '../../../exchange/ports/IBalanceProvider.js';
import type { IPortfolioProjector } from '../../../../domain/services/portfolio/PortfolioProjector.js';
import type { OrderSide } from '../../../exchange/types/OrderResponse.js';

/**
 * Параметры проверки баланса
 */
export interface BalanceCheckParams {
  /** ID токена */
  tokenId: string;

  /** Сторона ордера ('BUY' | 'SELL') */
  side: OrderSide;

  /** Цена ордера */
  price: number;

  /** Размер ордера */
  size: number;

  /** Минимальный размер ордера из ограничений рынка (опционально) */
  minOrderSize?: number;
}

/**
 * Результат проверки баланса
 */
export interface BalanceCheckResult {
  /** Достаточен ли баланс */
  ok: boolean;

  /** Причина, если недостаточно */
  reason?: string;

  /** Требуемая сумма */
  required?: number;

  /** Доступная сумма */
  available?: number;

  /** Предлагаемый размер (максимально доступный с текущим балансом) */
  suggestedSize?: number;
}

/**
 * Политика баланса Polymarket
 */
export class PolymarketBalancePolicy {
  constructor(
    private readonly balanceProvider: IBalanceProvider,
    private readonly logger: ILogger,
    private readonly portfolioProjector?: IPortfolioProjector
  ) {}

  /**
   * Проверяет, можно ли разместить ордер (проверка баланса)
   *
   * @param params - Параметры проверки баланса
   * @returns Результат проверки
   *
   * @example
   * ```typescript
   * const result = await policy.checkBalance({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   *
   * if (result.ok) {
   *   console.log('Sufficient balance');
   * } else {
   *   console.error(result.reason);
   * }
   * ```
   */
  async checkBalance(params: BalanceCheckParams): Promise<BalanceCheckResult> {
    const { tokenId, side, price, size } = params;

    this.logger.debug('Checking balance', {
      tokenId,
      side,
      price,
      size,
      minOrderSize: params.minOrderSize,
    });

    // side уже в UPPERCASE (OrderSide = 'BUY' | 'SELL')
    if (side === 'BUY') {
      return this.checkBuyBalance(params);
    } else {
      return this.checkSellBalance(tokenId, size);
    }
  }

  /**
   * Получает баланс токенов из PortfolioProjector (мгновенно) или Balance API (fallback)
   *
   * @param tokenId - ID токена
   * @returns Баланс и источник данных
   *
   * @remarks
   * v7.6: PortfolioProjector используется первым (мгновенно, на основе событий),
   * Balance API - как fallback (может задерживаться 0-5 секунд после исполнения).
   */
  private async getTokenBalance(
    tokenId: string
  ): Promise<{ balance: number; source: 'PortfolioProjector' | 'BalanceAPI' }> {
    if (this.portfolioProjector) {
      const position = this.portfolioProjector.getPosition(tokenId);
      return {
        balance: position?.quantity ?? 0,
        source: 'PortfolioProjector',
      };
    }

    // Fallback - Balance API (может задерживаться после мгновенного исполнения)
    const balance = await this.balanceProvider.getOutcomeBalance(tokenId);
    return {
      balance,
      source: 'BalanceAPI',
    };
  }

  /**
   * Проверяет баланс для ордера на покупку (BUY)
   *
   * @param params - Параметры проверки баланса
   * @returns Результат проверки
   *
   * @remarks
   * Ордер на покупку (BUY) требует USDC: required = price * size
   */
  private async checkBuyBalance(
    params: BalanceCheckParams
  ): Promise<BalanceCheckResult> {
    const { price, size } = params;

    // Защита от деления на ноль (согласовано с getMaxBuySize)
    if (price <= 0) {
      return {
        ok: false,
        reason: `Invalid price: ${price}. Price must be positive`,
        required: 0,
        available: 0,
        suggestedSize: 0,
      };
    }

    // Валидация размера ордера
    if (size <= 0) {
      return {
        ok: false,
        reason: `Invalid size: ${size}. Size must be positive`,
        required: 0,
        available: 0,
        suggestedSize: 0,
      };
    }

    const requiredUSDC = price * size;
    const availableUSDC = await this.balanceProvider.getAvailableBalance();

    this.logger.debug('Checking buy balance', {
      requiredUSDC,
      availableUSDC,
    });

    if (availableUSDC < requiredUSDC) {
      // Вычисляем максимально доступный размер с текущим балансом
      let suggestedSize = Math.floor(availableUSDC / price);

      // Проверяем, соответствует ли предложенный размер минимальным требованиям
      const minOrderSize = params.minOrderSize ?? 1;
      if (suggestedSize < minOrderSize) {
        suggestedSize = 0; // Не хватает средств на минимальный размер ордера
      }

      const reason = `Insufficient USDC: have ${availableUSDC.toFixed(
        2
      )}, need ${requiredUSDC.toFixed(2)}`;

      this.logger.warn('Insufficient balance for buy order', {
        requiredUSDC,
        availableUSDC,
        deficit: requiredUSDC - availableUSDC,
        suggestedSize,
        minOrderSize,
      });

      return {
        ok: false,
        reason,
        required: requiredUSDC,
        available: availableUSDC,
        suggestedSize,
      };
    }

    this.logger.debug('Sufficient balance for buy order', {
      requiredUSDC,
      availableUSDC,
      surplus: availableUSDC - requiredUSDC,
    });

    return { ok: true };
  }

  /**
   * Проверяет баланс для ордера на продажу (SELL)
   *
   * @param tokenId - ID токена
   * @param size - Размер ордера
   * @returns Результат проверки
   *
   * @remarks
   * v7.6: Использует PortfolioProjector ПЕРВЫМ (мгновенно, без задержки), затем Balance API как резервный вариант.
   *
   * Ордер на продажу (SELL) требует токены исхода: required = size
   * Если баланс немного меньше (< 1% дефицита), предлагает продать доступный баланс
   *
   * **Почему PortfolioProjector первым?**
   * - PortfolioProjector = основан на событиях (мгновенно, всегда актуален)
   * - Balance API = внешнее API (может задерживаться на 0-5 секунд после исполнения)
   * - После мгновенного исполнения BUY ордера, Balance API может еще возвращать 0, в то время как PortfolioProjector верен
   */
  private async checkSellBalance(
    tokenId: string,
    size: number
  ): Promise<BalanceCheckResult> {
    // Валидация размера ордера
    if (size <= 0) {
      return {
        ok: false,
        reason: `Invalid size: ${size}. Size must be positive`,
        required: 0,
        available: 0,
        suggestedSize: 0,
      };
    }

    const requiredTokens = size;

    // ✅ v7.6: Сначала пробуем PortfolioProjector (мгновенно, без задержки)
    const { balance: availableTokens, source: balanceSource } = await this.getTokenBalance(tokenId);

    this.logger.debug('Checking sell balance', {
      tokenId: tokenId.length > 16 ? tokenId.substring(0, 16) + '...' : tokenId,
      requiredTokens,
      availableTokens,
      source: balanceSource,
    });

    if (availableTokens < requiredTokens) {
      const deficit = requiredTokens - availableTokens;
      const deficitPercent = (deficit / requiredTokens) * 100;

      // Если дефицит минимален (< 1%), просто продаем доступный баланс (ошибка округления/комиссии)
      if (deficitPercent < 1 && availableTokens > 0) {
        // КРИТИЧНО: Ордера SELL требуют makerAmount (size) с максимум 2 знаками после запятой
        // Округляем вниз до 2 знаков после запятой, чтобы избежать ошибки API 400
        const roundedSize = Math.floor(availableTokens * 100) / 100;

        this.logger.warn('Tiny deficit in sell balance - using available balance', {
          tokenId,
          requiredTokens,
          availableTokens,
          deficit,
          deficitPercent: `${deficitPercent.toFixed(3)}%`,
          roundedSize,
        });

        return {
          ok: true,
          available: availableTokens,
          suggestedSize: roundedSize, // Округлено до 2 знаков после запятой (требование API)
        };
      }

      const reason = `Insufficient outcome tokens: have ${availableTokens.toFixed(
        2
      )}, need ${requiredTokens.toFixed(2)}`;

      // Округляем доступные токены до 2 знаков после запятой (требование API для ордеров SELL)
      const roundedAvailable = Math.floor(availableTokens * 100) / 100;

      this.logger.warn('Insufficient balance for sell order', {
        tokenId,
        requiredTokens,
        availableTokens,
        deficit,
        roundedAvailable,
      });

      return {
        ok: false,
        reason,
        required: requiredTokens,
        available: availableTokens,
        suggestedSize: roundedAvailable, // Округлено до 2 знаков после запятой
      };
    }

    this.logger.debug('Sufficient balance for sell order', {
      tokenId,
      requiredTokens,
      availableTokens,
      surplus: availableTokens - requiredTokens,
    });

    return { ok: true };
  }

  /**
   * Проверяет, есть ли у пользователя ЛЮБОЙ баланс USDC
   *
   * @returns True, если баланс > 0
   *
   * @remarks
   * Быстрая проверка для условий остановки бота.
   *
   * @example
   * ```typescript
   * const hasBalance = await policy.hasAnyBalance();
   * if (!hasBalance) {
   *   console.log('No USDC balance - pausing bot');
   * }
   * ```
   */
  async hasAnyBalance(): Promise<boolean> {
    const availableUSDC = await this.balanceProvider.getAvailableBalance();
    return availableUSDC > 0;
  }

  /**
   * Получает максимальный размер ордера для заданной цены
   *
   * @param price - Цена ордера
   * @returns Максимальный размер, который можно купить с доступным USDC
   *
   * @remarks
   * Полезно для расчета максимального размера позиции.
   *
   * @example
   * ```typescript
   * const maxSize = await policy.getMaxBuySize(0.52);
   * console.log(`Max buy size at 0.52: ${maxSize}`);
   * ```
   */
  async getMaxBuySize(price: number): Promise<number> {
    if (price <= 0) {
      return 0;
    }

    const availableUSDC = await this.balanceProvider.getAvailableBalance();
    // Округляем вниз для согласованности с checkBuyBalance
    const maxSize = Math.floor(availableUSDC / price);

    this.logger.debug('Calculated max buy size', {
      price,
      availableUSDC,
      maxSize,
    });

    return maxSize;
  }

  /**
   * Получает максимальный размер продажи для токена
   *
   * @param tokenId - ID токена
   * @returns Максимальный размер, который можно продать (баланс токенов исхода, округленный до 2 знаков после запятой)
   *
   * @remarks
   * v7.6: Использует PortfolioProjector ПЕРВЫМ (мгновенно), затем Balance API как резервный вариант.
   *
   * Возвращает баланс, округленный ВНИЗ до 2 знаков после запятой в соответствии с требованиями API.
   * Ордера SELL требуют makerAmount с максимум 2 знаками после запятой.
   *
   * @example
   * ```typescript
   * const maxSize = await policy.getMaxSellSize('0x123');
   * console.log(`Max sell size: ${maxSize}`); // e.g., 9.99 (not 9.997271)
   * ```
   */
  async getMaxSellSize(tokenId: string): Promise<number> {
    // ✅ v7.6: Сначала пробуем PortfolioProjector (мгновенно, без задержки)
    const { balance: availableTokens, source: balanceSource } = await this.getTokenBalance(tokenId);

    // Округляем вниз до 2 знаков после запятой (требование API для ордеров SELL)
    const roundedSize = Math.floor(availableTokens * 100) / 100;

    this.logger.debug('Calculated max sell size', {
      tokenId: tokenId.length > 16 ? tokenId.substring(0, 16) + '...' : tokenId,
      availableTokens,
      maxSize: roundedSize,
      source: balanceSource,
    });

    return roundedSize;
  }
}

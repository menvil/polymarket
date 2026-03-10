/**
 * Политика проверки баланса Polymarket
 *
 * @remarks
 * Проверяет наличие достаточного количества USDC и outcome-токенов для размещения ордера.
 *
 * Эта политика используется в PortfolioAdapter.canPlaceOrder() для валидации
 * баланса ДО отправки ордера в API.
 *
 * Логика валидации:
 * - Ордер BUY: требует USDC (цена * размер)
 * - Ордер SELL: требует outcome-токены (размер)
 *
 * @example
 * ```typescript
 * const policy = new PolymarketBalancePolicy(balanceProvider, logger);
 *
 * const result = await policy.checkBalance({
 *   tokenId: '0x123',
 *   side: 'buy',
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

import type { ILogger } from '@polymarket/logger';
import type { IBalanceProvider } from '../../ports/IBalanceProvider.js';
import type { IPortfolioProjector } from '../../ports/IPortfolioProjector.js';

/**
 * Параметры проверки баланса
 */
export interface BalanceCheckParams {
  /** Идентификатор токена */
  tokenId: string;

  /** Сторона ордера */
  side: 'buy' | 'sell';

  /** Цена ордера */
  price: number;

  /** Размер ордера */
  size: number;

  /** Минимальный размер ордера из рыночных ограничений (опционально) */
  minOrderSize?: number;
}

/**
 * Результат проверки баланса
 */
export interface BalanceCheckResult {
  /** Достаточен ли баланс */
  ok: boolean;

  /** Причина отказа при недостаточном балансе */
  reason?: string;

  /** Требуемая сумма */
  required?: number;

  /** Доступная сумма */
  available?: number;

  /** Предлагаемый размер (максимально доступный при текущем балансе) */
  suggestedSize?: number;
}

/**
 * Политика проверки баланса Polymarket
 */
export class PolymarketBalancePolicy {
  /**
   * @param balanceProvider - REST API баланса (источник истины для USDC BUY-ордеров)
   * @param logger - Logger
   * @param portfolioProjector - Опциональный event-sourced проектор инвентаря.
   *   Если передан — используется для SELL-ордеров вместо Balance API (zero-lag).
   *   Если не передан — SELL-ордера проверяются через Balance API (может запаздывать 0–5 сек после BUY fill).
   *
   * @remarks
   * Стратегия проверки баланса:
   * - **BUY**: всегда Balance API (USDC) — PortfolioProjector не отслеживает USDC
   * - **SELL с portfolioProjector**: event-sourced инвентарь — мгновенно, без сетевых запросов
   * - **SELL без portfolioProjector**: Balance API — работает, но может не видеть только что купленные токены
   */
  constructor(
    private readonly balanceProvider: IBalanceProvider,
    private readonly logger: ILogger,
    private readonly portfolioProjector?: IPortfolioProjector
  ) {}

  /**
   * Проверить возможность размещения ордера (проверка баланса)
   *
   * @param params - Параметры проверки баланса
   * @returns Результат проверки
   *
   * @example
   * ```typescript
   * const result = await policy.checkBalance({
   *   tokenId: '0x123',
   *   side: 'buy',
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

    // Нормализуем сторону в нижний регистр для сравнения
    const normalizedSide = side.toLowerCase();

    if (normalizedSide === 'buy') {
      return this.checkBuyBalance(params);
    } else {
      return this.checkSellBalance(tokenId, size);
    }
  }

  /**
   * Проверить баланс для BUY-ордера
   *
   * @param params - Параметры проверки баланса
   * @returns Результат проверки
   *
   * @remarks
   * BUY-ордер требует USDC: необходимо = цена * размер
   */
  private async checkBuyBalance(
    params: BalanceCheckParams
  ): Promise<BalanceCheckResult> {
    const { price, size } = params;
    const requiredUSDC = price * size;
    const availableUSDC = await this.balanceProvider.getAvailableBalance();

    this.logger.debug('Checking buy balance', {
      requiredUSDC,
      availableUSDC,
    });

    if (availableUSDC < requiredUSDC) {
      // Вычисляем максимальный доступный размер при текущем балансе
      let suggestedSize = Math.floor(availableUSDC / price);

      // Проверяем что предложенный размер соответствует минимальному требованию
      const minOrderSize = params.minOrderSize ?? 1;
      if (suggestedSize < minOrderSize) {
        suggestedSize = 0; // Не хватает баланса на минимальный размер ордера
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
   * Проверить баланс для SELL-ордера
   *
   * @param tokenId - Идентификатор токена
   * @param size - Размер ордера
   * @returns Результат проверки
   *
   * @remarks
   * v7.6: Сначала использует PortfolioProjector (мгновенно, без задержки), затем Balance API как fallback.
   *
   * SELL-ордер требует outcome-токены: необходимо = размер
   * Если баланс незначительно меньше (дефицит < 1%), предлагает продать доступный баланс
   *
   * **Почему сначала PortfolioProjector?**
   * - PortfolioProjector = event sourced (мгновенно, всегда актуально)
   * - Balance API = внешний API (может отставать на 0-5 секунд после fills)
   * - После мгновенного BUY fill, Balance API может ещё возвращать 0, тогда как PortfolioProjector корректен
   */
  private async checkSellBalance(
    tokenId: string,
    size: number
  ): Promise<BalanceCheckResult> {
    const requiredTokens = size;

    // Пробуем PortfolioProjector первым (мгновенно, без задержки)
    let availableTokens: number;
    let balanceSource: 'PortfolioProjector' | 'BalanceAPI';

    if (this.portfolioProjector) {
      const position = this.portfolioProjector.getPosition(tokenId);
      availableTokens = position?.quantity ?? 0;
      balanceSource = 'PortfolioProjector';

      this.logger.debug('Checking sell balance (PortfolioProjector - instant)', {
        tokenId: tokenId.substring(0, 16) + '...',
        requiredTokens,
        availableTokens,
        source: balanceSource,
      });
    } else {
      // Fallback к Balance API (может отставать после мгновенных fills)
      availableTokens = await this.balanceProvider.getOutcomeBalance(tokenId);
      balanceSource = 'BalanceAPI';

      this.logger.debug('Checking sell balance (Balance API - may lag)', {
        tokenId: tokenId.substring(0, 16) + '...',
        requiredTokens,
        availableTokens,
        source: balanceSource,
      });
    }

    if (availableTokens < requiredTokens) {
      const deficit = requiredTokens - availableTokens;
      const deficitPercent = (deficit / requiredTokens) * 100;

      // Если дефицит незначительный (< 1%), продаём доступный баланс (ошибка округления/комиссия)
      if (deficitPercent < 1 && availableTokens > 0) {
        // КРИТИЧНО: SELL ордера требуют makerAmount (size) с не более 2 знаками после запятой
        // Округляем вниз до 2 знаков чтобы избежать ошибки API 400
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
          suggestedSize: roundedSize, // Округлено до 2 знаков (требование API)
        };
      }

      const reason = `Insufficient outcome tokens: have ${availableTokens.toFixed(
        2
      )}, need ${requiredTokens.toFixed(2)}`;

      // Округляем доступные токены до 2 знаков (требование API для SELL ордеров)
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
        suggestedSize: roundedAvailable, // Округлено до 2 знаков
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
   * Проверить наличие хоть какого-либо баланса USDC
   *
   * @returns true если баланс > 0
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
   * Получить максимальный размер ордера для заданной цены
   *
   * @param price - Цена ордера
   * @returns Максимальный размер, который можно купить при доступном USDC
   *
   * @remarks
   * Полезно для расчёта максимального размера позиции.
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
    const maxSize = availableUSDC / price;

    this.logger.debug('Calculated max buy size', {
      price,
      availableUSDC,
      maxSize,
    });

    return maxSize;
  }

  /**
   * Получить максимальный размер продажи для токена
   *
   * @param tokenId - Идентификатор токена
   * @returns Максимальный размер для продажи (баланс outcome-токена, округлённый до 2 знаков)
   *
   * @remarks
   * v7.6: Сначала использует PortfolioProjector (мгновенно), затем Balance API как fallback.
   *
   * Возвращает баланс, округлённый ВНИЗ до 2 знаков в соответствии с требованиями API.
   * SELL ордера требуют makerAmount с не более чем 2 знаками после запятой.
   *
   * @example
   * ```typescript
   * const maxSize = await policy.getMaxSellSize('0x123');
   * console.log(`Max sell size: ${maxSize}`); // e.g., 9.99 (not 9.997271)
   * ```
   */
  async getMaxSellSize(tokenId: string): Promise<number> {
    // Пробуем PortfolioProjector первым (мгновенно, без задержки)
    let availableTokens: number;

    if (this.portfolioProjector) {
      const position = this.portfolioProjector.getPosition(tokenId);
      availableTokens = position?.quantity ?? 0;

      this.logger.debug('Calculated max sell size (PortfolioProjector)', {
        tokenId: tokenId.substring(0, 16) + '...',
        availableTokens,
        source: 'PortfolioProjector',
      });
    } else {
      // Fallback к Balance API (может отставать после мгновенных fills)
      availableTokens = await this.balanceProvider.getOutcomeBalance(tokenId);

      this.logger.debug('Calculated max sell size (Balance API)', {
        tokenId: tokenId.substring(0, 16) + '...',
        availableTokens,
        source: 'BalanceAPI',
      });
    }

    // Округляем вниз до 2 знаков (требование API для SELL ордеров)
    const roundedSize = Math.floor(availableTokens * 100) / 100;

    this.logger.debug('Max sell size (rounded)', {
      tokenId: tokenId.substring(0, 16) + '...',
      availableTokens,
      maxSize: roundedSize,
    });

    return roundedSize;
  }
}

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
 *   // "Insufficient USDC: have 50.00, need 52.00"
 * }
 * ```
 */

import Decimal from 'decimal.js';
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
   * BUY-ордер требует USDC: необходимо = цена * размер.
   * Использует Decimal-арифметику для точного сравнения.
   */
  private async checkBuyBalance(
    params: BalanceCheckParams
  ): Promise<BalanceCheckResult> {
    const { price, size } = params;

    const required  = new Decimal(price).mul(size);
    const available = await this.balanceProvider.getAvailableBalance();
    const availableDecimal = available.value();

    this.logger.debug('Checking buy balance', {
      requiredUSDC:   required.toNumber(),
      availableUSDC:  availableDecimal.toNumber(),
    });

    if (availableDecimal.lt(required)) {
      const minOrderSize = params.minOrderSize ?? 1;
      let suggestedSize  = availableDecimal.div(price).floor().toNumber();

      if (suggestedSize < minOrderSize) {
        suggestedSize = 0;
      }

      const reason = `Insufficient USDC: have ${availableDecimal.toFixed(2)}, need ${required.toFixed(2)}`;

      this.logger.warn('Insufficient balance for buy order', {
        requiredUSDC:  required.toNumber(),
        availableUSDC: availableDecimal.toNumber(),
        deficit:       required.sub(availableDecimal).toNumber(),
        suggestedSize,
        minOrderSize,
      });

      return {
        ok:            false,
        reason,
        required:      required.toNumber(),
        available:     availableDecimal.toNumber(),
        suggestedSize,
      };
    }

    this.logger.debug('Sufficient balance for buy order', {
      requiredUSDC:  required.toNumber(),
      availableUSDC: availableDecimal.toNumber(),
      surplus:       availableDecimal.sub(required).toNumber(),
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
   * Сначала использует PortfolioProjector (мгновенно, без задержки), затем Balance API как fallback.
   *
   * SELL-ордер требует outcome-токены: необходимо = размер.
   * Если баланс незначительно меньше (дефицит < 1%), предлагает продать доступный баланс.
   *
   * **Почему сначала PortfolioProjector?**
   * - PortfolioProjector = event sourced (мгновенно, всегда актуально)
   * - Balance API = внешний API (может отставать на 0–5 секунд после fills)
   */
  private async checkSellBalance(
    tokenId: string,
    size: number
  ): Promise<BalanceCheckResult> {
    const requiredTokens = size;

    let availableTokens: number;
    let balanceSource: 'PortfolioProjector' | 'BalanceAPI';

    if (this.portfolioProjector) {
      const position = this.portfolioProjector.getPosition(tokenId);
      availableTokens = position?.quantity ?? 0;
      balanceSource   = 'PortfolioProjector';

      this.logger.debug('Checking sell balance (PortfolioProjector - instant)', {
        tokenId:         tokenId.substring(0, 16) + '...',
        requiredTokens,
        availableTokens,
        source:          balanceSource,
      });
    } else {
      const outcomeBalance = await this.balanceProvider.getOutcomeBalance(tokenId);
      availableTokens      = outcomeBalance.amount().value().toNumber();
      balanceSource        = 'BalanceAPI';

      this.logger.debug('Checking sell balance (Balance API - may lag)', {
        tokenId:         tokenId.substring(0, 16) + '...',
        requiredTokens,
        availableTokens,
        source:          balanceSource,
      });
    }

    if (availableTokens < requiredTokens) {
      const deficit        = requiredTokens - availableTokens;
      const deficitPercent = (deficit / requiredTokens) * 100;

      // Если дефицит незначительный (< 1%), продаём доступный баланс (ошибка округления/комиссия)
      if (deficitPercent < 1 && availableTokens > 0) {
        // КРИТИЧНО: SELL ордера требуют makerAmount (size) с не более 2 знаками после запятой
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
          ok:            true,
          available:     availableTokens,
          suggestedSize: roundedSize,
        };
      }

      const reason = `Insufficient outcome tokens: have ${availableTokens.toFixed(2)}, need ${requiredTokens.toFixed(2)}`;

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
        ok:            false,
        reason,
        required:      requiredTokens,
        available:     availableTokens,
        suggestedSize: roundedAvailable,
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
   * Проверить наличие хоть какого-либо баланса USDC.
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
    const available = await this.balanceProvider.getAvailableBalance();
    return available.isPositive();
  }

  /**
   * Получить максимальный размер ордера для заданной цены.
   *
   * @param price - Цена ордера
   * @returns Максимальный размер, который можно купить при доступном USDC
   *
   * @remarks
   * Использует Decimal-арифметику для точного деления.
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

    const available    = await this.balanceProvider.getAvailableBalance();
    const maxSize      = available.value().div(price).toNumber();

    this.logger.debug('Calculated max buy size', {
      price,
      availableUSDC: available.toNumber(),
      maxSize,
    });

    return maxSize;
  }

  /**
   * Получить максимальный размер продажи для токена.
   *
   * @param tokenId - Идентификатор токена
   * @returns Максимальный размер для продажи (округлённый до 2 знаков)
   *
   * @remarks
   * Сначала использует PortfolioProjector (мгновенно), затем Balance API как fallback.
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
    let availableTokens: number;

    if (this.portfolioProjector) {
      const position  = this.portfolioProjector.getPosition(tokenId);
      availableTokens = position?.quantity ?? 0;

      this.logger.debug('Calculated max sell size (PortfolioProjector)', {
        tokenId:        tokenId.substring(0, 16) + '...',
        availableTokens,
        source:         'PortfolioProjector',
      });
    } else {
      const outcomeBalance = await this.balanceProvider.getOutcomeBalance(tokenId);
      availableTokens      = outcomeBalance.amount().value().toNumber();

      this.logger.debug('Calculated max sell size (Balance API)', {
        tokenId:        tokenId.substring(0, 16) + '...',
        availableTokens,
        source:         'BalanceAPI',
      });
    }

    // Округляем вниз до 2 знаков (требование API для SELL ордеров)
    const roundedSize = Math.floor(availableTokens * 100) / 100;

    this.logger.debug('Max sell size (rounded)', {
      tokenId:        tokenId.substring(0, 16) + '...',
      availableTokens,
      maxSize:        roundedSize,
    });

    return roundedSize;
  }
}

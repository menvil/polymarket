/**
 * Адаптер портфеля Polymarket
 *
 * @remarks
 * Обрабатывает запросы баланса, позиций и разрешений.
 * Использует BalancePolicy + MarketConstraintsPolicy внутренне.
 * Реализует IPortfolioAdapter.
 *
 * **ВАЖНО**: Этот адаптер НЕ обрабатывает стакан заявок или рыночные данные.
 * Для этого используйте MarketDataAdapter.
 *
 * Ключевые обязанности:
 * - Получение баланса пользователя (USDC, токены исходов)
 * - Получение позиций пользователя (исполненные сделки)
 * - Проверка возможности размещения ордера (использует политики)
 * - Подтверждение USDC для торговли (вызов блокчейна)
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketPortfolioAdapter(
 *   balanceProvider,
 *   positionsProvider,
 *   balancePolicy,
 *   constraintsPolicy,
 *   logger
 * );
 *
 * // Проверяем возможность размещения ордера
 * const result = await adapter.canPlaceOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (result.ok) {
 *   console.log(`Can place order with size ${result.normalizedSize}`);
 * } else {
 *   console.error(`Cannot place order: ${result.reason}`);
 * }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type {
  IPortfolioAdapter,
  PositionResponse,
  CanPlaceOrderParams,
  CanPlaceOrderResult,
} from '../../ports/IPortfolioAdapter.js';
import type { IBalanceProvider } from '../../ports/IBalanceProvider.js';
import type { IPositionsProvider } from '../../ports/IPositionsProvider.js';
import type { PolymarketMarketConstraintsPolicy } from '../policies/PolymarketMarketConstraintsPolicy.js';
import type { PolymarketBalancePolicy } from '../policies/PolymarketBalancePolicy.js';

/**
 * Адаптер портфеля Polymarket
 *
 * @remarks
 * Реализует IPortfolioAdapter для Polymarket.
 */
export class PolymarketPortfolioAdapter implements IPortfolioAdapter {
  constructor(
    private readonly balanceProvider: IBalanceProvider,
    private readonly positionsProvider: IPositionsProvider,
    private readonly balancePolicy: PolymarketBalancePolicy,
    private readonly constraintsPolicy: PolymarketMarketConstraintsPolicy,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить доступный баланс USDC
   *
   * @returns Доступный баланс USDC
   * @throws {ApiError} При ошибке API-вызова
   */
  async getBalance(): Promise<number> {
    this.logger.debug('Getting balance');

    const balance = await this.balanceProvider.getAvailableBalance();

    this.logger.debug('Balance retrieved', { balance });

    return balance;
  }

  /**
   * Получить баланс токена исхода для конкретного токена
   *
   * @param tokenId - Идентификатор токена
   * @returns Баланс токена исхода
   * @throws {ApiError} При ошибке API-вызова
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    this.logger.debug('Getting outcome balance', { tokenId });

    const balance = await this.balanceProvider.getOutcomeBalance(tokenId);

    this.logger.debug('Outcome balance retrieved', {
      tokenId,
      balance,
    });

    return balance;
  }

  /**
   * Получить текущие позиции (исполненные сделки)
   *
   * @param tokenId - Необязательно: фильтр по идентификатору токена
   * @returns Массив позиций
   * @throws {ApiError} При ошибке API-вызова
   */
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    // Дублирующие логи удалены (логируются в PolymarketPositionsRestClient)
    const positions = await this.positionsProvider.getPositions(tokenId);
    return positions;
  }

  /**
   * Проверить возможность размещения ордера (использует политики внутренне)
   *
   * @param params - Параметры ордера
   * @returns Результат с нормализованным размером или причиной отказа
   *
   * @remarks
   * Этот метод использует:
   * - MarketConstraintsPolicy → нормализация размера, валидация ограничений
   * - BalancePolicy → проверка достаточности баланса
   *
   * Возвращает {ok: true, normalizedSize: ...} если ордер может быть размещён.
   * Возвращает {ok: false, reason: '...'} в противном случае.
   *
   * Алгоритм:
   * 1. Нормализация размера через MarketConstraintsPolicy
   * 2. Валидация размера против ограничений (min/max)
   * 3. Проверка баланса через BalancePolicy
   *
   * @example
   * ```typescript
   * const result = await adapter.canPlaceOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 15.7777,
   * });
   *
   * if (result.ok) {
   *   console.log(`Can place order with size ${result.normalizedSize}`);
   * } else {
   *   console.error(`Cannot place order: ${result.reason}`);
   * }
   * ```
   */
  async canPlaceOrder(params: CanPlaceOrderParams): Promise<CanPlaceOrderResult> {
    const { tokenId, side, price, size } = params;

    this.logger.debug('Checking if order can be placed', {
      tokenId,
      side,
      price,
      size,
    });

    // Шаг 1: Нормализуем размер через MarketConstraintsPolicy
    const normalizedSize = await this.constraintsPolicy.normalizeSize(tokenId, size);

    this.logger.debug('Size normalized', {
      original: size,
      normalized: normalizedSize,
    });

    // Шаг 1.5: Нормализуем цену через MarketConstraintsPolicy
    const normalizedPrice = await this.constraintsPolicy.normalizePrice(tokenId, price);

    // Получаем priceTick из ограничений для построителя API
    const constraints = await this.constraintsPolicy.getConstraints(tokenId);

    this.logger.debug('Price normalized', {
      original: price,
      normalized: normalizedPrice,
      priceTick: constraints.priceTick,
    });

    // Шаг 2: Проверяем размер против ограничений
    const sizeValidation = await this.constraintsPolicy.validateSize(
      tokenId,
      normalizedSize,
      normalizedPrice,
      side
    );

    if (!sizeValidation.ok) {
      this.logger.warn('Size validation failed', {
        tokenId,
        size: normalizedSize,
        price: normalizedPrice,
        side,
        reason: sizeValidation.reason,
        minShares: sizeValidation.minShares,
      });

      return { ok: false, reason: sizeValidation.reason ?? 'Size validation failed' };
    }

    // Шаг 3: Проверяем баланс через BalancePolicy
    const balanceCheck = await this.balancePolicy.checkBalance({
      tokenId,
      side,
      price: normalizedPrice,
      size: normalizedSize,
      minOrderSize: constraints.minOrderSize, // Передаём минимальный размер ордера для маркета
    });

    if (!balanceCheck.ok) {
      this.logger.warn('Balance check failed', {
        tokenId,
        side,
        price: normalizedPrice,
        size: normalizedSize,
        reason: balanceCheck.reason,
        suggestedSize: balanceCheck.suggestedSize,
      });

      return { ok: false, reason: balanceCheck.reason ?? 'Balance check failed' };
    }

    // Используем suggestedSize если он предоставлен проверкой баланса (напр., продажа доступного остатка)
    const finalSize = balanceCheck.suggestedSize ?? normalizedSize;

    // Получаем ставку комиссии (изученную из ошибок или дефолтную)
    const feeRateBps = this.constraintsPolicy.getFeeRateBps(tokenId);

    this.logger.debug('Order can be placed', {
      tokenId,
      side,
      price: normalizedPrice,
      normalizedSize,
      finalSize,
      priceTick: constraints.priceTick,
      feeRateBps,
    });

    return {
      ok: true,
      normalizedSize: finalSize,
      normalizedPrice,
      feeRateBps,
      priceTick: constraints.priceTick,
    };
  }

  /**
   * Подтвердить USDC для торговли (вызов блокчейна)
   *
   * @param amount - Сумма для подтверждения
   * @throws {BlockchainError} При ошибке вызова блокчейна
   *
   * @remarks
   * Это транзакция блокчейна, а не API-вызов.
   * Может потребовать оплату газа.
   *
   * TODO: Реализовать интеграцию с блокчейном.
   */
  async approveUSDC(amount: number): Promise<void> {
    this.logger.warn('approveUSDC not yet implemented', { amount });

    // TODO: Реализовать интеграцию с блокчейном
    throw new Error('approveUSDC not yet implemented');
  }

  /**
   * Получить текущее разрешение USDC
   *
   * @returns Текущая сумма разрешения
   * @throws {BlockchainError} При ошибке вызова блокчейна
   *
   * @remarks
   * TODO: Реализовать интеграцию с блокчейном.
   */
  async getAllowance(): Promise<number> {
    this.logger.warn('getAllowance not yet implemented');

    // TODO: Реализовать интеграцию с блокчейном
    throw new Error('getAllowance not yet implemented');
  }
}

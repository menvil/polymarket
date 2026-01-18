/**
 * Адаптер портфеля Polymarket
 *
 * @remarks
 * Обрабатывает запросы баланса, позиций и разрешений.
 * Использует BalancePolicy + MarketConstraintsPolicy внутренне.
 * Реализует IPortfolioAdapter.
 *
 * **ВАЖНО**: Этот адаптер НЕ обрабатывает книгу ордеров или рыночные данные.
 * Используйте MarketDataAdapter для этого.
 *
 * Ключевые обязанности:
 * - Получение балансов пользователя (USDC, токены исходов)
 * - Получение позиций пользователя (исполненные сделки)
 * - Проверка возможности размещения ордера (использует политики)
 * - Одобрение USDC для торговли (вызов блокчейна)
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
 * // Проверить, может ли быть размещён ордер
 * const result = await adapter.canPlaceOrder({
 *   tokenId: '0x123',
 *   side: 'BUY',
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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  IPortfolioAdapter,
  PositionResponse,
  CanPlaceOrderParams,
  CanPlaceOrderResult,
} from '../../../exchange/ports/IPortfolioAdapter.js';
import type { IBalanceProvider } from '../../../exchange/ports/IBalanceProvider.js';
import type { IPositionsProvider } from '../../../exchange/ports/IPositionsProvider.js';
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
   * @throws {ApiError} Если API-вызов не удался
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
   * @param tokenId - ID токена
   * @returns Баланс токена исхода
   * @throws {ApiError} Если API-вызов не удался
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
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив позиций
   * @throws {ApiError} Если API-вызов не удался
   */
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    // v7.7.14: Удалены дублирующиеся логи (логируется в PolymarketPositionsRestClient)
    const positions = await this.positionsProvider.getPositions(tokenId);
    return positions;
  }

  /**
   * Проверить, может ли быть размещён ордер (использует политики внутренне)
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
   * Поток:
   * 1. Нормализация размера через MarketConstraintsPolicy
   * 2. Валидация размера относительно ограничений (мин/макс)
   * 3. Проверка баланса через BalancePolicy
   *
   * @example
   * ```typescript
   * const result = await adapter.canPlaceOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
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

    // Шаг 1: Нормализация размера через MarketConstraintsPolicy
    const normalizedSize = await this.constraintsPolicy.normalizeSize(tokenId, size);

    this.logger.debug('Size normalized', {
      original: size,
      normalized: normalizedSize,
    });

    // Шаг 1.5: Нормализация цены через MarketConstraintsPolicy (КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ)
    const normalizedPrice = await this.constraintsPolicy.normalizePrice(tokenId, price);

    // Получение priceTick из ограничений для построителя API
    const constraints = await this.constraintsPolicy.getConstraints(tokenId);

    this.logger.debug('Price normalized', {
      original: price,
      normalized: normalizedPrice,
      priceTick: constraints.priceTick,
    });

    // Шаг 2: Валидация размера относительно ограничений
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

      return { ok: false, reason: sizeValidation.reason };
    }

    // Шаг 3: Проверка баланса через BalancePolicy
    const balanceCheck = await this.balancePolicy.checkBalance({
      tokenId,
      side,
      price: normalizedPrice,
      size: normalizedSize,
      minOrderSize: constraints.minOrderSize, // Передача минимального размера ордера рынка
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

      return { ok: false, reason: balanceCheck.reason };
    }

    // Использовать suggestedSize, если проверка баланса предоставила его (например, продажа точного доступного баланса)
    const finalSize = balanceCheck.suggestedSize ?? normalizedSize;

    // Получить ставку комиссии (изученную из ошибок или по умолчанию)
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
   * Одобрить USDC для торговли (вызов блокчейна)
   *
   * @param amount - Сумма для одобрения
   * @throws {Error} Метод не реализован
   *
   * @remarks
   * Это транзакция блокчейна, а не API-вызов.
   * Может потребовать комиссии за газ.
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
   * @throws {Error} Метод не реализован
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

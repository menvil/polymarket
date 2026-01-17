/**
 * Общий интерфейс адаптера портфеля
 *
 * @remarks
 * Адаптер портфеля обрабатывает запросы балансов, позиций и разрешений.
 * Может использовать политики внутренне (BalancePolicy, MarketConstraintsPolicy).
 *
 * **ВАЖНО**: Этот адаптер НЕ обрабатывает orderbook или рыночные данные.
 * Для этого используйте IMarketDataAdapter.
 *
 * Ключевые обязанности:
 * - Получение балансов пользователя (USDC, outcome токены)
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
 * // Проверка возможности размещения ордера
 * const result = await adapter.canPlaceOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (result.ok) {
 *   console.log(`Можно разместить ордер с размером ${result.normalizedSize}`);
 * } else {
 *   console.error(`Нельзя разместить ордер: ${result.reason}`);
 * }
 * ```
 */

import type { PositionResponse } from '../types/PositionResponse.js';
import type { OrderSide } from '../types/OrderResponse.js';

export type { PositionResponse, OrderSide };

/**
 * Параметры для проверки возможности размещения ордера
 */
export interface CanPlaceOrderParams {
  /** ID токена */
  tokenId: string;

  /** Сторона ордера (UPPERCASE: 'BUY' | 'SELL') */
  side: OrderSide;

  /** Цена ордера */
  price: number;

  /** Размер ордера (будет нормализован) */
  size: number;
}

/**
 * Результат проверки canPlaceOrder
 */
export interface CanPlaceOrderResult {
  /** Можно ли разместить ордер */
  ok: boolean;

  /** Причина если ордер нельзя разместить */
  reason?: string;

  /** Нормализованный размер если ордер можно разместить */
  normalizedSize?: number;

  /** Нормализованная цена если ордер можно разместить (округлена до priceTick) */
  normalizedPrice?: number;

  /** Шаг цены из ограничений рынка */
  priceTick?: number;

  /** Ставка комиссии в базисных пунктах (выученная из ошибок или по умолчанию) */
  feeRateBps?: number;
}

/**
 * Общий интерфейс адаптера портфеля
 */
export interface IPortfolioAdapter {
  /**
   * Получить доступный баланс USDC
   *
   * @returns Доступный баланс USDC
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @example
   * ```typescript
   * const balance = await adapter.getBalance();
   * console.log(`Доступно: ${balance} USDC`);
   * ```
   */
  getBalance(): Promise<number>;

  /**
   * Получить баланс outcome токенов для конкретного токена
   *
   * @param tokenId - ID токена
   * @returns Баланс outcome токенов
   * @throws {ApiError} Если вызов API завершился неудачей
   */
  getOutcomeBalance(tokenId: string): Promise<number>;

  /**
   * Получить текущие позиции (исполненные сделки)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив позиций
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Позиции - это исполненные сделки, НЕ открытые ордера.
   * Для открытых ордеров используйте IExecutionAdapter.getOpenOrders().
   */
  getPositions(tokenId?: string): Promise<PositionResponse[]>;

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
   * Возвращает {ok: true, normalizedSize: ...} если ордер можно разместить.
   * Возвращает {ok: false, reason: '...'} в противном случае.
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
   *   console.log(`Можно разместить ордер с размером ${result.normalizedSize}`);
   * } else {
   *   console.error(`Нельзя разместить ордер: ${result.reason}`);
   * }
   * ```
   */
  canPlaceOrder(params: CanPlaceOrderParams): Promise<CanPlaceOrderResult>;

  /**
   * Одобрить USDC для торговли (вызов блокчейна)
   *
   * @param amount - Сумма для одобрения
   * @throws {BlockchainError} Если вызов блокчейна завершился неудачей
   *
   * @remarks
   * Это транзакция блокчейна, не вызов API.
   * Может потребовать оплату газа.
   */
  approveUSDC(amount: number): Promise<void>;

  /**
   * Получить текущее разрешение USDC
   *
   * @returns Текущая сумма разрешения
   * @throws {BlockchainError} Если вызов блокчейна завершился неудачей
   */
  getAllowance(): Promise<number>;
}
/**
 * Общий интерфейс адаптера исполнения
 *
 * @remarks
 * Адаптер исполнения отвечает ТОЛЬКО за вызовы API.
 * БЕЗ валидации, БЕЗ проверки баланса, БЕЗ нормализации.
 *
 * Этот адаптер предполагает, что все параметры уже валидированы и нормализованы
 * политиками (BalancePolicy, MarketConstraintsPolicy).
 *
 * Ключевой принцип: **Разделение ответственности**
 * - Валидация → BalancePolicy, MarketConstraintsPolicy
 * - Вызовы API → ExecutionAdapter
 * - Оркестрация → RestAdapter (Фасад)
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketExecutionAdapter(orderClient, mapper, logger);
 *
 * // Параметры уже нормализованы и валидированы!
 * const order = await adapter.postOrder({
 *   marketId: 'condition-123',
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100, // Уже округлено до sizeTick
 * });
 *
 * console.log(`Order placed: ${order.orderId}`);
 * ```
 */

import type { OrderResponse, OrderSide } from '../types/OrderResponse.js';

export type { OrderResponse, OrderSide };

/**
 * Параметры для размещения ордера (уже нормализованные)
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 * strategyId передаётся через: Intent → Context → Adapter → Event
 */
export interface PlaceOrderParams {
  /** ID рынка (condition ID в Polymarket) */
  marketId: string;

  /** ID токена (UP или DOWN) */
  tokenId: string;

  /** Сторона ордера ('BUY' | 'SELL') */
  side: OrderSide;

  /** Цена (уже валидирована и нормализована) */
  price: number;

  /** Размер (уже нормализован до sizeTick) */
  size: number;

  /** ID стратегии (v4.2: для multi-strategy изоляции, опционально для обратной совместимости) */
  strategyId?: string;

  /** Шаг цены из ограничений рынка (для построителя ордеров API) */
  priceTick?: number;

  /** Ставка комиссии в базисных пунктах (из ограничений рынка или выученная из ошибок) */
  feeRateBps?: number;
}

/**
 * Контекст для отмены ордера (для публикации события)
 *
 * @remarks
 * Содержит информацию, необходимую для публикации OrderCancelled события.
 */
export interface CancelOrderContext {
  /** ID рынка */
  marketId: string;
  /** ID токена */
  tokenId: string;
  /** ID стратегии */
  strategyId: string;
}

/**
 * Ответ об исполнении/сделке (нормализованный)
 */
export interface FillResponse {
  /** ID исполнения */
  fillId: string;

  /** ID ордера */
  orderId: string;

  /** ID токена */
  tokenId: string;

  /** Сторона сделки ('BUY' | 'SELL') */
  side: OrderSide;

  /** Цена исполнения */
  executedPrice: number;

  /** Исполненный размер */
  filledSize: number;

  /** Уплаченная комиссия */
  fee: number;

  /** Временная метка исполнения (мс) */
  timestamp: number;
}

/**
 * Общий интерфейс адаптера исполнения
 *
 * @remarks
 * ТОЛЬКО вызовы API - без бизнес-логики!
 */
export interface IExecutionAdapter {
  /**
   * Разместить ордер (ТОЛЬКО вызов API, БЕЗ валидации)
   *
   * @param params - Нормализованные параметры ордера (уже валидированы!)
   * @returns Ответ с ордером
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Предполагается:
   * - Размер уже нормализован (округлён до sizeTick)
   * - Баланс уже проверен
   * - Цена валидна
   *
   * @example
   * ```typescript
   * const order = await adapter.postOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   * ```
   */
  postOrder(params: PlaceOrderParams): Promise<OrderResponse>;

  /**
   * Отменить ордер (прямой вызов API)
   *
   * @param orderId - ID ордера для отмены
   * @param context - Контекст ордера для публикации события (marketId, tokenId, strategyId)
   * @throws {ApiError} Если вызов API завершился неудачей
   */
  cancelOrder(orderId: string, context?: CancelOrderContext): Promise<void>;

  /**
   * Получить открытые ордера (прямой вызов API)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив открытых ордеров (нормализованных)
   * @throws {ApiError} Если вызов API завершился неудачей
   */
  getOpenOrders(tokenId?: string): Promise<OrderResponse[]>;

  /**
   * Получить историю исполнений
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив исполнений (нормализованных)
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает исполненные сделки пользователя.
   * Это НЕ история рыночных сделок - для этого используйте IMarketDataAdapter.
   */
  getFillHistory(tokenId?: string): Promise<FillResponse[]>;
}
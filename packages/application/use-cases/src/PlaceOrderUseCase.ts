/**
 * PlaceOrderUseCase — оркестрация размещения нового торгового ордера.
 *
 * @remarks
 * ### Алгоритм (7 шагов):
 * 1. Пре-трейд риск-проверка (OrderRiskChecker)
 * 2. Создание Order aggregate (Order.create → PENDING)
 * 3. Резервирование баланса (portfolio.reserveForOrder)
 * 4. Отправка на биржу (exchangeClient.submitOrder)
 *    - При ошибке биржи: откат резервации + отклонение ордера
 * 5. Принятие ордера биржей (order.accept → OPEN)
 * 6. Сохранение ордера в репозиторий
 * 7. Публикация доменных событий
 *
 * ### Идемпотентность:
 * orderId должен быть уникальным для каждой попытки.
 * При ошибке биржи резервация автоматически откатывается.
 *
 * @example
 * ```typescript
 * const useCase = new PlaceOrderUseCase({
 *   riskChecker, orderRepo, portfolioService, exchangeClient, eventBus, clock, logger,
 * });
 *
 * const result = await useCase.execute({
 *   orderId, accountId, asset, side: 'BUY', price, size, strategyId, openOrdersCount,
 * });
 *
 * if (result.ok) {
 *   console.log('Order placed:', result.value);
 * }
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { TimestampService } from '@polymarket/value-objects';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import type { AccountId, AssetId, InstrumentId, OrderId } from '@polymarket/ids';
import type { IOrderRepository, IExchangeClient } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { IOrderRiskChecker, RiskViolationError } from '@polymarket/risk';
import type { PortfolioService } from './services/PortfolioService.js';
import type { OrderService } from './services/OrderService.js';

/** Входные данные для PlaceOrderUseCase */
export interface PlaceOrderInput {
  /** ID нового ордера (должен быть уникальным) */
  readonly orderId: OrderId;
  /** ID аккаунта владельца ордера */
  readonly accountId: AccountId;
  /** Торгуемый актив */
  readonly asset: AssetId;
  /** ID инструмента (для риск-проверки позиции) */
  readonly instrumentId: InstrumentId;
  /** Сторона (BUY/SELL) */
  readonly side: Side;
  /** Лимитная цена */
  readonly price: Price;
  /** Размер ордера */
  readonly size: Quantity;
  /** ID стратегии (опционально) */
  readonly strategyId?: string;
  /** Текущий portfolio (для риск-проверки) */
  readonly portfolio: Portfolio;
  /** Количество открытых ордеров стратегии (для риск-проверки) */
  readonly openOrdersCount: number;
}

/** Зависимости PlaceOrderUseCase */
export interface PlaceOrderDeps {
  readonly riskChecker: IOrderRiskChecker;
  readonly orderService: OrderService;
  readonly portfolioService: PortfolioService;
  readonly orderRepo: IOrderRepository;
  readonly exchangeClient: IExchangeClient;
  readonly eventBus: IEventBus;
  readonly clock: IClock;
  readonly logger: ILogger;
}

/** Ошибки PlaceOrderUseCase */
export type PlaceOrderError = TradingError | RiskViolationError;

/**
 * Use case размещения торгового ордера.
 *
 * @remarks
 * Оркестрирует пре-трейд проверку, создание ордера, резервирование средств
 * и отправку на биржу. При ошибке на любом шаге обеспечивает откат.
 */
export class PlaceOrderUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: PlaceOrderDeps) {
    this._logger = _deps.logger.child({ component: 'PlaceOrderUseCase' });
  }

  /**
   * Выполняет размещение ордера.
   *
   * @param input - Входные данные ордера и контекст риска
   * @returns Ok(OrderId) при успехе, Err(PlaceOrderError) при нарушении
   *
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   */
  public async execute(input: PlaceOrderInput): Promise<Result<OrderId, PlaceOrderError>> {
    // Шаг 1: Пре-трейд риск-проверка
    const riskResult = this._deps.riskChecker.checkBeforeOrder({
      portfolio: input.portfolio,
      openOrdersCount: input.openOrdersCount,
      side: input.side,
      price: input.price,
      size: input.size,
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
    });
    if (!riskResult.ok) {
      this._logger.warn('Pre-trade risk check failed', {
        riskCode: riskResult.error.riskCode,
        orderId: String(input.orderId),
      });
      return riskResult;
    }

    // Шаг 2: Создание Order aggregate
    const timestampResult = TimestampService.fromDate(this._deps.clock.now());
    if (!timestampResult.ok) {
      return Err(new TradingError(
        `Failed to create timestamp: ${timestampResult.error.message}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    const orderResult = Order.create({
      id: input.orderId,
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      timestamp: timestampResult.value,
      strategyId: input.strategyId,
    });
    if (!orderResult.ok) {
      return Err(orderResult.error);
    }
    const order = orderResult.value;

    // Шаг 3: Резервирование баланса
    const notional = input.price.value().times(input.size.value());
    const reserveResult = this._deps.portfolioService.reserveForOrder(input.accountId, notional);
    if (!reserveResult.ok) {
      return Err(new TradingError(
        `Failed to reserve balance: ${reserveResult.error.message}`,
        { context: { orderId: String(input.orderId), notional: notional.toString() } },
      ));
    }

    // Шаг 4: Отправка на биржу
    const submitResult = await this._deps.exchangeClient.submitOrder({
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      clientOrderId: input.orderId as unknown as string,
      strategyId: input.strategyId,
    });

    if (!submitResult.ok) {
      // Откат: снять резервацию
      this._logger.warn('Exchange rejected order, rolling back reservation', {
        orderId: String(input.orderId),
        error: submitResult.error.message,
      });
      const releaseResult = this._deps.portfolioService.releaseReservation(input.accountId, notional);
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation during rollback', {
          orderId: String(input.orderId),
          releaseError: releaseResult.error.message,
        });
      }
      return Err(new TradingError(
        `Exchange submission failed: ${submitResult.error.message}`,
        {
          context: {
            orderId: String(input.orderId),
            rollbackError: releaseResult.ok ? undefined : releaseResult.error.message,
          },
        },
      ));
    }

    // Шаг 5: Принятие ордера (PENDING → OPEN)
    const acceptResult = order.accept();
    if (!acceptResult.ok) {
      this._deps.portfolioService.releaseReservation(input.accountId, notional);
      return Err(acceptResult.error);
    }
    const acceptedOrder = acceptResult.value;

    // Шаг 6: Сохранение ордера
    await this._deps.orderService.save(acceptedOrder);

    // Шаг 7: Публикация событий
    const events = acceptedOrder.pullEvents();
    await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);

    this._logger.info('Order placed successfully', {
      orderId: String(input.orderId),
      side: input.side,
      notional: notional.toString(),
    });

    return Ok(input.orderId);
  }
}

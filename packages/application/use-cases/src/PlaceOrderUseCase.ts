/**
 * PlaceOrderUseCase — оркестрация размещения нового торгового ордера.
 *
 * @remarks
 * ### Алгоритм (7 шагов):
 * 1. Пре-трейд риск-проверка (OrderRiskChecker)
 * 2. Резервирование баланса (portfolio.reserveForOrder)
 * 3. Отправка на биржу (exchangeClient.submitOrder) → получаем venueOrderId
 *    - При ошибке биржи: откат резервации
 * 4. Создание Order aggregate с **venueOrderId** (Order.create → PENDING)
 * 5. Принятие ордера (order.accept → OPEN)
 * 6. Сохранение ордера в репозиторий (с venueOrderId!)
 * 7. Публикация доменных событий
 *
 * ### Почему Order создаётся ПОСЛЕ отправки на биржу:
 * Polymarket возвращает свой orderId (0xa928...) при размещении.
 * Именно этот venueOrderId используется во всех WS-событиях (fills, order updates).
 * Order хранится в репозитории под venueOrderId — только так OrderUpdateHandler
 * и FillEventHandler смогут найти ордер по ID из WS-событий.
 * input.orderId используется как clientOrderId для идемпотентности retry.
 *
 * ### Идемпотентность:
 * input.orderId (внутренний UUID) передаётся в биржу как clientOrderId для retry.
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
import type { IExchangeClient } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { IOrderRiskChecker, RiskViolationError } from '@polymarket/risk';
import type { PortfolioService } from './services/PortfolioService.js';
import type { OrderService } from './services/OrderService.js';

/** Входные данные для PlaceOrderUseCase */
export interface PlaceOrderInput {
  /**
   * Внутренний ID ордера — используется как clientOrderId для идемпотентности retry.
   * Фактический orderId ордера будет venueOrderId, возвращённый биржей.
   * Use case вернёт Ok(venueOrderId), а не Ok(orderId).
   */
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
        clientOrderId: String(input.orderId),
      });
      return riskResult;
    }

    // Шаг 2: Резервирование ресурсов (BUY → USDC, SELL → токены)
    const isBuy = input.side === 'BUY';
    const notional = isBuy ? input.price.value().times(input.size.value()) : undefined;
    const reserveResult = isBuy
      ? this._deps.portfolioService.reserveForOrder(input.accountId, notional!)
      : this._deps.portfolioService.reserveTokensForOrder(
          input.accountId,
          input.instrumentId,
          input.size.value(),
        );
    if (!reserveResult.ok) {
      return Err(new TradingError(
        `Failed to reserve ${isBuy ? 'balance' : 'tokens'}: ${reserveResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            ...(isBuy ? { notional: notional!.toString() } : { instrumentId: String(input.instrumentId), size: input.size.value().toString() }),
          },
        },
      ));
    }

    // Шаг 3: Отправка на биржу
    // input.orderId используется как clientOrderId для идемпотентности retry.
    // Фактический orderId ордера = venueOrderId, который вернёт биржа.
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
        clientOrderId: String(input.orderId),
        error: submitResult.error.message,
      });
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation during rollback', {
          clientOrderId: String(input.orderId),
          releaseError: releaseResult.error.message,
        });
      }
      return Err(new TradingError(
        `Exchange submission failed: ${submitResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            rollbackError: releaseResult.ok ? undefined : releaseResult.error.message,
          },
        },
      ));
    }

    // venueOrderId — реальный ID от биржи (0xa928...).
    // Именно этот ID используется в WS-событиях (fills, order updates).
    // Order entity создаётся с этим ID, чтобы lookups в OrderUpdateHandler работали.
    const venueOrderId = submitResult.value;

    // Шаг 4: Создание Order aggregate с venueOrderId
    const timestampResult = TimestampService.fromDate(this._deps.clock.now());
    if (!timestampResult.ok) {
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after timestamp failure', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
      }
      await this._deps.exchangeClient.cancelOrder(venueOrderId);
      return Err(new TradingError(
        `Failed to create timestamp: ${timestampResult.error.message}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    const orderResult = Order.create({
      id: venueOrderId,
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      timestamp: timestampResult.value,
      strategyId: input.strategyId,
    });
    if (!orderResult.ok) {
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after Order.create failure', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
      }
      await this._deps.exchangeClient.cancelOrder(venueOrderId);
      return Err(orderResult.error);
    }
    const order = orderResult.value;

    // Шаг 5: Принятие ордера (PENDING → OPEN)
    const acceptResult = order.accept();
    if (!acceptResult.ok) {
      // Откат: снять резервацию и отменить ордер на бирже
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation during accept() rollback', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      if (!cancelExchangeResult.ok) {
        this._logger.error('Failed to cancel exchange order during accept() rollback', {
          venueOrderId: String(venueOrderId),
          error: cancelExchangeResult.error.message,
        });
      }
      return Err(acceptResult.error);
    }
    const acceptedOrder = acceptResult.value;

    // Шаг 6: Сохранение ордера (с venueOrderId)
    try {
      await this._deps.orderService.save(acceptedOrder);
    } catch (err) {
      this._logger.error('Failed to save accepted order', {
        venueOrderId: String(venueOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return Err(new TradingError(
        `Failed to save order: ${err instanceof Error ? err.message : String(err)}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    // Шаг 7: Публикация событий
    const events = acceptedOrder.pullEvents();
    try {
      await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
    } catch (err) {
      this._logger.error('Failed to publish order placed events', {
        venueOrderId: String(venueOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return Err(new TradingError(
        `Failed to publish events: ${err instanceof Error ? err.message : String(err)}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    this._logger.info('Order placed successfully', {
      venueOrderId: String(venueOrderId),
      clientOrderId: String(input.orderId),
      side: input.side,
      ...(notional !== undefined ? { notional: notional.toString() } : { size: input.size.value().toString() }),
    });

    return Ok(venueOrderId);
  }
}

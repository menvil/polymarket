/**
 * TradingAPI — изолированный торговый API для одной стратегии.
 *
 * @remarks
 * Реализует ITradingAPI и оборачивает use-cases приложения.
 *
 * ### Изоляция подписок:
 * `subscribe()` отслеживает все возвращаемые unsubscribe-функции в `_unsubscribes[]`.
 * `unsubscribeAll()` вызывает все из них и очищает массив.
 *
 * ### Генерация orderId:
 * Каждый вызов `placeOrder()` генерирует уникальный UUID как OrderId.
 *
 * ### Portfolio в PlaceOrderUseCase:
 * TradingAPI читает актуальный Portfolio из IPortfolioStore перед каждым ордером.
 * openOrdersCount запрашивается из IOrderRepository.
 *
 * @example
 * ```typescript
 * const api = new TradingAPI({
 *   strategyId: 'my-strategy-1',
 *   accountId: myAccountId,
 *   placeOrderUseCase, cancelOrderUseCase,
 *   orderRepo, portfolioStore, eventBus, logger,
 * });
 * ```
 */
import type { Result } from '@polymarket/result';
import { Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, OrderId } from '@polymarket/ids';
import { asOrderId } from '@polymarket/ids';
import type { ApplicationEvent, EventHandler, IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore } from '@polymarket/ports';
import type { Order } from '@polymarket/order';
import type { PlaceOrderUseCase, PlaceOrderError, CancelOrderUseCase } from '@polymarket/use-cases';
import type { ITradingAPI, PlaceOrderParams } from './ITradingAPI.js';

/**
 * Зависимости TradingAPI.
 *
 * @remarks
 * Инжектируются StrategyRunner при создании экземпляра для каждой стратегии.
 */
export interface TradingAPIDeps {
  /** ID стратегии для изоляции ордеров и подписок */
  readonly strategyId: string;
  /** ID аккаунта для резервирования баланса и получения Portfolio */
  readonly accountId: AccountId;
  /** Use case размещения ордера */
  readonly placeOrderUseCase: PlaceOrderUseCase;
  /** Use case отмены ордера */
  readonly cancelOrderUseCase: CancelOrderUseCase;
  /** Репозиторий ордеров (для getOpenOrders и countByStrategyId) */
  readonly orderRepo: IOrderRepository;
  /** Хранилище Portfolio (для чтения текущего баланса) */
  readonly portfolioStore: IPortfolioStore;
  /** Event bus для подписок стратегии */
  readonly eventBus: IEventBus;
  /** Logger */
  readonly logger: ILogger;
}

/**
 * Изолированный торговый API для одной стратегии.
 *
 * @remarks
 * Каждая стратегия получает свой экземпляр TradingAPI.
 * StrategyRunner создаёт его при вызове `start(strategy)`.
 */
export class TradingAPI implements ITradingAPI {
  private readonly _logger: ILogger;
  /** Список всех active unsubscribe-функций */
  private readonly _unsubscribes: Array<() => void> = [];

  /**
   * @param deps - Зависимости TradingAPI
   */
  constructor(private readonly _deps: TradingAPIDeps) {
    this._logger = _deps.logger.child({ component: 'TradingAPI', strategyId: _deps.strategyId });
  }

  /**
   * ID стратегии этого API.
   */
  get strategyId(): string {
    return this._deps.strategyId;
  }

  /**
   * Размещает новый лимитный ордер через PlaceOrderUseCase.
   *
   * @param params - Параметры ордера
   * @returns Ok(OrderId) при успехе, Err(PlaceOrderError) при нарушении риска или ошибке биржи
   *
   * @remarks
   * Алгоритм:
   * 1. Генерирует уникальный OrderId (UUID)
   * 2. Читает актуальный Portfolio из portfolioStore
   * 3. Запрашивает количество открытых ордеров стратегии
   * 4. Делегирует PlaceOrderUseCase
   */
  public async placeOrder(params: PlaceOrderParams): Promise<Result<OrderId, PlaceOrderError>> {
    // crypto.randomUUID() всегда валидный UUID — не содержит control chars, длина < 256
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const orderId = asOrderId(crypto.randomUUID())!;

    const portfolio = this._deps.portfolioStore.get(this._deps.accountId);
    if (!portfolio) {
      this._logger.warn('Portfolio not found, cannot place order', {
        accountId: String(this._deps.accountId),
        strategyId: this._deps.strategyId,
      });
      return Err(new TradingError(
        `Portfolio not found for account: ${String(this._deps.accountId)}`,
        { context: { strategyId: this._deps.strategyId } },
      ));
    }

    const openOrdersCount = await this._deps.orderRepo.countByStrategyId(this._deps.strategyId);

    return this._deps.placeOrderUseCase.execute({
      orderId,
      accountId: this._deps.accountId,
      asset: params.asset,
      instrumentId: params.instrumentId,
      side: params.side,
      price: params.price,
      size: params.size,
      strategyId: this._deps.strategyId,
      portfolio,
      openOrdersCount,
    });
  }

  /**
   * Отменяет открытый ордер через CancelOrderUseCase.
   *
   * @param orderId - ID ордера
   * @returns Ok(void) при успехе
   */
  public async cancelOrder(orderId: OrderId): Promise<Result<void, TradingError>> {
    return this._deps.cancelOrderUseCase.execute({
      orderId,
      accountId: this._deps.accountId,
    });
  }

  /**
   * Возвращает открытые ордера этой стратегии.
   *
   * @returns Readonly массив ордеров стратегии
   */
  public async getOpenOrders(): Promise<readonly Order[]> {
    return this._deps.orderRepo.getByStrategyId(this._deps.strategyId);
  }

  /**
   * Подписывается на событие и отслеживает unsubscribe для последующего cleanup.
   *
   * @param type - Тип события
   * @param handler - Async handler
   * @returns Функция отписки (также убирает из внутреннего трекинга)
   *
   * @remarks
   * Внутренний `_unsubscribes[]` хранит оригинальные unsubscribe-функции от eventBus.
   * При вызове возвращённой функции — снимаем подписку И убираем из трекинга.
   */
  public subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void {
    const unsub = this._deps.eventBus.subscribe(type, handler);
    this._unsubscribes.push(unsub);

    return () => {
      unsub();
      const idx = this._unsubscribes.indexOf(unsub);
      if (idx !== -1) {
        this._unsubscribes.splice(idx, 1);
      }
    };
  }

  /**
   * Снимает все активные подписки стратегии.
   *
   * @remarks
   * Вызывается StrategyRunner автоматически после `strategy.stop()`.
   * Идемпотентен: повторный вызов на уже отписанном API безопасен.
   */
  public unsubscribeAll(): void {
    for (const unsub of this._unsubscribes) {
      unsub();
    }
    this._unsubscribes.length = 0;
    this._logger.debug('TradingAPI: all subscriptions removed');
  }
}

/**
 * Корневой агрегат TradingSession
 *
 * @remarks
 * Корневой агрегат, управляющий всем состоянием торговой сессии.
 * Координирует рынок, портфель, риски и ордера.
 *
 * Алгоритм:
 * - Отслеживает все активные ордера с их состоянием
 * - Управляет резервированием средств для BUY ордеров
 * - Обрабатывает исполнение ордеров и обновляет позиции
 * - Мониторит риски и применяет лимиты
 * - Валидирует все бизнес-правила и инварианты
 * - Иммутабельный - все операции возвращают новые экземпляры
 *
 * Почему корневой агрегат?
 * - Торговая сессия является верхнеуровневой границей консистентности
 * - Все торговые операции проходят через сессию
 * - Координирует портфель, риски и ордера вместе
 * - Обеспечивает глобальные инварианты для всех сущностей
 * - Единственный источник истины для всего торгового состояния
 *
 * Жизненный цикл ордера:
 * 1. placeOrder(): Резервирует средства (если BUY), добавляет в активные ордера
 * 2. Ордер находится в activeOrders map до исполнения или отмены
 * 3. fillOrder(): Обновляет позицию, конвертирует зарезервированные средства, удаляет из активных
 * 4. cancelOrder(): Освобождает зарезервированные средства, удаляет из активных
 *
 * Управление рисками:
 * - Непрерывно обновляет риски на основе состояния портфеля
 * - Применяет лимиты на позиции и убытки
 * - Переключается между торговыми режимами
 * - Может блокировать ордера при превышении лимитов
 *
 * @example
 * ```typescript
 * // Create session
 * const market = Market.create({...});
 * const session = TradingSession.create(market, Money.fromUSDC(1000));
 * console.log(session.portfolio.cash.amount); // 1000
 *
 * // Place order
 * const order = Order.create({
 *   id: 'order-1',
 *   tokenId: market.upTokenId,
 *   side: 'BUY',
 *   price: Price.fromNumber(0.60),
 *   size: Quantity.fromNumber(100),
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 * const withOrder = session.placeOrder(order);
 * console.log(withOrder.portfolio.reservedCash.amount); // 60
 *
 * // Fill order
 * const filled = withOrder.fillOrder('order-1', Quantity.fromNumber(100), Price.fromNumber(0.60));
 * console.log(filled.portfolio.getPosition(market.upTokenId)?.totalQuantity.value); // 100
 *
 * // Update risk
 * const prices = new Map([[market.upTokenId, Price.fromNumber(0.65)]]);
 * const limits = { maxNetPosition: 1000, maxGrossPosition: 2000, maxLossThreshold: Money.fromUSDC(100) };
 * const withRisk = filled.updateRisk(prices, 86400000, limits);
 * console.log(withRisk.riskExposure.status); // 'NORMAL'
 * ```
 */
import { Market } from '../entities/Market.js';
import { Order } from '../entities/Order.js';
import { PositionLot } from '../entities/PositionLot.js';
import { Portfolio } from './Portfolio.js';
import { RiskExposure } from './RiskExposure.js';
import { Money } from '../value-objects/Money.js';
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Ошибка нарушения инварианта торговой сессии
 *
 * @remarks
 * Выбрасывается когда состояние сессии нарушает бизнес-правила
 */
export class TradingSessionInvariantError extends TradingError {
  constructor(message: string) {
    super(`Trading session invariant violation: ${message}`, 'SESSION_INVARIANT_VIOLATION');
  }
}

/**
 * Ошибка "ордер не найден"
 *
 * @remarks
 * Выбрасывается при попытке доступа к несуществующему ордеру
 */
export class OrderNotFoundError extends TradingError {
  constructor(public readonly orderId: string) {
    super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND');
  }
}

/**
 * Лимиты рисков для сессии
 */
export interface SessionRiskLimits {
  readonly maxNetPosition: number;
  readonly maxGrossPosition: number;
  readonly maxLossThreshold: Money;
}

/**
 * Корневой агрегат TradingSession
 *
 * @remarks
 * Иммутабельный корневой агрегат, управляющий всем торговым состоянием.
 * Все методы возвращают новые экземпляры TradingSession.
 */
export class TradingSession {
  /**
   * Создаёт новый TradingSession
   *
   * @param sessionId - Уникальный идентификатор сессии
   * @param market - Рынок для торговли
   * @param portfolio - Состояние портфеля
   * @param riskExposure - Состояние управления рисками
   * @param activeOrders - Map активных ордеров (orderId -> Order)
   * @param startTime - Время начала сессии
   * @param lastUpdateTime - Временная метка последнего обновления
   *
   * @remarks
   * Приватный конструктор - используйте статические фабричные методы.
   */
  private constructor(
    public readonly sessionId: string,
    public readonly market: Market,
    public readonly portfolio: Portfolio,
    public readonly riskExposure: RiskExposure,
    public readonly activeOrders: ReadonlyMap<string, Order>,
    public readonly startTime: Date,
    public readonly lastUpdateTime: Date
  ) {}

  /**
   * Создаёт новую торговую сессию
   *
   * @param market - Рынок для торговли
   * @param initialCash - Начальный баланс средств
   * @returns Новый TradingSession
   *
   * @throws {Error} Выбрасывается когда рынок не активен или начальный баланс отрицательный
   *
   * @remarks
   * Фабричный метод, создающий начальное состояние сессии.
   * - Валидирует, что рынок активен и доступен для торговли
   * - Создаёт портфель с начальным балансом
   * - Инициализирует риск-экспозицию в NORMAL
   * - Устанавливает пустой map активных ордеров
   *
   * @example
   * ```typescript
   * const market = Market.create({
   *   id: '0x123',
   *   question: 'Will BTC hit $100k?',
   *   upTokenId: 'yes-token',
   *   downTokenId: 'no-token',
   *   expirationDate: new Date('2024-12-31'),
   *   status: 'ACTIVE'
   * });
   *
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * console.log(session.sessionId); // Generated UUID
   * console.log(session.portfolio.cash.amount); // 1000
   * console.log(session.riskExposure.status); // 'NORMAL'
   * ```
   */
  public static create(market: Market, initialCash: Money): TradingSession {
    // Validate market is tradeable
    if (!market.canTrade()) {
      throw new Error(`Market ${market.id} is not active for trading`);
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const portfolio = Portfolio.create(initialCash);
    const riskExposure = RiskExposure.create();

    const session = new TradingSession(
      sessionId,
      market,
      portfolio,
      riskExposure,
      new Map(),
      new Date(),
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Размещает ордер в сессии
   *
   * @param order - Ордер для размещения
   * @returns Новый TradingSession с добавленным ордером
   *
   * @throws {Error} Выбрасывается когда валидация ордера не прошла или недостаточно средств
   *
   * @remarks
   * Алгоритм:
   * 1. Валидация возможности размещения ордера (лимиты, средства, состояние рынка)
   * 2. Если BUY ордер: резервирование средств = price * size
   * 3. Добавление ордера в activeOrders map
   * 4. Валидация всех инвариантов
   * 5. Возврат нового TradingSession
   *
   * Зачем резервировать средства?
   * - Предотвращает избыточное выделение средств
   * - Зарезервированные средства нельзя использовать для других ордеров
   * - Освобождаются при отмене или исполнении ордера
   * - Гарантирует возможность оплаты исполнений
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   *
   * const order = Order.create({
   *   id: 'order-1',
   *   tokenId: market.upTokenId,
   *   side: 'BUY',
   *   price: Price.fromNumber(0.60),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   *
   * const withOrder = session.placeOrder(order);
   * console.log(withOrder.activeOrders.size); // 1
   * console.log(withOrder.portfolio.reservedCash.amount); // 60
   * ```
   */
  public placeOrder(order: Order): TradingSession {
    // Validate order can be placed
    if (!this.canPlaceOrder(order)) {
      throw new Error(`Cannot place order ${order.id}: validation failed`);
    }

    // Validate order belongs to this market
    if (this.market.getOutcomeIndexByTokenId(order.tokenId) === null) {
      throw new Error(`Order token ${order.tokenId} does not belong to market ${this.market.id}`);
    }

    let newPortfolio = this.portfolio;

    // Reserve cash for BUY orders
    if (order.side === 'BUY') {
      const orderCost = Money.fromUSDC(order.price.value * order.size.value);
      newPortfolio = newPortfolio.reserveCash(orderCost);
    }

    // Add order to active orders
    const newActiveOrders = new Map(this.activeOrders);
    newActiveOrders.set(order.id, order);

    const session = new TradingSession(
      this.sessionId,
      this.market,
      newPortfolio,
      this.riskExposure,
      newActiveOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Отменяет активный ордер
   *
   * @param orderId - ID ордера для отмены
   * @returns Новый TradingSession с отменённым ордером
   *
   * @throws {OrderNotFoundError} Выбрасывается когда ордер не существует
   * @throws {Error} Выбрасывается когда ордер не может быть отменён
   *
   * @remarks
   * Алгоритм:
   * 1. Поиск ордера в activeOrders
   * 2. Валидация возможности отмены ордера (PENDING или OPEN)
   * 3. Если BUY ордер: освобождение зарезервированных средств
   * 4. Удаление ордера из activeOrders
   * 5. Валидация инвариантов
   * 6. Возврат нового TradingSession
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order);
   * console.log(session.portfolio.reservedCash.amount); // 60
   *
   * const canceled = session.cancelOrder('order-1');
   * console.log(canceled.activeOrders.size); // 0
   * console.log(canceled.portfolio.reservedCash.amount); // 0 (cash released)
   * ```
   */
  public cancelOrder(orderId: string): TradingSession {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    if (!order.canCancel()) {
      throw new Error(`Order ${orderId} cannot be canceled (status: ${order.status})`);
    }

    let newPortfolio = this.portfolio;

    // Release reserved cash for BUY orders
    if (order.side === 'BUY') {
      const orderCost = Money.fromUSDC(order.price.value * order.size.value);
      newPortfolio = newPortfolio.releaseCash(orderCost);
    }

    // Remove order from active orders
    const newActiveOrders = new Map(this.activeOrders);
    newActiveOrders.delete(orderId);

    const session = new TradingSession(
      this.sessionId,
      this.market,
      newPortfolio,
      this.riskExposure,
      newActiveOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Обрабатывает исполнение ордера
   *
   * @param orderId - ID исполненного ордера
   * @param fillSize - Исполненное количество
   * @param fillPrice - Цена исполнения
   * @returns Новый TradingSession с обработанным исполнением
   *
   * @throws {OrderNotFoundError} Выбрасывается когда ордер не существует
   * @throws {Error} Выбрасывается когда исполнение невалидно
   *
   * @remarks
   * Алгоритм:
   * 1. Поиск ордера в activeOrders
   * 2. Валидация fill size <= оставшегося размера
   * 3. Создание лота позиции для исполнения
   * 4. Добавление лота в портфель (создаёт/обновляет позицию)
   * 5. Если BUY: освобождение зарезервированных средств, уменьшение средств на стоимость исполнения
   * 6. Если SELL: увеличение средств на выручку от исполнения
   * 7. Если ордер полностью исполнен: удаление из activeOrders
   * 8. Если частичное исполнение: обновление ордера в activeOrders
   * 9. Валидация инвариантов
   * 10. Возврат нового TradingSession
   *
   * Зачем создавать лоты?
   * - FIFO учёт для налогового соответствия
   * - Отслеживание цены входа по лотам для P&L
   * - Поддержка частичного закрытия позиций
   * - Точное отслеживание базиса стоимости
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(buyOrder); // BUY 100 @ 0.60
   *
   * // Order fills
   * const filled = session.fillOrder(
   *   'order-1',
   *   Quantity.fromNumber(100),
   *   Price.fromNumber(0.60)
   * );
   *
   * console.log(filled.activeOrders.size); // 0 (fully filled)
   * console.log(filled.portfolio.cash.amount); // 940 (1000 - 60)
   * console.log(filled.portfolio.reservedCash.amount); // 0
   *
   * const position = filled.portfolio.getPosition(market.upTokenId);
   * console.log(position?.totalQuantity.value); // 100
   * console.log(position?.averageEntryPrice.value); // 0.60
   * ```
   */
  public fillOrder(orderId: string, fillSize: Quantity, fillPrice: Price): TradingSession {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    // Validate fill size
    const remainingSize = order.getRemainingSize();
    if (fillSize.isGreaterThan(remainingSize)) {
      throw new Error(
        `Fill size ${fillSize.value} exceeds remaining size ${remainingSize.value}`
      );
    }

    let newPortfolio = this.portfolio;
    const fillCost = fillPrice.value * fillSize.value;

    // Determine side for position based on outcome index (0 → YES, 1 → NO)
    const outcomeIndex = this.market.getOutcomeIndexByTokenId(order.tokenId);
    const side = outcomeIndex === 0 ? 'YES' : 'NO';

    if (order.side === 'BUY') {
      // BUY order: release reserved cash, deduct fill cost from total cash
      const orderCost = Money.fromUSDC(order.price.value * order.size.value);
      const fillCostMoney = Money.fromUSDC(fillCost);

      // Release full order reservation
      newPortfolio = newPortfolio.releaseCash(orderCost);

      // Deduct actual fill cost from cash
      newPortfolio = newPortfolio.deductCash(fillCostMoney);

      // Create lot and add to position
      const lot = new PositionLot(
        `lot-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        order.tokenId,
        side,
        fillSize,
        fillPrice,
        new Date()
      );

      newPortfolio = newPortfolio.addPosition(order.tokenId, side, lot);
    } else {
      // SELL order: add proceeds to cash, reduce position
      const fillProceedsMoney = Money.fromUSDC(fillCost);

      // Add proceeds to cash
      newPortfolio = newPortfolio.addCash(fillProceedsMoney);

      // Remove quantity from position
      newPortfolio = newPortfolio.removePosition(order.tokenId, fillSize);
    }

    // Update or remove order
    const newActiveOrders = new Map(this.activeOrders);
    const isFullyFilled = fillSize.equals(remainingSize);

    if (isFullyFilled) {
      // Remove fully filled order
      newActiveOrders.delete(orderId);
    } else {
      // Update partially filled order
      const updatedOrder = order.withFill(
        order.filledSize ? order.filledSize.add(fillSize) : fillSize,
        fillPrice
      );
      newActiveOrders.set(orderId, updatedOrder);
    }

    const session = new TradingSession(
      this.sessionId,
      this.market,
      newPortfolio,
      this.riskExposure,
      newActiveOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Обновляет риск-экспозицию на основе текущего состояния
   *
   * @param prices - Текущие рыночные цены (tokenId -> Price)
   * @param timeToExpiry - Миллисекунды до истечения рынка
   * @param limits - Конфигурация лимитов рисков
   * @returns Новый TradingSession с обновлёнными рисками
   *
   * @remarks
   * Алгоритм:
   * 1. Расчёт нереализованного P&L из портфеля
   * 2. Проверка необходимости паники (превышен порог убытков)
   * 3. Проверка лимитов позиций (net, gross)
   * 4. Расчёт срочности на основе времени и позиции
   * 5. Обновление риск-экспозиции новым состоянием
   * 6. Возврат нового TradingSession
   *
   * Должен вызываться:
   * - После каждого исполнения
   * - Периодически (например, каждую минуту)
   * - При значительном изменении цен
   * - При приближении к истечению
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order)
   *   .fillOrder('order-1', Quantity.fromNumber(100), Price.fromNumber(0.60));
   *
   * const prices = new Map([[market.upTokenId, Price.fromNumber(0.70)]]);
   * const limits = {
   *   maxNetPosition: 1000,
   *   maxGrossPosition: 2000,
   *   maxLossThreshold: Money.fromUSDC(100)
   * };
   *
   * const withRisk = session.updateRisk(prices, 86400000, limits);
   * console.log(withRisk.riskExposure.status); // 'NORMAL'
   * console.log(withRisk.riskExposure.urgency); // ~0.04
   * ```
   */
  public updateRisk(
    prices: Map<string, Price>,
    timeToExpiry: number,
    limits: SessionRiskLimits
  ): TradingSession {
    // Calculate unrealized P&L
    const unrealizedPnL = this.portfolio.calculateUnrealizedPnL(prices);

    // Check for panic condition
    let newRiskExposure = this.riskExposure;
    if (this.riskExposure.shouldPanic(unrealizedPnL, limits.maxLossThreshold)) {
      newRiskExposure = newRiskExposure.updateMode(
        'PANIC',
        `Unrealized loss $${Math.abs(unrealizedPnL.amount).toFixed(2)} exceeds threshold $${limits.maxLossThreshold.amount.toFixed(2)}`
      );
    }

    // Check position limits
    newRiskExposure = newRiskExposure.checkLimits(
      this.portfolio,
      limits.maxNetPosition,
      limits.maxGrossPosition
    );

    // Calculate and update urgency
    const urgency = newRiskExposure.calculateUrgency(
      timeToExpiry,
      Math.abs(this.portfolio.netPosition),
      limits.maxNetPosition
    );

    newRiskExposure = newRiskExposure.updateUrgency(
      urgency,
      `Time: ${(timeToExpiry / 3600000).toFixed(1)}h, Position: ${Math.abs(this.portfolio.netPosition)}/${limits.maxNetPosition}`
    );

    const session = new TradingSession(
      this.sessionId,
      this.market,
      this.portfolio,
      newRiskExposure,
      this.activeOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Валидирует возможность размещения ордера
   *
   * @param order - Ордер для валидации
   * @returns True если ордер может быть размещён
   *
   * @remarks
   * Проверки валидации:
   * 1. Рынок активен и не истёк
   * 2. Ордер для корректных токенов рынка
   * 3. Портфель имеет достаточно средств (для BUY)
   * 4. Лимиты рисков позволяют ордер (не в режиме PANIC)
   * 5. Ордер ещё не в activeOrders
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   *
   * const canPlace = session.canPlaceOrder(order);
   * if (canPlace) {
   *   const withOrder = session.placeOrder(order);
   * }
   * ```
   */
  public canPlaceOrder(order: Order): boolean {
    // Check market is tradeable
    if (!this.market.canTrade()) {
      return false;
    }

    // Check token belongs to market
    if (this.market.getOutcomeIndexByTokenId(order.tokenId) === null) {
      return false;
    }

    // Check sufficient funds for BUY orders
    if (order.side === 'BUY') {
      if (!this.portfolio.canAffordOrder(order.price, order.size)) {
        return false;
      }
    } else {
      // For SELL orders, check we have position
      const position = this.portfolio.getPosition(order.tokenId);
      if (!position || position.totalQuantity.isLessThan(order.size)) {
        return false;
      }
    }

    // Check not in PANIC mode (can't place new orders)
    if (this.riskExposure.isPanic()) {
      return false;
    }

    // Check order not already active
    if (this.activeOrders.has(order.id)) {
      return false;
    }

    return true;
  }

  /**
   * Получает активные ордера для определённого токена
   *
   * @param tokenId - ID токена для фильтрации
   * @returns Массив ордеров для этого токена
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(yesOrder)
   *   .placeOrder(noOrder);
   *
   * const upOrders = session.getActiveOrdersForToken(market.upTokenId);
   * console.log(upOrders.length); // 1
   * ```
   */
  public getActiveOrdersForToken(tokenId: string): Order[] {
    const orders: Order[] = [];
    for (const order of this.activeOrders.values()) {
      if (order.tokenId === tokenId) {
        orders.push(order);
      }
    }
    return orders;
  }

  /**
   * Получает общую сумму зарезервированных средств из активных ордеров
   *
   * @returns Общая сумма зарезервированных средств
   *
   * @remarks
   * Должна совпадать с portfolio.reservedCash (проверяется в инвариантах)
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order1) // BUY 100 @ 0.60 = 60
   *   .placeOrder(order2); // BUY 50 @ 0.70 = 35
   *
   * const reserved = session.getTotalReservedCash();
   * console.log(reserved.amount); // 95
   * ```
   */
  public getTotalReservedCash(): Money {
    let total = 0;
    for (const order of this.activeOrders.values()) {
      if (order.side === 'BUY') {
        total += order.getNotional();
      }
    }
    return Money.fromUSDC(total);
  }

  /**
   * Валидирует все бизнес-правила и инварианты
   *
   * @throws {TradingSessionInvariantError} Выбрасывается когда какой-либо инвариант нарушен
   *
   * @remarks
   * Бизнес-правила:
   * 1. Рынок должен быть валидным и активным
   * 2. Портфель должен быть валидным
   * 3. Риск-экспозиция должна быть валидной
   * 4. Все активные ордера должны быть валидными
   * 5. Зарезервированные средства должны совпадать с суммой notional BUY ордеров
   * 6. Все ордера должны принадлежать этому рынку
   * 7. Время начала должно быть раньше времени последнего обновления
   * 8. ID сессии не должен быть пустым
   *
   * Вызывается автоматически после каждого изменения состояния.
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * session.validateSessionInvariants(); // OK
   * ```
   */
  public validateSessionInvariants(): void {
    // Rule 1: Market must be valid
    if (!this.market || !this.market.id) {
      throw new TradingSessionInvariantError('Market must be valid');
    }

    // Rule 2: Portfolio must be valid
    try {
      this.portfolio.validateInvariants();
    } catch (error) {
      throw new TradingSessionInvariantError(`Portfolio invalid: ${error}`);
    }

    // Rule 3: Risk exposure must be valid
    try {
      this.riskExposure.validateInvariants();
    } catch (error) {
      throw new TradingSessionInvariantError(`Risk exposure invalid: ${error}`);
    }

    // Rule 4: All active orders must be valid
    for (const [orderId, order] of this.activeOrders) {
      if (order.id !== orderId) {
        throw new TradingSessionInvariantError(
          `Order ID mismatch: map key ${orderId} vs order.id ${order.id}`
        );
      }

      try {
        order.validate();
      } catch (error) {
        throw new TradingSessionInvariantError(`Order ${orderId} invalid: ${error}`);
      }
    }

    // Rule 5: Reserved cash must match sum of BUY order notionals
    const calculatedReserved = this.getTotalReservedCash();
    if (!calculatedReserved.equals(this.portfolio.reservedCash)) {
      throw new TradingSessionInvariantError(
        `Reserved cash mismatch: calculated $${calculatedReserved.amount} vs portfolio $${this.portfolio.reservedCash.amount}`
      );
    }

    // Rule 6: All orders must belong to this market
    for (const order of this.activeOrders.values()) {
      if (this.market.getOutcomeIndexByTokenId(order.tokenId) === null) {
        throw new TradingSessionInvariantError(
          `Order ${order.id} token ${order.tokenId} does not belong to market ${this.market.id}`
        );
      }
    }

    // Rule 7: Start time must be before last update time
    if (this.startTime.getTime() > this.lastUpdateTime.getTime()) {
      throw new TradingSessionInvariantError(
        'Start time cannot be after last update time'
      );
    }

    // Rule 8: Session ID must be non-empty
    if (!this.sessionId || this.sessionId.trim().length === 0) {
      throw new TradingSessionInvariantError('Session ID cannot be empty');
    }
  }

  /**
   * Получает продолжительность сессии в миллисекундах
   *
   * @returns Продолжительность с момента начала сессии
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * // ... trading happens ...
   * const duration = session.getDuration();
   * console.log(`Session running for ${duration}ms`);
   * ```
   */
  public getDuration(): number {
    return this.lastUpdateTime.getTime() - this.startTime.getTime();
  }

  /**
   * Проверяет наличие активных позиций в сессии
   *
   * @returns True если портфель имеет позиции
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * console.log(session.hasActivePositions()); // false
   *
   * const withPosition = session.placeOrder(order).fillOrder(...);
   * console.log(withPosition.hasActivePositions()); // true
   * ```
   */
  public hasActivePositions(): boolean {
    return !this.portfolio.isEmpty();
  }

  /**
   * Проверяет наличие активных ордеров в сессии
   *
   * @returns True если есть активные ордера
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * console.log(session.hasActiveOrders()); // false
   *
   * const withOrder = session.placeOrder(order);
   * console.log(withOrder.hasActiveOrders()); // true
   * ```
   */
  public hasActiveOrders(): boolean {
    return this.activeOrders.size > 0;
  }

  /**
   * Создаёт строковое представление торговой сессии
   *
   * @returns Форматированная строка с описанием сессии
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order);
   * console.log(session.toString());
   * // "TradingSession[session-123]: Market[0x123] - 1 orders, 0 positions - RiskExposure: NORMAL/QUOTE"
   * ```
   */
  public toString(): string {
    return `TradingSession[${this.sessionId}]: Market[${this.market.id}] - ${this.activeOrders.size} orders, ${this.portfolio.positions.size} positions - ${this.riskExposure.toString()}`;
  }
}

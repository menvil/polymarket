/**
 * Portfolio entity
 *
 * @remarks
 * Представляет портфель трейдера с денежными средствами и позициями.
 * Управляет кэшем, резервированием средств и расчётом общей стоимости.
 *
 * Алгоритм:
 * 1. Хранит доступный кэш (cash) и резервированный кэш (reservedCash)
 * 2. Управляет позициями по всем рынкам (Map<marketId, Position>)
 * 3. Резервирует средства при размещении BUY ордеров
 * 4. Освобождает средства при отмене или исполнении ордеров
 * 5. Вычисляет общую стоимость портфеля = cash + sum(position values)
 *
 * Бизнес-правила:
 * - Нельзя резервировать больше доступного кэша
 * - Резервированный кэш недоступен для новых ордеров
 * - При добавлении позиции проверяется уникальность marketId
 * - Общая стоимость учитывает текущие рыночные цены
 *
 * @example
 * ```typescript
 * const portfolio = Portfolio.create('portfolio-1', Money.fromUSDC(1000));
 * 
 * // Резервируем средства для BUY ордера
 * const updated = portfolio.reserveCash(Money.fromUSDC(100));
 * console.log(updated.availableCash.amount); // 900
 * console.log(updated.reservedCash.amount); // 100
 * 
 * // Добавляем позицию
 * const withPosition = updated.addPosition(position);
 * 
 * // Вычисляем общую стоимость
 * const totalValue = withPosition.getTotalValue(marketPrices);
 * console.log(totalValue.amount); // cash + position values
 * ```
 */
import { Money } from '../value-objects/Money.js';
import { Position } from './Position.js';
import { Price } from '../value-objects/Price.js';
import { InsufficientFundsError, TradingError } from '../../shared/errors/TradingError.js';

/**
 * Ошибка дублирующейся позиции
 *
 * @remarks
 * Выбрасывается при попытке добавить позицию с уже существующим marketId.
 */
export class DuplicatePositionError extends TradingError {
  constructor(public readonly marketId: string) {
    super(
      `Position already exists for market: ${marketId}`,
      'DUPLICATE_POSITION'
    );
  }
}

/**
 * Ошибка отсутствующей позиции
 *
 * @remarks
 * Выбрасывается при попытке обновить несуществующую позицию.
 */
export class PositionNotFoundError extends TradingError {
  constructor(public readonly marketId: string) {
    super(
      `Position not found for market: ${marketId}`,
      'POSITION_NOT_FOUND'
    );
  }
}

/**
 * Portfolio entity
 *
 * @remarks
 * Immutable entity representing trader's portfolio.
 */
export class Portfolio {
  /**
   * Создаёт новый Portfolio
   *
   * @param id - Уникальный идентификатор портфеля
   * @param cash - Доступные денежные средства
   * @param reservedCash - Резервированные средства (для открытых BUY ордеров)
   * @param positions - Map позиций (marketId -> Position)
   *
   * @remarks
   * Private constructor - используйте статические фабричные методы.
   */
  private constructor(
    public readonly id: string,
    public readonly cash: Money,
    public readonly reservedCash: Money,
    public readonly positions: ReadonlyMap<string, Position>
  ) {}

  /**
   * Создаёт новый пустой портфель
   *
   * @param id - Идентификатор портфеля
   * @param initialCash - Начальные денежные средства
   * @returns Новый Portfolio с нулевым резервом и без позиций
   *
   * @throws {Error} If initialCash is negative
   *
   * @remarks
   * Используется для инициализации нового портфеля.
   * Начинает с нулевым резервом и пустым списком позиций.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create(
   *   'portfolio-1',
   *   Money.fromUSDC(10000)
   * );
   * console.log(portfolio.cash.amount); // 10000
   * console.log(portfolio.reservedCash.amount); // 0
   * console.log(portfolio.positions.size); // 0
   * ```
   */
  public static create(id: string, initialCash: Money): Portfolio {
    if (!id || id.trim().length === 0) {
      throw new Error('Portfolio id cannot be empty');
    }
    if (initialCash.amount < 0) {
      throw new Error('Initial cash cannot be negative');
    }

    return new Portfolio(
      id,
      initialCash,
      Money.zero(),
      new Map<string, Position>()
    );
  }

  /**
   * Получает доступный кэш (не резервированный)
   *
   * @returns Доступные денежные средства
   *
   * @remarks
   * Доступный кэш = cash - reservedCash
   * Только доступный кэш может быть использован для новых ордеров.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000))
   *   .reserveCash(Money.fromUSDC(200));
   * 
   * const available = portfolio.availableCash;
   * console.log(available.amount); // 800
   * ```
   */
  public get availableCash(): Money {
    return this.cash.subtract(this.reservedCash);
  }

  /**
   * Резервирует денежные средства
   *
   * @param amount - Сумма для резервирования
   * @returns Новый Portfolio с резервированными средствами
   *
   * @throws {InsufficientFundsError} Если недостаточно доступных средств
   *
   * @remarks
   * Резервирует средства для открытого BUY ордера.
   * Резервированные средства недоступны для других ордеров.
   * 
   * Алгоритм:
   * 1. Проверяем, что availableCash >= amount
   * 2. Увеличиваем reservedCash на amount
   * 3. Возвращаем новый immutable Portfolio
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000));
   * 
   * // Резервируем для BUY ордера на 100 USDC
   * const updated = portfolio.reserveCash(Money.fromUSDC(100));
   * console.log(updated.reservedCash.amount); // 100
   * console.log(updated.availableCash.amount); // 900
   * ```
   */
  public reserveCash(amount: Money): Portfolio {
    const available = this.availableCash;
    
    if (available.isLessThan(amount)) {
      throw new InsufficientFundsError(amount.amount, available.amount);
    }

    const newReservedCash = this.reservedCash.add(amount);

    return new Portfolio(
      this.id,
      this.cash,
      newReservedCash,
      this.positions
    );
  }

  /**
   * Освобождает резервированные средства
   *
   * @param amount - Сумма для освобождения
   * @returns Новый Portfolio с освобождёнными средствами
   *
   * @throws {Error} Если освобождаем больше чем резервировано
   *
   * @remarks
   * Освобождает средства при отмене или исполнении ордера.
   * После освобождения средства снова доступны для новых ордеров.
   * 
   * Алгоритм:
   * 1. Проверяем, что reservedCash >= amount
   * 2. Уменьшаем reservedCash на amount
   * 3. Возвращаем новый immutable Portfolio
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000))
   *   .reserveCash(Money.fromUSDC(100));
   * 
   * // Отменяем ордер - освобождаем средства
   * const updated = portfolio.releaseCash(Money.fromUSDC(100));
   * console.log(updated.reservedCash.amount); // 0
   * console.log(updated.availableCash.amount); // 1000
   * ```
   */
  public releaseCash(amount: Money): Portfolio {
    if (this.reservedCash.isLessThan(amount)) {
      throw new Error(
        `Cannot release ${amount.amount}: only ${this.reservedCash.amount} reserved`
      );
    }

    const newReservedCash = this.reservedCash.subtract(amount);

    return new Portfolio(
      this.id,
      this.cash,
      newReservedCash,
      this.positions
    );
  }

  /**
   * Добавляет или обновляет денежные средства
   *
   * @param amount - Сумма для добавления (может быть отрицательной)
   * @returns Новый Portfolio с обновлённым кэшем
   *
   * @throws {Error} Если результирующий кэш становится отрицательным
   * @throws {InsufficientFundsError} Если результирующий кэш становится меньше reservedCash
   *
   * @remarks
   * Используется для:
   * - Пополнения счёта (положительная сумма)
   * - Списания при покупке (отрицательная сумма)
   * - Зачисления при продаже (положительная сумма)
   * - Вывода средств (отрицательная сумма)
   *
   * Инвариант: cash должен быть >= reservedCash для сохранения корректного availableCash.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000));
   *
   * // Пополнение
   * const deposited = portfolio.updateCash(Money.fromUSDC(500));
   * console.log(deposited.cash.amount); // 1500
   *
   * // Списание при покупке
   * const afterBuy = deposited.updateCash(Money.fromUSDC(-100));
   * console.log(afterBuy.cash.amount); // 1400
   * ```
   */
  public updateCash(amount: Money): Portfolio {
    const newCash = amount.amount >= 0
      ? this.cash.add(amount)
      : this.cash.subtract(Money.fromUSDC(Math.abs(amount.amount)));

    if (newCash.amount < 0) {
      throw new Error(`Cash cannot be negative: ${newCash.amount}`);
    }

    // Проверка инварианта: cash не может быть меньше reservedCash
    if (newCash.amount < this.reservedCash.amount) {
      throw new InsufficientFundsError(
        this.reservedCash.amount - newCash.amount,
        newCash.amount
      );
    }

    return new Portfolio(
      this.id,
      newCash,
      this.reservedCash,
      this.positions
    );
  }

  /**
   * Добавляет новую позицию
   *
   * @param position - Позиция для добавления
   * @returns Новый Portfolio с добавленной позицией
   *
   * @throws {DuplicatePositionError} Если позиция с таким marketId уже существует
   *
   * @remarks
   * Добавляет позицию в портфель.
   * Каждый рынок может иметь только одну позицию.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000));
   * const position = Position.empty('market-123', 'YES');
   * 
   * const updated = portfolio.addPosition(position);
   * console.log(updated.positions.size); // 1
   * console.log(updated.getPosition('market-123')); // position
   * ```
   */
  public addPosition(position: Position): Portfolio {
    if (this.positions.has(position.tokenId)) {
      throw new DuplicatePositionError(position.tokenId);
    }

    const newPositions = new Map(this.positions);
    newPositions.set(position.tokenId, position);

    return new Portfolio(
      this.id,
      this.cash,
      this.reservedCash,
      newPositions
    );
  }

  /**
   * Обновляет существующую позицию
   *
   * @param tokenId - Идентификатор токена/рынка
   * @param updatedPosition - Обновлённая позиция
   * @returns Новый Portfolio с обновлённой позицией
   *
   * @throws {PositionNotFoundError} Если позиция не найдена
   *
   * @remarks
   * Заменяет существующую позицию новой версией.
   * Используется для обновления после добавления/удаления лотов.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000))
   *   .addPosition(position);
   * 
   * // Обновляем позицию (добавляем лот)
   * const newPosition = position.addLot(lot);
   * const updated = portfolio.updatePosition('market-123', newPosition);
   * ```
   */
  public updatePosition(tokenId: string, updatedPosition: Position): Portfolio {
    if (!this.positions.has(tokenId)) {
      throw new PositionNotFoundError(tokenId);
    }

    const newPositions = new Map(this.positions);
    
    // Если позиция пустая - удаляем её
    if (updatedPosition.isEmpty()) {
      newPositions.delete(tokenId);
    } else {
      newPositions.set(tokenId, updatedPosition);
    }

    return new Portfolio(
      this.id,
      this.cash,
      this.reservedCash,
      newPositions
    );
  }

  /**
   * Удаляет позицию из портфеля
   *
   * @param tokenId - Идентификатор токена/рынка
   * @returns Новый Portfolio без указанной позиции
   *
   * @remarks
   * Удаляет позицию из портфеля.
   * Обычно используется когда позиция полностью закрыта.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000))
   *   .addPosition(position);
   * 
   * const updated = portfolio.removePosition('market-123');
   * console.log(updated.positions.size); // 0
   * ```
   */
  public removePosition(tokenId: string): Portfolio {
    const newPositions = new Map(this.positions);
    newPositions.delete(tokenId);

    return new Portfolio(
      this.id,
      this.cash,
      this.reservedCash,
      newPositions
    );
  }

  /**
   * Получает позицию по идентификатору
   *
   * @param tokenId - Идентификатор токена/рынка
   * @returns Position или undefined
   *
   * @example
   * ```typescript
   * const position = portfolio.getPosition('market-123');
   * if (position) {
   *   console.log(position.totalQuantity.value);
   * }
   * ```
   */
  public getPosition(tokenId: string): Position | undefined {
    return this.positions.get(tokenId);
  }

  /**
   * Проверяет наличие позиции
   *
   * @param tokenId - Идентификатор токена/рынка
   * @returns True если позиция существует
   *
   * @example
   * ```typescript
   * if (portfolio.hasPosition('market-123')) {
   *   console.log('Position exists');
   * }
   * ```
   */
  public hasPosition(tokenId: string): boolean {
    return this.positions.has(tokenId);
  }

  /**
   * Вычисляет общую стоимость портфеля
   *
   * @param marketPrices - Map текущих рыночных цен (marketId -> Price)
   * @returns Общая стоимость портфеля
   *
   * @remarks
   * Общая стоимость = cash + sum(position values)
   * Position value = quantity * current price
   * 
   * Алгоритм:
   * 1. Начинаем с cash (доступный + резервированный)
   * 2. Для каждой позиции:
   *    - Получаем текущую цену из marketPrices
   *    - Вычисляем value = quantity * price
   *    - Добавляем к общей стоимости
   * 3. Возвращаем итоговую сумму
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromUSDC(1000))
   *   .addPosition(position); // 10 shares @ entry 0.60
   * 
   * const marketPrices = new Map([
   *   ['market-123', Price.fromNumber(0.70)]
   * ]);
   * 
   * const totalValue = portfolio.getTotalValue(marketPrices);
   * // cash (1000) + position value (10 * 0.70 = 7)
   * console.log(totalValue.amount); // 1007
   * ```
   */
  public getTotalValue(marketPrices: Map<string, Price>): Money {
    let totalValue = this.cash.amount;

    for (const [tokenId, position] of this.positions.entries()) {
      const currentPrice = marketPrices.get(tokenId);
      if (currentPrice && position.totalQuantity.isPositive()) {
        const positionValue = position.totalQuantity.value * currentPrice.value;
        totalValue += positionValue;
      }
    }

    return Money.fromUSDC(totalValue);
  }

  /**
   * Вычисляет общий нереализованный P&L всех позиций
   *
   * @param marketPrices - Map текущих рыночных цен (marketId -> Price)
   * @returns Общий нереализованный P&L
   *
   * @remarks
   * Суммирует нереализованный P&L всех позиций.
   * Каждая позиция вычисляет P&L на основе своего average entry price.
   *
   * @example
   * ```typescript
   * const marketPrices = new Map([
   *   ['market-123', Price.fromNumber(0.70)]
   * ]);
   * 
   * const totalPnL = portfolio.getTotalUnrealizedPnL(marketPrices);
   * console.log(totalPnL.amount); // Sum of all position P&Ls
   * ```
   */
  public getTotalUnrealizedPnL(marketPrices: Map<string, Price>): Money {
    let totalPnL = 0;

    for (const [tokenId, position] of this.positions.entries()) {
      const currentPrice = marketPrices.get(tokenId);
      if (currentPrice) {
        const pnl = position.calculateUnrealizedPnL(currentPrice);
        totalPnL += pnl.amount;
      }
    }

    return Money.fromUSDC(totalPnL);
  }

  /**
   * Получает количество позиций
   *
   * @returns Количество позиций в портфеле
   *
   * @example
   * ```typescript
   * console.log(portfolio.getPositionCount()); // 3
   * ```
   */
  public getPositionCount(): number {
    return this.positions.size;
  }

  /**
   * Получает все позиции как массив
   *
   * @returns Массив всех позиций
   *
   * @example
   * ```typescript
   * const positions = portfolio.getAllPositions();
   * positions.forEach(pos => {
   *   console.log(pos.toString());
   * });
   * ```
   */
  public getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Проверяет, пуст ли портфель
   *
   * @returns True если нет позиций и кэш равен нулю
   *
   * @example
   * ```typescript
   * const empty = Portfolio.create('p1', Money.zero());
   * console.log(empty.isEmpty()); // true
   * ```
   */
  public isEmpty(): boolean {
    return this.positions.size === 0 && this.cash.isZero();
  }

  /**
   * Конвертирует в строковое представление
   *
   * @returns Строковое представление портфеля
   *
   * @example
   * ```typescript
   * console.log(portfolio.toString());
   * // "Portfolio[p1]: $1000.00 cash ($200.00 reserved), 3 positions"
   * ```
   */
  public toString(): string {
    return `Portfolio[${this.id}]: ${this.cash.toString()} (${this.reservedCash.toString()} reserved), ${this.positions.size} positions`;
  }

  /**
   * Конвертирует в объект
   *
   * @returns Объектное представление портфеля
   *
   * @example
   * ```typescript
   * const obj = portfolio.toObject();
   * console.log(JSON.stringify(obj, null, 2));
   * ```
   */
  public toObject() {
    return {
      id: this.id,
      cash: this.cash.amount,
      reservedCash: this.reservedCash.amount,
      availableCash: this.availableCash.amount,
      positionCount: this.positions.size,
      positions: Array.from(this.positions.entries()).map(([tokenId, position]) => ({
        tokenId,
        side: position.side,
        quantity: position.totalQuantity.value,
        averagePrice: position.averageEntryPrice.value,
        lotCount: position.getLotCount(),
      })),
    };
  }
}

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
 * Design Patterns:
 * - Result pattern для всех fallible операций (create, reserveCash, releaseCash, updateCash, addPosition, updatePosition)
 * - Private constructor + static factory method (create)
 * - Immutability: все операции возвращают новый Portfolio
 *
 * @example
 * ```typescript
 * // Создание портфеля (возвращает Result)
 * const result = Portfolio.create('portfolio-1', Money.fromUSDC(1000));
 * if (!result.ok) {
 *   console.error('Failed to create portfolio:', result.error.message);
 *   return;
 * }
 *
 * const portfolio = result.value;
 *
 * // Резервируем средства для BUY ордера (возвращает Result)
 * const reserveResult = portfolio.reserveCash(Money.fromUSDC(100));
 * if (!reserveResult.ok) {
 *   console.error('Insufficient funds:', reserveResult.error.message);
 *   return;
 * }
 *
 * const updated = reserveResult.value;
 * console.log(updated.availableCash.amount); // 900
 * console.log(updated.reservedCash.amount); // 100
 *
 * // Добавляем позицию (возвращает Result)
 * const addResult = updated.addPosition(position);
 * if (!addResult.ok) {
 *   console.error('Failed to add position:', addResult.error.message);
 *   return;
 * }
 *
 * const withPosition = addResult.value;
 *
 * // Вычисляем общую стоимость
 * const totalValue = withPosition.getTotalValue(marketPrices);
 * console.log(totalValue.amount); // cash + position values
 * ```
 */
import { Money } from '@polymarket/value-objects';
import { Position } from './Position.js';
import { Price } from '@polymarket/value-objects';
import { InsufficientFundsError, TradingError, PortfolioValidationError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Ошибка дублирующейся позиции
 *
 * @remarks
 * Выбрасывается при попытке добавить позицию с уже существующим marketId.
 */
export class DuplicatePositionError extends TradingError {
  public readonly severity = 'low' as const;

  constructor(public readonly marketId: string) {
    super(
      `Position already exists for market: ${marketId}`,
      { code: 'DUPLICATE_POSITION', context: { marketId } }
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
  public readonly severity = 'low' as const;

  constructor(public readonly marketId: string) {
    super(
      `Position not found for market: ${marketId}`,
      { code: 'POSITION_NOT_FOUND', context: { marketId } }
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
   * @returns Result с новым Portfolio или ошибкой
   *
   * @remarks
   * Используется для инициализации нового портфеля.
   * Начинает с нулевым резервом и пустым списком позиций.
   *
   * Валидация:
   * - id должен быть непустой строкой
   * - initialCash не может быть отрицательным
   *
   * @example
   * ```typescript
   * const result = Portfolio.create(
   *   'portfolio-1',
   *   Money.fromUSDC(10000)
   * );
   * if (result.ok) {
   *   console.log(result.value.cash.amount); // 10000
   *   console.log(result.value.reservedCash.amount); // 0
   *   console.log(result.value.positions.size); // 0
   * } else {
   *   console.error('Failed to create portfolio:', result.error.message);
   * }
   * ```
   */
  public static create(
    id: string,
    initialCash: Money
  ): Result<Portfolio, PortfolioValidationError> {
    // Валидация ID
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return Err(
        new PortfolioValidationError(
          'Portfolio id must be a non-empty string',
          { context: { field: 'id', value: id } }
        )
      );
    }

    // Валидация initialCash
    if (initialCash.getAmount() < 0) {
      return Err(
        new PortfolioValidationError(
          'Initial cash cannot be negative',
          { context: { field: 'initialCash', portfolioId: id, value: initialCash.getAmount() } }
        )
      );
    }

    return Ok(
      new Portfolio(
        id,
        initialCash,
        Money.zero(),
        new Map<string, Position>()
      )
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
   * Математически гарантировано что cash >= reservedCash (инвариант класса),
   * поэтому subtract не может упасть.
   *
   * @example
   * ```typescript
   * const portfolio = Portfolio.create('p1', Money.fromValue(1000)).value;
   * const reserved = portfolio.reserveCash(Money.fromValue(200)).value;
   *
   * const available = reserved.availableCash;
   * console.log(available.getAmount()); // 800
   * ```
   */
  public get availableCash(): Money {
    const result = this.cash.subtract(this.reservedCash);
    if (!result.ok) {
      // Это не должно случиться никогда (инвариант класса)
      throw new Error(`Invariant violation: cash < reservedCash`);
    }
    return result.value;
  }

  /**
   * Резервирует денежные средства
   *
   * @param amount - Сумма для резервирования
   * @returns Result с новым Portfolio или ошибкой
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
   * const result = Portfolio.create('p1', Money.fromUSDC(1000));
   * if (!result.ok) return;
   *
   * // Резервируем для BUY ордера на 100 USDC
   * const reserveResult = result.value.reserveCash(Money.fromUSDC(100));
   * if (reserveResult.ok) {
   *   console.log(reserveResult.value.reservedCash.amount); // 100
   *   console.log(reserveResult.value.availableCash.amount); // 900
   * } else {
   *   console.error('Insufficient funds:', reserveResult.error.message);
   * }
   * ```
   */
  public reserveCash(amount: Money): Result<Portfolio, InsufficientFundsError> {
    const available = this.availableCash;

    const compareResult = available.lessThan(amount);
    if (!compareResult.ok) {
      // Currency mismatch - should not happen with USDC
      throw new Error(`Currency comparison failed: ${compareResult.error.message}`);
    }

    if (compareResult.value) {
      return Err(
        new InsufficientFundsError(amount.getAmount(), available.getAmount())
      );
    }

    const addResult = this.reservedCash.add(amount);
    if (!addResult.ok) {
      // Конвертируем ArithmeticError в ValidationError
      return Err(
        new InsufficientFundsError(amount.getAmount(), available.getAmount())
      );
    }

    return Ok(
      new Portfolio(
        this.id,
        this.cash,
        addResult.value,
        this.positions
      )
    );
  }

  /**
   * Освобождает резервированные средства
   *
   * @param amount - Сумма для освобождения
   * @returns Result с новым Portfolio или ошибкой
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
   * const result = Portfolio.create('p1', Money.fromUSDC(1000));
   * if (!result.ok) return;
   *
   * const reserveResult = result.value.reserveCash(Money.fromUSDC(100));
   * if (!reserveResult.ok) return;
   *
   * // Отменяем ордер - освобождаем средства
   * const releaseResult = reserveResult.value.releaseCash(Money.fromUSDC(100));
   * if (releaseResult.ok) {
   *   console.log(releaseResult.value.reservedCash.amount); // 0
   *   console.log(releaseResult.value.availableCash.amount); // 1000
   * }
   * ```
   */
  public releaseCash(amount: Money): Result<Portfolio, PortfolioValidationError> {
    const compareResult = this.reservedCash.lessThan(amount);
    if (!compareResult.ok) {
      // Currency mismatch - should not happen with USDC
      throw new Error(`Currency comparison failed: ${compareResult.error.message}`);
    }

    if (compareResult.value) {
      return Err(
        new PortfolioValidationError(
          `Cannot release ${amount.getAmount()}: only ${this.reservedCash.getAmount()} reserved`,
          {
            context: {
              requested: amount.getAmount(),
              available: this.reservedCash.getAmount(),
              portfolioId: this.id
            }
          }
        )
      );
    }

    const subtractResult = this.reservedCash.subtract(amount);
    if (!subtractResult.ok) {
      return Err(
        new PortfolioValidationError(
          `Failed to subtract from reserved cash: ${subtractResult.error.message}`,
          {
            context: {
              requested: amount.getAmount(),
              reserved: this.reservedCash.getAmount(),
              portfolioId: this.id
            }
          }
        )
      );
    }

    return Ok(
      new Portfolio(
        this.id,
        this.cash,
        subtractResult.value,
        this.positions
      )
    );
  }

  /**
   * Добавляет или обновляет денежные средства
   *
   * @param amount - Сумма для добавления (может быть отрицательной)
   * @returns Result с новым Portfolio или ошибкой
   *
   * @remarks
   * Используется для:
   * - Пополнения счёта (положительная сумма)
   * - Списания при покупке (отрицательная сумма)
   * - Зачисления при продаже (положительная сумма)
   * - Вывода средств (отрицательная сумма)
   *
   * Валидация:
   * - Результирующий cash не может быть отрицательным
   *
   * @example
   * ```typescript
   * const result = Portfolio.create('p1', Money.fromUSDC(1000));
   * if (!result.ok) return;
   *
   * // Пополнение
   * const depositResult = result.value.updateCash(Money.fromUSDC(500));
   * if (depositResult.ok) {
   *   console.log(depositResult.value.cash.amount); // 1500
   * }
   *
   * // Списание при покупке
   * const buyResult = depositResult.value.updateCash(Money.fromUSDC(-100));
   * if (buyResult.ok) {
   *   console.log(buyResult.value.cash.amount); // 1400
   * }
   * ```
   */
  public updateCash(amount: Money): Result<Portfolio, PortfolioValidationError> {
    const amountValue = amount.getAmount();

    // Вычисляем новый cash
    const cashResult = amountValue >= 0
      ? this.cash.add(amount)
      : (() => {
          const absAmountResult = Money.fromValue(Math.abs(amountValue));
          if (!absAmountResult.ok) return absAmountResult;
          return this.cash.subtract(absAmountResult.value);
        })();

    if (!cashResult.ok) {
      return Err(
        new PortfolioValidationError(
          `Failed to update cash: ${cashResult.error.message}`,
          {
            context: {
              currentCash: this.cash.getAmount(),
              changeAmount: amountValue,
              portfolioId: this.id
            }
          }
        )
      );
    }

    const newCash = cashResult.value;

    if (newCash.getAmount() < 0) {
      return Err(
        new PortfolioValidationError(
          `Cash cannot be negative: ${newCash.getAmount()}`,
          {
            context: {
              currentCash: this.cash.getAmount(),
              changeAmount: amountValue,
              resultingCash: newCash.getAmount(),
              portfolioId: this.id
            }
          }
        )
      );
    }

    return Ok(
      new Portfolio(
        this.id,
        newCash,
        this.reservedCash,
        this.positions
      )
    );
  }

  /**
   * Добавляет новую позицию
   *
   * @param position - Позиция для добавления
   * @returns Result с новым Portfolio или ошибкой
   *
   * @remarks
   * Добавляет позицию в портфель.
   * Каждый рынок может иметь только одну позицию.
   *
   * Валидация:
   * - Позиция с таким tokenId не должна существовать
   *
   * @example
   * ```typescript
   * const result = Portfolio.create('p1', Money.fromUSDC(1000));
   * if (!result.ok) return;
   *
   * const position = Position.empty('market-123', 'YES');
   *
   * const addResult = result.value.addPosition(position);
   * if (addResult.ok) {
   *   console.log(addResult.value.positions.size); // 1
   *   console.log(addResult.value.getPosition('market-123')); // position
   * }
   * ```
   */
  public addPosition(position: Position): Result<Portfolio, DuplicatePositionError> {
    if (this.positions.has(position.tokenId)) {
      return Err(new DuplicatePositionError(position.tokenId));
    }

    const newPositions = new Map(this.positions);
    newPositions.set(position.tokenId, position);

    return Ok(
      new Portfolio(
        this.id,
        this.cash,
        this.reservedCash,
        newPositions
      )
    );
  }

  /**
   * Обновляет существующую позицию
   *
   * @param tokenId - Идентификатор токена/рынка
   * @param updatedPosition - Обновлённая позиция
   * @returns Result с новым Portfolio или ошибкой
   *
   * @remarks
   * Заменяет существующую позицию новой версией.
   * Используется для обновления после добавления/удаления лотов.
   *
   * Алгоритм:
   * - Если позиция пустая - удаляем её из Map
   * - Иначе - заменяем на обновлённую версию
   *
   * @example
   * ```typescript
   * const result = Portfolio.create('p1', Money.fromUSDC(1000));
   * if (!result.ok) return;
   *
   * const addResult = result.value.addPosition(position);
   * if (!addResult.ok) return;
   *
   * // Обновляем позицию (добавляем лот)
   * const lotResult = position.addLot(lot);
   * if (!lotResult.ok) return;
   *
   * const updateResult = addResult.value.updatePosition('market-123', lotResult.value);
   * if (updateResult.ok) {
   *   console.log('Position updated');
   * }
   * ```
   */
  public updatePosition(
    tokenId: string,
    updatedPosition: Position
  ): Result<Portfolio, PositionNotFoundError> {
    if (!this.positions.has(tokenId)) {
      return Err(new PositionNotFoundError(tokenId));
    }

    const newPositions = new Map(this.positions);

    // Если позиция пустая - удаляем её
    if (updatedPosition.isEmpty()) {
      newPositions.delete(tokenId);
    } else {
      newPositions.set(tokenId, updatedPosition);
    }

    return Ok(
      new Portfolio(
        this.id,
        this.cash,
        this.reservedCash,
        newPositions
      )
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
    let totalValue = this.cash.getAmount();

    for (const [tokenId, position] of this.positions.entries()) {
      const currentPrice = marketPrices.get(tokenId);
      if (currentPrice && position.totalQuantity.isPositive()) {
        const positionValue = position.totalQuantity.value * currentPrice.value;
        totalValue += positionValue;
      }
    }

    const result = Money.fromValue(totalValue);
    if (!result.ok) {
      throw new Error(`Failed to create Money for total value: ${result.error.message}`);
    }
    return result.value;
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
        totalPnL += pnl.getAmount();
      }
    }

    const result = Money.fromValue(totalPnL);
    if (!result.ok) {
      throw new Error(`Failed to create Money for total unrealized P&L: ${result.error.message}`);
    }
    return result.value;
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
      cash: this.cash.getAmount(),
      reservedCash: this.reservedCash.getAmount(),
      availableCash: this.availableCash.getAmount(),
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

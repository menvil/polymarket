/**
 * Portfolio — агрегат портфеля трейдера
 *
 * @remarks
 * Portfolio — aggregate root, объединяющий:
 * - **Balance** (баланс): available/reserved средства через `@polymarket/value-objects/balance`
 * - **Positions** (позиции): карта `InstrumentId → IPosition`
 * - **TokenReservations** (резервации токенов): карта `InstrumentId → Quantity` для SELL ордеров
 *
 * ### Архитектурные решения
 *
 * **1. Balance VO вместо `cash + reservedCash`:**
 * Прежний вариант хранил `cash: Money` и `reservedCash: Money` отдельно.
 * Теперь `balance: Balance` инкапсулирует оба поля и предоставляет
 * атомарные операции через `BalanceService` (reserve/unfreezeReserved/consumeReserved).
 *
 * **2. `ReadonlyMap<InstrumentId, IPosition>` вместо строковых ключей:**
 * Typed ключи предотвращают ошибки при перепутывании ID разных сущностей.
 *
 * **3. `upsertPosition(position)` вместо add/update/remove:**
 * - Если позиция открыта — добавляет/обновляет в карте.
 * - Если `position.isClosed()` — удаляет из карты (позиция закрыта, хранить не нужно).
 *
 * **4. Валюация вынесена в `getTotalValue` / `getTotalUnrealizedPnL`:**
 * Оценка рыночной стоимости требует текущих котировок — внешних данных,
 * которые не являются частью доменного состояния Portfolio.
 * Это не "presentation/analytics": risk checks, margin и liquidation
 * используют те же расчёты — но они зависят от внешних цен,
 * поэтому не встраиваются в агрегат.
 *
 * **5. Immutability:**
 * Все мутирующие методы возвращают НОВЫЙ Portfolio. Исходный не изменяется.
 *
 * **6. Методы с балансом возвращают `Result`:**
 * Операции с балансом могут завершиться ошибкой (например, недостаточно средств).
 * Возврат `Result<Portfolio, InvalidBalanceError>` делает это явным на уровне типов.
 *
 * **7. Структурная типизация для позиций (IPosition):**
 * Portfolio не зависит напрямую от конкретного класса Position.
 * Достаточно реализовать интерфейс `IPosition`. Позволяет тестировать
 * Portfolio независимо от Position package.
 *
 * **8. tokenReservations — резервации outcome-токенов для SELL ордеров:**
 * При размещении SELL ордера токены резервируются, чтобы предотвратить двойную продажу.
 * Симметрично USDC-резервациям для BUY ордеров.
 *
 * ### Жизненный цикл баланса
 * ```
 * reserveForOrder(amount)    →  available -= amount, reserved += amount
 * releaseReservation(amount) →  available += amount, reserved -= amount
 * applyDebit(amount)         →  reserved -= amount (списание из reserved)
 * applyCredit(amount)        →  available += amount (зачисление)
 * ```
 *
 * ### Жизненный цикл токенных резерваций (SELL ордера)
 * ```
 * reserveTokensForOrder(id, qty)  →  tokenReservations[id] += qty
 * releaseTokenReservation(id, qty) →  tokenReservations[id] -= qty
 * ```
 *
 * @example
 * ```typescript
 * import { Portfolio } from './Portfolio';
 * import { Balance } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 * import { asPortfolioId } from './value-objects';
 *
 * const balance = Balance.withZeroReserved(
 *   Money.of(10000, 'USDC'),
 *   accountId,
 *   venueId
 * );
 *
 * const portfolioResult = Portfolio.create({
 *   id: asPortfolioId('portfolio-abc'),
 *   accountId,
 *   balance,
 * });
 *
 * if (portfolioResult.ok) {
 *   const portfolio = portfolioResult.value;
 *   const reserveResult = portfolio.reserveForOrder(Money.of(3000, 'USDC'));
 *   if (reserveResult.ok) {
 *     const reserved = reserveResult.value;
 *     console.log(reserved.balance.available().value()); // 7000
 *     console.log(reserved.balance.reserved().value());  // 3000
 *   }
 * }
 * ```
 */

import Decimal from 'decimal.js';
import type { Price } from '@polymarket/value-objects';
import { Result, Ok, Err } from '@polymarket/result';
import type { InstrumentId, AccountId } from '@polymarket/ids';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance, BalanceService } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';
import type { PortfolioId } from './value-objects/index.js';
import { PortfolioValidationError } from '@polymarket/errors/portfolio';

/**
 * Полный контракт позиции, используемый Portfolio
 *
 * @remarks
 * Portfolio использует структурную типизацию — не зависит от конкретного
 * класса Position. Любой объект, реализующий IPosition, совместим.
 *
 * Контракт включает все поля, необходимые как для управления позицией
 * (instrumentId, isClosed), так и для оценки риска и стоимости
 * (quantity, side, averageEntryPrice, getUnrealizedPnL).
 *
 * Единый интерфейс устраняет необходимость в IValuablePosition —
 * getTotalValue / getTotalUnrealizedPnL принимают Iterable<IPosition>
 * без каких-либо cast на стороне caller.
 */
export interface IPosition {
  /** Идентификатор торгового инструмента */
  readonly instrumentId: InstrumentId;
  /** Текущее количество в позиции */
  readonly quantity: { value(): Decimal };
  /** Сторона позиции */
  readonly side: 'LONG' | 'SHORT';
  /** Средневзвешенная цена входа */
  readonly averageEntryPrice: { value(): Decimal };
  /** Проверяет, закрыта ли позиция (quantity = 0) */
  isClosed(): boolean;
  /**
   * Вычисляет unrealized P&L для заданной текущей цены
   *
   * @param currentPrice - Текущая цена инструмента (Price VO)
   * @returns Объект с методом value(): Decimal (совместим с SignedQuantity)
   */
  getUnrealizedPnL(currentPrice: Price): { value(): Decimal };
}

/**
 * Параметры создания Portfolio
 */
export interface PortfolioParams {
  /** Уникальный идентификатор портфеля */
  readonly id: PortfolioId;
  /** ID аккаунта владельца */
  readonly accountId: AccountId;
  /** Начальный баланс (available + reserved) */
  readonly balance: Balance;
  /** Начальные позиции (опционально) */
  readonly positions?: ReadonlyMap<InstrumentId, IPosition>;
  /** Резервации outcome-токенов для открытых SELL ордеров (опционально) */
  readonly tokenReservations?: ReadonlyMap<InstrumentId, Decimal>;
}

/**
 * Portfolio — immutable aggregate root
 *
 * @remarks
 * Все поля readonly. Мутирующие операции возвращают НОВЫЙ Portfolio.
 */
export class Portfolio {
  /** Уникальный идентификатор портфеля */
  public readonly id: PortfolioId;

  /** ID аккаунта владельца */
  public readonly accountId: AccountId;

  /** Баланс: available + reserved средства */
  public readonly balance: Balance;

  /** Карта открытых позиций: InstrumentId → IPosition */
  public readonly positions: ReadonlyMap<InstrumentId, IPosition>;

  /**
   * Карта зарезервированных outcome-токенов для открытых SELL ордеров.
   *
   * @remarks
   * Ключ — InstrumentId (тот же, что в positions).
   * Значение — суммарный зарезервированный объём (Decimal, >= 0).
   *
   * Инвариант: reservedQty <= position.quantity (нельзя зарезервировать больше, чем есть).
   * Проверяется при вызове `reserveTokensForOrder`.
   */
  public readonly tokenReservations: ReadonlyMap<InstrumentId, Decimal>;

  /**
   * Приватный конструктор — используйте Portfolio.create()
   */
  private constructor(params: PortfolioParams) {
    this.id = params.id;
    this.accountId = params.accountId;
    this.balance = params.balance;
    this.positions = params.positions
      ? new Map(params.positions)
      : new Map<InstrumentId, IPosition>();
    this.tokenReservations = params.tokenReservations
      ? new Map(params.tokenReservations)
      : new Map<InstrumentId, Decimal>();
  }

  /**
   * Создаёт Portfolio с валидацией
   *
   * @param params - Параметры создания портфеля
   * @returns Result<Portfolio, PortfolioValidationError>
   *
   * @remarks
   * Проверяет:
   * - id не пустой
   * - accountId задан
   * - balance задан
   *
   * @example
   * ```typescript
   * const result = Portfolio.create({
   *   id: asPortfolioId('portfolio-abc'),
   *   accountId,
   *   balance: Balance.withZeroReserved(Money.of(10000, 'USDC'), accountId, venueId),
   * });
   * if (result.ok) {
   *   const portfolio = result.value;
   * }
   * ```
   */
  public static create(params: PortfolioParams): Result<Portfolio, PortfolioValidationError> {
    if (!params.id) {
      return Err(
        new PortfolioValidationError('Portfolio ID is required', {
          context: { field: 'id' },
        })
      );
    }

    if (!params.accountId) {
      return Err(
        new PortfolioValidationError('Account ID is required', {
          context: { field: 'accountId', portfolioId: params.id },
        })
      );
    }

    if (!params.balance) {
      return Err(
        new PortfolioValidationError('Balance is required', {
          context: { field: 'balance', portfolioId: params.id },
        })
      );
    }

    return Ok(new Portfolio(params));
  }

  // ────────────────────────────────────────────────────────────
  // Операции с балансом
  // ────────────────────────────────────────────────────────────

  /**
   * Резервирует средства для ордера
   *
   * @param amount - Сумма для резервирования
   * @returns Result с новым Portfolio или InvalidBalanceError
   *
   * @remarks
   * Переводит amount из available → reserved.
   * Возвращает Err если available < amount (INSUFFICIENT_FUNDS).
   *
   * @example
   * ```typescript
   * const result = portfolio.reserveForOrder(Money.of(3000, 'USDC'));
   * if (result.ok) {
   *   console.log(result.value.balance.available().value()); // available - 3000
   *   console.log(result.value.balance.reserved().value());  // reserved + 3000
   * }
   * ```
   */
  public reserveForOrder(amount: Money): Result<Portfolio, InvalidBalanceError> {
    const balanceResult = BalanceService.reserve(this.balance, amount);
    if (!balanceResult.ok) {
      return Err(balanceResult.error);
    }
    return Ok(this.withBalance(balanceResult.value));
  }

  /**
   * Освобождает зарезервированные средства (отмена ордера)
   *
   * @param amount - Сумма для разморозки
   * @returns Result с новым Portfolio или InvalidBalanceError
   *
   * @remarks
   * Переводит amount из reserved → available.
   * Возвращает Err если reserved < amount (INSUFFICIENT_RESERVED).
   *
   * @example
   * ```typescript
   * const result = portfolio.releaseReservation(Money.of(1000, 'USDC'));
   * if (result.ok) {
   *   console.log(result.value.balance.available().value()); // available + 1000
   *   console.log(result.value.balance.reserved().value());  // reserved - 1000
   * }
   * ```
   */
  public releaseReservation(amount: Money): Result<Portfolio, InvalidBalanceError> {
    const balanceResult = BalanceService.unfreezeReserved(this.balance, amount);
    if (!balanceResult.ok) {
      return Err(balanceResult.error);
    }
    return Ok(this.withBalance(balanceResult.value));
  }

  /**
   * Списывает средства из reserved (исполнение ордера)
   *
   * @param amount - Сумма для списания
   * @returns Result с новым Portfolio или InvalidBalanceError
   *
   * @remarks
   * Уменьшает reserved на amount. available не изменяется.
   * Используется при исполнении ордера (средства списаны из зарезервированных).
   * Возвращает Err если reserved < amount (INSUFFICIENT_RESERVED).
   *
   * @example
   * ```typescript
   * const result = portfolio.applyDebit(Money.of(2000, 'USDC'));
   * if (result.ok) {
   *   console.log(result.value.balance.reserved().value()); // reserved - 2000
   * }
   * ```
   */
  public applyDebit(amount: Money): Result<Portfolio, InvalidBalanceError> {
    const balanceResult = BalanceService.consumeReserved(this.balance, amount);
    if (!balanceResult.ok) {
      return Err(balanceResult.error);
    }
    return Ok(this.withBalance(balanceResult.value));
  }

  /**
   * Зачисляет средства в available (поступление)
   *
   * @param amount - Сумма для зачисления
   * @returns Result с новым Portfolio или InvalidBalanceError
   *
   * @remarks
   * Увеличивает available на amount. reserved не изменяется.
   * Используется при получении средств (profit, возврат, пополнение).
   *
   * @example
   * ```typescript
   * const result = portfolio.applyCredit(Money.of(500, 'USDC'));
   * if (result.ok) {
   *   console.log(result.value.balance.available().value()); // available + 500
   * }
   * ```
   */
  public applyCredit(amount: Money): Result<Portfolio, InvalidBalanceError> {
    const balanceResult = BalanceService.credit(this.balance, amount);
    if (!balanceResult.ok) {
      return Err(balanceResult.error);
    }
    return Ok(this.withBalance(balanceResult.value));
  }

  /**
   * Списывает средства напрямую из available (без резервации).
   *
   * @param amount - Сумма для списания
   * @returns Result с новым Portfolio или InvalidBalanceError
   *
   * @remarks
   * Используется для fills по terminal/не найденным ордерам, когда резервация
   * уже была снята (CancelOrderUseCase). Биржевое событие — источник истины.
   *
   * Если available < amount — списывает до нуля (best-effort).
   * REST-синхронизация портфолио скорректирует баланс в течение ~15 секунд.
   *
   * ```
   * applyDirectDebit(amount) → available = max(0, available - amount)
   * ```
   *
   * @example
   * ```typescript
   * // fill на отменённый ордер: резервация уже снята
   * const result = portfolio.applyDirectDebit(Money.of(notional, 'USDC'));
   * ```
   */
  public applyDirectDebit(amount: Money): Result<Portfolio, InvalidBalanceError> {
    const currentAvailable = this.balance.available().value();
    const newAvailableValue = Decimal.max(new Decimal(0), currentAvailable.minus(amount.value()));
    const newAvailable = Money.of(newAvailableValue, 'USDC');
    const balanceResult = BalanceService.updateAvailable(this.balance, newAvailable);
    if (!balanceResult.ok) {
      return Err(balanceResult.error);
    }
    return Ok(this.withBalance(balanceResult.value));
  }

  // ────────────────────────────────────────────────────────────
  // Операции с позициями
  // ────────────────────────────────────────────────────────────

  /**
   * Добавляет или обновляет позицию в портфеле
   *
   * @param position - Позиция для upsert
   * @returns Новый Portfolio
   *
   * @remarks
   * Алгоритм:
   * - Если `position.isClosed()` — удаляет позицию из карты (закрытые не храним).
   * - Иначе — добавляет/обновляет по ключу `position.instrumentId`.
   *
   * Immutable: возвращает новый Portfolio, исходный не изменяется.
   *
   * @example
   * ```typescript
   * const updated = portfolio.upsertPosition(newPosition);
   * // Открытая позиция:
   * console.log(updated.hasPosition(instrumentId)); // true
   *
   * // Закрытая позиция — удаляется:
   * const withClosed = portfolio.upsertPosition(closedPosition);
   * console.log(withClosed.hasPosition(closedPosition.instrumentId)); // false
   * ```
   */
  public upsertPosition(position: IPosition): Portfolio {
    const newPositions = new Map<InstrumentId, IPosition>(this.positions);

    if (position.isClosed()) {
      newPositions.delete(position.instrumentId);
    } else {
      newPositions.set(position.instrumentId, position);
    }

    return new Portfolio({
      id: this.id,
      accountId: this.accountId,
      balance: this.balance,
      positions: newPositions,
      tokenReservations: this.tokenReservations,
    });
  }

  /**
   * Возвращает позицию по instrumentId
   *
   * @param instrumentId - Идентификатор инструмента
   * @returns IPosition или undefined если позиции нет
   *
   * @example
   * ```typescript
   * const position = portfolio.getPosition(instrumentId);
   * if (position) {
   *   console.log(position.instrumentId);
   * }
   * ```
   */
  public getPosition(instrumentId: InstrumentId): IPosition | undefined {
    return this.positions.get(instrumentId);
  }

  /**
   * Проверяет наличие открытой позиции по instrumentId
   *
   * @param instrumentId - Идентификатор инструмента
   * @returns true если позиция существует в карте
   *
   * @example
   * ```typescript
   * if (portfolio.hasPosition(instrumentId)) {
   *   const position = portfolio.getPosition(instrumentId)!;
   * }
   * ```
   */
  public hasPosition(instrumentId: InstrumentId): boolean {
    return this.positions.has(instrumentId);
  }

  /**
   * Возвращает итератор по всем открытым позициям
   *
   * @returns IterableIterator<IPosition> — без аллокации массива
   *
   * @remarks
   * Предпочтительнее `Array.from()` в hot-path коде.
   * Для конвертации в массив: `Array.from(portfolio.getPositions())`.
   *
   * @example
   * ```typescript
   * for (const position of portfolio.getPositions()) {
   *   console.log(position.instrumentId);
   * }
   * ```
   */
  public getPositions(): IterableIterator<IPosition> {
    return this.positions.values();
  }

  /**
   * Возвращает количество открытых позиций
   *
   * @returns Число позиций в карте
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
   * Проверяет, пуст ли портфель (нет позиций и нулевой баланс)
   *
   * @returns true если нет позиций И баланс равен нулю
   *
   * @example
   * ```typescript
   * const empty = portfolio.isEmpty(); // true если нет позиций и баланс = 0
   * ```
   */
  public isEmpty(): boolean {
    return this.positions.size === 0 && this.balance.isZero();
  }

  /**
   * Строковое представление портфеля
   *
   * @returns Строка вида `Portfolio[id]: balance=X CURRENCY positions=N`
   *
   * @example
   * ```typescript
   * console.log(portfolio.toString());
   * // Portfolio[portfolio-abc]: balance=10000 USDC positions=2
   * ```
   */
  public toString(): string {
    return `Portfolio[${this.id}]: balance=${this.balance.total().value().toNumber()} ${this.balance.currency()} positions=${this.positions.size}`;
  }

  // ────────────────────────────────────────────────────────────
  // Операции с токенными резервациями (SELL ордера)
  // ────────────────────────────────────────────────────────────

  /**
   * Возвращает доступное количество токенов для SELL (с учётом резерваций).
   *
   * @param instrumentId - Идентификатор инструмента
   * @returns Decimal — позиция минус зарезервированное (>= 0)
   *
   * @remarks
   * Если позиции нет — возвращает Decimal(0).
   * Если reservedQty > positionQty (инвариант нарушен) — возвращает Decimal(0).
   *
   * @example
   * ```typescript
   * const available = portfolio.availableTokenQuantity(instrumentId);
   * console.log(available.toNumber()); // 50 при позиции 100 и резервации 50
   * ```
   */
  public availableTokenQuantity(instrumentId: InstrumentId): Decimal {
    const position = this.positions.get(instrumentId);
    if (!position) return new Decimal(0);

    const posQty = position.quantity.value();
    const reserved = this.tokenReservations.get(instrumentId) ?? new Decimal(0);
    const available = posQty.minus(reserved);
    return available.isNegative() ? new Decimal(0) : available;
  }

  /**
   * Резервирует outcome-токены для нового SELL ордера.
   *
   * @param instrumentId - Идентификатор инструмента
   * @param qty - Количество токенов для резервирования (Decimal)
   * @returns Result<Portfolio, InvalidBalanceError>
   *
   * @remarks
   * Проверяет: `availableTokenQuantity(instrumentId) >= qty`.
   * При недостатке — возвращает Err(INSUFFICIENT_FUNDS).
   * Иначе добавляет qty к текущей резервации инструмента.
   *
   * @example
   * ```typescript
   * const result = portfolio.reserveTokensForOrder(instrumentId, new Decimal(50));
   * if (result.ok) {
   *   console.log(result.value.availableTokenQuantity(instrumentId).toNumber()); // position - 50
   * }
   * ```
   */
  public reserveTokensForOrder(
    instrumentId: InstrumentId,
    qty: Decimal,
  ): Result<Portfolio, InvalidBalanceError> {
    if (qty.lte(0)) {
      return Err(
        new InvalidBalanceError(
          `reserveTokensForOrder: qty must be positive, got ${qty.toString()}`,
          { context: { instrumentId: String(instrumentId), qty: qty.toString() } },
        ),
      );
    }
    const available = this.availableTokenQuantity(instrumentId);
    if (available.lt(qty)) {
      return Err(
        new InvalidBalanceError(
          `Insufficient token balance for SELL: available ${available.toFixed(4)}, required ${qty.toFixed(4)}`,
          {
            context: {
              instrumentId: String(instrumentId),
              available: available.toString(),
              required: qty.toString(),
            },
          },
        ),
      );
    }

    const current = this.tokenReservations.get(instrumentId) ?? new Decimal(0);
    const newMap = new Map<InstrumentId, Decimal>(this.tokenReservations);
    newMap.set(instrumentId, current.plus(qty));
    return Ok(this.withTokenReservations(newMap));
  }

  /**
   * Снимает токенную резервацию (при исполнении или отмене SELL ордера).
   *
   * @param instrumentId - Идентификатор инструмента
   * @param qty - Количество токенов для освобождения (Decimal)
   * @returns Result<Portfolio, InvalidBalanceError>
   *
   * @remarks
   * Уменьшает существующую резервацию на qty.
   * Возвращает Err если резервация < qty (INSUFFICIENT_RESERVED).
   * Если после освобождения резервация = 0, удаляет запись из Map.
   *
   * @example
   * ```typescript
   * const result = portfolio.releaseTokenReservation(instrumentId, new Decimal(25));
   * if (result.ok) {
   *   console.log(result.value.tokenReservations.get(instrumentId)?.toNumber()); // было 50, стало 25
   * }
   * ```
   */
  public releaseTokenReservation(
    instrumentId: InstrumentId,
    qty: Decimal,
  ): Result<Portfolio, InvalidBalanceError> {
    if (qty.lte(0)) {
      return Err(
        new InvalidBalanceError(
          `releaseTokenReservation: qty must be positive, got ${qty.toString()}`,
          { context: { instrumentId: String(instrumentId), qty: qty.toString() } },
        ),
      );
    }
    const current = this.tokenReservations.get(instrumentId) ?? new Decimal(0);
    if (current.lt(qty)) {
      return Err(
        new InvalidBalanceError(
          `Cannot release token reservation: reserved ${current.toFixed(4)}, requested ${qty.toFixed(4)}`,
          {
            context: {
              instrumentId: String(instrumentId),
              reserved: current.toString(),
              requested: qty.toString(),
            },
          },
        ),
      );
    }

    const newMap = new Map<InstrumentId, Decimal>(this.tokenReservations);
    const newReserved = current.minus(qty);
    if (newReserved.isZero()) {
      newMap.delete(instrumentId);
    } else {
      newMap.set(instrumentId, newReserved);
    }
    return Ok(this.withTokenReservations(newMap));
  }

  // ────────────────────────────────────────────────────────────
  // Приватные хелперы
  // ────────────────────────────────────────────────────────────

  /**
   * Создаёт копию Portfolio с новым balance
   *
   * @param balance - Новый баланс
   * @returns Новый Portfolio
   */
  private withBalance(balance: Balance): Portfolio {
    return new Portfolio({
      id: this.id,
      accountId: this.accountId,
      balance,
      positions: this.positions,
      tokenReservations: this.tokenReservations,
    });
  }

  /**
   * Создаёт копию Portfolio с новой картой токенных резерваций
   *
   * @param tokenReservations - Новая карта резерваций
   * @returns Новый Portfolio
   */
  private withTokenReservations(tokenReservations: ReadonlyMap<InstrumentId, Decimal>): Portfolio {
    return new Portfolio({
      id: this.id,
      accountId: this.accountId,
      balance: this.balance,
      positions: this.positions,
      tokenReservations,
    });
  }
}

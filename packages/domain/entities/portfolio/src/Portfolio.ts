/**
 * Portfolio — агрегат портфеля трейдера
 *
 * @remarks
 * Portfolio — aggregate root, объединяющий:
 * - **Balance** (баланс): available/reserved средства через `@polymarket/value-objects/balance`
 * - **Positions** (позиции): карта `InstrumentId → IPosition`
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
 * **4. Валюация вынесена в `PortfolioValuationService`:**
 * `getTotalValue` и `getTotalUnrealizedPnL` — presentation/analytics,
 * не относятся к domain aggregate.
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
 * ### Жизненный цикл баланса
 * ```
 * reserveForOrder(amount)    →  available -= amount, reserved += amount
 * releaseReservation(amount) →  available += amount, reserved -= amount
 * applyDebit(amount)         →  reserved -= amount (списание из reserved)
 * applyCredit(amount)        →  available += amount (зачисление)
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

import { Result, Ok, Err } from '@polymarket/result';
import type { InstrumentId, AccountId } from '@polymarket/ids';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance, BalanceService } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';
import type { PortfolioId } from './value-objects/index.js';
import { PortfolioValidationError } from '@polymarket/errors/portfolio';

/**
 * Минимальный интерфейс позиции, необходимый Portfolio
 *
 * @remarks
 * Portfolio использует структурную типизацию — не зависит от конкретного
 * класса Position. Любой объект, реализующий IPosition, совместим.
 *
 * Это разделяет Portfolio и Position packages: Portfolio не нужна
 * скомпилированная Position для сборки.
 */
export interface IPosition {
  /** Идентификатор торгового инструмента */
  readonly instrumentId: InstrumentId;
  /** Проверяет, закрыта ли позиция (quantity = 0) */
  isClosed(): boolean;
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
   * Приватный конструктор — используйте Portfolio.create()
   */
  private constructor(params: PortfolioParams) {
    this.id = params.id;
    this.accountId = params.accountId;
    this.balance = params.balance;
    this.positions = params.positions ?? new Map<InstrumentId, IPosition>();
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
    const newAvailable = Money.of(
      this.balance.available().value().plus(amount.value()),
      this.balance.currency()
    );
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
   * Возвращает все открытые позиции
   *
   * @returns Массив позиций (иммутабельный snapshot)
   *
   * @example
   * ```typescript
   * const allPositions = portfolio.getAllPositions();
   * allPositions.forEach(pos => console.log(pos.instrumentId));
   * ```
   */
  public getAllPositions(): readonly IPosition[] {
    return Array.from(this.positions.values());
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
    });
  }
}

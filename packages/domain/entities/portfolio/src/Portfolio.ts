/**
 * Portfolio — агрегат портфеля трейдера
 *
 * @remarks
 * Portfolio — aggregate root, объединяющий:
 * - **Balance** (баланс): available/reserved средства через `@polymarket/value-objects/balance`
 * - **Positions** (позиции): карта `InstrumentId → Position`
 * - **TokenReservations** (резервации токенов): карта `InstrumentId → Quantity` для SELL ордеров
 *
 * ### Архитектурные решения
 *
 * **1. Balance VO вместо `cash + reservedCash`:**
 * Прежний вариант хранил `cash: Money` и `reservedCash: Money` отдельно.
 * Теперь `balance: Balance` инкапсулирует оба поля и предоставляет
 * атомарные операции через `BalanceService` (reserve/unfreezeReserved/consumeReserved).
 *
 * **2. `ReadonlyMap<InstrumentId, Position>` вместо строковых ключей:**
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
 * **7. Позиция — канонический `Position`, без промежуточного интерфейса:**
 * Раньше здесь жил `IPosition` — структурный контракт, позволявший подставить
 * любую реализацию. Подставлять оказалось нечего: единственным классом,
 * объявлявшим `implements IPosition`, был вырожденный `SimplePosition` из
 * этого же пакета, а `Position` совместимость держал случайно, без `implements`.
 *
 * Хуже того, интерфейс мешал: `PortfolioService` — единственный код, который
 * реально работал с позицией, — был вынужден писать `instanceof Position`,
 * потому что `IPosition` не выставлял лоты.
 *
 * Поэтому Portfolio зависит от `@polymarket/position` напрямую. Цикла нет:
 * `position` от portfolio не зависит. Заодно ушло ослабление типов —
 * `Pick<Quantity, 'value'>` заменён настоящими `Quantity`/`OutcomePrice`.
 *
 * Вернуть интерфейс стоит только если появится реальная граница подмены;
 * принцип «у сущности должен быть интерфейс» сам по себе такой границей не
 * является.
 *
 * **8. tokenBalances — токены по инструментам, доступные и зарезервированные:**
 * При размещении SELL ордера токены резервируются, чтобы предотвратить двойную
 * продажу. Симметрично USDC-резервациям для BUY ордеров.
 *
 * Хранится обе части, а не одна: раньше «доступное» ВЫЧИСЛЯЛОСЬ как
 * `position.quantity − reserved` и при отрицательном результате молча
 * зажималось в ноль — то есть нарушенный инвариант не просто не ловился, а
 * маскировался.
 *
 * ### Инвариант агрегата
 * ```
 * Position.quantity == TokenBalance.available + TokenBalance.reserved
 * ```
 *
 * Проверяется в единственной точке сборки состояния — и в мутаторах, и в
 * {@link Portfolio.create}. Второе существенно: иначе оставался бы публичный
 * вход, через который агрегат собирается сразу несогласованным.
 *
 * ### Жизненный цикл баланса
 * ```
 * reserveForOrder(amount)    →  available -= amount, reserved += amount
 * releaseReservation(amount) →  available += amount, reserved -= amount
 * applyDebit(amount)         →  reserved -= amount (списание из reserved)
 * applyCredit(amount)        →  available += amount (зачисление)
 * ```
 *
 * ### Жизненный цикл токенов (SELL ордера)
 * ```
 * reserveTokens(id, qty)  →  available -= qty, reserved += qty
 * releaseTokens(id, qty)  →  reserved -= qty, available += qty
 * ```
 *
 * Резервация — перекладывание, а не расход: количество позиции при ней не
 * меняется, и инвариант сохраняется.
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

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { Quantity } from '@polymarket/value-objects';
import { Result, Ok, Err } from '@polymarket/result';
import type { InstrumentId, AccountId } from '@polymarket/ids';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance, BalanceService } from '@polymarket/value-objects/balance';
import type { Fill } from '@polymarket/fill';
import { Position, PositionLot } from '@polymarket/position';
import {
  accountIdEquals,
  accountIdToString,
  assetIdToInstrumentId,
  assetIdToString,
  type PositionId,
} from '@polymarket/ids';
import { TokenBalance } from '@polymarket/value-objects/token-balance';
import { Money } from '@polymarket/value-objects/money';
import type { PortfolioId } from './value-objects/index.js';
import { PortfolioValidationError, PortfolioOperationError } from '@polymarket/errors/portfolio';

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
  readonly positions?: ReadonlyMap<InstrumentId, Position>;
  /** Резервации outcome-токенов для открытых SELL ордеров (опционально) */
  readonly tokenBalances?: ReadonlyMap<InstrumentId, TokenBalance>;
}

/**
 * Portfolio — immutable aggregate root
 *
 * @remarks
 * Все поля readonly. Мутирующие операции возвращают НОВЫЙ Portfolio.
 */
/**
 * Параметры применения исполнения к портфелю.
 *
 * @remarks
 * `reservedNotional` обязателен для BUY и не используется для SELL. Так
 * получается потому, что резервируются РАЗНЫЕ вещи: под покупку — деньги
 * (`reserveForOrder`), под продажу — токены (`reserveTokens`). Компилятор
 * различить эти случаи не может: сторона исполнения — значение времени
 * выполнения, а не параметр типа, поэтому отсутствие суммы на BUY даёт `Err`.
 */
export interface ApplyFillParams {
  /** Идентификатор позиции — используется, если позиция открывается впервые */
  readonly positionId: PositionId;
  /**
   * BUY: сколько денежной резервации потребляет ЭТО исполнение.
   *
   * @remarks
   * Передаётся вызывающим, а не выводится из `fill.price × fill.size`:
   * площадка округляет цену в fill-событии, и резервация создавалась по цене
   * ЗАЯВКИ. Вычислять сумму по округлённой цене значило бы оставлять на
   * резервации копеечные хвосты, которые никто потом не снимет.
   *
   * Частичное исполнение потребляет часть резервации; остаток остаётся под
   * неисполненным объёмом заявки.
   */
  readonly reservedNotional?: Money;
}

export class Portfolio {
  /** Уникальный идентификатор портфеля */
  public readonly id: PortfolioId;

  /** ID аккаунта владельца */
  public readonly accountId: AccountId;

  /** Баланс: available + reserved средства */
  public readonly balance: Balance;

  /** Карта открытых позиций: InstrumentId → Position */
  public readonly positions: ReadonlyMap<InstrumentId, Position>;

  /**
   * Карта зарезервированных outcome-токенов для открытых SELL ордеров.
   *
   * @remarks
   * Ключ — InstrumentId (тот же, что в positions).
   * Значение — суммарный зарезервированный объём (Quantity, >= 0).
   *
   * Инвариант: reservedQty <= position.quantity (нельзя зарезервировать больше, чем есть).
   * Проверяется при вызове `reserveTokensForOrder`.
   */
  public readonly tokenBalances: ReadonlyMap<InstrumentId, TokenBalance>;

  /**
   * Приватный конструктор — используйте Portfolio.create()
   */
  private constructor(params: PortfolioParams) {
    this.id = params.id;
    this.accountId = params.accountId;
    this.balance = params.balance;
    this.positions = params.positions
      ? new Map(params.positions)
      : new Map<InstrumentId, Position>();
    this.tokenBalances = params.tokenBalances
      ? new Map(params.tokenBalances)
      : new Map<InstrumentId, TokenBalance>();
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

    // Инвариант проверяется и ЗДЕСЬ, а не только в мутаторах. Иначе остаётся
    // публичный вход, через который агрегат собирается сразу несогласованным:
    // позиция на 100 при токенном балансе на 40 прошла бы, и первая же мутация
    // отвергла бы состояние, которое сама не создавала.
    const violation = Portfolio._findInvariantViolation(
      params.accountId,
      params.balance,
      params.positions ?? new Map(),
      params.tokenBalances ?? new Map(),
    );
    if (violation !== undefined) {
      return Err(
        new PortfolioValidationError(violation.message, {
          context: { ...violation.context, portfolioId: params.id },
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
   * // Закрытая позиция удаляется из карты
   * ```
   *
   * @remarks
   * ПРИВАТНЫЙ. Раньше метод был публичным, и вызывающий строил позицию
   * снаружи, а потом отдельно двигал деньги — согласованность агрегата
   * держалась на том, что он не забудет второй шаг. Теперь единственные
   * публичные мутаторы — {@link applyFill},
   * {@link reserveTokens} и {@link releaseTokens}, и каждый собирает ПОЛНЫЙ
   * новый набор через {@link _rebalanced}.
   *
   * Возвращает КАРТУ, а не портфель: собрать портфель можно только вместе с
   * деньгами и токенными балансами.
   */
  private _upsertPosition(position: Position): ReadonlyMap<InstrumentId, Position> {
    const newPositions = new Map<InstrumentId, Position>(this.positions);

    if (position.isClosed()) {
      newPositions.delete(position.instrumentId);
    } else {
      newPositions.set(position.instrumentId, position);
    }

    return newPositions;
  }

  /**
   * Возвращает позицию по instrumentId
   *
   * @param instrumentId - Идентификатор инструмента
   * @returns Position или undefined если позиции нет
   *
   * @example
   * ```typescript
   * const position = portfolio.getPosition(instrumentId);
   * if (position) {
   *   console.log(position.instrumentId);
   * }
   * ```
   */
  public getPosition(instrumentId: InstrumentId): Position | undefined {
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
   * @returns IterableIterator<Position> — без аллокации массива
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
  public getPositions(): IterableIterator<Position> {
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
   * Свободное количество токенов инструмента.
   *
   * @param instrumentId - Инструмент
   * @returns Доступное количество; ноль, если инструмента нет
   *
   * @remarks
   * Читает `TokenBalance.available()` — раздельно хранимую часть. Раньше это
   * значение ВЫЧИСЛЯЛОСЬ как `position.quantity − reserved` и при отрицательном
   * результате молча зажималось в ноль, то есть нарушенный инвариант
   * скрывался. Теперь нарушить его нельзя: {@link _rebalanced} проверяет
   * равенство до записи.
   */
  public availableTokens(instrumentId: InstrumentId): Quantity {
    return this.tokenBalances.get(instrumentId)?.available() ?? Quantity.of(new Decimal(0));
  }

  /**
   * Зарезервированное количество токенов инструмента.
   *
   * @param instrumentId - Инструмент
   * @returns Зарезервированное количество; ноль, если инструмента нет
   */
  public reservedTokens(instrumentId: InstrumentId): Quantity {
    return this.tokenBalances.get(instrumentId)?.reserved() ?? Quantity.of(new Decimal(0));
  }

  /**
   * Резервирует токены под SELL-заявку.
   *
   * @param instrumentId - Инструмент
   * @param qty - Количество к резервированию
   * @returns Новый согласованный портфель либо отказ
   *
   * @remarks
   * Перекладывает количество из `available` в `reserved` ВНУТРИ одного
   * `TokenBalance`. Сумма не меняется, поэтому инвариант с позицией сохраняется
   * по построению — но проверяется всё равно: дешевле проверки только молчащий
   * дефект.
   */
  public reserveTokens(
    instrumentId: InstrumentId,
    qty: Quantity,
  ): Result<Portfolio, PortfolioOperationError> {
    const amount = qty.value();
    if (amount.lte(0)) {
      return Err(new PortfolioOperationError(
        `reserveTokens: qty must be positive, got ${amount.toString()}`,
        { context: { instrumentId: String(instrumentId), qty: amount.toString() } },
      ));
    }

    const current = this.tokenBalances.get(instrumentId);
    if (current === undefined || current.available().value().lt(amount)) {
      const available = current?.available().value() ?? new Decimal(0);
      return Err(new PortfolioOperationError(
        `Insufficient token balance for SELL: available ${available.toFixed(4)}, ` +
          `required ${amount.toFixed(4)}`,
        {
          context: {
            instrumentId: String(instrumentId),
            available: available.toString(),
            required: amount.toString(),
          },
        },
      ));
    }

    const moved = TokenBalance.of(
      instrumentId,
      Quantity.of(current.available().value().minus(amount)),
      Quantity.of(current.reserved().value().plus(amount)),
      this.accountId,
      this.balance.venueId(),
    );
    return this._rebalanced(this.balance, this.positions, this._withTokenBalance(instrumentId, moved));
  }

  /**
   * Освобождает ранее зарезервированные токены.
   *
   * @param instrumentId - Инструмент
   * @param qty - Количество к освобождению
   * @returns Новый согласованный портфель либо отказ
   */
  public releaseTokens(
    instrumentId: InstrumentId,
    qty: Quantity,
  ): Result<Portfolio, PortfolioOperationError> {
    const amount = qty.value();
    if (amount.lte(0)) {
      return Err(new PortfolioOperationError(
        `releaseTokens: qty must be positive, got ${amount.toString()}`,
        { context: { instrumentId: String(instrumentId), qty: amount.toString() } },
      ));
    }

    const current = this.tokenBalances.get(instrumentId);
    const reserved = current?.reserved().value() ?? new Decimal(0);
    if (current === undefined || reserved.lt(amount)) {
      return Err(new PortfolioOperationError(
        `Cannot release token reservation: reserved ${reserved.toFixed(4)}, ` +
          `requested ${amount.toFixed(4)}`,
        {
          context: {
            instrumentId: String(instrumentId),
            reserved: reserved.toString(),
            requested: amount.toString(),
          },
        },
      ));
    }

    const moved = TokenBalance.of(
      instrumentId,
      Quantity.of(current.available().value().plus(amount)),
      Quantity.of(reserved.minus(amount)),
      this.accountId,
      this.balance.venueId(),
    );
    return this._rebalanced(this.balance, this.positions, this._withTokenBalance(instrumentId, moved));
  }

  /**
   * Применяет исполнение: деньги, позиция и токенный баланс одной операцией.
   *
   * @param fill - Canonical факт исполнения
   * @param positionId - Идентификатор позиции, если её ещё нет
   * @returns Новый согласованный портфель либо отказ
   *
   * @remarks
   * Это и есть транзакция агрегата. Раньше вызывающий делал два шага —
   * сначала `applyDebit`, потом `upsertPosition`, — и согласованность держалась
   * на том, что он не забудет второй. Забыть теперь нечего: либо меняется всё,
   * либо ничего.
   *
   * ### Это normal/local-order path
   *
   * Метод описывает исполнение заявки, ресурс под которую УЖЕ зарезервирован.
   * Обе стороны потребляют свою резервацию, и в этом они симметричны:
   *
   * ```text
   * BUY   деньги  reserved −номинал, available −комиссия   позиция +лот   токены available +size
   * SELL  деньги  available +(номинал − комиссия)          позиция −FIFO  токены reserved  −size
   * ```
   *
   * Резервируются РАЗНЫЕ вещи: под покупку — деньги ({@link reserveForOrder}),
   * под продажу — токены ({@link reserveTokens}). Отсюда и разные источники
   * списания, но принцип один: исполнение потребляет заранее отложенное, а не
   * лезет в свободный остаток.
   *
   * Комиссия — единственное исключение: её никто не резервировал, потому что
   * при размещении заявки ещё неизвестно, окажемся мы тейкером или мейкером.
   * Поэтому она снимается из `available`, и тоже fail-closed.
   *
   * Восстановление после сбоя (исполнение без заявки, резервация уже снята)
   * этим методом НЕ обслуживается: у него другая семантика — best-effort по
   * факту площадки, — и смешивать её с нормальным путём значит потерять
   * fail-closed там, где он нужен.
   *
   * Лоты закрывает сам `Position` по FIFO — экономика позиции принадлежит ей,
   * а не портфелю.
   *
   * Инвариант проверяется на ПОЛНОМ новом наборе (см. {@link _rebalanced}),
   * поэтому промежуточное несогласованное состояние наружу не выходит.
   *
   * ### Комиссия
   *
   * Портфель её не считает и не конвертирует. Всё, что нужно, уже выражено
   * дельтами `Fill`: деньги берутся из {@link Fill.getNetCashFlow}, количество
   * — валовое, потому что комиссия его не трогает.
   *
   * ```text
   * BUY  тейкер   отдаём  номинал + fee    получаем ПОЛНЫЕ size шар
   * SELL тейкер   получаем номинал − fee   отдаём  ПОЛНЫЕ size шар
   * мейкер        ровно номинал            комиссии нет
   * ```
   *
   * Измерено на 2898 реальных сделках — `docs/guides/polymarket-fee-settlement.md`.
   * Расчёт вида `feeInTokens = feeUSDC / price`, живущий в старом
   * `PortfolioService`, описывает механизм, которого не существует, и сюда
   * переноситься не должен.
   */
  public applyFill(
    fill: Fill,
    params: ApplyFillParams,
  ): Result<Portfolio, PortfolioOperationError> {
    // Владелец проверяется ДО любых вычислений: чужое исполнение не должно
    // дойти до арифметики вовсе.
    if (!accountIdEquals(fill.accountId, this.accountId)) {
      return Err(new PortfolioOperationError(
        'applyFill: fill belongs to a different account',
        {
          context: {
            fillId: String(fill.id),
            portfolioAccountId: accountIdToString(this.accountId),
            fillAccountId: accountIdToString(fill.accountId),
          },
        },
      ));
    }
    if (fill.venueId !== this.balance.venueId()) {
      return Err(new PortfolioOperationError(
        `applyFill: fill is from venue ${fill.venueId}, portfolio is on ${this.balance.venueId()}`,
        {
          context: {
            fillId: String(fill.id),
            portfolioVenueId: this.balance.venueId(),
            fillVenueId: fill.venueId,
          },
        },
      ));
    }

    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    if (instrumentId === undefined) {
      return Err(new PortfolioOperationError(
        `applyFill: token ${assetIdToString(fill.tokenId)} does not resolve to an instrument`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    const existing = this.positions.get(instrumentId);

    if (fill.side === 'BUY') {
      // Номинал ПОТРЕБЛЯЕТСЯ из reserved — той самой резервации, что создал
      // `reserveForOrder()` при размещении заявки. Сколько именно потребить,
      // говорит вызывающий: `fill.price` округлена площадкой, и восстановить
      // по ней исходную сумму нельзя. Частичное исполнение потребляет часть.
      if (params.reservedNotional === undefined) {
        return Err(new PortfolioOperationError(
          'applyFill: reservedNotional is required for BUY — notional is consumed from reserved, ' +
            'and the reserved amount cannot be recovered from the venue-rounded fill price',
          { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
        ));
      }

      const consumed = BalanceService.consumeReserved(this.balance, params.reservedNotional);
      if (!consumed.ok) {
        return Err(new PortfolioOperationError(
          `applyFill: cannot consume reserved ${params.reservedNotional.value().toString()} ` +
            `for BUY: ${consumed.error.message}`,
          { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
        ));
      }

      // Комиссию никто не резервировал: при размещении заявки ещё неизвестно,
      // окажемся мы тейкером или мейкером. Поэтому она снимается отдельно и
      // из available — fail-closed, без зажима в ноль.
      const money = fill.fee.isZero()
        ? consumed
        : Portfolio._debitAvailable(
            consumed.value,
            Money.of(fill.fee.quantity.amount().value(), this.balance.currency()),
          );
      if (!money.ok) {
        return Err(new PortfolioOperationError(
          `applyFill: cannot debit taker fee for BUY: ${money.error.message}`,
          { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
        ));
      }

      const lot = PositionLot.create({
        quantity: fill.size,
        entryPrice: fill.price,
        timestamp: fill.timestamp,
        fee: fill.fee,
      });

      const grown = existing === undefined
        ? Position.create({
            id: params.positionId,
            accountId: this.accountId,
            instrumentId,
            asset: fill.tokenId,
            side: 'LONG',
            openedAt: fill.timestamp,
            lots: [lot],
          })
        : existing.addLots([lot], fill.timestamp);
      if (!grown.ok) {
        return Err(new PortfolioOperationError(
          `applyFill: cannot grow position: ${grown.error.message}`,
          { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
        ));
      }

      const tokens = this.tokenBalances.get(instrumentId);
      const nextTokens = TokenBalance.of(
        instrumentId,
        Quantity.of((tokens?.available().value() ?? new Decimal(0)).plus(fill.size.value())),
        tokens?.reserved() ?? Quantity.of(new Decimal(0)),
        this.accountId,
        this.balance.venueId(),
      );

      return this._rebalanced(
        money.value,
        this._upsertPosition(grown.value),
        this._withTokenBalance(instrumentId, nextTokens),
      );
    }

    // ── SELL ──────────────────────────────────────────────────────────────
    if (existing === undefined) {
      return Err(new PortfolioOperationError(
        `applyFill: SELL without an open position for ${String(instrumentId)}`,
        { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
      ));
    }

    const tokens = this.tokenBalances.get(instrumentId);
    const reserved = tokens?.reserved().value() ?? new Decimal(0);
    if (reserved.lt(fill.size.value())) {
      return Err(new PortfolioOperationError(
        `applyFill: SELL of ${fill.size.value().toString()} exceeds reserved ` +
          `${reserved.toString()} for ${String(instrumentId)}`,
        { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
      ));
    }

    const closed = existing.close(fill.size, fill.price, 'FIFO', fill.timestamp);
    if (!closed.ok) {
      return Err(new PortfolioOperationError(
        `applyFill: cannot close position lots: ${closed.error.message}`,
        { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
      ));
    }

    // Деньги SELL — нетто-поток самого `Fill`: номинал за вычетом комиссии.
    // Пересчитывать нечего, домен уже умеет складывать поток с комиссией.
    const inflow = Money.of(fill.getNetCashFlow().amount.value(), this.balance.currency());
    const money = BalanceService.credit(this.balance, inflow);
    if (!money.ok) {
      return Err(new PortfolioOperationError(
        `applyFill: cannot credit ${inflow.value().toString()} for SELL: ${money.error.message}`,
        { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
      ));
    }

    const nextTokens = TokenBalance.of(
      instrumentId,
      tokens?.available() ?? Quantity.of(new Decimal(0)),
      Quantity.of(reserved.minus(fill.size.value())),
      this.accountId,
      this.balance.venueId(),
    );

    return this._rebalanced(
      money.value,
      this._upsertPosition(closed.value.position),
      this._withTokenBalance(instrumentId, nextTokens),
    );
  }

  // ────────────────────────────────────────────────────────────
  // Внутреннее: единственная точка сборки согласованного состояния
  // ────────────────────────────────────────────────────────────

  /**
   * Собирает новый портфель, проверив инвариант агрегата.
   *
   * @param balance - Новые деньги
   * @param positions - Новые позиции
   * @param tokenBalances - Новые токенные балансы
   * @returns Согласованный портфель либо отказ с указанием инструмента
   *
   * @remarks
   * ГЛАВНЫЙ ИНВАРИАНТ агрегата:
   *
   * ```text
   * Position.quantity == TokenBalance.available + TokenBalance.reserved
   * ```
   *
   * Позиция говорит, СКОЛЬКО токенов у нас есть; `TokenBalance` — как это
   * количество разложено на свободное и зарезервированное. Разойтись они не
   * могут: расхождение означает либо резервацию под несуществующие токены,
   * либо потерянные токены.
   *
   * Единственная точка, где собирается новое состояние. Публичных путей,
   * меняющих одну часть без остальных, у агрегата нет — именно поэтому
   * `_upsertPosition` приватный, а отдельной замены `TokenBalance` не
   * существует вовсе.
   */
  private _rebalanced(
    balance: Balance,
    positions: ReadonlyMap<InstrumentId, Position>,
    tokenBalances: ReadonlyMap<InstrumentId, TokenBalance>,
  ): Result<Portfolio, PortfolioOperationError> {
    const violation = Portfolio._findInvariantViolation(
      this.accountId, balance, positions, tokenBalances);
    if (violation !== undefined) {
      return Err(new PortfolioOperationError(violation.message, { context: violation.context }));
    }

    return Ok(new Portfolio({ id: this.id, accountId: this.accountId, balance, positions, tokenBalances }));
  }

  /**
   * Первое расхождение позиции с токенным балансом, если оно есть.
   *
   * @param positions - Позиции по инструментам
   * @param tokenBalances - Токенные балансы по тем же инструментам
   * @returns Описание нарушения либо `undefined`, если набор согласован
   *
   * @remarks
   * Единственное определение инварианта агрегата:
   *
   * ```text
   * Position.quantity == TokenBalance.available + TokenBalance.reserved
   * ```
   *
   * Проверяется по ОБЪЕДИНЕНИЮ ключей, а не по одной из карт: инструмент,
   * присутствующий только с одной стороны, — это тоже расхождение, и молча
   * пропускать его нельзя.
   *
   * Возвращается описание, а не `Result`: два вызывающих оборачивают его в
   * разные типы ошибок — {@link create} в валидационную, мутаторы в
   * операционную, — и заводить общий супертип ради этого незачем.
   */
  private static _findInvariantViolation(
    accountId: AccountId,
    balance: Balance,
    positions: ReadonlyMap<InstrumentId, Position>,
    tokenBalances: ReadonlyMap<InstrumentId, TokenBalance>,
  ): { message: string; context: Record<string, string> } | undefined {
    // Владелец денег — тот же, что владелец агрегата.
    if (!accountIdEquals(balance.accountId(), accountId)) {
      return {
        message: 'Balance belongs to a different account than the portfolio',
        context: {
          portfolioAccountId: accountIdToString(accountId),
          balanceAccountId: accountIdToString(balance.accountId()),
        },
      };
    }

    const venueId = balance.venueId();
    const instruments = new Set<InstrumentId>([...positions.keys(), ...tokenBalances.keys()]);

    for (const instrumentId of instruments) {
      const position = positions.get(instrumentId);
      const tokens = tokenBalances.get(instrumentId);

      // Инструмент существует ⟺ существуют ОБЕ половины. Односторонняя запись —
      // расхождение даже при нулевом количестве: мутаторы нормализуют ноль в
      // отсутствие ({@link _upsertPosition}, {@link _withTokenBalance}), и
      // допускать состояние, которого они не производят, значит принимать
      // набор, из которого сами же не смогли бы выйти.
      if (position === undefined || tokens === undefined) {
        return {
          message:
            `Instrument ${String(instrumentId)} is present only in ` +
            `${position === undefined ? 'tokenBalances' : 'positions'}`,
          context: {
            instrumentId: String(instrumentId),
            hasPosition: String(position !== undefined),
            hasTokenBalance: String(tokens !== undefined),
          },
        };
      }

      // Ключ карты — не метка, а утверждение об идентичности. Разойдись он с
      // самой записью, поиск по инструменту вернул бы чужой объект.
      if (position.instrumentId !== instrumentId) {
        return {
          message: `Position stored under key ${String(instrumentId)} declares ${String(position.instrumentId)}`,
          context: { key: String(instrumentId), declared: String(position.instrumentId) },
        };
      }
      if (tokens.instrumentId() !== instrumentId) {
        return {
          message: `TokenBalance stored under key ${String(instrumentId)} declares ${String(tokens.instrumentId())}`,
          context: { key: String(instrumentId), declared: String(tokens.instrumentId()) },
        };
      }

      // Владение: чужая позиция или чужой токенный баланс в нашем агрегате —
      // это перепутанный аккаунт или площадка, а не допустимое состояние.
      if (!accountIdEquals(position.accountId, accountId)) {
        return {
          message: `Position ${String(instrumentId)} belongs to a different account`,
          context: {
            instrumentId: String(instrumentId),
            portfolioAccountId: accountIdToString(accountId),
            positionAccountId: accountIdToString(position.accountId),
          },
        };
      }
      if (!accountIdEquals(tokens.accountId(), accountId)) {
        return {
          message: `TokenBalance ${String(instrumentId)} belongs to a different account`,
          context: {
            instrumentId: String(instrumentId),
            portfolioAccountId: accountIdToString(accountId),
            tokenAccountId: accountIdToString(tokens.accountId()),
          },
        };
      }
      if (tokens.venueId() !== venueId) {
        return {
          message: `TokenBalance ${String(instrumentId)} belongs to venue ${tokens.venueId()}, portfolio is on ${venueId}`,
          context: {
            instrumentId: String(instrumentId),
            portfolioVenueId: venueId,
            tokenVenueId: tokens.venueId(),
          },
        };
      }

      const positionQty = position.quantity.value();
      const tokenTotal = tokens.total().value();

      if (!positionQty.equals(tokenTotal)) {
        return {
          message:
            `Aggregate invariant violated for ${String(instrumentId)}: position quantity ` +
            `${positionQty.toString()} != token available+reserved ${tokenTotal.toString()}`,
          context: {
            instrumentId: String(instrumentId),
            positionQuantity: positionQty.toString(),
            tokenTotal: tokenTotal.toString(),
            available: tokens.available().value().toString(),
            reserved: tokens.reserved().value().toString(),
          },
        };
      }

      // Нулевая пара — это отсутствие инструмента, а не его присутствие с
      // нулём. Иначе «инструмент известен портфелю» перестаёт быть
      // однозначным вопросом.
      if (positionQty.isZero()) {
        return {
          message: `Instrument ${String(instrumentId)} is stored with zero quantity; zero must be absence`,
          context: { instrumentId: String(instrumentId) },
        };
      }
    }

    return undefined;
  }

  /**
   * Карта токенных балансов с заменённой или удалённой записью.
   *
   * @param instrumentId - Инструмент
   * @param next - Новый баланс; нулевой удаляется
   * @returns Новая карта
   */
  private _withTokenBalance(
    instrumentId: InstrumentId,
    next: TokenBalance,
  ): ReadonlyMap<InstrumentId, TokenBalance> {
    const map = new Map<InstrumentId, TokenBalance>(this.tokenBalances);
    if (next.total().value().isZero()) map.delete(instrumentId);
    else map.set(instrumentId, next);
    return map;
  }

  /**
   * Баланс после прямого списания.
   *
   * @param amount - Сумма к списанию
   * @returns Новый баланс либо отказ
   *
   * @remarks
   * Та же арифметика, что в {@link applyDirectDebit}: `available` не уходит
   * ниже нуля. Вынесено, чтобы {@link applyFill} не собирал баланс сам —
   * агрегат меняет деньги ровно одним способом.
   */
  private static _debitAvailable(
    balance: Balance,
    amount: Money,
  ): Result<Balance, InvalidBalanceError> {
    const next = balance.available().value().minus(amount.value());

    // Fail-closed. Здесь стоял `Decimal.max(0, …)`, то есть нехватка средств
    // молча превращалась в списание «до нуля» — и портфель расходился с
    // площадкой на разницу, не сообщив об этом никому.
    if (next.isNegative()) {
      return Err(new InvalidBalanceError(
        `Insufficient available funds: need ${amount.value().toString()}, ` +
          `have ${balance.available().value().toString()}`,
        {
          context: {
            required: amount.value().toString(),
            available: balance.available().value().toString(),
          },
        },
      ));
    }

    return BalanceService.updateAvailable(balance, Money.of(next, balance.currency()));
  }

  /**
   * Портфель с заменённым балансом.
   *
   * @param balance - Новый баланс
   * @returns Новый портфель
   */
  private withBalance(balance: Balance): Portfolio {
    return new Portfolio({
      id: this.id,
      accountId: this.accountId,
      balance,
      positions: this.positions,
      tokenBalances: this.tokenBalances,
    });
  }
}

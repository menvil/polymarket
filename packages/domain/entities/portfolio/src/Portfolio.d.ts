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
import Decimal from 'decimal.js';
import type { Price } from '@polymarket/value-objects';
import { Result } from '@polymarket/result';
import type { InstrumentId, AccountId } from '@polymarket/ids';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance } from '@polymarket/value-objects/balance';
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
    readonly quantity: {
        value(): Decimal;
    };
    /** Сторона позиции */
    readonly side: 'LONG' | 'SHORT';
    /** Средневзвешенная цена входа */
    readonly averageEntryPrice: {
        value(): Decimal;
    };
    /** Проверяет, закрыта ли позиция (quantity = 0) */
    isClosed(): boolean;
    /**
     * Вычисляет unrealized P&L для заданной текущей цены
     *
     * @param currentPrice - Текущая цена инструмента (Price VO)
     * @returns Объект с методом value(): Decimal (совместим с SignedQuantity)
     */
    getUnrealizedPnL(currentPrice: Price): {
        value(): Decimal;
    };
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
export declare class Portfolio {
    /** Уникальный идентификатор портфеля */
    readonly id: PortfolioId;
    /** ID аккаунта владельца */
    readonly accountId: AccountId;
    /** Баланс: available + reserved средства */
    readonly balance: Balance;
    /** Карта открытых позиций: InstrumentId → IPosition */
    readonly positions: ReadonlyMap<InstrumentId, IPosition>;
    /**
     * Приватный конструктор — используйте Portfolio.create()
     */
    private constructor();
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
    static create(params: PortfolioParams): Result<Portfolio, PortfolioValidationError>;
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
    reserveForOrder(amount: Money): Result<Portfolio, InvalidBalanceError>;
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
    releaseReservation(amount: Money): Result<Portfolio, InvalidBalanceError>;
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
    applyDebit(amount: Money): Result<Portfolio, InvalidBalanceError>;
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
    applyCredit(amount: Money): Result<Portfolio, InvalidBalanceError>;
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
    upsertPosition(position: IPosition): Portfolio;
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
    getPosition(instrumentId: InstrumentId): IPosition | undefined;
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
    hasPosition(instrumentId: InstrumentId): boolean;
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
    getPositions(): IterableIterator<IPosition>;
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
    getPositionCount(): number;
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
    isEmpty(): boolean;
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
    toString(): string;
    /**
     * Создаёт копию Portfolio с новым balance
     *
     * @param balance - Новый баланс
     * @returns Новый Portfolio
     */
    private withBalance;
}
//# sourceMappingURL=Portfolio.d.ts.map
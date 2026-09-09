/**
 * Конструкторы и арифметика Value Objects для отчёта.
 *
 * @remarks
 * Единственное место в приложении, где разворачивается `Result` от
 * `*Service`. Смысл — соблюсти границу из
 * `docs/architecture/boundary-contract.md` (Решение 1) без церемонии на
 * каждом вызове:
 *
 * - **`Decimal` не импортируется.** Конструкторы сервисов принимают `number`,
 *   поэтому голый `Decimal` приложению не нужен вовсе.
 * - **Арифметика идёт через `*Service`**, а не над извлечёнными значениями:
 *   `MoneyService.add(a, b)`, а не `a.value().plus(b.value())`.
 * - **Разворачивание `Result` собрано здесь.** Величины уже прошли инварианты
 *   при создании, поэтому отказ арифметики означает дефект, а не ожидаемый
 *   случай: прятать его в `null` значило бы получить прочерк в отчёте без
 *   единого следа о причине.
 *
 * Отчёт — read-only: он ничего не отправляет и не резервирует. Поэтому отказ
 * здесь допустимо превращать в исключение, а не тянуть `Result` через все
 * агрегаты.
 */
import type { Result } from '@polymarket/result';
import { isOk } from '@polymarket/result';
import type { Timestamp } from '@polymarket/timestamp';
import { TimestampService } from '@polymarket/timestamp';
import type { Money, OutcomePrice, Quantity, Ratio } from '@polymarket/value-objects';
import {
  MoneyService,
  OutcomePriceService,
  QuantityService,
  RatioService,
} from '@polymarket/value-objects';

/** Нижняя граница торгуемой цены (базовый тик Polymarket). */
const MIN_TRADEABLE_PRICE = 0.0001;

/** Верхняя граница торгуемой цены. */
const MAX_TRADEABLE_PRICE = 0.9999;

/**
 * Разворачивает `Result`, полученный от VO-сервиса.
 *
 * @param result - Результат операции
 * @param what - Что именно вычислялось — попадёт в текст ошибки
 * @returns Значение
 * @throws {Error} Если операция не удалась
 *
 * @example
 * ```typescript
 * const total = expect(MoneyService.add(a, b), 'sum of entry costs');
 * ```
 */
function expect<T>(result: Result<T, unknown>, what: string): T {
  if (isOk(result)) return result.value;
  throw new Error(`PnL: failed to compute ${what}: ${String(result.error)}`);
}

/**
 * Создаёт денежную величину в USDC.
 *
 * @param value - Сумма (может быть отрицательной)
 * @returns `Money`
 * @throws {Error} Если значение не число или бесконечность
 *
 * @example
 * ```typescript
 * money(-18.14);  // Money(-18.14 USDC)
 * ```
 */
export function money(value: number): Money {
  return expect(MoneyService.create(value), `money from ${value}`);
}

/**
 * Создаёт количество токенов.
 *
 * @param value - Количество, неотрицательное
 * @returns `Quantity`
 * @throws {Error} Если значение отрицательное
 *
 * @example
 * ```typescript
 * quantity(5);  // Quantity(5)
 * ```
 */
export function quantity(value: number): Quantity {
  return expect(QuantityService.create(value), `quantity from ${value}`);
}

/**
 * Создаёт безразмерную долю.
 *
 * @param value - Доля (0.127 = 12.7%), допускает отрицательные
 * @returns `Ratio`
 * @throws {Error} Если значение не число
 *
 * @example
 * ```typescript
 * ratio(-0.0602);  // Ratio(-0.0602) → "-6.0%"
 * ```
 */
export function ratio(value: number): Ratio {
  return expect(RatioService.fromDecimal(value), `ratio from ${value}`);
}

/**
 * Создаёт цену исхода, зажимая её в торгуемый диапазон.
 *
 * @param value - Цена
 * @returns `OutcomePrice` в пределах [MIN, MAX]
 * @throws {Error} Если значение не число
 *
 * @remarks
 * `OutcomePrice` допускает только открытый диапазон (0, 1) — по цене 0 или 1
 * ордер не выставить, и для КОТИРОВКИ это верный инвариант. Но в отчёте
 * встречаются производные величины (средняя цена входа), которые могут выйти
 * на границу. Зажимаем, а не падаем: отчёт о прошлых сделках не должен
 * ломаться из-за граничного значения. Искажение не превышает 0.0001.
 *
 * @example
 * ```typescript
 * price(0.47);  // OutcomePrice(0.47)
 * price(1);     // OutcomePrice(0.9999) — зажато
 * ```
 */
export function price(value: number): OutcomePrice {
  const clamped = Math.min(Math.max(value, MIN_TRADEABLE_PRICE), MAX_TRADEABLE_PRICE);
  return expect(OutcomePriceService.create(clamped), `price from ${value}`);
}

/**
 * Создаёт момент времени из epoch-миллисекунд.
 *
 * @param epochMs - Момент в миллисекундах
 * @returns `Timestamp`
 * @throws {Error} Если значение не число
 *
 * @remarks
 * Тип снимает ловушку, на которой уже обжигались: `match_time` в старом
 * REST приходил в СЕКУНДАХ, а `matchedAt` у SDK — ISO-строкой. С
 * `Timestamp` единица измерения перестаёт быть договорённостью.
 *
 * @example
 * ```typescript
 * timestamp(1780272000_000);
 * ```
 */
export function timestamp(epochMs: number): Timestamp {
  return expect(TimestampService.create(epochMs), `timestamp from ${epochMs}`);
}

/**
 * Складывает денежные величины.
 *
 * @param values - Слагаемые
 * @returns Сумма; для пустого списка — ноль
 * @throws {Error} Если сложение не удалось
 *
 * @example
 * ```typescript
 * sumMoney([money(1.5), money(2.5)]);  // Money(4)
 * ```
 */
export function sumMoney(values: Money[]): Money {
  return values.reduce<Money>(
    (acc, m) => expect(MoneyService.add(acc, m), 'money sum'),
    money(0)
  );
}

/**
 * Вычитает одну денежную величину из другой.
 *
 * @param a - Уменьшаемое
 * @param b - Вычитаемое
 * @returns Разность
 * @throws {Error} Если вычитание не удалось
 *
 * @example
 * ```typescript
 * subMoney(money(3), money(1));  // Money(2)
 * ```
 */
export function subMoney(a: Money, b: Money): Money {
  return expect(MoneyService.subtract(a, b), 'money difference');
}

/**
 * Умножает денежную величину на безразмерный множитель.
 *
 * @param m - Сумма
 * @param factor - Множитель
 * @returns Произведение
 * @throws {Error} Если умножение не удалось
 *
 * @example
 * ```typescript
 * mulMoney(money(3), 2);  // Money(6)
 * ```
 */
export function mulMoney(m: Money, factor: number): Money {
  return expect(MoneyService.multiply(m, factor), 'money product');
}

/**
 * Делит денежную величину на безразмерный делитель.
 *
 * @param m - Сумма
 * @param divisor - Делитель, не ноль
 * @returns Частное
 * @throws {Error} Если деление не удалось (в том числе на ноль)
 *
 * @example
 * ```typescript
 * divMoney(money(6), 2);  // Money(3)
 * ```
 */
export function divMoney(m: Money, divisor: number): Money {
  return expect(MoneyService.divide(m, divisor), 'money quotient');
}

/**
 * Меняет знак денежной величины.
 *
 * @param m - Сумма
 * @returns Величина с обратным знаком; ноль остаётся нулём
 *
 * @remarks
 * Ноль не отрицается: `−0` печатается форматтером как «-$0.00», и затрата в
 * ноль выглядела бы как убыток.
 *
 * @example
 * ```typescript
 * negateMoney(money(1.39));  // Money(-1.39)
 * negateMoney(money(0));     // Money(0)
 * ```
 */
export function negateMoney(m: Money): Money {
  return m.isZero() ? m : mulMoney(m, -1);
}

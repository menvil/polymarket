/**
 * Описание скалярного домена для общих операций.
 *
 * @remarks
 * Тот же приём, что и `PriceDomain` для цен: общей делается МЕХАНИКА
 * операции (разбор операнда, обёртка `wrapOp`, арифметика, создание
 * значения), а всё, чем домены различаются, приходит здесь.
 *
 * Различаются они ровно тремя вещами:
 *
 * 1. **Инвариантом.** `Quantity` = конечное и НЕОТРИЦАТЕЛЬНОЕ,
 *    `SignedQuantity` = конечное любого знака. Инварианты вложены, поэтому
 *    общий класс-предок здесь был бы вреден: он размыл бы их и сломал
 *    `equals` — значения разных доменов сравнивались бы как равные.
 *    Наследования нет, вместо него — фабрика `create`.
 * 2. **Типом ошибки** и словарём причин.
 * 3. **Правилами операндов.** `Quantity` требует множитель >= 0
 *    (иначе результат ушёл бы в отрицательные), `SignedQuantity` — нет.
 *
 * Всё остальное у них совпадало БАЙТ В БАЙТ, включая ключи в контексте
 * ошибок (`quantity1`, `quantity2`, `factor`, `stepSize`), — что и делает
 * вынос безопасным: контракт потребителей не меняется.
 */
import type { Result } from '@polymarket/result';
import type { AnyTradingError, ErrorConstructor } from '@polymarket/errors';
import type Decimal from 'decimal.js';
import type { DecimalValue } from './DecimalValue.js';

/**
 * Описание домена скалярной величины.
 *
 * @typeParam TValue - Тип значения домена (`Quantity`, `SignedQuantity`)
 * @typeParam TError - Тип ошибки домена
 */
export interface ScalarDomain<TValue extends DecimalValue, TError extends AnyTradingError> {
  /** Имя сервиса в контексте ошибок */
  readonly serviceName: string;

  /** Конструктор ошибки домена */
  readonly ErrorConstructor: ErrorConstructor<TError>;

  /** Причина «строку/число не удалось разобрать» */
  readonly invalidFormatReason: string;

  /** Причина «значение NaN» */
  readonly nanReason: string;

  /** Причина «значение не конечно» */
  readonly nonFiniteReason: string;

  /**
   * Создаёт значение домена, проверяя его инварианты.
   *
   * @remarks
   * Именно здесь домены расходятся: `Quantity.of` бросит на отрицательном,
   * `SignedQuantity.of` — нет.
   */
  readonly create: (value: Decimal) => Result<TValue, TError>;

  /** Правило для множителя: у `Quantity` оно строже */
  readonly validateFactor: (factor: Decimal) => Result<unknown, AnyTradingError>;

  /** Правило для делителя */
  readonly validateDivisor: (divisor: Decimal) => Result<unknown, AnyTradingError>;

  /** Правило для шага округления */
  readonly validateStep: (step: Decimal) => Result<unknown, AnyTradingError>;
}

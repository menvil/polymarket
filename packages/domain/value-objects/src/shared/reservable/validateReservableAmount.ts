/**
 * Правило: величина, изымаемая из пула, должна быть пригодной и доступной.
 *
 * @remarks
 * «Резервируемый остаток» — общий паттерн: есть пара `(available, reserved)`,
 * и величина переносится из одной части в другую. Проверка переносимой
 * величины одна и та же независимо от того, деньги это (`Balance`) или
 * токены исхода (`TokenBalance`):
 *
 * 1. величина конечна;
 * 2. величина строго положительна;
 * 3. величина не превышает пул, из которого изымается.
 *
 * До объединения существовали ЧЕТЫРЕ копии этого алгоритма
 * (`ValidateReserveAmount` и `ValidateReleaseAmount` в двух доменах),
 * совпадавшие построчно. Отличались они только именами полей, словами в
 * сообщениях и словарём причин — то есть конфигурацией, а не логикой.
 *
 * Копии успели разойтись: в ошибке нехватки три правила кладут величину в
 * ключ `requested`, а `balance/ValidateReleaseAmount` — в `releaseAmount`.
 * Расхождение сохранено параметром {@link ReservablePolicy.insufficientAmountField}:
 * ключи контекста закреплены тестами потребителей, и молча сменить их
 * значило бы сменить контракт.
 */
import { Result, Ok, Err } from '@polymarket/result';
import type { AnyTradingError, ErrorConstructor } from '@polymarket/errors';
import { ErrorSource } from '@polymarket/errors';
import type { DecimalValue } from '../numeric/DecimalValue.js';

/**
 * Описание домена для правила резервируемой величины.
 *
 * @typeParam TError - Тип ошибки домена
 */
export interface ReservablePolicy<TError extends AnyTradingError> {
  /** Конструктор ошибки домена */
  readonly ErrorConstructor: ErrorConstructor<TError>;

  /** Ключ переносимой величины: `'reserveAmount'`, `'releaseQty'`, ... */
  readonly amountField: string;

  /** Ключ пула-источника: `'available'` при резерве, `'reserved'` при возврате */
  readonly limitField: string;

  /** Как величина называется в сообщении: `'Reserve quantity'` */
  readonly label: string;

  /** Глагол операции в сообщении о нехватке: `'reserve'`, `'release'` */
  readonly verb: string;

  /** Как пул называется в сообщении о нехватке: `'available'`, `'reserved'` */
  readonly limitLabel: string;

  /** Причина «величина не число или не положительна» */
  readonly invalidFormatReason: string;

  /** Причина «в пуле недостаточно» */
  readonly insufficientReason: string;

  /**
   * Ключ величины в ошибке нехватки.
   *
   * @remarks
   * По умолчанию `'requested'`. Задаётся явно там, где историческая копия
   * положила величину в другой ключ, — см. докблок модуля.
   */
  readonly insufficientAmountField?: string;
}

/**
 * Проверяет величину, изымаемую из пула.
 *
 * @param amount - Переносимая величина
 * @param limit - Пул, из которого она изымается
 * @param policy - Описание домена: тип ошибки, имена полей, словарь причин
 * @returns `Ok(void)` либо ошибку домена с причиной отказа
 * @throws Никогда — все ошибки в `Result`
 *
 * @remarks
 * Порядок проверок значим: конечность до положительности, иначе `NaN`
 * прошёл бы сравнение `<= 0` как `false` и был бы принят за корректную
 * величину.
 *
 * Совпадение величины с пулом (`amount === limit`) — законный случай:
 * зарезервировать можно всё доступное целиком.
 *
 * @example
 * ```typescript
 * const RESERVE: ReservablePolicy<InvalidBalanceError> = {
 *   ErrorConstructor: InvalidBalanceError,
 *   amountField: 'reserveAmount',
 *   limitField: 'available',
 *   label: 'Reserve amount',
 *   verb: 'reserve',
 *   limitLabel: 'available',
 *   invalidFormatReason: BalanceErrorReason.INVALID_FORMAT,
 *   insufficientReason: BalanceErrorReason.INSUFFICIENT_FUNDS,
 * };
 *
 * validateReservableAmount(money, balance.available(), RESERVE);
 * ```
 */
export function validateReservableAmount<TError extends AnyTradingError>(
  amount: DecimalValue,
  limit: DecimalValue,
  policy: ReservablePolicy<TError>,
): Result<void, TError> {
  const value = amount.value();
  const limitValue = limit.value();

  const fail = (
    message: string,
    reason: string,
    amountKey: string,
  ): Result<void, TError> =>
    Err(
      new policy.ErrorConstructor(message, {
        context: {
          source: ErrorSource.RULE_VALIDATION,
          reason,
          [amountKey]: value.toString(),
          [policy.limitField]: limitValue.toString(),
        },
      }),
    );

  // Конечность — первой: NaN прошёл бы сравнение `<= 0` как false
  if (!value.isFinite()) {
    return fail(
      `${policy.label} must be finite`,
      policy.invalidFormatReason,
      policy.amountField,
    );
  }

  if (value.lessThanOrEqualTo(0)) {
    return fail(
      `${policy.label} must be positive, got ${value.toString()}`,
      policy.invalidFormatReason,
      policy.amountField,
    );
  }

  // Равенство законно: изъять весь пул целиком можно
  if (value.greaterThan(limitValue)) {
    return fail(
      `Cannot ${policy.verb} ${value.toString()}: only ${limitValue.toString()} ${policy.limitLabel}`,
      policy.insufficientReason,
      policy.insufficientAmountField ?? 'requested',
    );
  }

  return Ok(undefined);
}

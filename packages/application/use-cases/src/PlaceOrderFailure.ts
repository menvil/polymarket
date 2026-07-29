/**
 * Типизированные failure-коды размещения ордера (boundary use-case ↔ execution).
 *
 * @remarks
 * ### Зачем:
 * Раньше execution-слой (`ExecutionEngine`) классифицировал ошибки размещения
 * по `error.message` (regex/`includes`) — это fail-open: любое сообщение со
 * словом «defer»/«marketable» считалось benign post-only reject, а retry
 * при SELL-отклонении запускался по распарсенному из текста балансу даже при
 * неоднозначном исходе submit. Теперь классификация ТИПИЗИРОВАНА:
 *
 * 1. Venue-специфичные тексты классифицирует ТОЛЬКО infrastructure adapter
 *    (см. `SubmitRejectionCode` в `@polymarket/ports`).
 * 2. `PlaceOrderUseCase` конвертирует typed venue-исход в
 *    {@link PlaceOrderFailureError} с {@link PlaceFailureCode}.
 * 3. Execution-слой переключается ТОЛЬКО по коду через
 *    {@link getPlaceFailureCode} / {@link getPlaceFailureBalance} и НИКОГДА
 *    не читает `error.message` для принятия retry/safety-решений.
 *
 * ### Семантика кодов:
 * - `POST_ONLY_WOULD_TAKE` — post-only ордер был бы исполнен немедленно и
 *   потому отклонён venue. Единственный код, допускающий benign skip.
 * - `INSUFFICIENT_TOKEN_BALANCE` — venue ОПРЕДЕЛЁННО отклонил SELL из-за
 *   нехватки токенов. Выставляется ТОЛЬКО из definite REJECTED-исхода;
 *   `balance` (числовая metadata) обязателен для автоматического dust-retry.
 * - `INSUFFICIENT_ALLOWANCE` — не выставлен token allowance/approval.
 * - `DEFINITELY_REJECTED` — venue определённо отклонил ордер (live-ордера
 *   нет), причина не классифицирована.
 * - `SUBMISSION_OUTCOME_UNKNOWN` — исход submit неоднозначен (transport
 *   MAY_HAVE_BEEN_SUBMITTED, venue UNKNOWN, prior UNKNOWN submission):
 *   venue-ордер МОГ быть создан. НИКАКОЙ автоматический retry не допустим.
 * - `RISK_REJECTED` — отклонено риск-проверкой (см. `RiskViolationError`).
 * - `PORTFOLIO_UNAVAILABLE` — Portfolio не инициализирован/недоступен.
 * - `OTHER` — прочие ошибки (guard-блокировки, journal, CAS-конфликты).
 *
 * @example
 * ```typescript
 * const result = await placeOrderUseCase.execute(input);
 * if (!result.ok) {
 *   const code = getPlaceFailureCode(result.error);
 *   if (code === 'POST_ONLY_WOULD_TAKE') {
 *     // benign skip — post-only не встал в стакан
 *   }
 * }
 * ```
 */
import type Decimal from 'decimal.js';
import { TradingError } from '@polymarket/errors';
import { RiskViolationError } from '@polymarket/risk';

/** Типизированный код неуспеха размещения ордера. */
export type PlaceFailureCode =
  | 'POST_ONLY_WOULD_TAKE'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'DEFINITELY_REJECTED'
  | 'SUBMISSION_OUTCOME_UNKNOWN'
  | 'RISK_REJECTED'
  | 'PORTFOLIO_UNAVAILABLE'
  | 'OTHER';

/**
 * Числовая metadata venue-отклонения по балансу (микроединицы, 1e6).
 *
 * @remarks
 * Копия структуры `SubmitRejectionBalanceMetadata` из ports — Decimal, не
 * строки: значения приходят из авторитетного структурированного ответа venue
 * (классифицированы в infrastructure adapter), а не парсятся из текста.
 */
export interface PlaceFailureBalanceMetadata {
  /** Фактический on-chain баланс (микроединицы). */
  readonly onChainBalanceMicro: Decimal;
  /** Требуемый объём ордера (микроединицы). */
  readonly orderAmountMicro: Decimal;
}

/**
 * Ошибка размещения ордера с типизированным failure-кодом.
 *
 * @remarks
 * Расширяет `TradingError`, поэтому обратно совместима с существующим
 * `PlaceOrderError = TradingError | RiskViolationError`. Execution-слой
 * извлекает код через {@link getPlaceFailureCode}, а не instanceof-каскады.
 */
export class PlaceOrderFailureError extends TradingError {
  /** Типизированный код неуспеха (см. {@link PlaceFailureCode}). */
  public readonly failureCode: PlaceFailureCode;
  /** Числовая balance-metadata (только для `INSUFFICIENT_TOKEN_BALANCE`). */
  public readonly balance?: PlaceFailureBalanceMetadata;

  /**
   * @param failureCode - Типизированный код неуспеха
   * @param message - Человекочитаемое сообщение (English)
   * @param options - Опции: `context` (диагностика) и `balance`
   *   (числовая metadata для INSUFFICIENT_TOKEN_BALANCE)
   */
  constructor(
    failureCode: PlaceFailureCode,
    message: string,
    options?: {
      readonly context?: Record<string, unknown>;
      readonly balance?: PlaceFailureBalanceMetadata;
    },
  ) {
    super(message, { code: failureCode, context: options?.context });
    this.failureCode = failureCode;
    this.balance = options?.balance;
  }
}

/**
 * Извлекает типизированный failure-код из ошибки размещения.
 *
 * @param error - Ошибка из `PlaceOrderUseCase.execute()` (`Err`-ветка)
 * @returns Код неуспеха; `OTHER` для нетипизированных ошибок
 *
 * @remarks
 * Единственный санкционированный способ классификации ошибок размещения в
 * execution-слое. `RiskViolationError` маппится в `RISK_REJECTED`.
 *
 * @example
 * ```typescript
 * if (!result.ok && getPlaceFailureCode(result.error) === 'RISK_REJECTED') { ... }
 * ```
 */
export function getPlaceFailureCode(error: Error): PlaceFailureCode {
  if (error instanceof PlaceOrderFailureError) {
    return error.failureCode;
  }
  if (error instanceof RiskViolationError) {
    return 'RISK_REJECTED';
  }
  return 'OTHER';
}

/**
 * Извлекает числовую balance-metadata из ошибки размещения.
 *
 * @param error - Ошибка из `PlaceOrderUseCase.execute()` (`Err`-ветка)
 * @returns Metadata (микроединицы) либо `undefined`, если её нет
 *
 * @remarks
 * Возвращает значение ТОЛЬКО для `PlaceOrderFailureError` с заполненным
 * `balance` (то есть для definite `INSUFFICIENT_TOKEN_BALANCE` от venue).
 * Никогда не парсит `error.message`.
 */
export function getPlaceFailureBalance(error: Error): PlaceFailureBalanceMetadata | undefined {
  if (error instanceof PlaceOrderFailureError) {
    return error.balance;
  }
  return undefined;
}

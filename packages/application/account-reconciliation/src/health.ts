/**
 * Health сверки аккаунта — отдельно от `AccountHotState`.
 *
 * @remarks
 * Health отвечает на вопрос «подтверждено ли локальное состояние аккаунта
 * authoritative-источником», а не «сколько у нас денег». Поэтому он НЕ живёт
 * ни в `AccountHotState`, ни в `Portfolio`:
 *
 * ```text
 * AccountHotState       факты об аккаунте, строятся ТОЛЬКО из событий
 * reconciliation health результат наших попыток эти факты подтвердить
 * ```
 *
 * Смешать их значило бы дать проекции второго писателя (координатор) и
 * сделать replay событий зависимым от того, удавались ли когда-то запросы к
 * источнику.
 *
 * ### Статусы
 *
 * ```text
 * INITIALIZING  успешной сверки ещё не было
 * READY         последняя завершённая сверка успешна (включая no-op)
 * UNHEALTHY     последняя завершённая сверка отказала
 * ```
 *
 * Конфликт версий завершённой сверкой не считается: снимок устарел, и
 * координатор сразу делает свежий проход. Статус он не меняет — ни в
 * `UNHEALTHY`, ни в `READY`.
 *
 * Health — текущее состояние, а не история: хранится последний исход, а не
 * лента попыток. Время — только от инъецированных часов.
 */
import type { AccountId, VenueId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import { AccountScopedMap } from './accountScopedMap.js';
import type { AccountReconciliationFailure, AccountReconciliationFailureCode } from './errors.js';
import type { AccountReconciliationTrigger } from './trigger.js';

/** Состояние сверки одного аккаунта. */
export type AccountReconciliationHealthStatus = 'INITIALIZING' | 'READY' | 'UNHEALTHY';

/**
 * Health сверки одного аккаунта — immutable snapshot.
 *
 * @remarks
 * Каждое обновление заменяет запись целиком, поэтому потребитель, получивший
 * её, видит согласованный набор полей и не увидит, как они меняются под ним.
 *
 * `failureCode`/`failureReason` описывают ТЕКУЩИЙ отказ и есть только в
 * `UNHEALTHY`; успешная сверка их снимает. `lastFailureAt` остаётся — это
 * время последнего отказа, а не признак текущего.
 *
 * @example
 * ```typescript
 * const health = coordinator.health().get(venueId, accountId);
 * if (health.status !== 'READY') {
 *   // состояние аккаунта не подтверждено источником
 * }
 * ```
 */
export interface AccountReconciliationHealth {
  /** Текущий статус сверки */
  readonly status: AccountReconciliationHealthStatus;
  /** Причина последнего начатого прохода */
  readonly lastTrigger?: AccountReconciliationTrigger;
  /** Когда начался последний проход, включая отброшенный из-за конфликта версий */
  readonly lastAttemptAt?: Timestamp;
  /** Когда последний раз сверка завершилась успешно (в том числе no-op) */
  readonly lastSuccessAt?: Timestamp;
  /** Когда последний раз сверка отказала */
  readonly lastFailureAt?: Timestamp;
  /** Вид текущего отказа — только в `UNHEALTHY` */
  readonly failureCode?: AccountReconciliationFailureCode;
  /** Текст текущего отказа — только в `UNHEALTHY` */
  readonly failureReason?: string;
}

/**
 * Health сверки — только чтение.
 *
 * @example
 * ```typescript
 * coordinator.health().get(venueId, accountId).status; // → 'INITIALIZING'
 * ```
 */
export interface AccountReconciliationHealthView {
  /**
   * Health аккаунта.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns Текущий health; для аккаунта, по которому сверку ещё не
   *   запрашивали, — `INITIALIZING`
   *
   * @remarks
   * Ответ определён для ЛЮБОГО аккаунта, а не `undefined` для незнакомого:
   * иначе потребитель мог бы принять «ничего не известно» за «всё хорошо».
   * Незнакомый аккаунт не подтверждён — это и есть `INITIALIZING`.
   */
  get(venueId: VenueId, accountId: AccountId): AccountReconciliationHealth;
}

/** Health аккаунта, по которому ещё не было ни одного прохода. */
const INITIAL_HEALTH: AccountReconciliationHealth = Object.freeze({ status: 'INITIALIZING' });

/**
 * Изменяемое хранилище health.
 *
 * @remarks
 * НЕ экспортируется из пакета: единственный писатель — координатор, наружу
 * уходит только {@link AccountReconciliationHealthView}.
 */
export class AccountReconciliationHealthState implements AccountReconciliationHealthView {
  private readonly _records = new AccountScopedMap<AccountReconciliationHealth>();

  /** {@inheritDoc AccountReconciliationHealthView.get} */
  public get(venueId: VenueId, accountId: AccountId): AccountReconciliationHealth {
    return this._records.get(venueId, accountId) ?? INITIAL_HEALTH;
  }

  /**
   * Отмечает начало прохода.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param trigger - Причина прохода
   * @param at - Время по инъецированным часам
   *
   * @remarks
   * Статус не меняется: начатый проход ещё ничего не подтвердил и ничего не
   * опроверг.
   */
  public recordAttempt(
    venueId: VenueId,
    accountId: AccountId,
    trigger: AccountReconciliationTrigger,
    at: Timestamp,
  ): void {
    this._records.set(venueId, accountId, {
      ...this.get(venueId, accountId),
      lastTrigger: trigger,
      lastAttemptAt: at,
    });
  }

  /**
   * Отмечает успешную сверку — применённую или no-op.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param at - Время по инъецированным часам
   */
  public recordSuccess(venueId: VenueId, accountId: AccountId, at: Timestamp): void {
    // Текущего отказа больше нет — его описание снимается; время последнего
    // отказа остаётся историей.
    const { failureCode: _code, failureReason: _reason, ...rest } = this.get(venueId, accountId);
    this._records.set(venueId, accountId, { ...rest, status: 'READY', lastSuccessAt: at });
  }

  /**
   * Отмечает отказ сверки.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param failure - Отказ прохода (конфликт версий сюда не попадает)
   * @param at - Время по инъецированным часам
   */
  public recordFailure(
    venueId: VenueId,
    accountId: AccountId,
    failure: AccountReconciliationFailure,
    at: Timestamp,
  ): void {
    this._records.set(venueId, accountId, {
      ...this.get(venueId, accountId),
      status: 'UNHEALTHY',
      lastFailureAt: at,
      failureCode: failure.failureCode,
      failureReason: failure.message,
    });
  }
}

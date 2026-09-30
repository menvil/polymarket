/**
 * Планирование проходов сверки: per-account single-flight + coalescing.
 *
 * @remarks
 * ```text
 * request(A) ──► проход A#1 идёт
 * request(A) ─┐
 * request(A)  ├► requestedAgain = true   (10 запросов → ОДИН следующий проход)
 * request(A) ─┘
 *              проход A#1 завершён ──► ОДИН свежий проход A#2
 *                                      (новые запросы во время A#2 → A#3, …)
 *
 * request(B) ──► проход B#1 идёт параллельно с A — аккаунты независимы
 * ```
 *
 * ### Почему не запускать проход на каждый запрос
 *
 * Параллельные проходы одного аккаунта читали бы источник наперегонки, и
 * каждый, кроме первого, почти наверняка упёрся бы в конфликт версий, созданный
 * соседом. Запросы, пришедшие во время прохода, не могут быть обслужены им —
 * он уже начал читать источник РАНЬШЕ них, — поэтому они сливаются в один
 * следующий, свежий проход.
 *
 * ### Конфликт версий — свежий проход, а не повтор
 *
 * ```text
 * проход прочитал version 100
 * живое событие          → version 101
 * RECONCILED(expected = 100) → AccountReconciliationVersionConflictError
 * ```
 *
 * Координатор НЕ ставит `UNHEALTHY` (это нормальная гонка), НЕ публикует тот
 * же снимок повторно (он устарел) и помечает `requestedAgain`: следующий
 * проход заново читает и версию, и источник. Запросы, ожидавшие отброшенного
 * прохода, переходят к следующему — отброшенный проход ничего не подтвердил.
 *
 * Серия конфликтов ограничена `maxConsecutiveVersionConflicts`: аккаунт,
 * который живой контур меняет быстрее, чем источник успевает ответить, иначе
 * держал бы координатор в бесконечной петле запросов к источнику. По
 * исчерпании ожидающие получают последний конфликт, health не меняется, и
 * решение о следующем запросе остаётся за рантаймом.
 *
 * ### Чего здесь нет
 *
 * Таймеров, cron, каденций, backoff и startup-хуков: координатор только
 * выполняет запросы. Когда запрашивать `STARTUP`, как часто `PERIODIC` и что
 * считать `RECONNECT` — решает будущий runtime wiring.
 */
import { AccountReconciliationVersionConflictError } from '@polymarket/account-state';
import type { AccountId, VenueId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import { AccountScopedMap } from './accountScopedMap.js';
import type { AccountReconciler, AccountReconciliationPassResult } from './AccountReconciler.js';
import {
  AccountReconciliationHealthState,
  type AccountReconciliationHealthView,
} from './health.js';
import type { AccountReconciliationTrigger } from './trigger.js';

/**
 * Серия конфликтов версий подряд, после которой координатор прекращает
 * свежие проходы по текущим запросам.
 *
 * @remarks
 * Предохранитель от бесконечной петли, а не каденция: при обычной работе
 * конфликт случается редко и снимается следующим же проходом.
 */
export const DEFAULT_MAX_CONSECUTIVE_VERSION_CONFLICTS = 3;

/** Зависимости координатора. */
export interface AccountReconciliationCoordinatorOptions {
  /** Выполняет один проход сверки */
  readonly reconciler: Pick<AccountReconciler, 'reconcile'>;
  /** Инъецированные часы — единственный источник времени health */
  readonly clock: IClock;
  /**
   * Предел конфликтов версий подряд для одной серии запросов.
   *
   * @defaultValue {@link DEFAULT_MAX_CONSECUTIVE_VERSION_CONFLICTS}
   */
  readonly maxConsecutiveVersionConflicts?: number;
}

/** Ожидающий запрос: получит исход прохода, который его обслужит. */
interface Waiter {
  readonly resolve: (result: AccountReconciliationPassResult) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Планировочное состояние одного аккаунта.
 *
 * @remarks
 * `requestedAgain` — тот самый dirty-флаг: пока идёт проход, любой новый
 * запрос или конфликт версий взводит его, и цикл делает ещё один проход.
 */
interface AccountSlot {
  /** Идёт ли сейчас цикл проходов этого аккаунта */
  running: boolean;
  /** Нужен ли ещё один свежий проход после текущего */
  requestedAgain: boolean;
  /** Запросы, пришедшие после начала текущего прохода */
  waiting: Waiter[];
  /** Причина самого свежего из этих запросов */
  nextTrigger: AccountReconciliationTrigger | undefined;
}

/**
 * Координирует проходы сверки по аккаунтам и ведёт их health.
 *
 * @example
 * ```typescript
 * const coordinator = AccountReconciliationCoordinator.create({ reconciler, clock });
 * const result = await coordinator.request(venueId, accountId, 'STARTUP');
 * coordinator.health().get(venueId, accountId).status; // → 'READY' | 'UNHEALTHY' | 'INITIALIZING'
 * ```
 */
export class AccountReconciliationCoordinator {
  private readonly _slots = new AccountScopedMap<AccountSlot>();
  private readonly _health = new AccountReconciliationHealthState();
  private readonly _maxConflicts: number;

  private constructor(private readonly _options: AccountReconciliationCoordinatorOptions) {
    this._maxConflicts =
      _options.maxConsecutiveVersionConflicts ?? DEFAULT_MAX_CONSECUTIVE_VERSION_CONFLICTS;
  }

  /**
   * Создаёт координатор.
   *
   * @param options - Reconciler, часы и предел конфликтов
   * @returns Координатор без запущенных проходов
   * @throws {RangeError} Если предел конфликтов не положительное целое
   *
   * @example
   * ```typescript
   * const coordinator = AccountReconciliationCoordinator.create({ reconciler, clock });
   * ```
   */
  public static create(options: AccountReconciliationCoordinatorOptions): AccountReconciliationCoordinator {
    const max = options.maxConsecutiveVersionConflicts;
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
      throw new RangeError(`maxConsecutiveVersionConflicts must be a positive integer, got ${max}`);
    }
    return new AccountReconciliationCoordinator(options);
  }

  /**
   * Health сверки — только чтение.
   *
   * @returns Проекция health по всем аккаунтам
   */
  public health(): AccountReconciliationHealthView {
    return this._health;
  }

  /**
   * Запрашивает сверку аккаунта.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param trigger - Причина запроса (для health)
   * @returns Исход ПЕРВОГО прохода, начавшегося после этого запроса и не
   *   отброшенного из-за конфликта версий; конфликт — только при исчерпании
   *   предела
   *
   * @remarks
   * Если по аккаунту уже идёт проход, новый не запускается: запрос ставится
   * в ожидание, и после текущего выполняется ОДИН свежий проход на все
   * накопившиеся запросы.
   *
   * Promise никогда не отвергается из-за отказа сверки — отказ приходит как
   * `Err`. Отвергается он только при дефекте, выпущенном самим reconciler'ом
   * наружу вопреки контракту.
   *
   * `Ok` резолвится только после того, как коррекция ЭТОГО прохода прошла
   * critical-проектор (`IEventBus.publishConfirmed()`). Поэтому ждать
   * `request()` из handler'а шины нельзя: подтверждённая публикация ждала бы
   * drain, который держит сам handler.
   *
   * @example
   * ```typescript
   * const result = await coordinator.request(venueId, accountId, 'RECONNECT');
   * if (!result.ok) logger.warn('Account reconciliation failed', { code: result.error.message });
   * ```
   */
  public request(
    venueId: VenueId,
    accountId: AccountId,
    trigger: AccountReconciliationTrigger,
  ): Promise<AccountReconciliationPassResult> {
    const slot = this._slots.getOrCreate(venueId, accountId, () => ({
      running: false,
      requestedAgain: false,
      waiting: [],
      nextTrigger: undefined,
    }));

    return new Promise<AccountReconciliationPassResult>((resolve, reject) => {
      slot.waiting.push({ resolve, reject });
      slot.nextTrigger = trigger;
      slot.requestedAgain = true;
      if (!slot.running) {
        slot.running = true;
        void this._drive(venueId, accountId, slot, trigger);
      }
    });
  }

  /**
   * Цикл проходов одного аккаунта: пока `requestedAgain` — ещё один проход.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param slot - Планировочное состояние аккаунта
   * @param firstTrigger - Причина запроса, запустившего цикл
   *
   * @remarks
   * ```text
   * while requestedAgain:
   *   requestedAgain = false
   *   взять ожидающих (+ перенесённых после конфликта)
   *   проход
   *   конфликт версий и предел не исчерпан → перенести ожидающих, requestedAgain = true
   *   иначе → health, отдать исход ожидающим
   * ```
   *
   * Проверка условия цикла и `running = false` выполняются одним синхронным
   * участком после последнего `await`: запрос, пришедший между ними, не может
   * потеряться — он либо увидит `running = true` и взведёт флаг, либо
   * запустит новый цикл сам.
   */
  private async _drive(
    venueId: VenueId,
    accountId: AccountId,
    slot: AccountSlot,
    firstTrigger: AccountReconciliationTrigger,
  ): Promise<void> {
    let carried: Waiter[] = [];
    let trigger = firstTrigger;
    let conflicts = 0;

    try {
      while (slot.requestedAgain) {
        slot.requestedAgain = false;
        const waiters = [...carried, ...slot.waiting];
        slot.waiting = [];
        carried = [];
        // Повтор после конфликта сохраняет причину исходного запроса; новые
        // запросы приносят свою.
        trigger = slot.nextTrigger ?? trigger;
        slot.nextTrigger = undefined;

        this._health.recordAttempt(venueId, accountId, trigger, this._now());
        let result: AccountReconciliationPassResult;
        try {
          result = await this._options.reconciler.reconcile(venueId, accountId);
        } catch (error) {
          // Дефект reconciler'а, а не отказ сверки: ожидающие обязаны узнать о
          // нём, а не зависнуть навсегда.
          for (const waiter of [...waiters, ...slot.waiting]) waiter.reject(error);
          slot.waiting = [];
          slot.requestedAgain = false;
          return;
        }

        if (result.ok) {
          conflicts = 0;
          this._health.recordSuccess(venueId, accountId, this._now());
          settle(waiters, result);
          continue;
        }

        const failure = result.error;
        if (failure instanceof AccountReconciliationVersionConflictError) {
          conflicts += 1;
          if (conflicts < this._maxConflicts) {
            // Устаревший снимок отброшен. Никто из ожидающих не обслужен —
            // все переходят к свежему проходу.
            carried = waiters;
            slot.requestedAgain = true;
            continue;
          }
          // Предел исчерпан: health не меняется — конфликт не отказ.
          conflicts = 0;
          settle(waiters, result);
          continue;
        }

        conflicts = 0;
        this._health.recordFailure(venueId, accountId, failure, this._now());
        settle(waiters, result);
      }
    } finally {
      slot.running = false;
    }
  }

  /**
   * Текущее время по инъецированным часам.
   *
   * @returns Момент для записи в health
   */
  private _now(): Timestamp {
    return TimestampService.now(this._options.clock);
  }
}

/**
 * Отдаёт исход прохода всем запросам, которые он обслужил.
 *
 * @param waiters - Обслуженные запросы
 * @param result - Исход прохода
 */
function settle(waiters: readonly Waiter[], result: AccountReconciliationPassResult): void {
  for (const waiter of waiters) waiter.resolve(result);
}

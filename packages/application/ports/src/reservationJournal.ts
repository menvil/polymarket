/**
 * Reservation journal — учёт жизненного цикла резервации капитала под ордер.
 *
 * @remarks
 * `OrderSubmissionRecord` теперь не только idempotency guard, но и **recovery
 * journal** для резервации: сколько капитала (USDC для BUY, токенов для SELL)
 * было заморожено под ордер, сколько уже потреблено fill-ами, сколько
 * освобождено при отмене/коррекции, и сколько ещё held.
 *
 * Значения хранятся строками (exact decimal representation) — чтобы порт не
 * навязывал `Decimal` персистентным адаптерам. Вся арифметика инкапсулирована в
 * чистых функциях этого модуля (используют `Decimal` внутри).
 *
 * ### Инвариант учёта (ВСЕГДА):
 * ```
 * initial = remaining + consumed + released
 * ```
 *
 * ### Held определяется вычислимо, НЕ отдельным boolean:
 * резервация held, если `remaining > 0` и `status ∉ {NONE, SETTLED}` — см.
 * {@link hasHeldReservation}. Отдельный `reservationHeld: boolean` намеренно НЕ
 * вводится (легко рассинхронизируется с amount-ами).
 */
import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';

/** Вид зарезервированного актива. */
export type ReservationKind = 'USDC' | 'TOKENS';

/** Сторона ордера (для reservation kind и recovery-расчёта fill). */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Статус резервации.
 *
 * @remarks
 * - `NONE` — резервация ещё не создана (сразу после `begin()`).
 * - `HELD` — капитал заморожен полностью, потребления не было.
 * - `PARTIALLY_SETTLED` — часть потреблена/освобождена, остаток ещё held.
 * - `SETTLED` — остаток ноль (`remaining === 0`): резервации больше нет.
 * - `RECONCILIATION_REQUIRED` — учёт неоднозначен (сбой release/consume после
 *   частичного commit): требуется ручная реконсиляция, авто-переход запрещён.
 */
export type ReservationStatus =
  | 'NONE'
  | 'HELD'
  | 'PARTIALLY_SETTLED'
  | 'SETTLED'
  | 'RECONCILIATION_REQUIRED';

/** Снимок учёта резервации (exact decimal — строки). */
export interface ReservationSnapshot {
  readonly kind: ReservationKind;
  /** Исходно зарезервированное количество. */
  readonly initial: string;
  /** Остаток, всё ещё held. */
  readonly remaining: string;
  /** Уже потреблено fill-ами. */
  readonly consumed: string;
  /** Освобождено при отмене/коррекции размера. */
  readonly released: string;
  readonly status: ReservationStatus;
}

/** Код ошибки reservation transition. */
export type ReservationTransitionCode =
  | 'NEGATIVE_AMOUNT'
  | 'OVER_CONSUME'
  | 'INVARIANT_VIOLATION'
  | 'RECONCILIATION_LOCKED';

/** Ошибка reservation transition (нарушение инварианта учёта). */
export class ReservationTransitionError extends Error {
  public readonly code: ReservationTransitionCode;

  /**
   * @param code - Код ошибки
   * @param message - Человекочитаемое описание (English)
   */
  constructor(code: ReservationTransitionCode, message: string) {
    super(message);
    this.name = 'ReservationTransitionError';
    this.code = code;
  }
}

/** Дельта reservation transition (потребление/освобождение + опц. статус). */
export interface ReservationDelta {
  /** Потреблено этой операцией (decimal-строка, >= 0). */
  readonly consume?: string;
  /** Освобождено этой операцией (decimal-строка, >= 0). */
  readonly release?: string;
  /**
   * Явный статус (например `RECONCILIATION_REQUIRED`). Если не задан — статус
   * вычисляется из остатка: `remaining === 0 → SETTLED`, иначе если было
   * потребление/освобождение → `PARTIALLY_SETTLED`, иначе `HELD`.
   */
  readonly status?: ReservationStatus;
}

/**
 * Создаёт пустой снимок резервации (`NONE`, все суммы ноль).
 *
 * @param kind - Вид актива (USDC для BUY, TOKENS для SELL)
 * @returns Снимок со статусом `NONE`
 *
 * @example
 * ```typescript
 * const snap = emptyReservation('USDC'); // initial=0, remaining=0, status='NONE'
 * ```
 */
export function emptyReservation(kind: ReservationKind): ReservationSnapshot {
  return { kind, initial: '0', remaining: '0', consumed: '0', released: '0', status: 'NONE' };
}

/**
 * Создаёт снимок полностью held резервации.
 *
 * @param kind - Вид актива
 * @param initial - Зарезервированное количество (decimal-строка)
 * @returns `Ok` со снимком `HELD` (`remaining === initial`) или
 *   `Err(ReservationTransitionError)` с кодом `NEGATIVE_AMOUNT`, если `initial < 0`
 *
 * @example
 * ```typescript
 * const result = heldReservation('USDC', '65');
 * if (result.ok) {
 *   const snap = result.value; // initial=65, remaining=65, status='HELD'
 * }
 * ```
 */
export function heldReservation(
  kind: ReservationKind,
  initial: string,
): Result<ReservationSnapshot, ReservationTransitionError> {
  const init = new Decimal(initial);
  if (init.isNegative()) {
    return Err(new ReservationTransitionError('NEGATIVE_AMOUNT', `heldReservation: initial must be >= 0, got ${initial}`));
  }
  return Ok({
    kind,
    initial: init.toString(),
    remaining: init.toString(),
    consumed: '0',
    released: '0',
    status: init.isZero() ? 'SETTLED' : 'HELD',
  });
}

/**
 * Проверяет, есть ли ещё held-резервация (капитал, который может быть потреблён).
 *
 * @param snapshot - Снимок резервации
 * @returns `true`, если `remaining > 0` и статус не `NONE`/`SETTLED`
 *
 * @remarks
 * Именно этот предикат (а не отдельный boolean-флаг) — источник истины про
 * held: он не может рассинхронизироваться с amount-ами.
 */
export function hasHeldReservation(snapshot: ReservationSnapshot): boolean {
  if (snapshot.status === 'NONE' || snapshot.status === 'SETTLED') return false;
  return new Decimal(snapshot.remaining).greaterThan(0);
}

/**
 * Проверяет, можно ли АВТОМАТИЧЕСКИ потребить held-резервацию (fill path).
 *
 * @param snapshot - Снимок резервации
 * @returns `true` только для `HELD`/`PARTIALLY_SETTLED` при `remaining > 0`
 *
 * @remarks
 * Отличие от {@link hasHeldReservation}: `RECONCILIATION_REQUIRED` здесь
 * ВСЕГДА `false` — резервация в неоднозначном состоянии никогда не должна
 * автоматически потребляться held-fill path (только ручная реконсиляция).
 * `hasHeldReservation` остаётся ответом на вопрос «капитал ещё заморожен?»
 * (включая reconciliation), этот предикат — «можно ли его авто-потребить?».
 */
export function canConsumeHeldReservation(snapshot: ReservationSnapshot): boolean {
  if (snapshot.status !== 'HELD' && snapshot.status !== 'PARTIALLY_SETTLED') return false;
  return new Decimal(snapshot.remaining).greaterThan(0);
}

/**
 * Применяет дельту к снимку резервации, проверяя инварианты учёта.
 *
 * Алгоритм:
 * 0. `RECONCILIATION_REQUIRED` — заблокирован для авто-переходов: любая дельта
 *    возвращает `Err(RECONCILIATION_LOCKED)`, кроме идемпотентного re-mark
 *    (без сумм, `status: 'RECONCILIATION_REQUIRED'`).
 * 1. `consume`/`release` неотрицательны.
 * 2. `consume + release <= remaining` (нельзя потребить/освободить больше остатка).
 * 3. Новый `remaining = remaining − consume − release`;
 *    `consumed += consume`; `released += release`.
 * 4. Проверка `initial === remaining + consumed + released`.
 * 5. Статус: явный из дельты, иначе `remaining === 0 → SETTLED`,
 *    иначе (если была активность) `PARTIALLY_SETTLED`, иначе `HELD`.
 * 6. Консистентность статус↔суммы: `SETTLED` требует `remaining === 0`;
 *    `HELD`/`PARTIALLY_SETTLED` требуют `remaining > 0`; `NONE` требует
 *    нулевых сумм — иначе `Err(INVARIANT_VIOLATION)`.
 *
 * @param snapshot - Текущий снимок
 * @param delta - Потребление/освобождение + опц. статус
 * @returns `Ok` с новым снимком или `Err(ReservationTransitionError)`
 *
 * @example
 * ```typescript
 * const held = heldReservation('USDC', '65');
 * const r = applyReservationDelta(held, { consume: '65' });
 * // r.value: remaining=0, consumed=65, status='SETTLED'
 * ```
 */
export function applyReservationDelta(
  snapshot: ReservationSnapshot,
  delta: ReservationDelta,
): Result<ReservationSnapshot, ReservationTransitionError> {
  const consume = new Decimal(delta.consume ?? '0');
  const release = new Decimal(delta.release ?? '0');

  // Шаг 0: RECONCILIATION_REQUIRED — терминален для автоматики. Разрешён ТОЛЬКО
  // идемпотентный re-mark (без сумм, тот же статус); любой consume/release или
  // смена статуса требует ручной реконсиляции вне журнала.
  if (snapshot.status === 'RECONCILIATION_REQUIRED') {
    if (delta.status === 'RECONCILIATION_REQUIRED' && consume.isZero() && release.isZero()) {
      return Ok(snapshot);
    }
    return Err(new ReservationTransitionError(
      'RECONCILIATION_LOCKED',
      'Reservation is RECONCILIATION_REQUIRED: automatic transitions are forbidden, manual reconciliation required',
    ));
  }

  if (consume.isNegative() || release.isNegative()) {
    return Err(new ReservationTransitionError(
      'NEGATIVE_AMOUNT',
      `Reservation delta must be non-negative: consume=${consume.toString()} release=${release.toString()}`,
    ));
  }

  const remaining = new Decimal(snapshot.remaining);
  const total = consume.plus(release);
  if (total.greaterThan(remaining)) {
    return Err(new ReservationTransitionError(
      'OVER_CONSUME',
      `Reservation delta exceeds remaining: consume+release=${total.toString()} > remaining=${remaining.toString()}`,
    ));
  }

  const newRemaining = remaining.minus(total);
  const newConsumed = new Decimal(snapshot.consumed).plus(consume);
  const newReleased = new Decimal(snapshot.released).plus(release);
  const initial = new Decimal(snapshot.initial);

  // Инвариант учёта: initial = remaining + consumed + released.
  if (!newRemaining.plus(newConsumed).plus(newReleased).equals(initial)) {
    return Err(new ReservationTransitionError(
      'INVARIANT_VIOLATION',
      `Reservation invariant violated: remaining(${newRemaining})+consumed(${newConsumed})+released(${newReleased}) != initial(${initial})`,
    ));
  }

  const status = delta.status ?? deriveStatus(newRemaining, consume, release, snapshot);

  // Шаг 6: консистентность статус↔суммы. Запрещённые состояния (см. task 1.5):
  // SETTLED при remaining > 0; HELD/PARTIALLY_SETTLED при remaining === 0;
  // NONE при ненулевых суммах.
  const consistencyError = validateStatusAmountConsistency(status, {
    initial, remaining: newRemaining, consumed: newConsumed, released: newReleased,
  });
  if (consistencyError) return Err(consistencyError);

  return Ok({
    kind: snapshot.kind,
    initial: initial.toString(),
    remaining: newRemaining.toString(),
    consumed: newConsumed.toString(),
    released: newReleased.toString(),
    status,
  });
}

/**
 * Проверяет консистентность статуса резервации и её сумм.
 *
 * @param status - Проверяемый статус
 * @param amounts - Суммы после применения дельты
 * @returns `ReservationTransitionError` при нарушении, иначе `undefined`
 *
 * @remarks
 * Запрещённые состояния: `SETTLED` при `remaining > 0`; `HELD`/
 * `PARTIALLY_SETTLED` при `remaining === 0`; `NONE` при любых ненулевых
 * суммах. `RECONCILIATION_REQUIRED` допускает любые суммы (снимок сомнителен
 * по определению).
 */
function validateStatusAmountConsistency(
  status: ReservationStatus,
  amounts: { initial: Decimal; remaining: Decimal; consumed: Decimal; released: Decimal },
): ReservationTransitionError | undefined {
  const { initial, remaining, consumed, released } = amounts;
  if (status === 'SETTLED' && !remaining.isZero()) {
    return new ReservationTransitionError(
      'INVARIANT_VIOLATION',
      `Status SETTLED requires remaining === 0, got remaining=${remaining.toString()}`,
    );
  }
  if ((status === 'HELD' || status === 'PARTIALLY_SETTLED') && remaining.isZero()) {
    return new ReservationTransitionError(
      'INVARIANT_VIOLATION',
      `Status ${status} requires remaining > 0, got remaining=0`,
    );
  }
  if (status === 'NONE' && (!initial.isZero() || !remaining.isZero() || !consumed.isZero() || !released.isZero())) {
    return new ReservationTransitionError(
      'INVARIANT_VIOLATION',
      'Status NONE requires all amounts to be zero',
    );
  }
  return undefined;
}

/**
 * Вычисляет статус резервации из остатка и активности дельты.
 *
 * @param newRemaining - Новый остаток
 * @param consume - Потреблено этой дельтой
 * @param release - Освобождено этой дельтой
 * @param prev - Предыдущий снимок (для сохранения PARTIALLY_SETTLED)
 * @returns Вычисленный статус
 */
function deriveStatus(
  newRemaining: Decimal,
  consume: Decimal,
  release: Decimal,
  prev: ReservationSnapshot,
): ReservationStatus {
  if (newRemaining.isZero()) return 'SETTLED';
  const hadActivity = consume.greaterThan(0) || release.greaterThan(0)
    || prev.status === 'PARTIALLY_SETTLED';
  return hadActivity ? 'PARTIALLY_SETTLED' : 'HELD';
}

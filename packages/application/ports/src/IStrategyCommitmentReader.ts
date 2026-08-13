/**
 * Порт: authoritative reader незавершённых trading commitments стратегии.
 *
 * @remarks
 * ### Зачем:
 * `IOrderStateStore.getOpenOrders(strategyId)` доказывает только отсутствие
 * ЛОКАЛЬНО сохранённых Order — но не отсутствие commitment вообще:
 * - `submission UNKNOWN` — venue мог принять заявку, исход неоднозначен;
 * - `VENUE_ACCEPTED` — venue создал ордер, но локальный Order ещё не сохранён
 *   (крэш между submit и save);
 * - `SUBMITTING` — submit ещё физически не завершился (в т.ч. после restart —
 *   recovery submission ещё не материализована как Order);
 * - `reservation.status === RECONCILIATION_REQUIRED` — капитал зарезервирован,
 *   но journal не может автоматически разрешить его судьбу;
 * - unsettled fills (venue in-flight / application processing / manual
 *   reconciliation block / terminal settlement pending) — см.
 *   `IOrderStateStore.hasUnsettledFills`.
 *
 * `StrategyScheduler` использует этот порт как ДОПОЛНИТЕЛЬНЫЙ (не заменяющий)
 * post-check к `getOpenOrders()` перед тем, как объявить стратегию безопасно
 * остановленной и удалить её entry.
 *
 * ### Что это НЕ:
 * Не новый параллельный source of truth — реализация (см.
 * `SubmissionJournalStrategyCommitmentReader` в `@polymarket/use-cases`)
 * читает существующий `IOrderSubmissionRepository` (submission/reservation
 * journal) и `IOrderStateStore` (unsettled fills), не дублируя их логику.
 */
import type { AccountId, InstrumentId, StrategyId } from '@polymarket/ids';

/**
 * Вид незавершённого commitment.
 *
 * @remarks
 * - `OPEN_ORDER` — локально сохранённый Order всё ещё открыт (обычно
 *   обнаруживается отдельно через `getOpenOrders` — но допустим в единой
 *   metadata-модели для консистентной отчётности).
 * - `SUBMISSION_IN_PROGRESS` — submission journal: submit ещё физически не
 *   завершился (`SUBMITTING`), в т.ч. после restart (recovery).
 * - `UNKNOWN_SUBMISSION` — submission journal: ambiguous исход (`UNKNOWN`).
 * - `VENUE_ACCEPTED_SUBMISSION` — venue создал ордер, локальный Order ещё не
 *   сохранён (`VENUE_ACCEPTED`).
 * - `RECONCILIATION_REQUIRED` — reservation journal требует ручной реконсиляции.
 * - `UNSETTLED_FILL` — venue in-flight fill / application processing block /
 *   manual reconciliation block / terminal settlement pending на инструменте.
 */
export type StrategyCommitmentKind =
  | 'OPEN_ORDER'
  | 'SUBMISSION_IN_PROGRESS'
  | 'UNKNOWN_SUBMISSION'
  | 'VENUE_ACCEPTED_SUBMISSION'
  | 'RECONCILIATION_REQUIRED'
  | 'UNSETTLED_FILL';

/**
 * Один незавершённый commitment стратегии.
 */
export interface StrategyCommitment {
  /** Вид commitment (см. {@link StrategyCommitmentKind}). */
  readonly kind: StrategyCommitmentKind;
  /** Идентификатор записи (clientOrderId, orderId, instrumentId — зависит от kind). */
  readonly id: string;
  /** Инструмент, если применимо. */
  readonly instrumentId?: InstrumentId;
}

/**
 * Порт: authoritative чтение активных commitments стратегии.
 */
export interface IStrategyCommitmentReader {
  /**
   * Возвращает все незавершённые commitments стратегии.
   *
   * @param input - `strategyId`/`accountId` — владелец; `instrumentIds` —
   *   инструменты, для которых проверяются unsettled fills (primary +
   *   complementary регистрации)
   * @returns Readonly массив commitments (пустой, если ничего не найдено)
   *
   * @remarks
   * НЕ глотает исключения — реализация может бросить (например, если
   * `IOrderSubmissionRepository` недоступен). Caller (`StrategyScheduler`)
   * обязан обрабатывать это fail-closed: исключение = «есть commitments»,
   * а не «commitments отсутствуют».
   */
  getActiveCommitments(input: {
    readonly strategyId: StrategyId;
    readonly accountId: AccountId;
    readonly instrumentIds: readonly InstrumentId[];
  }): Promise<readonly StrategyCommitment[]>;
}

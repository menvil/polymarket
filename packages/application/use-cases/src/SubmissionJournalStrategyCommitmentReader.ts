/**
 * SubmissionJournalStrategyCommitmentReader — authoritative reader
 * незавершённых commitments стратегии поверх submission/reservation journal.
 *
 * @remarks
 * Реализует `IStrategyCommitmentReader` (`@polymarket/ports`) БЕЗ дублирования
 * логики: читает существующий `IOrderSubmissionRepository` (submission guard +
 * reservation journal) и `IOrderStateStore.hasUnsettledFills` (venue in-flight /
 * application processing / manual reconciliation / terminal settlement).
 *
 * ### Алгоритм:
 * 1. Для каждого известного `OrderSubmissionStatus` — `listByStatus(status)`,
 *    фильтр по `record.strategyId === strategyId` и `record.accountId`.
 * 2. `SUBMITTING` → `SUBMISSION_IN_PROGRESS`; `UNKNOWN` → `UNKNOWN_SUBMISSION`;
 *    `VENUE_ACCEPTED` → `VENUE_ACCEPTED_SUBMISSION` (остальные статусы сами по
 *    себе НЕ commitment — но их reservation ниже проверяется тоже).
 * 3. Независимо от submission-статуса: `record.reservation.status ===
 *    'RECONCILIATION_REQUIRED'` → `RECONCILIATION_REQUIRED` commitment
 *    (COMMITTED-ордер с desync резервацией — отдельная ось от submission status).
 * 4. Для каждого `instrumentId` из входа: `orderStateStore.hasUnsettledFills`
 *    → `UNSETTLED_FILL`.
 *
 * НЕ глотает исключения — `IOrderSubmissionRepository`/`IOrderStateStore`
 * ошибки пробрасываются caller-у (fail-closed по контракту порта).
 *
 * @example
 * ```typescript
 * const reader = new SubmissionJournalStrategyCommitmentReader({
 *   submissions: orderSubmissionRepo,
 *   orderStateStore: orderRepo,
 *   logger,
 * });
 * const commitments = await reader.getActiveCommitments({
 *   strategyId, accountId, instrumentIds: [instrumentId, complementaryInstrumentId],
 * });
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId, InstrumentId } from '@polymarket/ids';
import { accountIdEquals } from '@polymarket/ids';
import type {
  IStrategyCommitmentReader,
  StrategyCommitment,
  StrategyCommitmentKind,
  IOrderSubmissionRepository,
  OrderSubmissionStatus,
  IOrderStateStore,
} from '@polymarket/ports';

/** Статусы submission journal, которые сканируются на предмет commitments. */
const SCANNED_STATUSES: readonly OrderSubmissionStatus[] = [
  'SUBMITTING',
  'VENUE_ACCEPTED',
  'UNKNOWN',
  'COMMITTED',
  'FAILED',
  'CANCELLED',
];

/** Submission-статусы, сами по себе являющиеся unresolved commitment. */
const STATUS_TO_KIND: ReadonlyMap<OrderSubmissionStatus, StrategyCommitmentKind> = new Map([
  ['SUBMITTING', 'SUBMISSION_IN_PROGRESS'],
  ['UNKNOWN', 'UNKNOWN_SUBMISSION'],
  ['VENUE_ACCEPTED', 'VENUE_ACCEPTED_SUBMISSION'],
]);

/** Зависимости {@link SubmissionJournalStrategyCommitmentReader}. */
export interface SubmissionJournalStrategyCommitmentReaderDeps {
  readonly submissions: IOrderSubmissionRepository;
  /** Достаточно `hasUnsettledFills` — reader не читает/не мутирует остальной IOrderStateStore. */
  readonly orderStateStore: Pick<IOrderStateStore, 'hasUnsettledFills'>;
  readonly logger: ILogger;
}

/**
 * Сравнение AccountId с защитой от legacy/test string-представлений.
 *
 * @remarks
 * `accountIdEquals` ожидает настоящие AccountId-объекты (`{kind, ...}`) — для
 * raw-строкового representation (legacy/test-паттерн, см. аналогичный
 * `ExecutionEngine._sameAccount`) оба объекта имеют `kind === undefined` и
 * попадают в общий `return false` — ДАЖЕ для двух ОДИНАКОВЫХ строк. Поэтому
 * raw-строки сравниваются отдельно, напрямую.
 */
function sameAccount(a: AccountId, b: AccountId): boolean {
  if (typeof (a as unknown) === 'string' || typeof (b as unknown) === 'string') {
    return String(a) === String(b);
  }
  return accountIdEquals(a, b);
}

export class SubmissionJournalStrategyCommitmentReader implements IStrategyCommitmentReader {
  private readonly _logger: ILogger;

  constructor(private readonly _deps: SubmissionJournalStrategyCommitmentReaderDeps) {
    this._logger = _deps.logger.child({ component: 'SubmissionJournalStrategyCommitmentReader' });
  }

  public async getActiveCommitments(input: {
    readonly strategyId: string;
    readonly accountId: AccountId;
    readonly instrumentIds: readonly InstrumentId[];
  }): Promise<readonly StrategyCommitment[]> {
    const commitments: StrategyCommitment[] = [];

    for (const status of SCANNED_STATUSES) {
      const records = await this._deps.submissions.listByStatus(status);
      for (const record of records) {
        if (record.strategyId !== input.strategyId) continue;
        if (!sameAccount(record.accountId, input.accountId)) continue;

        const kind = STATUS_TO_KIND.get(status);
        if (kind !== undefined) {
          commitments.push({ kind, id: String(record.clientOrderId), instrumentId: record.instrumentId });
        }

        if (record.reservation.status === 'RECONCILIATION_REQUIRED') {
          commitments.push({
            kind: 'RECONCILIATION_REQUIRED',
            id: String(record.clientOrderId),
            instrumentId: record.instrumentId,
          });
        }
      }
    }

    for (const instrumentId of input.instrumentIds) {
      if (this._deps.orderStateStore.hasUnsettledFills(instrumentId)) {
        commitments.push({ kind: 'UNSETTLED_FILL', id: String(instrumentId), instrumentId });
      }
    }

    if (commitments.length > 0) {
      this._logger.warn('SubmissionJournalStrategyCommitmentReader: active commitments found', {
        strategyId: input.strategyId,
        count: commitments.length,
        kinds: commitments.map((c) => c.kind),
      });
    }

    return commitments;
  }
}

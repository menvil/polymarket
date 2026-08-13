import { describe, it, expect, jest } from '@jest/globals';
import { unsafeStrategyId } from '@polymarket/ids';
import { Ok } from '@polymarket/result';
import { asOrderId, asInstrumentId } from '@polymarket/ids';
import type { AccountId } from '@polymarket/ids';
import type {
  IOrderSubmissionRepository,
  OrderSubmissionRecord,
  OrderSubmissionStatus,
} from '@polymarket/ports';
import { SubmissionJournalStrategyCommitmentReader } from '../src/SubmissionJournalStrategyCommitmentReader.js';

const STRATEGY_ID = unsafeStrategyId('strategy-1');
const OTHER_STRATEGY_ID = unsafeStrategyId('strategy-2');
const ACCOUNT_ID = 'venue:POLYMARKET:test' as unknown as AccountId;
const OTHER_ACCOUNT_ID = 'venue:POLYMARKET:other' as unknown as AccountId;
const INSTRUMENT_ID = asInstrumentId('111')!;
const CLIENT_ORDER_ID = asOrderId('client-order-1')!;

const fn = jest.fn as any;

function makeLogger() {
  return {
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(),
    warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

function makeRecord(overrides: Partial<OrderSubmissionRecord> = {}): OrderSubmissionRecord {
  return {
    clientOrderId: CLIENT_ORDER_ID,
    venueOrderId: undefined,
    status: 'COMMITTED',
    accountId: ACCOUNT_ID,
    instrumentId: INSTRUMENT_ID,
    attempt: 1,
    fingerprint: 'fp',
    side: 'BUY',
    orderPrice: '0.5',
    requestedSize: '10',
    reservation: {
      kind: 'USDC',
      initial: '5',
      remaining: '0',
      consumed: '5',
      released: '0',
      status: 'SETTLED',
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    strategyId: STRATEGY_ID,
    ...overrides,
  } as OrderSubmissionRecord;
}

/** Полный fake IOrderSubmissionRepository — только listByStatus реально используется тестами. */
function makeSubmissions(byStatus: Partial<Record<OrderSubmissionStatus, OrderSubmissionRecord[]>> = {}): IOrderSubmissionRepository {
  return {
    begin: fn().mockResolvedValue({ outcome: 'ACQUIRED' }),
    markReservationHeld: fn().mockResolvedValue(Ok(makeRecord())),
    setEffectiveSize: fn().mockResolvedValue(undefined),
    applyReservationTransition: fn().mockResolvedValue(Ok(makeRecord())),
    findByVenueOrderId: fn().mockResolvedValue(undefined),
    markVenueAccepted: fn().mockResolvedValue(undefined),
    markCommitted: fn().mockResolvedValue(undefined),
    markUnknown: fn().mockResolvedValue(undefined),
    markFailed: fn().mockResolvedValue(undefined),
    markCancelled: fn().mockResolvedValue(undefined),
    get: fn().mockResolvedValue(undefined),
    listByStatus: fn().mockImplementation(async (status: OrderSubmissionStatus) => byStatus[status] ?? []),
    getPendingBuyQuantityForInstrument: fn().mockResolvedValue(Ok(0)),
  };
}

function makeOrderStateStore(hasUnsettled = false) {
  return {
    hasUnsettledFills: fn().mockReturnValue(hasUnsettled),
  };
}

describe('SubmissionJournalStrategyCommitmentReader', () => {
  it('пусто, если нет ни submissions, ни unsettled fills', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions(),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toEqual([]);
  });

  it('UNKNOWN submission нашей стратегии → UNKNOWN_SUBMISSION', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions({
        UNKNOWN: [makeRecord({ status: 'UNKNOWN', strategyId: STRATEGY_ID })],
      }),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ kind: 'UNKNOWN_SUBMISSION', instrumentId: INSTRUMENT_ID });
  });

  it('VENUE_ACCEPTED submission нашей стратегии → VENUE_ACCEPTED_SUBMISSION', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions({
        VENUE_ACCEPTED: [makeRecord({ status: 'VENUE_ACCEPTED', strategyId: STRATEGY_ID })],
      }),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ kind: 'VENUE_ACCEPTED_SUBMISSION' });
  });

  it('SUBMITTING нашей стратегии → SUBMISSION_IN_PROGRESS', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions({
        SUBMITTING: [makeRecord({ status: 'SUBMITTING', strategyId: STRATEGY_ID })],
      }),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ kind: 'SUBMISSION_IN_PROGRESS' });
  });

  it('reservation RECONCILIATION_REQUIRED на COMMITTED записи → RECONCILIATION_REQUIRED', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions({
        COMMITTED: [makeRecord({
          status: 'COMMITTED',
          strategyId: STRATEGY_ID,
          reservation: {
            kind: 'USDC', initial: '5', remaining: '5', consumed: '0', released: '0',
            status: 'RECONCILIATION_REQUIRED',
          },
        })],
      }),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ kind: 'RECONCILIATION_REQUIRED' });
  });

  it('unsettled fill на инструменте → UNSETTLED_FILL', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions(),
      orderStateStore: makeOrderStateStore(true),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toMatchObject({ kind: 'UNSETTLED_FILL', instrumentId: INSTRUMENT_ID });
  });

  it('записи ДРУГОЙ стратегии игнорируются', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions({
        UNKNOWN: [makeRecord({ status: 'UNKNOWN', strategyId: OTHER_STRATEGY_ID })],
      }),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toEqual([]);
  });

  it('записи ДРУГОГО аккаунта игнорируются', async () => {
    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions: makeSubmissions({
        UNKNOWN: [makeRecord({ status: 'UNKNOWN', strategyId: STRATEGY_ID, accountId: OTHER_ACCOUNT_ID })],
      }),
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    const commitments = await reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    });

    expect(commitments).toEqual([]);
  });

  it('пробрасывает exception из submissions.listByStatus (fail-closed — caller обязан трактовать как commitments)', async () => {
    const submissions = makeSubmissions();
    (submissions.listByStatus as any).mockRejectedValue(new Error('journal unavailable'));

    const reader = new SubmissionJournalStrategyCommitmentReader({
      submissions,
      orderStateStore: makeOrderStateStore(false),
      logger: makeLogger() as any,
    });

    await expect(reader.getActiveCommitments({
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
      instrumentIds: [INSTRUMENT_ID],
    })).rejects.toThrow('journal unavailable');
  });
});

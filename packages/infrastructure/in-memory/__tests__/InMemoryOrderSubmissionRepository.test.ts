import { describe, it, expect, beforeEach } from '@jest/globals';
import { asOrderId, asInstrumentId } from '@polymarket/ids';
import type { AccountId } from '@polymarket/ids';
import { InMemoryOrderSubmissionRepository } from '../src/InMemoryOrderSubmissionRepository.js';

const CLIENT_ID = asOrderId('client-1')!;
const VENUE_ID = asOrderId('venue-1')!;
const ACCOUNT_ID = 'acc-1' as unknown as AccountId;
const INSTRUMENT_ID = asInstrumentId('123')!;
const NOW = new Date('2024-01-01T00:00:00.000Z');

function makeBeginInput(now = NOW) {
  return { clientOrderId: CLIENT_ID, accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID, now };
}

describe('InMemoryOrderSubmissionRepository', () => {
  let repo: InMemoryOrderSubmissionRepository;

  beforeEach(() => {
    repo = new InMemoryOrderSubmissionRepository();
  });

  it('begin() новый clientOrderId → ACQUIRED, статус SUBMITTING', async () => {
    const result = await repo.begin(makeBeginInput());
    expect(result.outcome).toBe('ACQUIRED');
    const record = await repo.get(CLIENT_ID);
    expect(record?.status).toBe('SUBMITTING');
    expect(record?.accountId).toBe(ACCOUNT_ID);
  });

  it('begin() на SUBMITTING → IN_PROGRESS', async () => {
    await repo.begin(makeBeginInput());
    const result = await repo.begin(makeBeginInput());
    expect(result.outcome).toBe('IN_PROGRESS');
  });

  it('markCommitted → begin() возвращает ALREADY_COMMITTED с venueOrderId', async () => {
    await repo.begin(makeBeginInput());
    await repo.markCommitted(CLIENT_ID, VENUE_ID, NOW);

    const result = await repo.begin(makeBeginInput());
    expect(result.outcome).toBe('ALREADY_COMMITTED');
    if (result.outcome === 'ALREADY_COMMITTED') {
      expect(result.record.venueOrderId).toBe(VENUE_ID);
      expect(result.record.status).toBe('COMMITTED');
    }
  });

  it('markUnknown → begin() возвращает UNKNOWN (блокирует авто-retry)', async () => {
    await repo.begin(makeBeginInput());
    await repo.markUnknown(CLIENT_ID, 'ambiguous', undefined, NOW);

    const result = await repo.begin(makeBeginInput());
    expect(result.outcome).toBe('UNKNOWN');
    if (result.outcome === 'UNKNOWN') {
      expect(result.record.reason).toBe('ambiguous');
    }
  });

  it('markFailed → begin() возвращает FAILED_RETRYABLE и переводит в SUBMITTING', async () => {
    await repo.begin(makeBeginInput());
    await repo.markFailed(CLIENT_ID, 'rejected', NOW);

    const result = await repo.begin(makeBeginInput(new Date('2024-01-02T00:00:00.000Z')));
    expect(result.outcome).toBe('FAILED_RETRYABLE');
    if (result.outcome === 'FAILED_RETRYABLE') {
      expect(result.record.status).toBe('FAILED'); // прежняя запись
    }
    // После retry-begin запись снова SUBMITTING.
    const after = await repo.get(CLIENT_ID);
    expect(after?.status).toBe('SUBMITTING');
  });

  it('mark* для неизвестного clientOrderId — no-op (не бросает)', async () => {
    await expect(repo.markCommitted(asOrderId('unknown')!, VENUE_ID, NOW)).resolves.toBeUndefined();
    expect(await repo.get(asOrderId('unknown')!)).toBeUndefined();
  });

  it('get() возвращает snapshot с клонированными Date (мутация не влияет на хранилище)', async () => {
    await repo.begin(makeBeginInput());
    const record = await repo.get(CLIENT_ID);
    record?.createdAt.setFullYear(2030);
    const again = await repo.get(CLIENT_ID);
    expect(again?.createdAt.getFullYear()).toBe(2024);
  });

  it('clear() очищает хранилище', async () => {
    await repo.begin(makeBeginInput());
    repo.clear();
    expect(await repo.get(CLIENT_ID)).toBeUndefined();
  });
});

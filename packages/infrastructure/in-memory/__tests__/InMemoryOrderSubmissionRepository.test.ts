import { describe, it, expect, beforeEach } from '@jest/globals';
import { asOrderId, asInstrumentId } from '@polymarket/ids';
import type { AccountId } from '@polymarket/ids';
import { InMemoryOrderSubmissionRepository } from '../src/InMemoryOrderSubmissionRepository.js';

const CLIENT_ID = asOrderId('client-1')!;
const VENUE_ID = asOrderId('venue-1')!;
const ACCOUNT_ID = 'acc-1' as unknown as AccountId;
const INSTRUMENT_ID = asInstrumentId('123')!;
const NOW = new Date('2024-01-01T00:00:00.000Z');
const FINGERPRINT = 'acc-1|123|token-1|BUY|0.65|10|LIMIT|false|strat-1';

function makeBeginInput(now = NOW, fingerprint = FINGERPRINT) {
  return {
    clientOrderId: CLIENT_ID,
    accountId: ACCOUNT_ID,
    instrumentId: INSTRUMENT_ID,
    fingerprint,
    side: 'BUY' as const,
    orderPrice: '0.65',
    requestedSize: '10',
    now,
  };
}

describe('InMemoryOrderSubmissionRepository', () => {
  let repo: InMemoryOrderSubmissionRepository;

  beforeEach(() => {
    repo = new InMemoryOrderSubmissionRepository();
  });

  it('begin() новый clientOrderId → ACQUIRED, статус SUBMITTING, сохраняет fingerprint', async () => {
    const result = await repo.begin(makeBeginInput());
    expect(result.outcome).toBe('ACQUIRED');
    const record = await repo.get(CLIENT_ID);
    expect(record?.status).toBe('SUBMITTING');
    expect(record?.accountId).toBe(ACCOUNT_ID);
    expect(record?.fingerprint).toBe(FINGERPRINT);
  });

  it('begin() с другим fingerprint → FINGERPRINT_MISMATCH (проверяется ПЕРВОЙ, даже после COMMITTED)', async () => {
    await repo.begin(makeBeginInput());
    await repo.markCommitted(CLIENT_ID, VENUE_ID, NOW);

    const result = await repo.begin(makeBeginInput(NOW, 'different-fingerprint'));
    expect(result.outcome).toBe('FINGERPRINT_MISMATCH');
    if (result.outcome === 'FINGERPRINT_MISMATCH') {
      expect(result.expectedFingerprint).toBe(FINGERPRINT);
      expect(result.actualFingerprint).toBe('different-fingerprint');
      // Запись НЕ тронута — прежний COMMITTED статус и venueOrderId сохранены.
      expect(result.record.status).toBe('COMMITTED');
      expect(result.record.venueOrderId).toBe(VENUE_ID);
    }
  });

  it('markVenueAccepted → begin() возвращает VENUE_ACCEPTED с venueOrderId', async () => {
    await repo.begin(makeBeginInput());
    await repo.markVenueAccepted(CLIENT_ID, VENUE_ID, NOW);

    const result = await repo.begin(makeBeginInput());
    expect(result.outcome).toBe('VENUE_ACCEPTED');
    if (result.outcome === 'VENUE_ACCEPTED') {
      expect(result.record.venueOrderId).toBe(VENUE_ID);
      expect(result.record.status).toBe('VENUE_ACCEPTED');
    }
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

  it('markCancelled → begin() ВСЕГДА возвращает CANCELLED_NO_RESUBMIT (в отличие от FAILED — retry запрещён навсегда, held-резервация не влияет)', async () => {
    await repo.begin(makeBeginInput());
    await repo.markVenueAccepted(CLIENT_ID, VENUE_ID, NOW);
    await repo.markCancelled(CLIENT_ID, 'operator cancelled bound venue order', NOW);

    const result = await repo.begin(makeBeginInput(new Date('2024-01-02T00:00:00.000Z')));
    expect(result.outcome).toBe('CANCELLED_NO_RESUBMIT');
    if (result.outcome === 'CANCELLED_NO_RESUBMIT') {
      expect(result.record.status).toBe('CANCELLED');
      expect(result.record.venueOrderId).toBe(VENUE_ID);
    }
    // Запись НЕ переведена в SUBMITTING (в отличие от FAILED_RETRYABLE) —
    // терминальный статус сохраняется.
    const after = await repo.get(CLIENT_ID);
    expect(after?.status).toBe('CANCELLED');
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

  it('begin() создаёт reservation со статусом NONE и экономическими параметрами', async () => {
    await repo.begin(makeBeginInput());
    const record = await repo.get(CLIENT_ID);
    expect(record?.side).toBe('BUY');
    expect(record?.orderPrice).toBe('0.65');
    expect(record?.requestedSize).toBe('10');
    expect(record?.reservation).toMatchObject({
      kind: 'USDC',
      initial: '0',
      remaining: '0',
      consumed: '0',
      released: '0',
      status: 'NONE',
    });
  });

  // ── Reverse lookup ──────────────────────────────────────────────────────────

  describe('findByVenueOrderId (reverse lookup)', () => {
    it('после markVenueAccepted находит запись по venueOrderId', async () => {
      await repo.begin(makeBeginInput());
      await repo.markVenueAccepted(CLIENT_ID, VENUE_ID, NOW);

      const found = await repo.findByVenueOrderId(VENUE_ID);
      expect(found?.clientOrderId).toBe(CLIENT_ID);
      expect(found?.venueOrderId).toBe(VENUE_ID);
    });

    it('после markCommitted находит запись по venueOrderId', async () => {
      await repo.begin(makeBeginInput());
      await repo.markCommitted(CLIENT_ID, VENUE_ID, NOW);
      const found = await repo.findByVenueOrderId(VENUE_ID);
      expect(found?.clientOrderId).toBe(CLIENT_ID);
    });

    it('неизвестный venueOrderId → undefined', async () => {
      expect(await repo.findByVenueOrderId(asOrderId('nope')!)).toBeUndefined();
    });

    it('один venueOrderId не может принадлежать двум clientOrderId (бросает)', async () => {
      const CLIENT_2 = asOrderId('client-2')!;
      await repo.begin(makeBeginInput());
      await repo.markVenueAccepted(CLIENT_ID, VENUE_ID, NOW);
      await repo.begin({ ...makeBeginInput(), clientOrderId: CLIENT_2, fingerprint: 'fp2' });
      await expect(repo.markVenueAccepted(CLIENT_2, VENUE_ID, NOW)).rejects.toThrow(/already mapped/);
    });

    it('clear() очищает и обратный индекс', async () => {
      await repo.begin(makeBeginInput());
      await repo.markCommitted(CLIENT_ID, VENUE_ID, NOW);
      repo.clear();
      expect(await repo.findByVenueOrderId(VENUE_ID)).toBeUndefined();
    });
  });

  // ── Reservation journal ─────────────────────────────────────────────────────

  describe('reservation journal', () => {
    beforeEach(async () => {
      await repo.begin(makeBeginInput());
    });

    it('markReservationHeld → HELD, remaining === initial, инвариант выполнен', async () => {
      const r = await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      expect(r.ok).toBe(true);
      const record = await repo.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({
        initial: '65', remaining: '65', consumed: '0', released: '0', status: 'HELD',
      });
    });

    it('partial consume → PARTIALLY_SETTLED, инвариант initial = remaining+consumed+released', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '30', now: NOW });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.reservation).toMatchObject({
          initial: '65', remaining: '35', consumed: '30', released: '0', status: 'PARTIALLY_SETTLED',
        });
      }
    });

    it('partial release → PARTIALLY_SETTLED', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'excess', release: '13', now: NOW });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.reservation).toMatchObject({ remaining: '52', released: '13', status: 'PARTIALLY_SETTLED' });
      }
    });

    it('полное потребление → SETTLED (remaining === 0)', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '65', now: NOW });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.reservation).toMatchObject({ remaining: '0', consumed: '65', status: 'SETTLED' });
      }
    });

    it('consume больше remaining → OVER_CONSUME Err, запись не меняется', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '100', now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('OVER_CONSUME');
      const record = await repo.get(CLIENT_ID);
      expect(record?.reservation.remaining).toBe('65'); // не тронута
    });

    it('отрицательная сумма → NEGATIVE_AMOUNT Err', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '-5', now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NEGATIVE_AMOUNT');
    });

    it('повторный transition с тем же operationId идемпотентен (не удваивает)', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '30', now: NOW });
      const r2 = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '30', now: NOW });
      expect(r2.ok).toBe(true);
      const record = await repo.get(CLIENT_ID);
      // consumed остался 30, не 60.
      expect(record?.reservation).toMatchObject({ consumed: '30', remaining: '35' });
    });

    it('два разных operationId полностью закрывают резервацию', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-1', consume: '40', now: NOW });
      const r = await repo.applyReservationTransition(CLIENT_ID, { operationId: 'fill-2', consume: '25', now: NOW });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.reservation).toMatchObject({ remaining: '0', consumed: '65', status: 'SETTLED' });
    });

    it('явный статус RECONCILIATION_REQUIRED без consume/release', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'reconcile', status: 'RECONCILIATION_REQUIRED', now: NOW,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.reservation).toMatchObject({ remaining: '65', status: 'RECONCILIATION_REQUIRED' });
      }
    });

    it('setEffectiveSize фиксирует effectiveSize', async () => {
      await repo.setEffectiveSize(CLIENT_ID, '8', NOW);
      const record = await repo.get(CLIENT_ID);
      expect(record?.effectiveSize).toBe('8');
    });
  });

  // ── Attempt + safe retry (Этап 1) ───────────────────────────────────────────

  describe('attempt + safe retry', () => {
    it('новая запись начинается с attempt = 1', async () => {
      await repo.begin(makeBeginInput());
      const record = await repo.get(CLIENT_ID);
      expect(record?.attempt).toBe(1);
    });

    it('FAILED + HELD не даёт retry → RECONCILIATION_REQUIRED', async () => {
      await repo.begin(makeBeginInput());
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.markFailed(CLIENT_ID, 'submit failed', NOW);

      const result = await repo.begin(makeBeginInput());
      expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
      // Запись не тронута: статус FAILED, attempt не увеличен.
      const record = await repo.get(CLIENT_ID);
      expect(record?.status).toBe('FAILED');
      expect(record?.attempt).toBe(1);
      expect(record?.reservation.status).toBe('HELD');
    });

    it('FAILED + PARTIALLY_SETTLED не даёт retry → RECONCILIATION_REQUIRED', async () => {
      await repo.begin(makeBeginInput());
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, { operationId: 'attempt:1:fill:f1', consume: '30', now: NOW });
      await repo.markFailed(CLIENT_ID, 'submit failed', NOW);

      const result = await repo.begin(makeBeginInput());
      expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    });

    it('FAILED + RECONCILIATION_REQUIRED не даёт retry', async () => {
      await repo.begin(makeBeginInput());
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:reconcile', status: 'RECONCILIATION_REQUIRED', now: NOW,
      });
      await repo.markFailed(CLIENT_ID, 'submit failed', NOW);

      const result = await repo.begin(makeBeginInput());
      expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    });

    it('FAILED + SETTLED (remaining=0) увеличивает attempt и разрешает retry', async () => {
      await repo.begin(makeBeginInput());
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:rollback:rejected', release: '65', now: NOW,
      });
      await repo.markFailed(CLIENT_ID, 'rejected', NOW);

      const result = await repo.begin(makeBeginInput());
      expect(result.outcome).toBe('FAILED_RETRYABLE');
      const record = await repo.get(CLIENT_ID);
      expect(record?.status).toBe('SUBMITTING');
      expect(record?.attempt).toBe(2);
    });

    it('FAILED + NONE (reserve не проходил) разрешает retry с attempt+1', async () => {
      await repo.begin(makeBeginInput());
      await repo.markFailed(CLIENT_ID, 'risk check failed', NOW);
      const result = await repo.begin(makeBeginInput());
      expect(result.outcome).toBe('FAILED_RETRYABLE');
      const record = await repo.get(CLIENT_ID);
      expect(record?.attempt).toBe(2);
    });

    it('operation ID предыдущего attempt не блокирует новый attempt', async () => {
      // Attempt 1: hold → rollback release → FAILED.
      await repo.begin(makeBeginInput());
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:rollback:rejected', release: '65', now: NOW,
      });
      await repo.markFailed(CLIENT_ID, 'rejected', NOW);

      // Attempt 2: retry → hold → rollback с attempt-scoped operationId.
      const retry = await repo.begin(makeBeginInput());
      expect(retry.outcome).toBe('FAILED_RETRYABLE');
      const held = await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      expect(held.ok).toBe(true);
      const rollback2 = await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:2:rollback:rejected', release: '65', now: NOW,
      });
      expect(rollback2.ok).toBe(true);
      const record = await repo.get(CLIENT_ID);
      // Второй rollback реально применился (не съеден идемпотентностью attempt 1).
      expect(record?.reservation).toMatchObject({ remaining: '0', released: '65', status: 'SETTLED' });
    });

    it('SETTLED → HELD без увеличения attempt запрещён (та же попытка)', async () => {
      await repo.begin(makeBeginInput());
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:cancel-release', release: '65', now: NOW,
      });
      // Та же попытка (attempt=1) пытается снова hold поверх SETTLED.
      const r = await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVARIANT_VIOLATION');
    });
  });

  // ── markReservationHeld: запрещённые переходы (Этап 1.3) ────────────────────

  describe('markReservationHeld: запрещённые переходы', () => {
    beforeEach(async () => {
      await repo.begin(makeBeginInput());
    });

    it('HELD → HELD идемпотентен с тем же initial', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      expect(r.ok).toBe(true);
      const record = await repo.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ initial: '65', remaining: '65', status: 'HELD' });
    });

    it('нельзя перезаписать HELD с другой суммой', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      const r = await repo.markReservationHeld(CLIENT_ID, '99', NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVARIANT_VIOLATION');
      const record = await repo.get(CLIENT_ID);
      expect(record?.reservation.initial).toBe('65'); // не тронута
    });

    it('нельзя перезаписать PARTIALLY_SETTLED', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, { operationId: 'attempt:1:fill:f1', consume: '30', now: NOW });
      const r = await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RECONCILIATION_LOCKED');
    });

    it('нельзя перезаписать RECONCILIATION_REQUIRED', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:reconcile', status: 'RECONCILIATION_REQUIRED', now: NOW,
      });
      const r = await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RECONCILIATION_LOCKED');
    });

    it('нельзя автоматически transition-ить из RECONCILIATION_REQUIRED', async () => {
      await repo.markReservationHeld(CLIENT_ID, '65', NOW);
      await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:reconcile', status: 'RECONCILIATION_REQUIRED', now: NOW,
      });
      const consume = await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:fill:f2', consume: '10', now: NOW,
      });
      expect(consume.ok).toBe(false);
      if (!consume.ok) expect(consume.error.code).toBe('RECONCILIATION_LOCKED');
      const release = await repo.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:cancel-release', release: '65', now: NOW,
      });
      expect(release.ok).toBe(false);
      if (!release.ok) expect(release.error.code).toBe('RECONCILIATION_LOCKED');
    });
  });
});

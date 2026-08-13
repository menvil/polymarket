import { describe, it, expect, beforeEach } from '@jest/globals';
import { asFillId } from '@polymarket/ids';
import { InMemoryProcessedFillRepository } from '../src/InMemoryProcessedFillRepository.js';

const FILL_1 = asFillId('fill-1')!;

describe('InMemoryProcessedFillRepository', () => {
  let repo: InMemoryProcessedFillRepository;

  beforeEach(() => {
    repo = new InMemoryProcessedFillRepository();
  });

  describe('begin()', () => {
    it('новый fillId → ACQUIRED, isRetry=false', async () => {
      const result = await repo.begin(FILL_1);
      expect(result).toEqual({ outcome: 'ACQUIRED', isRetry: false });
      expect(await repo.getStatus(FILL_1)).toBe('PROCESSING');
    });

    it('APPLIED fillId → DUPLICATE, не меняет статус', async () => {
      await repo.begin(FILL_1);
      await repo.markApplied(FILL_1);

      const result = await repo.begin(FILL_1);
      expect(result).toEqual({ outcome: 'DUPLICATE' });
      expect(await repo.getStatus(FILL_1)).toBe('APPLIED');
    });

    it('PROCESSING fillId (конкурентная обработка) → BUSY', async () => {
      await repo.begin(FILL_1); // первая обработка ещё "идёт" (PROCESSING)

      const result = await repo.begin(FILL_1);
      expect(result).toEqual({ outcome: 'BUSY' });
      // Статус не сброшен повторным begin()
      expect(await repo.getStatus(FILL_1)).toBe('PROCESSING');
    });

    it('FAILED fillId → ACQUIRED, isRetry=true (retry разрешён)', async () => {
      await repo.begin(FILL_1);
      await repo.markFailed(FILL_1, 'portfolio update failed');

      const result = await repo.begin(FILL_1);
      expect(result).toEqual({ outcome: 'ACQUIRED', isRetry: true });
      expect(await repo.getStatus(FILL_1)).toBe('PROCESSING');
    });

    it('REVERTED fillId → ACQUIRED, isRetry=true (retry разрешён)', async () => {
      await repo.begin(FILL_1);
      await repo.markApplied(FILL_1);
      await repo.markReverted(FILL_1);

      const result = await repo.begin(FILL_1);
      expect(result).toEqual({ outcome: 'ACQUIRED', isRetry: true });
    });

    it('RECONCILIATION_REQUIRED fillId → RECONCILIATION_REQUIRED, не меняет статус (retry НЕ разрешён)', async () => {
      await repo.begin(FILL_1);
      await repo.markReconciliationRequired(FILL_1, 'ORDER_PORTFOLIO_DESYNC: portfolio not found');

      const result = await repo.begin(FILL_1);
      expect(result).toEqual({ outcome: 'RECONCILIATION_REQUIRED' });
      // Повторный begin() снова RECONCILIATION_REQUIRED — не переходит в PROCESSING.
      expect(await repo.getStatus(FILL_1)).toBe('RECONCILIATION_REQUIRED');
      const second = await repo.begin(FILL_1);
      expect(second).toEqual({ outcome: 'RECONCILIATION_REQUIRED' });
    });
  });

  describe('markApplied() / markFailed() / markReverted() / markReconciliationRequired()', () => {
    it('markApplied переводит в APPLIED', async () => {
      await repo.begin(FILL_1);
      await repo.markApplied(FILL_1);
      expect(await repo.getStatus(FILL_1)).toBe('APPLIED');
    });

    it('markFailed переводит в FAILED', async () => {
      await repo.begin(FILL_1);
      await repo.markFailed(FILL_1, 'some error');
      expect(await repo.getStatus(FILL_1)).toBe('FAILED');
    });

    it('markReverted переводит в REVERTED', async () => {
      await repo.begin(FILL_1);
      await repo.markApplied(FILL_1);
      await repo.markReverted(FILL_1);
      expect(await repo.getStatus(FILL_1)).toBe('REVERTED');
    });

    it('markReconciliationRequired переводит в RECONCILIATION_REQUIRED', async () => {
      await repo.begin(FILL_1);
      await repo.markReconciliationRequired(FILL_1, 'ORDER_PORTFOLIO_DESYNC: portfolio not found');
      expect(await repo.getStatus(FILL_1)).toBe('RECONCILIATION_REQUIRED');
    });
  });

  describe('getStatus()', () => {
    it('возвращает undefined для неизвестного fillId', async () => {
      expect(await repo.getStatus(FILL_1)).toBeUndefined();
    });
  });

  describe('size и clear()', () => {
    it('size отражает количество отслеживаемых fillId', async () => {
      expect(repo.size).toBe(0);
      await repo.begin(FILL_1);
      expect(repo.size).toBe(1);
    });

    it('clear() сбрасывает все статусы', async () => {
      await repo.begin(FILL_1);
      repo.clear();
      expect(repo.size).toBe(0);
      expect(await repo.getStatus(FILL_1)).toBeUndefined();
    });
  });

  // ── PROCESSING lease (recovery зависшего worker-а) ────────────────────────

  describe('PROCESSING lease', () => {
    const T0 = new Date('2026-01-01T00:00:00.000Z');
    const lease = (nowMs: number, workerId = 'w1') => ({ workerId, now: new Date(nowMs), leaseMs: 60_000 });

    it('до истечения lease повторный begin → BUSY', async () => {
      const first = await repo.begin(FILL_1, lease(T0.getTime()));
      expect(first.outcome).toBe('ACQUIRED');
      const second = await repo.begin(FILL_1, lease(T0.getTime() + 30_000, 'w2'));
      expect(second.outcome).toBe('BUSY');
    });

    it('stale PROCESSING reclaimable после lease expiry (reclaimed=true, fencing token растёт)', async () => {
      const first = await repo.begin(FILL_1, lease(T0.getTime()));
      expect(first.outcome).toBe('ACQUIRED');
      const firstToken = first.outcome === 'ACQUIRED' ? first.leaseToken : undefined;

      // Worker w1 «завис»: lease истёк → w2 перехватывает.
      const reclaimed = await repo.begin(FILL_1, lease(T0.getTime() + 61_000, 'w2'));
      expect(reclaimed.outcome).toBe('ACQUIRED');
      if (reclaimed.outcome === 'ACQUIRED') {
        expect(reclaimed.reclaimed).toBe(true);
        expect(reclaimed.isRetry).toBe(true);
        expect(reclaimed.leaseToken).toBeGreaterThan(firstToken ?? 0);
      }
      expect(await repo.getStatus(FILL_1)).toBe('PROCESSING');
    });

    it('legacy begin без lease → PROCESSING остаётся BUSY (нет доказательства зависания)', async () => {
      await repo.begin(FILL_1); // без lease
      const second = await repo.begin(FILL_1, lease(T0.getTime() + 999_999_999));
      expect(second.outcome).toBe('BUSY');
    });

    it('терминальный mark* снимает lease; следующий begin — обычный acquire (reclaimed отсутствует)', async () => {
      await repo.begin(FILL_1, lease(T0.getTime()));
      await repo.markFailed(FILL_1, 'boom');
      const again = await repo.begin(FILL_1, lease(T0.getTime() + 1_000));
      expect(again.outcome).toBe('ACQUIRED');
      if (again.outcome === 'ACQUIRED') {
        expect(again.isRetry).toBe(true);
        expect(again.reclaimed).toBeUndefined();
      }
    });
  });
});

import { describe, it, expect, beforeEach } from '@jest/globals';
import { asFillId, asOrderId } from '@polymarket/ids';
import type { ReconciliationIssue } from '@polymarket/ports';
import { InMemoryReconciliationIssueRepository } from '../src/InMemoryReconciliationIssueRepository.js';

const FILL_1 = asFillId('fill-1')!;
const ORDER_1 = asOrderId('order-1')!;

/** Создаёт тестовую issue с переопределяемыми полями */
function makeIssue(overrides: Partial<ReconciliationIssue> = {}): ReconciliationIssue {
  return {
    id: 'reconciliation:fill:fill-1:order-portfolio-desync',
    type: 'ORDER_PORTFOLIO_DESYNC',
    status: 'OPEN',
    reason: 'ORDER_PORTFOLIO_DESYNC: portfolio not found',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    fillId: FILL_1,
    orderId: ORDER_1,
    context: { stage: 'portfolio-apply', error: 'portfolio not found' },
    ...overrides,
  };
}

describe('InMemoryReconciliationIssueRepository', () => {
  let repo: InMemoryReconciliationIssueRepository;

  beforeEach(() => {
    repo = new InMemoryReconciliationIssueRepository();
  });

  describe('add() + get()', () => {
    it('добавленная issue доступна через get() по id', async () => {
      const issue = makeIssue();
      await repo.add(issue);

      const stored = await repo.get(issue.id);
      expect(stored).toBeDefined();
      expect(stored).toEqual(issue);
      expect(repo.size).toBe(1);
    });

    it('get() неизвестного id возвращает undefined', async () => {
      expect(await repo.get('unknown-id')).toBeUndefined();
    });

    it('хранит snapshot, а не live reference — мутация исходного объекта не видна', async () => {
      const issue = makeIssue();
      await repo.add(issue);

      (issue as { reason: string }).reason = 'mutated';

      const stored = await repo.get(issue.id);
      expect(stored?.reason).toBe('ORDER_PORTFOLIO_DESYNC: portfolio not found');
    });
  });

  describe('add() идемпотентность', () => {
    it('повторный add того же id не создаёт дубль и не перезаписывает существующую issue', async () => {
      const original = makeIssue({ reason: 'original reason' });
      await repo.add(original);

      const overwriteAttempt = makeIssue({ reason: 'overwrite attempt' });
      await repo.add(overwriteAttempt);

      expect(repo.size).toBe(1);
      const stored = await repo.get(original.id);
      expect(stored?.reason).toBe('original reason');
    });
  });

  describe('listOpen()', () => {
    it('возвращает только OPEN issues, фильтруя RESOLVED', async () => {
      await repo.add(makeIssue({ id: 'issue-open-1' }));
      await repo.add(makeIssue({ id: 'issue-open-2' }));
      await repo.add(makeIssue({ id: 'issue-resolved' }));
      await repo.markResolved('issue-resolved', new Date('2024-01-02T00:00:00.000Z'));

      const open = await repo.listOpen();
      expect(open.map((i) => i.id).sort()).toEqual(['issue-open-1', 'issue-open-2']);
    });

    it('возвращает пустой массив, если issues нет', async () => {
      expect(await repo.listOpen()).toEqual([]);
    });
  });

  describe('markResolved()', () => {
    it('переводит OPEN issue в RESOLVED и проставляет resolvedAt', async () => {
      const issue = makeIssue();
      await repo.add(issue);

      const resolvedAt = new Date('2024-01-02T12:00:00.000Z');
      await repo.markResolved(issue.id, resolvedAt);

      const stored = await repo.get(issue.id);
      expect(stored?.status).toBe('RESOLVED');
      expect(stored?.resolvedAt).toEqual(resolvedAt);
    });

    it('неизвестный id — no-op, не бросает', async () => {
      await expect(repo.markResolved('unknown-id', new Date())).resolves.toBeUndefined();
      expect(repo.size).toBe(0);
    });

    it('повторный markResolved уже RESOLVED issue — no-op, первый resolvedAt сохраняется', async () => {
      const issue = makeIssue();
      await repo.add(issue);

      const firstResolvedAt = new Date('2024-01-02T00:00:00.000Z');
      await repo.markResolved(issue.id, firstResolvedAt);
      await repo.markResolved(issue.id, new Date('2024-01-03T00:00:00.000Z'));

      const stored = await repo.get(issue.id);
      expect(stored?.resolvedAt).toEqual(firstResolvedAt);
    });
  });

  describe('Date immutability', () => {
    const ORIGINAL_ISO = '2024-01-01T00:00:00.000Z';
    const MUTATED_TIME = new Date('2030-01-01T00:00:00.000Z').getTime();

    it('мутация исходного createdAt после add не влияет на stored issue', async () => {
      const createdAt = new Date(ORIGINAL_ISO);
      const issue = makeIssue({ createdAt });
      await repo.add(issue);

      createdAt.setTime(MUTATED_TIME);

      const stored = await repo.get(issue.id);
      expect(stored?.createdAt.toISOString()).toBe(ORIGINAL_ISO);
    });

    it('мутация createdAt из get() не влияет на последующий get()', async () => {
      const issue = makeIssue({ createdAt: new Date(ORIGINAL_ISO) });
      await repo.add(issue);

      const first = await repo.get(issue.id);
      first?.createdAt.setTime(MUTATED_TIME);

      const second = await repo.get(issue.id);
      expect(second?.createdAt.toISOString()).toBe(ORIGINAL_ISO);
    });

    it('мутация resolvedAt из get() не влияет на stored issue', async () => {
      const issue = makeIssue();
      await repo.add(issue);

      const resolvedIso = '2024-01-02T00:00:00.000Z';
      await repo.markResolved(issue.id, new Date(resolvedIso));

      const first = await repo.get(issue.id);
      first?.resolvedAt?.setTime(MUTATED_TIME);

      const second = await repo.get(issue.id);
      expect(second?.resolvedAt?.toISOString()).toBe(resolvedIso);
    });

    it('мутация исходного resolvedAt после markResolved не влияет на stored issue', async () => {
      const issue = makeIssue();
      await repo.add(issue);

      const resolvedIso = '2024-01-02T00:00:00.000Z';
      const resolvedAt = new Date(resolvedIso);
      await repo.markResolved(issue.id, resolvedAt);

      resolvedAt.setTime(MUTATED_TIME);

      const stored = await repo.get(issue.id);
      expect(stored?.resolvedAt?.toISOString()).toBe(resolvedIso);
    });

    it('мутация createdAt из listOpen() не влияет на stored issue', async () => {
      const issue = makeIssue({ createdAt: new Date(ORIGINAL_ISO) });
      await repo.add(issue);

      const open = await repo.listOpen();
      open[0]?.createdAt.setTime(MUTATED_TIME);

      const stored = await repo.get(issue.id);
      expect(stored?.createdAt.toISOString()).toBe(ORIGINAL_ISO);
    });
  });

  describe('clear()', () => {
    it('очищает хранилище', async () => {
      await repo.add(makeIssue());
      repo.clear();
      expect(repo.size).toBe(0);
      expect(await repo.listOpen()).toEqual([]);
    });
  });
});

/**
 * Тесты ReconcileTradesUseCase
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ReconcileTradesUseCase } from '../src/ReconcileTradesUseCase.js';
// ReconcileTradesDeps and ReconcileTradesInput are exported but not used directly in tests
import type { ProcessFillUseCase } from '../src/ProcessFillUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type {
  IExchangeClient,
  IProcessedFillRepository,
  IReconciliationIssueRepository,
  VenueTradeSnapshot,
} from '@polymarket/ports';
import { ExchangeError } from '@polymarket/ports';
import type { AccountId, AssetId, FillId, MarketId, OrderId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import Decimal from 'decimal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;
const USDC_ASSET = { type: 'CURRENCY', tokenId: undefined } as unknown as AssetId;
const MARKET_ID = 'market-abc' as unknown as MarketId;

const mockTimestamp = {
  value: () => new Decimal(1672290701000),
  toNumber: () => 1672290701000,
  toISO: () => '2023-01-01T00:00:00.000Z',
} as never;

function makeTradeSnapshot(fillId: string): VenueTradeSnapshot {
  return {
    fillId: fillId as unknown as FillId,
    orderId: 'order-1' as unknown as OrderId,
    accountId: ACCOUNT_ID,
    marketId: MARKET_ID,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.57')) as never,
    size: Quantity.of(new Decimal('10')) as never,
    fee: {
      amount: Quantity.of(new Decimal('0')) as never,
      asset: USDC_ASSET,
    },
    executedAt: mockTimestamp,
    status: 'CONFIRMED',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReconcileTradesUseCase', () => {
  let exchangeClient: jest.Mocked<IExchangeClient>;
  let processedFillRepo: jest.Mocked<IProcessedFillRepository>;
  let processFillUseCase: jest.Mocked<Pick<ProcessFillUseCase, 'execute'>>;
  let logger: ILogger;
  let useCase: ReconcileTradesUseCase;

  beforeEach(() => {
    exchangeClient = {
      submitOrder: jest.fn() as jest.MockedFunction<IExchangeClient['submitOrder']>,
      cancelOrder: jest.fn() as jest.MockedFunction<IExchangeClient['cancelOrder']>,
      getOpenOrders: jest.fn() as jest.MockedFunction<IExchangeClient['getOpenOrders']>,
      getTrades: jest.fn() as jest.MockedFunction<IExchangeClient['getTrades']>,
    };
    processedFillRepo = {
      begin: jest.fn<IProcessedFillRepository['begin']>(),
      markApplied: jest.fn<IProcessedFillRepository['markApplied']>(),
      markFailed: jest.fn<IProcessedFillRepository['markFailed']>(),
      markReverted: jest.fn<IProcessedFillRepository['markReverted']>(),
      markReconciliationRequired: jest.fn<IProcessedFillRepository['markReconciliationRequired']>(),
      getStatus: jest.fn<IProcessedFillRepository['getStatus']>(),
    };
    processFillUseCase = {
      execute: jest.fn<ProcessFillUseCase['execute']>().mockResolvedValue(Ok(undefined)),
    };
    logger = makeLogger();

    useCase = new ReconcileTradesUseCase({
      exchangeClient,
      processedFillRepo,
      processFillUseCase: processFillUseCase as unknown as ProcessFillUseCase,
      logger,
    });
  });

  it('возвращает Ok если нет трейдов', async () => {
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([]));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processedFillRepo.getStatus).not.toHaveBeenCalled();
    expect(processFillUseCase.execute).not.toHaveBeenCalled();
  });

  it('возвращает Err если getTrades упал', async () => {
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Err(new ExchangeError('Network error')));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Exchange getTrades failed');
  });

  it('пропускает уже обработанный (APPLIED) fill', async () => {
    const snapshot = makeTradeSnapshot('fill-already-processed');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.getStatus.mockResolvedValue('APPLIED'); // уже был обработан (скорее всего через WS)

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).not.toHaveBeenCalled();
  });

  it('пропускает fill со статусом RECONCILIATION_REQUIRED, не вызывает ProcessFillUseCase, логирует error', async () => {
    const snapshot = makeTradeSnapshot('fill-desync');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.getStatus.mockResolvedValue('RECONCILIATION_REQUIRED');

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Fill requires manual reconciliation — skipping reconcile attempt',
      expect.objectContaining({ fillId: 'fill-desync' }),
    );
  });

  it('обрабатывает новый (unknown status) fill через ProcessFillUseCase', async () => {
    const snapshot = makeTradeSnapshot('fill-new');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.getStatus.mockResolvedValue(undefined); // новый, ProcessFillUseCase сам решит

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('НЕ вызывает processedFillRepo.begin() напрямую — делегирует ProcessFillUseCase.execute()', async () => {
    // Регрессия: если бы ReconcileTradesUseCase сам вызывал begin(), второй begin()
    // внутри ProcessFillUseCase.execute() увидел бы PROCESSING и вернул BUSY,
    // ошибочно пропустив реальную обработку.
    const snapshot = makeTradeSnapshot('fill-new');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.getStatus.mockResolvedValue(undefined);

    await useCase.execute({ accountId: ACCOUNT_ID });

    expect(processedFillRepo.begin).not.toHaveBeenCalled();
  });

  it('пропускает fill с ошибкой ProcessFillUseCase, обрабатывает следующий', async () => {
    const snap1 = makeTradeSnapshot('fill-fail');
    const snap2 = makeTradeSnapshot('fill-ok');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snap1, snap2]));
    processedFillRepo.getStatus.mockResolvedValue(undefined);
    (processFillUseCase.execute as jest.MockedFunction<ProcessFillUseCase['execute']>)
      .mockResolvedValueOnce(Err(new TradingError('Fill failed')))
      .mockResolvedValueOnce(Ok(undefined));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('пропускает fills со статусами MINED / RETRYING / undefined без вызова getStatus', async () => {
    const statuses = ['MINED', 'RETRYING', undefined] as const;
    for (const status of statuses) {
      const snapshot = { ...makeTradeSnapshot(`fill-${status ?? 'undef'}`), status };
      (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
        .mockResolvedValue(Ok([snapshot]));
      processedFillRepo.getStatus.mockClear();

      const result = await useCase.execute({ accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(processedFillRepo.getStatus).not.toHaveBeenCalled();
    }
  });

  it('обрабатывает fills со статусом MATCHED (мгновенное исполнение)', async () => {
    const snapshot = { ...makeTradeSnapshot('fill-matched'), status: 'MATCHED' as const };
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    // Первый вызов (stats-only pre-check) — ещё не применён; второй (re-check
    // ПОСЛЕ execute(), см. P1 processedCount fix) — подтверждает APPLIED.
    processedFillRepo.getStatus
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('APPLIED');
    processFillUseCase.execute.mockResolvedValue(Ok(undefined));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processedFillRepo.getStatus).toHaveBeenCalledTimes(2);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('Ok от processFillUseCase.execute() БЕЗ APPLIED (BUSY/DUPLICATE/RECONCILIATION no-op) НЕ считается processed', async () => {
    const snapshot = { ...makeTradeSnapshot('fill-busy'), status: 'CONFIRMED' as const };
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    // Ok, но статус так и не стал APPLIED — конкурентная обработка (BUSY) либо
    // no-op (DUPLICATE/RECONCILIATION_REQUIRED).
    processedFillRepo.getStatus
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    processFillUseCase.execute.mockResolvedValue(Ok(undefined));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
    expect(processedFillRepo.getStatus).toHaveBeenCalledTimes(2);
    // НЕ processed (не APPLIED) — summary-лог обязан отразить это как skipped.
    expect(logger.info).toHaveBeenCalledWith('Trade reconciliation complete', expect.objectContaining({
      processed: 0,
      skipped: 1,
    }));
  });

  // ── venue FAILED после local APPLIED ────────────────────────────────────────

  describe('FAILED trade handling', () => {
    function makeReconciliationIssueRepo(): IReconciliationIssueRepository {
      return {
        add: jest.fn<IReconciliationIssueRepository['add']>().mockResolvedValue(undefined),
        listOpen: jest.fn<IReconciliationIssueRepository['listOpen']>().mockResolvedValue([]),
        get: jest.fn<IReconciliationIssueRepository['get']>().mockResolvedValue(undefined),
        markResolved: jest.fn<IReconciliationIssueRepository['markResolved']>().mockResolvedValue(undefined),
      };
    }

    function makeUseCaseWithIssues(reconciliationIssues: IReconciliationIssueRepository): ReconcileTradesUseCase {
      return new ReconcileTradesUseCase({
        exchangeClient,
        processedFillRepo,
        processFillUseCase: processFillUseCase as unknown as ProcessFillUseCase,
        logger,
        reconciliationIssues,
      });
    }

    it('FAILED + local APPLIED → VENUE_LOCAL_ORDER_DESYNC issue, ProcessFillUseCase не вызывается', async () => {
      const snapshot = { ...makeTradeSnapshot('fill-failed-applied'), status: 'FAILED' as const };
      (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
        .mockResolvedValue(Ok([snapshot]));
      processedFillRepo.getStatus.mockResolvedValue('APPLIED');
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCaseWithIssues = makeUseCaseWithIssues(reconciliationIssues);

      const result = await useCaseWithIssues.execute({ accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(processFillUseCase.execute).not.toHaveBeenCalled();
      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        reason: string;
        fillId: unknown;
        orderId: unknown;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe('reconciliation:fill:fill-failed-applied:venue-failed-after-applied');
      expect(issue.type).toBe('VENUE_LOCAL_ORDER_DESYNC');
      expect(issue.reason).toContain('VENUE_FILL_FAILED_AFTER_LOCAL_APPLIED');
      expect(issue.fillId).toBe(snapshot.fillId);
      expect(issue.orderId).toBe(snapshot.orderId);
      expect(issue.context).toMatchObject({
        stage: 'reconcile-trades-failed-after-applied',
        venueStatus: 'FAILED',
        localProcessedStatus: 'APPLIED',
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('VENUE_FILL_FAILED_AFTER_LOCAL_APPLIED'),
        expect.objectContaining({ fillId: 'fill-failed-applied' }),
      );
    });

    it('FAILED + local НЕ APPLIED (undefined/FAILED/RECONCILIATION_REQUIRED) → skip без issue и без обработки', async () => {
      const localStatuses = [undefined, 'FAILED', 'RECONCILIATION_REQUIRED'] as const;
      for (const localStatus of localStatuses) {
        const snapshot = { ...makeTradeSnapshot('fill-failed-x'), status: 'FAILED' as const };
        (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
          .mockResolvedValue(Ok([snapshot]));
        processedFillRepo.getStatus.mockResolvedValue(localStatus);
        const reconciliationIssues = makeReconciliationIssueRepo();
        const useCaseWithIssues = makeUseCaseWithIssues(reconciliationIssues);
        (processFillUseCase.execute as ReturnType<typeof jest.fn>).mockClear();

        const result = await useCaseWithIssues.execute({ accountId: ACCOUNT_ID });

        expect(result.ok).toBe(true);
        expect(processFillUseCase.execute).not.toHaveBeenCalled();
        expect(reconciliationIssues.add).not.toHaveBeenCalled();
      }
    });

    it('сбой issue store логируется, reconciliation всё равно возвращает Ok', async () => {
      const snapshot = { ...makeTradeSnapshot('fill-failed-applied'), status: 'FAILED' as const };
      (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
        .mockResolvedValue(Ok([snapshot]));
      processedFillRepo.getStatus.mockResolvedValue('APPLIED');
      const reconciliationIssues = makeReconciliationIssueRepo();
      (reconciliationIssues.add as ReturnType<typeof jest.fn>).mockImplementation(() =>
        Promise.reject(new Error('issue store down')),
      );
      const useCaseWithIssues = makeUseCaseWithIssues(reconciliationIssues);

      const result = await useCaseWithIssues.execute({ accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to add reconciliation issue',
        expect.objectContaining({ issueType: 'VENUE_LOCAL_ORDER_DESYNC' }),
      );
    });

    it('без reconciliationIssues (optional dep) FAILED + APPLIED — только лог, Ok', async () => {
      const snapshot = { ...makeTradeSnapshot('fill-failed-applied'), status: 'FAILED' as const };
      (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
        .mockResolvedValue(Ok([snapshot]));
      processedFillRepo.getStatus.mockResolvedValue('APPLIED');

      const result = await useCase.execute({ accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(processFillUseCase.execute).not.toHaveBeenCalled();
    });
  });

  it('передаёт since в getTrades если указан', async () => {
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([]));
    const since = mockTimestamp;

    await useCase.execute({ accountId: ACCOUNT_ID, since });

    expect(exchangeClient.getTrades).toHaveBeenCalledWith(ACCOUNT_ID, since);
  });
});

/**
 * Тесты ReconcileTradesUseCase
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ReconcileTradesUseCase } from '../src/ReconcileTradesUseCase.js';
// ReconcileTradesDeps and ReconcileTradesInput are exported but not used directly in tests
import type { ProcessFillUseCase } from '../src/ProcessFillUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IExchangeClient, IProcessedFillRepository, VenueTradeSnapshot } from '@polymarket/ports';
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
      markIfNotExists: jest.fn<IProcessedFillRepository['markIfNotExists']>(),
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
    expect(processedFillRepo.markIfNotExists).not.toHaveBeenCalled();
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

  it('пропускает уже обработанный fill (не новый)', async () => {
    const snapshot = makeTradeSnapshot('fill-already-processed');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.markIfNotExists.mockResolvedValue(false); // уже был

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).not.toHaveBeenCalled();
  });

  it('обрабатывает новый fill через ProcessFillUseCase', async () => {
    const snapshot = makeTradeSnapshot('fill-new');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.markIfNotExists.mockResolvedValue(true); // новый

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('пропускает fill с ошибкой ProcessFillUseCase, обрабатывает следующий', async () => {
    const snap1 = makeTradeSnapshot('fill-fail');
    const snap2 = makeTradeSnapshot('fill-ok');
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snap1, snap2]));
    processedFillRepo.markIfNotExists.mockResolvedValue(true);
    (processFillUseCase.execute as jest.MockedFunction<ProcessFillUseCase['execute']>)
      .mockResolvedValueOnce(Err(new TradingError('Fill failed')))
      .mockResolvedValueOnce(Ok(undefined));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('пропускает fills со статусами MINED / RETRYING / undefined без вызова markIfNotExists', async () => {
    const statuses = ['MINED', 'RETRYING', undefined] as const;
    for (const status of statuses) {
      const snapshot = { ...makeTradeSnapshot(`fill-${status ?? 'undef'}`), status };
      (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
        .mockResolvedValue(Ok([snapshot]));
      processedFillRepo.markIfNotExists.mockClear();

      const result = await useCase.execute({ accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(processedFillRepo.markIfNotExists).not.toHaveBeenCalled();
    }
  });

  it('обрабатывает fills со статусом MATCHED (мгновенное исполнение)', async () => {
    const snapshot = { ...makeTradeSnapshot('fill-matched'), status: 'MATCHED' as const };
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([snapshot]));
    processedFillRepo.markIfNotExists.mockResolvedValue(true);
    processFillUseCase.execute.mockResolvedValue(Ok(undefined));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(processedFillRepo.markIfNotExists).toHaveBeenCalledTimes(1);
    expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('передаёт since в getTrades если указан', async () => {
    (exchangeClient.getTrades as jest.MockedFunction<IExchangeClient['getTrades']>)
      .mockResolvedValue(Ok([]));
    const since = mockTimestamp;

    await useCase.execute({ accountId: ACCOUNT_ID, since });

    expect(exchangeClient.getTrades).toHaveBeenCalledWith(ACCOUNT_ID, since);
  });
});

/**
 * Тесты для FillsReconciler — сверка fills из venue API с локальными записями.
 *
 * @remarks
 * Проверяем:
 * - Корректную обработку новых fills
 * - Дедупликацию через processedFillRepo.markIfNotExists
 * - Поведение при ошибках venue API
 * - Поведение при ошибках обработки отдельных fills
 * - Корректность FillReconciliationReport
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { parseAccountId, asFillId } from '@polymarket/ids';
import { FillsReconciler } from '../../src/FillsReconciler.js';
import type { IVenueFillProcessor } from '../../src/FillsReconciler.js';
import type { IExchangeClient, VenueTradeSnapshot, IProcessedFillRepository } from '@polymarket/ports';
import type { ILogger } from '@polymarket/logger';
import type { FillId } from '@polymarket/ids';


// ── Вспомогательные фикстуры ─────────────────────────────────────────────────

const accountId = parseAccountId('venue:POLYMARKET:test-user')!;

/**
 * Создаёт мок ILogger с поддержкой child().
 */
function makeLogger(): ILogger {
  return {
    child: jest.fn().mockReturnThis() as unknown as ILogger['child'],
    trace: jest.fn() as unknown as ILogger['trace'],
    debug: jest.fn() as unknown as ILogger['debug'],
    info:  jest.fn() as unknown as ILogger['info'],
    warn:  jest.fn() as unknown as ILogger['warn'],
    error: jest.fn() as unknown as ILogger['error'],
  } as unknown as ILogger;
}

/**
 * Создаёт минимальный VenueTradeSnapshot для тестов.
 *
 * @param fillIdStr - Строковый ID fill-а
 * @returns VenueTradeSnapshot с указанным fillId
 */
function makeTrade(fillIdStr: string): VenueTradeSnapshot {
  return {
    fillId: asFillId(fillIdStr)!,
    orderId: {} as VenueTradeSnapshot['orderId'],
    accountId,
    marketId: {} as VenueTradeSnapshot['marketId'],
    asset: {} as VenueTradeSnapshot['asset'],
    side: 'BUY' as VenueTradeSnapshot['side'],
    price: {} as VenueTradeSnapshot['price'],
    size: {} as VenueTradeSnapshot['size'],
    fee: {} as VenueTradeSnapshot['fee'],
    executedAt: {} as VenueTradeSnapshot['executedAt'],
  };
}

/**
 * Создаёт мок IExchangeClient, возвращающий указанные trades.
 *
 * @param trades - Список trades для getTrades()
 * @returns Мок IExchangeClient
 */
function makeExchangeClient(
  trades: VenueTradeSnapshot[],
): IExchangeClient {
  return {
    submitOrder: jest.fn(),
    cancelOrder: jest.fn(),
    getOpenOrders: jest.fn(),
    getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue({
      ok: true as const,
      value: trades,
    }),
  } as unknown as IExchangeClient;
}

/**
 * Создаёт мок IExchangeClient, возвращающий ошибку при getTrades.
 *
 * @param errorMsg - Текст ошибки
 * @returns Мок IExchangeClient
 */
function makeFailingExchangeClient(errorMsg: string): IExchangeClient {
  return {
    submitOrder: jest.fn(),
    cancelOrder: jest.fn(),
    getOpenOrders: jest.fn(),
    getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue({
      ok: false,
      error: new Error(errorMsg),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
  } as unknown as IExchangeClient;
}

/**
 * Создаёт мок IProcessedFillRepository.
 *
 * @param knownFills - Set строковых fill ID, которые считаются уже обработанными
 * @returns Мок IProcessedFillRepository
 */
function makeProcessedFillRepo(
  knownFills: Set<string> = new Set(),
): IProcessedFillRepository {
  return {
    markIfNotExists: jest.fn<(id: FillId) => Promise<boolean>>()
      .mockImplementation(async (fillId: FillId) => {
        const key = String(fillId);
        if (knownFills.has(key)) return false;
        knownFills.add(key);
        return true;
      }),
  };
}

/**
 * Создаёт мок IVenueFillProcessor, всегда возвращающий Ok.
 *
 * @returns Мок IVenueFillProcessor
 */
function makeSuccessProcessor(): IVenueFillProcessor {
  return {
    processVenueTrade: jest.fn<IVenueFillProcessor['processVenueTrade']>()
      .mockResolvedValue({ ok: true as const, value: undefined }),
  };
}

/**
 * Создаёт мок IVenueFillProcessor, возвращающий Err(Error).
 *
 * @param errorMsg - Текст ошибки
 * @returns Мок IVenueFillProcessor
 */
function makeFailingProcessor(errorMsg: string): IVenueFillProcessor {
  return {
    processVenueTrade: jest.fn<IVenueFillProcessor['processVenueTrade']>()
      .mockResolvedValue({
        ok: false as const,
        error: new Error(errorMsg),
      }),
  };
}

/**
 * Создаёт мок IVenueFillProcessor, бросающий исключение.
 *
 * @param errorMsg - Текст исключения
 * @returns Мок IVenueFillProcessor
 */
function makeThrowingProcessor(errorMsg: string): IVenueFillProcessor {
  return {
    processVenueTrade: jest.fn<IVenueFillProcessor['processVenueTrade']>()
      .mockRejectedValue(new Error(errorMsg)),
  };
}

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('FillsReconciler', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  describe('reconcile()', () => {
    it('возвращает пустой report если venue вернул 0 trades', async () => {
      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient([]),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report).toEqual({
        totalFromVenue: 0,
        alreadyProcessed: 0,
        newlyProcessed: 0,
        errors: 0,
      });
    });

    it('обрабатывает новые fills и увеличивает newlyProcessed', async () => {
      const trades = [makeTrade('fill-1'), makeTrade('fill-2')];
      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report.totalFromVenue).toBe(2);
      expect(report.newlyProcessed).toBe(2);
      expect(report.alreadyProcessed).toBe(0);
      expect(report.errors).toBe(0);
    });

    it('пропускает уже обработанные fills (дедупликация)', async () => {
      const trades = [makeTrade('fill-dup'), makeTrade('fill-new')];
      const knownFills = new Set([String(asFillId('fill-dup')!)]);
      const processor = makeSuccessProcessor();

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(knownFills),
        fillProcessor: processor,
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report.totalFromVenue).toBe(2);
      expect(report.alreadyProcessed).toBe(1);
      expect(report.newlyProcessed).toBe(1);
      expect(processor.processVenueTrade).toHaveBeenCalledTimes(1);
    });

    it('считает errors при Result.err от fillProcessor', async () => {
      const trades = [makeTrade('fill-err')];

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeFailingProcessor('processing failed'),
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report.totalFromVenue).toBe(1);
      expect(report.newlyProcessed).toBe(0);
      expect(report.errors).toBe(1);
    });

    it('считает errors при исключении от fillProcessor', async () => {
      const trades = [makeTrade('fill-throw')];

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeThrowingProcessor('unexpected crash'),
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report.totalFromVenue).toBe(1);
      expect(report.newlyProcessed).toBe(0);
      expect(report.errors).toBe(1);
    });

    it('логирует warn при Result.err от fillProcessor', async () => {
      const trades = [makeTrade('fill-warn')];

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeFailingProcessor('validation error'),
        logger,
      });

      await reconciler.reconcile(accountId);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('fill processing returned error'),
        expect.objectContaining({ error: 'validation error' }),
      );
    });

    it('логирует error при исключении от fillProcessor', async () => {
      const trades = [makeTrade('fill-exc')];

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeThrowingProcessor('kaboom'),
        logger,
      });

      await reconciler.reconcile(accountId);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('fill processing threw'),
        expect.objectContaining({ err: expect.any(Error) }),
      );
    });

    it('возвращает report с errors=1 при ошибке getTrades от venue', async () => {
      const reconciler = new FillsReconciler({
        exchangeClient: makeFailingExchangeClient('network timeout'),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report).toEqual({
        totalFromVenue: 0,
        alreadyProcessed: 0,
        newlyProcessed: 0,
        errors: 1,
      });
    });

    it('логирует error при ошибке getTrades от venue', async () => {
      const reconciler = new FillsReconciler({
        exchangeClient: makeFailingExchangeClient('network timeout'),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      await reconciler.reconcile(accountId);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to fetch trades'),
        expect.objectContaining({ error: 'network timeout' }),
      );
    });

    it('не прерывает reconciliation при ошибке одного fill (продолжает остальные)', async () => {
      const trades = [makeTrade('fill-ok-1'), makeTrade('fill-bad'), makeTrade('fill-ok-2')];

      // Первый и третий — Ok, второй — Err
      let callCount = 0;
      const processor: IVenueFillProcessor = {
        processVenueTrade: jest.fn<IVenueFillProcessor['processVenueTrade']>()
          .mockImplementation(async () => {
            callCount++;
            if (callCount === 2) {
              return { ok: false as const, error: new Error('bad fill') };
            }
            return { ok: true as const, value: undefined };
          }),
      };

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: processor,
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report.totalFromVenue).toBe(3);
      expect(report.newlyProcessed).toBe(2);
      expect(report.errors).toBe(1);
      expect(processor.processVenueTrade).toHaveBeenCalledTimes(3);
    });

    it('передаёт since в exchangeClient.getTrades', async () => {
      const client = makeExchangeClient([]);
      const reconciler = new FillsReconciler({
        exchangeClient: client,
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      const fakeSince = { fake: 'timestamp' } as unknown as import('@polymarket/value-objects').Timestamp;
      await reconciler.reconcile(accountId, fakeSince);

      expect(client.getTrades).toHaveBeenCalledWith(accountId, fakeSince);
    });

    it('вызывает reconcile без since (undefined) корректно', async () => {
      const client = makeExchangeClient([]);
      const reconciler = new FillsReconciler({
        exchangeClient: client,
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      await reconciler.reconcile(accountId);

      expect(client.getTrades).toHaveBeenCalledWith(accountId, undefined);
    });

    it('смешанный сценарий: новые, дубликаты, ошибки — report корректен', async () => {
      const trades = [
        makeTrade('fill-dup-1'),
        makeTrade('fill-new-1'),
        makeTrade('fill-err-1'),
        makeTrade('fill-new-2'),
        makeTrade('fill-dup-2'),
      ];

      const knownFills = new Set([
        String(asFillId('fill-dup-1')!),
        String(asFillId('fill-dup-2')!),
      ]);

      let newCallCount = 0;
      const processor: IVenueFillProcessor = {
        processVenueTrade: jest.fn<IVenueFillProcessor['processVenueTrade']>()
          .mockImplementation(async () => {
            newCallCount++;
            // Второй вызов (fill-err-1) — ошибка
            if (newCallCount === 2) {
              return { ok: false as const, error: new Error('bad') };
            }
            return { ok: true as const, value: undefined };
          }),
      };

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(knownFills),
        fillProcessor: processor,
        logger,
      });

      const report = await reconciler.reconcile(accountId);

      expect(report.totalFromVenue).toBe(5);
      expect(report.alreadyProcessed).toBe(2);
      expect(report.newlyProcessed).toBe(2);
      expect(report.errors).toBe(1);
    });

    it('логирует итоговый report', async () => {
      const trades = [makeTrade('fill-log')];
      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient(trades),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: makeSuccessProcessor(),
        logger,
      });

      await reconciler.reconcile(accountId);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('reconciliation complete'),
        expect.objectContaining({
          totalFromVenue: 1,
          newlyProcessed: 1,
          alreadyProcessed: 0,
          errors: 0,
        }),
      );
    });

    it('передаёт VenueTradeSnapshot в fillProcessor.processVenueTrade', async () => {
      const trade = makeTrade('fill-passthrough');
      const processor = makeSuccessProcessor();

      const reconciler = new FillsReconciler({
        exchangeClient: makeExchangeClient([trade]),
        processedFillRepo: makeProcessedFillRepo(),
        fillProcessor: processor,
        logger,
      });

      await reconciler.reconcile(accountId);

      expect(processor.processVenueTrade).toHaveBeenCalledWith(trade);
    });
  });
});

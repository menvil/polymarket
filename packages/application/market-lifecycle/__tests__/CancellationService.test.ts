/**
 * Тесты CancellationService — пакетная best-effort отмена открытых ордеров.
 *
 * @remarks
 * Проверяет: фильтрацию по canCancel(), батчинг, best-effort (rejected promise,
 * Ok(Err) от use case), конструктор (batchSize < 1 → RangeError).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CancellationService } from '../src/CancellationService.js';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId, OrderId } from '@polymarket/ids';
import type { Order } from '@polymarket/order';
import type { CancelOrderUseCase } from '@polymarket/use-cases';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';

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

/**
 * Упрощённая заглушка Order: только id и canCancel().
 * Реальный Order-агрегат не нужен — CancellationService обращается только к ним.
 */
function makeOrder(id: string, cancellable = true): Order {
  return {
    id: id as unknown as OrderId,
    canCancel: () => cancellable,
  } as unknown as Order;
}

const ACCOUNT_ID = 'acc-cancel-test' as unknown as AccountId;
const MARKET_ID  = 'mkt-cancel-test' as unknown as MarketId;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CancellationService', () => {
  let cancelUseCase: jest.Mocked<Pick<CancelOrderUseCase, 'execute'>>;
  let logger: ILogger;
  let service: CancellationService;

  beforeEach(() => {
    cancelUseCase = {
      execute: jest.fn<CancelOrderUseCase['execute']>().mockResolvedValue(Ok(undefined)),
    };
    logger = makeLogger();
    service = new CancellationService(
      cancelUseCase as unknown as CancelOrderUseCase,
      { logger },
    );
  });

  // ── Конструктор ────────────────────────────────────────────────────────────

  describe('конструктор', () => {
    it('batchSize=0 → RangeError', () => {
      expect(
        () => new CancellationService(cancelUseCase as unknown as CancelOrderUseCase, { logger }, 0),
      ).toThrow(RangeError);
      expect(
        () => new CancellationService(cancelUseCase as unknown as CancelOrderUseCase, { logger }, 0),
      ).toThrow('batchSize must be >= 1');
    });

    it('отрицательный batchSize → RangeError', () => {
      expect(
        () => new CancellationService(cancelUseCase as unknown as CancelOrderUseCase, { logger }, -5),
      ).toThrow(RangeError);
    });
  });

  // ── cancelOpenOrders ───────────────────────────────────────────────────────

  describe('cancelOpenOrders', () => {
    it('нет ордеров → {cancelled:0, failed:0}, execute не вызывается', async () => {
      const result = await service.cancelOpenOrders([], ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 0, failed: 0 });
      expect(cancelUseCase.execute).not.toHaveBeenCalled();
    });

    it('все ордера non-cancellable → {cancelled:0, failed:0}, execute не вызывается', async () => {
      const orders = [makeOrder('o1', false), makeOrder('o2', false)];

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 0, failed: 0 });
      expect(cancelUseCase.execute).not.toHaveBeenCalled();
    });

    it('OPEN ордера (cancellable=true) — все отменяются', async () => {
      const orders = [makeOrder('o1'), makeOrder('o2')];

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 2, failed: 0 });
      expect(cancelUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('PARTIALLY_FILLED ордера (cancellable=true) — включаются в отмену', async () => {
      // canCancel() возвращает true для PARTIALLY_FILLED так же как для OPEN
      const partiallyFilled = makeOrder('o-partial', true);

      const result = await service.cancelOpenOrders(
        [partiallyFilled], ACCOUNT_ID, MARKET_ID, 'EXPIRED',
      );

      expect(result).toEqual({ cancelled: 1, failed: 0 });
      expect(cancelUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('смешанный список: cancellable и non-cancellable → только cancellable отменяются', async () => {
      const orders = [
        makeOrder('o-open', true),
        makeOrder('o-filled', false),    // FILLED — non-cancellable
        makeOrder('o-partial', true),    // PARTIALLY_FILLED — cancellable
        makeOrder('o-pending', false),   // PENDING — non-cancellable
      ];

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 2, failed: 0 });
      expect(cancelUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('rejected promise от cancelOrderUseCase → failed++, warn log, не бросает', async () => {
      const orders = [makeOrder('o-fail')];
      (cancelUseCase.execute as jest.MockedFunction<CancelOrderUseCase['execute']>)
        .mockRejectedValue(new Error('Network timeout'));

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 0, failed: 1 });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('Ok(Err) от cancelOrderUseCase → failed++, warn log', async () => {
      const orders = [makeOrder('o-err')];
      (cancelUseCase.execute as jest.MockedFunction<CancelOrderUseCase['execute']>)
        .mockResolvedValue(Err(new TradingError('Cannot cancel: order not found')));

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 0, failed: 1 });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('один Ok, один Err → {cancelled:1, failed:1}', async () => {
      const orders = [makeOrder('o-ok'), makeOrder('o-err')];
      (cancelUseCase.execute as jest.MockedFunction<CancelOrderUseCase['execute']>)
        .mockResolvedValueOnce(Ok(undefined))
        .mockResolvedValueOnce(Err(new TradingError('Denied')));

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 1, failed: 1 });
    });

    it('один Ok, один rejected → {cancelled:1, failed:1}', async () => {
      const orders = [makeOrder('o-ok'), makeOrder('o-throw')];
      (cancelUseCase.execute as jest.MockedFunction<CancelOrderUseCase['execute']>)
        .mockResolvedValueOnce(Ok(undefined))
        .mockRejectedValueOnce(new Error('Bus down'));

      const result = await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(result).toEqual({ cancelled: 1, failed: 1 });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('батчинг: 3 ордера с batchSize=2 → execute вызван 3 раза, все обработаны', async () => {
      const batchedService = new CancellationService(
        cancelUseCase as unknown as CancelOrderUseCase,
        { logger },
        2,
      );
      const orders = [makeOrder('o1'), makeOrder('o2'), makeOrder('o3')];

      const result = await batchedService.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(cancelUseCase.execute).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ cancelled: 3, failed: 0 });
    });

    it('передаёт reason в строку запроса отмены', async () => {
      const orders = [makeOrder('o1')];

      await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'MANUAL');

      expect(cancelUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Market closed: MANUAL' }),
      );
    });

    it('передаёт orderId и accountId в запрос отмены', async () => {
      const orders = [makeOrder('order-xyz')];

      await service.cancelOpenOrders(orders, ACCOUNT_ID, MARKET_ID, 'EXPIRED');

      expect(cancelUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'order-xyz',
          accountId: ACCOUNT_ID,
        }),
      );
    });
  });
});

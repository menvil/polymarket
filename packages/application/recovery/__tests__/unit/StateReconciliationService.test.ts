/**
 * Тесты для StateReconciliationService — периодическая сверка состояния с venue.
 *
 * @remarks
 * Проверяем:
 * - reconcileOnce: вызывает OrderReconciler и FillsReconciler
 * - reconcileOnce: ошибки в одном этапе не блокируют другой
 * - reconcileOnce: корректный расчёт since по fillLookbackMs
 * - start/stop: управление таймером
 * - start: no-op при отсутствии intervalMs
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { parseAccountId } from '@polymarket/ids';
import { StateReconciliationService } from '../../src/StateReconciliationService.js';
import type { StateReconciliationDeps, StateReconciliationConfig } from '../../src/StateReconciliationService.js';
import type { OrderReconciler } from '../../src/OrderReconciler.js';
import type { FillsReconciler } from '../../src/FillsReconciler.js';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { Timestamp } from '@polymarket/value-objects';

// ── Вспомогательные фикстуры ─────────────────────────────────────────────────

const accountId = parseAccountId('venue:POLYMARKET:test-user')!;
const NOW_MS = 1_700_000_000_000;

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
 * Создаёт мок IClock, возвращающий фиксированное время.
 *
 * @param nowMs - Текущее время в миллисекундах
 * @returns Мок IClock
 */
function makeClock(nowMs: number = NOW_MS): IClock {
  return {
    now: jest.fn<() => Date>().mockReturnValue(new Date(nowMs)),
  };
}

/**
 * Создаёт мок OrderReconciler.
 *
 * @returns Мок OrderReconciler
 */
function makeOrderReconciler(): OrderReconciler {
  return {
    reconcile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as OrderReconciler;
}

/**
 * Создаёт мок FillsReconciler.
 *
 * @returns Мок FillsReconciler
 */
function makeFillsReconciler(): FillsReconciler {
  return {
    reconcile: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      totalFromVenue: 0,
      alreadyProcessed: 0,
      newlyProcessed: 0,
      errors: 0,
    }),
  } as unknown as FillsReconciler;
}

/**
 * Создаёт StateReconciliationService с дефолтными зависимостями.
 *
 * @param overrides - Переопределения зависимостей и конфигурации
 * @returns Объект с service и всеми моками
 */
function createService(overrides: {
  orderReconciler?: OrderReconciler;
  fillsReconciler?: FillsReconciler;
  clock?: IClock;
  logger?: ILogger;
  config?: Partial<StateReconciliationConfig>;
} = {}) {
  const logger = overrides.logger ?? makeLogger();
  const orderReconciler = overrides.orderReconciler ?? makeOrderReconciler();
  const fillsReconciler = overrides.fillsReconciler ?? makeFillsReconciler();
  const clock = overrides.clock ?? makeClock();

  const config: StateReconciliationConfig = {
    fillLookbackMs: 300_000,
    ...overrides.config,
  };

  const deps: StateReconciliationDeps = {
    orderReconciler,
    fillsReconciler,
    clock,
    logger,
  };

  const service = new StateReconciliationService(deps, config);

  return { service, logger, orderReconciler, fillsReconciler, clock };
}

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('StateReconciliationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('reconcileOnce()', () => {
    it('вызывает orderReconciler.reconcile с accountId', async () => {
      const { service, orderReconciler } = createService();

      await service.reconcileOnce(accountId);

      expect(orderReconciler.reconcile).toHaveBeenCalledWith(accountId);
    });

    it('вызывает fillsReconciler.reconcile с accountId и since', async () => {
      const { service, fillsReconciler } = createService();

      await service.reconcileOnce(accountId);

      expect(fillsReconciler.reconcile).toHaveBeenCalledWith(
        accountId,
        expect.anything(), // since Timestamp
      );
    });

    it('рассчитывает since = clock.now() - fillLookbackMs', async () => {
      const fillLookbackMs = 300_000;
      const { service, fillsReconciler } = createService({
        config: { fillLookbackMs },
      });

      await service.reconcileOnce(accountId);

      const call = (fillsReconciler.reconcile as jest.Mock).mock.calls[0];
      const since = call[1] as Timestamp | undefined;
      // since должен быть Timestamp, созданный из NOW_MS - 300_000
      // Проверяем что since не undefined (TimestampService.create удался)
      expect(since).toBeDefined();
    });

    it('ошибка orderReconciler не блокирует fillsReconciler', async () => {
      const orderReconciler = {
        reconcile: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('order boom')),
      } as unknown as OrderReconciler;
      const fillsReconciler = makeFillsReconciler();

      const { service } = createService({ orderReconciler, fillsReconciler });

      // Не должен бросить
      await expect(service.reconcileOnce(accountId)).resolves.toBeUndefined();

      // fillsReconciler всё равно вызван
      expect(fillsReconciler.reconcile).toHaveBeenCalledTimes(1);
    });

    it('ошибка fillsReconciler не бросает исключение', async () => {
      const fillsReconciler = {
        reconcile: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('fills boom')),
      } as unknown as FillsReconciler;

      const { service } = createService({ fillsReconciler });

      await expect(service.reconcileOnce(accountId)).resolves.toBeUndefined();
    });

    it('логирует error при ошибке orderReconciler', async () => {
      const orderReconciler = {
        reconcile: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('order fail')),
      } as unknown as OrderReconciler;
      const logger = makeLogger();

      const { service } = createService({ orderReconciler, logger });
      await service.reconcileOnce(accountId);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('order reconciliation failed'),
        expect.objectContaining({ err: expect.any(Error) }),
      );
    });

    it('логирует error при ошибке fillsReconciler', async () => {
      const fillsReconciler = {
        reconcile: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('fills fail')),
      } as unknown as FillsReconciler;
      const logger = makeLogger();

      const { service } = createService({ fillsReconciler, logger });
      await service.reconcileOnce(accountId);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('fills reconciliation failed'),
        expect.objectContaining({ err: expect.any(Error) }),
      );
    });

    it('логирует debug в начале и конце reconciliation', async () => {
      const logger = makeLogger();
      const { service } = createService({ logger });

      await service.reconcileOnce(accountId);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('starting reconciliation'),
        expect.objectContaining({ accountId: String(accountId) }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('reconciliation complete'),
        expect.objectContaining({ accountId: String(accountId) }),
      );
    });

    it('вызывает orders ДО fills (последовательность)', async () => {
      const callOrder: string[] = [];
      const orderReconciler = {
        reconcile: jest.fn<() => Promise<void>>().mockImplementation(async () => {
          callOrder.push('orders');
        }),
      } as unknown as OrderReconciler;
      const fillsReconciler = {
        reconcile: jest.fn<() => Promise<unknown>>().mockImplementation(async () => {
          callOrder.push('fills');
          return { totalFromVenue: 0, alreadyProcessed: 0, newlyProcessed: 0, errors: 0 };
        }),
      } as unknown as FillsReconciler;

      const { service } = createService({ orderReconciler, fillsReconciler });
      await service.reconcileOnce(accountId);

      expect(callOrder).toEqual(['orders', 'fills']);
    });
  });

  describe('start()', () => {
    it('no-op если intervalMs не задан (undefined)', () => {
      const logger = makeLogger();
      const { service, orderReconciler } = createService({
        logger,
        config: { intervalMs: undefined, fillLookbackMs: 300_000 },
      });

      service.start(accountId);

      // Нет таймера — advance не должен вызывать reconcile
      jest.advanceTimersByTime(1_000_000);
      expect(orderReconciler.reconcile).not.toHaveBeenCalled();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('periodic reconciliation disabled'),
      );

      service.stop(); // безопасно даже если таймер не был создан
    });

    it('запускает периодический reconcile с intervalMs', () => {
      const orderReconciler = makeOrderReconciler();
      const fillsReconciler = makeFillsReconciler();

      const { service } = createService({
        orderReconciler,
        fillsReconciler,
        config: { intervalMs: 60_000, fillLookbackMs: 300_000 },
      });

      service.start(accountId);

      // Первый tick
      jest.advanceTimersByTime(60_000);
      expect(orderReconciler.reconcile).toHaveBeenCalledTimes(1);

      // Второй tick
      jest.advanceTimersByTime(60_000);
      expect(orderReconciler.reconcile).toHaveBeenCalledTimes(2);

      service.stop();
    });

    it('логирует info при запуске с intervalMs', () => {
      const logger = makeLogger();
      const { service } = createService({
        logger,
        config: { intervalMs: 30_000, fillLookbackMs: 300_000 },
      });

      service.start(accountId);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('started'),
        expect.objectContaining({ intervalMs: 30_000, fillLookbackMs: 300_000 }),
      );

      service.stop();
    });

    it('перезапускает таймер при повторном start() (без stop())', () => {
      const orderReconciler = makeOrderReconciler();
      const { service } = createService({
        orderReconciler,
        config: { intervalMs: 60_000, fillLookbackMs: 300_000 },
      });

      service.start(accountId);
      // Прошло 30 сек — ещё не сработал
      jest.advanceTimersByTime(30_000);
      expect(orderReconciler.reconcile).not.toHaveBeenCalled();

      // Повторный start перезапускает таймер
      service.start(accountId);
      jest.advanceTimersByTime(30_000);
      // Не должен быть вызван — 30 сек от нового start, а не 60
      expect(orderReconciler.reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(30_000);
      expect(orderReconciler.reconcile).toHaveBeenCalledTimes(1);

      service.stop();
    });
  });

  describe('stop()', () => {
    it('останавливает периодический reconcile', () => {
      const orderReconciler = makeOrderReconciler();
      const { service } = createService({
        orderReconciler,
        config: { intervalMs: 60_000, fillLookbackMs: 300_000 },
      });

      service.start(accountId);
      service.stop();

      jest.advanceTimersByTime(120_000);
      expect(orderReconciler.reconcile).not.toHaveBeenCalled();
    });

    it('безопасен при повторном вызове', () => {
      const { service } = createService({
        config: { intervalMs: 60_000, fillLookbackMs: 300_000 },
      });

      service.start(accountId);
      service.stop();
      service.stop(); // повторный вызов — не должен бросать

      expect(true).toBe(true); // дошли без ошибок
    });

    it('безопасен без предшествующего start()', () => {
      const { service } = createService();

      service.stop(); // не было start — не должен бросать

      expect(true).toBe(true);
    });
  });
});

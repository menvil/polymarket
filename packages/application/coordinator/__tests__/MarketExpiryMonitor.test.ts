/**
 * Тесты MarketExpiryMonitor.
 *
 * @remarks
 * Покрывает:
 * - Lifecycle: start(), stop(), повторный start() (no-op)
 * - Трекинг рынков через MARKET_OPENED / MARKET_CLOSED
 * - _checkExpired(): закрытие просроченных рынков
 * - Обработка ошибок CloseMarketUseCase
 * - Snapshot-подход: expired собираются до await, не подвержены concurrent modification
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MarketExpiryMonitor } from '../src/MarketExpiryMonitor.js';
import type { MarketExpiryMonitorDeps, MarketExpiryMonitorConfig } from '../src/MarketExpiryMonitor.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus, MarketOpenedEvent, MarketClosedEvent } from '@polymarket/event-bus';
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import type { CloseMarketUseCase } from '@polymarket/market-lifecycle';
import type { IClock } from '@polymarket/time';
import type { AccountId, MarketId, InstrumentId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-test' as unknown as AccountId;
const MARKET_ID_1 = 'mkt-1' as unknown as MarketId;
const MARKET_ID_2 = 'mkt-2' as unknown as MarketId;
const INSTR_ID_1 = 'inst-1' as unknown as InstrumentId;
const INSTR_ID_2 = 'inst-2' as unknown as InstrumentId;

const NOW_MS = 1_700_000_000_000;
const FUTURE_MS = NOW_MS + 60_000; // +1 мин — не истёк
const EXPIRED_MS = NOW_MS - 1; // -1 мс — уже истёк

function makeTimestamp(ms: number) {
  const r = TimestampService.create(ms);
  if (!r.ok) throw new Error('Failed to create timestamp');
  return r.value;
}

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

function makeClock(nowMs = NOW_MS): IClock {
  return { now: () => new Date(nowMs) };
}

function makeCatalog(): jest.Mocked<IMarketCatalog> {
  return {
    get: jest.fn<IMarketCatalog['get']>(),
    getAll: jest.fn<IMarketCatalog['getAll']>().mockReturnValue([]),
    getByMarketId: jest.fn<IMarketCatalog['getByMarketId']>().mockReturnValue(undefined),
    register: jest.fn<IMarketCatalog['register']>(),
    remove: jest.fn<IMarketCatalog['remove']>(),
    clear: jest.fn<IMarketCatalog['clear']>(),
  };
}

function makeCloseUseCase() {
  return { execute: jest.fn<CloseMarketUseCase['execute']>() };
}

function makeInstrument(marketId: MarketId, instrumentId: InstrumentId, expiresAtMs = FUTURE_MS): InstrumentInfo {
  return {
    instrumentId,
    marketId,
    tickSize: {} as any,
    minOrderSize: {} as any,
    expiresAt: makeTimestamp(expiresAtMs),
    active: true,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MarketExpiryMonitor', () => {
  let catalog: jest.Mocked<IMarketCatalog>;
  let closeUseCase: ReturnType<typeof makeCloseUseCase>;
  let logger: ILogger;
  let monitor: MarketExpiryMonitor;

  /** Захваченные event-handlers */
  let openedHandler: ((e: MarketOpenedEvent) => Promise<void>) | undefined;
  let closedHandler: ((e: MarketClosedEvent) => Promise<void>) | undefined;
  let unsubscribeOpenedFn: jest.Mock;
  let unsubscribeClosedFn: jest.Mock;
  let eventBus: IEventBus;

  const config: MarketExpiryMonitorConfig = {
    accountId: ACCOUNT_ID,
    checkIntervalMs: 5_000,
  };

  function buildMonitor(clockMs = NOW_MS, cfg?: Partial<MarketExpiryMonitorConfig>): MarketExpiryMonitor {
    const deps: MarketExpiryMonitorDeps = {
      closeMarketUseCase: closeUseCase as unknown as CloseMarketUseCase,
      marketCatalog: catalog,
      eventBus,
      clock: makeClock(clockMs),
      logger,
    };
    return new MarketExpiryMonitor(deps, { ...config, ...cfg });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    catalog = makeCatalog();
    closeUseCase = makeCloseUseCase();
    logger = makeLogger();
    openedHandler = undefined;
    closedHandler = undefined;
    unsubscribeOpenedFn = jest.fn().mockReturnValue(undefined);
    unsubscribeClosedFn = jest.fn().mockReturnValue(undefined);

    eventBus = {
      publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
      publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
      subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
        (type: string, handler: unknown) => {
          if (type === 'MARKET_OPENED') {
            openedHandler = handler as (e: MarketOpenedEvent) => Promise<void>;
            return unsubscribeOpenedFn;
          }
          if (type === 'MARKET_CLOSED') {
            closedHandler = handler as (e: MarketClosedEvent) => Promise<void>;
            return unsubscribeClosedFn;
          }
          return () => {};
        },
      ) as IEventBus['subscribe'],
    };

    monitor = buildMonitor();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('подписывается на MARKET_OPENED и MARKET_CLOSED', () => {
      monitor.start();

      expect(eventBus.subscribe).toHaveBeenCalledWith('MARKET_OPENED', expect.any(Function));
      expect(eventBus.subscribe).toHaveBeenCalledWith('MARKET_CLOSED', expect.any(Function));
    });

    it('запускает setInterval с checkIntervalMs', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      monitor.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), config.checkIntervalMs);
    });

    it('повторный start() — no-op с предупреждением', () => {
      monitor.start();
      monitor.start();

      expect(eventBus.subscribe).toHaveBeenCalledTimes(2); // только первый раз
      expect(logger.warn).toHaveBeenCalledWith(
        'MarketExpiryMonitor already running, ignoring start()',
      );
    });

    it('stop() отписывается от событий', () => {
      monitor.start();
      monitor.stop();

      expect(unsubscribeOpenedFn).toHaveBeenCalled();
      expect(unsubscribeClosedFn).toHaveBeenCalled();
    });

    it('stop() очищает интервал', async () => {
      monitor.start();
      monitor.stop();

      closeUseCase.execute.mockClear();
      await jest.runAllTimersAsync();

      expect(closeUseCase.execute).not.toHaveBeenCalled();
    });

    it('stop() без предварительного start() — no error', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  // ── Tracking via MARKET_OPENED / MARKET_CLOSED ────────────────────────────

  describe('трекинг рынков', () => {
    beforeEach(() => {
      monitor.start();
    });

    it('добавляет рынок в трекинг при MARKET_OPENED если инструмент найден в каталоге', async () => {
      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, FUTURE_MS));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      expect(catalog.getByMarketId).toHaveBeenCalledWith(MARKET_ID_1);
      expect(logger.debug).toHaveBeenCalledWith(
        'Market expiry tracking started',
        expect.objectContaining({ marketId: String(MARKET_ID_1) }),
      );
    });

    it('логирует warn если инструмент не найден в каталоге при MARKET_OPENED', async () => {
      catalog.getByMarketId.mockReturnValue(undefined);

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('instrument not found in catalog'),
        expect.objectContaining({ marketId: String(MARKET_ID_1) }),
      );
    });

    it('удаляет рынок из трекинга при MARKET_CLOSED', async () => {
      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, EXPIRED_MS));
      closeUseCase.execute.mockResolvedValue(Ok(undefined));

      // Добавляем, потом убираем
      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);
      await closedHandler!({ type: 'MARKET_CLOSED', marketId: MARKET_ID_1 } as any);

      // Продвигаем интервал — рынок удалён из трекинга, закрытие не вызывается
      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(closeUseCase.execute).not.toHaveBeenCalled();
    });
  });

  // ── _checkExpired() ───────────────────────────────────────────────────────

  describe('_checkExpired()', () => {
    it('не вызывает closeMarketUseCase если нет отслеживаемых рынков', async () => {
      monitor.start();

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(closeUseCase.execute).not.toHaveBeenCalled();
    });

    it('не закрывает рынок если expiresAtMs > now', async () => {
      monitor.start();
      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, FUTURE_MS));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(closeUseCase.execute).not.toHaveBeenCalled();
    });

    it('закрывает рынок с reason EXPIRED если expiresAtMs <= now', async () => {
      monitor = buildMonitor(NOW_MS);
      monitor.start();

      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, EXPIRED_MS));
      closeUseCase.execute.mockResolvedValue(Ok(undefined));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(closeUseCase.execute).toHaveBeenCalledWith({
        marketId: MARKET_ID_1,
        accountId: ACCOUNT_ID,
        reason: 'EXPIRED',
      });
    });

    it('закрывает несколько истёкших рынков', async () => {
      monitor = buildMonitor(NOW_MS);
      monitor.start();

      catalog.getByMarketId
        .mockReturnValueOnce(makeInstrument(MARKET_ID_1, INSTR_ID_1, EXPIRED_MS))
        .mockReturnValueOnce(makeInstrument(MARKET_ID_2, INSTR_ID_2, EXPIRED_MS));

      closeUseCase.execute.mockResolvedValue(Ok(undefined));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);
      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_2 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(closeUseCase.execute).toHaveBeenCalledTimes(2);
      expect(closeUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ marketId: MARKET_ID_1, reason: 'EXPIRED' }),
      );
      expect(closeUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ marketId: MARKET_ID_2, reason: 'EXPIRED' }),
      );
    });

    it('логирует ошибку если closeMarketUseCase вернул Err', async () => {
      monitor = buildMonitor(NOW_MS);
      monitor.start();

      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, EXPIRED_MS));
      closeUseCase.execute.mockResolvedValue(Err(new TradingError('Cancel failed')));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to close expired market',
        expect.objectContaining({ marketId: String(MARKET_ID_1) }),
      );
    });

    it('логирует ошибку если closeMarketUseCase бросает исключение', async () => {
      monitor = buildMonitor(NOW_MS);
      monitor.start();

      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, EXPIRED_MS));
      closeUseCase.execute.mockRejectedValue(new Error('Unexpected failure'));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(logger.error).toHaveBeenCalledWith(
        'Unexpected error closing expired market',
        expect.objectContaining({ marketId: String(MARKET_ID_1) }),
      );
    });

    it('проверяет истечение периодически каждые checkIntervalMs', async () => {
      monitor = buildMonitor(NOW_MS);
      monitor.start();
      closeUseCase.execute.mockResolvedValue(Ok(undefined));

      // Первый интервал — рынки не истекли
      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, FUTURE_MS));
      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();
      expect(closeUseCase.execute).not.toHaveBeenCalled();

      // Второй интервал — тот же рынок ещё не истёк
      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();
      expect(closeUseCase.execute).not.toHaveBeenCalled();
    });

    it('логирует info о закрытии истёкших рынков (count)', async () => {
      monitor = buildMonitor(NOW_MS);
      monitor.start();

      catalog.getByMarketId.mockReturnValue(makeInstrument(MARKET_ID_1, INSTR_ID_1, EXPIRED_MS));
      closeUseCase.execute.mockResolvedValue(Ok(undefined));

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      await jest.advanceTimersByTimeAsync(config.checkIntervalMs);
      await flushMicrotasks();

      expect(logger.info).toHaveBeenCalledWith(
        'Expiry check: closing expired markets',
        expect.objectContaining({ count: 1 }),
      );
    });
  });
});

/**
 * StrategyRunner unit tests
 *
 * @remarks
 * Проверяет start/stop/stopAll/getMetrics/onRiskBreached.
 */
import { Ok, Err } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import { parseAccountId } from '@polymarket/ids';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore } from '@polymarket/ports';
import type { PlaceOrderUseCase, CancelOrderUseCase } from '@polymarket/use-cases';
import type { Portfolio } from '@polymarket/portfolio';
import { StrategyRunner } from '../../src/StrategyRunner.js';
import type { IStrategy } from '../../src/IStrategy.js';
import type { StrategyContext } from '../../src/StrategyContext.js';
import type { RiskLimitBreachedEvent } from '@polymarket/event-bus';

// --- Helpers ---

function makeLogger(): ILogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as ILogger;
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn(),
    publishAll: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  } as unknown as IEventBus;
}

function makeOrderRepo(): IOrderRepository {
  return {
    get: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    getByStrategyId: jest.fn().mockResolvedValue([]),
    countByStrategyId: jest.fn().mockResolvedValue(0),
  } as unknown as IOrderRepository;
}

function makePortfolioStore(): IPortfolioStore {
  return {
    get: jest.fn().mockReturnValue({ version: 1 } as unknown as Portfolio),
    save: jest.fn(),
  } as unknown as IPortfolioStore;
}

function makePlaceOrderUseCase(): PlaceOrderUseCase {
  return { execute: jest.fn() } as unknown as PlaceOrderUseCase;
}

function makeCancelOrderUseCase(): CancelOrderUseCase {
  return { execute: jest.fn() } as unknown as CancelOrderUseCase;
}

function makeStrategy(id: string, initResult: 'ok' | 'err' = 'ok'): IStrategy {
  return {
    id,
    name: `Strategy-${id}`,
    initialize: jest.fn().mockResolvedValue(
      initResult === 'ok' ? Ok(undefined) : Err(new Error('Init failed'))
    ),
    stop: jest.fn().mockResolvedValue(undefined),
    getMetrics: jest.fn().mockReturnValue({ ordersPlaced: 0 }),
  };
}

function makeRiskEvent(strategyId?: string): RiskLimitBreachedEvent {
  return {
    type: 'RISK_LIMIT_BREACHED',
    violationType: 'DRAWDOWN',
    violation: 'Max drawdown exceeded',
    triggeredAt: {} as never,
    strategyId,
  };
}

function makeRunner() {
  const logger = makeLogger();
  const eventBus = makeEventBus();
  const runner = new StrategyRunner({
    accountId: parseAccountId('venue:POLYMARKET:test-user')!,
    placeOrderUseCase: makePlaceOrderUseCase(),
    cancelOrderUseCase: makeCancelOrderUseCase(),
    orderRepo: makeOrderRepo(),
    portfolioStore: makePortfolioStore(),
    eventBus,
    logger,
  });
  return { runner, logger, eventBus };
}

// --- Tests ---

describe('StrategyRunner', () => {
  describe('start()', () => {
    it('инициализирует стратегию и возвращает Ok', async () => {
      const { runner } = makeRunner();
      const strategy = makeStrategy('s1');

      const result = await runner.start(strategy);

      expect(result.ok).toBe(true);
      expect(strategy.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ api: expect.objectContaining({ strategyId: 's1' }) })
      );
    });

    it('передаёт изолированный TradingAPI с правильным strategyId', async () => {
      const { runner } = makeRunner();
      let capturedCtx: StrategyContext | undefined;
      const strategy: IStrategy = {
        id: 's2',
        name: 'S2',
        initialize: jest.fn().mockImplementation(async (ctx: StrategyContext) => {
          capturedCtx = ctx;
          return Ok(undefined);
        }),
        stop: jest.fn(),
        getMetrics: jest.fn().mockReturnValue({}),
      };

      await runner.start(strategy);

      expect(capturedCtx?.api.strategyId).toBe('s2');
    });

    it('возвращает Err если initialize() вернул Err', async () => {
      const { runner } = makeRunner();
      const strategy = makeStrategy('s3', 'err');

      const result = await runner.start(strategy);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Init failed');
      }
    });

    it('вызывает unsubscribeAll при провале initialize()', async () => {
      const { runner, eventBus } = makeRunner();
      const subscribeUnsub = jest.fn();
      (eventBus.subscribe as jest.Mock).mockReturnValue(subscribeUnsub);

      const strategy: IStrategy = {
        id: 's4',
        name: 'S4',
        initialize: jest.fn().mockImplementation(async (ctx: StrategyContext) => {
          // Подписываемся в initialize, потом возвращаем Err
          ctx.api.subscribe('BOOK_UPDATED', jest.fn());
          return Err(new Error('Init failed'));
        }),
        stop: jest.fn(),
        getMetrics: jest.fn().mockReturnValue({}),
      };

      await runner.start(strategy);

      // subscribeUnsub должен быть вызван при unsubscribeAll
      expect(subscribeUnsub).toHaveBeenCalled();
    });

    it('игнорирует повторный start одной стратегии', async () => {
      const { runner } = makeRunner();
      const strategy = makeStrategy('s5');

      await runner.start(strategy);
      const result = await runner.start(strategy);

      expect(result.ok).toBe(true);
      // initialize вызван только 1 раз
      expect(strategy.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('вызывает strategy.stop() и unsubscribeAll', async () => {
      const { runner, eventBus } = makeRunner();
      const subscribeUnsub = jest.fn();
      (eventBus.subscribe as jest.Mock).mockReturnValue(subscribeUnsub);

      const strategy: IStrategy = {
        id: 's6',
        name: 'S6',
        initialize: jest.fn().mockImplementation(async (ctx: StrategyContext) => {
          ctx.api.subscribe('BOOK_UPDATED', jest.fn());
          return Ok(undefined);
        }),
        stop: jest.fn().mockResolvedValue(undefined),
        getMetrics: jest.fn().mockReturnValue({}),
      };

      await runner.start(strategy);
      await runner.stop('s6');

      expect(strategy.stop).toHaveBeenCalled();
      expect(subscribeUnsub).toHaveBeenCalled();
    });

    it('убирает стратегию из активных после stop', async () => {
      const { runner } = makeRunner();
      const strategy = makeStrategy('s7');

      await runner.start(strategy);
      await runner.stop('s7');

      expect(runner.getMetrics('s7')).toBeUndefined();
    });

    it('нет ошибки при stop несуществующей стратегии', async () => {
      const { runner } = makeRunner();
      await expect(runner.stop('nonexistent')).resolves.toBeUndefined();
    });

    it('логирует ошибку если strategy.stop() бросает, но продолжает', async () => {
      const { runner, logger } = makeRunner();
      const strategy: IStrategy = {
        id: 's8',
        name: 'S8',
        initialize: jest.fn().mockResolvedValue(Ok(undefined)),
        stop: jest.fn().mockRejectedValue(new Error('Stop failed')),
        getMetrics: jest.fn().mockReturnValue({}),
      };

      await runner.start(strategy);
      await runner.stop('s8');

      // unsubscribeAll всё равно был вызван, стратегия удалена
      expect(runner.getMetrics('s8')).toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('stopAll()', () => {
    it('останавливает все активные стратегии', async () => {
      const { runner } = makeRunner();
      const s1 = makeStrategy('s9');
      const s2 = makeStrategy('s10');

      await runner.start(s1);
      await runner.start(s2);
      await runner.stopAll();

      expect(s1.stop).toHaveBeenCalled();
      expect(s2.stop).toHaveBeenCalled();
      expect(runner.getMetrics('s9')).toBeUndefined();
      expect(runner.getMetrics('s10')).toBeUndefined();
    });

    it('безопасен при отсутствии активных стратегий', async () => {
      const { runner } = makeRunner();
      await expect(runner.stopAll()).resolves.toBeUndefined();
    });
  });

  describe('getMetrics()', () => {
    it('возвращает метрики активной стратегии', async () => {
      const { runner } = makeRunner();
      const strategy = makeStrategy('s11');
      (strategy.getMetrics as jest.Mock).mockReturnValue({ ordersPlaced: 42 });

      await runner.start(strategy);

      expect(runner.getMetrics('s11')).toEqual({ ordersPlaced: 42 });
    });

    it('возвращает undefined для неизвестной стратегии', () => {
      const { runner } = makeRunner();
      expect(runner.getMetrics('unknown')).toBeUndefined();
    });
  });

  describe('onRiskBreached()', () => {
    it('останавливает конкретную стратегию если strategyId указан', async () => {
      const { runner } = makeRunner();
      const strategy = makeStrategy('s12');

      await runner.start(strategy);
      await runner.onRiskBreached(makeRiskEvent('s12'));

      expect(strategy.stop).toHaveBeenCalled();
      expect(runner.getMetrics('s12')).toBeUndefined();
    });

    it('останавливает все стратегии если strategyId отсутствует', async () => {
      const { runner } = makeRunner();
      const s1 = makeStrategy('s13');
      const s2 = makeStrategy('s14');

      await runner.start(s1);
      await runner.start(s2);
      await runner.onRiskBreached(makeRiskEvent(undefined));

      expect(s1.stop).toHaveBeenCalled();
      expect(s2.stop).toHaveBeenCalled();
    });
  });
});

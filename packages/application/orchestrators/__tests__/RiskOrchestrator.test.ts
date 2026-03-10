import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RiskOrchestrator } from '../src/RiskOrchestrator.js';
import type { RiskOrchestratorDeps } from '../src/RiskOrchestrator.js';
import type { IStrategyRunner } from '../src/IStrategyRunner.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { RiskLimitBreachedEvent } from '@polymarket/event-bus';
import type { Timestamp } from '@polymarket/value-objects';

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

function makeEventBus(): IEventBus & {
  _triggerRiskBreached: (event: RiskLimitBreachedEvent) => Promise<void>;
} {
  let riskHandler: ((event: RiskLimitBreachedEvent) => Promise<void>) | undefined;

  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
      (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'RISK_LIMIT_BREACHED') {
          riskHandler = handler;
        }
        return () => { riskHandler = undefined; };
      }
    ) as IEventBus['subscribe'],
    _triggerRiskBreached: async (event: RiskLimitBreachedEvent) => {
      if (riskHandler) await riskHandler(event);
    },
  };
}

function makeStrategyRunner(shouldThrow = false): IStrategyRunner {
  return {
    onRiskBreached: jest.fn<IStrategyRunner['onRiskBreached']>().mockImplementation(
      shouldThrow
        ? () => Promise.reject(new Error('StrategyRunner error'))
        : () => Promise.resolve()
    ),
  };
}

function makeRiskEvent(strategyId?: string): RiskLimitBreachedEvent {
  return {
    type: 'RISK_LIMIT_BREACHED',
    violationType: 'DRAWDOWN',
    violation: 'Drawdown exceeded 10%',
    triggeredAt: {} as Timestamp,
    strategyId,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RiskOrchestrator', () => {
  let logger: ILogger;
  let eventBus: ReturnType<typeof makeEventBus>;
  let strategyRunner: IStrategyRunner;
  let deps: RiskOrchestratorDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    strategyRunner = makeStrategyRunner(false);
    deps = { eventBus, strategyRunner, logger };
  });

  it('подписывается на RISK_LIMIT_BREACHED при register()', () => {
    const orchestrator = new RiskOrchestrator(deps);
    orchestrator.register();
    expect(eventBus.subscribe).toHaveBeenCalledWith('RISK_LIMIT_BREACHED', expect.any(Function));
  });

  it('вызывает strategyRunner.onRiskBreached при получении события', async () => {
    const orchestrator = new RiskOrchestrator(deps);
    orchestrator.register();
    const event = makeRiskEvent('strategy-1');
    await eventBus._triggerRiskBreached(event);
    expect(strategyRunner.onRiskBreached).toHaveBeenCalledWith(event);
  });

  it('вызывает onRiskBreached для системного нарушения (strategyId undefined)', async () => {
    const orchestrator = new RiskOrchestrator(deps);
    orchestrator.register();
    const event = makeRiskEvent(undefined);
    await eventBus._triggerRiskBreached(event);
    expect(strategyRunner.onRiskBreached).toHaveBeenCalledWith(event);
  });

  it('логирует error если onRiskBreached бросает исключение', async () => {
    strategyRunner = makeStrategyRunner(true);
    const orchestrator = new RiskOrchestrator({ ...deps, strategyRunner });
    orchestrator.register();
    await eventBus._triggerRiskBreached(makeRiskEvent('s-1'));
    expect(logger.error).toHaveBeenCalledWith(
      'StrategyRunner.onRiskBreached failed',
      expect.objectContaining({ violationType: 'DRAWDOWN' }),
    );
  });

  it('логирует warn при получении риск-события', async () => {
    const orchestrator = new RiskOrchestrator(deps);
    orchestrator.register();
    await eventBus._triggerRiskBreached(makeRiskEvent('s-1'));
    expect(logger.warn).toHaveBeenCalledWith(
      'Risk limit breached, notifying StrategyRunner',
      expect.objectContaining({ violationType: 'DRAWDOWN' }),
    );
  });

  it('логирует info при register()', () => {
    const orchestrator = new RiskOrchestrator(deps);
    orchestrator.register();
    expect(logger.info).toHaveBeenCalledWith('RiskOrchestrator registered');
  });

  it('не вызывает onRiskBreached если не зарегистрирован', async () => {
    new RiskOrchestrator(deps);
    // Не вызываем register()
    await eventBus._triggerRiskBreached(makeRiskEvent());
    expect(strategyRunner.onRiskBreached).not.toHaveBeenCalled();
  });
});

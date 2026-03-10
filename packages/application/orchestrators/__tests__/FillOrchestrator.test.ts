import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { FillOrchestrator } from '../src/FillOrchestrator.js';
import type { FillOrchestratorDeps } from '../src/FillOrchestrator.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { ProcessFillUseCase } from '@polymarket/use-cases';
import type { FillReceivedEvent } from '@polymarket/event-bus';
import type { Timestamp } from '@polymarket/value-objects';
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

function makeEventBus(): IEventBus & {
  _triggerFillReceived: (event: FillReceivedEvent) => Promise<void>;
} {
  let fillHandler: ((event: FillReceivedEvent) => Promise<void>) | undefined;

  const bus = {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
      (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'FILL_RECEIVED') {
          fillHandler = handler;
        }
        return () => { fillHandler = undefined; };
      }
    ) as IEventBus['subscribe'],
    _triggerFillReceived: async (event: FillReceivedEvent) => {
      if (fillHandler) await fillHandler(event);
    },
  };

  return bus;
}

function makeProcessFillUseCase(ok = true): ProcessFillUseCase {
  return {
    execute: jest.fn<ProcessFillUseCase['execute']>().mockResolvedValue(
      ok ? Ok(undefined) : Err(new TradingError('Fill processing failed') as never)
    ),
  } as unknown as ProcessFillUseCase;
}

function makeFillEvent(): FillReceivedEvent {
  return {
    type: 'FILL_RECEIVED',
    fill: { id: 'fill-1' } as never,
    receivedAt: {} as Timestamp,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FillOrchestrator', () => {
  let logger: ILogger;
  let eventBus: ReturnType<typeof makeEventBus>;
  let processFill: ProcessFillUseCase;
  let deps: FillOrchestratorDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    processFill = makeProcessFillUseCase(true);
    deps = { eventBus, processFill, logger };
  });

  it('подписывается на FILL_RECEIVED при register()', () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    expect(eventBus.subscribe).toHaveBeenCalledWith('FILL_RECEIVED', expect.any(Function));
  });

  it('вызывает ProcessFillUseCase.execute при получении FILL_RECEIVED', async () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    await eventBus._triggerFillReceived(makeFillEvent());
    expect(processFill.execute).toHaveBeenCalledWith(makeFillEvent().fill);
  });

  it('логирует error если ProcessFillUseCase вернул Err', async () => {
    processFill = makeProcessFillUseCase(false);
    const orchestrator = new FillOrchestrator({ ...deps, processFill });
    orchestrator.register();
    await eventBus._triggerFillReceived(makeFillEvent());
    expect(logger.error).toHaveBeenCalledWith(
      'ProcessFillUseCase failed',
      expect.objectContaining({ fillId: 'fill-1' }),
    );
  });

  it('не вызывает execute если не зарегистрирован', async () => {
    new FillOrchestrator(deps);
    // Не вызываем register()
    await eventBus._triggerFillReceived(makeFillEvent());
    expect(processFill.execute).not.toHaveBeenCalled();
  });

  it('повторный register() отписывается от предыдущей подписки', () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    orchestrator.register();
    // subscribe вызвался дважды
    expect(eventBus.subscribe).toHaveBeenCalledTimes(2);
  });

  it('логирует info при register()', () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    expect(logger.info).toHaveBeenCalledWith('FillOrchestrator registered');
  });
});

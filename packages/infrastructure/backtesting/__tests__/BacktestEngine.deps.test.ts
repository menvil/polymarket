/**
 * Инвариант зависимостей BacktestEngine: eventBus и metadataGenerator —
 * атомарная пара (M-003 follow-up).
 *
 * @remarks
 * Compile-time: смешанная конфигурация не выражается типами
 * (`BacktestEventPublishingDeps` — union «оба или ни одного»).
 * Runtime: обход типов (JS/casts) ловится fail-fast в конструкторе —
 * молчаливого пропуска TRADE_RECEIVED из-за отсутствующего генератора нет.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { Ok } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import { BacktestEngine } from '../src/BacktestEngine.js';
import type { BacktestConfig, BacktestDeps } from '../src/BacktestEngine.js';
import type { BookUpdateHandler } from '@polymarket/handlers';

function makeLogger(): ILogger {
  const logger = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  } as unknown as ILogger;
  (logger.child as jest.Mock).mockReturnValue(logger);
  return logger;
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn() as IEventBus['subscribe'],
  };
}

function makeMetadataGenerator(): MessageMetadataGenerator {
  return new MessageMetadataGenerator({
    clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
    runId: unsafeRunId('testrun1'),
  });
}

const BOOK_HANDLER = { handleSnapshot: async () => undefined } as unknown as BookUpdateHandler;
const CONFIG: BacktestConfig = { filePaths: ['/nonexistent.jsonl'], outcomeIndex: 0 };

describe('BacktestEngine — атомарная пара eventBus + metadataGenerator', () => {
  it('valid: оба присутствуют', () => {
    const deps: BacktestDeps = {
      bookUpdateHandler: BOOK_HANDLER,
      logger: makeLogger(),
      eventBus: makeEventBus(),
      metadataGenerator: makeMetadataGenerator(),
    };
    expect(() => new BacktestEngine(CONFIG, deps)).not.toThrow();
  });

  it('valid: оба отсутствуют (публикация выключена)', () => {
    const deps: BacktestDeps = {
      bookUpdateHandler: BOOK_HANDLER,
      logger: makeLogger(),
    };
    expect(() => new BacktestEngine(CONFIG, deps)).not.toThrow();
  });

  it('compile-time invalid: eventBus без metadataGenerator', () => {
    // @ts-expect-error — eventBus без metadataGenerator не выражается типами (union-пара)
    const invalid: BacktestDeps = {
      bookUpdateHandler: BOOK_HANDLER,
      logger: makeLogger(),
      eventBus: makeEventBus(),
    };
    void invalid;
    expect(true).toBe(true);
  });

  it('compile-time invalid: metadataGenerator без eventBus', () => {
    // @ts-expect-error — metadataGenerator без eventBus не выражается типами (union-пара)
    const invalid: BacktestDeps = {
      bookUpdateHandler: BOOK_HANDLER,
      logger: makeLogger(),
      metadataGenerator: makeMetadataGenerator(),
    };
    void invalid;
    expect(true).toBe(true);
  });

  it('runtime fail-fast: обход типов с eventBus без generator бросает в конструкторе', () => {
    const bypass = {
      bookUpdateHandler: BOOK_HANDLER,
      logger: makeLogger(),
      eventBus: makeEventBus(),
      // metadataGenerator намеренно отсутствует — имитация JS/config bypass
    } as unknown as BacktestDeps;
    expect(() => new BacktestEngine(CONFIG, bypass)).toThrow(RangeError);
    expect(() => new BacktestEngine(CONFIG, bypass)).toThrow(/atomic pair/);
  });

  it('runtime fail-fast: generator без eventBus тоже бросает', () => {
    const bypass = {
      bookUpdateHandler: BOOK_HANDLER,
      logger: makeLogger(),
      metadataGenerator: makeMetadataGenerator(),
    } as unknown as BacktestDeps;
    expect(() => new BacktestEngine(CONFIG, bypass)).toThrow(RangeError);
  });
});

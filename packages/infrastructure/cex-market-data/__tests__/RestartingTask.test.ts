import { describe, it, expect, jest } from '@jest/globals';
import type { ILogger } from '@polymarket/logger';
import { RestartingTask } from '../src/RestartingTask.js';

function makeLogger(): ILogger {
  const logger = {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as unknown as ILogger['child'],
  };
  logger.child = jest.fn(() => logger) as unknown as ILogger['child'];
  return logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('Timed out waiting for condition');
}

describe('RestartingTask', () => {
  it('restarts the task after a failure', async () => {
    const logger = makeLogger();
    let runs = 0;

    const task = new RestartingTask({
      name: 'test-task',
      logger,
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      jitterRatio: 0,
      cooldownAfterFailures: 100,
      run: async (signal) => {
        runs++;
        if (runs === 1) throw new Error('boom');
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    task.start();
    await waitUntil(() => runs >= 2);
    await task.stop();

    expect(runs).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Restarting task session failed, restarting',
      expect.objectContaining({ task: 'test-task', failures: 1 }),
    );
  });

  it('does not start duplicate sessions when start is called twice', async () => {
    const logger = makeLogger();
    let runs = 0;

    const task = new RestartingTask({
      name: 'test-task',
      logger,
      run: async (signal) => {
        runs++;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    task.start();
    task.start();
    await waitUntil(() => runs === 1);
    await sleep(20);
    await task.stop();

    expect(runs).toBe(1);
    expect(logger.debug).toHaveBeenCalledWith(
      'Restarting task already running',
      { task: 'test-task' },
    );
  });

  it('enters cooldown after repeated failures', async () => {
    const logger = makeLogger();
    let runs = 0;

    const task = new RestartingTask({
      name: 'test-task',
      logger,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      jitterRatio: 0,
      cooldownAfterFailures: 2,
      cooldownMs: 50,
      run: async () => {
        runs++;
        throw new Error('boom');
      },
    });

    task.start();
    await waitUntil(() => runs >= 2);
    await waitUntil(() => (logger.warn as jest.Mock).mock.calls.some(
      ([message]) => message === 'Restarting task entering cooldown',
    ));
    await task.stop();

    expect(logger.warn).toHaveBeenCalledWith(
      'Restarting task entering cooldown',
      expect.objectContaining({ task: 'test-task', failures: 2, cooldownMs: 50 }),
    );
  });
});

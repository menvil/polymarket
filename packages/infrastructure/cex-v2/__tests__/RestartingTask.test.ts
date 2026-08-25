/**
 * Тесты supervised-петли RestartingTask (перенос V2, транспортный контур).
 */
import { describe, it, expect } from '@jest/globals';
import { PermanentTaskError, RestartingTask } from '../src/index.js';
import { CapturingLogger, sleep, waitUntil } from './helpers/fakes.js';

describe('RestartingTask', () => {
  it('перезапускает сессию после отказа с backoff', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      initialBackoffMs: 5,
      maxBackoffMs: 10,
      run: async () => {
        runs++;
        throw new Error('session failed');
      },
    });

    task.start();
    await waitUntil(() => runs >= 3);
    await task.stop();

    expect(runs).toBeGreaterThanOrEqual(3);
    expect(task.isRunning()).toBe(false);
  });

  it('нормальный return сессии — controlled restart без backoff-логов об отказе', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      run: async () => {
        runs++;
        // Реальная сессия всегда ждёт транспорт: мгновенный return дал бы
        // tight-loop рестартов без выхода в event loop
        await sleep(2);
      },
    });

    task.start();
    await waitUntil(() => runs >= 3);
    await task.stop();

    expect(logger.byLevel('warn')).toHaveLength(0);
  });

  it('stop абортит активную сессию и петля не воскресает', async () => {
    const logger = new CapturingLogger();
    let aborts = 0;
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      run: (signal) =>
        new Promise<void>((resolve) => {
          runs++;
          signal.addEventListener('abort', () => {
            aborts++;
            resolve();
          });
        }),
    });

    task.start();
    await waitUntil(() => runs === 1);
    await task.stop();
    const runsAfterStop = runs;
    await sleep(30);

    expect(aborts).toBe(1);
    expect(runs).toBe(runsAfterStop);
    expect(task.isRunning()).toBe(false);
  });

  it('stop во время backoff-паузы завершается немедленно', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      initialBackoffMs: 60_000,
      run: async () => {
        runs++;
        throw new Error('fail fast');
      },
    });

    task.start();
    await waitUntil(() => runs === 1);
    await sleep(10); // петля вошла в backoff

    const started = Date.now();
    await task.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('повторный start во время работы — no-op', async () => {
    const logger = new CapturingLogger();
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      run: async (signal) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        concurrent--;
      },
    });

    task.start();
    task.start();
    await sleep(20);
    await task.stop();

    expect(maxConcurrent).toBe(1);
  });

  it('controlled restart выдерживает минимальную паузу между сессиями', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const startedAt = Date.now();
    const task = new RestartingTask({
      name: 'test',
      logger,
      controlledRestartDelayMs: 40,
      // Мгновенно завершающаяся сессия: без паузы это был бы tight-loop
      run: async () => {
        runs++;
      },
    });

    task.start();
    await waitUntil(() => runs >= 3);
    await task.stop();

    // Между тремя сессиями минимум две паузы по 40ms
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
    expect(logger.byLevel('warn')).toHaveLength(0);
  });

  it('stop во время controlled-паузы завершается немедленно', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      controlledRestartDelayMs: 60_000,
      run: async () => {
        runs++;
      },
    });

    task.start();
    await waitUntil(() => runs === 1);
    await sleep(10); // петля вошла в controlled-паузу

    const started = Date.now();
    await task.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(runs).toBe(1);
  });

  it('PermanentTaskError останавливает петлю без рестартов', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      initialBackoffMs: 1,
      run: async () => {
        runs++;
        throw new PermanentTaskError('capability is not supported');
      },
    });

    task.start();
    await waitUntil(() => !task.isRunning());
    await sleep(20);

    // Ровно одна сессия: перманентный отказ не ретраится
    expect(runs).toBe(1);
    expect(
      logger
        .byLevel('error')
        .some(
          (entry) =>
            entry.message.includes('failed permanently') &&
            String(entry.context?.['error'] ?? '').includes('capability is not supported'),
        ),
    ).toBe(true);
    await task.stop();
  });

  it('серия быстрых отказов уходит в cooldown', async () => {
    const logger = new CapturingLogger();
    let runs = 0;
    const task = new RestartingTask({
      name: 'test',
      logger,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      cooldownAfterFailures: 3,
      cooldownMs: 60_000,
      run: async () => {
        runs++;
        throw new Error('fail');
      },
    });

    task.start();
    await waitUntil(() =>
      logger.byLevel('warn').some((entry) => entry.message.includes('cooldown')),
    );
    const runsAtCooldown = runs;
    await sleep(30);
    // Во время cooldown новые сессии не запускаются
    expect(runs).toBe(runsAtCooldown);

    await task.stop();
  });
});

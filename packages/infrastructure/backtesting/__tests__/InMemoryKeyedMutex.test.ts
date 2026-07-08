import { describe, it, expect } from '@jest/globals';
import { InMemoryKeyedMutex } from '../src/InMemoryKeyedMutex.js';

/** Ожидает N микротасков/таймеров, чтобы дать очереди мьютекса продвинуться. */
function tick(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('InMemoryKeyedMutex', () => {
  it('выполняет fn и возвращает её результат', async () => {
    const mutex = new InMemoryKeyedMutex();
    const result = await mutex.runExclusive(['key-1'], async () => 42);
    expect(result).toBe(42);
  });

  it('пробрасывает исключение из fn, но освобождает блокировку', async () => {
    const mutex = new InMemoryKeyedMutex();
    await expect(
      mutex.runExclusive(['key-1'], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Блокировка освобождена — следующий вызов на тот же ключ не виснет
    const result = await mutex.runExclusive(['key-1'], async () => 'ok');
    expect(result).toBe('ok');
  });

  it('сериализует конкурентные вызовы с пересекающимся ключом', async () => {
    const mutex = new InMemoryKeyedMutex();
    const order: string[] = [];

    const first = mutex.runExclusive(['key-1'], async () => {
      order.push('first-start');
      await tick(10);
      order.push('first-end');
    });
    // Второй вызов стартует, пока первый ещё выполняется (нет await между ними)
    const second = mutex.runExclusive(['key-1'], async () => {
      order.push('second-start');
      await tick();
      order.push('second-end');
    });

    await Promise.all([first, second]);

    // Второй вызов не мог начать выполнение ДО завершения первого — иначе
    // порядок был бы ['first-start', 'second-start', ...].
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('НЕ сериализует конкурентные вызовы с непересекающимися ключами', async () => {
    const mutex = new InMemoryKeyedMutex();
    const order: string[] = [];

    const a = mutex.runExclusive(['key-a'], async () => {
      order.push('a-start');
      await tick(10);
      order.push('a-end');
    });
    const b = mutex.runExclusive(['key-b'], async () => {
      order.push('b-start');
      await tick();
      order.push('b-end');
    });

    await Promise.all([a, b]);

    // b не заблокирован a (разные ключи) — должен успеть начаться И завершиться,
    // пока a ещё выполняется (не сериализованы).
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('сериализует по составному набору ключей, если наборы пересекаются частично', async () => {
    const mutex = new InMemoryKeyedMutex();
    const order: string[] = [];

    // Первый вызов держит [accountId, orderId1]; второй хочет [orderId1, instrumentId] —
    // пересечение по orderId1 должно заставить второй ждать.
    const first = mutex.runExclusive(['account-1', 'order-1'], async () => {
      order.push('first-start');
      await tick(10);
      order.push('first-end');
    });
    const second = mutex.runExclusive(['order-1', 'instrument-1'], async () => {
      order.push('second-start');
      await tick();
      order.push('second-end');
    });

    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('дедуплицирует повторяющиеся ключи в одном вызове без побочных эффектов', async () => {
    const mutex = new InMemoryKeyedMutex();
    const result = await mutex.runExclusive(['key-1', 'key-1', 'key-1'], async () => 'ok');
    expect(result).toBe('ok');

    // Ключ корректно освобождён — следующий вызов не виснет
    const next = await mutex.runExclusive(['key-1'], async () => 'next');
    expect(next).toBe('next');
  });
});

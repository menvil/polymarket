/**
 * Тесты FifoMessageQueue — FIFO-семантика и amortized O(1) без Array.shift().
 *
 * @remarks
 * Проверяется только observable-поведение (порядок, size, возвраты) — backing
 * array и момент compaction тестами не фиксируются.
 */
import { describe, it, expect } from '@jest/globals';
import { FifoMessageQueue } from '../src/queue/FifoMessageQueue.js';

describe('FifoMessageQueue', () => {
  it('пустая очередь: size 0, dequeue → undefined', () => {
    const queue = new FifoMessageQueue<number>();
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('enqueue/dequeue одного элемента', () => {
    const queue = new FifoMessageQueue<string>();
    queue.enqueue('a');
    expect(queue.size).toBe(1);
    expect(queue.dequeue()).toBe('a');
    expect(queue.size).toBe(0);
  });

  it('FIFO-порядок при нескольких элементах', () => {
    const queue = new FifoMessageQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.dequeue()).toBe(1);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('enqueueMany сохраняет порядок и смешивается с enqueue', () => {
    const queue = new FifoMessageQueue<number>();
    queue.enqueue(1);
    queue.enqueueMany([2, 3, 4]);
    queue.enqueue(5);
    const drained: number[] = [];
    for (let item = queue.dequeue(); item !== undefined; item = queue.dequeue()) {
      drained.push(item);
    }
    expect(drained).toEqual([1, 2, 3, 4, 5]);
  });

  it('enqueueMany с пустым массивом ничего не меняет', () => {
    const queue = new FifoMessageQueue<number>();
    queue.enqueueMany([]);
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('clear опустошает очередь, очередь остаётся рабочей', () => {
    const queue = new FifoMessageQueue<number>();
    queue.enqueueMany([1, 2, 3]);
    queue.dequeue();
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();

    queue.enqueue(42);
    expect(queue.size).toBe(1);
    expect(queue.dequeue()).toBe(42);
  });

  it('size отражает количество ожидающих элементов на каждом шаге', () => {
    const queue = new FifoMessageQueue<number>();
    expect(queue.size).toBe(0);
    queue.enqueue(1);
    expect(queue.size).toBe(1);
    queue.enqueueMany([2, 3]);
    expect(queue.size).toBe(3);
    queue.dequeue();
    expect(queue.size).toBe(2);
    queue.dequeue();
    queue.dequeue();
    expect(queue.size).toBe(0);
  });

  it('переиспользование после полного опустошения работает FIFO', () => {
    const queue = new FifoMessageQueue<number>();
    queue.enqueueMany([1, 2]);
    expect(queue.dequeue()).toBe(1);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBeUndefined();

    queue.enqueueMany([10, 11]);
    expect(queue.dequeue()).toBe(10);
    expect(queue.dequeue()).toBe(11);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('compaction не ломает порядок при чередовании enqueue/dequeue поверх порога', () => {
    const queue = new FifoMessageQueue<number>();
    // Держим в очереди ~50 элементов, прогоняя 10 000 значений насквозь —
    // consumed prefix многократно превышает порог compaction.
    let next = 0;
    let expected = 0;
    for (let i = 0; i < 50; i++) queue.enqueue(next++);
    for (let round = 0; round < 10_000; round++) {
      queue.enqueue(next++);
      const item = queue.dequeue();
      expect(item).toBe(expected++);
    }
    expect(queue.size).toBe(50);
    for (let item = queue.dequeue(); item !== undefined; item = queue.dequeue()) {
      expect(item).toBe(expected++);
    }
    expect(expected).toBe(next);
  });

  it('100 000 элементов проходят строго FIFO', () => {
    const queue = new FifoMessageQueue<number>();
    const total = 100_000;
    for (let i = 0; i < total; i++) {
      queue.enqueue(i);
    }
    expect(queue.size).toBe(total);
    for (let i = 0; i < total; i++) {
      expect(queue.dequeue()).toBe(i);
    }
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('enqueue после большого consumed prefix продолжает корректный порядок', () => {
    const queue = new FifoMessageQueue<number>();
    for (let i = 0; i < 5000; i++) queue.enqueue(i);
    // Съедаем почти всё — остаётся хвост [4990..4999]
    for (let i = 0; i < 4990; i++) queue.dequeue();
    expect(queue.size).toBe(10);

    queue.enqueueMany([5000, 5001]);
    const drained: number[] = [];
    for (let item = queue.dequeue(); item !== undefined; item = queue.dequeue()) {
      drained.push(item);
    }
    expect(drained).toEqual([4990, 4991, 4992, 4993, 4994, 4995, 4996, 4997, 4998, 4999, 5000, 5001]);
  });
});

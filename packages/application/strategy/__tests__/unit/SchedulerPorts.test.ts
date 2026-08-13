import { describe, it, expect } from '@jest/globals';
import {
  DeterministicSchedulerTimer,
  NodeSchedulerTimer,
} from '../../src/ports/SchedulerTimer.js';
import {
  SequentialOrderIdGenerator,
  UuidOrderIdGenerator,
  OrderIdGeneratorConfigError,
} from '../../src/ports/OrderIdGenerator.js';

describe('DeterministicSchedulerTimer', () => {
  it('setTimeout срабатывает только при advance до due-времени', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    timer.setTimeout(() => fired.push('a'), 100);

    timer.advanceTo(99);
    expect(fired).toEqual([]);

    timer.advanceTo(100);
    expect(fired).toEqual(['a']);
  });

  it('clearTimeout отменяет запланированный вызов', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    const handle = timer.setTimeout(() => fired.push('a'), 100);
    timer.clearTimeout(handle);
    timer.advanceTo(1000);

    expect(fired).toEqual([]);
  });

  it('setInterval срабатывает несколько раз за один advance', () => {
    const timer = new DeterministicSchedulerTimer(0);
    let count = 0;

    timer.setInterval(() => { count++; }, 100);
    timer.advanceTo(350);

    expect(count).toBe(3);
  });

  it('порядок детерминирован: (dueAtMs, порядок постановки)', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    timer.setTimeout(() => fired.push('later'), 200);
    timer.setTimeout(() => fired.push('first'), 100);
    timer.setTimeout(() => fired.push('second'), 100);

    timer.advanceTo(300);

    expect(fired).toEqual(['first', 'second', 'later']);
  });

  it('таймер, поставленный из callback, срабатывает в том же advance если due', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    timer.setTimeout(() => {
      fired.push('outer');
      timer.setTimeout(() => fired.push('inner'), 50);
    }, 100);

    timer.advanceTo(200);

    expect(fired).toEqual(['outer', 'inner']);
  });

  it('исключение в callback не прерывает остальные таймеры', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    timer.setTimeout(() => { throw new Error('boom'); }, 100);
    timer.setTimeout(() => fired.push('survivor'), 150);

    timer.advanceTo(200);

    expect(fired).toEqual(['survivor']);
  });

  it('advance назад — no-op', () => {
    const timer = new DeterministicSchedulerTimer(500);
    const fired: string[] = [];
    timer.setTimeout(() => fired.push('a'), 100);

    timer.advanceTo(100); // назад
    expect(fired).toEqual([]);
    expect(timer.nowMs).toBe(500);
  });

  it('setTimeout(0) + advanceTo(current) → callback срабатывает ровно один раз', () => {
    const timer = new DeterministicSchedulerTimer(100);
    let calls = 0;

    timer.setTimeout(() => { calls++; }, 0);
    // nowMs не продвигается (dueAtMs === текущее время) — раньше это было
    // no-op (guard `nowMs <= this._nowMs`) и callback терялся.
    timer.advanceTo(100);

    expect(calls).toBe(1);
  });

  it('equal dueAt ordering сохраняет insertion order (повторный вызов advanceTo той же цели — идемпотентен)', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    timer.setTimeout(() => fired.push('first'), 100);
    timer.setTimeout(() => fired.push('second'), 100);

    timer.advanceTo(100);
    timer.advanceTo(100); // повторный вызов — нет due-таймеров, no-op

    expect(fired).toEqual(['first', 'second']);
  });

  it('callback создаёт zero-delay callback → детерминированное исполнение в том же advanceTo', () => {
    const timer = new DeterministicSchedulerTimer(0);
    const fired: string[] = [];

    timer.setTimeout(() => {
      fired.push('outer');
      timer.setTimeout(() => fired.push('zero-delay-inner'), 0);
    }, 50);

    timer.advanceTo(50);

    expect(fired).toEqual(['outer', 'zero-delay-inner']);
  });
});

describe('NodeSchedulerTimer', () => {
  it('setTimeout/clearTimeout работают через непрозрачный handle', async () => {
    const timer = new NodeSchedulerTimer();
    const fired: string[] = [];

    const h1 = timer.setTimeout(() => fired.push('a'), 5);
    const h2 = timer.setTimeout(() => fired.push('b'), 5);
    timer.clearTimeout(h2);
    // Повторный clear — безопасный no-op.
    timer.clearTimeout(h2);
    expect(h1.id).not.toBe(h2.id);

    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toEqual(['a']);
  });

  it('setInterval/clearInterval работают через непрозрачный handle', async () => {
    const timer = new NodeSchedulerTimer();
    let count = 0;

    const h = timer.setInterval(() => { count++; }, 5);
    await new Promise((r) => setTimeout(r, 18));
    timer.clearInterval(h);
    const after = count;
    await new Promise((r) => setTimeout(r, 15));

    expect(after).toBeGreaterThanOrEqual(1);
    expect(count).toBe(after); // после clear не растёт
  });
});

describe('SequentialOrderIdGenerator', () => {
  it('детерминированная монотонная последовательность', () => {
    const gen = new SequentialOrderIdGenerator('bt');
    expect(String(gen.next())).toBe('bt-1');
    expect(String(gen.next())).toBe('bt-2');
    expect(String(gen.next())).toBe('bt-3');
  });

  it('два экземпляра с одинаковым префиксом дают одинаковые последовательности (replay)', () => {
    const gen1 = new SequentialOrderIdGenerator('replay');
    const gen2 = new SequentialOrderIdGenerator('replay');
    const seq1 = [gen1.next(), gen1.next()].map(String);
    const seq2 = [gen2.next(), gen2.next()].map(String);
    expect(seq1).toEqual(seq2);
  });

  it('пустой prefix отклонён (OrderIdGeneratorConfigError)', () => {
    expect(() => new SequentialOrderIdGenerator('')).toThrow(OrderIdGeneratorConfigError);
  });

  it('whitespace-only prefix отклонён', () => {
    expect(() => new SequentialOrderIdGenerator('   ')).toThrow(OrderIdGeneratorConfigError);
  });

  it('control characters в prefix отклонены', () => {
    expect(() => new SequentialOrderIdGenerator('bad\u0000prefix')).toThrow(OrderIdGeneratorConfigError);
  });

  it('валидный prefix даёт стабильную детерминированную последовательность', () => {
    const gen = new SequentialOrderIdGenerator('valid-prefix');
    expect(String(gen.next())).toBe('valid-prefix-1');
    expect(String(gen.next())).toBe('valid-prefix-2');
  });
});

describe('UuidOrderIdGenerator', () => {
  it('генерирует уникальные валидные OrderId', () => {
    const gen = new UuidOrderIdGenerator();
    const a = gen.next();
    const b = gen.next();
    expect(String(a)).not.toBe(String(b));
    expect(String(a).length).toBeGreaterThan(0);
  });
});

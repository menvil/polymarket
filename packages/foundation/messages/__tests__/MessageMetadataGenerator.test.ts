/**
 * Тесты MessageMetadataGenerator — identity, ordering, время и causal chain.
 *
 * @remarks
 * Все тесты детерминированы: wall-clock — `PaperClock`, sub-ms —
 * `FixedHighResolutionClock`. Реальное время процесса не используется нигде.
 */
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { unsafeRunId, asRunId } from '@polymarket/ids';
import type { MessageMetadata } from '../src/index.js';
import {
  MessageMetadataGenerator,
  FixedHighResolutionClock,
  SystemHighResolutionClock,
  generateRunId,
} from '../src/index.js';

/** Базовый детерминированный момент: 2026-08-14T00:41:27.123Z. */
const BASE_EPOCH_MS = 1786668087123;

/** Собирает детерминированный генератор с управляемыми clock-ами. */
function createGenerator(overrides?: {
  runId?: string;
  epochMs?: number;
  hrNanoseconds?: bigint;
}): { generator: MessageMetadataGenerator; clock: PaperClock; hr: FixedHighResolutionClock } {
  const clock = new PaperClock(new Date(overrides?.epochMs ?? BASE_EPOCH_MS));
  const hr = new FixedHighResolutionClock(overrides?.hrNanoseconds ?? 456_789n);
  const generator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: hr,
    runId: unsafeRunId(overrides?.runId ?? 'testrun1'),
  });
  return { generator, clock, hr };
}

describe('MessageMetadataGenerator — sequence (Test 1)', () => {
  it('nextRoot() выдаёт 1, 2, 3 — строго возрастающий порядок с единицы', () => {
    const { generator } = createGenerator();
    expect(generator.nextRoot().sequence).toBe(1);
    expect(generator.nextRoot().sequence).toBe(2);
    expect(generator.nextRoot().sequence).toBe(3);
  });

  it('nextChild() разделяет тот же счётчик с nextRoot()', () => {
    const { generator } = createGenerator();
    const root = generator.nextRoot(); // 1
    const child = generator.nextChild(root); // 2
    const grandchild = generator.nextChild(child); // 3
    expect([root.sequence, child.sequence, grandchild.sequence]).toEqual([1, 2, 3]);
  });

  it('fail-fast RangeError при переполнении safe integer', () => {
    const { generator } = createGenerator();
    // Ставим счётчик на MAX_SAFE_INTEGER — следующий инкремент вышел бы за safe-диапазон
    (generator as unknown as { _sequence: number })._sequence = Number.MAX_SAFE_INTEGER;
    expect(() => generator.nextRoot()).toThrow(RangeError);
    expect(() => generator.nextRoot()).toThrow(/sequence overflow/);
  });
});

describe('MessageMetadataGenerator — unique MessageId (Test 2)', () => {
  it('5000 сообщений → все MessageId уникальны', () => {
    const { generator } = createGenerator();
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(String(generator.nextRoot().messageId));
    }
    expect(ids.size).toBe(5000);
  });
});

describe('MessageMetadataGenerator — same tick (Test 3)', () => {
  it('одинаковое время у двух вызовов → time-компоненты совпадают, sequence и messageId различаются', () => {
    const { generator } = createGenerator(); // PaperClock заморожен, hr фиксирован
    const first = generator.nextRoot();
    const second = generator.nextRoot();

    expect(second.createdAtUnixSeconds).toBe(first.createdAtUnixSeconds);
    expect(second.millisecondOfSecond).toBe(first.millisecondOfSecond);
    expect(second.microsecondOfMillisecond).toBe(first.microsecondOfMillisecond);
    expect(second.nanosecondOfMicrosecond).toBe(first.nanosecondOfMicrosecond);

    expect(second.sequence).not.toBe(first.sequence);
    expect(second.messageId).not.toBe(first.messageId);
  });
});

describe('MessageMetadataGenerator — root correlation (Test 4)', () => {
  it('root: correlationId === messageId, causationId отсутствует', () => {
    const { generator } = createGenerator();
    const root = generator.nextRoot();
    expect(root.correlationId).toBe(root.messageId);
    expect(root.causationId).toBeUndefined();
  });
});

describe('MessageMetadataGenerator — child (Test 5)', () => {
  it('child наследует correlationId root-а, causationId === parent.messageId', () => {
    const { generator } = createGenerator();
    const m1 = generator.nextRoot();
    const m2 = generator.nextChild(m1);

    expect(m2.correlationId).toBe(m1.correlationId);
    expect(m2.correlationId).toBe(m1.messageId); // у root correlation = свой id
    expect(m2.causationId).toBe(m1.messageId);
    expect(m2.messageId).not.toBe(m1.messageId);
  });
});

describe('MessageMetadataGenerator — grandchild chain (Test 6)', () => {
  it('M1 → M2 → M3: correlation остаётся M1, causation — непосредственный parent', () => {
    const { generator } = createGenerator();
    const m1 = generator.nextRoot();
    const m2 = generator.nextChild(m1);
    const m3 = generator.nextChild(m2);

    expect(m3.correlationId).toBe(m1.messageId);
    expect(m3.causationId).toBe(m2.messageId);

    // Полная цепочка M1 → M2 → M3 → M4 (ещё один application-событийный шаг)
    const m4 = generator.nextChild(m3);
    expect(m4.correlationId).toBe(m1.messageId);
    expect(m4.causationId).toBe(m3.messageId);
  });
});

describe('MessageMetadataGenerator — run identity (Test 7)', () => {
  it('два runtime: одинаковый sequence, но разные runId и MessageId', () => {
    const a = createGenerator({ runId: 'runaaaa1' }).generator;
    const b = createGenerator({ runId: 'runbbbb2' }).generator;

    const fromA = a.nextRoot();
    const fromB = b.nextRoot();

    expect(fromA.sequence).toBe(1);
    expect(fromB.sequence).toBe(1);
    expect(fromA.runId).not.toBe(fromB.runId);
    expect(fromA.messageId).not.toBe(fromB.messageId);
  });

  it('runId генератора доступен и постоянен для всех metadata', () => {
    const { generator } = createGenerator({ runId: 'runzzzz9' });
    expect(generator.runId).toBe('runzzzz9');
    expect(generator.nextRoot().runId).toBe('runzzzz9');
    expect(generator.nextChild(generator.nextRoot()).runId).toBe('runzzzz9');
  });
});

describe('MessageMetadataGenerator — concurrency-style scheduling (Test 8)', () => {
  it('microtasks/timers с одним генератором: нет дубликатов sequence/messageId, порядок фактических вызовов строгий', async () => {
    const { generator } = createGenerator();
    const observed: MessageMetadata[] = [];

    // Смесь microtask- и timer-планирования, как у реальных async producers
    // (WS callbacks разных бирж готовы «одновременно»)
    const producers: Array<Promise<void>> = [];
    for (let i = 0; i < 200; i++) {
      if (i % 3 === 0) {
        producers.push(
          Promise.resolve().then(() => {
            observed.push(generator.nextRoot());
          }),
        );
      } else if (i % 3 === 1) {
        producers.push(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              observed.push(generator.nextRoot());
              resolve();
            }, 0);
          }),
        );
      } else {
        producers.push(
          Promise.resolve()
            .then(() => undefined)
            .then(() => {
              observed.push(generator.nextRoot());
            }),
        );
      }
    }
    await Promise.all(producers);

    expect(observed).toHaveLength(200);

    const sequences = observed.map((m) => m.sequence);
    const messageIds = new Set(observed.map((m) => String(m.messageId)));

    // Уникальность
    expect(new Set(sequences).size).toBe(200);
    expect(messageIds.size).toBe(200);

    // Строгое возрастание в порядке фактических вызовов генератора:
    // observed упорядочен порядком вызовов (push сразу за next), поэтому
    // sequence обязан расти строго монотонно
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
  });
});

describe('MessageMetadataGenerator — time ranges (Test 9)', () => {
  it('ms/us/ns компоненты в диапазоне 0..999 на границах hr-значений', () => {
    const probes: bigint[] = [0n, 1n, 999n, 1_000n, 999_999n, 1_000_000n, 123_456_789n];
    for (const ns of probes) {
      const { generator } = createGenerator({ hrNanoseconds: ns });
      const metadata = generator.nextRoot();
      expect(metadata.millisecondOfSecond).toBeGreaterThanOrEqual(0);
      expect(metadata.millisecondOfSecond).toBeLessThanOrEqual(999);
      expect(metadata.microsecondOfMillisecond).toBeGreaterThanOrEqual(0);
      expect(metadata.microsecondOfMillisecond).toBeLessThanOrEqual(999);
      expect(metadata.nanosecondOfMicrosecond).toBeGreaterThanOrEqual(0);
      expect(metadata.nanosecondOfMicrosecond).toBeLessThanOrEqual(999);
    }
  });

  it('hr-остаток внутри миллисекунды раскладывается на us/ns корректно', () => {
    // 456_789 ns внутри ms → 456 us + 789 ns
    const { generator } = createGenerator({ hrNanoseconds: 456_789n });
    const metadata = generator.nextRoot();
    expect(metadata.microsecondOfMillisecond).toBe(456);
    expect(metadata.nanosecondOfMicrosecond).toBe(789);
  });

  it('без highResolutionClock — честные нули (нет выдуманных наносекунд)', () => {
    const clock = new PaperClock(new Date(BASE_EPOCH_MS));
    const generator = new MessageMetadataGenerator({
      clock,
      runId: unsafeRunId('testrun1'),
    });
    const metadata = generator.nextRoot();
    expect(metadata.microsecondOfMillisecond).toBe(0);
    expect(metadata.nanosecondOfMicrosecond).toBe(0);
  });
});

describe('MessageMetadataGenerator — time consistency (Test 10)', () => {
  it('createdAt согласован с createdAtUnixSeconds и millisecondOfSecond', () => {
    const { generator } = createGenerator({ epochMs: BASE_EPOCH_MS });
    const metadata = generator.nextRoot();

    const epochMs = metadata.createdAt.toNumber();
    expect(epochMs).toBe(BASE_EPOCH_MS);
    expect(metadata.createdAtUnixSeconds).toBe(Math.floor(BASE_EPOCH_MS / 1000));
    expect(metadata.millisecondOfSecond).toBe(BASE_EPOCH_MS % 1000);

    // Обратная сборка: seconds*1000 + ms === createdAt
    expect(metadata.createdAtUnixSeconds * 1000 + metadata.millisecondOfSecond).toBe(epochMs);
  });

  it('после продвижения PaperClock поля описывают новый момент согласованно', () => {
    const { generator, clock } = createGenerator({ epochMs: BASE_EPOCH_MS });
    clock.tick(877); // 123 + 877 = 1000 → перенос в следующую секунду
    const metadata = generator.nextRoot();

    expect(metadata.createdAtUnixSeconds).toBe(Math.floor((BASE_EPOCH_MS + 877) / 1000));
    expect(metadata.millisecondOfSecond).toBe((BASE_EPOCH_MS + 877) % 1000);
    expect(metadata.createdAt.toNumber()).toBe(BASE_EPOCH_MS + 877);
  });
});

describe('MessageMetadataGenerator — deterministic fake clock (Test 11)', () => {
  it('одинаковые входы → идентичные metadata (кроме ничего: полная детерминированность)', () => {
    const first = createGenerator().generator.nextRoot();
    const second = createGenerator().generator.nextRoot();

    // Два независимых «runtime» с одинаковыми детерминированными входами
    // производят идентичные metadata — реального времени в тестах нет
    expect(second).toEqual(first);
  });

  it('messageId имеет канонический human-readable формат', () => {
    const { generator } = createGenerator();
    const metadata = generator.nextRoot();
    // testrun1-1786668087-123-456-789-000000001
    expect(String(metadata.messageId)).toBe('testrun1-1786668087-123-456-789-000000001');
    expect(String(metadata.messageId)).toMatch(/^[a-z0-9]{8}-\d+-\d{3}-\d{3}-\d{3}-\d{9}$/);
  });

  it('невалидное время от clock → понятная ошибка (fail-fast)', () => {
    const brokenClock = { now: (): Date => new Date(Number.NaN) };
    const generator = new MessageMetadataGenerator({
      clock: brokenClock,
      runId: unsafeRunId('testrun1'),
    });
    expect(() => generator.nextRoot()).toThrow(/invalid time from the injected clock/);
  });
});

describe('generateRunId / RunId auto-generation', () => {
  it('генерирует валидный RunId: 8 символов [a-z0-9]', () => {
    for (let i = 0; i < 100; i++) {
      const runId = generateRunId();
      expect(asRunId(String(runId))).toBe(runId);
    }
  });

  it('конструктор без runId сам генерирует валидный runtime identity', () => {
    const clock = new PaperClock(new Date(BASE_EPOCH_MS));
    const generator = new MessageMetadataGenerator({ clock });
    expect(asRunId(String(generator.runId))).toBe(generator.runId);
    expect(generator.nextRoot().runId).toBe(generator.runId);
  });

  it('случайные runId двух генераторов практически всегда различны (smoke)', () => {
    const clock = new PaperClock(new Date(BASE_EPOCH_MS));
    const a = new MessageMetadataGenerator({ clock });
    const b = new MessageMetadataGenerator({ clock });
    // 36^8 ≈ 2.8e12 комбинаций — совпадение в тесте невозможно на практике
    expect(a.runId).not.toBe(b.runId);
  });
});

describe('FixedHighResolutionClock', () => {
  it('set/advance управляют значением детерминированно', () => {
    const hr = new FixedHighResolutionClock();
    expect(hr.nowNanoseconds()).toBe(0n);
    hr.set(1_500n);
    expect(hr.nowNanoseconds()).toBe(1_500n);
    hr.advance(2_000n);
    expect(hr.nowNanoseconds()).toBe(3_500n);
  });

  it('отклоняет отрицательные значения', () => {
    expect(() => new FixedHighResolutionClock(-1n)).toThrow(RangeError);
    const hr = new FixedHighResolutionClock();
    expect(() => hr.set(-5n)).toThrow(RangeError);
    expect(() => hr.advance(-5n)).toThrow(RangeError);
  });
});

describe('SystemHighResolutionClock', () => {
  it('возвращает monotonic bigint-наносекунды', () => {
    const hr = new SystemHighResolutionClock();
    const first = hr.nowNanoseconds();
    const second = hr.nowNanoseconds();
    expect(typeof first).toBe('bigint');
    expect(second >= first).toBe(true);
    expect(first >= 0n).toBe(true);
  });
});

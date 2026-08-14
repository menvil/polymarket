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

/** Тот же момент с sub-ms precision: ...27.123456789 (epoch-наносекунды). */
const BASE_EPOCH_NS = BigInt(BASE_EPOCH_MS) * 1_000_000n + 456_789n;

/** Собирает детерминированный генератор с управляемыми clock-ами. */
function createGenerator(overrides?: {
  runId?: string;
  epochMs?: number;
  hrEpochNanoseconds?: bigint;
}): { generator: MessageMetadataGenerator; clock: PaperClock; hr: FixedHighResolutionClock } {
  const clock = new PaperClock(new Date(overrides?.epochMs ?? BASE_EPOCH_MS));
  const hr = new FixedHighResolutionClock(overrides?.hrEpochNanoseconds ?? BASE_EPOCH_NS);
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
    const probes: bigint[] = [
      0n, 1n, 999n, 1_000n, 999_999n, 1_000_000n, 123_456_789n,
      BASE_EPOCH_NS, BASE_EPOCH_NS + 999_999n,
    ];
    for (const ns of probes) {
      const { generator } = createGenerator({ hrEpochNanoseconds: ns });
      const metadata = generator.nextRoot();
      expect(metadata.millisecondOfSecond).toBeGreaterThanOrEqual(0);
      expect(metadata.millisecondOfSecond).toBeLessThanOrEqual(999);
      expect(metadata.microsecondOfMillisecond).toBeGreaterThanOrEqual(0);
      expect(metadata.microsecondOfMillisecond).toBeLessThanOrEqual(999);
      expect(metadata.nanosecondOfMicrosecond).toBeGreaterThanOrEqual(0);
      expect(metadata.nanosecondOfMicrosecond).toBeLessThanOrEqual(999);
    }
  });

  it('sub-ms часть epoch-значения раскладывается на us/ns корректно', () => {
    // ...123.456789 → ms=123, us=456, ns=789
    const { generator } = createGenerator({ hrEpochNanoseconds: BASE_EPOCH_NS });
    const metadata = generator.nextRoot();
    expect(metadata.millisecondOfSecond).toBe(123);
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
  it('с hr-источником ВСЕ поля выведены из одного epoch-значения (TEST A/B)', () => {
    const { generator } = createGenerator(); // hr = ...27.123456789
    const metadata = generator.nextRoot();

    const epochMs = metadata.createdAt.toNumber();
    expect(epochMs).toBe(BASE_EPOCH_MS);
    expect(metadata.createdAtUnixSeconds).toBe(Math.floor(BASE_EPOCH_MS / 1000));
    expect(metadata.millisecondOfSecond).toBe(123);
    expect(metadata.microsecondOfMillisecond).toBe(456);
    expect(metadata.nanosecondOfMicrosecond).toBe(789);

    // Обратная сборка одного момента: seconds*1000 + ms === createdAt(ms)
    expect(metadata.createdAtUnixSeconds * 1000 + metadata.millisecondOfSecond).toBe(epochMs);
  });

  it('без hr-источника все поля выведены из одного чтения IClock', () => {
    const clock = new PaperClock(new Date(BASE_EPOCH_MS));
    const generator = new MessageMetadataGenerator({ clock, runId: unsafeRunId('testrun1') });
    const metadata = generator.nextRoot();

    expect(metadata.createdAt.toNumber()).toBe(BASE_EPOCH_MS);
    expect(metadata.createdAtUnixSeconds).toBe(Math.floor(BASE_EPOCH_MS / 1000));
    expect(metadata.millisecondOfSecond).toBe(BASE_EPOCH_MS % 1000);
    expect(metadata.microsecondOfMillisecond).toBe(0);
    expect(metadata.nanosecondOfMicrosecond).toBe(0);
  });

  it('после продвижения IClock (без hr) поля описывают новый момент согласованно', () => {
    const clock = new PaperClock(new Date(BASE_EPOCH_MS));
    const generator = new MessageMetadataGenerator({ clock, runId: unsafeRunId('testrun1') });
    clock.tick(877); // 123 + 877 = 1000 → перенос в следующую секунду
    const metadata = generator.nextRoot();

    expect(metadata.createdAtUnixSeconds).toBe(Math.floor((BASE_EPOCH_MS + 877) / 1000));
    expect(metadata.millisecondOfSecond).toBe((BASE_EPOCH_MS + 877) % 1000);
    expect(metadata.createdAt.toNumber()).toBe(BASE_EPOCH_MS + 877);
  });

  it('monotonic advance hr: +1ns/+1us/+1ms с корректными carry (TEST C)', () => {
    const { generator, hr } = createGenerator(); // ...27.123.456.789
    const first = generator.nextRoot();
    expect([first.millisecondOfSecond, first.microsecondOfMillisecond, first.nanosecondOfMicrosecond])
      .toEqual([123, 456, 789]);

    hr.advance(1n); // → .123.456.790
    const plusNs = generator.nextRoot();
    expect(plusNs.nanosecondOfMicrosecond).toBe(790);
    expect(plusNs.microsecondOfMillisecond).toBe(456);

    hr.advance(1_000n); // → .123.457.790
    const plusUs = generator.nextRoot();
    expect(plusUs.microsecondOfMillisecond).toBe(457);
    expect(plusUs.millisecondOfSecond).toBe(123);

    hr.advance(1_000_000n); // → .124.457.790
    const plusMs = generator.nextRoot();
    expect(plusMs.millisecondOfSecond).toBe(124);
    expect(plusMs.createdAtUnixSeconds).toBe(first.createdAtUnixSeconds);
    expect(plusMs.createdAt.toNumber()).toBe(BASE_EPOCH_MS + 1);

    // carry ns → us: .124.457.999 + 1ns = .124.458.000
    hr.set(BigInt(BASE_EPOCH_MS + 1) * 1_000_000n + 457_999n);
    hr.advance(1n);
    const carryNs = generator.nextRoot();
    expect(carryNs.nanosecondOfMicrosecond).toBe(0);
    expect(carryNs.microsecondOfMillisecond).toBe(458);
  });

  it('rollover секунды: 999ms.999us.999ns + 1ns → следующая секунда, все нули (TEST D)', () => {
    const second = Math.floor(BASE_EPOCH_MS / 1000); // 1786668087
    const endOfSecondNs = BigInt(second) * 1_000_000_000n + 999_999_999n;
    const { generator, hr } = createGenerator({ hrEpochNanoseconds: endOfSecondNs });

    const before = generator.nextRoot();
    expect(before.createdAtUnixSeconds).toBe(second);
    expect(before.millisecondOfSecond).toBe(999);
    expect(before.microsecondOfMillisecond).toBe(999);
    expect(before.nanosecondOfMicrosecond).toBe(999);

    hr.advance(1n);
    const after = generator.nextRoot();
    expect(after.createdAtUnixSeconds).toBe(second + 1);
    expect(after.millisecondOfSecond).toBe(0);
    expect(after.microsecondOfMillisecond).toBe(0);
    expect(after.nanosecondOfMicrosecond).toBe(0);
    expect(after.createdAt.toNumber()).toBe((second + 1) * 1000);
  });

  it('MessageId time-компоненты совпадают с полями metadata (TEST F)', () => {
    const { generator } = createGenerator();
    const metadata = generator.nextRoot();

    // Формат: <runId>-<sec>-<ms>-<us>-<ns>-<seq> — парсим в тесте, без public-парсера
    const match = /^([a-z0-9]{8})-(\d+)-(\d{3})-(\d{3})-(\d{3})-(\d{9,})$/.exec(String(metadata.messageId));
    expect(match).not.toBeNull();
    const [, runId, sec, ms, us, ns, seq] = match!;
    expect(runId).toBe(String(metadata.runId));
    expect(Number(sec)).toBe(metadata.createdAtUnixSeconds);
    expect(Number(ms)).toBe(metadata.millisecondOfSecond);
    expect(Number(us)).toBe(metadata.microsecondOfMillisecond);
    expect(Number(ns)).toBe(metadata.nanosecondOfMicrosecond);
    expect(Number(seq)).toBe(metadata.sequence);
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
    expect(() => generator.nextRoot()).toThrow(/invalid time from the injected time source/);
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
    expect(hr.nowEpochNanoseconds()).toBe(0n);
    hr.set(1_500n);
    expect(hr.nowEpochNanoseconds()).toBe(1_500n);
    hr.advance(2_000n);
    expect(hr.nowEpochNanoseconds()).toBe(3_500n);
  });

  it('отклоняет отрицательные значения', () => {
    expect(() => new FixedHighResolutionClock(-1n)).toThrow(RangeError);
    const hr = new FixedHighResolutionClock();
    expect(() => hr.set(-5n)).toThrow(RangeError);
    expect(() => hr.advance(-5n)).toThrow(RangeError);
  });
});

describe('SystemHighResolutionClock', () => {
  it('возвращает monotonic неубывающие epoch-наносекунды около текущего wall-clock', () => {
    const beforeMs = Date.now();
    const hr = new SystemHighResolutionClock();
    const first = hr.nowEpochNanoseconds();
    const second = hr.nowEpochNanoseconds();
    const afterMs = Date.now();

    expect(typeof first).toBe('bigint');
    expect(second >= first).toBe(true);
    // Абсолютная шкала: значение соответствует текущему Unix-времени
    // (±1s допуска на планировщик — здесь только sanity абсолютности, не точность)
    expect(first >= BigInt(beforeMs - 1000) * 1_000_000n).toBe(true);
    expect(first <= BigInt(afterMs + 1000) * 1_000_000n).toBe(true);
  });
});

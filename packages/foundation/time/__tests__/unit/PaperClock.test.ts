/**
 * Тесты для PaperClock
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaperClock } from '../../src/PaperClock.js';
import type { IClock } from '../../src/IClock.js';

describe('PaperClock', () => {
  const initialTime = new Date('2024-01-01T00:00:00.000Z');
  let clock: PaperClock;

  beforeEach(() => {
    clock = new PaperClock(initialTime);
  });

  describe('constructor', () => {
    it('должен устанавливать начальное время', () => {
      const result = clock.now();
      expect(result).toEqual(initialTime);
    });

    it('должен работать с разными начальными временами', () => {
      const time1 = new Date('2023-06-15T12:30:45.123Z');
      const clock1 = new PaperClock(time1);
      expect(clock1.now()).toEqual(time1);

      const time2 = new Date('2025-12-31T23:59:59.999Z');
      const clock2 = new PaperClock(time2);
      expect(clock2.now()).toEqual(time2);
    });

    it('должен создавать копию входной даты (defensive copy)', () => {
      const inputDate = new Date('2024-01-01T12:00:00.000Z');
      const clock = new PaperClock(inputDate);

      // Мутируем входную дату
      inputDate.setUTCHours(15);

      // Внутреннее состояние не должно измениться
      expect(clock.now().toISOString()).toBe('2024-01-01T12:00:00.000Z');
      expect(clock.now().getUTCHours()).toBe(12);
    });
  });

  describe('now()', () => {
    it('должен возвращать зафиксированное время', () => {
      const time1 = clock.now();
      const time2 = clock.now();

      expect(time1).toEqual(time2);
      expect(time1).toEqual(initialTime);
    });

    it('должен возвращать копию для предотвращения мутации', () => {
      const time1 = clock.now();
      const time2 = clock.now();

      // Разные объекты (предотвращает мутацию)
      expect(time1).not.toBe(time2);
      // Но одинаковые значения
      expect(time1.getTime()).toBe(time2.getTime());
      expect(time1).toEqual(time2);
    });

    it('должен предотвращать мутацию внутреннего состояния', () => {
      const time = clock.now();
      const originalHours = time.getHours();

      // Попытка мутации возвращенного объекта
      time.setHours(originalHours + 5);

      // Внутреннее состояние не должно измениться
      const newTime = clock.now();
      expect(newTime.getHours()).toBe(originalHours);
    });
  });

  describe('setTime()', () => {
    it('должен устанавливать новое время', () => {
      const newTime = new Date('2024-06-15T12:00:00.000Z');
      clock.setTime(newTime);

      expect(clock.now()).toEqual(newTime);
    });

    it('должен заменять предыдущее время', () => {
      const time1 = new Date('2024-02-01T00:00:00.000Z');
      const time2 = new Date('2024-03-01T00:00:00.000Z');

      clock.setTime(time1);
      expect(clock.now()).toEqual(time1);

      clock.setTime(time2);
      expect(clock.now()).toEqual(time2);
      expect(clock.now()).not.toEqual(time1);
    });

    it('должен создавать копию входной даты (defensive copy)', () => {
      const inputDate = new Date('2024-06-15T12:00:00.000Z');
      clock.setTime(inputDate);

      // Мутируем входную дату
      inputDate.setUTCHours(15);

      // Внутреннее состояние не должно измениться
      expect(clock.now().toISOString()).toBe('2024-06-15T12:00:00.000Z');
      expect(clock.now().getUTCHours()).toBe(12);
    });

    it('должен работать с любыми датами', () => {
      const pastTime = new Date('1970-01-01T00:00:00.000Z');
      const futureTime = new Date('2099-12-31T23:59:59.999Z');

      clock.setTime(pastTime);
      expect(clock.now()).toEqual(pastTime);

      clock.setTime(futureTime);
      expect(clock.now()).toEqual(futureTime);
    });

    it('должен работать с миллисекундной точностью', () => {
      const preciseTime = new Date('2024-01-01T12:34:56.789Z');
      clock.setTime(preciseTime);

      expect(clock.now()).toEqual(preciseTime);
      expect(clock.now().getMilliseconds()).toBe(789);
    });
  });

  describe('tick()', () => {
    it('должен продвигать время на указанное количество миллисекунд', () => {
      clock.tick(1000); // 1 секунда

      const expected = new Date('2024-01-01T00:00:01.000Z');
      expect(clock.now()).toEqual(expected);
    });

    it('должен работать с разными значениями', () => {
      clock.tick(500); // 500ms
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:00.500Z'));

      clock.tick(500); // еще 500ms
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:01.000Z'));
    });

    it('должен работать с большими интервалами', () => {
      clock.tick(60000); // 1 минута
      expect(clock.now()).toEqual(new Date('2024-01-01T00:01:00.000Z'));

      clock.tick(3600000); // 1 час
      expect(clock.now()).toEqual(new Date('2024-01-01T01:01:00.000Z'));

      clock.tick(86400000); // 1 день
      expect(clock.now()).toEqual(new Date('2024-01-02T01:01:00.000Z'));
    });

    it('должен позволять накапливать время через множественные вызовы', () => {
      clock.tick(100);
      clock.tick(200);
      clock.tick(300);

      const expected = new Date('2024-01-01T00:00:00.600Z');
      expect(clock.now()).toEqual(expected);
    });

    it('должен работать с нулевым значением', () => {
      const before = clock.now();
      clock.tick(0);
      const after = clock.now();

      expect(after).toEqual(before);
    });

    it('должен работать с отрицательными значениями (движение назад)', () => {
      clock.tick(5000); // +5 секунд
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:05.000Z'));

      clock.tick(-2000); // -2 секунды
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:03.000Z'));
    });
  });

  describe('комбинация setTime() и tick()', () => {
    it('должен работать вместе', () => {
      clock.setTime(new Date('2024-06-15T12:00:00.000Z'));
      clock.tick(3600000); // +1 час

      expect(clock.now()).toEqual(new Date('2024-06-15T13:00:00.000Z'));
    });

    it('должен позволять сбрасывать и продвигать время', () => {
      clock.tick(1000);
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:01.000Z'));

      clock.setTime(new Date('2024-01-01T00:00:00.000Z')); // Сброс
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:00.000Z'));

      clock.tick(2000);
      expect(clock.now()).toEqual(new Date('2024-01-01T00:00:02.000Z'));
    });
  });

  describe('использование в тестах', () => {
    it('должен позволять контролировать время в тестах', () => {
      const testClock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));

      // Симуляция события в определенное время
      const event1Time = testClock.now();
      expect(event1Time).toEqual(new Date('2024-01-01T00:00:00.000Z'));

      // Продвинуть время
      testClock.tick(1000);

      // Симуляция второго события
      const event2Time = testClock.now();
      expect(event2Time).toEqual(new Date('2024-01-01T00:00:01.000Z'));

      // Проверка интервала
      expect(event2Time.getTime() - event1Time.getTime()).toBe(1000);
    });

    it('должен быть детерминированным', () => {
      const clock1 = new PaperClock(new Date('2024-01-01'));
      const clock2 = new PaperClock(new Date('2024-01-01'));

      // Одинаковые операции
      clock1.tick(1000);
      clock2.tick(1000);

      // Одинаковый результат
      expect(clock1.now()).toEqual(clock2.now());
    });
  });

  describe('интеграция с IClock', () => {
    it('должен быть совместим с IClock интерфейсом', () => {
      const usesClock = (clock: IClock): Date => {
        return clock.now();
      };

      const result = usesClock(clock);
      expect(result).toBeInstanceOf(Date);
    });

    it('должен работать в контексте требующем IClock', () => {
      class TimeDependentService {
        constructor(private readonly clock: IClock) {}

        getCurrentTime(): Date {
          return this.clock.now();
        }

        waitAndGetTime(ms: number): Date {
          if (this.clock instanceof PaperClock) {
            this.clock.tick(ms);
          }
          return this.clock.now();
        }
      }

      const service = new TimeDependentService(clock);
      expect(service.getCurrentTime()).toEqual(initialTime);

      const newTime = service.waitAndGetTime(5000);
      expect(newTime).toEqual(new Date('2024-01-01T00:00:05.000Z'));
    });
  });

  describe('валидация', () => {
    describe('constructor', () => {
      it('должен выбрасывать ошибку при невалидной дате', () => {
        expect(() => new PaperClock(new Date('invalid'))).toThrow('Invalid Date');
        expect(() => new PaperClock(new Date(NaN))).toThrow('Invalid Date');
      });

      it('должен принимать валидные даты', () => {
        expect(() => new PaperClock(new Date(0))).not.toThrow();
        expect(() => new PaperClock(new Date('2024-01-01'))).not.toThrow();
        expect(() => new PaperClock(new Date())).not.toThrow();
      });

      it('должен выбрасывать ошибку при передаче не-Date объекта (runtime)', () => {
        // TypeScript не защищает от as unknown as Date
        expect(() => new PaperClock({} as unknown as Date)).toThrow(
          'Invalid Date'
        );
        expect(
          () => new PaperClock({ getTime: () => 123 } as unknown as Date)
        ).toThrow('Invalid Date');
        expect(() => new PaperClock(null as unknown as Date)).toThrow();
        expect(() => new PaperClock(undefined as unknown as Date)).toThrow();
      });
    });

    describe('setTime', () => {
      it('должен выбрасывать ошибку при невалидной дате', () => {
        expect(() => clock.setTime(new Date('invalid'))).toThrow('Invalid Date');
        expect(() => clock.setTime(new Date(NaN))).toThrow('Invalid Date');
      });

      it('должен принимать валидные даты', () => {
        expect(() => clock.setTime(new Date(0))).not.toThrow();
        expect(() => clock.setTime(new Date('2024-12-31'))).not.toThrow();
      });

      it('должен выбрасывать ошибку при передаче не-Date объекта (runtime)', () => {
        expect(() => clock.setTime({} as unknown as Date)).toThrow(
          'Invalid Date'
        );
        expect(
          () => clock.setTime({ getTime: () => 123 } as unknown as Date)
        ).toThrow('Invalid Date');
        expect(() => clock.setTime(null as unknown as Date)).toThrow();
        expect(() => clock.setTime(undefined as unknown as Date)).toThrow();
      });
    });

    describe('tick', () => {
      it('должен выбрасывать ошибку при NaN', () => {
        expect(() => clock.tick(NaN)).toThrow('finite number');
      });

      it('должен выбрасывать ошибку при Infinity', () => {
        expect(() => clock.tick(Infinity)).toThrow('finite number');
        expect(() => clock.tick(-Infinity)).toThrow('finite number');
      });

      it('должен выбрасывать ошибку при верхнем overflow', () => {
        // Date max value ~8640000000000000
        const clock2 = new PaperClock(new Date(8640000000000000 - 1000));
        expect(() => clock2.tick(10000)).toThrow('invalid Date');
      });

      it('должен выбрасывать ошибку при нижнем overflow', () => {
        // Date min value ~-8640000000000000
        const clock2 = new PaperClock(new Date(-8640000000000000 + 1000));
        expect(() => clock2.tick(-10000)).toThrow('invalid Date');
      });

      it('должен принимать валидные значения', () => {
        expect(() => clock.tick(0)).not.toThrow();
        expect(() => clock.tick(1000)).not.toThrow();
        expect(() => clock.tick(-1000)).not.toThrow();
      });
    });
  });
});

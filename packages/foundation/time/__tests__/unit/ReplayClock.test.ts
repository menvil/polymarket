/**
 * Тесты для ReplayClock
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ReplayClock } from '../../src/ReplayClock.js';
import type { IClock } from '../../src/IClock.js';

describe('ReplayClock', () => {
  const initialTime = new Date('2024-01-01T00:00:00.000Z');
  let clock: ReplayClock;

  beforeEach(() => {
    clock = new ReplayClock(initialTime);
  });

  describe('constructor', () => {
    it('должен устанавливать начальное время', () => {
      const result = clock.now();
      expect(result).toEqual(initialTime);
    });

    it('должен работать с эпохой (epoch)', () => {
      const epochClock = new ReplayClock(new Date(0));
      expect(epochClock.now()).toEqual(new Date(0));
    });

    it('должен работать с разными начальными временами', () => {
      const time1 = new Date('2023-06-15T12:30:45.123Z');
      const clock1 = new ReplayClock(time1);
      expect(clock1.now()).toEqual(time1);

      const time2 = new Date('2025-12-31T23:59:59.999Z');
      const clock2 = new ReplayClock(time2);
      expect(clock2.now()).toEqual(time2);
    });

    it('должен создавать копию входной даты (defensive copy)', () => {
      const inputDate = new Date('2024-01-01T12:00:00.000Z');
      const clock = new ReplayClock(inputDate);

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

    it('НЕ должен возвращать Date.now()', async () => {
      const frozenTime = clock.now();

      // Подождать немного
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stillFrozen = clock.now();

      // Время не должно измениться
      expect(stillFrozen).toEqual(frozenTime);
      expect(stillFrozen.getTime()).toBe(frozenTime.getTime());
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

  describe('update()', () => {
    it('должен обновлять зафиксированное время', () => {
      const newTime = new Date('2024-01-01T00:01:00.000Z');
      clock.update(newTime);

      expect(clock.now()).toEqual(newTime);
    });

    it('должен заменять предыдущее время', () => {
      const time1 = new Date('2024-01-01T00:01:00.000Z');
      const time2 = new Date('2024-01-01T00:02:00.000Z');

      clock.update(time1);
      expect(clock.now()).toEqual(time1);

      clock.update(time2);
      expect(clock.now()).toEqual(time2);
      expect(clock.now()).not.toEqual(time1);
    });

    it('должен создавать копию входной даты (defensive copy)', () => {
      const inputDate = new Date('2024-01-01T00:01:00.000Z');
      clock.update(inputDate);

      // Мутируем входную дату
      inputDate.setUTCHours(15);

      // Внутреннее состояние не должно измениться
      expect(clock.now().toISOString()).toBe('2024-01-01T00:01:00.000Z');
      expect(clock.now().getUTCHours()).toBe(0);
    });

    it('должен работать с последовательностью обновлений', () => {
      const timestamps = [
        new Date('2024-01-01T00:00:01.000Z'),
        new Date('2024-01-01T00:00:02.000Z'),
        new Date('2024-01-01T00:00:03.000Z'),
      ];

      timestamps.forEach((timestamp) => {
        clock.update(timestamp);
        expect(clock.now()).toEqual(timestamp);
      });
    });

    it('должен работать с миллисекундной точностью', () => {
      const preciseTime = new Date('2024-01-01T12:34:56.789Z');
      clock.update(preciseTime);

      expect(clock.now()).toEqual(preciseTime);
      expect(clock.now().getMilliseconds()).toBe(789);
    });

    it('должен позволять обновлять время назад (для replay)', () => {
      const time1 = new Date('2024-01-01T12:00:00.000Z');
      const time2 = new Date('2024-01-01T11:00:00.000Z'); // Раньше

      clock.update(time1);
      expect(clock.now()).toEqual(time1);

      clock.update(time2);
      expect(clock.now()).toEqual(time2);
    });
  });

  describe('детерминизм воспроизведения', () => {
    it('должен обеспечивать идентичные timestamps при повторном воспроизведении', () => {
      // Симуляция событий
      const events = [
        { id: 1, timestamp: new Date('2024-01-01T00:00:01.000Z') },
        { id: 2, timestamp: new Date('2024-01-01T00:00:02.000Z') },
        { id: 3, timestamp: new Date('2024-01-01T00:00:03.000Z') },
      ];

      // Первое воспроизведение
      const clock1 = new ReplayClock(new Date(0));
      const replay1: Date[] = [];

      events.forEach((event) => {
        clock1.update(event.timestamp);
        replay1.push(clock1.now());
      });

      // Второе воспроизведение
      const clock2 = new ReplayClock(new Date(0));
      const replay2: Date[] = [];

      events.forEach((event) => {
        clock2.update(event.timestamp);
        replay2.push(clock2.now());
      });

      // Результаты идентичны
      expect(replay1).toEqual(replay2);
      replay1.forEach((time, index) => {
        expect(time.getTime()).toBe(replay2[index].getTime());
      });
    });

    it('должен гарантировать bit-for-bit идентичность', () => {
      const eventTime = new Date('2024-01-01T12:34:56.789Z');

      // Воспроизведение 1
      const clock1 = new ReplayClock(new Date(0));
      clock1.update(eventTime);
      const result1 = clock1.now();

      // Воспроизведение 2
      const clock2 = new ReplayClock(new Date(0));
      clock2.update(eventTime);
      const result2 = clock2.now();

      // Полностью идентичны
      expect(result1.getTime()).toBe(result2.getTime());
      expect(result1.toISOString()).toBe(result2.toISOString());
    });
  });

  describe('использование в системе воспроизведения', () => {
    it('должен работать в цикле воспроизведения событий', () => {
      interface Event {
        type: string;
        timestamp: Date;
        data: unknown;
      }

      const events: Event[] = [
        {
          type: 'ORDER_PLACED',
          timestamp: new Date('2024-01-01T10:00:00.000Z'),
          data: { orderId: 1 },
        },
        {
          type: 'ORDER_FILLED',
          timestamp: new Date('2024-01-01T10:00:01.500Z'),
          data: { orderId: 1 },
        },
        {
          type: 'ORDER_CANCELLED',
          timestamp: new Date('2024-01-01T10:00:03.000Z'),
          data: { orderId: 2 },
        },
      ];

      const replayClock = new ReplayClock(new Date(0));
      const telemetry: Array<{ event: string; timestamp: Date }> = [];

      // Симуляция системы воспроизведения
      events.forEach((event) => {
        // Обновить clock ПЕРЕД обработкой события
        replayClock.update(event.timestamp);

        // Обработать событие с зафиксированным временем
        telemetry.push({
          event: event.type,
          timestamp: replayClock.now(),
        });
      });

      // Проверка что timestamps соответствуют событиям
      expect(telemetry[0].timestamp).toEqual(events[0].timestamp);
      expect(telemetry[1].timestamp).toEqual(events[1].timestamp);
      expect(telemetry[2].timestamp).toEqual(events[2].timestamp);
    });

    it('должен обеспечивать правильный порядок обновления', () => {
      const eventTimestamps = [
        new Date('2024-01-01T00:00:01.000Z'),
        new Date('2024-01-01T00:00:02.000Z'),
        new Date('2024-01-01T00:00:03.000Z'),
      ];

      const processedTimes: Date[] = [];

      eventTimestamps.forEach((timestamp) => {
        // 1. Обновить clock из события
        clock.update(timestamp);

        // 2. Обработать событие (получить время)
        processedTimes.push(clock.now());
      });

      // Все времена должны соответствовать событиям
      processedTimes.forEach((time, index) => {
        expect(time).toEqual(eventTimestamps[index]);
      });
    });
  });

  describe('сравнение с LiveClock', () => {
    it('ReplayClock должен быть детерминированным в отличие от LiveClock', () => {
      const replayTime = new Date('2024-01-01T12:00:00.000Z');
      const replayClock = new ReplayClock(replayTime);

      // ReplayClock всегда возвращает одно и то же время
      const time1 = replayClock.now();
      const time2 = replayClock.now();

      expect(time1).toEqual(time2);
      expect(time1.getTime()).toBe(time2.getTime());
    });
  });

  describe('интеграция с IClock', () => {
    it('должен быть совместим с IClock интерфейсом', () => {
      const usesClock = (clock: IClock): Date => {
        return clock.now();
      };

      const result = usesClock(clock);
      expect(result).toBeInstanceOf(Date);
      // Усиленная проверка: timestamp валидный и соответствует ожидаемому времени
      expect(Number.isFinite(result.getTime())).toBe(true);
      expect(result).toEqual(initialTime);
    });

    it('должен работать в системе требующей IClock', () => {
      class EventProcessor {
        private telemetry: Array<{ timestamp: Date }> = [];

        constructor(private readonly clock: IClock) {}

        processEvent(eventTimestamp: Date): void {
          // Обновить clock если это ReplayClock
          if (this.clock instanceof ReplayClock) {
            this.clock.update(eventTimestamp);
          }

          // Записать telemetry
          this.telemetry.push({
            timestamp: this.clock.now(),
          });
        }

        getTelemetry(): Array<{ timestamp: Date }> {
          return this.telemetry;
        }
      }

      const processor = new EventProcessor(clock);

      const events = [
        new Date('2024-01-01T00:00:01.000Z'),
        new Date('2024-01-01T00:00:02.000Z'),
        new Date('2024-01-01T00:00:03.000Z'),
      ];

      events.forEach((timestamp) => {
        processor.processEvent(timestamp);
      });

      const telemetry = processor.getTelemetry();

      // Timestamps в telemetry должны соответствовать событиям
      expect(telemetry[0].timestamp).toEqual(events[0]);
      expect(telemetry[1].timestamp).toEqual(events[1]);
      expect(telemetry[2].timestamp).toEqual(events[2]);
    });
  });

  describe('валидация', () => {
    describe('constructor', () => {
      it('должен выбрасывать ошибку при невалидной дате', () => {
        expect(() => new ReplayClock(new Date('invalid'))).toThrow('Invalid Date');
        expect(() => new ReplayClock(new Date(NaN))).toThrow('Invalid Date');
      });

      it('должен принимать валидные даты', () => {
        expect(() => new ReplayClock(new Date(0))).not.toThrow();
        expect(() => new ReplayClock(new Date('2024-01-01'))).not.toThrow();
        expect(() => new ReplayClock(new Date())).not.toThrow();
      });

      it('должен выбрасывать ошибку при передаче не-Date объекта (runtime)', () => {
        expect(() => new ReplayClock({} as unknown as Date)).toThrow(
          'Invalid Date'
        );
        expect(
          () => new ReplayClock({ getTime: () => 123 } as unknown as Date)
        ).toThrow('Invalid Date');
        expect(() => new ReplayClock(null as unknown as Date)).toThrow();
        expect(() => new ReplayClock(undefined as unknown as Date)).toThrow();
      });
    });

    describe('update', () => {
      it('должен выбрасывать ошибку при невалидной дате', () => {
        expect(() => clock.update(new Date('invalid'))).toThrow('Invalid Date');
        expect(() => clock.update(new Date(NaN))).toThrow('Invalid Date');
      });

      it('должен принимать валидные даты', () => {
        expect(() => clock.update(new Date(0))).not.toThrow();
        expect(() => clock.update(new Date('2024-12-31'))).not.toThrow();
      });

      it('должен выбрасывать ошибку при передаче не-Date объекта (runtime)', () => {
        expect(() => clock.update({} as unknown as Date)).toThrow(
          'Invalid Date'
        );
        expect(
          () => clock.update({ getTime: () => 123 } as unknown as Date)
        ).toThrow('Invalid Date');
        expect(() => clock.update(null as unknown as Date)).toThrow();
        expect(() => clock.update(undefined as unknown as Date)).toThrow();
      });
    });
  });
});

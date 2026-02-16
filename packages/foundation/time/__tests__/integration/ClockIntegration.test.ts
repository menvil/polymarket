/**
 * Интеграционные тесты для модуля @polymarket/time
 */

import { describe, it, expect } from '@jest/globals';
import type { IClock } from '../../src/IClock.js';
import { LiveClock } from '../../src/LiveClock.js';
import { PaperClock } from '../../src/PaperClock.js';
import { ReplayClock } from '../../src/ReplayClock.js';

describe('Clock Integration', () => {
  describe('Полиморфное использование через IClock', () => {
    it('все реализации должны быть совместимы с IClock', () => {
      const clocks: IClock[] = [
        new LiveClock(),
        new PaperClock(new Date()),
        new ReplayClock(new Date()),
      ];

      clocks.forEach((clock) => {
        const time = clock.now();
        expect(time).toBeInstanceOf(Date);
      });
    });

    it('должны работать в функции принимающей IClock', () => {
      const getCurrentTimestamp = (clock: IClock): number => {
        return clock.now().getTime();
      };

      const liveTimestamp = getCurrentTimestamp(new LiveClock());
      const paperTimestamp = getCurrentTimestamp(
        new PaperClock(new Date('2024-01-01'))
      );
      const replayTimestamp = getCurrentTimestamp(
        new ReplayClock(new Date('2024-01-01'))
      );

      // Проверяем что timestamp валидный number (не NaN, не Infinity)
      expect(Number.isFinite(liveTimestamp)).toBe(true);
      expect(Number.isFinite(paperTimestamp)).toBe(true);
      expect(Number.isFinite(replayTimestamp)).toBe(true);

      // Paper и Replay должны возвращать одинаковое время
      expect(paperTimestamp).toBe(replayTimestamp);
    });
  });

  describe('Сценарий: Стратегия с разными режимами', () => {
    interface StrategyContext {
      readonly mode: 'LIVE' | 'PAPER' | 'REPLAY';
      readonly clock: IClock;
      now(): Date;
    }

    class SimpleStrategyContext implements StrategyContext {
      constructor(
        public readonly mode: 'LIVE' | 'PAPER' | 'REPLAY',
        public readonly clock: IClock
      ) {}

      now(): Date {
        return this.clock.now();
      }
    }

    it('LIVE режим должен использовать реальное время', () => {
      const ctx = new SimpleStrategyContext('LIVE', new LiveClock());

      const time1 = ctx.now();
      const systemTime = new Date();

      // Время должно быть близко к системному
      expect(Math.abs(time1.getTime() - systemTime.getTime())).toBeLessThan(
        100
      );
    });

    it('PAPER режим должен использовать управляемое время', () => {
      const paperClock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));
      const ctx = new SimpleStrategyContext('PAPER', paperClock);

      const time1 = ctx.now();
      expect(time1).toEqual(new Date('2024-01-01T00:00:00.000Z'));

      // Продвинуть время
      paperClock.tick(5000);

      const time2 = ctx.now();
      expect(time2).toEqual(new Date('2024-01-01T00:00:05.000Z'));
    });

    it('REPLAY режим должен использовать время из событий', () => {
      const replayClock = new ReplayClock(new Date(0));
      const ctx = new SimpleStrategyContext('REPLAY', replayClock);

      const events = [
        { timestamp: new Date('2024-01-01T10:00:00.000Z') },
        { timestamp: new Date('2024-01-01T10:00:01.000Z') },
        { timestamp: new Date('2024-01-01T10:00:02.000Z') },
      ];

      const processedTimes: Date[] = [];

      events.forEach((event) => {
        replayClock.update(event.timestamp);
        processedTimes.push(ctx.now());
      });

      expect(processedTimes[0]).toEqual(events[0].timestamp);
      expect(processedTimes[1]).toEqual(events[1].timestamp);
      expect(processedTimes[2]).toEqual(events[2].timestamp);
    });
  });

  describe('Сценарий: Тестирование с временными зависимостями', () => {
    class OrderService {
      private orders: Array<{ id: number; placedAt: Date }> = [];

      constructor(private readonly clock: IClock) {}

      placeOrder(id: number): void {
        this.orders.push({
          id,
          placedAt: this.clock.now(),
        });
      }

      getOrders(): Array<{ id: number; placedAt: Date }> {
        return this.orders;
      }
    }

    it('должен позволять тестировать с контролируемым временем', () => {
      const testTime = new Date('2024-01-01T12:00:00.000Z');
      const clock = new PaperClock(testTime);
      const service = new OrderService(clock);

      // Разместить первый ордер
      service.placeOrder(1);

      // Продвинуть время на 1 минуту
      clock.tick(60000);

      // Разместить второй ордер
      service.placeOrder(2);

      const orders = service.getOrders();

      expect(orders[0].placedAt).toEqual(testTime);
      expect(orders[1].placedAt).toEqual(
        new Date('2024-01-01T12:01:00.000Z')
      );

      // Проверить интервал
      const interval =
        orders[1].placedAt.getTime() - orders[0].placedAt.getTime();
      expect(interval).toBe(60000);
    });

    it('должен позволять воспроизводить исторические события', () => {
      const replayClock = new ReplayClock(new Date(0));
      const service = new OrderService(replayClock);

      const historicalEvents = [
        { orderId: 1, timestamp: new Date('2024-01-01T10:00:00.000Z') },
        { orderId: 2, timestamp: new Date('2024-01-01T10:00:30.000Z') },
        { orderId: 3, timestamp: new Date('2024-01-01T10:01:00.000Z') },
      ];

      // Воспроизвести события
      historicalEvents.forEach((event) => {
        replayClock.update(event.timestamp);
        service.placeOrder(event.orderId);
      });

      const orders = service.getOrders();

      // Timestamps должны соответствовать историческим
      expect(orders[0].placedAt).toEqual(historicalEvents[0].timestamp);
      expect(orders[1].placedAt).toEqual(historicalEvents[1].timestamp);
      expect(orders[2].placedAt).toEqual(historicalEvents[2].timestamp);
    });
  });

  describe('Сценарий: Детерминированное воспроизведение', () => {
    interface TelemetryEntry {
      action: string;
      timestamp: Date;
    }

    class TelemetryCollector {
      private entries: TelemetryEntry[] = [];

      constructor(private readonly clock: IClock) {}

      log(action: string): void {
        this.entries.push({
          action,
          timestamp: this.clock.now(),
        });
      }

      getEntries(): TelemetryEntry[] {
        return this.entries;
      }
    }

    it('должен обеспечивать идентичную telemetry при повторном воспроизведении', () => {
      const events = [
        { action: 'START', timestamp: new Date('2024-01-01T00:00:00.000Z') },
        { action: 'ORDER', timestamp: new Date('2024-01-01T00:00:01.000Z') },
        { action: 'FILL', timestamp: new Date('2024-01-01T00:00:02.000Z') },
      ];

      // Первое воспроизведение
      const clock1 = new ReplayClock(new Date(0));
      const collector1 = new TelemetryCollector(clock1);

      events.forEach((event) => {
        clock1.update(event.timestamp);
        collector1.log(event.action);
      });

      // Второе воспроизведение
      const clock2 = new ReplayClock(new Date(0));
      const collector2 = new TelemetryCollector(clock2);

      events.forEach((event) => {
        clock2.update(event.timestamp);
        collector2.log(event.action);
      });

      // Telemetry должна быть идентичной
      const entries1 = collector1.getEntries();
      const entries2 = collector2.getEntries();

      expect(entries1.length).toBe(entries2.length);

      entries1.forEach((entry, index) => {
        expect(entry.action).toBe(entries2[index].action);
        expect(entry.timestamp.getTime()).toBe(
          entries2[index].timestamp.getTime()
        );
      });
    });
  });

  describe('Сценарий: Переключение между режимами', () => {
    class ConfigurableService {
      constructor(private clock: IClock) {}

      setClock(clock: IClock): void {
        this.clock = clock;
      }

      getCurrentTime(): Date {
        return this.clock.now();
      }
    }

    it('должен позволять переключаться между реализациями', () => {
      const service = new ConfigurableService(new LiveClock());

      // LIVE режим
      const liveTime = service.getCurrentTime();
      expect(liveTime.getTime()).toBeGreaterThan(0);

      // Переключение на PAPER режим
      const paperClock = new PaperClock(new Date('2024-01-01'));
      service.setClock(paperClock);

      const paperTime = service.getCurrentTime();
      expect(paperTime).toEqual(new Date('2024-01-01'));

      // Переключение на REPLAY режим
      const replayClock = new ReplayClock(new Date('2024-02-01'));
      service.setClock(replayClock);

      const replayTime = service.getCurrentTime();
      expect(replayTime).toEqual(new Date('2024-02-01'));
    });
  });
});

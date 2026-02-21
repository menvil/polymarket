import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { Quote } from '../../../src/quote/core/Quote.js';
import { ValidateAge } from '../../../src/quote/rules/ValidateAge.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';
import { ErrorSource } from '@polymarket/errors';

// Тестовые константы для sourceId и instrumentId
const TEST_SOURCE_ID = 'TEST_SOURCE' as MarketDataSourceId;
const TEST_INSTRUMENT_ID = 'TEST_INSTRUMENT' as InstrumentId;

describe('ValidateAge', () => {
  const baseTime = new Date('2024-01-01T12:00:00Z');
  let clock: PaperClock;

  beforeEach(() => {
    clock = new PaperClock(baseTime);
  });

  const createQuote = (timestampMs: number): Quote => {
    const bid = Price.of(new Decimal('0.48'));
    const ask = Price.of(new Decimal('0.52'));
    const bidSize = Quantity.of(new Decimal(100));
    const askSize = Quantity.of(new Decimal(150));
    return Quote.of(bid, ask, bidSize, askSize, new Decimal(timestampMs), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
  };

  describe('check()', () => {
    it('должен пройти для свежей котировки', () => {
      // Создаём котировку с текущим timestamp
      const quote = createQuote(clock.now().getTime());

      // Проверяем с maxAge = 5000ms
      const result = ValidateAge.check(quote, 5000, clock);

      // Котировка свежая (возраст = 0ms)
      expect(result.ok).toBe(true);
    });

    it('должен пройти для котировки в пределах maxAge', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время на 3 секунды вперёд
      clock.tick(3000);

      // Проверяем с maxAge = 5000ms
      const result = ValidateAge.check(quote, 5000, clock);

      // Возраст 3s < maxAge 5s
      expect(result.ok).toBe(true);
    });

    it('должен пройти для котировки ровно на границе maxAge', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время ровно на maxAge
      clock.tick(5000);

      // Проверяем с maxAge = 5000ms
      const result = ValidateAge.check(quote, 5000, clock);

      // Возраст 5s == maxAge 5s (граница включена в допустимый диапазон)
      expect(result.ok).toBe(true);
    });

    it('должен вернуть ошибку для устаревшей котировки', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время на 10 секунд вперёд
      clock.tick(10000);

      // Проверяем с maxAge = 5000ms
      const result = ValidateAge.check(quote, 5000, clock);

      // Возраст 10s > maxAge 5s
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Quote age 10000ms exceeds maximum 5000ms');
        expect(result.error.context?.reason).toBe(QuoteErrorReason.QUOTE_TOO_OLD);
        expect(result.error.context?.ageMs).toBe(10000);
        expect(result.error.context?.maxAgeMs).toBe(5000);
      }
    });

    it('должен вернуть ошибку для очень старой котировки', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время на 1 минуту вперёд
      clock.tick(60000);

      // Проверяем с maxAge = 5000ms
      const result = ValidateAge.check(quote, 5000, clock);

      // Возраст 60s >> maxAge 5s
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.QUOTE_TOO_OLD);
        expect(result.error.context?.ageMs).toBe(60000);
        expect(result.error.context?.maxAgeMs).toBe(5000);
      }
    });

    it('должен работать с разными значениями maxAge', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время на 2 секунды
      clock.tick(2000);

      // Проверка с maxAge = 1000ms - должна провалиться
      const result1 = ValidateAge.check(quote, 1000, clock);
      expect(result1.ok).toBe(false);

      // Проверка с maxAge = 3000ms - должна пройти
      const result2 = ValidateAge.check(quote, 3000, clock);
      expect(result2.ok).toBe(true);

      // Проверка с maxAge = 2000ms - должна пройти (граница)
      const result3 = ValidateAge.check(quote, 2000, clock);
      expect(result3.ok).toBe(true);
    });

    it('должен содержать правильные timestamps в error context', () => {
      const quoteTime = clock.now().getTime();
      const quote = createQuote(quoteTime);

      // Перематываем время на 10 секунд
      clock.tick(10000);
      const currentTime = clock.now().getTime();

      const result = ValidateAge.check(quote, 5000, clock);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.quoteTimestamp).toBe(quoteTime);
        expect(result.error.context?.currentTimestamp).toBe(currentTime);
        expect(result.error.context?.ageMs).toBe(currentTime - quoteTime);
      }
    });

    it('должен работать с очень маленьким maxAge', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время на 100ms
      clock.tick(100);

      // Проверка с maxAge = 50ms
      const result = ValidateAge.check(quote, 50, clock);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.ageMs).toBe(100);
        expect(result.error.context?.maxAgeMs).toBe(50);
      }
    });

    it('должен работать с большим maxAge', () => {
      // Создаём котировку
      const quote = createQuote(clock.now().getTime());

      // Перематываем время на 1 час
      clock.tick(3600000);

      // Проверка с maxAge = 2 часа (7200000ms)
      const result = ValidateAge.check(quote, 7200000, clock);

      // Возраст 1h < maxAge 2h
      expect(result.ok).toBe(true);
    });

    it('должен использовать ErrorSource.RULE_VALIDATION', () => {
      const quote = createQuote(clock.now().getTime());
      clock.tick(10000);

      const result = ValidateAge.check(quote, 5000, clock);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.RULE_VALIDATION);
      }
    });
  });

  describe('Integration with IClock', () => {
    it('должен работать с разными реализациями IClock', () => {
      // Используем PaperClock для детерминированного тестирования
      const testClock = new PaperClock(new Date('2024-06-15T10:00:00Z'));
      const quote = createQuote(testClock.now().getTime());

      // Тик на 3 секунды
      testClock.tick(3000);

      const result = ValidateAge.check(quote, 5000, testClock);
      expect(result.ok).toBe(true);

      // Ещё тик на 3 секунды (итого 6s)
      testClock.tick(3000);

      const result2 = ValidateAge.check(quote, 5000, testClock);
      expect(result2.ok).toBe(false);
    });

    it('должен правильно вычислять возраст при разных базовых временах', () => {
      // Создаём clock с другой базовой датой
      const futureClock = new PaperClock(new Date('2025-01-01T00:00:00Z'));
      const quote = createQuote(futureClock.now().getTime());

      futureClock.tick(4000);

      const result = ValidateAge.check(quote, 5000, futureClock);
      expect(result.ok).toBe(true);
    });
  });
});

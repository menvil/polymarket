/**
 * Тесты для MarketFilter.
 *
 * @remarks
 * Покрывают каждый фильтр в отдельности и их комбинации.
 * Используют реальные domain VO (Timestamp, Price, Quantity) без mock'ов.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { TimestampService, Price, Quantity } from '@polymarket/value-objects';
import { asMarketId, asInstrumentId } from '@polymarket/ids';
import type { DiscoveredMarket, IMarketFilterConfig } from '@polymarket/ports';
import { MarketFilter } from '../src/MarketFilter.js';

// Фиксированный "сейчас" для детерминированных тестов
const NOW_MS = 1_700_000_000_000; // 2023-11-14 22:13:20 UTC

/**
 * Создаёт DiscoveredMarket с заданными параметрами.
 * Использует дефолты для полей, не влияющих на конкретный тест.
 */
function makeMarket(overrides: Partial<{
  question: string;
  expiresAtMs: number;
  spread: number;
  liquidity: number;
  marketIdSuffix: string;
}>): DiscoveredMarket {
  const {
    question = 'Will Bitcoin price exceed $50,000?',
    expiresAtMs = NOW_MS + 48 * 60 * 60 * 1000, // +48 часов
    spread = 0.05,
    liquidity = 10_000,
    marketIdSuffix = '01',
  } = overrides;

  const expiresAtResult = TimestampService.create(expiresAtMs);
  if (!expiresAtResult.ok) throw new Error(`Invalid timestamp: ${expiresAtResult.error.message}`);

  const marketId = asMarketId(`0xcondition${marketIdSuffix}`);
  if (!marketId) throw new Error(`Invalid marketId`);

  const instrumentId = asInstrumentId(`0xtoken${marketIdSuffix}`);
  if (!instrumentId) throw new Error(`Invalid instrumentId`);

  return {
    marketId,
    instrumentId,
    question,
    expiresAt: expiresAtResult.value,
    tickSize: Price.of(new Decimal('0.01')),
    minOrderSize: Quantity.of(new Decimal('1')),
    spread,
    liquidity,
    score: 0,
  };
}

/** Базовая конфигурация — проходит все фильтры */
const BASE_CONFIG: IMarketFilterConfig = {
  minTimeToExpiryHours: 24,
  minSpread: 0,
  minDailyVolume: 0,
  maxMarketsToReturn: 100,
};

describe('MarketFilter', () => {
  let filter: MarketFilter;

  beforeEach(() => {
    filter = new MarketFilter();
  });

  describe('базовые случаи', () => {
    it('пустой список → возвращает []', () => {
      const result = filter.filterCandidates([], BASE_CONFIG, NOW_MS);
      expect(result).toEqual([]);
    });

    it('рынок проходит все фильтры → включён в результат', () => {
      const market = makeMarket({});
      const result = filter.filterCandidates([market], BASE_CONFIG, NOW_MS);
      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(market.marketId);
    });
  });

  describe('фильтр по времени истечения', () => {
    it('рынок истекает ровно через minTimeToExpiryHours → включён', () => {
      const market = makeMarket({ expiresAtMs: NOW_MS + 24 * 60 * 60 * 1000 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minTimeToExpiryHours: 24 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('рынок истекает раньше minTimeToExpiryHours → исключён', () => {
      const market = makeMarket({ expiresAtMs: NOW_MS + 12 * 60 * 60 * 1000 }); // +12 часов
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minTimeToExpiryHours: 24 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('рынок уже истёк (в прошлом) → исключён', () => {
      const market = makeMarket({ expiresAtMs: NOW_MS - 1000 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minTimeToExpiryHours: 0 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });
  });

  describe('фильтр по спреду', () => {
    it('spread === 0 (данные недоступны) → проходит фильтр даже при minSpread > 0', () => {
      const market = makeMarket({ spread: 0 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minSpread: 0.05 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('spread >= minSpread → включён', () => {
      const market = makeMarket({ spread: 0.05 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minSpread: 0.05 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('spread < minSpread (и spread > 0) → исключён', () => {
      const market = makeMarket({ spread: 0.02 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minSpread: 0.05 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });
  });

  describe('фильтр по ликвидности', () => {
    it('liquidity >= minDailyVolume → включён', () => {
      const market = makeMarket({ liquidity: 10_000 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minDailyVolume: 10_000 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('liquidity < minDailyVolume → исключён', () => {
      const market = makeMarket({ liquidity: 5_000 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minDailyVolume: 10_000 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });
  });

  describe('фильтр requiredKeywords', () => {
    it('вопрос содержит все обязательные слова → включён', () => {
      const market = makeMarket({ question: 'Will Bitcoin price exceed $50,000 by December?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['bitcoin', 'price'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('вопрос не содержит одно из обязательных слов → исключён', () => {
      const market = makeMarket({ question: 'Will Bitcoin exceed $50,000?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['bitcoin', 'price'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('поиск регистронезависимый → включён', () => {
      const market = makeMarket({ question: 'Will BITCOIN PRICE exceed $50,000?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['bitcoin', 'price'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('пустой список requiredKeywords → фильтр пропускается', () => {
      const market = makeMarket({ question: 'Unrelated question' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: [] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('undefined requiredKeywords → фильтр пропускается', () => {
      const market = makeMarket({ question: 'Unrelated question' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: undefined };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });
  });

  describe('фильтр anyOfKeywords', () => {
    it('вопрос содержит одно из anyOfKeywords → включён', () => {
      const market = makeMarket({ question: 'Will Bitcoin go up by January?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, anyOfKeywords: ['up', 'down'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('вопрос не содержит ни одного anyOfKeyword → исключён', () => {
      const market = makeMarket({ question: 'Will Bitcoin exceed $50,000?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, anyOfKeywords: ['up', 'down'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('пустой список anyOfKeywords → фильтр пропускается', () => {
      const market = makeMarket({ question: 'Unrelated question' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, anyOfKeywords: [] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('undefined anyOfKeywords → фильтр пропускается', () => {
      const market = makeMarket({ question: 'Unrelated question' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, anyOfKeywords: undefined };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });
  });

  describe('фильтр excludedKeywords', () => {
    it('вопрос не содержит excludedKeywords → включён', () => {
      const market = makeMarket({ question: 'Will Bitcoin exceed $50,000?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['test', 'demo'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('вопрос содержит excludedKeyword → исключён', () => {
      const market = makeMarket({ question: 'TEST: Will Bitcoin exceed $50,000?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['test', 'demo'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('поиск регистронезависимый для excludedKeywords', () => {
      const market = makeMarket({ question: 'Demo market for testing' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['DEMO'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('пустой список excludedKeywords → фильтр пропускается', () => {
      const market = makeMarket({ question: 'test demo anything' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: [] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });
  });

  describe('дедупликация по marketId', () => {
    it('два рынка с одинаковым marketId → дедуплицированы (один остаётся)', () => {
      const market1 = makeMarket({ question: 'First version', marketIdSuffix: '01' });
      const market2 = makeMarket({ question: 'Second version (duplicate)', marketIdSuffix: '01' });
      const result = filter.filterCandidates([market1, market2], BASE_CONFIG, NOW_MS);
      expect(result).toHaveLength(1);
      // Последний дубликат побеждает
      expect(result[0]!.question).toBe('Second version (duplicate)');
    });

    it('два рынка с разными marketId → оба включены', () => {
      const market1 = makeMarket({ marketIdSuffix: '01' });
      const market2 = makeMarket({ marketIdSuffix: '02' });
      const result = filter.filterCandidates([market1, market2], BASE_CONFIG, NOW_MS);
      expect(result).toHaveLength(2);
    });
  });

  describe('комбинация фильтров', () => {
    it('рынок не проходит несколько фильтров → исключён', () => {
      const market = makeMarket({
        expiresAtMs: NOW_MS + 12 * 60 * 60 * 1000, // только 12 часов
        liquidity: 100,                               // мало ликвидности
        question: 'TEST market',                     // исключённое слово
      });
      const config: IMarketFilterConfig = {
        minTimeToExpiryHours: 24,
        minSpread: 0,
        minDailyVolume: 5000,
        maxMarketsToReturn: 100,
        excludedKeywords: ['test'],
      };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('смешанный список: одни проходят, другие нет', () => {
      const passing = makeMarket({ marketIdSuffix: 'A1', liquidity: 20_000 });
      const failing = makeMarket({ marketIdSuffix: 'A2', liquidity: 100 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minDailyVolume: 10_000 };
      const result = filter.filterCandidates([passing, failing], config, NOW_MS);
      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(passing.marketId);
    });
  });
});

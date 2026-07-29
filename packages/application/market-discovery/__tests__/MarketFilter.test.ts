/**
 * Тесты для MarketFilter.
 *
 * @remarks
 * Покрывают каждый фильтр в отдельности и их комбинации.
 * Используют реальные domain VO (Timestamp, Price, Quantity) без mock'ов.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { TimestampService, Money, Price, Quantity } from '@polymarket/value-objects';
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
  spread: number | null; // null = нет данных о спреде (undefined в DiscoveredMarket); omit = дефолт 0.05
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
    minOrderValue: Money.of(new Decimal('1'), 'USDC'),
    active: true,
    spread: spread !== null ? new Decimal(spread) : undefined,
    liquidity: new Decimal(liquidity),
    score: new Decimal(0),
  };
}

/** Базовая конфигурация — проходит все фильтры */
const BASE_CONFIG: IMarketFilterConfig = {
  minTimeToExpiryHours: 24,
  minSpread: 0,
  minLiquidity: 0,
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
    it('spread === undefined (нет данных) → проходит фильтр даже при minSpread > 0', () => {
      const market = makeMarket({ spread: null });
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
    it('liquidity >= minLiquidity → включён', () => {
      const market = makeMarket({ liquidity: 10_000 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minLiquidity: 10_000 };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('liquidity < minLiquidity → исключён', () => {
      const market = makeMarket({ liquidity: 5_000 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minLiquidity: 10_000 };
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

  describe('word-boundary matching (ложные срабатывания)', () => {
    it('excludedKeywords: war — не исключает рынок со словом "reward"', () => {
      const market = makeMarket({ question: 'Will the reward program expand globally?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['war'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('excludedKeywords: war — исключает рынок где "war" является отдельным словом', () => {
      const market = makeMarket({ question: 'Will the war in Ukraine end this year?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['war'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('requiredKeywords: up — не матчит слово "output"', () => {
      const market = makeMarket({ question: 'Will output increase next quarter?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['up'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it("requiredKeywords: trump — матчит \"Trump's approval rating\" (апостроф не ломает поиск)", () => {
      const market = makeMarket({ question: "Will Trump's approval rating exceed 50%?" });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['trump'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('excludedKeywords: trump — не матчит "Trumpist" (часть более длинного слова)', () => {
      const market = makeMarket({ question: 'Will Trumpist policies dominate 2025?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['trump'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });

    it('requiredKeywords: covid — матчит "COVID-19" (дефис не ломает поиск)', () => {
      const market = makeMarket({ question: 'Will COVID-19 cases rise this winter?' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['covid'] };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(1);
    });
  });

  describe('экранирование спецсимволов в ключевых словах', () => {
    it('requiredKeywords: "$50" — $ экранируется, матчит "$50" но не "$5000"', () => {
      const mMatch = makeMarket({ question: 'Will price reach $50 by end of year?', marketIdSuffix: 'sp1' });
      const mNoMatch = makeMarket({ question: 'Will price reach $5000 by end of year?', marketIdSuffix: 'sp2' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, requiredKeywords: ['$50'] };

      const result = filter.filterCandidates([mMatch, mNoMatch], config, NOW_MS);

      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(mMatch.marketId);
    });

    it('excludedKeywords: "c++" — + экранируется, исключает "C++" но не "C-based"', () => {
      const mExcluded = makeMarket({ question: 'Will C++ remain the top systems language?', marketIdSuffix: 'cpp1' });
      const mKept = makeMarket({ question: 'Will C-based languages grow in 2025?', marketIdSuffix: 'cpp2' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['c++'] };

      const result = filter.filterCandidates([mExcluded, mKept], config, NOW_MS);

      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(mKept.marketId);
    });
  });

  describe('lookaround matching: цифры и дефисы в ключевых словах', () => {
    it('anyOfKeywords: "web3" — матчит "Web3" но не "web30" (цифра блокирует lookahead)', () => {
      const mMatch = makeMarket({ question: 'Will Web3 adoption grow in 2025?', marketIdSuffix: 'w31' });
      const mNoMatch = makeMarket({ question: 'Will Web30 protocol dominate the market?', marketIdSuffix: 'w32' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, anyOfKeywords: ['web3'] };

      const result = filter.filterCandidates([mMatch, mNoMatch], config, NOW_MS);

      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(mMatch.marketId);
    });

    it('excludedKeywords: "ai" — не матчит "retail" (lookahead предотвращает ложное срабатывание)', () => {
      const mExcluded = makeMarket({ question: 'Will AI dominate the tech market?', marketIdSuffix: 'ai1' });
      const mKept = makeMarket({ question: 'Will retail sales exceed expectations?', marketIdSuffix: 'ai2' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['ai'] };

      const result = filter.filterCandidates([mExcluded, mKept], config, NOW_MS);

      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(mKept.marketId); // 'ret-ai-l' не матчит 'ai'
    });

    it('anyOfKeywords: "covid-19" — дефис не ломает поиск, матчит "COVID-19"', () => {
      const m = makeMarket({ question: 'Will COVID-19 cases decline next year?', marketIdSuffix: 'cov1' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, anyOfKeywords: ['covid-19'] };

      const result = filter.filterCandidates([m], config, NOW_MS);

      expect(result).toHaveLength(1);
    });

    it('excludedKeywords: "e-sports" — не матчит "esports" (без дефиса)', () => {
      const mExcluded = makeMarket({ question: 'Will e-sports market grow in 2025?', marketIdSuffix: 'es1' });
      const mKept = makeMarket({ question: 'Will esports revenues exceed $5B?', marketIdSuffix: 'es2' });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, excludedKeywords: ['e-sports'] };

      const result = filter.filterCandidates([mExcluded, mKept], config, NOW_MS);

      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(mKept.marketId);
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
        minLiquidity: 5000,
        maxMarketsToReturn: 100,
        excludedKeywords: ['test'],
      };
      const result = filter.filterCandidates([market], config, NOW_MS);
      expect(result).toHaveLength(0);
    });

    it('смешанный список: одни проходят, другие нет', () => {
      const passing = makeMarket({ marketIdSuffix: 'A1', liquidity: 20_000 });
      const failing = makeMarket({ marketIdSuffix: 'A2', liquidity: 100 });
      const config: IMarketFilterConfig = { ...BASE_CONFIG, minLiquidity: 10_000 };
      const result = filter.filterCandidates([passing, failing], config, NOW_MS);
      expect(result).toHaveLength(1);
      expect(result[0]!.marketId).toBe(passing.marketId);
    });
  });
});

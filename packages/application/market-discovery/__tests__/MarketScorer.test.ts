/**
 * Тесты для MarketScorer.
 *
 * @remarks
 * Покрывают сортировку по expiresAt ASC и liquidity DESC при равных expiresAt.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { PaperClock } from '@polymarket/time';
import { TimestampService, Price, Quantity } from '@polymarket/value-objects';
import { asMarketId, asInstrumentId } from '@polymarket/ids';
import type { DiscoveredMarket } from '@polymarket/ports';
import { MarketScorer } from '../src/MarketScorer.js';

// Фиксированные отметки времени для тестов
// Используем будущее время, чтобы score (hoursToExpiry) был положительным
const NOW_MS = 1_700_000_000_000;
const IN_24H = NOW_MS + 24 * 60 * 60 * 1000;
const IN_48H = NOW_MS + 48 * 60 * 60 * 1000;
const IN_72H = NOW_MS + 72 * 60 * 60 * 1000;

/**
 * Создаёт DiscoveredMarket с заданными параметрами.
 */
function makeMarket(params: {
  expiresAtMs: number;
  liquidity?: number;
  suffix?: string;
}): DiscoveredMarket {
  const { expiresAtMs, liquidity = 5000, suffix = 'x1' } = params;

  const expiresAtResult = TimestampService.create(expiresAtMs);
  if (!expiresAtResult.ok) throw new Error(`Invalid timestamp`);

  const marketId = asMarketId(`0xmarket${suffix}`);
  if (!marketId) throw new Error(`Invalid marketId`);

  const instrumentId = asInstrumentId(`0xinstr${suffix}`);
  if (!instrumentId) throw new Error(`Invalid instrumentId`);

  return {
    marketId,
    instrumentId,
    question: `Market ${suffix}`,
    expiresAt: expiresAtResult.value,
    tickSize: Price.of(new Decimal('0.01')),
    minOrderSize: Quantity.of(new Decimal('1')),
    active: true,
    spread: new Decimal('0.05'),
    liquidity: new Decimal(liquidity),
    score: new Decimal(0),
  };
}

describe('MarketScorer', () => {
  let scorer: MarketScorer;

  beforeEach(() => {
    scorer = new MarketScorer(new PaperClock(new Date(NOW_MS)));
  });

  describe('базовые случаи', () => {
    it('пустой список → возвращает []', () => {
      const result = scorer.scoreAndSort([]);
      expect(result).toEqual([]);
    });

    it('один элемент → возвращает его с проставленным score', () => {
      const market = makeMarket({ expiresAtMs: IN_24H, suffix: 'solo' });
      const result = scorer.scoreAndSort([market]);
      expect(result).toHaveLength(1);
      // score ≈ 24 часа (с погрешностью из-за Date.now())
      expect(result[0]!.score.greaterThan(0)).toBe(true);
    });

    it('не мутирует исходный массив', () => {
      const market1 = makeMarket({ expiresAtMs: IN_48H, suffix: 'm1' });
      const market2 = makeMarket({ expiresAtMs: IN_24H, suffix: 'm2' });
      const original = [market1, market2];
      scorer.scoreAndSort(original);
      // Исходный порядок не изменился
      expect(original[0]!.marketId).toBe(market1.marketId);
      expect(original[1]!.marketId).toBe(market2.marketId);
    });
  });

  describe('сортировка по expiresAt ASC', () => {
    it('три рынка с разными expiresAt → отсортированы по возрастанию', () => {
      const m72h = makeMarket({ expiresAtMs: IN_72H, suffix: '72h' });
      const m24h = makeMarket({ expiresAtMs: IN_24H, suffix: '24h' });
      const m48h = makeMarket({ expiresAtMs: IN_48H, suffix: '48h' });

      const result = scorer.scoreAndSort([m72h, m24h, m48h]);

      expect(result[0]!.marketId).toBe(m24h.marketId); // 24h — первый
      expect(result[1]!.marketId).toBe(m48h.marketId); // 48h — второй
      expect(result[2]!.marketId).toBe(m72h.marketId); // 72h — третий
    });

    it('score проставляется корректно (ближайший → меньше score)', () => {
      const m24h = makeMarket({ expiresAtMs: IN_24H, suffix: 's24' });
      const m48h = makeMarket({ expiresAtMs: IN_48H, suffix: 's48' });

      const result = scorer.scoreAndSort([m48h, m24h]);

      // score[0] < score[1] (ближайшее истечение = меньше hoursToExpiry)
      expect(result[0]!.score.lessThan(result[1]!.score)).toBe(true);
    });
  });

  describe('сортировка при равных expiresAt: по liquidity DESC', () => {
    it('два рынка с одинаковым expiresAt → более ликвидный первый', () => {
      const highLiq = makeMarket({ expiresAtMs: IN_24H, liquidity: 50_000, suffix: 'hi' });
      const lowLiq = makeMarket({ expiresAtMs: IN_24H, liquidity: 1_000, suffix: 'lo' });

      const result = scorer.scoreAndSort([lowLiq, highLiq]);

      expect(result[0]!.marketId).toBe(highLiq.marketId);
      expect(result[1]!.marketId).toBe(lowLiq.marketId);
    });

    it('три рынка с одинаковым expiresAt → отсортированы по liquidity DESC', () => {
      const low = makeMarket({ expiresAtMs: IN_24H, liquidity: 1_000, suffix: 'l1' });
      const high = makeMarket({ expiresAtMs: IN_24H, liquidity: 100_000, suffix: 'l2' });
      const mid = makeMarket({ expiresAtMs: IN_24H, liquidity: 10_000, suffix: 'l3' });

      const result = scorer.scoreAndSort([low, high, mid]);

      expect(result[0]!.liquidity.toNumber()).toBe(100_000); // high
      expect(result[1]!.liquidity.toNumber()).toBe(10_000);  // mid
      expect(result[2]!.liquidity.toNumber()).toBe(1_000);   // low
    });
  });

  describe('комбинированная сортировка', () => {
    it('смешанный список: разные expiresAt и liquidity → правильный порядок', () => {
      // Ожидаемый порядок: m24_high, m24_low, m48
      const m48 = makeMarket({ expiresAtMs: IN_48H, liquidity: 50_000, suffix: 'c1' });
      const m24_low = makeMarket({ expiresAtMs: IN_24H, liquidity: 1_000, suffix: 'c2' });
      const m24_high = makeMarket({ expiresAtMs: IN_24H, liquidity: 20_000, suffix: 'c3' });

      const result = scorer.scoreAndSort([m48, m24_low, m24_high]);

      expect(result[0]!.marketId).toBe(m24_high.marketId);
      expect(result[1]!.marketId).toBe(m24_low.marketId);
      expect(result[2]!.marketId).toBe(m48.marketId);
    });
  });
});

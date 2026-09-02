/**
 * Поведенческие тесты `PolymarketSubscriptionPlanner`.
 *
 * @remarks
 * Проверяются ворота пригодности и их ПОРЯДОК, границы обоих временных
 * правил (строгое «до старта» и минимальный запас), момент оценки policy и
 * контракты результата: детерминизм, иммутабельность входа и выхода,
 * арифметика диагностики.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { KnownVenues, unsafeCryptoAssetId } from '@polymarket/ids';
import { createPolymarketPolicy } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import {
  DEFAULT_MIN_LEAD_TIME_MS,
  PolymarketSubscriptionPlanner,
} from '../src/index.js';
import {
  AT_1750_MS,
  AT_1755_MS,
  AT_1757_MS,
  AT_1758_MS,
  AT_1800_MS,
  AT_1805_MS,
  FIFTEEN_MIN_MS,
  FIVE_MIN_MS,
  TWO_MIN_MS,
  makeEntry,
  nominal,
  ts,
  usdc,
} from './helpers/fixtures.js';

/** Policy без ограничений, кроме семейства: изолирует lifecycle-ворота. */
const ANY_MARKET: PolymarketPolicy = createPolymarketPolicy({
  kind: 'POLYMARKET',
  family: 'CRYPTO_UP_DOWN',
});

/** Идентификаторы кандидатов плана в порядке плана. */
function ids(candidates: readonly MarketDiscoveryEntry[]): string[] {
  return candidates.map((entry) => String(entry.market.id));
}

describe('PolymarketSubscriptionPlanner', () => {
  let planner: PolymarketSubscriptionPlanner;

  beforeEach(() => {
    planner = new PolymarketSubscriptionPlanner();
  });

  describe('конфигурация', () => {
    it('по умолчанию минимальный запас — 2 минуты', () => {
      expect(DEFAULT_MIN_LEAD_TIME_MS).toBe(TWO_MIN_MS);
    });

    it('дефолтный планировщик ведёт себя как заданный явным дефолтом', () => {
      const explicit = new PolymarketSubscriptionPlanner({
        minLeadTimeMs: DEFAULT_MIN_LEAD_TIME_MS,
      });
      const entries = [
        makeEntry({ id: 'lead-exact', startsAtMs: AT_1800_MS }),
        makeEntry({ id: 'lead-short', startsAtMs: AT_1800_MS + FIVE_MIN_MS }),
      ];
      const now = ts(AT_1800_MS - TWO_MIN_MS);

      expect(ids(planner.plan(entries, ANY_MARKET, now).candidates)).toEqual(
        ids(explicit.plan(entries, ANY_MARKET, now).candidates),
      );
    });

    it('нулевой запас допустим: он означает «успеть хотя бы на миллисекунду»', () => {
      const zeroLead = new PolymarketSubscriptionPlanner({ minLeadTimeMs: 0 });
      const entry = makeEntry({ startsAtMs: AT_1800_MS });

      const plan = zeroLead.plan([entry], ANY_MARKET, ts(AT_1800_MS - 1));

      expect(plan.diagnostics.eligible).toBe(1);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['дробное', 1.5],
      ['отрицательное', -1],
    ])('некорректный minLeadTimeMs (%s) → отказ при создании', (_label, value) => {
      expect(() => new PolymarketSubscriptionPlanner({ minLeadTimeMs: value })).toThrow(
        /minLeadTimeMs/,
      );
    });
  });

  describe('ворота площадки', () => {
    it('рынок другой площадки отклоняется, даже если всё остальное подходит', () => {
      const polymarket = makeEntry({ id: 'pm-btc', venueId: KnownVenues.POLYMARKET });
      const kalshi = makeEntry({ id: 'kalshi-btc', venueId: KnownVenues.KALSHI });

      const plan = planner.plan([polymarket, kalshi], ANY_MARKET, ts(AT_1755_MS));

      expect(ids(plan.candidates)).toEqual(['pm-btc']);
      expect(plan.diagnostics.wrongVenue).toBe(1);
    });
  });

  describe('ворота состояния', () => {
    it('ACTIVE до старта → пригоден', () => {
      const plan = planner.plan([makeEntry({ state: 'ACTIVE' })], ANY_MARKET, ts(AT_1755_MS));

      expect(plan.diagnostics.eligible).toBe(1);
      expect(plan.diagnostics.inactive).toBe(0);
    });

    it.each(['CLOSED', 'RESOLVED'] as const)('%s → inactive', (state) => {
      const plan = planner.plan([makeEntry({ state })], ANY_MARKET, ts(AT_1755_MS));

      expect(plan.candidates).toHaveLength(0);
      expect(plan.diagnostics.inactive).toBe(1);
    });
  });

  describe('строгая граница «торги ещё не начались»', () => {
    /** Планировщик без запаса: изолирует ровно границу старта. */
    const zeroLead = (): PolymarketSubscriptionPlanner =>
      new PolymarketSubscriptionPlanner({ minLeadTimeMs: 0 });

    it('за миллисекунду до старта → пригоден', () => {
      const plan = zeroLead().plan(
        [makeEntry({ startsAtMs: AT_1800_MS })],
        ANY_MARKET,
        ts(AT_1800_MS - 1),
      );

      expect(plan.diagnostics.eligible).toBe(1);
      expect(plan.diagnostics.alreadyStarted).toBe(0);
    });

    it('РОВНО в момент старта → уже поздно', () => {
      const plan = zeroLead().plan(
        [makeEntry({ startsAtMs: AT_1800_MS })],
        ANY_MARKET,
        ts(AT_1800_MS),
      );

      expect(plan.candidates).toHaveLength(0);
      expect(plan.diagnostics.alreadyStarted).toBe(1);
    });

    it('через миллисекунду после старта → уже поздно', () => {
      const plan = zeroLead().plan(
        [makeEntry({ startsAtMs: AT_1800_MS })],
        ANY_MARKET,
        ts(AT_1800_MS + 1),
      );

      expect(plan.candidates).toHaveLength(0);
      expect(plan.diagnostics.alreadyStarted).toBe(1);
    });

    it('идущий рынок не догоняется даже при огромном запасе до истечения', () => {
      const running = makeEntry({
        id: 'running-15m',
        startsAtMs: AT_1755_MS,
        nominalMs: FIFTEEN_MIN_MS,
      });

      const plan = planner.plan([running], ANY_MARKET, ts(AT_1757_MS));

      expect(plan.candidates).toHaveLength(0);
      expect(plan.diagnostics.alreadyStarted).toBe(1);
    });
  });

  describe('граница минимального запаса (120 000 мс)', () => {
    it.each([
      ['запас больше минимума', 120_001, 1, 0],
      ['запас РОВНО минимум', 120_000, 1, 0],
      ['запас меньше минимума на миллисекунду', 119_999, 0, 1],
    ])('%s', (_label, timeToStartMs, eligible, insufficient) => {
      const plan = planner.plan(
        [makeEntry({ startsAtMs: AT_1800_MS })],
        ANY_MARKET,
        ts(AT_1800_MS - timeToStartMs),
      );

      expect(plan.diagnostics.eligible).toBe(eligible);
      expect(plan.diagnostics.insufficientLeadTime).toBe(insufficient);
    });

    it('отклонение по запасу не запоминается: оно повторяется само', () => {
      // Прежний координатор держал кэш «отклонён по lead time». Планировщик
      // stateless: время до старта убывает монотонно, поэтому повторный
      // отказ получается сам, а не из состояния.
      const entry = makeEntry({ startsAtMs: AT_1800_MS });

      const first = planner.plan([entry], ANY_MARKET, ts(AT_1800_MS - 119_999));
      const second = planner.plan([entry], ANY_MARKET, ts(AT_1800_MS - 50_000));

      expect(first.diagnostics.insufficientLeadTime).toBe(1);
      expect(second.diagnostics.insufficientLeadTime).toBe(1);
    });
  });

  describe('policy оценивается В МОМЕНТ СТАРТА рынка', () => {
    it('policy, которая ещё НЕ действует, отбирает свой будущий рынок', () => {
      // now = 17:50, policy действует с 18:00, рынок стартует в 18:00.
      const futurePolicy = createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: ts(AT_1800_MS),
      });

      const plan = planner.plan(
        [makeEntry({ id: 'starts-1800', startsAtMs: AT_1800_MS })],
        futurePolicy,
        ts(AT_1750_MS),
      );

      expect(ids(plan.candidates)).toEqual(['starts-1800']);
      expect(plan.diagnostics.policyMismatch).toBe(0);
    });

    it('policy, которая действует СЕЙЧАС, не отбирает рынок за своей границей', () => {
      // now = 17:50, policy действует до 18:00, рынок стартует в 18:00:
      // окно полуоткрыто, стык принадлежит СЛЕДУЮЩЕЙ policy.
      const expiringPolicy = createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveUntil: ts(AT_1800_MS),
      });

      const plan = planner.plan(
        [makeEntry({ id: 'starts-1800', startsAtMs: AT_1800_MS })],
        expiringPolicy,
        ts(AT_1750_MS),
      );

      expect(plan.candidates).toHaveLength(0);
      expect(plan.diagnostics.policyMismatch).toBe(1);
    });

    it('стык окна policy и граница запаса выполняются ОДНОВРЕМЕННО', () => {
      // now = 17:58, старт 18:00, effectiveFrom = 18:00, запас = ровно 2 мин.
      const fromEighteen = createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: ts(AT_1800_MS),
      });

      const plan = planner.plan(
        [makeEntry({ id: 'starts-1800', startsAtMs: AT_1800_MS })],
        fromEighteen,
        ts(AT_1758_MS),
      );

      expect(ids(plan.candidates)).toEqual(['starts-1800']);
    });
  });

  describe('переиспользование MarketFilter', () => {
    it('селекторы актива, номинала и ликвидности работают как в policy-контуре', () => {
      const entries = [
        makeEntry({ id: 'btc-5m-liquid', asset: 'btc', nominalMs: FIVE_MIN_MS, liquidity: 1000 }),
        makeEntry({ id: 'eth-5m-liquid', asset: 'eth', nominalMs: FIVE_MIN_MS, liquidity: 1000 }),
        makeEntry({ id: 'btc-15m', asset: 'btc', nominalMs: FIFTEEN_MIN_MS, liquidity: 1000 }),
        makeEntry({ id: 'btc-5m-thin', asset: 'btc', nominalMs: FIVE_MIN_MS, liquidity: 10 }),
      ];
      const btc5m = createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        assets: [unsafeCryptoAssetId('btc')],
        durations: [nominal(FIVE_MIN_MS)],
        minLiquidity: usdc(100),
      });

      const plan = planner.plan(entries, btc5m, ts(AT_1755_MS));

      expect(ids(plan.candidates)).toEqual(['btc-5m-liquid']);
      expect(plan.diagnostics.policyMismatch).toBe(3);
    });
  });

  describe('порядок: сначала пригодность, потом ранжирование', () => {
    it('уже идущий рынок не становится вершиной плана', () => {
      // Скорер сам по себе поставил бы A первым: его startsAt самый ранний.
      const entries = [
        makeEntry({ id: 'A-started', startsAtMs: AT_1757_MS - 10 * 60_000 }),
        makeEntry({ id: 'B-plus-5m', startsAtMs: AT_1757_MS + 5 * 60_000 }),
        makeEntry({ id: 'C-plus-2m', startsAtMs: AT_1757_MS + 2 * 60_000 }),
      ];

      const plan = planner.plan(
        entries,
        ANY_MARKET,
        ts(AT_1757_MS),
      );

      expect(ids(plan.candidates)).toEqual(['C-plus-2m', 'B-plus-5m']);
      expect(plan.diagnostics.alreadyStarted).toBe(1);
    });
  });

  describe('диагностика', () => {
    /** Набор, где на каждую причину приходится ровно одна запись. */
    function oneOfEach(): readonly MarketDiscoveryEntry[] {
      return [
        makeEntry({ id: 'wrong-venue', venueId: KnownVenues.KALSHI, startsAtMs: AT_1805_MS }),
        makeEntry({ id: 'inactive', state: 'CLOSED', startsAtMs: AT_1805_MS }),
        makeEntry({ id: 'already-started', startsAtMs: AT_1755_MS }),
        makeEntry({ id: 'lead-too-short', startsAtMs: AT_1757_MS + 60_000 }),
        makeEntry({ id: 'policy-mismatch', asset: 'eth', startsAtMs: AT_1805_MS }),
        makeEntry({ id: 'eligible', asset: 'btc', startsAtMs: AT_1805_MS }),
      ];
    }

    /** Policy, отсекающая ровно запись `policy-mismatch`. */
    const btcOnly = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [unsafeCryptoAssetId('btc')],
    });

    it('каждая запись попадает РОВНО в одну категорию', () => {
      const plan = planner.plan(oneOfEach(), btcOnly, ts(AT_1757_MS));

      expect(plan.diagnostics).toEqual({
        scanned: 6,
        wrongVenue: 1,
        inactive: 1,
        alreadyStarted: 1,
        insufficientLeadTime: 1,
        policyMismatch: 1,
        eligible: 1,
      });
    });

    it('сумма причин равна числу просмотренных записей', () => {
      const { diagnostics } = planner.plan(oneOfEach(), btcOnly, ts(AT_1757_MS));

      const sum =
        diagnostics.wrongVenue +
        diagnostics.inactive +
        diagnostics.alreadyStarted +
        diagnostics.insufficientLeadTime +
        diagnostics.policyMismatch +
        diagnostics.eligible;

      expect(sum).toBe(diagnostics.scanned);
    });

    it('запись, нарушающая несколько правил, считается по ПЕРВОЙ причине', () => {
      // Чужая площадка + терминальное состояние + рынок уже идёт: причина
      // одна — та, что раньше в порядке ворот.
      const entry = makeEntry({
        id: 'multi',
        venueId: KnownVenues.KALSHI,
        state: 'RESOLVED',
        startsAtMs: AT_1755_MS,
      });

      const { diagnostics } = planner.plan([entry], btcOnly, ts(AT_1757_MS));

      expect(diagnostics.wrongVenue).toBe(1);
      expect(diagnostics.inactive).toBe(0);
      expect(diagnostics.alreadyStarted).toBe(0);
    });

    it('пустой вход → пустой план с нулевой диагностикой', () => {
      const plan = planner.plan([], ANY_MARKET, ts(AT_1757_MS));

      expect(plan.candidates).toEqual([]);
      expect(plan.diagnostics.scanned).toBe(0);
      expect(plan.diagnostics.eligible).toBe(0);
    });
  });

  describe('контракты результата', () => {
    it('plannedAt — РОВНО переданный момент', () => {
      const now = ts(AT_1757_MS);

      const plan = planner.plan([makeEntry()], ANY_MARKET, now);

      expect(plan.plannedAt).toBe(now);
    });

    it('план, кандидаты и диагностика заморожены', () => {
      const plan = planner.plan([makeEntry()], ANY_MARKET, ts(AT_1757_MS));

      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.candidates)).toBe(true);
      expect(Object.isFrozen(plan.diagnostics)).toBe(true);
    });

    it('повторный вызов с теми же входами даёт тот же результат', () => {
      const entries = [
        makeEntry({ id: 'first', startsAtMs: AT_1805_MS }),
        makeEntry({ id: 'second', startsAtMs: AT_1805_MS + FIVE_MIN_MS }),
        makeEntry({ id: 'started', startsAtMs: AT_1755_MS }),
      ];
      const now = ts(AT_1757_MS);

      const first = planner.plan(entries, ANY_MARKET, now);
      const second = planner.plan(entries, ANY_MARKET, now);

      expect(ids(second.candidates)).toEqual(ids(first.candidates));
      expect(second.diagnostics).toEqual(first.diagnostics);
      expect(second.plannedAt).toBe(first.plannedAt);
    });

    it('кандидаты — ТЕ ЖЕ объекты записей, а не их копии', () => {
      const entry = makeEntry({ startsAtMs: AT_1805_MS });

      const plan = planner.plan([entry], ANY_MARKET, ts(AT_1757_MS));

      expect(plan.candidates[0]).toBe(entry);
    });

    it('вход не мутируется: ни порядок, ни записи, ни метрики', () => {
      const entries = [
        makeEntry({ id: 'later', startsAtMs: AT_1805_MS + FIVE_MIN_MS, liquidity: 10 }),
        makeEntry({ id: 'sooner', startsAtMs: AT_1805_MS, liquidity: 20 }),
        makeEntry({ id: 'started', startsAtMs: AT_1755_MS, liquidity: 30 }),
      ];

      /** Полный слепок содержимого записей. */
      const describeEntries = (): unknown =>
        entries.map((entry) => ({
          entryKeys: Object.keys(entry).sort(),
          marketKeys: Object.keys(entry.market).sort(),
          metricsKeys: Object.keys(entry.metrics).sort(),
          id: String(entry.market.id),
          venueId: String(entry.market.venueId),
          state: entry.market.state.status,
          startsAt: entry.market.startsAt.toISO(),
          liquidity: entry.metrics.liquidity.value().toString(),
        }));

      const before = describeEntries();
      planner.plan(entries, ANY_MARKET, ts(AT_1757_MS));

      expect(describeEntries()).toEqual(before);
      expect(ids(entries)).toEqual(['later', 'sooner', 'started']);
      // Ни score, ни eligible, ни timeToStart планировщик записям не дописывает
      for (const entry of entries) {
        for (const leaked of ['score', 'eligible', 'reason', 'timeToStart']) {
          expect(entry).not.toHaveProperty(leaked);
          expect(entry.market).not.toHaveProperty(leaked);
        }
      }
    });
  });
});

/**
 * Поведенческие тесты `MarketFilter`: применение owner policy к записям
 * universe.
 *
 * @remarks
 * Фикстуры собираются НАСТОЯЩИМИ `Market.create()` и настоящими value
 * objects, без моков сущности. Причина не в чистоте ради чистоты: половина
 * проверяемых здесь правил (номинал серии против фактического окна,
 * совместимость валют, связка «семейство → спецификация») — это инварианты
 * самих доменных типов, и на моках они проверялись бы против выдуманной
 * структуры, а не против той, которую фильтр реально увидит в рантайме.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal нужен как аргумент конструкторов VO (Money.of/Ratio.of) при сборке фикстур; см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { Market, MarketState, asMarketDuration } from '@polymarket/market';
import type { MarketDuration, MarketFamily } from '@polymarket/market';
import {
  KnownVenues,
  unsafeCryptoAssetId,
  unsafeInstrumentId,
  unsafeMarketId,
} from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { Money, Ratio } from '@polymarket/value-objects';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import { MarketFilter } from '../src/MarketFilter.js';
import type { PolymarketPolicy } from '../src/PolymarketPolicy.js';

/** Пять минут в миллисекундах. */
const FIVE_MIN_MS = 5 * 60_000;
/** Пятнадцать минут в миллисекундах. */
const FIFTEEN_MIN_MS = 15 * 60_000;

/** Фиксированное начало торгов по умолчанию (2026-09-01T12:00:00Z). */
const BASE_START_MS = Date.parse('2026-09-01T12:00:00.000Z');

/** Моменты сценария смены policy. */
const AT_1755_MS = Date.parse('2026-09-01T17:55:00.000Z');
const AT_1800_MS = Date.parse('2026-09-01T18:00:00.000Z');
const AT_1805_MS = Date.parse('2026-09-01T18:05:00.000Z');

/**
 * Собирает `Timestamp` из миллисекунд.
 *
 * @param ms - Момент в миллисекундах epoch
 * @returns Canonical `Timestamp`
 * @throws {Error} Если фикстура задаёт невалидный момент
 */
function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`bad timestamp fixture: ${result.error.message}`);
  return result.value;
}

/**
 * Собирает НОМИНАЛ серии из миллисекунд.
 *
 * @param ms - Номинальная длительность серии в миллисекундах
 * @returns `MarketDuration`
 * @throws {Error} Если фикстура задаёт невалидный номинал
 */
function nominal(ms: number): MarketDuration {
  const duration = asMarketDuration(ms);
  if (duration === undefined) throw new Error(`bad duration fixture: ${ms}`);
  return duration;
}

/**
 * Сумма в USDC.
 *
 * @param amount - Величина
 * @returns `Money` в USDC
 */
function usdc(amount: number): Money {
  return Money.of(new Decimal(amount), 'USDC');
}

/**
 * Доля от единицы (`0.02` = 2%).
 *
 * @param value - Величина доли
 * @returns `Ratio`
 */
function ratio(value: number): Ratio {
  return Ratio.of(new Decimal(value));
}

/**
 * Сумма в валюте, НЕСОВМЕСТИМОЙ с порогом policy.
 *
 * @param amount - Величина
 * @returns `Money`, валюта которого не совпадает с USDC
 *
 * @remarks
 * `SUPPORTED_CURRENCIES` сегодня состоит ровно из `'USDC'`, поэтому легальным
 * путём Money другой валюты не построить: `Money.of` отвергает всё остальное
 * инвариантом конструктора. Проверяемая ветка фильтра при этом реальна —
 * список валют расширяется правкой одной константы, и ошибка сравнения
 * разных валют должна быть поймана ДО того, как это произойдёт. Поэтому
 * валюта подменяется точечно и только в тесте: единственная альтернатива —
 * не покрывать ветку вовсе.
 */
function foreignCurrency(amount: number): Money {
  const money = Money.of(new Decimal(amount), 'USDC');
  (money as unknown as { _currency: string })._currency = 'EUR';
  return money;
}

/** Параметры фикстуры записи universe. */
interface EntryOverrides {
  /** Идентификатор рынка (влияет и на инструменты исходов). */
  readonly id?: string;
  /** Вопрос рынка. */
  readonly question?: string;
  /** Базовый криптоактив (только для `CRYPTO_UP_DOWN`). */
  readonly asset?: string;
  /** НОМИНАЛ серии (только для `CRYPTO_UP_DOWN`). */
  readonly nominalMs?: number;
  /** Начало торгов. */
  readonly startsAtMs?: number;
  /** ФАКТИЧЕСКОЕ окно рынка (по умолчанию совпадает с номиналом). */
  readonly windowMs?: number;
  /** Семейство рынка. */
  readonly family?: MarketFamily;
  /** Наблюдаемая ликвидность. */
  readonly liquidity?: Money;
  /** Наблюдаемый спред (отсутствие = площадка спред не отдала). */
  readonly spread?: Ratio;
}

/**
 * Собирает запись universe: canonical рынок + наблюдения по нему.
 *
 * @param overrides - Отклонения от базовой фикстуры
 * @returns `MarketDiscoveryEntry` с настоящим `Market`
 * @throws {Error} Если параметры фикстуры нарушают инварианты `Market`
 *
 * @example
 * ```typescript
 * const entry = makeEntry({ asset: 'eth', nominalMs: FIFTEEN_MIN_MS });
 * ```
 */
function makeEntry(overrides: EntryOverrides = {}): MarketDiscoveryEntry {
  const {
    id = 'market-01',
    question = 'Bitcoin Up or Down — 12:00 to 12:05?',
    asset = 'btc',
    nominalMs = FIVE_MIN_MS,
    startsAtMs = BASE_START_MS,
    windowMs = nominalMs,
    family = 'CRYPTO_UP_DOWN',
    liquidity = usdc(10_000),
    spread,
  } = overrides;

  const created = Market.create({
    id: unsafeMarketId(id),
    venueId: KnownVenues.POLYMARKET,
    question,
    startsAt: ts(startsAtMs),
    expiresAt: ts(startsAtMs + windowMs),
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${id}-down`) },
    ],
    family,
    // Спецификация есть только у CRYPTO_UP_DOWN: BINARY_OUTCOME её ЗАПРЕЩАЕТ
    // (инвариант Market.create), и именно так собирается рынок без crypto.
    ...(family === 'CRYPTO_UP_DOWN'
      ? { crypto: { asset: unsafeCryptoAssetId(asset), duration: nominal(nominalMs) } }
      : {}),
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);

  return {
    market: created.value,
    metrics: spread === undefined ? { liquidity } : { liquidity, spread },
  };
}

/**
 * Собирает запись, у которой семейство — `CRYPTO_UP_DOWN`, а обязательной
 * crypto-спецификации НЕТ.
 *
 * @param overrides - Отклонения от базовой фикстуры (семейство игнорируется)
 * @returns `MarketDiscoveryEntry` со структурно несогласованным рынком
 * @throws {Error} Если параметры фикстуры нарушают инварианты `Market`
 *
 * @remarks
 * Легального пути построить такой рынок нет: `Market.create()` требует
 * спецификацию у `CRYPTO_UP_DOWN` и запрещает её остальным семействам
 * (`_validateFamily`). Поэтому фикстура собирается настоящим
 * `BINARY_OUTCOME` — семейством, у которого ключа `crypto` не существует
 * вовсе, — а семейство подменяется точечно и только в тесте, как валюта в
 * `foreignCurrency()`.
 *
 * Покрываемое правило от этого не становится выдуманным: фильтр обязан
 * отвечать на такую запись одинаково независимо от того, задал ли
 * потребитель селекторы, и обязан выдерживать запись, собранную в обход
 * canonical-фабрики.
 *
 * @example
 * ```typescript
 * const broken = makeCryptoEntryWithoutSpec();
 * expect(broken.market.crypto).toBeUndefined();
 * ```
 */
function makeCryptoEntryWithoutSpec(overrides: EntryOverrides = {}): MarketDiscoveryEntry {
  const entry = makeEntry({ id: 'crypto-no-spec', ...overrides, family: 'BINARY_OUTCOME' });
  (entry.market as unknown as { family: MarketFamily }).family = 'CRYPTO_UP_DOWN';
  return entry;
}

/** Policy без единого ограничения, кроме семейства. */
const BASE_POLICY: PolymarketPolicy = {
  kind: 'POLYMARKET',
  family: 'CRYPTO_UP_DOWN',
};

/** Момент оценки по умолчанию (policy без окна действует всегда). */
const AT = ts(BASE_START_MS);

describe('MarketFilter', () => {
  let filter: MarketFilter;

  beforeEach(() => {
    filter = new MarketFilter();
  });

  describe('базовые случаи', () => {
    it('пустой вход → пустой результат', () => {
      expect(filter.filter([], BASE_POLICY, AT)).toEqual([]);
    });

    it('рынок проходит все селекторы → подходит', () => {
      const entry = makeEntry();
      expect(filter.matches(entry, BASE_POLICY, AT)).toBe(true);
      expect(filter.filter([entry], BASE_POLICY, AT)).toHaveLength(1);
    });
  });

  describe('окно policy (полуоткрытый интервал)', () => {
    it('policy без окна действует в любой момент', () => {
      const entry = makeEntry();
      expect(filter.matches(entry, BASE_POLICY, ts(0))).toBe(true);
      expect(filter.matches(entry, BASE_POLICY, ts(AT_1805_MS))).toBe(true);
    });

    it('effectiveFrom включён, effectiveUntil исключён', () => {
      const entry = makeEntry();
      const windowed: PolymarketPolicy = {
        ...BASE_POLICY,
        effectiveFrom: ts(AT_1755_MS),
        effectiveUntil: ts(AT_1800_MS),
      };

      expect(filter.matches(entry, windowed, ts(AT_1755_MS - 1))).toBe(false);
      expect(filter.matches(entry, windowed, ts(AT_1755_MS))).toBe(true);
      expect(filter.matches(entry, windowed, ts(AT_1800_MS - 1))).toBe(true);
      expect(filter.matches(entry, windowed, ts(AT_1800_MS))).toBe(false);
    });

    it('смена policy в 18:00: стык принадлежит СЛЕДУЮЩЕЙ policy', () => {
      // Момент оценки — старт КОНКРЕТНОГО рынка: ровно так спрашивает
      // планировщик подписок («будет ли policy действовать, когда рынок
      // откроется»), и ровно здесь замкнутый интервал дал бы двух владельцев
      // одного рынка в точке стыка.
      const btcPolicy: PolymarketPolicy = {
        ...BASE_POLICY,
        assets: [unsafeCryptoAssetId('btc')],
        effectiveUntil: ts(AT_1800_MS),
      };
      const xrpPolicy: PolymarketPolicy = {
        ...BASE_POLICY,
        assets: [unsafeCryptoAssetId('xrp')],
        effectiveFrom: ts(AT_1800_MS),
      };

      const btc1755 = makeEntry({ id: 'btc-1755', asset: 'btc', startsAtMs: AT_1755_MS });
      const btc1800 = makeEntry({ id: 'btc-1800', asset: 'btc', startsAtMs: AT_1800_MS });
      const xrp1800 = makeEntry({ id: 'xrp-1800', asset: 'xrp', startsAtMs: AT_1800_MS });
      const xrp1805 = makeEntry({ id: 'xrp-1805', asset: 'xrp', startsAtMs: AT_1805_MS });

      expect(filter.matches(btc1755, btcPolicy, btc1755.market.startsAt)).toBe(true);
      expect(filter.matches(btc1800, btcPolicy, btc1800.market.startsAt)).toBe(false);
      expect(filter.matches(xrp1800, xrpPolicy, xrp1800.market.startsAt)).toBe(true);
      expect(filter.matches(xrp1805, xrpPolicy, xrp1805.market.startsAt)).toBe(true);
    });

    it('недействующая policy отклоняет рынок, подходящий по всем остальным селекторам', () => {
      const entry = makeEntry();
      const expired: PolymarketPolicy = { ...BASE_POLICY, effectiveUntil: ts(BASE_START_MS) };
      expect(filter.matches(entry, expired, AT)).toBe(false);
      expect(filter.filter([entry], expired, AT)).toEqual([]);
    });
  });

  describe('семейство', () => {
    it('семейство рынка совпадает с policy → подходит', () => {
      const entry = makeEntry({ family: 'CRYPTO_UP_DOWN' });
      expect(filter.matches(entry, BASE_POLICY, AT)).toBe(true);
    });

    it('семейство рынка НЕ совпадает с policy → не подходит', () => {
      const entry = makeEntry({ id: 'binary-01', family: 'BINARY_OUTCOME' });
      expect(filter.matches(entry, BASE_POLICY, AT)).toBe(false);
    });
  });

  describe('обязательная спецификация семейства', () => {
    it('фикстура действительно несогласованна: семейство есть, спецификации нет', () => {
      const entry = makeCryptoEntryWithoutSpec();
      expect(entry.market.family).toBe('CRYPTO_UP_DOWN');
      expect(entry.market.crypto).toBeUndefined();
    });

    it('CRYPTO_UP_DOWN без спецификации не подходит policy БЕЗ селекторов', () => {
      // Ядро правила: испорченность записи — свойство самой записи, поэтому
      // ответ не имеет права зависеть от того, ограничил ли потребитель
      // актив или номинал. Пока проверка жила в селекторах, эта же запись
      // проходила policy без ограничений.
      const entry = makeCryptoEntryWithoutSpec();
      expect(() => filter.matches(entry, BASE_POLICY, AT)).not.toThrow();
      expect(filter.matches(entry, BASE_POLICY, AT)).toBe(false);
      expect(filter.filter([entry], BASE_POLICY, AT)).toEqual([]);
    });

    it('РЕГРЕССИЯ: он же не подходит policy с заданным assets', () => {
      const entry = makeCryptoEntryWithoutSpec();
      const policy: PolymarketPolicy = { ...BASE_POLICY, assets: [unsafeCryptoAssetId('btc')] };
      expect(filter.matches(entry, policy, AT)).toBe(false);
      expect(filter.filter([entry], policy, AT)).toEqual([]);
    });

    it('РЕГРЕССИЯ: он же не подходит policy с заданным durations', () => {
      const entry = makeCryptoEntryWithoutSpec();
      const policy: PolymarketPolicy = { ...BASE_POLICY, durations: [nominal(FIVE_MIN_MS)] };
      expect(filter.matches(entry, policy, AT)).toBe(false);
      expect(filter.filter([entry], policy, AT)).toEqual([]);
    });

    it('BINARY_OUTCOME без спецификации подходит своей policy без селекторов', () => {
      // Обратная сторона правила: у не-crypto семейства спецификация
      // ЗАПРЕЩЕНА инвариантом домена, поэтому требовать её здесь значило бы
      // отбросить каждый исправный BINARY_OUTCOME.
      const entry = makeEntry({ id: 'binary-03', family: 'BINARY_OUTCOME' });
      const policy: PolymarketPolicy = { ...BASE_POLICY, family: 'BINARY_OUTCOME' };
      expect(entry.market.crypto).toBeUndefined();
      expect(filter.matches(entry, policy, AT)).toBe(true);
      expect(filter.filter([entry], policy, AT)).toHaveLength(1);
    });
  });

  describe('актив', () => {
    it('актив рынка в списке policy → подходит', () => {
      const entry = makeEntry({ asset: 'btc' });
      const policy: PolymarketPolicy = { ...BASE_POLICY, assets: [unsafeCryptoAssetId('btc')] };
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('актив рынка НЕ в списке policy → не подходит', () => {
      const entry = makeEntry({ asset: 'eth' });
      const policy: PolymarketPolicy = { ...BASE_POLICY, assets: [unsafeCryptoAssetId('btc')] };
      expect(filter.matches(entry, policy, AT)).toBe(false);
    });

    it('несколько активов в policy → подходит любой из них', () => {
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        assets: [unsafeCryptoAssetId('btc'), unsafeCryptoAssetId('eth')],
      };
      expect(filter.matches(makeEntry({ asset: 'btc' }), policy, AT)).toBe(true);
      expect(filter.matches(makeEntry({ asset: 'eth' }), policy, AT)).toBe(true);
      expect(filter.matches(makeEntry({ asset: 'sol' }), policy, AT)).toBe(false);
    });

    it('assets: [] и assets: undefined — оба означают «ограничения нет»', () => {
      const entry = makeEntry({ asset: 'doge' });
      expect(filter.matches(entry, { ...BASE_POLICY, assets: [] }, AT)).toBe(true);
      expect(filter.matches(entry, { ...BASE_POLICY, assets: undefined }, AT)).toBe(true);
    });

    it('рынок без crypto-спецификации отклоняется, а не роняет фильтр', () => {
      // Семейство совпадает, но спецификации у BINARY_OUTCOME нет по
      // инварианту Market.create — то есть policy спрашивает про актив у
      // рынка, у которого актива не существует.
      const entry = makeEntry({ id: 'binary-02', family: 'BINARY_OUTCOME' });
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        family: 'BINARY_OUTCOME',
        assets: [unsafeCryptoAssetId('btc')],
      };
      expect(() => filter.matches(entry, policy, AT)).not.toThrow();
      expect(filter.matches(entry, policy, AT)).toBe(false);
      expect(filter.filter([entry], policy, AT)).toEqual([]);
    });
  });

  describe('длительность (НОМИНАЛ серии)', () => {
    it('номинал рынка в списке policy → подходит', () => {
      const entry = makeEntry({ nominalMs: FIVE_MIN_MS });
      const policy: PolymarketPolicy = { ...BASE_POLICY, durations: [nominal(FIVE_MIN_MS)] };
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('номинал рынка НЕ в списке policy → не подходит', () => {
      const entry = makeEntry({ nominalMs: FIFTEEN_MIN_MS });
      const policy: PolymarketPolicy = { ...BASE_POLICY, durations: [nominal(FIVE_MIN_MS)] };
      expect(filter.matches(entry, policy, AT)).toBe(false);
    });

    it('несколько номиналов в policy → подходит любой из них', () => {
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        durations: [nominal(FIVE_MIN_MS), nominal(FIFTEEN_MIN_MS)],
      };
      expect(filter.matches(makeEntry({ nominalMs: FIVE_MIN_MS }), policy, AT)).toBe(true);
      expect(filter.matches(makeEntry({ nominalMs: FIFTEEN_MIN_MS }), policy, AT)).toBe(true);
    });

    it('durations: [] и durations: undefined — оба означают «ограничения нет»', () => {
      const entry = makeEntry({ nominalMs: FIFTEEN_MIN_MS });
      expect(filter.matches(entry, { ...BASE_POLICY, durations: [] }, AT)).toBe(true);
      expect(filter.matches(entry, { ...BASE_POLICY, durations: undefined }, AT)).toBe(true);
    });

    it('РЕГРЕССИЯ: сдвинутое окно не выбрасывает рынок из своей серии', () => {
      // Номинал серии — 5 минут, а ФАКТИЧЕСКОЕ окно площадка сдвинула до 4:
      // именно так выглядит реальный рынок с задержкой публикации либо
      // выравниванием по TWAP-окну. Селектор серии обязан смотреть на
      // классификацию (crypto.duration), а не на измеренный интервал
      // (market.duration()) — иначе такой рынок молча выпадает из отбора.
      const entry = makeEntry({ nominalMs: FIVE_MIN_MS, windowMs: 4 * 60_000 });

      expect(entry.market.crypto?.duration).toBe(FIVE_MIN_MS);
      expect(entry.market.duration().toNumber()).toBe(4 * 60_000);

      const policy: PolymarketPolicy = { ...BASE_POLICY, durations: [nominal(FIVE_MIN_MS)] };
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });
  });

  describe('ликвидность', () => {
    const policy: PolymarketPolicy = { ...BASE_POLICY, minLiquidity: usdc(1000) };

    it('ликвидность ниже порога → не подходит', () => {
      expect(filter.matches(makeEntry({ liquidity: usdc(999) }), policy, AT)).toBe(false);
    });

    it('ликвидность РОВНО на пороге → подходит', () => {
      expect(filter.matches(makeEntry({ liquidity: usdc(1000) }), policy, AT)).toBe(true);
    });

    it('ликвидность выше порога → подходит', () => {
      expect(filter.matches(makeEntry({ liquidity: usdc(1001) }), policy, AT)).toBe(true);
    });

    it('minLiquidity: undefined → ограничения нет', () => {
      const entry = makeEntry({ liquidity: usdc(0) });
      expect(filter.matches(entry, { ...BASE_POLICY, minLiquidity: undefined }, AT)).toBe(true);
    });

    it('несовместимая валюта → рынок отклоняется, а не роняет фильтр', () => {
      // Сравнить нельзя, значит порог НЕ подтверждён: отдать такой рынок
      // потребителю значило бы выдать непроверенное условие за проверенное.
      const entry = makeEntry({ liquidity: foreignCurrency(1_000_000) });
      expect(() => filter.matches(entry, policy, AT)).not.toThrow();
      expect(filter.matches(entry, policy, AT)).toBe(false);
      expect(filter.filter([entry], policy, AT)).toEqual([]);
    });
  });

  describe('спред', () => {
    const policy: PolymarketPolicy = { ...BASE_POLICY, minSpread: ratio(0.02) };

    it('спред ниже порога → не подходит', () => {
      expect(filter.matches(makeEntry({ spread: ratio(0.01) }), policy, AT)).toBe(false);
    });

    it('спред РОВНО на пороге → подходит', () => {
      expect(filter.matches(makeEntry({ spread: ratio(0.02) }), policy, AT)).toBe(true);
    });

    it('спред НЕ наблюдался (undefined) → рынок НЕ отклоняется', () => {
      // Поведение мигрировано из старого фильтра НАМЕРЕННО: undefined значит
      // «площадка спред не отдала», а не «спред нулевой». Отклонять рынок за
      // отсутствие наблюдения — значит фильтровать по качеству ответа
      // площадки, а не по свойствам рынка.
      const entry = makeEntry({ spread: undefined });
      expect(entry.metrics.spread).toBeUndefined();
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('minSpread: undefined → ограничения нет', () => {
      const entry = makeEntry({ spread: ratio(0) });
      expect(filter.matches(entry, { ...BASE_POLICY, minSpread: undefined }, AT)).toBe(true);
    });
  });

  describe('ключевые слова: required', () => {
    it('все слова присутствуют → подходит', () => {
      const entry = makeEntry({ question: 'Will Bitcoin price exceed $50,000 by December?' });
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        title: { required: ['bitcoin', 'price'] },
      };
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('одного слова нет → не подходит', () => {
      const entry = makeEntry({ question: 'Will Bitcoin exceed $50,000?' });
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        title: { required: ['bitcoin', 'price'] },
      };
      expect(filter.matches(entry, policy, AT)).toBe(false);
    });

    it('поиск регистронезависимый', () => {
      const entry = makeEntry({ question: 'Will BITCOIN PRICE exceed $50,000?' });
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        title: { required: ['bitcoin', 'price'] },
      };
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('пустой список и отсутствующий селектор — оба означают «ограничения нет»', () => {
      const entry = makeEntry({ question: 'Unrelated question' });
      expect(filter.matches(entry, { ...BASE_POLICY, title: { required: [] } }, AT)).toBe(true);
      expect(filter.matches(entry, { ...BASE_POLICY, title: {} }, AT)).toBe(true);
      expect(filter.matches(entry, { ...BASE_POLICY, title: undefined }, AT)).toBe(true);
    });
  });

  describe('ключевые слова: anyOf', () => {
    const policy: PolymarketPolicy = { ...BASE_POLICY, title: { anyOf: ['up', 'down'] } };

    it('хотя бы одно слово присутствует → подходит', () => {
      const entry = makeEntry({ question: 'Will Bitcoin go up by January?' });
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('ни одного слова нет → не подходит', () => {
      const entry = makeEntry({ question: 'Will Bitcoin exceed $50,000?' });
      expect(filter.matches(entry, policy, AT)).toBe(false);
    });

    it('пустой список → ограничения нет', () => {
      const entry = makeEntry({ question: 'Unrelated question' });
      expect(filter.matches(entry, { ...BASE_POLICY, title: { anyOf: [] } }, AT)).toBe(true);
    });
  });

  describe('ключевые слова: excluded', () => {
    const policy: PolymarketPolicy = { ...BASE_POLICY, title: { excluded: ['test', 'demo'] } };

    it('ни одного запрещённого слова → подходит', () => {
      const entry = makeEntry({ question: 'Will Bitcoin exceed $50,000?' });
      expect(filter.matches(entry, policy, AT)).toBe(true);
    });

    it('любое совпадение отклоняет рынок', () => {
      expect(filter.matches(makeEntry({ question: 'TEST: will Bitcoin rise?' }), policy, AT)).toBe(false);
      expect(filter.matches(makeEntry({ question: 'Demo market for the show' }), policy, AT)).toBe(false);
    });

    it('пустой список → ограничения нет', () => {
      const entry = makeEntry({ question: 'test demo anything' });
      expect(filter.matches(entry, { ...BASE_POLICY, title: { excluded: [] } }, AT)).toBe(true);
    });

    it('три селектора применяются вместе', () => {
      const combined: PolymarketPolicy = {
        ...BASE_POLICY,
        title: { required: ['bitcoin'], anyOf: ['up', 'down'], excluded: ['test'] },
      };
      expect(filter.matches(makeEntry({ question: 'Bitcoin up or down?' }), combined, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Ethereum up or down?' }), combined, AT)).toBe(false);
      expect(filter.matches(makeEntry({ question: 'Bitcoin above 50k?' }), combined, AT)).toBe(false);
      expect(filter.matches(makeEntry({ question: 'TEST Bitcoin up or down?' }), combined, AT)).toBe(false);
    });
  });

  describe('границы слова', () => {
    const policy: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['war'] } };

    it.each([
      ['Will the war end this year?', true],
      ['WAR of words continues?', true],
      ['Will the-war end this year?', true],
      ['Is it war? Really?', true],
      ['Will the reward program expand?', false],
      ['Will forward guidance change?', false],
      ['Will a warrior win the match?', false],
    ])('«%s» → %s', (question, expected) => {
      expect(filter.matches(makeEntry({ question }), policy, AT)).toBe(expected);
    });

    it('дефис и апостроф не ломают поиск', () => {
      const covid: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['covid'] } };
      expect(filter.matches(makeEntry({ question: 'Will COVID-19 cases rise?' }), covid, AT)).toBe(true);

      const trump: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['trump'] } };
      expect(filter.matches(makeEntry({ question: "Will Trump's rating exceed 50%?" }), trump, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Will Trumpist policies dominate?' }), trump, AT)).toBe(false);
    });

    it('цифра рядом со словом блокирует совпадение', () => {
      const web3: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['web3'] } };
      expect(filter.matches(makeEntry({ question: 'Will Web3 adoption grow?' }), web3, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Will Web30 protocol dominate?' }), web3, AT)).toBe(false);
    });
  });

  describe('экранирование спецсимволов regex', () => {
    it('«$50» — доллар экранирован, «$5000» не совпадает', () => {
      const policy: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['$50'] } };
      expect(filter.matches(makeEntry({ question: 'Will price reach $50 by year end?' }), policy, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Will price reach $5000 by year end?' }), policy, AT)).toBe(false);
    });

    it('«c++» — плюсы экранированы, regex компилируется и совпадает буквально', () => {
      const policy: PolymarketPolicy = { ...BASE_POLICY, title: { excluded: ['c++'] } };
      expect(filter.matches(makeEntry({ question: 'Will C++ remain the top language?' }), policy, AT)).toBe(false);
      expect(filter.matches(makeEntry({ question: 'Will C-based languages grow?' }), policy, AT)).toBe(true);
    });

    it('«a.b» — точка экранирована и не работает как «любой символ»', () => {
      const policy: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['a.b'] } };
      expect(filter.matches(makeEntry({ question: 'Will a.b ship this year?' }), policy, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Will axb ship this year?' }), policy, AT)).toBe(false);
    });

    it('«foo(bar)» — скобки экранированы и не работают как группа', () => {
      const policy: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['foo(bar)'] } };
      expect(filter.matches(makeEntry({ question: 'Will foo(bar) return true?' }), policy, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Will foobar return true?' }), policy, AT)).toBe(false);
    });
  });

  describe('юникодные границы слова', () => {
    const policy: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['up'] } };

    it('нелатинская буква — часть слова, а не разделитель', () => {
      // С ASCII-границей [a-zA-Z0-9] кириллическая буква считалась бы
      // пунктуацией, и «Биткоинup» дал бы ложное совпадение по слову «up».
      expect(filter.matches(makeEntry({ question: 'Биткоинup or down?' }), policy, AT)).toBe(false);
      expect(filter.matches(makeEntry({ question: 'Биткоин up or down?' }), policy, AT)).toBe(true);
    });

    it('комбинирующий знак (NFD) — часть слова, а не разделитель', () => {
      // 'й' в разложенной форме: 'и' (U+0438) + комбинирующая бреве (U+0306).
      // Нормализацию площадка не гарантирует, а в разложенной форме ПОСЛЕДНИЙ
      // символ слова — комбинирующий знак, а не буква: без \p{M} в классе
      // границы он читался бы как разделитель, и «up» после него считалось бы
      // отдельным словом.
      const question = 'Бо\u0438\u0306up or down?';
      expect(question.normalize('NFD')).toBe(question);
      expect(filter.matches(makeEntry({ question }), policy, AT)).toBe(false);
    });

    it('нелатинское ключевое слово ищется регистронезависимо', () => {
      const cyrillic: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['биткоин'] } };
      expect(filter.matches(makeEntry({ question: 'Биткоин вверх или вниз?' }), cyrillic, AT)).toBe(true);
      expect(filter.matches(makeEntry({ question: 'Эфириум вверх или вниз?' }), cyrillic, AT)).toBe(false);
    });
  });

  describe('filter()', () => {
    it('не мутирует вход', () => {
      const passing = makeEntry({ id: 'pass', asset: 'btc' });
      const failing = makeEntry({ id: 'fail', asset: 'eth' });
      const entries = [passing, failing];
      const policy: PolymarketPolicy = { ...BASE_POLICY, assets: [unsafeCryptoAssetId('btc')] };

      const result = filter.filter(entries, policy, AT);

      expect(result).not.toBe(entries);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toBe(passing);
      expect(entries[1]).toBe(failing);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(passing);
    });

    it('сохраняет порядок входа', () => {
      const entries = ['c', 'a', 'b'].map((id) => makeEntry({ id }));
      const result = filter.filter(entries, BASE_POLICY, AT);
      expect(result.map((entry) => String(entry.market.id))).toEqual(['c', 'a', 'b']);
    });

    it('эквивалентен поэлементному matches()', () => {
      const entries = [
        makeEntry({ id: 'e1', asset: 'btc', nominalMs: FIVE_MIN_MS, question: 'Bitcoin up or down?', liquidity: usdc(5000) }),
        makeEntry({ id: 'e2', asset: 'eth', nominalMs: FIVE_MIN_MS, question: 'Ethereum up or down?', liquidity: usdc(5000) }),
        makeEntry({ id: 'e3', asset: 'btc', nominalMs: FIFTEEN_MIN_MS, question: 'Bitcoin up or down?', liquidity: usdc(5000) }),
        makeEntry({ id: 'e4', asset: 'btc', nominalMs: FIVE_MIN_MS, question: 'Bitcoin up or down?', liquidity: usdc(10) }),
        makeEntry({ id: 'e5', asset: 'btc', nominalMs: FIVE_MIN_MS, question: 'TEST Bitcoin up or down?', liquidity: usdc(5000) }),
        makeEntry({ id: 'e6', asset: 'btc', nominalMs: FIVE_MIN_MS, question: 'Bitcoin up or down?', liquidity: usdc(5000), spread: ratio(0.001) }),
      ];
      const policy: PolymarketPolicy = {
        ...BASE_POLICY,
        assets: [unsafeCryptoAssetId('btc')],
        durations: [nominal(FIVE_MIN_MS)],
        minLiquidity: usdc(1000),
        minSpread: ratio(0.01),
        title: { required: ['bitcoin'], anyOf: ['up', 'down'], excluded: ['test'] },
      };

      const byFilter = filter.filter(entries, policy, AT);
      const byMatches = entries.filter((entry) => filter.matches(entry, policy, AT));

      expect(byFilter.map((entry) => String(entry.market.id))).toEqual(
        byMatches.map((entry) => String(entry.market.id)),
      );
      expect(byFilter.map((entry) => String(entry.market.id))).toEqual(['e1']);
    });

    it('переиспользование скомпилированных регексов не зависит от числа записей', () => {
      // Регексы компилируются один раз на вызов и прогоняются по всем
      // записям: без флага `g` у RegExp.test нет состояния между вызовами,
      // поэтому одинаковые записи дают одинаковый ответ.
      const entries = ['k1', 'k2', 'k3'].map((id) =>
        makeEntry({ id, question: 'Will the war end this year?' }),
      );
      const policy: PolymarketPolicy = { ...BASE_POLICY, title: { required: ['war'] } };
      expect(filter.filter(entries, policy, AT)).toHaveLength(3);
    });
  });
});

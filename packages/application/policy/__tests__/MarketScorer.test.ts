/**
 * Тесты `MarketScorer`.
 *
 * @remarks
 * Проверяется ровно то, что скорер обещает: составной порядок
 * `startsAt → expiresAt → liquidity → venueId → marketId`, независимость
 * результата от порядка входа, отсутствие мутации входа и отсутствие
 * материализованного `score` на записях.
 *
 * Отдельным блоком закреплено, что порядок по `startsAt` — АБСОЛЮТНЫЙ:
 * записи с началом торгов в прошлом идут впереди предстоящих. Это осознанное
 * решение, а не побочный эффект сортировки, поэтому у него есть тест.
 *
 * Фикстуры собираются из НАСТОЯЩИХ доменных объектов (`Market.create`,
 * `MoneyService.create`, `TimestampService.create`), а не из моков: тест
 * порядка на подделке сущности доказывал бы порядок на подделке. Заодно это
 * гарантирует, что ранжирование опирается на реально существующие поля
 * canonical `Market`, а не на удобную форму, придуманную тестом.
 */
import { describe, it, expect } from '@jest/globals';
import { Market, MarketState } from '@polymarket/market';
import {
  KnownVenues,
  asVenueId,
  unsafeInstrumentId,
  unsafeMarketId,
  type VenueId,
} from '@polymarket/ids';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import { MoneyService, type Money } from '@polymarket/value-objects';
import { MarketScorer } from '../src/MarketScorer.js';

/** Опорный момент фикстур: 2026-09-01T12:00:00.000Z. */
const BASE_MS = Date.UTC(2026, 8, 1, 12, 0, 0);
const MINUTE_MS = 60_000;

/** Площадки для проверки identity-ключа: 'ALPHA_VENUE' < 'BETA_VENUE'. */
const ALPHA_VENUE = venue('ALPHA_VENUE');
const BETA_VENUE = venue('BETA_VENUE');

/**
 * Строит `VenueId` из строки, отказывая на невалидной фикстуре.
 *
 * @param raw - Код площадки
 * @returns Канонический `VenueId`
 * @throws {Error} Если строка не является каноническим `VenueId`
 */
function venue(raw: string): VenueId {
  const parsed = asVenueId(raw);
  if (parsed === undefined) throw new Error(`Invalid fixture venueId: ${raw}`);
  return parsed;
}

/**
 * Отметка времени со сдвигом от опорного момента.
 *
 * @param minutes - Сдвиг в минутах: нулевой, положительный (будущее) или
 *                  отрицательный (прошлое относительно опорного момента)
 * @returns `Timestamp` фикстуры
 * @throws {Error} Если сервис отверг значение
 *
 * @remarks
 * Отрицательный сдвиг нужен для рынков, торги по которым уже идут: `Market`
 * такое расписание принимает — единственный его инвариант по времени это
 * `startsAt < expiresAt`, и с часами он не сверяется.
 */
function at(minutes: number): Timestamp {
  const created = TimestampService.create(BASE_MS + minutes * MINUTE_MS);
  if (!created.ok) throw new Error(`Invalid fixture timestamp: ${minutes}m`);
  return created.value;
}

/**
 * Ликвидность в USDC.
 *
 * @param amount - Сумма
 * @returns `Money` фикстуры
 * @throws {Error} Если сервис отверг значение
 *
 * @remarks
 * Через `MoneyService.create`, а не через `Money.of`: последний принимает
 * готовый `Decimal` и помечен `@internal`, а голый `decimal.js` в этом слое
 * запрещён. Публичный конструктор денег — сервис.
 */
function usdc(amount: number): Money {
  const created = MoneyService.create(amount, 'USDC');
  if (!created.ok) throw new Error(`Invalid fixture liquidity: ${amount}`);
  return created.value;
}

/** Параметры записи-фикстуры. */
interface EntryFixture {
  /** Идентификатор рынка (он же последний ключ ранжирования). */
  readonly id: string;
  /** Площадка (предпоследний ключ ранжирования). */
  readonly venueId?: VenueId;
  /** Начало торгов, минут от опорного момента. */
  readonly startsAtMin: number;
  /** Окончание торгов, минут от опорного момента. */
  readonly expiresAtMin: number;
  /** Наблюдаемая ликвидность в USDC. */
  readonly liquidity: number;
}

/**
 * Собирает запись universe из настоящего `Market` и наблюдений рядом с ним.
 *
 * @param fixture - Параметры записи
 * @returns `MarketDiscoveryEntry` для подачи в скорер
 * @throws {Error} Если доменные инварианты рынка нарушены фикстурой
 *
 * @remarks
 * Семейство — `BINARY_OUTCOME`: скорер не смотрит ни на актив, ни на номинал
 * серии, поэтому crypto-спецификация в фикстуре была бы шумом, который читатель
 * ошибочно принял бы за значимый для порядка.
 */
function makeEntry(fixture: EntryFixture): MarketDiscoveryEntry {
  const created = Market.create({
    id: unsafeMarketId(fixture.id),
    venueId: fixture.venueId ?? KnownVenues.POLYMARKET,
    question: `Market ${fixture.id}`,
    startsAt: at(fixture.startsAtMin),
    expiresAt: at(fixture.expiresAtMin),
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${fixture.id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${fixture.id}-down`) },
    ],
    family: 'BINARY_OUTCOME',
  });
  if (!created.ok) throw new Error(`Invalid fixture market: ${created.error.message}`);

  return { market: created.value, metrics: { liquidity: usdc(fixture.liquidity) } };
}

/** Идентичность записи в виде, удобном для сравнения ожиданий. */
function identityOf(entry: MarketDiscoveryEntry): string {
  return `${entry.market.venueId}/${entry.market.id}`;
}

/** Порядок результата как список идентичностей. */
function orderOf(entries: readonly MarketDiscoveryEntry[]): string[] {
  return entries.map(identityOf);
}

describe('MarketScorer', () => {
  const scorer = new MarketScorer();

  describe('вырожденные случаи', () => {
    it('пустой вход → пустой результат', () => {
      expect(scorer.rank([])).toEqual([]);
    });

    it('одна запись возвращается той же самой (скорер её не пересобирает)', () => {
      const only = makeEntry({ id: 'solo', startsAtMin: 0, expiresAtMin: 5, liquidity: 10 });

      const ranked = scorer.rank([only]);

      expect(ranked).toHaveLength(1);
      expect(ranked[0]).toBe(only);
    });
  });

  describe('ключ 1: startsAt ASC', () => {
    it('ранний старт важнее ликвидности', () => {
      // A стартует позже, но в сто раз ликвиднее B.
      const a = makeEntry({ id: 'a', startsAtMin: 5, expiresAtMin: 10, liquidity: 100 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 10, liquidity: 1 });

      const ranked = scorer.rank([a, b]);

      expect(ranked[0]).toBe(b);
      expect(ranked[1]).toBe(a);
    });

    it('ранний старт важнее более близкого истечения', () => {
      // A истекает раньше всех, но и стартует позже: «следующий» — это B.
      const a = makeEntry({ id: 'a', startsAtMin: 5, expiresAtMin: 6, liquidity: 10 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 60, liquidity: 10 });

      expect(orderOf(scorer.rank([a, b]))).toEqual(orderOf([b, a]));
    });
  });

  describe('ranked[0] — самый ранний старт, а НЕ «ближайший предстоящий»', () => {
    // Момент оценки — опорный. `running` уже торгуется: старт 30 минут назад,
    // истечение впереди. Такие записи лежат в universe штатно — Polymarket V2
    // Discovery набирает снимок по окну `endDate`
    // [now - zombieGraceMs, now + endDateWindowMs] и по началу торгов не
    // ограничивает его вообще, так что уже идущий рынок в снимок попадает,
    // пока не истёк.
    //
    // Что вершиной оказывается ОН, а не ближайший предстоящий, — не дефект
    // скорера. Скорер отвечает на вопрос «в каком порядке», и порядок по
    // startsAt здесь абсолютный, без привязки к «сейчас». «Предстоящий»
    // задаётся ОГРАНИЧЕНИЕМ НАБОРА по моменту оценки, а набор ограничивает
    // вызывающий (subscription planner): право отбрасывать записи у скорера
    // отнято намеренно — иначе отбор смешался бы с ранжированием.
    //
    // Поэтому тест закрепляет обе стороны контракта: что даёт rank() на сыром
    // наборе и что даёт он же после ограничения набора вызывающим.
    const now = at(0);
    const running = makeEntry({
      id: 'running', startsAtMin: -30, expiresAtMin: 30, liquidity: 10,
    });
    const soon = makeEntry({ id: 'soon', startsAtMin: 5, expiresAtMin: 65, liquidity: 10 });
    const later = makeEntry({ id: 'later', startsAtMin: 60, expiresAtMin: 120, liquidity: 10 });

    it('уже начавшийся рынок встаёт впереди всех предстоящих', () => {
      const ranked = scorer.rank([later, soon, running]);

      expect(ranked[0]).toBe(running);
      expect(ranked[0].market.isStartedAt(now)).toBe(true);
      expect(orderOf(ranked)).toEqual(orderOf([running, soon, later]));
    });

    it('после ограничения набора по моменту оценки первым идёт ближайший предстоящий', () => {
      const universe = [later, soon, running];

      // Ровно тот шаг, который делает вызывающий: отсечь уже начавшиеся ДО rank().
      const upcoming = universe.filter((entry) => !entry.market.isStartedAt(now));
      const ranked = scorer.rank(upcoming);

      expect(ranked[0]).toBe(soon);
      expect(orderOf(ranked)).toEqual(orderOf([soon, later]));
      // Отбросил запись вызывающий, а не скорер: на полном наборе выхлоп полный.
      expect(scorer.rank(universe)).toHaveLength(universe.length);
    });
  });

  describe('ключ 2: expiresAt ASC', () => {
    it('при одинаковом старте первым идёт истекающий раньше', () => {
      const a = makeEntry({ id: 'a', startsAtMin: 0, expiresAtMin: 5, liquidity: 10 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 15, liquidity: 10 });

      const ranked = scorer.rank([b, a]);

      expect(ranked[0]).toBe(a);
      expect(ranked[1]).toBe(b);
    });

    it('более близкое истечение важнее ликвидности', () => {
      const a = makeEntry({ id: 'a', startsAtMin: 0, expiresAtMin: 5, liquidity: 1 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 15, liquidity: 1000 });

      expect(scorer.rank([b, a])[0]).toBe(a);
    });
  });

  describe('ключ 3: liquidity DESC', () => {
    it('при одинаковом расписании первым идёт более ликвидный', () => {
      const a = makeEntry({ id: 'a', startsAtMin: 0, expiresAtMin: 5, liquidity: 100 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 5, liquidity: 1000 });

      const ranked = scorer.rank([a, b]);

      expect(ranked[0]).toBe(b);
      expect(ranked[1]).toBe(a);
    });

    it('ликвидность важнее identity', () => {
      // 'a' < 'b' по id, но b ликвиднее — identity включается только при равенстве.
      const a = makeEntry({ id: 'a', startsAtMin: 0, expiresAtMin: 5, liquidity: 1 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 5, liquidity: 2 });

      expect(scorer.rank([a, b])[0]).toBe(b);
    });
  });

  describe('ключи 4–5: identity (venueId, затем marketId)', () => {
    /** Четыре записи с полностью одинаковым расписанием и ликвидностью. */
    function makeIdenticalSet(): readonly MarketDiscoveryEntry[] {
      const schedule = { startsAtMin: 0, expiresAtMin: 5, liquidity: 500 } as const;
      return [
        makeEntry({ ...schedule, id: 'm-1', venueId: ALPHA_VENUE }),
        makeEntry({ ...schedule, id: 'm-2', venueId: ALPHA_VENUE }),
        makeEntry({ ...schedule, id: 'm-1', venueId: BETA_VENUE }),
        makeEntry({ ...schedule, id: 'm-2', venueId: BETA_VENUE }),
      ];
    }

    const EXPECTED_IDENTITY_ORDER = [
      'ALPHA_VENUE/m-1',
      'ALPHA_VENUE/m-2',
      'BETA_VENUE/m-1',
      'BETA_VENUE/m-2',
    ];

    it('порядок детерминирован: venueId ASC, затем marketId ASC', () => {
      expect(orderOf(scorer.rank(makeIdenticalSet()))).toEqual(EXPECTED_IDENTITY_ORDER);
    });

    it('результат не зависит от порядка входа', () => {
      const forward = makeIdenticalSet();
      const reversed = [...makeIdenticalSet()].reverse();
      const source = makeIdenticalSet();
      const shuffled = [source[2], source[0], source[3], source[1]];

      expect(orderOf(scorer.rank(forward))).toEqual(EXPECTED_IDENTITY_ORDER);
      expect(orderOf(scorer.rank(reversed))).toEqual(EXPECTED_IDENTITY_ORDER);
      expect(orderOf(scorer.rank(shuffled))).toEqual(EXPECTED_IDENTITY_ORDER);
    });
  });

  describe('составной порядок целиком', () => {
    it('все пять ключей решают по одному соседнему переходу', () => {
      // A→B решает marketId, B→C — venueId, C→D — liquidity,
      // D→E — expiresAt, E→F — startsAt.
      const a = makeEntry({
        id: 'a', venueId: ALPHA_VENUE, startsAtMin: 0, expiresAtMin: 5, liquidity: 100,
      });
      const b = makeEntry({
        id: 'b', venueId: ALPHA_VENUE, startsAtMin: 0, expiresAtMin: 5, liquidity: 100,
      });
      const c = makeEntry({
        id: 'a', venueId: BETA_VENUE, startsAtMin: 0, expiresAtMin: 5, liquidity: 100,
      });
      const d = makeEntry({
        id: 'd', venueId: ALPHA_VENUE, startsAtMin: 0, expiresAtMin: 5, liquidity: 50,
      });
      const e = makeEntry({
        id: 'e', venueId: ALPHA_VENUE, startsAtMin: 0, expiresAtMin: 9, liquidity: 1000,
      });
      const f = makeEntry({
        id: 'f', venueId: ALPHA_VENUE, startsAtMin: 3, expiresAtMin: 4, liquidity: 9999,
      });

      const ranked = scorer.rank([f, d, b, e, a, c]);

      expect(ranked).toEqual([a, b, c, d, e, f]);
    });
  });

  describe('скорер — чистая функция порядка', () => {
    it('не мутирует вход: ни массив, ни его порядок', () => {
      const a = makeEntry({ id: 'a', startsAtMin: 5, expiresAtMin: 10, liquidity: 1 });
      const b = makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 10, liquidity: 1 });
      const input = [a, b];

      const ranked = scorer.rank(input);

      expect(ranked).not.toBe(input);
      expect(input).toHaveLength(2);
      expect(input[0]).toBe(a);
      expect(input[1]).toBe(b);
      // Порядок действительно изменился — иначе тест на неизменность был бы пустым.
      expect(ranked[0]).toBe(b);
    });

    it('ничего не отбрасывает: на выходе тот же набор записей', () => {
      const entries = [
        makeEntry({ id: 'a', startsAtMin: 0, expiresAtMin: 5, liquidity: 0 }),
        makeEntry({ id: 'b', startsAtMin: 90, expiresAtMin: 95, liquidity: 0 }),
        makeEntry({ id: 'c', startsAtMin: 45, expiresAtMin: 50, liquidity: 0 }),
      ];

      const ranked = scorer.rank(entries);

      expect(ranked).toHaveLength(entries.length);
      for (const entry of entries) expect(ranked).toContain(entry);
    });

    it('не проставляет score: ни записи, ни рынку, ни метрикам', () => {
      const entries = [
        makeEntry({ id: 'a', startsAtMin: 5, expiresAtMin: 10, liquidity: 100 }),
        makeEntry({ id: 'b', startsAtMin: 0, expiresAtMin: 10, liquidity: 1 }),
      ];

      const ranked = scorer.rank(entries);

      for (const entry of ranked) {
        // `in` проверяет и прототип: поле не появилось ни как собственное,
        // ни унаследованным от класса.
        expect('score' in entry).toBe(false);
        expect('score' in entry.market).toBe(false);
        expect('score' in entry.metrics).toBe(false);
        expect(Object.keys(entry).sort()).toEqual(['market', 'metrics']);
      }

      // Записи вернулись теми же объектами — дописывать score было бы просто некуда.
      expect(ranked[0]).toBe(entries[1]);
      expect(ranked[1]).toBe(entries[0]);
    });
  });
});

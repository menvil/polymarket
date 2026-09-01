/**
 * Поведенческие тесты Polymarket V2 Discovery: bounded-пагинация каталога,
 * технический gate торгуемости, классификация семейства, точное расписание
 * из события, canonical mapping, дедупликация, диагностика и last-good
 * семантика снимка.
 *
 * @remarks
 * Fake-ится ТОЛЬКО граница vendor-клиента ({@link FakeDiscoveryClient});
 * классификатор и canonical `Market` — настоящие: именно их поведение
 * и является предметом проверки.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolymarketMarketDiscovery } from '../src/index.js';
import type { PolymarketMarketDiscoveryConfig } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import {
  CONDITION_ID_BTC,
  CONDITION_ID_ETH,
  FIXED_NOW_MS,
  FakeDiscoveryClient,
  FixedClock,
  TOKEN_ID_BTC_DOWN,
  TOKEN_ID_BTC_UP,
  createCryptoThresholdMarket,
  createCryptoUpDownMarket,
  createFootballMarket,
  createPoliticsMarket,
  createSdkEvent,
  createSdkMarket,
  createWeatherMarket,
} from './helpers/gammaFixtures.js';

/** Собирает discovery поверх fake-клиента и фиксированных часов. */
function createHarness(configOverrides: PolymarketMarketDiscoveryConfig = {}): {
  client: FakeDiscoveryClient;
  clock: FixedClock;
  logger: CapturingLogger;
  discovery: PolymarketMarketDiscovery;
} {
  const client = new FakeDiscoveryClient();
  const clock = new FixedClock();
  const logger = new CapturingLogger();
  const discovery = new PolymarketMarketDiscovery({ client, clock, logger }, configOverrides);
  return { client, clock, logger, discovery };
}

/** ISO-момент через `minutes` минут от фиксированного «сейчас». */
function isoInMinutes(minutes: number): string {
  return new Date(FIXED_NOW_MS + minutes * 60_000).toISOString();
}

/** Регистрирует событие с точным началом через `minutes` минут. */
function registerEvent(
  client: FakeDiscoveryClient,
  id: string,
  startMinutes: number,
  endMinutes = 30,
): void {
  client.events.set(
    id,
    createSdkEvent({
      id,
      startTime: isoInMinutes(startMinutes),
      endDate: isoInMinutes(endMinutes),
    }),
  );
}

describe('canonical mapping: vendor Market → Domain Market (TEST 1)', () => {
  it('строит canonical Market с точным расписанием и НОМИНАЛОМ серии', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(35) })]];
    registerEvent(client, '99001', 30, 35);

    expect(await discovery.refresh()).toBe(true);
    const entries = discovery.getSnapshot().entries;

    expect(entries).toHaveLength(1);
    const market = entries[0]!.market;
    expect(String(market.venueId)).toBe('POLYMARKET');
    expect(String(market.id)).toBe(CONDITION_ID_BTC);
    expect(market.family).toBe('CRYPTO_UP_DOWN');
    expect(market.crypto?.asset).toBe('btc');
    // Номинал прочитан из слага серии (`…-5m`), фактическое окно совпадает
    expect(market.crypto?.duration).toBe(5 * 60_000);
    expect(market.duration().toNumber()).toBe(5 * 60_000);
    expect(market.state.status).toBe('ACTIVE');
    expect(market.startsAt.toNumber()).toBe(FIXED_NOW_MS + 30 * 60_000);
    expect(market.expiresAt.toNumber()).toBe(FIXED_NOW_MS + 35 * 60_000);
    expect(market.question).toBe('Bitcoin Up or Down - August 19, 8AM ET');
    expect(market.slug).toBe('bitcoin-up-or-down-august-19-8am-et');
    expect(market.outcomes).toEqual([
      { index: 0, label: 'Up', instrumentId: TOKEN_ID_BTC_UP },
      { index: 1, label: 'Down', instrumentId: TOKEN_ID_BTC_DOWN },
    ]);
  });

  it('crypto.duration — НОМИНАЛ серии, а не измеренное окно (они расходятся)', async () => {
    const { client, discovery } = createHarness();
    // Площадка сдвинула окно конкретного рынка: фактические 4 минуты
    // против номинальных 5. Именно ради этого случая номинал и читается
    // из серии: `crypto.duration === FIVE_MINUTES` у Policy обязан
    // означать «рынок 5-минутной серии», а не «окно длиной 5 минут».
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(34) })]];
    client.events.set(
      '99001',
      createSdkEvent({
        id: '99001',
        startTime: isoInMinutes(30),
        endDate: isoInMinutes(34),
        seriesSlug: 'bitcoin-up-or-down-5m',
      }),
    );

    await discovery.refresh();
    const market = discovery.getSnapshot().entries[0]!.market;

    expect(market.crypto?.duration).toBe(5 * 60_000); // номинал серии
    expect(market.duration().toNumber()).toBe(4 * 60_000); // фактическое окно
  });

  it.each([
    ['bitcoin-up-or-down-5m', 5 * 60_000],
    ['ethereum-up-or-down-15m', 15 * 60_000],
    ['solana-up-or-down-4h', 4 * 60 * 60_000],
  ])('номинал %s читается как %i мс', async (seriesSlug, expected) => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(35) })]];
    client.events.set(
      '99001',
      createSdkEvent({ id: '99001', startTime: isoInMinutes(30), seriesSlug }),
    );

    await discovery.refresh();

    expect(discovery.getSnapshot().entries[0]!.market.crypto?.duration).toBe(expected);
  });

  it('серия без числового номинала (hourly) исключает рынок, а не подставляет окно', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(35) })]];
    client.events.set(
      '99001',
      createSdkEvent({
        id: '99001',
        startTime: isoInMinutes(30),
        seriesSlug: 'bitcoin-up-or-down-hourly',
      }),
    );

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.diagnostics.invalidMarkets.seriesDuration).toBe(1);
    expect(snapshot.diagnostics.invalidMarkets.total).toBe(1);
  });

  it('событие без серии исключает рынок: номинал объявлять нечем', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(35) })]];
    client.events.set(
      '99001',
      createSdkEvent({ id: '99001', startTime: isoInMinutes(30), seriesSlug: null }),
    );

    await discovery.refresh();

    expect(discovery.getSnapshot().entries).toHaveLength(0);
    expect(discovery.getSnapshot().diagnostics.invalidMarkets.seriesDuration).toBe(1);
  });

  it('vendor-объекты НЕ являются частью публичной записи discovery', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const entry = discovery.getSnapshot().entries[0]!;

    for (const leaked of ['sdkMarket', 'gammaMarket', 'gammaEvent', 'rawMarket']) {
      expect(entry).not.toHaveProperty(leaked);
      expect(entry.market).not.toHaveProperty(leaked);
    }
    expect(Object.keys(entry).sort()).toEqual(['market', 'metrics']);
  });

  it('запись снимка и её metrics заморожены: порт не даёт менять состояние Discovery', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();
    const entry = snapshot.entries[0]!;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metrics)).toBe(true);
    expect(() => {
      (entry.metrics as { liquidity: unknown }).liquidity = null;
    }).toThrow(TypeError);
  });

  it('liquidity/spread живут в metrics, а не внутри Market', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ liquidity: '15000', spread: '0.03' })]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const entry = discovery.getSnapshot().entries[0]!;

    expect(entry.metrics.liquidity.value().toNumber()).toBe(15000);
    expect(entry.metrics.spread?.toDecimal().toNumber()).toBe(0.03);
    expect(entry.market).not.toHaveProperty('liquidity');
    expect(entry.market).not.toHaveProperty('spread');
  });

  it('отсутствующая liquidity → ноль, отсутствующий spread → undefined', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ liquidity: null, spread: null })]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const metrics = discovery.getSnapshot().entries[0]!.metrics;

    expect(metrics.liquidity.value().toNumber()).toBe(0);
    expect(metrics.spread).toBeUndefined();
  });

  it('передаёт server-side narrowing в listMarkets (closed/order/ascending/endDateMin/pageSize)', async () => {
    const { client, discovery } = createHarness({ pageSize: 100, zombieGraceMs: 2 * 60_000 });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();

    expect(client.listCalls).toHaveLength(1);
    const request = client.listCalls[0]!;
    expect(request).toMatchObject({
      closed: false,
      order: 'endDate',
      ascending: true,
      pageSize: 100,
      endDateMin: new Date(FIXED_NOW_MS - 2 * 60_000).toISOString(),
    });
    // endDateMax серверу сознательно не передаётся (аудит: HTTP 500 у Gamma)
    expect(request).not.toHaveProperty('endDateMax');
  });

  it('отбрасывает неторгуемые рынки: active=false, closed=true, enableOrderBook!=true', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, active: false }),
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, closed: true }),
        createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, enableOrderBook: false }),
        createSdkMarket({ conditionId: `0x${'d'.repeat(64)}`, enableOrderBook: null }),
        createSdkMarket({ conditionId: `0x${'e'.repeat(64)}` }),
      ],
    ];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'e'.repeat(64)}`,
    ]);
    expect(snapshot.diagnostics.tradeableMarkets).toBe(1);
    expect(snapshot.diagnostics.marketsScanned).toBe(5);
  });
});

describe('семейство: только Crypto Up/Down попадает в universe (TEST 2)', () => {
  it('чужие семейства отсекаются и НЕ запрашивают событие', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createFootballMarket({ eventRef: { id: 'evt-football' } }),
        createWeatherMarket({ eventRef: { id: 'evt-weather' } }),
        createPoliticsMarket({ eventRef: { id: 'evt-politics' } }),
        createCryptoThresholdMarket({ eventRef: { id: 'evt-threshold' } }),
        createCryptoUpDownMarket('btc', { conditionId: CONDITION_ID_BTC }),
      ],
    ];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries.map((entry) => String(entry.market.id))).toEqual([CONDITION_ID_BTC]);
    // Ключевая экономия: событие запрошено ровно у поддержанного рынка
    expect(client.fetchEventCalls).toEqual(['99001']);
    expect(snapshot.diagnostics.unsupportedMarkets).toBe(4);
    expect(snapshot.diagnostics.supportedCryptoUpDown).toBe(1);
  });

  it('крипто Yes/No без Up/Down-семантики не обогащается событием', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createCryptoThresholdMarket({ eventRef: { id: 'evt-threshold' } })]];

    await discovery.refresh();

    expect(client.fetchEventCalls).toHaveLength(0);
    expect(discovery.getSnapshot().entries).toHaveLength(0);
  });

  it('поломанный рынок нашего семейства считается invalid, обход продолжается', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'1'.repeat(64)}`, noTokenId: null }),
        createSdkMarket({ conditionId: `0x${'2'.repeat(64)}`, question: null }),
        createSdkMarket({ conditionId: `0x${'3'.repeat(64)}` }),
      ],
    ];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'3'.repeat(64)}`,
    ]);
    expect(snapshot.diagnostics.invalidMarkets.total).toBe(2);
  });
});

describe('точное расписание из события (TEST 3)', () => {
  it('startsAt берётся ИМЕННО из event.schedule.startTime', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(65) })]];
    registerEvent(client, '99001', 5, 65);

    await discovery.refresh();

    expect(discovery.getSnapshot().entries[0]!.market.startsAt.toNumber()).toBe(
      FIXED_NOW_MS + 5 * 60_000,
    );
  });

  it('событие без startTime → рынок непригоден, НИКАКОГО угаданного расписания', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(35) })]];
    client.events.set('99001', createSdkEvent({ id: '99001', startTime: null }));

    expect(await discovery.refresh()).toBe(true);
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.diagnostics.invalidMarkets.total).toBe(1);
  });

  it('startTime не парсится → рынок непригоден', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    client.events.set('99001', createSdkEvent({ id: '99001', startTime: 'not-a-date' }));

    await discovery.refresh();

    expect(discovery.getSnapshot().entries).toHaveLength(0);
  });

  it('startsAt не раньше expiresAt → рынок непригоден', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: isoInMinutes(30) })]];
    registerEvent(client, '99001', 30);

    await discovery.refresh();

    expect(discovery.getSnapshot().entries).toHaveLength(0);
  });

  it('рынок без ссылки на событие непригоден и событие не запрашивается', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ eventRef: null })]];

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(client.fetchEventCalls).toHaveLength(0);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.diagnostics.invalidMarkets.total).toBe(1);
  });

  it('eventFetchFailures считает СОБЫТИЯ и различает полный отказ обогащения', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createCryptoUpDownMarket('btc', {
          conditionId: CONDITION_ID_BTC,
          eventRef: { id: 'evt-a' },
        }),
        createCryptoUpDownMarket('eth', {
          conditionId: CONDITION_ID_ETH,
          eventRef: { id: 'evt-b' },
        }),
      ],
    ];
    client.failFetchEventIds.add('evt-a');
    client.failFetchEventIds.add('evt-b');

    // Обход каталога удался, поэтому refresh честно возвращает true —
    // именно поэтому нужен отдельный счётчик отказов обогащения
    expect(await discovery.refresh()).toBe(true);
    const d = discovery.getSnapshot().diagnostics;

    expect(discovery.getSnapshot().entries).toHaveLength(0);
    expect(d.eventFetches).toBe(2);
    expect(d.eventFetchFailures).toBe(2);
    expect(d.invalidMarkets.eventUnavailable).toBe(2);
    expect(d.invalidMarkets.total).toBe(2);
  });

  it('отказ fetchEvent исключает только рынки этого события', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [
      [
        createCryptoUpDownMarket('btc', {
          conditionId: CONDITION_ID_BTC,
          eventRef: { id: 'evt-broken' },
        }),
        createCryptoUpDownMarket('eth', {
          conditionId: CONDITION_ID_ETH,
          eventRef: { id: 'evt-ok' },
        }),
      ],
    ];
    registerEvent(client, 'evt-ok', 10);
    client.failFetchEventIds.add('evt-broken');

    expect(await discovery.refresh()).toBe(true);
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries.map((entry) => String(entry.market.id))).toEqual([CONDITION_ID_ETH]);
    expect(snapshot.diagnostics.invalidMarkets.total).toBe(1);
    expect(snapshot.diagnostics.supportedCryptoUpDown).toBe(1);
    expect(logger.byLevel('warn').some((e) => e.message.includes('fetchEvent failed'))).toBe(true);
  });

  it('regression: fallback «expiresAt − номинал серии» отсутствует в исходниках', () => {
    // Расписание рынка обязано быть подтверждено площадкой. Любая арифметика
    // вида `expiresAt - 5m/15m/1h` вернула бы выдуманное начало торгов, и
    // отличить такой рынок от честного по данным было бы уже нельзя.
    const sources = ['PolymarketMarketDiscovery.ts', 'PolymarketCryptoUpDownClassifier.ts'].map(
      (file) => readFileSync(join(__dirname, '..', 'src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
    );

    for (const code of sources) {
      expect(code).not.toMatch(/expiresAt[^\n]*-[^\n]*(?:5\s*\*\s*60|15\s*\*\s*60|60\s*\*\s*60)/);
      expect(code).not.toMatch(/fallbackMarketDuration/i);
      expect(code).not.toMatch(/DEFAULT_MARKET_DURATION/);
    }
  });
});

describe('кэш и дедупликация событий (TEST 4)', () => {
  it('несколько рынков одного события → один fetchEvent', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createCryptoUpDownMarket('btc', {
          conditionId: CONDITION_ID_BTC,
          eventRef: { id: 'evt-shared' },
        }),
        createCryptoUpDownMarket('eth', {
          conditionId: CONDITION_ID_ETH,
          eventRef: { id: 'evt-shared' },
        }),
      ],
    ];
    registerEvent(client, 'evt-shared', 10);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(client.fetchEventCalls).toEqual(['evt-shared']);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.diagnostics.eventFetches).toBe(1);
  });

  it('повторный обход внутри TTL кэша событий не ходит в сеть за расписанием', async () => {
    const { client, clock, discovery } = createHarness({ cacheTtlMs: 60_000 });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    expect(discovery.getSnapshot().diagnostics.eventFetches).toBe(1);

    clock.advance(61_000);
    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(client.listCalls).toHaveLength(2);
    expect(client.fetchEventCalls).toHaveLength(1);
    expect(snapshot.diagnostics.eventFetches).toBe(0);
    expect(snapshot.diagnostics.eventCacheHits).toBe(1);
  });

  it('после истечения TTL события расписание перезапрашивается', async () => {
    const { client, clock, discovery } = createHarness({
      cacheTtlMs: 60_000,
      eventCacheTtlMs: 120_000,
    });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    clock.advance(180_000);
    await discovery.refresh();

    expect(client.fetchEventCalls).toEqual(['99001', '99001']);
  });

  it('кэш событий ограничен по размеру', async () => {
    const { client, clock, discovery } = createHarness({
      cacheTtlMs: 0,
      eventCacheMaxEntries: 1,
    });
    client.pages = [
      [createCryptoUpDownMarket('btc', { conditionId: CONDITION_ID_BTC, eventRef: { id: 'e1' } })],
    ];
    registerEvent(client, 'e1', 10);
    registerEvent(client, 'e2', 10);
    await discovery.refresh();

    // Второй обход вытесняет e1 записью e2
    client.pages = [
      [createCryptoUpDownMarket('eth', { conditionId: CONDITION_ID_ETH, eventRef: { id: 'e2' } })],
    ];
    clock.advance(1);
    await discovery.refresh();

    // Третий обход снова просит e1 — он уже вытеснен
    client.pages = [
      [createCryptoUpDownMarket('btc', { conditionId: CONDITION_ID_BTC, eventRef: { id: 'e1' } })],
    ];
    clock.advance(1);
    await discovery.refresh();

    expect(client.fetchEventCalls).toEqual(['e1', 'e2', 'e1']);
  });
});

describe('пагинация и окно endDate (TEST 5)', () => {
  it('накапливает несколько страниц внутри окна', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: isoInMinutes(10) })],
      [createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: isoInMinutes(20) })],
      [createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: isoInMinutes(30) })],
    ];
    registerEvent(client, '99001', 5);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.diagnostics.pagesFetched).toBe(3);
  });

  it('останавливает пагинацию на первой странице за endDate cutoff', async () => {
    const { client, discovery } = createHarness({ endDateWindowMs: 60 * 60_000 });
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: isoInMinutes(30) }),
        // За cutoff (60 мин): сам рынок отфильтрован, пагинация остановлена
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: isoInMinutes(120) }),
      ],
      // Эта страница НЕ должна быть прочитана
      [createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: isoInMinutes(240) })],
    ];
    client.failAtPage = 1; // чтение второй страницы уронило бы обход
    registerEvent(client, '99001', 5);

    await discovery.refresh();

    expect(discovery.getSnapshot().entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'a'.repeat(64)}`,
    ]);
  });

  it('уважает страховочный предел maxPages', async () => {
    const { client, discovery, logger } = createHarness({ maxPages: 2 });
    client.pages = [
      [createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: isoInMinutes(5) })],
      [createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: isoInMinutes(6) })],
      [createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: isoInMinutes(7) })],
    ];
    registerEvent(client, '99001', 1);

    await discovery.refresh();

    expect(discovery.getSnapshot().entries).toHaveLength(2);
    expect(logger.byLevel('warn').some((e) => e.message.includes('maxPages'))).toBe(true);
  });

  it('фильтрует zombie-рынки с endDate в прошлом за grace-окном', async () => {
    const { client, discovery } = createHarness({ zombieGraceMs: 2 * 60_000 });
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: isoInMinutes(-10) }),
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: isoInMinutes(15) }),
      ],
    ];
    registerEvent(client, '99001', 5);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'b'.repeat(64)}`,
    ]);
    // Рынок за grace-окном не доходит даже до gate торгуемости
    expect(snapshot.diagnostics.marketsScanned).toBe(2);
    expect(snapshot.diagnostics.tradeableMarkets).toBe(1);
  });

  it('рынок без endDate не проходит окно', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ endDate: null })]];

    await discovery.refresh();

    expect(discovery.getSnapshot().entries).toHaveLength(0);
  });
});

describe('policy отказов и last-good снимок (TEST 6)', () => {
  it('отказ первой страницы сохраняет прежний снимок, refresh даёт false', async () => {
    const { client, clock, discovery, logger } = createHarness({ cacheTtlMs: 0 });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);
    expect(await discovery.refresh()).toBe(true);
    expect(discovery.getSnapshot().entries).toHaveLength(1);

    client.failAtPage = 0;
    clock.advance(1);
    expect(await discovery.refresh({ force: true })).toBe(false);

    expect(discovery.getSnapshot().entries).toHaveLength(1);
    expect(logger.byLevel('error').some((e) => e.message.includes('keeping previous'))).toBe(true);
  });

  it('отказ глубокой страницы использует частично собранный список', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [
      [createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: isoInMinutes(5) })],
      [createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: isoInMinutes(6) })],
    ];
    client.failAtPage = 1;
    registerEvent(client, '99001', 1);

    expect(await discovery.refresh()).toBe(true);

    expect(discovery.getSnapshot().entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'a'.repeat(64)}`,
    ]);
    expect(logger.byLevel('warn').some((e) => e.message.includes('partial'))).toBe(true);
  });

  it('до первого успешного обхода снимок пуст, а не отсутствует', () => {
    const { discovery } = createHarness();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.diagnostics.marketsScanned).toBe(0);
    expect(snapshot.observedAt.toNumber()).toBe(FIXED_NOW_MS);
  });
});

describe('TTL, backoff и single-flight (TEST 7)', () => {
  it('внутри TTL refresh не ходит в сеть; после TTL — обновляется', async () => {
    const { client, clock, discovery } = createHarness({ cacheTtlMs: 60_000 });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    expect(await discovery.refresh()).toBe(true);
    expect(await discovery.refresh()).toBe(true);
    expect(client.listCalls).toHaveLength(1);

    clock.advance(61_000);
    await discovery.refresh();
    expect(client.listCalls).toHaveLength(2);
  });

  it('force игнорирует свежий TTL', async () => {
    const { client, discovery } = createHarness({ cacheTtlMs: 60_000 });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    await discovery.refresh({ force: true });

    expect(client.listCalls).toHaveLength(2);
  });

  it('конкурентные refresh дедуплицируются: одна пагинация на всех', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);
    let releaseHold!: () => void;
    client.listHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const first = discovery.refresh();
    const second = discovery.refresh();
    releaseHold();
    expect(await Promise.all([first, second])).toEqual([true, true]);

    expect(client.listCalls).toHaveLength(1);
    expect(discovery.getSnapshot().entries).toHaveLength(1);
  });

  it('после неудачи авто-обновление выдерживает backoff, force — нет', async () => {
    const { client, clock, discovery } = createHarness({
      cacheTtlMs: 60_000,
      refreshFailureBackoffMs: 15_000,
    });
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);
    client.failAtPage = 0;

    expect(await discovery.refresh()).toBe(false);
    expect(client.listCalls).toHaveLength(1);

    // Немедленный повтор НЕ молотит Gamma
    expect(await discovery.refresh()).toBe(false);
    expect(client.listCalls).toHaveLength(1);

    // force backoff не учитывает — cadence принадлежит вызывающему
    await discovery.refresh({ force: true });
    expect(client.listCalls).toHaveLength(2);

    // После истечения backoff обход восстанавливается
    client.failAtPage = -1;
    clock.advance(15_001);
    expect(await discovery.refresh()).toBe(true);
    expect(client.listCalls).toHaveLength(3);
    expect(discovery.getSnapshot().entries).toHaveLength(1);
  });
});

describe('детерминированный порядок и дедупликация (TEST 8)', () => {
  it('сортирует по startsAt ASC, затем expiresAt ASC, затем id ASC', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createCryptoUpDownMarket('btc', {
          conditionId: `0x${'c'.repeat(64)}`,
          endDate: isoInMinutes(40),
          eventRef: { id: 'late' },
        }),
        createCryptoUpDownMarket('eth', {
          conditionId: `0x${'b'.repeat(64)}`,
          endDate: isoInMinutes(30),
          eventRef: { id: 'early' },
        }),
        createCryptoUpDownMarket('sol', {
          conditionId: `0x${'a'.repeat(64)}`,
          endDate: isoInMinutes(30),
          eventRef: { id: 'early' },
        }),
      ],
    ];
    registerEvent(client, 'early', 10);
    registerEvent(client, 'late', 20);

    await discovery.refresh();

    expect(discovery.getSnapshot().entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'a'.repeat(64)}`, // startsAt 10, expiresAt 30, id 0xaaa…
      `0x${'b'.repeat(64)}`, // startsAt 10, expiresAt 30, id 0xbbb…
      `0x${'c'.repeat(64)}`, // startsAt 20
    ]);
  });

  it('порядок ЛИКВИДНОСТЬЮ не определяется (это не ranking)', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createCryptoUpDownMarket('btc', {
          conditionId: `0x${'a'.repeat(64)}`,
          endDate: isoInMinutes(40),
          liquidity: '1',
          eventRef: { id: 'late' },
        }),
        createCryptoUpDownMarket('eth', {
          conditionId: `0x${'b'.repeat(64)}`,
          endDate: isoInMinutes(30),
          liquidity: '999999',
          eventRef: { id: 'early' },
        }),
      ],
    ];
    registerEvent(client, 'early', 10);
    registerEvent(client, 'late', 20);

    await discovery.refresh();

    expect(discovery.getSnapshot().entries.map((entry) => String(entry.market.id))).toEqual([
      `0x${'b'.repeat(64)}`,
      `0x${'a'.repeat(64)}`,
    ]);
  });

  it('дедуплицирует по venueId+marketId, побеждает первая запись', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({ gammaId: 'first', endDate: isoInMinutes(30) }),
        createSdkMarket({ gammaId: 'second', endDate: isoInMinutes(30) }),
      ],
    ];
    registerEvent(client, '99001', 10);

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.diagnostics.duplicateMarkets).toBe(1);
    expect(discovery.prepareMarket(snapshot.entries[0]!.market.id)?.gammaMarketId).toBe('first');
  });

  it('побеждает первая ПРИГОДНАЯ запись: дефект первой копии не теряет рынок', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        // Первая копия ссылается на событие, которого получить нельзя
        createSdkMarket({ gammaId: 'broken-copy', eventRef: { id: 'evt-broken' } }),
        createSdkMarket({ gammaId: 'good-copy', eventRef: { id: 'evt-ok' } }),
      ],
    ];
    registerEvent(client, 'evt-ok', 10);
    client.failFetchEventIds.add('evt-broken');

    await discovery.refresh();
    const snapshot = discovery.getSnapshot();

    expect(snapshot.entries).toHaveLength(1);
    expect(discovery.prepareMarket(snapshot.entries[0]!.market.id)?.gammaMarketId).toBe('good-copy');
    expect(snapshot.diagnostics.invalidMarkets.total).toBe(1);
    expect(snapshot.diagnostics.duplicateMarkets).toBe(0);
  });

  it('конфликтующий дубликат диагностируется, но обход не падает', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [
      [
        createSdkMarket({ gammaId: 'first' }),
        createSdkMarket({ gammaId: 'conflicting' }),
      ],
    ];
    registerEvent(client, '99001', 10);

    expect(await discovery.refresh()).toBe(true);

    expect(discovery.getSnapshot().entries).toHaveLength(1);
    expect(
      logger.byLevel('warn').some((e) => e.message.includes('Conflicting duplicate')),
    ).toBe(true);
  });
});

describe('диагностика обхода (TEST 9)', () => {
  it('детерминированные счётчики на смешанном наборе', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createFootballMarket({ eventRef: { id: 'evt-football' } }),
        createWeatherMarket({ eventRef: { id: 'evt-weather' } }),
        createCryptoThresholdMarket({ eventRef: { id: 'evt-threshold' } }),
        createSdkMarket({ conditionId: `0x${'1'.repeat(64)}`, noTokenId: null }),
        createCryptoUpDownMarket('btc', {
          conditionId: CONDITION_ID_BTC,
          eventRef: { id: 'evt-shared' },
        }),
        createCryptoUpDownMarket('eth', {
          conditionId: CONDITION_ID_ETH,
          eventRef: { id: 'evt-shared' },
        }),
        createSdkMarket({ conditionId: `0x${'9'.repeat(64)}`, closed: true }),
      ],
    ];
    registerEvent(client, 'evt-shared', 10);

    await discovery.refresh();
    const diagnostics = discovery.getSnapshot().diagnostics;

    expect(diagnostics).toEqual({
      pagesFetched: 1,
      marketsScanned: 7,
      tradeableMarkets: 6,
      unsupportedMarkets: 3,
      supportedCryptoUpDown: 2,
      invalidMarkets: {
        total: 1,
        classification: 1,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      },
      duplicateMarkets: 0,
      eventFetches: 1,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    });
  });

  it('инвариант: tradeable = supported + unsupported + invalid + duplicates', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createFootballMarket({ eventRef: { id: 'evt-football' } }),
        createSdkMarket({ gammaId: 'dup-a' }),
        createSdkMarket({ gammaId: 'dup-b' }),
        createSdkMarket({ conditionId: `0x${'1'.repeat(64)}`, eventRef: null }),
        createCryptoUpDownMarket('eth', {
          conditionId: CONDITION_ID_ETH,
          eventRef: { id: 'evt-eth' },
        }),
      ],
    ];
    registerEvent(client, '99001', 10);
    registerEvent(client, 'evt-eth', 10);

    await discovery.refresh();
    const d = discovery.getSnapshot().diagnostics;

    expect(
      d.supportedCryptoUpDown + d.unsupportedMarkets + d.invalidMarkets.total + d.duplicateMarkets,
    ).toBe(d.tradeableMarkets);
    expect(d.supportedCryptoUpDown).toBe(discovery.getSnapshot().entries.length);
    // Разбор причин обязан сходиться со своим же total, иначе счётчик,
    // добавленный без причины, потерялся бы молча
    const { total, ...reasons } = d.invalidMarkets;
    expect(Object.values(reasons).reduce((sum, n) => sum + n, 0)).toBe(total);
  });
});

describe('vendor-запись для физической подготовки подписок (TEST 10)', () => {
  it('prepareMarket отдаёт RTDS-фиды, settlement и typed vendor-модели без сети', async () => {
    const { client, discovery } = createHarness();
    const vendorMarket = createCryptoUpDownMarket('eth', {
      conditionId: CONDITION_ID_ETH,
      endDate: isoInMinutes(35),
      eventRef: { id: '99001', slug: 'ref-slug', title: 'Ref title' },
    });
    client.pages = [[vendorMarket]];
    const event = createSdkEvent({
      id: '99001',
      slug: 'evt-slug',
      title: 'Evt title',
      startTime: isoInMinutes(30),
      endDate: isoInMinutes(35),
    });
    client.events.set('99001', event);

    await discovery.refresh();
    const fetchCallsAfterRefresh = client.fetchEventCalls.length;
    const market = discovery.getSnapshot().entries[0]!.market;
    const vendor = discovery.prepareMarket(market.id);

    expect(client.fetchEventCalls).toHaveLength(fetchCallsAfterRefresh);
    expect(vendor).toBeDefined();
    expect(vendor!.marketId).toBe(market.id);
    expect(vendor!.eventStartsAt.toNumber()).toBe(FIXED_NOW_MS + 30 * 60_000);
    expect(vendor!.event).toEqual({ id: '99001', slug: 'evt-slug', title: 'Evt title' });
    expect(vendor!.crypto.asset).toBe('eth');
    expect(vendor!.rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'eth/usd' },
      { topic: 'prices.crypto.binance', symbol: 'ethusdt' },
      { topic: 'prices.crypto.chainlink.twap', symbol: 'eth/usd', windowSeconds: 60 },
    ]);
    expect(vendor!.crypto.settlement).toEqual({
      kind: 'chainlink-twap',
      symbol: 'eth/usd',
      windowSeconds: 60,
      resolutionSource: 'https://data.chain.link/streams/eth-usd-twap-60s-streams',
    });
    expect(vendor!.gammaMarket).toBe(vendorMarket);
    expect(vendor!.gammaEvent).toBe(event);
  });

  it('рынка нет в снимке → нет и vendor-записи', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    registerEvent(client, '99001', 10);
    await discovery.refresh();
    const known = discovery.getSnapshot().entries[0]!.market.id;

    // Следующий обход universe уже не содержит прежний рынок
    client.pages = [[]];
    await discovery.refresh({ force: true });

    expect(discovery.prepareMarket(known)).toBeUndefined();
  });
});

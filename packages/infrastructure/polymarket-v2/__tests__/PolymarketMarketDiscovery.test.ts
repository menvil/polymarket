/**
 * Поведенческие тесты Market Discovery V2: пагинация официального SDK,
 * mapping normalized Market → кандидат, selection policy (reuse
 * MarketFilter/MarketScorer), TTL-кэш, policy отказов, prepareSelected.
 *
 * @remarks
 * SDK-граница fake-ится ({@link FakeDiscoveryClient}), selection-компоненты —
 * РЕАЛЬНЫЕ `MarketFilter`/`MarketScorer` (это и есть проверяемая policy).
 */
import { describe, it, expect } from '@jest/globals';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { IMarketFilterConfig } from '@polymarket/ports';
import { PolymarketMarketDiscovery } from '../src/index.js';
import type { PolymarketMarketDiscoveryConfig } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import {
  CONDITION_ID_BTC,
  FIXED_NOW_MS,
  FakeDiscoveryClient,
  FixedClock,
  TOKEN_ID_BTC_DOWN,
  TOKEN_ID_BTC_UP,
  createSdkEvent,
  createSdkMarket,
} from './helpers/gammaFixtures.js';

/** Конфиг фильтра «пропускай всё» (селекция проверяется отдельными тестами). */
const OPEN_FILTER: IMarketFilterConfig = {
  minTimeToExpiryHours: 0,
  minSpread: 0,
  minLiquidity: 0,
  maxMarketsToReturn: 10,
};

/** Собирает discovery поверх fake SDK-клиента и фиксированных часов. */
function createHarness(configOverrides: Partial<PolymarketMarketDiscoveryConfig> = {}): {
  client: FakeDiscoveryClient;
  clock: FixedClock;
  logger: CapturingLogger;
  discovery: PolymarketMarketDiscovery;
} {
  const client = new FakeDiscoveryClient();
  const clock = new FixedClock();
  const logger = new CapturingLogger();
  const discovery = new PolymarketMarketDiscovery(
    { client, filter: new MarketFilter(), scorer: new MarketScorer(clock), clock, logger },
    { filter: OPEN_FILTER, ...configOverrides },
  );
  return { client, clock, logger, discovery };
}

/** ISO endDate через `minutes` минут от фиксированного «сейчас». */
function endDateInMinutes(minutes: number): string {
  return new Date(FIXED_NOW_MS + minutes * 60_000).toISOString();
}

describe('mapping normalized Market → кандидат (TEST 1)', () => {
  it('переносит identity, токены, timing и торговые поля из SDK Market', async () => {
    const { client, discovery } = createHarness();
    const market = createSdkMarket({ endDate: endDateInMinutes(30) });
    client.pages = [[market]];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(String(candidate.marketId)).toBe(CONDITION_ID_BTC);
    expect(String(candidate.instrumentId)).toBe(TOKEN_ID_BTC_UP);
    expect(candidate.allTokenIds).toEqual([TOKEN_ID_BTC_UP, TOKEN_ID_BTC_DOWN]);
    expect(candidate.question).toBe('Bitcoin Up or Down - August 19, 8AM ET');
    expect(candidate.expiresAt.toNumber()).toBe(FIXED_NOW_MS + 30 * 60_000);
    expect(candidate.tickSize.toNumber()).toBe(0.01);
    expect(candidate.minOrderSize.value().toNumber()).toBe(5);
    expect(candidate.minOrderValue.value().toNumber()).toBe(1);
    expect(candidate.liquidity.value().toNumber()).toBe(15000);
    expect(candidate.spread?.toDecimal().toNumber()).toBe(0.03);
    expect(candidate.active).toBe(true);
    // Typed SDK Market сохраняется той же ссылкой (initial Gamma state)
    expect(candidate.sdkMarket).toBe(market);
    // Gap N-001: у кандидатов V2 нет времени начала события
    expect(candidate.eventStartMs).toBeUndefined();
    // Legacy raw DTO не эмулируется
    expect(candidate.rawMarket).toBeUndefined();
  });

  it('передаёт server-side narrowing в listMarkets (closed/order/ascending/endDateMin/pageSize)', async () => {
    const { client, discovery } = createHarness({ pageSize: 100, zombieGraceMs: 2 * 60_000 });
    client.pages = [[createSdkMarket()]];

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
    // endDateMax серверу сознательно не передаётся (legacy-аудит: HTTP 500)
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

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates.map((c) => String(c.marketId))).toEqual([`0x${'e'.repeat(64)}`]);
  });

  it('отбрасывает рынки без обязательных полей, сохраняя остальные', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [
      [
        createSdkMarket({ conditionId: null }),
        createSdkMarket({ conditionId: `0x${'1'.repeat(64)}`, yesTokenId: null }),
        createSdkMarket({ conditionId: `0x${'2'.repeat(64)}`, question: null }),
        createSdkMarket({ conditionId: `0x${'3'.repeat(64)}`, endDate: null }),
        createSdkMarket({ conditionId: `0x${'4'.repeat(64)}` }),
      ],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates.map((c) => String(c.marketId))).toEqual([`0x${'4'.repeat(64)}`]);
    expect(logger.byLevel('warn').length).toBeGreaterThanOrEqual(1);
  });

  it('деградирует второстепенные поля до дефолтов, не отбрасывая рынок', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({
          liquidity: null,
          spread: null,
          minimumTickSize: null,
          minimumOrderSize: null,
        }),
      ],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.liquidity.value().toNumber()).toBe(0);
    expect(candidate.spread).toBeUndefined();
    expect(candidate.tickSize.toNumber()).toBe(0.01);
    expect(candidate.minOrderSize.value().toNumber()).toBe(1);
  });

  it('рынок с одним yes-токеном получает allTokenIds из одного токена (parity fallback)', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ noTokenId: null })]];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates[0]!.allTokenIds).toEqual([TOKEN_ID_BTC_UP]);
  });
});

describe('пагинация и окно endDate (TEST 2)', () => {
  it('накапливает несколько страниц внутри окна', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: endDateInMinutes(10) })],
      [createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: endDateInMinutes(20) })],
      [createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: endDateInMinutes(30) })],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates).toHaveLength(3);
  });

  it('останавливает пагинацию на первой странице за endDate cutoff', async () => {
    const { client, discovery } = createHarness({ endDateWindowMs: 60 * 60_000 });
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: endDateInMinutes(30) }),
        // За cutoff (60 мин): сам рынок отфильтрован, пагинация остановлена
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: endDateInMinutes(120) }),
      ],
      // Эта страница НЕ должна быть прочитана
      [createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: endDateInMinutes(240) })],
    ];
    client.failAtPage = 1; // чтение второй страницы уронило бы refresh

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates.map((c) => String(c.marketId))).toEqual([`0x${'a'.repeat(64)}`]);
  });

  it('уважает страховочный предел maxPages', async () => {
    const { client, discovery, logger } = createHarness({ maxPages: 2 });
    client.pages = [
      [createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: endDateInMinutes(5) })],
      [createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: endDateInMinutes(6) })],
      [createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: endDateInMinutes(7) })],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates).toHaveLength(2);
    expect(logger.byLevel('warn').some((e) => e.message.includes('maxPages'))).toBe(true);
  });

  it('фильтрует zombie-рынки с endDate в прошлом за grace-окном', async () => {
    const { client, discovery } = createHarness({ zombieGraceMs: 2 * 60_000 });
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: endDateInMinutes(-10) }),
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: endDateInMinutes(-1) }),
        createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: endDateInMinutes(15) }),
      ],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    // -10 мин — за grace-окном (zombie: отброшен окном); -1 мин — внутри
    // grace-окна пагинации, но затем отклонён expiry-фильтром MarketFilter
    // (hoursToExpiry < 0) — ровно как в legacy (REST grace + adapter filter)
    expect(candidates.map((c) => String(c.marketId))).toEqual([`0x${'c'.repeat(64)}`]);
  });
});

describe('policy отказов refresh (TEST 3)', () => {
  it('отказ первой страницы сохраняет прежний кэш', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [[createSdkMarket()]];
    await discovery.refresh();
    expect(await discovery.findCandidates()).toHaveLength(1);

    client.failAtPage = 0;
    await discovery.refresh();

    expect((await discovery.findCandidates())).toHaveLength(1);
    expect(logger.byLevel('error').some((e) => e.message.includes('keeping stale'))).toBe(true);
  });

  it('отказ глубокой страницы использует частично собранный список', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [
      [createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: endDateInMinutes(5) })],
      [createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: endDateInMinutes(6) })],
    ];
    client.failAtPage = 1;

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates.map((c) => String(c.marketId))).toEqual([`0x${'a'.repeat(64)}`]);
    expect(logger.byLevel('warn').some((e) => e.message.includes('partial'))).toBe(true);
  });
});

describe('TTL-кэш findCandidates (TEST 4)', () => {
  it('внутри TTL не ходит в Gamma повторно; после TTL — обновляется', async () => {
    const { client, clock, discovery } = createHarness({ cacheTtlMs: 60_000 });
    client.pages = [[createSdkMarket()]];

    await discovery.findCandidates(); // первый вызов — refresh (кэш пуст)
    await discovery.findCandidates(); // внутри TTL — из кэша
    expect(client.listCalls).toHaveLength(1);

    clock.advance(61_000);
    await discovery.findCandidates(); // TTL истёк — refresh
    expect(client.listCalls).toHaveLength(2);
  });

  it('конкурентные refresh дедуплицируются: одна пагинация на всех', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    let releaseHold!: () => void;
    client.listHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const first = discovery.refresh();
    const second = discovery.refresh(); // in-flight → ждёт ту же пагинацию
    const read = discovery.findCandidates(); // авто-refresh тоже разделяет её
    releaseHold();
    await Promise.all([first, second, read]);

    expect(client.listCalls).toHaveLength(1);
    expect(await discovery.findCandidates()).toHaveLength(1);
  });

  it('после неудачного refresh авто-обновление выдерживает backoff, явный refresh — нет', async () => {
    const { client, clock, discovery } = createHarness({
      cacheTtlMs: 60_000,
      refreshFailureBackoffMs: 15_000,
    });
    client.pages = [[createSdkMarket()]];
    client.failAtPage = 0;

    await discovery.findCandidates(); // попытка refresh — Gamma недоступен
    expect(client.listCalls).toHaveLength(1);

    // Немедленное повторное чтение НЕ молотит Gamma (backoff)
    await discovery.findCandidates();
    expect(client.listCalls).toHaveLength(1);

    // Явный refresh() backoff не учитывает — cadence принадлежит вызывающему
    await discovery.refresh();
    expect(client.listCalls).toHaveLength(2);

    // После истечения backoff авто-refresh пробует снова и восстанавливается
    client.failAtPage = -1;
    clock.advance(15_001);
    await discovery.findCandidates();
    expect(client.listCalls).toHaveLength(3);
    expect(await discovery.findCandidates()).toHaveLength(1);
    expect(client.listCalls).toHaveLength(3); // кэш снова свежий
  });
});

describe('selection policy: reuse MarketFilter/MarketScorer (TEST 5)', () => {
  it('применяет keywords/liquidity-фильтры и ranking по ближайшему истечению', async () => {
    const { client, discovery } = createHarness({
      filter: {
        minTimeToExpiryHours: 0,
        minSpread: 0.02,
        minLiquidity: 100,
        maxMarketsToReturn: 2,
        anyOfKeywords: ['bitcoin', 'ethereum'],
        excludedKeywords: ['testnet'],
      },
    });
    client.pages = [
      [
        createSdkMarket({
          conditionId: `0x${'a'.repeat(64)}`,
          question: 'Ethereum Up or Down - later hour',
          endDate: endDateInMinutes(60),
          liquidity: '500',
        }),
        createSdkMarket({
          conditionId: `0x${'b'.repeat(64)}`,
          question: 'Bitcoin Up or Down - nearest hour',
          endDate: endDateInMinutes(30),
          liquidity: '5000',
        }),
        createSdkMarket({
          conditionId: `0x${'c'.repeat(64)}`,
          question: 'Bitcoin testnet market',
          endDate: endDateInMinutes(40),
        }),
        createSdkMarket({
          conditionId: `0x${'d'.repeat(64)}`,
          question: 'Solana Up or Down',
          endDate: endDateInMinutes(40),
        }),
        createSdkMarket({
          conditionId: `0x${'e'.repeat(64)}`,
          question: 'Bitcoin thin market',
          endDate: endDateInMinutes(45),
          liquidity: '50',
        }),
      ],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    // b (30м) раньше a (60м); testnet/solana/thin отфильтрованы
    expect(candidates.map((c) => String(c.marketId))).toEqual([
      `0x${'b'.repeat(64)}`,
      `0x${'a'.repeat(64)}`,
    ]);
    // score проставлен скорером (hoursToExpiry)
    expect(candidates[0]!.score.toNumber()).toBeCloseTo(0.5, 5);
  });

  it('кэш держит 3× запас относительно maxMarketsToReturn', async () => {
    const { client, discovery } = createHarness({
      filter: { ...OPEN_FILTER, maxMarketsToReturn: 1 },
    });
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}`, endDate: endDateInMinutes(10) }),
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}`, endDate: endDateInMinutes(20) }),
        createSdkMarket({ conditionId: `0x${'c'.repeat(64)}`, endDate: endDateInMinutes(30) }),
        createSdkMarket({ conditionId: `0x${'d'.repeat(64)}`, endDate: endDateInMinutes(40) }),
      ],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates).toHaveLength(3); // 1 × CACHE_MULTIPLIER(3)
  });

  it('дедуплицирует кандидатов по marketId', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({ gammaId: '1', endDate: endDateInMinutes(10) }),
        createSdkMarket({ gammaId: '2', endDate: endDateInMinutes(10) }),
      ],
    ];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();

    expect(candidates).toHaveLength(1);
  });
});

describe('prepareSelected: fetchEvent только для выбранного (TEST 6)', () => {
  it('refresh НЕ вызывает fetchEvent ни для одного кандидата (нет N+1)', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({ conditionId: `0x${'a'.repeat(64)}` }),
        createSdkMarket({ conditionId: `0x${'b'.repeat(64)}` }),
      ],
    ];

    await discovery.refresh();

    expect(client.fetchEventCalls).toHaveLength(0);
  });

  it('дообогащает выбранный рынок событием: identity, точное startTime, RTDS-фиды', async () => {
    const { client, discovery } = createHarness();
    const market = createSdkMarket({
      endDate: endDateInMinutes(70),
      eventRef: { id: '99001', slug: 'ref-slug', title: 'Ref title' },
      resolutionSource: 'https://data.chain.link/streams/btc-usd',
    });
    const event = createSdkEvent({
      id: '99001',
      slug: 'evt-slug',
      title: 'Evt title',
      startTime: endDateInMinutes(10),
      endDate: endDateInMinutes(70),
      metadata: { fee: 0 },
    });
    client.pages = [[market]];
    client.events.set('99001', event);

    await discovery.refresh();
    const candidates = await discovery.findCandidates();
    const selected = await discovery.prepareSelected(candidates[0]!);

    expect(client.fetchEventCalls).toEqual(['99001']);
    expect(selected.marketId).toBe(candidates[0]!.marketId);
    expect(selected.sourceMarketId).toBe(CONDITION_ID_BTC);
    expect(selected.gammaMarketId).toBe('516789');
    expect(selected.question).toBe(candidates[0]!.question);
    expect(selected.tokenIds).toEqual([TOKEN_ID_BTC_UP, TOKEN_ID_BTC_DOWN]);
    expect(selected.outcomes).toEqual([
      { label: 'Up', tokenId: TOKEN_ID_BTC_UP },
      { label: 'Down', tokenId: TOKEN_ID_BTC_DOWN },
    ]);
    expect(selected.expiresAt.toNumber()).toBe(FIXED_NOW_MS + 70 * 60_000);
    expect(selected.eventStartsAt?.toNumber()).toBe(FIXED_NOW_MS + 10 * 60_000);
    expect(selected.event).toEqual({ id: '99001', slug: 'evt-slug', title: 'Evt title' });
    expect(selected.crypto?.source).toBe('chainlink');
    expect(selected.crypto?.binanceSymbol).toBe('BTCUSDT');
    expect(selected.rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
    ]);
    expect(selected.gammaMarket).toBe(market);
    expect(selected.gammaEvent).toBe(event);
  });

  it('отказ fetchEvent деградирует до выбора без event-данных (warn, не исключение)', async () => {
    const { client, discovery, logger } = createHarness();
    client.pages = [[createSdkMarket()]];
    client.fetchEventError = new Error('gamma event 500');

    await discovery.refresh();
    const candidates = await discovery.findCandidates();
    const selected = await discovery.prepareSelected(candidates[0]!);

    expect(selected.eventStartsAt).toBeUndefined();
    expect(selected.gammaEvent).toBeUndefined();
    // Identity события сохраняется из reference рынка
    expect(selected.event?.id).toBe('99001');
    expect(logger.byLevel('warn').some((e) => e.message.includes('fetchEvent'))).toBe(true);
  });

  it('рынок без event-ссылки готовится без fetchEvent', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket({ eventRef: null, resolutionSource: null })]];

    await discovery.refresh();
    const candidates = await discovery.findCandidates();
    const selected = await discovery.prepareSelected(candidates[0]!);

    expect(client.fetchEventCalls).toHaveLength(0);
    expect(selected.event).toBeUndefined();
    expect(selected.eventStartsAt).toBeUndefined();
    expect(selected.crypto).toBeUndefined();
    expect(selected.rtdsFeeds).toEqual([]);
  });

  it('TWAP-форма Chainlink URL (текущие 5m/15m-серии) даёт те же RTDS-фиды', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({
          resolutionSource: 'https://data.chain.link/streams/eth-usd-twap-60s-streams',
        }),
      ],
    ];
    client.events.set('99001', createSdkEvent({ id: '99001' }));

    await discovery.refresh();
    const candidates = await discovery.findCandidates();
    const selected = await discovery.prepareSelected(candidates[0]!);

    expect(selected.crypto?.source).toBe('chainlink');
    expect(selected.crypto?.binanceSymbol).toBe('ETHUSDT');
    expect(selected.rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'eth/usd' },
      { topic: 'prices.crypto.binance', symbol: 'ethusdt' },
    ]);
  });

  it('неподдержанная пара TWAP-URL (нет Binance-маппинга) не даёт фидов', async () => {
    const { client, discovery } = createHarness();
    client.pages = [
      [
        createSdkMarket({
          resolutionSource: 'https://data.chain.link/streams/hype-usd-twap-60s-streams',
        }),
      ],
    ];
    client.events.set('99001', createSdkEvent({ id: '99001' }));

    await discovery.refresh();
    const candidates = await discovery.findCandidates();
    const selected = await discovery.prepareSelected(candidates[0]!);

    expect(selected.crypto).toBeUndefined();
    expect(selected.rtdsFeeds).toEqual([]);
  });

  it('событие без startTime даёт eventStartsAt=undefined (fallback решает координатор)', async () => {
    const { client, discovery } = createHarness();
    client.pages = [[createSdkMarket()]];
    client.events.set('99001', createSdkEvent({ id: '99001', startTime: null }));

    await discovery.refresh();
    const candidates = await discovery.findCandidates();
    const selected = await discovery.prepareSelected(candidates[0]!);

    expect(selected.eventStartsAt).toBeUndefined();
    expect(selected.gammaEvent).toBeDefined();
  });
});

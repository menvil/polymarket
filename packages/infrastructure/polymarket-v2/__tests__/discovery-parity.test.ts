/**
 * Parity-тесты Discovery V2 против legacy behavior oracle (PART 33).
 *
 * @remarks
 * Один и тот же логический набор рынков подаётся в:
 *
 * - LEGACY: `PolymarketMarketDiscoveryAdapter` (raw `GammaMarketDto`,
 *   custom REST-клиент за fake) — production-поведение старого коллектора;
 * - V2: `PolymarketMarketDiscovery` (normalized SDK `Market`, официальный
 *   client за fake).
 *
 * При одинаковой логической конфигурации проверяется ИДЕНТИЧНОЕ selection
 * behavior: eligible/not eligible, keywords, expiry, дедупликация, ranking,
 * идентичность рынка/токенов, RTDS-маппинг. Цель — same market selection,
 * а не byte-equal внутренние объекты.
 *
 * Legacy-код импортируется прямыми путями соседнего пакета СОЗНАТЕЛЬНО:
 * это тестовая ссылка на неизменяемый behavior oracle (N-003 PART 45 —
 * legacy не трогаем), а публичный индекс `@polymarket/exchange/adapters`
 * тянет тяжёлые WS/CLOB-зависимости, ненужные оракулу селекции.
 */
import { describe, it, expect } from '@jest/globals';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { IMarketFilterConfig } from '@polymarket/ports';
import type { Market } from '@polymarket/bindings/gamma';
import { PolymarketMarketDiscoveryAdapter } from '../../polymarket/adapters/PolymarketMarketDiscoveryAdapter.js';
import { parseCryptoMeta } from '../../polymarket/adapters/CryptoMarketMeta.js';
import type {
  GammaMarketDto,
  PolymarketMarketDataRestClient,
} from '../../polymarket/rest/clients/PolymarketMarketDataRestClient.js';
import { PolymarketMarketDiscovery, derivePolymarketCryptoMeta } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import { FakeDiscoveryClient, FixedClock, createSdkMarket } from './helpers/gammaFixtures.js';

/**
 * Baseline «сейчас» parity-тестов — РЕАЛЬНОЕ время запуска.
 *
 * @remarks
 * Legacy behavior oracle внутри использует `Date.now()` (время не
 * инъецируется в старый adapter), поэтому фикстуры строятся от реального
 * запуска; V2 получает те же миллисекунды через `FixedClock`. Смещения
 * фикстур минутные — субсекундный дрейф между захватом baseline и
 * `Date.now()` внутри legacy не влияет на исходы.
 */
const PARITY_NOW_MS = Date.now();

/**
 * Логические параметры одного рынка, из которых строятся ОБА представления:
 * legacy raw DTO и normalized SDK Market.
 */
interface TwinOptions {
  readonly conditionId: string;
  readonly question: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  /** Минуты до истечения от FIXED_NOW_MS (может быть отрицательным). */
  readonly expiresInMinutes: number;
  readonly liquidity?: string;
  /** Спред как число (legacy DTO) — V2 получает его DecimalString-ом. */
  readonly spread?: number;
  readonly active?: boolean;
  readonly closed?: boolean;
  readonly enableOrderBook?: boolean;
  readonly resolutionSource?: string;
  /** Минуты до начала события (legacy `eventStartTime`). */
  readonly eventStartsInMinutes?: number;
}

/** Строит пару представлений одного логического рынка. */
function createTwin(options: TwinOptions): { dto: GammaMarketDto; sdk: Market } {
  const endDate = new Date(PARITY_NOW_MS + options.expiresInMinutes * 60_000).toISOString();
  const eventStartTime =
    options.eventStartsInMinutes !== undefined
      ? new Date(PARITY_NOW_MS + options.eventStartsInMinutes * 60_000).toISOString()
      : undefined;

  const dto: GammaMarketDto = {
    conditionId: options.conditionId,
    question: options.question,
    slug: `slug-${options.conditionId.slice(2, 8)}`,
    clobTokenIds: JSON.stringify([options.yesTokenId, options.noTokenId]),
    outcomes: '["Up","Down"]',
    active: options.active ?? true,
    closed: options.closed ?? false,
    enableOrderBook: options.enableOrderBook ?? true,
    endDate,
    liquidity: options.liquidity ?? '15000',
    ...(options.spread !== undefined ? { spread: options.spread } : {}),
    orderPriceMinTickSize: 0.01,
    orderMinSize: 5,
    ...(options.resolutionSource !== undefined
      ? { resolutionSource: options.resolutionSource }
      : {}),
    ...(eventStartTime !== undefined ? { eventStartTime } : {}),
  };

  const sdk = createSdkMarket({
    gammaId: `9${options.conditionId.slice(2, 7)}`,
    conditionId: options.conditionId,
    question: options.question,
    yesTokenId: options.yesTokenId,
    noTokenId: options.noTokenId,
    endDate,
    liquidity: options.liquidity ?? '15000',
    spread: options.spread !== undefined ? String(options.spread) : null,
    minimumTickSize: 0.01,
    minimumOrderSize: '5',
    active: options.active ?? true,
    closed: options.closed ?? false,
    enableOrderBook: options.enableOrderBook ?? true,
    resolutionSource: options.resolutionSource ?? null,
  });

  return { dto, sdk };
}

/** Одинаковая логическая конфигурация селекции для обеих реализаций. */
const PARITY_CONFIG: IMarketFilterConfig = {
  minTimeToExpiryHours: 0,
  minSpread: 0.02,
  minLiquidity: 100,
  maxMarketsToReturn: 3,
  anyOfKeywords: ['bitcoin', 'ethereum'],
  excludedKeywords: ['testnet'],
};

/** Пропускает набор twin-рынков через LEGACY и V2, возвращая selection-порядки. */
async function runBothPaths(twins: ReadonlyArray<{ dto: GammaMarketDto; sdk: Market }>): Promise<{
  legacyOrder: string[];
  v2Order: string[];
  legacyCandidates: Awaited<ReturnType<PolymarketMarketDiscoveryAdapter['findCandidates']>>;
  v2Candidates: Awaited<ReturnType<PolymarketMarketDiscovery['findCandidates']>>;
}> {
  const clock = new FixedClock(PARITY_NOW_MS);
  const logger = new CapturingLogger();

  const legacyRestClient = {
    getActiveMarkets: async (): Promise<GammaMarketDto[]> => twins.map((twin) => twin.dto),
  } as unknown as PolymarketMarketDataRestClient;
  const legacy = new PolymarketMarketDiscoveryAdapter(
    legacyRestClient,
    new MarketFilter(),
    new MarketScorer(clock),
    PARITY_CONFIG,
    logger,
  );

  const client = new FakeDiscoveryClient();
  client.pages = [twins.map((twin) => twin.sdk)];
  const v2 = new PolymarketMarketDiscovery(
    { client, filter: new MarketFilter(), scorer: new MarketScorer(clock), clock, logger },
    { filter: PARITY_CONFIG },
  );

  await legacy.refresh();
  await v2.refresh();
  const legacyCandidates = await legacy.findCandidates();
  const v2Candidates = await v2.findCandidates();

  return {
    legacyOrder: legacyCandidates.map((c) => String(c.marketId)),
    v2Order: v2Candidates.map((c) => String(c.marketId)),
    legacyCandidates,
    v2Candidates,
  };
}

/** 64-hex conditionId из односимвольного паттерна. */
function cid(char: string): string {
  return `0x${char.repeat(64)}`;
}

const TOKEN_A = '11111111111111111111111111111111111111111111111111111111111111111111111111111';
const TOKEN_B = '22222222222222222222222222222222222222222222222222222222222222222222222222222';

describe('LEGACY vs V2: same market selection behavior (PART 33)', () => {
  it('идентичный eligible/ranking-порядок на представительном наборе рынков', async () => {
    const twins = [
      // eligible: bitcoin, истекает через 60 мин
      createTwin({
        conditionId: cid('a'),
        question: 'Ethereum Up or Down - later hour',
        yesTokenId: `1${TOKEN_A}`,
        noTokenId: `1${TOKEN_B}`,
        expiresInMinutes: 60,
        spread: 0.05,
      }),
      // eligible: ближайшее истечение — должен стать первым
      createTwin({
        conditionId: cid('b'),
        question: 'Bitcoin Up or Down - nearest hour',
        yesTokenId: `2${TOKEN_A}`,
        noTokenId: `2${TOKEN_B}`,
        expiresInMinutes: 30,
        spread: 0.03,
      }),
      // rejected: excluded keyword
      createTwin({
        conditionId: cid('c'),
        question: 'Bitcoin testnet experiment',
        yesTokenId: `3${TOKEN_A}`,
        noTokenId: `3${TOKEN_B}`,
        expiresInMinutes: 40,
      }),
      // rejected: не проходит anyOfKeywords
      createTwin({
        conditionId: cid('d'),
        question: 'Solana Up or Down',
        yesTokenId: `4${TOKEN_A}`,
        noTokenId: `4${TOKEN_B}`,
        expiresInMinutes: 40,
      }),
      // rejected: ликвидность ниже порога
      createTwin({
        conditionId: cid('e'),
        question: 'Bitcoin thin market',
        yesTokenId: `5${TOKEN_A}`,
        noTokenId: `5${TOKEN_B}`,
        expiresInMinutes: 45,
        liquidity: '50',
      }),
      // rejected: уже истёк (legacy — фильтром expiry, V2 — окном endDate)
      createTwin({
        conditionId: cid('f'),
        question: 'Bitcoin expired market',
        yesTokenId: `6${TOKEN_A}`,
        noTokenId: `6${TOKEN_B}`,
        expiresInMinutes: -10,
      }),
      // rejected: закрыт
      createTwin({
        conditionId: cid('1'),
        question: 'Bitcoin closed market',
        yesTokenId: `7${TOKEN_A}`,
        noTokenId: `7${TOKEN_B}`,
        expiresInMinutes: 50,
        closed: true,
      }),
      // rejected: стакан выключен
      createTwin({
        conditionId: cid('2'),
        question: 'Bitcoin no orderbook',
        yesTokenId: `8${TOKEN_A}`,
        noTokenId: `8${TOKEN_B}`,
        expiresInMinutes: 50,
        enableOrderBook: false,
      }),
      // eligible: spread отсутствует — фильтр спреда пропускает (нет данных)
      createTwin({
        conditionId: cid('3'),
        question: 'Bitcoin no spread data',
        yesTokenId: `9${TOKEN_A}`,
        noTokenId: `9${TOKEN_B}`,
        expiresInMinutes: 45,
      }),
    ];

    const { legacyOrder, v2Order } = await runBothPaths(twins);

    expect(legacyOrder).toEqual([cid('b'), cid('3'), cid('a')]);
    expect(v2Order).toEqual(legacyOrder);
  });

  it('идентичная дедупликация по conditionId (последний дубликат побеждает)', async () => {
    const twins = [
      createTwin({
        conditionId: cid('a'),
        question: 'Bitcoin Up or Down - first copy',
        yesTokenId: `1${TOKEN_A}`,
        noTokenId: `1${TOKEN_B}`,
        expiresInMinutes: 30,
      }),
      createTwin({
        conditionId: cid('a'),
        question: 'Bitcoin Up or Down - second copy',
        yesTokenId: `2${TOKEN_A}`,
        noTokenId: `2${TOKEN_B}`,
        expiresInMinutes: 30,
      }),
    ];

    const { legacyOrder, v2Order, legacyCandidates, v2Candidates } = await runBothPaths(twins);

    expect(legacyOrder).toEqual([cid('a')]);
    expect(v2Order).toEqual(legacyOrder);
    expect(legacyCandidates[0]!.question).toBe('Bitcoin Up or Down - second copy');
    expect(v2Candidates[0]!.question).toBe(legacyCandidates[0]!.question);
  });

  it('идентичный mapping идентичности рынка: id, токены, timing, торговые поля', async () => {
    const twins = [
      createTwin({
        conditionId: cid('a'),
        question: 'Bitcoin Up or Down - mapping check',
        yesTokenId: `1${TOKEN_A}`,
        noTokenId: `1${TOKEN_B}`,
        expiresInMinutes: 30,
        liquidity: '7000',
        spread: 0.04,
      }),
    ];

    const { legacyCandidates, v2Candidates } = await runBothPaths(twins);
    const legacyCandidate = legacyCandidates[0]!;
    const v2Candidate = v2Candidates[0]!;

    expect(String(v2Candidate.marketId)).toBe(String(legacyCandidate.marketId));
    expect(String(v2Candidate.instrumentId)).toBe(String(legacyCandidate.instrumentId));
    expect(v2Candidate.allTokenIds).toEqual(legacyCandidate.allTokenIds);
    expect(v2Candidate.question).toBe(legacyCandidate.question);
    expect(v2Candidate.expiresAt.toNumber()).toBe(legacyCandidate.expiresAt.toNumber());
    expect(v2Candidate.tickSize.toNumber()).toBe(legacyCandidate.tickSize.toNumber());
    expect(v2Candidate.minOrderSize.value().toNumber()).toBe(
      legacyCandidate.minOrderSize.value().toNumber(),
    );
    expect(v2Candidate.liquidity.value().toNumber()).toBe(
      legacyCandidate.liquidity.value().toNumber(),
    );
    expect(v2Candidate.spread?.toDecimal().toNumber()).toBe(
      legacyCandidate.spread?.toDecimal().toNumber(),
    );
    expect(v2Candidate.score.toNumber()).toBe(legacyCandidate.score.toNumber());
  });

  it('ДОКУМЕНТИРОВАННОЕ отличие: у V2-кандидатов нет eventStartMs (gap N-001)', async () => {
    const twins = [
      createTwin({
        conditionId: cid('a'),
        question: 'Bitcoin Up or Down - with event start',
        yesTokenId: `1${TOKEN_A}`,
        noTokenId: `1${TOKEN_B}`,
        expiresInMinutes: 60,
        eventStartsInMinutes: 10,
      }),
    ];

    const { legacyCandidates, v2Candidates } = await runBothPaths(twins);

    // Legacy получал eventStartTime из raw DTO на стадии кандидата
    expect(legacyCandidates[0]!.eventStartMs?.toNumber()).toBe(PARITY_NOW_MS + 10 * 60_000);
    // Normalized SDK Market это поле не несёт: точное время начала события
    // V2 получает через prepareSelected() → fetchEvent(selected only)
    expect(v2Candidates[0]!.eventStartMs).toBeUndefined();
  });
});

describe('LEGACY vs V2: RTDS-маппинг крипто-рынков (PART 33/PART 17)', () => {
  /** Legacy wire-topic → vendor topic официального SDK. */
  const TOPIC_TRANSLATION: Record<string, string> = {
    crypto_prices: 'prices.crypto.binance',
    crypto_prices_chainlink: 'prices.crypto.chainlink',
  };

  it.each([
    ['chainlink', 'https://data.chain.link/streams/btc-usd'],
    ['binance', 'https://www.binance.com/en/trade/BTC_USDT'],
    ['chainlink eth', 'https://data.chain.link/streams/eth-usd'],
  ])('одинаковые фиды (source %s) с переводом vendor topic', async (_label, resolutionSource) => {
    const twin = createTwin({
      conditionId: cid('a'),
      question: 'Bitcoin Up or Down - crypto',
      yesTokenId: `1${TOKEN_A}`,
      noTokenId: `1${TOKEN_B}`,
      expiresInMinutes: 30,
      resolutionSource,
      eventStartsInMinutes: -30, // событие уже идёт — legacy требует eventStartTime
    });

    const legacyMeta = parseCryptoMeta(twin.dto as unknown as Record<string, unknown>);
    const v2Meta = derivePolymarketCryptoMeta(twin.sdk);

    expect(legacyMeta).toBeDefined();
    expect(v2Meta).toBeDefined();
    expect(v2Meta!.source).toBe(legacyMeta!.source);
    expect(v2Meta!.binanceSymbol).toBe(legacyMeta!.binanceSymbol);

    const translatedLegacyFeeds = legacyMeta!.rtdsSubscriptions.map((subscription) => ({
      topic: TOPIC_TRANSLATION[subscription.topic],
      symbol: subscription.filter,
    }));
    expect([...v2Meta!.feeds]).toEqual(translatedLegacyFeeds);
  });

  it('не-крипто рынок: обе реализации не дают RTDS-фидов', async () => {
    const twin = createTwin({
      conditionId: cid('a'),
      question: 'Bitcoin political market',
      yesTokenId: `1${TOKEN_A}`,
      noTokenId: `1${TOKEN_B}`,
      expiresInMinutes: 30,
    });

    expect(parseCryptoMeta(twin.dto as unknown as Record<string, unknown>)).toBeUndefined();
    expect(derivePolymarketCryptoMeta(twin.sdk)).toBeUndefined();
  });

  it('ДОКУМЕНТИРОВАННОЕ отличие: V2 парсит TWAP-форму Chainlink URL текущих 5m/15m-серий', () => {
    // Текущие крипто-серии Polymarket используют
    // .../streams/btc-usd-twap-60s-streams — legacy-регекс такие URL не
    // парсил, и старый коллектор записывал эти рынки БЕЗ RTDS-цен.
    const twin = createTwin({
      conditionId: cid('a'),
      question: 'Bitcoin Up or Down - twap series',
      yesTokenId: `1${TOKEN_A}`,
      noTokenId: `1${TOKEN_B}`,
      expiresInMinutes: 30,
      resolutionSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
      eventStartsInMinutes: -30,
    });

    expect(parseCryptoMeta(twin.dto as unknown as Record<string, unknown>)).toBeUndefined();
    const v2Meta = derivePolymarketCryptoMeta(twin.sdk);
    expect(v2Meta).toBeDefined();
    expect(v2Meta!.source).toBe('chainlink');
    // Canonical базовый актив выводится на той же границе (вход N-004)
    expect(v2Meta!.asset).toBe('btc');
    expect(v2Meta!.binanceSymbol).toBe('BTCUSDT');
    expect([...v2Meta!.feeds]).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
    ]);
  });

  it('ДОКУМЕНТИРОВАННОЕ отличие: V2 выводит фиды без eventStartTime', () => {
    // Legacy parseCryptoMeta требовал eventStartTime/endDate для klines-математики
    // и возвращал undefined без них; V2-выводу нужен только resolution.source.
    const twin = createTwin({
      conditionId: cid('a'),
      question: 'Bitcoin Up or Down - no event start',
      yesTokenId: `1${TOKEN_A}`,
      noTokenId: `1${TOKEN_B}`,
      expiresInMinutes: 30,
      resolutionSource: 'https://data.chain.link/streams/btc-usd',
      // eventStartsInMinutes сознательно не задан
    });

    expect(parseCryptoMeta(twin.dto as unknown as Record<string, unknown>)).toBeUndefined();
    expect(derivePolymarketCryptoMeta(twin.sdk)).toBeDefined();
  });
});

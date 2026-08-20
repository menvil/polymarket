/**
 * Fixtures normalized Gamma-моделей официального SDK для тестов Discovery V2.
 *
 * @remarks
 * Формы объектов 1:1 повторяют typed-модели `@polymarket/bindings/gamma`
 * (`Market`, `Event`) установленной версии 0.6.0 — проверено по `.d.ts` и по
 * live smoke N-003, печатающему реальный selected market.
 *
 * ### Почему `as` вместо запуска реальных схем
 *
 * Та же причина, что у `sdkFixtures.ts`: branded-типы SDK (`MarketId`,
 * `ConditionId`, `TokenId`, `DecimalString`, `IsoDateTimeString`)
 * конструируются только его zod-схемами, а `@polymarket/bindings` — чистый
 * ESM, который нельзя импортировать в runtime под CJS-jest. Fixtures
 * построены полными литералами формы normalized-моделей и приводятся ОДНИМ
 * `as unknown as` к SDK-типу; runtime-парс реальных схем выполняет live
 * smoke (tsx, ESM).
 */
import type { IClock } from '@polymarket/time';
import type { Event, Market } from '@polymarket/bindings/gamma';
import type { PolymarketDiscoveryClient } from '../../src/index.js';

/** Реалистичный conditionId (0x + 64 hex). */
export const CONDITION_ID_BTC =
  '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af';

/** Реалистичные CLOB token ids (decimal-строки ERC-1155). */
export const TOKEN_ID_BTC_UP =
  '65818619657568813474341868652308942079804919287380422192892211131408793125422';
export const TOKEN_ID_BTC_DOWN =
  '71321045679252212594626385532706912750332728571942532289631379312455583992563';

/** Фиксированное «сейчас» всех discovery-тестов (2026-08-19T12:00:00Z). */
export const FIXED_NOW_MS = Date.parse('2026-08-19T12:00:00.000Z');

/**
 * Управляемые часы для детерминированных тестов discovery.
 */
export class FixedClock implements IClock {
  constructor(private _nowMs: number = FIXED_NOW_MS) {}

  public now(): Date {
    return new Date(this._nowMs);
  }

  /** Сдвигает время вперёд на `deltaMs`. */
  public advance(deltaMs: number): void {
    this._nowMs += deltaMs;
  }
}

/**
 * Параметры билдера normalized SDK Market.
 */
export interface SdkMarketFixtureOptions {
  readonly gammaId?: string;
  readonly conditionId?: string | null;
  readonly question?: string | null;
  readonly slug?: string | null;
  readonly yesTokenId?: string | null;
  readonly noTokenId?: string | null;
  readonly yesLabel?: string;
  readonly noLabel?: string;
  readonly active?: boolean | null;
  readonly closed?: boolean | null;
  readonly enableOrderBook?: boolean | null;
  /** ISO endDate; `null` — рынок без даты истечения. */
  readonly endDate?: string | null;
  readonly startDate?: string | null;
  readonly liquidity?: string | null;
  /** DecimalString спреда; `null` — Gamma не вернул поле. */
  readonly spread?: string | null;
  readonly minimumTickSize?: number | null;
  readonly minimumOrderSize?: string | null;
  readonly resolutionSource?: string | null;
  /** Ссылка на событие Gamma (events[0]); `null` — рынок без события. */
  readonly eventRef?: { id: string; slug?: string | null; title?: string | null } | null;
}

/**
 * Создаёт normalized SDK Market в форме модели `@polymarket/bindings/gamma`.
 *
 * @param options - Переопределения полей (дефолт — eligible BTC-рынок,
 *   истекающий через 30 минут от {@link FIXED_NOW_MS})
 * @returns Объект, удовлетворяющий типу `Market` официального SDK
 */
export function createSdkMarket(options: SdkMarketFixtureOptions = {}): Market {
  const {
    gammaId = '516789',
    conditionId = CONDITION_ID_BTC,
    question = 'Bitcoin Up or Down - August 19, 8AM ET',
    slug = 'bitcoin-up-or-down-august-19-8am-et',
    yesTokenId = TOKEN_ID_BTC_UP,
    noTokenId = TOKEN_ID_BTC_DOWN,
    yesLabel = 'Up',
    noLabel = 'Down',
    active = true,
    closed = false,
    enableOrderBook = true,
    endDate = new Date(FIXED_NOW_MS + 30 * 60_000).toISOString(),
    startDate = new Date(FIXED_NOW_MS - 6 * 60 * 60_000).toISOString(),
    liquidity = '15000',
    spread = '0.03',
    minimumTickSize = 0.01,
    minimumOrderSize = '5',
    resolutionSource = 'https://data.chain.link/streams/btc-usd',
    eventRef = { id: '99001', slug: 'bitcoin-up-or-down-august-19', title: 'Bitcoin Up or Down' },
  } = options;

  const market = {
    id: gammaId,
    slug,
    conditionId,
    question,
    groupItemTitle: null,
    description: 'Resolves according to the source.',
    category: 'Crypto',
    image: null,
    icon: null,
    state: {
      active,
      closed,
      archived: false,
      acceptingOrders: active,
      enableOrderBook,
      negRisk: false,
      startDate,
      endDate,
      closedTime: null,
    },
    outcomes: {
      yes: { label: yesLabel, tokenId: yesTokenId, positionId: null, price: '0.5' },
      no: { label: noLabel, tokenId: noTokenId, positionId: null, price: '0.5' },
    },
    metrics: {
      volume: '120000',
      volumeNum: '120000',
      liquidity,
      liquidityNum: liquidity,
    },
    prices: {
      bestBid: '0.49',
      bestAsk: '0.52',
      lastTradePrice: '0.5',
      spread,
    },
    trading: {
      minimumOrderSize,
      minimumTickSize,
      secondsDelay: 0,
      feesEnabled: false,
      feeType: null,
      feeSchedule: null,
    },
    resolution: {
      questionId: null,
      negRiskRequestId: null,
      umaResolutionStatus: null,
      source: resolutionSource,
      resolvedBy: null,
    },
    rewards: {
      clobRewards: null,
      rewardsMinSize: null,
      rewardsMaxSpread: null,
      holdingRewardsEnabled: null,
    },
    sports: {
      sportsMarketType: null,
      line: null,
      gameId: null,
      gameStartTime: null,
    },
    events: eventRef === null ? [] : [{ id: eventRef.id, slug: eventRef.slug ?? null, title: eventRef.title ?? null }],
    tags: [],
    positionIds: [],
  };
  return market as unknown as Market;
}

/**
 * Параметры билдера normalized SDK Event.
 */
export interface SdkEventFixtureOptions {
  readonly id?: string;
  readonly slug?: string | null;
  readonly title?: string | null;
  /** ISO точного времени начала события (schedule.startTime). */
  readonly startTime?: string | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  /** eventMetadata Gamma (priceToBeat/finalPrice появляются в N-004). */
  readonly metadata?: Record<string, unknown> | null;
  /** Вложенные normalized markets события. */
  readonly markets?: readonly Market[];
}

/**
 * Создаёт normalized SDK Event в форме модели `@polymarket/bindings/gamma`.
 *
 * @param options - Переопределения полей (дефолт — событие часового
 *   BTC-рынка, начинающееся через 10 минут от {@link FIXED_NOW_MS})
 * @returns Объект, удовлетворяющий типу `Event` официального SDK
 */
export function createSdkEvent(options: SdkEventFixtureOptions = {}): Event {
  const {
    id = '99001',
    slug = 'bitcoin-up-or-down-august-19',
    title = 'Bitcoin Up or Down',
    startTime = new Date(FIXED_NOW_MS + 10 * 60_000).toISOString(),
    startDate = new Date(FIXED_NOW_MS - 6 * 60 * 60_000).toISOString(),
    endDate = new Date(FIXED_NOW_MS + 30 * 60_000).toISOString(),
    metadata = null,
    markets = [],
  } = options;

  const event = {
    id,
    parentEventId: null,
    ticker: slug,
    slug,
    title,
    subtitle: null,
    description: null,
    category: 'Crypto',
    subcategory: null,
    image: null,
    icon: null,
    featuredImage: null,
    createdAt: null,
    updatedAt: null,
    publishedAt: null,
    state: {
      active: true,
      closed: false,
      archived: false,
      new: null,
      featured: null,
      restricted: null,
      cyom: null,
      live: null,
      ended: false,
      automaticallyActive: null,
      commentsEnabled: null,
      requiresTranslation: null,
    },
    schedule: {
      startDate,
      creationDate: null,
      endDate,
      closedTime: null,
      startTime,
      eventDate: null,
      eventWeek: null,
      finishedAt: null,
    },
    metrics: {},
    display: {},
    trading: {},
    resolution: { source: null, automaticallyResolved: null },
    estimation: {},
    sports: { bestLines: [], teams: [], sport: null },
    partners: [],
    metadata,
    markets: [...markets],
    series: [],
    tags: [],
    creators: [],
  };
  return event as unknown as Event;
}

/** Записанный вызов listMarkets (plain-форма request для ассертов). */
export type RecordedListMarketsRequest = Record<string, unknown> | undefined;

/**
 * Fake официального SDK-клиента для Discovery V2.
 *
 * @remarks
 * Реализует `PolymarketDiscoveryClient` (= `Pick<PublicClient,
 * 'listMarkets' | 'fetchEvent'>`). `listMarkets` возвращает `Paginated`,
 * итерирующий заранее заданные страницы; `from()`/`firstPage()` реализованы
 * структурно. Request/response-типы SDK не экспортируются с public root,
 * поэтому реализация приводится ОДНИМ документированным `as unknown as`
 * к типу порта (тот же unavoidable-upstream-typing приём, что в
 * `FakePolymarketClient`).
 */
export class FakeDiscoveryClient implements PolymarketDiscoveryClient {
  /** Страницы, которые вернёт следующий listMarkets (массив batch-ей). */
  public pages: Market[][] = [];
  /** Если задан — чтение первой страницы ждёт этот promise (медленный Gamma). */
  public listHold: Promise<void> | undefined;
  /** Индекс страницы (0-based), чтение которой бросит ошибку; -1 — без ошибок. */
  public failAtPage = -1;
  /** Ошибка, бросаемая на failAtPage. */
  public pageError: unknown = new Error('gamma page failed');
  /** Записанные вызовы listMarkets. */
  public readonly listCalls: RecordedListMarketsRequest[] = [];
  /** События по id для fetchEvent. */
  public readonly events = new Map<string, Event>();
  /** Записанные вызовы fetchEvent (request.id). */
  public readonly fetchEventCalls: string[] = [];
  /** Если задано — fetchEvent бросает эту ошибку. */
  public fetchEventError: unknown;

  public listMarkets = ((request?: Record<string, unknown>) => {
    this.listCalls.push(request);
    const pages = this.pages;
    const failAtPage = this.failAtPage;
    const pageError = this.pageError;
    const listHold = this.listHold;

    const iterate = async function* (): AsyncGenerator<{
      items: Market[];
      hasMore: boolean;
      nextCursor?: unknown;
    }> {
      if (listHold !== undefined) {
        await listHold;
      }
      for (let i = 0; i < pages.length; i++) {
        if (i === failAtPage) {
          throw pageError;
        }
        yield { items: pages[i]!, hasMore: i < pages.length - 1 };
      }
    };

    const paginated = {
      [Symbol.asyncIterator]: () => iterate(),
      firstPage: async () => {
        const first = await iterate().next();
        return first.done === true ? { items: [], hasMore: false } : first.value;
      },
      from: () => paginated,
    };
    return paginated;
  }) as unknown as PolymarketDiscoveryClient['listMarkets'];

  public fetchEvent = (async (request: { id?: string }): Promise<Event> => {
    const id = String(request.id);
    this.fetchEventCalls.push(id);
    if (this.fetchEventError !== undefined) {
      throw this.fetchEventError;
    }
    const event = this.events.get(id);
    if (event === undefined) {
      throw new Error(`FakeDiscoveryClient has no event ${id}`);
    }
    return event;
  }) as unknown as PolymarketDiscoveryClient['fetchEvent'];
}

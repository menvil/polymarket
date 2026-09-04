/**
 * Тестовая обвязка finalizer-а: РЕАЛЬНЫЙ `PolymarketCollectionLifecycle`
 * поверх узких fakes recorder-а, control-plane подписок и Gamma.
 *
 * @remarks
 * Session lifecycle настоящий намеренно: правила границы датасета
 * (ACTIVE → FINALIZING → seal → release claim) — это правила ЕГО состояния,
 * и на моке они проверялись бы против выдуманной структуры. Fake — только
 * то, чем lifecycle владеть не должен: recorder (диск), claim-ы (транспорт)
 * и Gamma (сеть).
 *
 * Обвязка САМОДОСТАТОЧНА: зависимости на legacy `@polymarket/collection-
 * coordinator` здесь нет — он снят с вооружения и удаляется на Legacy
 * Infrastructure Cleanup.
 *
 * Fresh-Gamma fixtures повторяют live-характеризацию 2026-08-24 (SDK 0.6.0):
 * `outcomes.*.price` — DecimalString (`"1"`/`"0"` у resolved),
 * `event.metadata.priceToBeat/finalPrice` — JSON numbers,
 * `state.closedTime` — не-ISO vendor-строка.
 */
import { asCryptoAssetId, asInstrumentId, asMarketId } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { MarketMeta } from '@polymarket/ports';
import type {
  PolymarketChainlinkTwapSettlement,
  PolymarketGammaEvent,
  PolymarketGammaMarket,
  PolymarketRtdsFeed,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import { rtdsFeedKey } from '@polymarket/polymarket-v2';
import type { PolymarketRecordingSessionSnapshot } from '@polymarket/external-message-recorder';
import { COLLECTOR_RAW_OWNER_KEY, PolymarketCollectionLifecycle } from '@polymarket/collector';
import { MarketFinalizer } from '../../src/index.js';
import type { FinalizationGammaClient, MarketFinalizerConfig } from '../../src/index.js';

/** Фиксированное «сейчас» тестов (2026-08-19T12:00:00Z). */
export const NOW_MS = Date.parse('2026-08-19T12:00:00.000Z');

/** Реалистичные идентификаторы BTC-рынка. */
export const CID_A = `0x${'a'.repeat(64)}`;
export const CID_B = `0x${'b'.repeat(64)}`;
export const TOKEN_UP = '111';
export const TOKEN_DOWN = '222';

/** Gamma numeric id рынка фикстур. */
export const GAMMA_MARKET_ID = '516789';
/** Gamma event id рынка фикстур. */
export const GAMMA_EVENT_ID = '99001';

/** RTDS-фиды BTC (оба spot vendor topic). */
export const BTC_FEEDS: readonly PolymarketRtdsFeed[] = [
  { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
  { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
];

/** Settlement-дескриптор BTC TWAP-60 (рынок текущих 5m/15m-серий). */
export const BTC_TWAP_SETTLEMENT: PolymarketChainlinkTwapSettlement = {
  kind: 'chainlink-twap',
  symbol: 'btc/usd',
  windowSeconds: 60,
  resolutionSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
};

/** RTDS-фиды BTC TWAP-рынка: spot-пара + официальный settlement-поток. */
export const BTC_TWAP_FEEDS: readonly PolymarketRtdsFeed[] = [
  ...BTC_FEEDS,
  { topic: 'prices.crypto.chainlink.twap', symbol: 'btc/usd', windowSeconds: 60 },
];

/** Управляемые часы. */
export class FixedClock implements IClock {
  public constructor(private _nowMs: number = NOW_MS) {}

  /**
   * Текущий момент.
   *
   * @returns Дата текущего момента часов
   */
  public now(): Date {
    return new Date(this._nowMs);
  }

  /**
   * Двигает часы вперёд.
   *
   * @param deltaMs - Сдвиг в миллисекундах
   */
  public advance(deltaMs: number): void {
    this._nowMs += deltaMs;
  }
}

/** Запись лога для ассертов. */
export interface CapturedLogEntry {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly context?: Record<string, unknown> | undefined;
}

/** Логгер, накапливающий записи в память (child возвращает тот же sink). */
export class CapturingLogger implements ILogger {
  public readonly entries: CapturedLogEntry[] = [];

  public trace(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'trace', message, context });
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'debug', message, context });
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, context });
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', message, context });
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, context });
  }

  public fatal(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'fatal', message, context });
  }

  public child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }

  /**
   * Записи заданного уровня.
   *
   * @param level - Уровень записи
   * @returns Отфильтрованные записи
   */
  public byLevel(level: CapturedLogEntry['level']): CapturedLogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
}

/** Журнал последовательности вызовов (проверка ПОРЯДКА шагов). */
export class CallLog {
  public readonly calls: string[] = [];

  /**
   * Добавляет вызов в журнал.
   *
   * @param call - Метка вызова
   */
  public push(call: string): void {
    this.calls.push(call);
  }

  /**
   * Позиция первого вхождения метки.
   *
   * @param call - Метка вызова
   * @returns Индекс или `-1`
   */
  public indexOf(call: string): number {
    return this.calls.indexOf(call);
  }
}

/**
 * Обязательный typed Timestamp из ms (fixtures).
 *
 * @param ms - Момент epoch
 * @returns Canonical `Timestamp`
 * @throws {Error} Если момент невалиден
 */
export function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Обязательный typed MarketId (fixtures).
 *
 * @param conditionId - conditionId рынка
 * @returns Canonical `MarketId`
 * @throws {Error} Если id невалиден
 */
export function mid(conditionId: string): MarketId {
  const marketId = asMarketId(conditionId);
  if (marketId === undefined) {
    throw new Error(`invalid MarketId fixture: ${conditionId}`);
  }
  return marketId;
}

/**
 * Обязательный typed InstrumentId (fixtures).
 *
 * @param raw - tokenId исхода
 * @returns Canonical `InstrumentId`
 * @throws {Error} Если id невалиден
 */
export function iid(raw: string): InstrumentId {
  const instrumentId = asInstrumentId(raw);
  if (instrumentId === undefined) {
    throw new Error(`invalid InstrumentId fixture: ${raw}`);
  }
  return instrumentId;
}

/** Параметры фикстуры vendor-подготовки рынка. */
export interface SelectedFixtureOptions {
  readonly conditionId?: string;
  readonly question?: string;
  readonly tokenIds?: readonly string[];
  readonly expiresAtMs?: number;
  /**
   * ms точного начала события; `null` — вырожденная vendor-запись без него.
   *
   * @remarks
   * В V2 `eventStartsAt` обязателен, поэтому `null` собирается точечным
   * приведением: он нужен, чтобы проверить ЗАЩИТУ финализатора от записи
   * без официального открытия окна, а не чтобы описать нормальный рынок.
   */
  readonly eventStartsAtMs?: number | null;
  readonly rtdsFeeds?: readonly PolymarketRtdsFeed[];
  /** Settlement-дескриптор рынка (без него fallback-деривация недоступна). */
  readonly settlement?: PolymarketChainlinkTwapSettlement;
  /** `resolution.source` с TWAP-правилом, которое локально не поддержано. */
  readonly unsupportedSettlementSource?: string;
  /** Байты паддинга `question` (тесты бюджета header). */
  readonly questionPadding?: number;
}

/**
 * Строит `SelectedPolymarketMarket` — vendor-подготовку удерживаемого рынка.
 *
 * @param options - Переопределения (дефолт: BTC-рынок, событие через 10 мин,
 *   истечение через 70 мин, оба spot RTDS-фида)
 * @returns Подготовка рынка
 */
export function createSelected(options: SelectedFixtureOptions = {}): SelectedPolymarketMarket {
  const {
    conditionId = CID_A,
    tokenIds = [TOKEN_UP, TOKEN_DOWN],
    expiresAtMs = NOW_MS + 70 * 60_000,
    eventStartsAtMs = NOW_MS + 10 * 60_000,
    rtdsFeeds = BTC_FEEDS,
    settlement,
    unsupportedSettlementSource,
    questionPadding,
  } = options;
  const question =
    options.question ??
    `Bitcoin Up or Down - fixture${questionPadding !== undefined ? ` ${'q'.repeat(questionPadding)}` : ''}`;

  // Форма покрывает поля, которые читает finalizer (outcomes/resolution/state)
  const gammaMarket = {
    id: GAMMA_MARKET_ID,
    conditionId,
    question,
    state: { active: true, closed: false, closedTime: null },
    outcomes: {
      yes: { label: 'Up', tokenId: tokenIds[0] ?? null, positionId: null, price: '0.5' },
      no: { label: 'Down', tokenId: tokenIds[1] ?? null, positionId: null, price: '0.5' },
    },
    resolution: {
      questionId: null,
      negRiskRequestId: null,
      umaResolutionStatus: null,
      source: null,
      resolvedBy: null,
    },
    events: [{ id: GAMMA_EVENT_ID, slug: 'fixture-event', title: 'Fixture Event' }],
  } as unknown as PolymarketGammaMarket;

  const gammaEvent = {
    id: GAMMA_EVENT_ID,
    slug: 'fixture-event',
    title: 'Fixture Event',
    markets: [],
  } as unknown as PolymarketGammaEvent;

  return {
    marketId: mid(conditionId),
    gammaMarketId: GAMMA_MARKET_ID,
    slug: 'fixture-slug',
    question,
    outcomes: tokenIds.map((tokenId, index) => ({
      label: index === 0 ? 'Up' : 'Down',
      instrumentId: iid(tokenId),
    })) as unknown as SelectedPolymarketMarket['outcomes'],
    expiresAt: ts(expiresAtMs),
    ...(eventStartsAtMs !== null ? { eventStartsAt: ts(eventStartsAtMs) } : {}),
    event: { id: GAMMA_EVENT_ID, slug: 'fixture-event', title: 'Fixture Event' },
    ...(rtdsFeeds.length > 0
      ? {
          crypto: {
            source: 'chainlink' as const,
            asset: asCryptoAssetId('btc')!,
            binanceSymbol: 'BTCUSDT',
            feeds: rtdsFeeds,
            ...(settlement !== undefined ? { settlement } : {}),
            ...(unsupportedSettlementSource !== undefined ? { unsupportedSettlementSource } : {}),
          },
        }
      : {}),
    rtdsFeeds,
    gammaMarket,
    gammaEvent,
  } as SelectedPolymarketMarket;
}

/**
 * Строит canonical V2 header допуска рынка (то, что пишет gate в LINE 1).
 *
 * @param selected - Vendor-подготовка рынка
 * @returns Базовый header, который финализатор обязан ОБОГАТИТЬ
 *
 * @remarks
 * Форма повторяет `PolymarketCollectionGate`: canonical identity/timing/
 * outcomes/крипто-номинал БЕЗ vendor-снапшотов. Именно она — база
 * финального header-а, и именно её ломало бы возвращение `headerVersion: 1`.
 */
export function baseHeaderFor(selected: SelectedPolymarketMarket): Record<string, unknown> {
  return {
    headerVersion: 2,
    source: 'polymarket',
    conditionId: String(selected.marketId),
    slug: selected.slug,
    question: selected.question,
    outcomes: selected.outcomes.map((outcome, index) => ({
      index,
      label: outcome.label,
      instrumentId: String(outcome.instrumentId),
    })),
    family: 'CRYPTO_UP_DOWN',
    timing: {
      ...(selected.eventStartsAt !== undefined
        ? { startsAt: selected.eventStartsAt.toNumber() }
        : {}),
      expiresAt: selected.expiresAt.toNumber(),
    },
    ...(selected.crypto !== undefined
      ? { crypto: { asset: String(selected.crypto.asset), duration: 5 * 60_000 } }
      : {}),
  };
}

/** Внутреннее состояние одной recording-сессии подделки recorder-а. */
interface FakeRecordingSession {
  readonly marketMeta: MarketMeta;
  rtdsFeeds: readonly PolymarketRtdsFeed[];
  state: 'ACTIVE' | 'FINALIZING' | 'SEALED';
  readonly firstObservedAtMs: number;
}

/**
 * Подделка recorder-а: и владелец recording-сессий (для lifecycle), и
 * write-путь header/архива (для finalizer) — как в production, где это ОДИН
 * компонент.
 */
export class FakeCollectionRecorder {
  /** Сессии по `String(marketId)`. */
  public readonly sessions = new Map<string, FakeRecordingSession>();
  /** Финализации `key:reason` в порядке вызовов. */
  public readonly finalizations: string[] = [];
  /** Заморозки датасетов в порядке вызовов. */
  public readonly seals: string[] = [];
  /** Переходы в FINALIZING: `marketId:feedKey,...`. */
  public readonly narrowings: string[] = [];
  /** Записанные header-обновления в порядке вызовов. */
  public readonly metaUpdates: Array<{ marketId: string; header: Record<string, unknown> }> = [];
  /** Возвращаемое значение sealMarket. */
  public sealResult = true;
  /** Если задано — sealMarket бросает для этого `String(marketId)`. */
  public sealErrorForMarketId: string | undefined;
  /** Если задано — finalizeMarket бросает. */
  public finalizeError: unknown;
  /** Исход следующих updateMarketMeta (default true = header записан). */
  public metaUpdateResult = true;
  /** Если задано — updateMarketMeta бросает (I/O-ошибка storage). */
  public metaUpdateError: unknown;
  /** Записанные payload-строки sealed-датасета (ступень `recorded-*`). */
  public sealedPayloadLines: readonly string[] | undefined;
  /** Зафиксированные вызовы read-пути (marketId). */
  public readonly sealedReads: string[] = [];

  public constructor(private readonly _log?: CallLog) {}

  /**
   * Создаёт recording-сессию рынка (эквивалент допуска первым наблюдением).
   *
   * @param selected - Vendor-подготовка рынка
   * @param firstObservedAtMs - Момент первой записанной строки
   */
  public openSession(selected: SelectedPolymarketMarket, firstObservedAtMs: number): void {
    this.sessions.set(String(selected.marketId), {
      marketMeta: {
        marketId: selected.marketId,
        question: selected.question,
        tokenIds: selected.outcomes.map((outcome) => String(outcome.instrumentId)),
        expiresAt: selected.expiresAt,
        rawMarket: baseHeaderFor(selected),
      },
      rtdsFeeds: selected.rtdsFeeds,
      state: 'ACTIVE',
      firstObservedAtMs,
    });
  }

  public readonly listMarketSessions = (): readonly PolymarketRecordingSessionSnapshot[] =>
    [...this.sessions.entries()].map(([, session]) => ({
      marketId: session.marketMeta.marketId,
      state: session.state,
      marketMeta: session.marketMeta,
      rtdsFeeds: session.rtdsFeeds,
      firstObservedAtMs: session.firstObservedAtMs,
    }));

  public readonly beginMarketFinalization = (
    marketId: MarketId,
    feeds: readonly PolymarketRtdsFeed[],
  ): boolean => {
    const label = feeds.map((feed) => rtdsFeedKey(feed)).join(',');
    this.narrowings.push(`${String(marketId)}:${label}`);
    this._log?.push(`recorder.beginMarketFinalization:${String(marketId)}:${label}`);
    const session = this.sessions.get(String(marketId));
    if (session === undefined) {
      return false;
    }
    session.rtdsFeeds = feeds;
    session.state = 'FINALIZING';
    return true;
  };

  public readonly sealMarket = async (marketId: MarketId): Promise<boolean> => {
    if (this.sealErrorForMarketId === String(marketId)) {
      throw new Error(`storage seal failed for ${String(marketId)}`);
    }
    this.seals.push(String(marketId));
    this._log?.push(`recorder.sealMarket:${String(marketId)}`);
    const session = this.sessions.get(String(marketId));
    if (session !== undefined) {
      session.state = 'SEALED';
    }
    return this.sealResult;
  };

  public readonly finalizeMarket = async (
    marketId: MarketId,
    reason: 'EXPIRED' | 'SHUTDOWN',
  ): Promise<void> => {
    this.finalizations.push(`${String(marketId)}:${reason}`);
    this._log?.push(`recorder.finalizeMarket:${String(marketId)}:${reason}`);
    if (this.finalizeError !== undefined) {
      throw this.finalizeError;
    }
    this.sessions.delete(String(marketId));
  };

  public readonly updateMarketMeta = async (
    marketId: MarketId,
    header: Record<string, unknown>,
  ): Promise<boolean> => {
    if (this.metaUpdateError !== undefined) {
      throw this.metaUpdateError;
    }
    this.metaUpdates.push({ marketId: String(marketId), header });
    this._log?.push(`recorder.updateMarketMeta:${String(marketId)}`);
    return this.metaUpdateResult;
  };

  public readonly readSealedPayloadLines = async (
    marketId: MarketId,
    filter: (line: string) => boolean,
    maxMatches = 100_000,
  ): Promise<readonly string[] | undefined> => {
    // Паритет с DataRecorder: невалидный потолок — программная ошибка
    if (!Number.isInteger(maxMatches) || maxMatches <= 0) {
      throw new Error(
        `readSealedPayloadLines: maxMatches must be a positive integer, got ${String(maxMatches)}`,
      );
    }
    this.sealedReads.push(String(marketId));
    if (this.sealedPayloadLines === undefined) {
      return undefined;
    }
    return this.sealedPayloadLines.filter(filter).slice(0, maxMatches);
  };

  /**
   * Последний записанный header (для ассертов финального содержимого).
   *
   * @returns Header последнего `updateMarketMeta` либо `undefined`
   */
  public lastHeader(): Record<string, unknown> | undefined {
    return this.metaUpdates[this.metaUpdates.length - 1]?.header;
  }
}

/** Подделка read-only проекции claim-ов общего control-plane. */
export class FakeCollectionSubscriptions {
  /** Удерживаемые коллектором рынки по `String(marketId)`. */
  public readonly held = new Map<string, SelectedPolymarketMarket>();
  /** Снятые claim-ы в порядке вызовов. */
  public readonly released: string[] = [];

  public constructor(private readonly _log?: CallLog) {}

  public readonly getHeldMarket = (
    ownerKey: string,
    marketId: MarketId,
  ): { readonly selected: SelectedPolymarketMarket } | undefined => {
    if (ownerKey !== COLLECTOR_RAW_OWNER_KEY) {
      return undefined;
    }
    const selected = this.held.get(String(marketId));
    return selected === undefined ? undefined : { selected };
  };

  public readonly release = async (_ownerKey: string, marketId: MarketId): Promise<string> => {
    this.released.push(String(marketId));
    this._log?.push(`subscriptions.release:${String(marketId)}`);
    this.held.delete(String(marketId));
    return 'closed';
  };
}

/** Fake официального SDK query plane (fetchMarket/fetchEvent). */
export class FakeGamma implements FinalizationGammaClient {
  /** Fresh Markets по gammaMarketId. */
  public readonly markets = new Map<string, PolymarketGammaMarket>();
  /** Fresh Events по event id. */
  public readonly events = new Map<string, PolymarketGammaEvent>();
  public readonly fetchMarketCalls: string[] = [];
  public readonly fetchEventCalls: string[] = [];
  /** Если true — любой fetch бросает (недоступный Gamma). */
  public failFetches = false;

  public fetchMarket = (async (request: { id?: string }): Promise<PolymarketGammaMarket> => {
    const id = String(request.id);
    this.fetchMarketCalls.push(id);
    if (this.failFetches) {
      throw new Error('gamma fetchMarket 500');
    }
    const market = this.markets.get(id);
    if (market === undefined) {
      throw new Error(`FakeGamma has no market ${id}`);
    }
    return market;
  }) as unknown as FinalizationGammaClient['fetchMarket'];

  public fetchEvent = (async (request: { id?: string }): Promise<PolymarketGammaEvent> => {
    const id = String(request.id);
    this.fetchEventCalls.push(id);
    if (this.failFetches) {
      throw new Error('gamma fetchEvent 500');
    }
    const event = this.events.get(id);
    if (event === undefined) {
      throw new Error(`FakeGamma has no event ${id}`);
    }
    return event;
  }) as unknown as FinalizationGammaClient['fetchEvent'];
}

/** Параметры fresh-Market фикстуры (характеризованные значения по умолчанию). */
export interface FreshGammaMarketOptions {
  readonly closed?: boolean;
  readonly umaResolutionStatus?: string | null;
  readonly yesPrice?: string | null;
  readonly noPrice?: string | null;
  /** Байты паддинга (тесты бюджета header). */
  readonly padding?: number;
}

/**
 * Строит СВЕЖИЙ normalized Market resolved-формы (live-характеризация).
 *
 * @param options - Переопределения полей
 * @returns Normalized Gamma Market
 */
export function createFreshGammaMarket(
  options: FreshGammaMarketOptions = {},
): PolymarketGammaMarket {
  const {
    closed = true,
    umaResolutionStatus = 'resolved',
    yesPrice = '1',
    noPrice = '0',
    padding,
  } = options;
  return {
    id: GAMMA_MARKET_ID,
    conditionId: CID_A,
    question: 'Bitcoin Up or Down - fixture',
    state: {
      active: true,
      closed,
      enableOrderBook: true,
      closedTime: closed ? '2026-08-24 11:41:25+00' : null,
    },
    outcomes: {
      yes: { label: 'Up', tokenId: TOKEN_UP, positionId: null, price: yesPrice },
      no: { label: 'Down', tokenId: TOKEN_DOWN, positionId: null, price: noPrice },
    },
    resolution: {
      questionId: null,
      negRiskRequestId: null,
      umaResolutionStatus,
      source: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
      resolvedBy: null,
    },
    events: [{ id: GAMMA_EVENT_ID, slug: 'fixture-event', title: 'Fixture Event' }],
    ...(padding !== undefined ? { padding: 'x'.repeat(padding) } : {}),
  } as unknown as PolymarketGammaMarket;
}

/** Параметры fresh-Event фикстуры. */
export interface FreshGammaEventOptions {
  /** `eventMetadata.priceToBeat` (JSON number — как в live). */
  readonly priceToBeat?: number;
  /** `eventMetadata.finalPrice` (JSON number — как в live). */
  readonly finalPrice?: number;
  /**
   * СЫРОЕ значение `eventMetadata.priceToBeat` (строка/мусор).
   *
   * @remarks
   * Gamma-metadata — нетипизированный vendor-объект: там встречаются не
   * только числа. Нужно, чтобы проверить, что непригодное значение не
   * выдаётся за официальное.
   */
  readonly priceToBeatRaw?: unknown;
  /** Байты паддинга (тесты бюджета header). */
  readonly padding?: number;
}

/**
 * Строит СВЕЖИЙ normalized Event с metadata характеризованной формы.
 *
 * @param options - Переопределения полей
 * @returns Normalized Gamma Event
 */
export function createFreshGammaEvent(options: FreshGammaEventOptions = {}): PolymarketGammaEvent {
  const { priceToBeat, finalPrice, priceToBeatRaw, padding } = options;
  const metadata: Record<string, unknown> | null =
    priceToBeat !== undefined || finalPrice !== undefined || priceToBeatRaw !== undefined
      ? {
          ...(priceToBeat !== undefined ? { priceToBeat } : {}),
          ...(priceToBeatRaw !== undefined ? { priceToBeat: priceToBeatRaw } : {}),
          ...(finalPrice !== undefined ? { finalPrice } : {}),
        }
      : null;
  return {
    id: GAMMA_EVENT_ID,
    slug: 'fixture-event',
    title: 'Fixture Event',
    state: { active: true, closed: true },
    schedule: { startTime: new Date(NOW_MS + 10 * 60_000).toISOString() },
    metadata,
    markets: [],
    ...(padding !== undefined ? { padding: 'y'.repeat(padding) } : {}),
  } as unknown as PolymarketGammaEvent;
}

/** Полный harness finalizer-а вокруг РЕАЛЬНОГО lifecycle. */
export interface FinalizerHarness {
  log: CallLog;
  recorder: FakeCollectionRecorder;
  subscriptions: FakeCollectionSubscriptions;
  gamma: FakeGamma;
  clock: FixedClock;
  logger: CapturingLogger;
  lifecycle: PolymarketCollectionLifecycle<SelectedPolymarketMarket>;
  finalizer: MarketFinalizer;
}

/**
 * Собирает harness: реальный lifecycle + finalizer поверх fakes.
 *
 * @param config - Переопределения retry/timeout finalizer-а
 * @returns Полный harness
 *
 * @remarks
 * `settlementGraceMs: 0` — собственное поведение grace проверяется тестами
 * lifecycle, а здесь оно лишь добавляло бы секунды ожидания в каждый тест
 * резолюции (сам seal при этом происходит в той же цепочке).
 */
export function createFinalizerHarness(config: MarketFinalizerConfig = {}): FinalizerHarness {
  const log = new CallLog();
  const recorder = new FakeCollectionRecorder(log);
  const subscriptions = new FakeCollectionSubscriptions(log);
  const gamma = new FakeGamma();
  const clock = new FixedClock();
  const logger = new CapturingLogger();
  const lifecycle = new PolymarketCollectionLifecycle<SelectedPolymarketMarket>(
    { recorder, subscriptions, clock, logger },
    { settlementGraceMs: 0 },
  );
  const finalizer = new MarketFinalizer(
    { lifecycle, recorder, gamma, clock, logger },
    { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 15 * 60_000, ...config },
  );
  return { log, recorder, subscriptions, gamma, clock, logger, lifecycle, finalizer };
}

/**
 * Открывает collection-сессию рынка в harness (допуск + attach lifecycle).
 *
 * @param harness - Harness finalizer-а
 * @param options - Параметры фикстуры рынка
 * @returns Vendor-подготовка открытого рынка
 *
 * @example
 * ```typescript
 * openMarket(harness, { rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT });
 * ```
 */
export function openMarket(
  harness: FinalizerHarness,
  options: SelectedFixtureOptions = {},
): SelectedPolymarketMarket {
  const selected = createSelected(options);
  harness.subscriptions.held.set(String(selected.marketId), selected);
  harness.recorder.openSession(selected, harness.clock.now().getTime());
  harness.lifecycle.syncSessions();
  return selected;
}

/**
 * Заряжает fresh-Gamma ответы фикстурного рынка.
 *
 * @param gamma - Подделка query plane
 * @param market - Свежий Market
 * @param event - Свежий Event (опционально)
 */
export function armGamma(
  gamma: FakeGamma,
  market: PolymarketGammaMarket,
  event?: PolymarketGammaEvent,
): void {
  gamma.markets.set(GAMMA_MARKET_ID, market);
  if (event !== undefined) {
    gamma.events.set(GAMMA_EVENT_ID, event);
  }
}

/**
 * Управляемый deferred для hold-сценариев.
 *
 * @returns Promise и его резолвер
 */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Дожидается осушения microtask/immediate очередей.
 *
 * @param rounds - Сколько раундов ожидания
 */
export async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Дожидается выполнения условия (граница async-транзакции вместо счёта тиков).
 *
 * @param predicate - Проверяемое условие
 * @param timeoutMs - Предел ожидания
 * @throws {Error} Если условие не наступило за timeoutMs
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

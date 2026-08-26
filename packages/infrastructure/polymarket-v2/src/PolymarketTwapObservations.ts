/**
 * Ограниченная проекция наблюдений settlement-потока Chainlink TWAP.
 *
 * @remarks
 * ### Зачем это существует
 *
 * Ровно один вопрос требует ответа В РЕАЛЬНОМ ВРЕМЕНИ: «пришло ли уже
 * наблюдение с vendor-timestamp за границей рынка?». По нему координатор
 * решает, можно ли замораживать датасет истёкшего рынка, или граничное
 * наблюдение ещё в пути — RTDS доставляет его через 1.1–2.2 с после
 * момента, которым оно датировано (замер 2026-08-26).
 *
 * ### Чем это НЕ является
 *
 * Это НЕ semantic adapter и НЕ Domain-сущность:
 *
 * - значения хранятся ТОЧНО так, как их отдал SDK — десятичной строкой;
 *   ни `Price`, ни `Decimal`, ни `Number()` здесь не появляются;
 * - payload источника не мутируется и не пересобирается;
 * - истории «на будущее» не копится: буфер каждого фида ограничен, а сами
 *   фиды вытесняются по TTL молчания.
 *
 * Полный ряд наблюдений живёт не здесь, а в ЗАПИСАННОМ датасете рынка —
 * именно из него finalizer выводит итог (одно и то же наблюдение в архиве
 * и в расчёте, MR-B PART 26). Трекер сознательно не является вторым
 * источником истины.
 *
 * ```text
 * общий ExternalMessageBus
 *   ├─► ExternalMessageRecorder ──► датасет рынка  (источник для fallback)
 *   └─► PolymarketTwapObservations (этот класс)    (сигнал границы)
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { IExternalMessageBus } from '@polymarket/external-message-bus';
import type { PolymarketExternalMessage } from './PolymarketExternalMessage.js';
import type { PolymarketTwapRtdsFeed } from './PolymarketRtdsFeeds.js';
import { rtdsFeedKey } from './PolymarketRtdsFeeds.js';

/**
 * Одно наблюдение settlement-потока в source-native виде.
 */
export interface PolymarketTwapObservation {
  /** Vendor-timestamp наблюдения (epoch ms, выровнен по целой секунде). */
  readonly timestampMs: number;
  /** Значение TWAP ТОЧНОЙ десятичной строкой SDK (без конверсии). */
  readonly value: string;
}

/**
 * Порт подписки трекера на общий bus.
 *
 * @remarks
 * Структурное подмножество `IExternalMessageBus` (только `subscribe`) —
 * то же правило, что у recorder-а: трекер не владеет bus и не имеет права
 * публиковать/дренировать/закрывать его. Узкий тип также позволяет передать
 * bus, параметризованный БОЛЕЕ ШИРОКИМ union-ом источников контура.
 */
export type PolymarketTwapBusSubscription = Pick<
  IExternalMessageBus<PolymarketExternalMessage>,
  'subscribe'
>;

/** Зависимости {@link PolymarketTwapObservations}. */
export interface PolymarketTwapObservationsDependencies {
  /** Общий bus внешнего контура (используется только `subscribe`). */
  readonly bus: PolymarketTwapBusSubscription;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/** Конфигурация {@link PolymarketTwapObservations}. */
export interface PolymarketTwapObservationsConfig {
  /**
   * Потолок наблюдений на один фид (кольцевой буфер).
   *
   * @defaultValue 120
   *
   * @remarks
   * При каденсе 1 Гц это две минуты истории — с запасом перекрывает
   * boundary grace (секунды), ради которого буфер и существует. Больше
   * держать незачем: полный ряд рынка живёт в его записанном датасете.
   */
  readonly maxObservationsPerFeed?: number;
  /**
   * Время молчания, после которого фид выселяется целиком.
   *
   * @defaultValue 900_000 (15 минут)
   *
   * @remarks
   * Верхняя граница числа отслеживаемых фидов — это число одновременно
   * активных settlement-подписок контура; TTL гарантирует, что подписки
   * закрытых рынков не остаются в памяти навсегда.
   */
  readonly feedTtlMs?: number;
}

/** Дефолты конфигурации (см. {@link PolymarketTwapObservationsConfig}). */
const DEFAULT_MAX_OBSERVATIONS_PER_FEED = 120;
const DEFAULT_FEED_TTL_MS = 15 * 60_000;

/** Снимок состояния трекера (диагностика/смоук). */
export interface PolymarketTwapObservationsStats {
  /** Отслеживаемых settlement-фидов сейчас. */
  readonly feeds: number;
  /** Наблюдений в буферах сейчас. */
  readonly buffered: number;
  /** Принято наблюдений всего (накопительно). */
  readonly accepted: number;
  /** Отброшено сообщений с непригодным payload (накопительно). */
  readonly rejected: number;
}

/** Буфер одного фида. */
interface FeedBuffer {
  /** Наблюдения в порядке поступления (кольцевой сдвиг слева). */
  readonly observations: PolymarketTwapObservation[];
  /** Максимальный vendor-timestamp, замеченный у фида. */
  latestTimestampMs: number;
  /** Момент последнего наблюдения по локальным часам (для TTL). */
  lastSeenAtMs: number;
}

/**
 * Трекер граничных наблюдений settlement-потока TWAP.
 *
 * @example
 * ```typescript
 * const observations = new PolymarketTwapObservations({ bus, logger });
 * observations.start();
 *
 * const feed = { topic: 'prices.crypto.chainlink.twap', symbol: 'btc/usd', windowSeconds: 60 } as const;
 * if (observations.hasObservationAtOrAfter(feed, market.expiresAt.toNumber())) {
 *   // граница пересечена — датасет можно замораживать
 * }
 * ```
 */
export class PolymarketTwapObservations {
  private readonly _bus: PolymarketTwapBusSubscription;
  private readonly _logger: ILogger;
  private readonly _maxObservationsPerFeed: number;
  private readonly _feedTtlMs: number;

  /** Буферы по точному ключу фида (`rtdsFeedKey`). */
  private readonly _feeds = new Map<string, FeedBuffer>();
  private _dispose: (() => void) | null = null;
  private _accepted = 0;
  private _rejected = 0;

  /**
   * Создаёт трекер поверх общего bus контура.
   *
   * @param deps - Зависимости (см. {@link PolymarketTwapObservationsDependencies})
   * @param config - Границы памяти (см. {@link PolymarketTwapObservationsConfig})
   */
  constructor(
    deps: PolymarketTwapObservationsDependencies,
    config: PolymarketTwapObservationsConfig = {},
  ) {
    this._bus = deps.bus;
    this._logger = deps.logger.child({ component: 'PolymarketTwapObservations' });
    this._maxObservationsPerFeed =
      config.maxObservationsPerFeed ?? DEFAULT_MAX_OBSERVATIONS_PER_FEED;
    this._feedTtlMs = config.feedTtlMs ?? DEFAULT_FEED_TTL_MS;
  }

  /**
   * Подписывается на settlement-поток общего bus.
   *
   * @remarks
   * Идемпотентен. Подписка строго typed — трекер видит ТОЛЬКО
   * `POLYMARKET_CRYPTO_CHAINLINK_TWAP` и никак не влияет на остальных
   * подписчиков (в том числе на recorder: раздача веерная).
   */
  public start(): void {
    if (this._dispose !== null) {
      return;
    }
    this._dispose = this._bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', (message) => {
      this._onObservation(message.payload.payload);
    });
    this._logger.info('Chainlink TWAP observation tracker started');
  }

  /**
   * Отписывается от bus и освобождает буферы.
   *
   * @remarks
   * Идемпотентен. Общий bus НЕ закрывается — им владеет composition root.
   */
  public close(): void {
    this._dispose?.();
    this._dispose = null;
    this._feeds.clear();
    this._logger.info('Chainlink TWAP observation tracker closed');
  }

  /**
   * Пришло ли наблюдение фида с vendor-timestamp не раньше границы.
   *
   * @param feed - Settlement-фид рынка (символ + окно)
   * @param atMs - Граница рынка (epoch ms)
   * @returns `true`, если граничное наблюдение уже получено
   *
   * @remarks
   * Сравнение ведётся по VENDOR-времени наблюдения, а не по локальному
   * времени получения: именно vendor-timestamp определяет, к какому моменту
   * рынка относится значение (PART 23 — «последний полученный до expiresAt»
   * НЕ означает «граничный»).
   */
  public hasObservationAtOrAfter(feed: PolymarketTwapRtdsFeed, atMs: number): boolean {
    const buffer = this._feeds.get(rtdsFeedKey(feed));
    return buffer !== undefined && buffer.latestTimestampMs >= atMs;
  }

  /**
   * Возвращает наблюдение фида с ТОЧНО заданным vendor-timestamp.
   *
   * @param feed - Settlement-фид рынка
   * @param timestampMs - Искомый vendor-timestamp (epoch ms)
   * @returns Наблюдение либо `undefined`, если такого нет в буфере
   *
   * @remarks
   * Именно точное совпадение, без «ближайшего»: оракул берёт значение НА
   * границе, а соседняя секунда — уже другое число (и, как показал замер,
   * секунда после границы нередко дублирует её значение, что делает
   * «ближайшее» ещё и неоднозначным).
   */
  public observationAt(
    feed: PolymarketTwapRtdsFeed,
    timestampMs: number,
  ): PolymarketTwapObservation | undefined {
    const buffer = this._feeds.get(rtdsFeedKey(feed));
    return buffer?.observations.find((observation) => observation.timestampMs === timestampMs);
  }

  /**
   * Возвращает снимок состояния.
   *
   * @returns Текущие значения {@link PolymarketTwapObservationsStats}
   */
  public getStats(): PolymarketTwapObservationsStats {
    let buffered = 0;
    for (const buffer of this._feeds.values()) {
      buffered += buffer.observations.length;
    }
    return {
      feeds: this._feeds.size,
      buffered,
      accepted: this._accepted,
      rejected: this._rejected,
    };
  }

  /**
   * Принимает одно наблюдение settlement-потока.
   *
   * @param payload - Внутренний payload SDK-события (symbol/value/window/ts)
   *
   * @remarks
   * Никогда не бросает: трекер — необязательный наблюдатель, его отказ не
   * имеет права ронять handler общего bus. Ключ фида собирается из САМОГО
   * события, поэтому наблюдение окна 30 физически не может попасть в буфер
   * окна 60.
   */
  private _onObservation(payload: {
    readonly symbol: string;
    readonly timestamp: number;
    readonly value: string;
    readonly windowSeconds: PolymarketTwapRtdsFeed['windowSeconds'];
  }): void {
    const timestampMs = payload.timestamp;
    if (!Number.isFinite(timestampMs) || payload.value.length === 0) {
      this._rejected++;
      return;
    }
    const key = rtdsFeedKey({
      topic: 'prices.crypto.chainlink.twap',
      symbol: payload.symbol,
      windowSeconds: payload.windowSeconds,
    });
    let buffer = this._feeds.get(key);
    if (buffer === undefined) {
      buffer = { observations: [], latestTimestampMs: Number.NEGATIVE_INFINITY, lastSeenAtMs: 0 };
      this._feeds.set(key, buffer);
    }
    buffer.observations.push({ timestampMs, value: payload.value });
    if (buffer.observations.length > this._maxObservationsPerFeed) {
      buffer.observations.shift();
    }
    if (timestampMs > buffer.latestTimestampMs) {
      buffer.latestTimestampMs = timestampMs;
    }
    // TTL считается по vendor-времени потока: локальные часы трекеру не
    // инъецированы, а поток фиксирует ход времени сам (1 Гц)
    buffer.lastSeenAtMs = timestampMs;
    this._accepted++;
    this._pruneSilentFeeds(timestampMs);
  }

  /**
   * Выселяет фиды, молчащие дольше TTL (граница числа буферов).
   *
   * @param nowMs - Текущее vendor-время потока
   */
  private _pruneSilentFeeds(nowMs: number): void {
    if (this._feeds.size <= 1) {
      return;
    }
    for (const [key, buffer] of this._feeds) {
      if (nowMs - buffer.lastSeenAtMs >= this._feedTtlMs) {
        this._feeds.delete(key);
        this._logger.debug('Evicted silent TWAP feed buffer', { feed: key });
      }
    }
  }
}

/**
 * PolymarketSource — тонкий ingress boundary над `@polymarket/client` (Polymarket V2).
 *
 * @remarks
 * ### Поток данных
 *
 * ```text
 * Polymarket V2 client (client.subscribe → AsyncIterable)
 *         ↓  for await (const sdkEvent of handle)
 * ExternalMessage {
 *   type:     наш routing discriminator,
 *   payload:  sdkEvent               ← ТОТ ЖЕ объект, без remapping,
 *   metadata: metadataGenerator.nextRoot(),
 * }
 *         ↓
 * общий ExternalMessageBus (инъецируется, НЕ создаётся здесь)
 * ```
 *
 * ### Чем Source сознательно НЕ занимается
 *
 * - **не нормализует payload** — semantic adapter появится ПОСЛЕ Recorder
 *   checkpoint (N-002+), здесь SDK event проходит как есть;
 * - **не переустанавливает соединения** — reconnect/backoff/heartbeat
 *   принадлежат Polymarket V2 client (проверено в 0.6.0: realtime-транспорт
 *   переподключается пока есть активные подписки);
 * - **не сортирует события** — публикация в порядке фактического получения
 *   из SDK-итераторов; порядок фиксирует `metadata.sequence`;
 * - **не заводит собственный bus/очередь** — единственная очередь контура
 *   живёт в `MessageBus` под `ExternalMessageBus`.
 */
import type { ILogger } from '@polymarket/logger';
import type { MessageBusPublishError } from '@polymarket/message-bus';
import type { MessageMetadataGenerator } from '@polymarket/messages';
import type { Result } from '@polymarket/result';
import type { createPublicClient } from '@polymarket/client';
import type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  CryptoPricesChainlinkTwapEvent,
  CryptoPricesChainlinkTwapWindowSeconds,
  CryptoPricesTopic,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
import type {
  PolymarketCryptoBinanceExternalMessage,
  PolymarketCryptoChainlinkExternalMessage,
  PolymarketCryptoChainlinkTwapExternalMessage,
  PolymarketExternalMessage,
  PolymarketMarketExternalMessage,
} from './PolymarketExternalMessage.js';
import { CHAINLINK_TWAP_TOPIC } from './PolymarketRtdsFeeds.js';

/**
 * Subscription handle Polymarket V2 client/bindings — структурное зеркало его контракта.
 *
 * @remarks
 * `@polymarket/client@0.6.0` НЕ экспортирует свои subscription-типы
 * (`SubscriptionHandle`, `PublicSubscriptionSpec`, ...) с public root —
 * они живут только во внутреннем chunk-модуле, а импорт internal SDK paths
 * запрещён. Реальный handle SDK (`{ close() } & AsyncIterable`)
 * удовлетворяет этому типу структурно, без кастов.
 */
export interface PolymarketSubscriptionHandle<TEvent> extends AsyncIterable<TEvent> {
  /**
   * Закрывает подписку (контракт SDK: идемпотентен, best-effort — ошибки
   * первого вызова пробрасываются, последующие вызовы no-op).
   */
  close(): Promise<void>;
}

/**
 * Subscribe-возможность клиента Polymarket V2, которую использует Source.
 *
 * @remarks
 * Тип выведен НАПРЯМУЮ из `PublicClient` Polymarket V2 client
 * (`Pick<..., 'subscribe'>`), а не написан руками: SDK не экспортирует типы
 * subscribe-контракта (`PublicSubscriptionSpec`, `SubscriptionHandle`, ...)
 * с public root, а рукописные узкие overload-ы не проходят structural-check
 * против `const`-generic метода SDK (компилятор не может инстанцировать его
 * generic при сравнении сигнатур и падает в constraint-fallback).
 * `ReturnType<typeof createPublicClient>` — публичный API, поэтому вывод
 * устойчив к минорным обновлениям SDK.
 *
 * Это НЕ vendor-абстракция: реальный `createPublicClient()` присваивается
 * сюда напрямую (это его собственный метод). Узкий Pick нужен только чтобы
 * тестовый fake не был обязан реализовать ВСЕ actions полного клиента.
 *
 * @example
 * ```typescript
 * const client = createPublicClient();          // Polymarket V2 client
 * const source = new PolymarketSource({ client, bus, metadataGenerator, logger });
 * ```
 */
export type PolymarketSubscribeClient = Pick<
  ReturnType<typeof createPublicClient>,
  'subscribe' | 'closeSubscriptions'
>;

/**
 * Порт публикации внешних сообщений Polymarket в общий ExternalMessageBus.
 *
 * @remarks
 * Структурное подмножество `IExternalMessageBus` (только `publish`).
 * Узкий тип обязателен по TypeScript-причине: будущий общий bus контура
 * параметризуется union-ом ВСЕХ sources
 * (`ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>`), а
 * полный `IExternalMessageBus<A | B>` не присваиваем к
 * `IExternalMessageBus<A>` из-за generic-подписки `subscribe`. Метод
 * `publish` контравариантен по сообщению, поэтому bus с более широким union
 * подходит под этот порт без каких-либо кастов.
 */
export interface PolymarketExternalMessagePublisher {
  /**
   * Публикует одно внешнее сообщение (контракт `ExternalMessageBus.publish`).
   *
   * @param message - Полное сообщение `{ type, payload, metadata }`
   * @returns Canonical Result движка доставки
   */
  publish(message: PolymarketExternalMessage): Promise<Result<void, MessageBusPublishError>>;
}

/**
 * Зависимости {@link PolymarketSource}.
 *
 * @remarks
 * Ownership: composition root создаёт ОДИН public client Polymarket V2 и ОДИН
 * общий ExternalMessageBus и передаёт их сюда. Source не создаёт ни клиента,
 * ни bus, ни metadata generator — он только владеет открытыми им
 * subscription handles.
 */
export interface PolymarketSourceDependencies {
  /** Официальный SDK public client (обычно результат `createPublicClient()`). */
  readonly client: PolymarketSubscribeClient;
  /** Общий bus внешнего контура (один на все sources процесса). */
  readonly bus: PolymarketExternalMessagePublisher;
  /** Canonical генератор metadata runtime (один на процесс). */
  readonly metadataGenerator: MessageMetadataGenerator;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
  /**
   * Пауза в RTDS-потоке, после которой он считается мёртвым (мс).
   *
   * @defaultValue 10_000
   *
   * @remarks
   * Порог инъецируется, а не зашит константой, ровно по двум причинам:
   * детерминированные тесты надзора и возможность подстроить его под
   * реальную частоту фида, если она изменится. К CLOB-подпискам он не
   * применяется вовсе — тихий рынок это норма.
   */
  readonly rtdsStallAfterMs?: number;

  /**
   * Лестница задержек между попытками переподписки RTDS (мс).
   *
   * @defaultValue `[1000, 2000, 5000, 10000]`
   *
   * @remarks
   * Ограничивает ШАГ, а не число попыток: последняя ступень повторяется,
   * пока подписку не отпустят. Инъецируется по той же причине, что порог
   * молчания, — тест на восстановление после `broken` иначе стоил бы
   * полминуты реального времени на каждом прогоне CI.
   */
  readonly rtdsResubscribeBackoffMs?: readonly number[];
}

/**
 * Sentinel гонки pump-цикла: подписка закрыта, пока `publish` ждал drain.
 */
const PUMP_CLOSED: unique symbol = Symbol('polymarket-source-pump-closed');

/**
 * Открытая подписка Source: позволяет завершить её независимо от остальных.
 */
export interface PolymarketOpenSubscription {
  /**
   * Закрывает подписку и дожидается завершения её pump-цикла.
   *
   * @returns Promise, разрешающийся после остановки итератора
   *
   * @remarks
   * Идемпотентна (close SDK-handle идемпотентен). Ошибки закрытия транспорта
   * логируются и не пробрасываются — при shutdown они не должны ронять caller.
   */
  readonly close: () => Promise<void>;
}

/**
 * Ingress boundary Polymarket V2: события Polymarket V2 client → canonical
 * ExternalMessages → общий ExternalMessageBus.
 *
 * @remarks
 * ### Ответственность (и только она)
 *
 * 1. открыть подписки через Polymarket V2 client;
 * 2. читать SDK AsyncIterable;
 * 3. обернуть каждый event в canonical ExternalMessage
 *    (payload === SDK event, metadata = `nextRoot()` — каждое внешнее
 *    наблюдение начинает НОВУЮ causal chain);
 * 4. опубликовать в общий ExternalMessageBus;
 * 5. корректно закрыть подписки.
 *
 * ### Policy отказов (детерминированная)
 *
 * - **Отклонение публикации bus-ом** (`Err` от `publish`) — source НЕ делает
 *   вид, что событие обработано: ошибка логируется, source переходит в
 *   терминальное состояние `failed` и закрывает ВСЕ свои подписки. Retry
 *   queue сознательно нет: отклонение canonical bus (closed/overflow) — это
 *   отказ контура доставки, а не транзиентная сетевая ошибка.
 * - **Падение SDK-итератора** (transport exception) — та же терминальная
 *   ветка `failed`; исключение НЕ становится unhandled rejection (pump
 *   полностью изолирован).
 * - **Ошибки `subscribe*`** — пробрасываются вызывающему как есть
 *   (SDK `SubscribeError` — легитимная Infrastructure-ошибка; второй набор
 *   идентичных наших ошибок не заводится).
 * - **Поздний `subscribe`** — SDK-handle, разрешившийся после `close()`/
 *   отказа, немедленно закрывается и НЕ регистрируется; вызов отклоняется
 *   той же ошибкой состояния, что и fail-fast guard.
 * - **Shutdown из обработчика bus** — `close()` (и `close()` отдельной
 *   подписки) БЕЗОПАСНО await-ить из обработчика этого же bus: pump гоняет
 *   `publish` с сигналом закрытия и не образует цикл
 *   handler → close → pump → publish → handler.
 *
 * @example
 * ```typescript
 * // Composition root:
 * const client = createPublicClient();
 * const bus = new ExternalMessageBus<PolymarketExternalMessage>();
 * const source = new PolymarketSource({ client, bus, metadataGenerator, logger });
 *
 * await source.subscribeMarket([upTokenId, downTokenId]);
 * await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
 *
 * // Shutdown:
 * await source.close();
 * await bus.close();
 * ```
 */
/**
 * Надзор за непрерывностью потока подписки.
 *
 * @remarks
 * Нужен там, где молчание потока — это ОТКАЗ, а не законное затишье.
 * RTDS-фиды крипто-цен идут с частотой ~1 Гц независимо от рыночной
 * активности, поэтому их пауза в десятки секунд означает мёртвый поток.
 * CLOB-подписке надзор НЕ выдаётся: тихий рынок — норма, и watchdog
 * перезапускал бы её без причины.
 */
interface SubscriptionSupervision<TEvent> {
  /**
   * Открывает НОВЫЙ SDK-handle с тем же spec-ом подписки.
   *
   * @remarks
   * Это и есть «кэш подписок» из legacy `RtdsWebSocketClient`: замыкание
   * помнит spec целиком, поэтому восстановление после сброса соединения не
   * требует ни отдельного реестра, ни участия владельца. Замыкание есть у
   * КАЖДОЙ подписки, включая CLOB, — иначе connection-level reset оставил бы
   * стакан закрытым.
   */
  readonly reopen: () => Promise<PolymarketSubscriptionHandle<TEvent>>;
  /**
   * Пауза в событиях, после которой поток считается мёртвым (мс);
   * `undefined` — молчание для этой подписки законно (CLOB).
   */
  readonly stallAfterMs?: number;
}

/**
 * Пауза в RTDS-потоке, после которой он считается мёртвым (мс).
 *
 * @remarks
 * RTDS публикует ~1 Гц, поэтому 10 секунд — это десяток пропущенных тиков
 * подряд: сомнений в том, что поток мёртв, уже не остаётся, а ложных
 * срабатываний на джиттере доставки (замер: p99 ≈ 0.4 с) не возникает.
 *
 * Было 30 с. Живой разрыв в run-02 показал, где реальная цена: провал данных
 * составил ~34 с, из которых 32.5 с ушло на ОБНАРУЖЕНИЕ и лишь 1.3 с на саму
 * переподписку. Узкое место — порог, а не скорость восстановления, поэтому
 * его снижение втрое стоит дешевле любого другого улучшения. Legacy
 * `RtdsWebSocketClient` держал те же 30 с, но опрашивал каждые 5 с и имел
 * PING-heartbeat, которого у SDK-транспорта мы не видим.
 */
const RTDS_STALL_AFTER_MS = 10_000;

/**
 * Лестница задержек перед повторной попыткой переподписки (мс).
 *
 * @remarks
 * Лестница ОГРАНИЧИВАЕТ шаг, а не число попыток: после последней ступени
 * ретраи продолжаются с той же задержкой, пока подписку не отпустит владелец
 * или не закроется source. Останавливать восстановление нельзя — это вернуло
 * бы ровно тот дефект, ради которого написан надзор: сетевой обрыв дольше
 * 18 секунд навсегда оставил бы контур без RTDS, а контроллер продолжал бы
 * считать фид приобретённым.
 */
const RESUBSCRIBE_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

/**
 * Раз во сколько попыток логировать неудачу уже сломанного фида.
 *
 * @remarks
 * Ретраи бесконечны, поэтому лог на каждую попытку дал бы строку каждые
 * 10 секунд на весь срок аварии. Шесть попыток на ступени 10 с — примерно
 * одна строка в минуту: отказ остаётся видимым, лог не тонет.
 */
const BROKEN_LOG_EVERY_NTH_FAILURE = 6;

/**
 * Сколько перезапусков подряд БЕЗ единого события означают, что виновата не
 * подписка, а общее соединение SDK.
 *
 * @remarks
 * Счётчик обнуляется первым же пришедшим событием, поэтому «подряд» здесь —
 * это «фид переоткрыли, и он снова умер, так и не ожив». Один такой цикл
 * бывает при обычном сетевом всплеске; два подряд означают, что мы
 * переоткрываем поток поверх мёртвого сокета. Порог взят из legacy
 * `RtdsWebSocketClient`, где эскалация звалась
 * `subscription_stale_after_resubscribe` и срабатывала при `staleCount >= 2`.
 */
const ESCALATE_AFTER_RESTARTS = 2;

/**
 * Пауза между сбросами общего соединения (мс).
 *
 * @remarks
 * Обязательна, потому что фиды умирают ПАЧКОЙ: в живом прогоне 2026-09-06
 * замолчали все шесть разом. Без cooldown каждый из них потребовал бы своего
 * сброса, и мы бы рвали соединение шесть раз подряд, мешая ему подняться.
 * У legacy-клиента ту же роль играл cooldown resubscribe по топику.
 */
const CONNECTION_RESET_COOLDOWN_MS = 30_000;

/**
 * Сколько ждать `closeSubscriptions()` SDK при сбросе соединения (мс).
 *
 * @remarks
 * Вызов неотменяем и на мёртвом транспорте может не разрешиться. Ждать его
 * безусловно значит подвесить эскалацию и остановку источника; ограничение
 * означает «мы перестали ЖДАТЬ», а не «сброс не состоялся» — teardown
 * продолжается в фоне, подписки переоткрываются своим чередом.
 */
const CONNECTION_RESET_TIMEOUT_MS = 5_000;

/**
 * Диагностика непрерывности одной надзираемой подписки.
 */
export interface PolymarketSubscriptionHealth {
  /**
   * Identity фида той же гранулярности, что `rtdsFeedKey`:
   * `topic \n symbol` (для TWAP — плюс `\n windowSeconds`).
   */
  readonly subscription: string;
  /** Момент последнего полученного события (epoch ms); нет — событий не было. */
  readonly lastEventAtMs?: number;
  /**
   * Момент, ОТ КОТОРОГО считается тишина (epoch ms): последнее событие, а
   * если событий ещё не было — старт текущего поколения потока.
   *
   * @remarks
   * Поле обязательное намеренно. Подписка, не принёсшая ни одного события, —
   * самое тревожное состояние из возможных, и потребитель, считающий возраст
   * по одному `lastEventAtMs`, отрисовал бы её как «данных нет» вместо
   * «молчит N секунд». Watchdog меряет тишину от этого же момента, поэтому
   * диагностика и решение о перезапуске согласованы по построению.
   */
  readonly silentSinceMs: number;
  /** Сколько раз поток пришлось поднимать заново. */
  readonly restarts: number;
  /**
   * Молчание этой подписки считается отказом.
   *
   * @remarks
   * Отличает RTDS-фиды (идут ~1 Гц, тишина = смерть) от CLOB (тихий стакан —
   * норма). Потребитель ОБЯЗАН фильтровать по этому полю, когда считает
   * «сколько времени самый тихий поток молчит»: без фильтра спокойный рынок
   * выглядел бы как авария.
   */
  readonly watched: boolean;
  /** Поток сейчас недоступен: переподписка не удалась подряд достаточно раз. */
  readonly broken: boolean;
}

/** Изменяемое состояние надзора за одной подпиской. */
interface SupervisionState {
  lastEventAtMs?: number;
  /** Старт текущего поколения потока — точка отсчёта тишины до первого события. */
  streamStartedAtMs: number;
  restarts: number;
  /** Перезапуски подряд без единого события; обнуляется первым событием. */
  consecutiveRestarts: number;
  /** Молчание этой подписки — отказ (RTDS), а не норма (CLOB). */
  watched: boolean;
  broken: boolean;
}

/**
 * Строит identity надзираемого фида.
 *
 * @param topic - RTDS topic
 * @param symbols - Символы подписки
 * @param windowSeconds - Окно TWAP, если это settlement-поток
 * @returns Ключ надзора
 *
 * @remarks
 * Ключ обязан совпадать по гранулярности с `rtdsFeedKey` контроллера:
 * тот открывает ОТДЕЛЬНУЮ подписку на каждый символ, поэтому ключ из одного
 * `topic` склеил бы BTC и ETH в одну запись здоровья — вторая подписка
 * затирала бы первую, а завершение любой из них удаляло бы диагностику
 * обеих. При одном символе строка байт-в-байт равна `rtdsFeedKey(feed)`,
 * так что записи здоровья сопоставимы с `rtdsFeedKeys` контроллера напрямую.
 *
 * @example
 * ```typescript
 * supervisionKey('prices.crypto.binance', ['btcusdt']); // 'prices.crypto.binance\nbtcusdt'
 * ```
 */
function supervisionKey(
  topic: string,
  symbols: readonly string[],
  windowSeconds?: number,
): string {
  const parts = [topic, [...symbols].join(',')];
  if (windowSeconds !== undefined) {
    parts.push(String(windowSeconds));
  }
  return parts.join('\n');
}

export class PolymarketSource {
  private readonly _client: PolymarketSubscribeClient;
  private readonly _bus: PolymarketExternalMessagePublisher;
  private readonly _metadataGenerator: MessageMetadataGenerator;
  private readonly _logger: ILogger;
  /** Открытые SDK-handles: только те, что открыл этот Source. */
  private readonly _handles = new Set<PolymarketSubscriptionHandle<unknown>>();
  /** Активные pump-циклы; `close()` дожидается их всех (никаких висящих итераторов). */
  private readonly _pumps = new Set<Promise<void>>();
  /** Resolver-ы сигналов «handle закрыт»: будят pump, ждущий publish (drain-owner). */
  private readonly _handleCloseSignals = new Map<PolymarketSubscriptionHandle<unknown>, () => void>();
  /** true после `close()` — новые подписки запрещены. */
  /** Состояние надзора по identity подписки (диагностика непрерывности). */
  private readonly _supervised = new Map<string, SupervisionState>();
  /** Будильники ожидающих backoff циклов: `close()`/`_fail()` не ждут ступень. */
  private readonly _releaseSignals = new Set<() => void>();
  /** Идущий сброс общего соединения (single-flight). */
  private _connectionReset: Promise<void> | undefined;
  /** Когда общее соединение сбрасывали в последний раз (epoch ms). */
  private _lastConnectionResetAtMs = 0;
  /** Сколько раз сбрасывали общее соединение — для статуса. */
  private _connectionResets = 0;
  /** Порог молчания RTDS-потока (мс). */
  private readonly _rtdsStallAfterMs: number;
  /** Лестница задержек переподписки (мс); последняя ступень повторяется. */
  private readonly _rtdsBackoffMs: readonly number[];

  private _closed = false;
  /** true после терминального отказа (bus rejection / падение итератора). */
  private _failed = false;

  /**
   * Создаёт Source поверх инъецированных client/bus/metadata generator.
   *
   * @param deps - Зависимости (см. {@link PolymarketSourceDependencies})
   */
  constructor(deps: PolymarketSourceDependencies) {
    this._client = deps.client;
    this._bus = deps.bus;
    this._metadataGenerator = deps.metadataGenerator;
    this._logger = deps.logger.child({ component: 'PolymarketSource' });
    this._rtdsStallAfterMs = deps.rtdsStallAfterMs ?? RTDS_STALL_AFTER_MS;
    const backoff = deps.rtdsResubscribeBackoffMs ?? RESUBSCRIBE_BACKOFF_MS;
    this._rtdsBackoffMs = backoff.length > 0 ? backoff : RESUBSCRIBE_BACKOFF_MS;
  }

  /** true, если source закрыт (`close()`) и новые подписки запрещены. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * true после терминального отказа: bus отклонил публикацию либо упал
   * SDK-итератор. Отказ детерминированно останавливает все подписки source.
   */
  public get hasFailed(): boolean {
    return this._failed;
  }

  /**
   * Открывает подписку CLOB market channel на набор tokenIds.
   *
   * @param tokenIds - CLOB token IDs (asset ids), чьи события нужны
   * @returns Открытая подписка с индивидуальным `close()`
   * @throws {Error} Если source уже закрыт или в терминальном `failed`
   * @throws `SubscribeError` SDK (`TransportError | UserInputError`) — как есть
   *
   * @remarks
   * События подписки (`book`/`price_change`/`last_trade_price`/
   * `tick_size_change`) публикуются как `POLYMARKET_MARKET` с payload =
   * нетронутый {@link StandardMarketEvent}. `customFeatureEnabled` не
   * включается — custom-события текущей системе не нужны.
   *
   * @example
   * ```typescript
   * const subscription = await source.subscribeMarket([yesTokenId, noTokenId]);
   * // ... рынок истёк:
   * await subscription.close();
   * ```
   */
  public async subscribeMarket(tokenIds: readonly string[]): Promise<PolymarketOpenSubscription> {
    this._assertAcceptsSubscriptions();
    const handle = await this._client.subscribe([{ topic: 'market', tokenIds }]);
    if (this._closed || this._failed) {
      return this._discardLateSubscription('market', handle);
    }
    this._logger.info('Polymarket market subscription opened', { tokenIdCount: tokenIds.length });
    // Watchdog CLOB не получает — тихий стакан это норма. Но reopen получает:
    // после connection-level reset стакан обязан подняться вместе со всеми,
    // иначе сброс соединения лечил бы RTDS ценой потери CLOB.
    return this._track(
      supervisionKey('market', tokenIds),
      handle,
      (event) => this._toMarketMessage(event),
      { reopen: async () => this._client.subscribe([{ topic: 'market', tokenIds }]) },
    );
  }

  /**
   * Открывает подписку RTDS crypto-prices topic на набор символов.
   *
   * @param topic - RTDS topic SDK: `prices.crypto.binance` (символы вида
   *   `btcusdt`) или `prices.crypto.chainlink` (символы вида `btc/usd`)
   * @param symbols - Символы для фильтрации потока
   * @returns Открытая подписка с индивидуальным `close()`
   * @throws {Error} Если source уже закрыт или в терминальном `failed`
   * @throws `SubscribeError` SDK (`TransportError | UserInputError`) — как есть
   *
   * @remarks
   * Событие каждого topic публикуется под своим routing discriminator
   * (`POLYMARKET_CRYPTO_BINANCE` / `POLYMARKET_CRYPTO_CHAINLINK`);
   * выбор ведётся по `payload.topic` самого события — vendor discriminator
   * сохраняется в payload как есть. Метод обслуживает ТОЛЬКО spot-потоки:
   * у settlement-потока Chainlink TWAP другой spec подписки (обязательное
   * окно усреднения), поэтому у него отдельный метод
   * {@link PolymarketSource.subscribeChainlinkTwap}.
   *
   * @example
   * ```typescript
   * await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
   * await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);
   * ```
   */
  public async subscribeCryptoPrices(
    topic: CryptoPricesTopic,
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> {
    this._assertAcceptsSubscriptions();
    const handle = await this._client.subscribe([{ topic, symbols }]);
    if (this._closed || this._failed) {
      return this._discardLateSubscription(topic, handle);
    }
    this._logger.info('Polymarket crypto prices subscription opened', {
      topic,
      symbolCount: symbols.length,
    });
    return this._track(
      supervisionKey(topic, symbols),
      handle,
      (event) => this._toCryptoMessage(event),
      {
        reopen: async () => this._client.subscribe([{ topic, symbols }]),
        stallAfterMs: this._rtdsStallAfterMs,
      },
    );
  }

  /**
   * Открывает подписку на ОФИЦИАЛЬНЫЙ settlement-поток Chainlink TWAP.
   *
   * @param windowSeconds - Окно усреднения TWAP (vendor-домен: 30 | 60);
   *   берётся из settlement-дескриптора рынка, а НЕ из его длительности
   * @param symbols - Символы Chainlink slash-формата (`btc/usd`)
   * @returns Открытая подписка с индивидуальным `close()`
   * @throws {Error} Если source уже закрыт или в терминальном `failed`
   * @throws `SubscribeError` SDK (`TransportError | UserInputError`) — как есть
   *
   * @remarks
   * Отдельный метод, а не перегрузка {@link PolymarketSource.subscribeCryptoPrices},
   * потому что таков контракт САМОГО SDK: spot-потоки описываются spec-ом
   * `{ topic, symbols }`, а settlement-поток —
   * `{ topic: 'prices.crypto.chainlink.twap', windowSeconds, symbols }`, где
   * окно ОБЯЗАТЕЛЬНО. Склеивать их в один метод с optional-окном значило бы
   * сделать представимым невалидный вызов (TWAP без окна).
   *
   * События публикуются под собственным discriminator-ом
   * `POLYMARKET_CRYPTO_CHAINLINK_TWAP` с нетронутым SDK-payload — окно
   * приходит обратно в `payload.windowSeconds`.
   *
   * @example
   * ```typescript
   * // рынок с resolution.source = '.../btc-usd-twap-60s-streams':
   * await source.subscribeChainlinkTwap(60, ['btc/usd']);
   * ```
   */
  public async subscribeChainlinkTwap(
    windowSeconds: CryptoPricesChainlinkTwapWindowSeconds,
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> {
    this._assertAcceptsSubscriptions();
    const handle = await this._client.subscribe([
      { topic: CHAINLINK_TWAP_TOPIC, windowSeconds, symbols },
    ]);
    const subscription = supervisionKey(CHAINLINK_TWAP_TOPIC, symbols, windowSeconds);
    if (this._closed || this._failed) {
      return this._discardLateSubscription(subscription, handle);
    }
    this._logger.info('Polymarket Chainlink TWAP subscription opened', {
      topic: CHAINLINK_TWAP_TOPIC,
      windowSeconds,
      symbolCount: symbols.length,
    });
    return this._track(subscription, handle, (event) => this._toTwapMessage(event), {
      reopen: async () =>
        this._client.subscribe([{ topic: CHAINLINK_TWAP_TOPIC, windowSeconds, symbols }]),
      stallAfterMs: this._rtdsStallAfterMs,
    });
  }

  /**
   * Graceful shutdown: закрывает все открытые подписки и дожидается
   * завершения всех pump-циклов.
   *
   * @returns Promise, разрешающийся когда ни одного живого итератора не осталось
   *
   * @remarks
   * Идемпотентен. Общий bus НЕ закрывается — им владеет composition root
   * (bus разделён с другими sources). Ошибки закрытия SDK-handles
   * логируются warn-ом и не пробрасываются.
   *
   * Безопасен для вызова ИЗ обработчика этого же bus: pump-циклы выходят из
   * ожидания `publish` по сигналу закрытия (см. {@link PolymarketSource._pump}),
   * поэтому цикл handler → close → pump → publish → handler не образуется.
   * Сообщение, чей `publish` был прерван сигналом, уже находится в очереди
   * движка и доставляется текущим drain-ом.
   */
  public async close(): Promise<void> {
    const firstClose = !this._closed;
    this._closed = true;
    this._wakeSupervisionWaiters();
    await this._closeAllHandles();
    await Promise.all([...this._pumps]);
    if (firstClose) {
      this._logger.info('PolymarketSource closed');
    }
  }

  /**
   * Fail-fast guard для subscribe-методов.
   *
   * @throws {Error} Если source закрыт или уже отказал
   */
  private _assertAcceptsSubscriptions(): void {
    if (this._closed) {
      throw new Error('PolymarketSource is closed and cannot open new subscriptions');
    }
    if (this._failed) {
      throw new Error('PolymarketSource has failed and cannot open new subscriptions');
    }
  }

  /**
   * Отклоняет подписку, SDK-handle которой разрешился ПОСЛЕ перехода source
   * в терминальное состояние.
   *
   * @param subscription - Имя подписки для логов
   * @param handle - Поздно разрешившийся SDK handle
   * @returns Никогда не возвращает управление нормально
   * @throws {Error} Та же ошибка состояния, что у fail-fast guard
   *
   * @remarks
   * Закрывает race: `close()`/`_fail()` закрывают только handles,
   * зарегистрированные на момент вызова, а pending `client.subscribe()`
   * мог разрешиться позже. Без этого guard-а поздний handle стал бы живой
   * подпиской на терминальном source (висящий итератор + публикации после
   * close). Поздний handle немедленно закрывается и НЕ регистрируется.
   */
  private async _discardLateSubscription(
    subscription: string,
    handle: PolymarketSubscriptionHandle<unknown>,
  ): Promise<never> {
    this._logger.warn('Subscription resolved after source shutdown, closing late handle', {
      subscription,
    });
    await this._closeHandle(subscription, handle);
    throw new Error(
      this._closed
        ? 'PolymarketSource is closed and cannot open new subscriptions'
        : 'PolymarketSource has failed and cannot open new subscriptions',
    );
  }

  /**
   * Регистрирует handle, запускает pump и собирает объект открытой подписки.
   *
   * @param subscription - Имя подписки для логов
   * @param handle - SDK handle (AsyncIterable + close)
   * @param toMessage - Конструктор canonical сообщения из SDK-события
   * @param supervision - Надзор за непрерывностью (только для RTDS-фидов)
   * @returns Открытая подписка с индивидуальным close
   *
   * @remarks
   * Pump-promise хранится до завершения: `close()` через него гарантирует
   * отсутствие висящих итераторов. Сам pump никогда не reject-ится —
   * все ошибки обрабатываются внутри (см. {@link PolymarketSource._pump}).
   *
   * ### Зачем надзорный цикл
   *
   * Без него поток, ЗАВЕРШИВШИЙСЯ штатно, исчезал бесследно: `for await`
   * выходил из цикла, handle удалялся из реестра, и ни одной строки в лог не
   * попадало — потому что исключения не было. Владелец подписки при этом
   * продолжал считать фид живым (у него на руках остаётся тот же объект
   * `{ close }`), а данные больше не приходили. Ровно так на прогоне 2026-09-06
   * RTDS замолчал на 64-й минуте: десять минут рынки писались без единой
   * котировки, `pmRtdsFeeds: 6`, ошибок ноль.
   *
   * Теперь у надзираемой подписки завершение потока — не конец, а повод
   * подняться заново. Наружный объект подписки при этом НЕ меняется: владелец
   * держит стабильный handle, а какой SDK-поток стоит за ним сейчас — деталь
   * реализации источника.
   */
  private _track<TEvent>(
    subscription: string,
    handle: PolymarketSubscriptionHandle<TEvent>,
    toMessage: (event: TEvent) => PolymarketExternalMessage,
    supervision: SubscriptionSupervision<TEvent>,
  ): PolymarketOpenSubscription {
    const state: SupervisionState = {
      streamStartedAtMs: Date.now(),
      restarts: 0,
      consecutiveRestarts: 0,
      watched: supervision.stallAfterMs !== undefined,
      broken: false,
    };
    this._supervised.set(subscription, state);
    /** Подписку закрыл ВЛАДЕЛЕЦ — переподписываться больше нельзя. */
    let releasedByOwner = false;
    /**
     * Будит ожидание backoff в момент release: без этого `close()` владельца
     * ждал бы конца текущей ступени (до 10 с) на каждой подписке, а лестница
     * остановки контура ограничена по времени.
     */
    let signalReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve;
    });
    this._releaseSignals.add(signalReleased);
    /**
     * Подписку больше нельзя поднимать: отпустил владелец ЛИБО source ушёл
     * в терминальное состояние. Проверяется вокруг каждого await в цикле
     * восстановления — между ними успевает произойти и то, и другое.
     */
    const abandoned = (): boolean => releasedByOwner || this._closed || this._failed;
    let current = handle;

    const supervised = (async (): Promise<void> => {
      for (;;) {
        const activeHandle = current;
        state.streamStartedAtMs = Date.now();
        this._handles.add(activeHandle);
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        this._handleCloseSignals.set(activeHandle, resolveClosed);

        const stallAfterMs = supervision.stallAfterMs;
        const watchdog =
          stallAfterMs === undefined
            ? undefined
            : this._startStallWatchdog(subscription, activeHandle, state, stallAfterMs);
        try {
          // Состояние надзора — ТОЛЬКО надзираемым: для `_pump` его наличие
          // и есть признак «этот поток восстановим». Передать его CLOB-у
          // значило бы молча превратить терминальный отказ в перезапуск.
          await this._pump(subscription, activeHandle, toMessage, closed, state);
        } finally {
          if (watchdog !== undefined) {
            clearInterval(watchdog);
          }
          this._handles.delete(activeHandle);
          this._handleCloseSignals.delete(activeHandle);
        }

        // Поток кончился. Дальше всё зависит от того, кто его прекратил.
        if (abandoned()) {
          return;
        }
        // Старое поколение обязано быть закрыто ДО открытия нового: путь
        // «итератор бросил исключение» приходит сюда с ЖИВЫМ handle, и без
        // явного close на каждой сетевой ошибке оставался бы висящий
        // SDK-ресурс. Для завершившегося итератора и для закрытого watchdog-ом
        // handle этот вызов — no-op: контракт close() идемпотентен.
        await this._closeHandle(subscription, activeHandle);
        if (abandoned()) {
          return;
        }
        // Второй уровень: поток умирает СНОВА, не успев ожить. Значит дело не
        // в подписке, а в общем соединении SDK — лечить надо его, иначе мы
        // бесконечно переоткрываем фид поверх мёртвого сокета. Ровно эта
        // эскалация была в legacy `RtdsWebSocketClient`
        // (`subscription_stale_after_resubscribe`).
        state.consecutiveRestarts += 1;
        if (state.consecutiveRestarts >= ESCALATE_AFTER_RESTARTS) {
          await this._resetSharedConnection(subscription, state.consecutiveRestarts);
          if (abandoned()) {
            return;
          }
        }
        const reopened = await this._reopenSupervised(
          subscription,
          state,
          supervision,
          abandoned,
          released,
        );
        if (reopened === undefined) {
          return; // подписку отпустили во время восстановления
        }
        current = reopened;
      }
    })().finally(() => {
      this._pumps.delete(supervised);
      this._releaseSignals.delete(signalReleased);
      // Цикл завершается ТОЛЬКО при release/close/fail — неудачная
      // переподписка его больше не прекращает, поэтому запись здоровья
      // исчезает вместе с самой подпиской, а не в момент её смерти.
      // Удаляем СВОЮ запись: две подписки с одинаковым ключом (source —
      // публичный API, дубли им не запрещены) иначе стирали бы диагностику
      // друг друга — снова «фид жив, а health о нём молчит».
      if (this._supervised.get(subscription) === state) {
        this._supervised.delete(subscription);
      }
    });
    this._pumps.add(supervised);

    return {
      close: async () => {
        // Признак ДО закрытия транспорта: иначе надзор успел бы принять
        // штатное завершение потока за обрыв и поднять новую подписку.
        releasedByOwner = true;
        signalReleased();
        await this._closeHandle(subscription, current);
        await supervised;
        this._logger.info('Polymarket subscription closed', { subscription });
      },
    };
  }

  /**
   * Сколько раз пришлось сбрасывать общее realtime-соединение SDK.
   *
   * @returns Счётчик сбросов за жизнь источника
   *
   * @remarks
   * Растущее значение означает, что первый уровень (переоткрытие подписки)
   * систематически не помогает, то есть проблема в транспорте SDK, а не в
   * отдельных фидах. Ноль при ненулевых `restarts` — наоборот, признак, что
   * обычной переподписки хватает.
   */
  public get connectionResets(): number {
    return this._connectionResets;
  }

  /**
   * Возвращает диагностику непрерывности надзираемых подписок.
   *
   * @returns Снимок по каждой живой RTDS-подписке
   *
   * @remarks
   * Отвечает на вопрос, на который НЕ отвечает счётчик подписок: фид может
   * числиться открытым и при этом ничего не приносить. Ref-count говорит
   * «сколько мы хотим», а этот снимок — «сколько реально живо».
   *
   * Ограничение: снимок ключуется identity фида, поэтому две ОДНОВРЕМЕННЫЕ
   * подписки с одинаковым ключом дадут одну запись — последнюю. Диагностику
   * друг друга они не стирают (запись удаляет только её владелец), но считать
   * длину снимка числом физических подписок в таком случае нельзя. В нашем
   * рантайме этого не возникает: RTDS-контроллер дедуплицирует фиды по
   * `rtdsFeedKey` и держит на каждый ровно одну подписку.
   *
   * @example
   * ```typescript
   * const stale = source.getSubscriptionHealth()
   *   .filter((h) => Date.now() - (h.lastEventAtMs ?? 0) > 60_000);
   * ```
   */
  public getSubscriptionHealth(): readonly PolymarketSubscriptionHealth[] {
    return [...this._supervised.entries()]
      .map(([subscription, state]) =>
        Object.freeze({
          subscription,
          ...(state.lastEventAtMs !== undefined ? { lastEventAtMs: state.lastEventAtMs } : {}),
          silentSinceMs: state.lastEventAtMs ?? state.streamStartedAtMs,
          restarts: state.restarts,
          watched: state.watched,
          broken: state.broken,
        }),
      )
      .sort((a, b) => (a.subscription < b.subscription ? -1 : a.subscription > b.subscription ? 1 : 0));
  }

  /**
   * Сторожевой таймер молчащего потока.
   *
   * @param subscription - Имя подписки для логов
   * @param handle - Handle, за которым следим
   * @param state - Состояние надзора (момент последнего события)
   * @param stallAfterMs - Допустимая пауза в событиях
   * @returns Дескриптор интервала — вызывающий обязан его снять
   *
   * @remarks
   * Обнаружив паузу, watchdog НЕ переподписывается сам: он закрывает handle,
   * pump на этом заканчивается, и надзорный цикл поднимает поток заново —
   * тем же путём, что и при штатном завершении итератора. Одна дорога на оба
   * случая: два независимых пути восстановления разошлись бы в поведении.
   *
   * Отсчёт ведётся от последнего события, а при его отсутствии — от момента
   * запуска: подписка, не принёсшая НИ ОДНОГО события, тоже мертва.
   */
  private _startStallWatchdog(
    subscription: string,
    handle: PolymarketSubscriptionHandle<unknown>,
    state: SupervisionState,
    stallAfterMs: number,
  ): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      const silentSince = state.lastEventAtMs ?? state.streamStartedAtMs;
      const silentMs = Date.now() - silentSince;
      if (silentMs < stallAfterMs) {
        return;
      }
      this._logger.warn('Polymarket subscription went silent, restarting stream', {
        subscription,
        silentMs,
        stallAfterMs,
        hadEvents: state.lastEventAtMs !== undefined,
      });
      clearInterval(timer);
      void this._closeHandle(subscription, handle);
    }, Math.max(1_000, Math.floor(stallAfterMs / 3)));
    timer.unref?.();
    return timer;
  }

  /**
   * Поднимает надзираемую подписку заново, пока её не отпустят.
   *
   * @param subscription - Identity фида для логов и диагностики
   * @param state - Состояние надзора
   * @param supervision - Как открыть подписку заново
   * @param abandoned - Подписку отпустил владелец либо source терминален
   * @param released - Сигнал release: обрывает ожидание текущей ступени
   * @returns Новый handle либо `undefined`, если подписку отпустили
   *
   * @remarks
   * ### Почему попытки не кончаются
   *
   * Ограниченное число попыток выглядит аккуратно и является ловушкой:
   * сетевой обрыв дольше суммы лестницы (18 секунд) навсегда оставил бы
   * контур без RTDS, при том что контроллер продолжает держать этот фид
   * приобретённым, а source не в `hasFailed`. Это ровно исходный дефект,
   * только с другой причиной. Поэтому ступень ограничена, а попытки — нет:
   * единственные условия выхода — release владельца и терминальный source.
   *
   * `broken` при этом выставляется, когда лестница пройдена целиком, — как
   * ДИАГНОЗ, а не как конец восстановления, — и снимается первой же удачной
   * переподпиской. Запись
   * здоровья при этом не исчезает: цикл продолжает жить.
   *
   * ### Почему проверок отмены три
   *
   * Между ступенью backoff и возвратом `subscribe()` проходит произвольное
   * время, и последний рынок вполне может отпустить фид именно в этом окне.
   * Проверка только перед попыткой оставила бы гонку: `reopen()` открыл бы
   * НОВЫЙ handle уже после release, надзор начал бы его качать, а `close()`
   * владельца ждал бы этот цикл вечно. Поэтому отмена проверяется до
   * ожидания, после ожидания и после того, как handle уже открыт — в
   * последнем случае handle немедленно закрывается и не становится активным.
   *
   * @example
   * ```typescript
   * // owner released во время 10-секундной ступени:
   * // ожидание обрывается сигналом, новый handle не открывается
   * ```
   */
  private async _reopenSupervised<TEvent>(
    subscription: string,
    state: SupervisionState,
    supervision: SubscriptionSupervision<TEvent>,
    abandoned: () => boolean,
    released: Promise<void>,
  ): Promise<PolymarketSubscriptionHandle<TEvent> | undefined> {
    let failures = 0;
    for (let attempt = 1; ; attempt += 1) {
      if (abandoned()) {
        return undefined;
      }
      const ladder = this._rtdsBackoffMs;
      const backoffMs = ladder[Math.min(attempt, ladder.length) - 1] ?? ladder[ladder.length - 1];
      await Promise.race([
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          timer.unref?.();
        }),
        released,
      ]);
      if (abandoned()) {
        return undefined;
      }
      try {
        // `subscribe()` SDK неотменяем и на мёртвом соединении может не
        // разрешиться вовсе. Ждать его безусловно значило бы подвесить
        // `close()` владельца и всю лестницу остановки на неопределённый
        // срок — тот же бюджет, ради которого прерывается ожидание ступени.
        const reopening = supervision.reopen();
        const opened = await Promise.race([
          reopening.then((value) => ({ handle: value })),
          released.then(() => undefined),
        ]);
        if (opened === undefined || abandoned()) {
          // Release победил гонку либо случился, пока handle открывался:
          // поздний handle не должен стать активным ни на секунду.
          void reopening.then(
            async (late) => this._closeHandle(subscription, late),
            () => undefined, // отказ поздней переподписки уже никого не волнует
          );
          return undefined;
        }
        const handle = opened.handle;
        state.restarts += 1;
        state.lastEventAtMs = undefined;
        state.broken = false;
        this._logger.info('Polymarket subscription re-established', {
          subscription,
          attempt,
          restarts: state.restarts,
        });
        return handle;
      } catch (error) {
        failures += 1;
        this._reportReopenFailure(subscription, state, failures, error);
      }
    }
  }

  /**
   * Сбрасывает ОБЩЕЕ realtime-соединение SDK и даёт всем подпискам подняться.
   *
   * @param subscription - Фид, чья повторная смерть вызвала эскалацию
   * @param consecutiveRestarts - Сколько перезапусков подряд он пережил
   *
   * @remarks
   * ### Зачем второй уровень
   *
   * Первый уровень переоткрывает одну подписку. Он бессилен, когда мёртв сам
   * сокет: мы будем бесконечно вешать новый фид поверх нерабочего соединения.
   * В живом прогоне 2026-09-06 замолчали ВСЕ ШЕСТЬ RTDS-фидов одновременно —
   * это и есть подпись общего соединения, а не шести независимых потоков.
   *
   * `closeSubscriptions()` по контракту SDK «ends active subscription
   * iterators and closes shared websocket connections... does not affect
   * authentication or other client state», то есть клиент после него
   * переиспользуем. Итераторы всех подписок завершаются, каждый надзорный
   * цикл видит конец потока и поднимает СВОЮ подписку из собственного
   * замыкания `reopen`. Отдельный реестр не нужен: множество живых циклов и
   * есть кэш подписок.
   *
   * ### Почему single-flight и cooldown
   *
   * Фиды умирают пачкой, и без защиты каждый из шести потребовал бы своего
   * сброса — мы бы рвали соединение шесть раз подряд, не давая ему встать.
   * Идущий сброс переиспользуется, а следующий возможен не раньше
   * {@link CONNECTION_RESET_COOLDOWN_MS}.
   *
   * Ошибка `closeSubscriptions()` не терминальна: соединение и так считается
   * мёртвым, а переоткрытие подписок идёт своим чередом.
   *
   * @example
   * ```typescript
   * // фид переоткрыт и умер снова, не приняв ни одного события
   * await this._resetSharedConnection('prices.crypto.binance\nbtcusdt', 2);
   * ```
   */
  private async _resetSharedConnection(
    subscription: string,
    consecutiveRestarts: number,
  ): Promise<void> {
    const inFlight = this._connectionReset;
    if (inFlight !== undefined) {
      // Ждём ОГРАНИЧЕННЫЙ промис соседа, а не сам vendor-вызов: он снимается
      // и по таймауту, поэтому зависший сброс не держит остальные циклы.
      await inFlight;
      return;
    }
    const sinceLastMs = Date.now() - this._lastConnectionResetAtMs;
    if (sinceLastMs < CONNECTION_RESET_COOLDOWN_MS) {
      this._logger.debug('Shared realtime reset skipped, still in cooldown', {
        subscription,
        sinceLastMs,
        cooldownMs: CONNECTION_RESET_COOLDOWN_MS,
      });
      return;
    }
    this._connectionResets += 1;
    this._logger.error('Resetting shared realtime connection after repeated feed death', {
      subscription,
      consecutiveRestarts,
      connectionResets: this._connectionResets,
    });
    // `closeSubscriptions()` SDK неотменяем и может не разрешиться вовсе.
    // Ограничение ставится на ВНУТРЕННЮЮ операцию, а не на ожидание снаружи:
    // тогда сам `reset` завершается при любом исходе, его `.finally()`
    // отрабатывает и снимает single-flight. Иначе зависший vendor-вызов
    // оставил бы `_connectionReset` навсегда, и КАЖДАЯ следующая эскалация
    // встала бы на нём — вместе с `close()`, который ждёт pump-циклы.
    const reset = (async (): Promise<void> => {
      const closing = (async (): Promise<void> => {
        try {
          await this._client.closeSubscriptions();
        } catch (error) {
          this._logger.warn('Shared realtime reset failed; subscriptions will retry anyway', {
            subscription,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), CONNECTION_RESET_TIMEOUT_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([closing.then(() => 'closed' as const), bounded]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // Cooldown ставится при ЛЮБОМ исходе: сброс либо случился, либо мы
      // перестали его ждать — в обоих случаях рвать соединение снова прямо
      // сейчас бессмысленно.
      this._lastConnectionResetAtMs = Date.now();
      if (outcome === 'timeout') {
        this._logger.warn('Shared realtime reset did not complete in time (teardown continues)', {
          subscription,
          timeoutMs: CONNECTION_RESET_TIMEOUT_MS,
        });
      }
    })().finally(() => {
      this._connectionReset = undefined;
    });
    this._connectionReset = reset;
    await reset;
  }

  /**
   * Логирует неудачную переподписку и переводит фид в `broken`.
   *
   * @param subscription - Identity фида
   * @param state - Состояние надзора (мутируется)
   * @param failures - Сколько неудач подряд уже было
   * @param error - Ошибка попытки
   *
   * @remarks
   * Ретраи бесконечны, поэтому лог обязан быть ограничен: неудачи в пределах
   * лестницы логируются каждая (это обычный сетевой всплеск, полезно видеть
   * целиком), переход в `broken` — один
   * `error`, дальше по одной строке на каждые
   * {@link BROKEN_LOG_EVERY_NTH_FAILURE} попыток, то есть примерно раз в
   * минуту. Молчать нельзя: тишина в логе при мёртвом фиде — это и есть
   * дефект, который мы чиним.
   */
  private _reportReopenFailure(
    subscription: string,
    state: SupervisionState,
    failures: number,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const brokenAfter = Math.max(1, this._rtdsBackoffMs.length);
    if (failures < brokenAfter) {
      this._logger.warn('Polymarket subscription re-subscribe failed', {
        subscription,
        failures,
        error: message,
      });
      return;
    }
    if (failures === brokenAfter) {
      state.broken = true;
      this._logger.error('Polymarket subscription is broken; retrying until released', {
        subscription,
        failures,
        retryEveryMs: this._rtdsBackoffMs[this._rtdsBackoffMs.length - 1],
        error: message,
      });
      return;
    }
    if ((failures - brokenAfter) % BROKEN_LOG_EVERY_NTH_FAILURE === 0) {
      this._logger.error('Polymarket subscription still broken', {
        subscription,
        failures,
        error: message,
      });
    }
  }

  /**
   * Pump-цикл одной подписки: SDK-итератор → canonical message → bus.
   *
   * @param subscription - Имя подписки для логов
   * @param handle - SDK handle
   * @param toMessage - Конструктор canonical сообщения
   *
   * @param closed - Сигнал «handle этой подписки закрыт» — будит pump,
   *   ждущий publish
   *
   * @remarks
   * Инварианты:
   * - публикация в порядке получения событий из итератора (без буферизации
   *   и сортировки); каждый event получает свежий `nextRoot()` в момент
   *   обработки — `sequence` фиксирует runtime creation order;
   * - `Err` от bus → терминальный отказ source (без ретраев), цикл
   *   останавливается;
   * - исключение итератора после `close()` считается штатным завершением
   *   транспорта и логируется debug-ом; до `close()` — терминальный отказ
   *   для НЕнадзираемой подписки (CLOB) и локальный перезапуск для
   *   надзираемой (RTDS): восстановимый обрыв не должен ронять контур;
   * - promise никогда не reject-ится — unhandled rejections исключены;
   * - `await publish` гоняется с сигналом закрытия: `publish` движка может
   *   стать drain-owner-ом и ждать обработчиков, а обработчик имеет право
   *   await-ить `close()` этого source. Без гонки возник бы цикл
   *   handler → close → pump → publish → handler (deadlock). При закрытии
   *   pump выходит немедленно; сообщение уже enqueue-нуто движком и будет
   *   доставлено текущим drain-ом, его Result дологируется асинхронно.
   */
  private async _pump<TEvent>(
    subscription: string,
    handle: PolymarketSubscriptionHandle<TEvent>,
    toMessage: (event: TEvent) => PolymarketExternalMessage,
    closed: Promise<void>,
    supervisionState?: SupervisionState,
  ): Promise<void> {
    const closedMarker = closed.then((): typeof PUMP_CLOSED => PUMP_CLOSED);
    try {
      for await (const event of handle) {
        // Момент ПОЛУЧЕНИЯ события, а не публикации: watchdog следит за
        // живостью транспорта, и медленный bus не должен выглядеть как
        // мёртвый поток.
        if (supervisionState !== undefined) {
          supervisionState.lastEventAtMs = Date.now();
          // Поток ожил — цепочка «умер сразу после перезапуска» прервана.
          supervisionState.consecutiveRestarts = 0;
        }
        const message = toMessage(event);
        const publishPromise = this._bus.publish(message);
        const outcome = await Promise.race([publishPromise, closedMarker]);
        if (outcome === PUMP_CLOSED) {
          void publishPromise.then(
            (result) => {
              if (!result.ok) {
                this._logger.debug('Publication settled with rejection after subscription close', {
                  subscription,
                  messageType: message.type,
                  error: result.error.message,
                });
              }
            },
            () => undefined,
          );
          return;
        }
        if (!outcome.ok) {
          this._logger.error('External message bus rejected publication, failing source', {
            subscription,
            messageType: message.type,
            error: outcome.error.message,
          });
          await this._fail();
          return;
        }
      }
    } catch (error) {
      if (this._closed) {
        this._logger.debug('Polymarket subscription iterator terminated during close', {
          subscription,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Обрыв транспорта восстановим у ЛЮБОЙ подписки: у каждой есть spec в
      // замыкании reopen, поэтому падение итератора лечится тем же путём, что
      // штатное завершение и тишина. Терминальный отказ остаётся только за
      // тем, что восстановить нельзя, — отказом шины.
      this._logger.warn('Polymarket subscription stream failed, restarting', {
        subscription,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Терминальный отказ source: помечает `failed` и закрывает все подписки.
   *
   * @remarks
   * Идемпотентен (повторные отказы других pump-циклов не дублируют работу).
   * Pump-циклы НЕ await-ятся отсюда — метод вызывается ИЗ pump-цикла и
   * ожидание самого себя было бы deadlock; их завершение гарантирует
   * закрытие handles (итераторы терминируются).
   */
  private async _fail(): Promise<void> {
    if (this._failed) {
      return;
    }
    this._failed = true;
    this._wakeSupervisionWaiters();
    await this._closeAllHandles();
  }

  /**
   * Будит все надзорные циклы, ожидающие ступень backoff.
   *
   * @remarks
   * Ретраи переподписки бесконечны, а ступень доходит до 10 секунд. Без
   * пробуждения `close()` источника ждал бы `Promise.all(this._pumps)` до
   * конца текущей ступени на КАЖДОЙ надзираемой подписке, и лестница
   * остановки контура вылезла бы за свой бюджет на ровном месте.
   */
  private _wakeSupervisionWaiters(): void {
    for (const wake of [...this._releaseSignals]) {
      wake();
    }
  }

  /**
   * Закрывает все зарегистрированные SDK-handles (ошибки — в warn).
   */
  private async _closeAllHandles(): Promise<void> {
    const handles = [...this._handles];
    await Promise.all(handles.map(async (handle) => this._closeHandle('all', handle)));
  }

  /**
   * Закрывает один SDK-handle, не пробрасывая ошибки транспорта.
   *
   * @param subscription - Имя подписки для логов
   * @param handle - SDK handle
   */
  private async _closeHandle(subscription: string, handle: PolymarketSubscriptionHandle<unknown>): Promise<void> {
    // Сигнал pump-циклу ДО close транспорта: если pump ждёт publish
    // (drain-owner), он обязан выйти из гонки, не дожидаясь сети/drain.
    this._handleCloseSignals.get(handle)?.();
    try {
      await handle.close();
    } catch (error) {
      this._logger.warn('Failed to close Polymarket subscription handle', {
        subscription,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Оборачивает market-событие SDK в canonical сообщение.
   *
   * @param event - Событие SDK как есть
   * @returns Canonical сообщение с payload === event
   */
  private _toMarketMessage(event: StandardMarketEvent): PolymarketMarketExternalMessage {
    return {
      type: 'POLYMARKET_MARKET',
      payload: event,
      metadata: this._metadataGenerator.nextRoot(),
    };
  }

  /**
   * Оборачивает RTDS-событие SDK в canonical сообщение своего topic.
   *
   * @param event - Событие SDK как есть
   * @returns Canonical сообщение с payload === event
   *
   * @remarks
   * Routing discriminator выбирается по vendor `event.topic` — сам payload
   * не модифицируется.
   */
  private _toCryptoMessage(
    event: CryptoPricesBinanceEvent | CryptoPricesChainlinkEvent,
  ): PolymarketCryptoBinanceExternalMessage | PolymarketCryptoChainlinkExternalMessage {
    if (event.topic === 'prices.crypto.binance') {
      return {
        type: 'POLYMARKET_CRYPTO_BINANCE',
        payload: event,
        metadata: this._metadataGenerator.nextRoot(),
      };
    }
    return {
      type: 'POLYMARKET_CRYPTO_CHAINLINK',
      payload: event,
      metadata: this._metadataGenerator.nextRoot(),
    };
  }

  /**
   * Оборачивает settlement-событие TWAP в canonical сообщение.
   *
   * @param event - Событие SDK как есть (включая `payload.windowSeconds`)
   * @returns Canonical сообщение с payload === event
   *
   * @remarks
   * Никакого remapping: окно, символ, vendor-timestamp и точная десятичная
   * строка значения уходят в bus ровно теми, какими их отдал SDK — replay
   * получит идентичный source-native объект.
   */
  private _toTwapMessage(
    event: CryptoPricesChainlinkTwapEvent,
  ): PolymarketCryptoChainlinkTwapExternalMessage {
    return {
      type: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      payload: event,
      metadata: this._metadataGenerator.nextRoot(),
    };
  }
}

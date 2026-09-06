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
  'subscribe'
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
   * @defaultValue 30_000
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
  /** Открывает НОВЫЙ SDK-handle с тем же spec-ом подписки. */
  readonly reopen: () => Promise<PolymarketSubscriptionHandle<TEvent>>;
  /** Пауза в событиях, после которой поток считается мёртвым (мс). */
  readonly stallAfterMs: number;
}

/**
 * Пауза в RTDS-потоке, после которой он считается мёртвым (мс).
 *
 * @remarks
 * RTDS публикует ~1 Гц, поэтому 30 секунд — это три десятка пропущенных
 * тиков подряд: сомнений в том, что поток мёртв, уже не остаётся, а ложных
 * срабатываний на джиттере доставки (замер: p99 ≈ 0.4 с) не возникает.
 */
const RTDS_STALL_AFTER_MS = 30_000;

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
  /** Сколько раз поток пришлось поднимать заново. */
  readonly restarts: number;
  /** Поток сейчас недоступен: переподписка не удалась подряд достаточно раз. */
  readonly broken: boolean;
}

/** Изменяемое состояние надзора за одной подпиской. */
interface SupervisionState {
  lastEventAtMs?: number;
  restarts: number;
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
    return this._track('market', handle, (event) => this._toMarketMessage(event));
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
    supervision?: SubscriptionSupervision<TEvent>,
  ): PolymarketOpenSubscription {
    const state: SupervisionState = { restarts: 0, broken: false };
    if (supervision !== undefined) {
      this._supervised.set(subscription, state);
    }
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
        this._handles.add(activeHandle);
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        this._handleCloseSignals.set(activeHandle, resolveClosed);

        const watchdog =
          supervision === undefined
            ? undefined
            : this._startStallWatchdog(subscription, activeHandle, state, supervision.stallAfterMs);
        try {
          // Состояние надзора — ТОЛЬКО надзираемым: для `_pump` его наличие
          // и есть признак «этот поток восстановим». Передать его CLOB-у
          // значило бы молча превратить терминальный отказ в перезапуск.
          await this._pump(
            subscription,
            activeHandle,
            toMessage,
            closed,
            supervision === undefined ? undefined : state,
          );
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
        if (supervision === undefined) {
          // Ненадзираемая (CLOB) подписка кончилась САМА. Watchdog ей не
          // нужен — тихий стакан это норма, — но штатное завершение
          // ИТЕРАТОРА тишиной не является: физическая подписка исчезла, а
          // контроллер продолжает считать рынок ACTIVE. Это тот же класс
          // бесшумно неполного датасета, что нашёл прогон 2026-09-06, только
          // на CLOB. Переподписываться здесь нельзя (владение рынками — не
          // забота source), поэтому единственный честный исход — терминальный
          // отказ: он поднимает hasFailed, и контур пересобирает подписки.
          this._logger.error('Polymarket subscription ended unexpectedly, failing source', {
            subscription,
          });
          await this._fail();
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
      this._supervised.delete(subscription);
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
   * Возвращает диагностику непрерывности надзираемых подписок.
   *
   * @returns Снимок по каждой живой RTDS-подписке
   *
   * @remarks
   * Отвечает на вопрос, на который НЕ отвечает счётчик подписок: фид может
   * числиться открытым и при этом ничего не приносить. Ref-count говорит
   * «сколько мы хотим», а этот снимок — «сколько реально живо».
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
          restarts: state.restarts,
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
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const silentSince = state.lastEventAtMs ?? startedAt;
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
        const handle = await supervision.reopen();
        if (abandoned()) {
          // Handle открылся одновременно с release: он не должен стать
          // активным ни на секунду — закрываем и уходим.
          await this._closeHandle(subscription, handle);
          return undefined;
        }
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
      if (supervisionState !== undefined) {
        // Надзираемый фид восстановим: падение итератора — такой же обрыв
        // транспорта, как штатное завершение и тишина, и лечится тем же
        // путём. Ронять весь source значило бы закрыть CLOB и остальные
        // RTDS-потоки из-за одного упавшего прайс-фида — цена несоразмерна
        // потере, а восстановление у нас есть.
        this._logger.warn('Polymarket subscription stream failed, restarting', {
          subscription,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this._logger.error('Polymarket subscription stream failed, failing source', {
        subscription,
        error: error instanceof Error ? error.message : String(error),
      });
      await this._fail();
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

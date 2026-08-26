/**
 * PolymarketSource — тонкий ingress boundary над официальным `@polymarket/client`.
 *
 * @remarks
 * ### Поток данных
 *
 * ```text
 * официальный SDK (client.subscribe → AsyncIterable)
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
 *   принадлежат официальному SDK (проверено в 0.6.0: realtime-транспорт
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
 * Subscription handle официального SDK — структурное зеркало его контракта.
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
 * Subscribe-возможность официального SDK-клиента, которую использует Source.
 *
 * @remarks
 * Тип выведен НАПРЯМУЮ из официального `PublicClient`
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
 * const client = createPublicClient();          // официальный SDK
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
 * Ownership: composition root создаёт ОДИН официальный public client и ОДИН
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
 * Ingress boundary Polymarket V2: официальные SDK-события → canonical
 * ExternalMessages → общий ExternalMessageBus.
 *
 * @remarks
 * ### Ответственность (и только она)
 *
 * 1. открыть подписки через официальный SDK;
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
    return this._track(topic, handle, (event) => this._toCryptoMessage(event));
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
    const subscription = `${CHAINLINK_TWAP_TOPIC}:${String(windowSeconds)}`;
    if (this._closed || this._failed) {
      return this._discardLateSubscription(subscription, handle);
    }
    this._logger.info('Polymarket Chainlink TWAP subscription opened', {
      topic: CHAINLINK_TWAP_TOPIC,
      windowSeconds,
      symbolCount: symbols.length,
    });
    return this._track(subscription, handle, (event) => this._toTwapMessage(event));
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
   * @returns Открытая подписка с индивидуальным close
   *
   * @remarks
   * Pump-promise хранится до завершения: `close()` через него гарантирует
   * отсутствие висящих итераторов. Сам pump никогда не reject-ится —
   * все ошибки обрабатываются внутри (см. {@link PolymarketSource._pump}).
   */
  private _track<TEvent>(
    subscription: string,
    handle: PolymarketSubscriptionHandle<TEvent>,
    toMessage: (event: TEvent) => PolymarketExternalMessage,
  ): PolymarketOpenSubscription {
    this._handles.add(handle);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this._handleCloseSignals.set(handle, resolveClosed);
    const pump = this._pump(subscription, handle, toMessage, closed).finally(() => {
      this._handles.delete(handle);
      this._handleCloseSignals.delete(handle);
      this._pumps.delete(pump);
    });
    this._pumps.add(pump);
    return {
      close: async () => {
        await this._closeHandle(subscription, handle);
        await pump;
        this._logger.info('Polymarket subscription closed', { subscription });
      },
    };
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
   *   транспорта и логируется debug-ом; до `close()` — терминальный отказ;
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
  ): Promise<void> {
    const closedMarker = closed.then((): typeof PUMP_CLOSED => PUMP_CLOSED);
    try {
      for await (const event of handle) {
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
    await this._closeAllHandles();
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

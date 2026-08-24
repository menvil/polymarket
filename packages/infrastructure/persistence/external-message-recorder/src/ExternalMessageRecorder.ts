/**
 * ExternalMessageRecorder — recording-подписчик общего ExternalMessageBus.
 *
 * @remarks
 * ### Место в архитектуре (N-002)
 *
 * ```text
 * @polymarket/client
 *        ↓
 * PolymarketSource                ← НЕ знает о Recorder
 *        ↓
 * ExternalMessage {type, payload, metadata}
 *        ↓
 * общий ExternalMessageBus
 *        ↓ subscribe('POLYMARKET_*')
 * ExternalMessageRecorder (этот класс)   ← независимый consumer
 *        ↓ message.payload  (ТОЛЬКО payload, без outer envelope)
 * DataRecorder / storage
 *        ↓
 * market JSONL file (.jsonl → .jsonl.gz)
 * ```
 *
 * ### Разделение ответственности (ingestion vs storage)
 *
 * Этот класс — ТОЛЬКО ingestion/routing:
 * - подписывается на typed Polymarket-сообщения общего bus;
 * - маршрутизирует market-события по source market id (`payload.market` ==
 *   conditionId == `String(marketMeta.marketId)` — доказано аудитом
 *   PolymarketMarketDiscoveryAdapter);
 * - маршрутизирует RTDS-события по точному ключу `(topic, symbol)` —
 *   БЕЗ эвристик формата символа;
 * - передаёт в storage НЕИЗМЕНЁННЫЙ `message.payload`.
 *
 * Buffering/flush/gzip/header/cleanup — ответственность storage
 * (`DataRecorder`), сюда не дублируются.
 *
 * ### Payload-only инвариант
 *
 * На диск попадает ТОЛЬКО `message.payload` (source-native SDK event):
 * canonical runtime metadata (`messageId`/`sequence`/`correlationId`/...) и
 * внешний routing discriminator (`POLYMARKET_MARKET`) принадлежат live
 * execution и НЕ записываются. Будущий Reader создаст НОВЫЙ ExternalMessage
 * вокруг того же payload — semantic adapter в live и replay получает
 * идентичное source-native представление.
 *
 * ### Policy отказов
 *
 * Recorder — optional/non-trading consumer: ошибка записи наблюдаема
 * (лог + счётчики {@link ExternalMessageRecorderStats}), но НЕ уничтожает
 * PolymarketSource, не останавливает bus и не мешает будущему SemanticAdapter.
 * Handlers синхронные и никогда не бросают.
 */
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type { IExternalMessageBus } from '@polymarket/external-message-bus';
import type { CexWindowRecorder, DataRecorder } from '@polymarket/data-collection';
import type {
  CryptoPricesTopic,
  PolymarketCryptoBinanceExternalMessage,
  PolymarketCryptoChainlinkExternalMessage,
  PolymarketExternalMessage,
  PolymarketMarketExternalMessage,
} from '@polymarket/polymarket-v2';
import type {
  CexExternalMessage,
  CexOrderbookExternalMessage,
  CexTradeExternalMessage,
} from '@polymarket/cex-v2';

/**
 * Точный ключ маршрутизации одного RTDS-фида в файл рынка.
 *
 * @remarks
 * Источник определяется по vendor `topic`-дискриминатору SDK
 * (`prices.crypto.binance` / `prices.crypto.chainlink`), а НЕ по формату
 * символа: эвристика `symbol.includes('/')` из legacy-коллектора сюда
 * сознательно не переносится. `symbol` сравнивается точно (Binance —
 * `btcusdt`, Chainlink — `btc/usd`, как в подписке Source).
 */
export interface PolymarketRtdsFeedKey {
  /** Vendor topic RTDS-фида (дискриминатор источника). */
  readonly topic: CryptoPricesTopic;
  /** Точный символ фида в нативном формате источника. */
  readonly symbol: string;
}

/**
 * Регистрация recording-сессии одного Polymarket-рынка.
 *
 * @remarks
 * Recorder НЕ решает, какие символы нужны рынку — готовую routing-регистрацию
 * ему передаёт вызывающий (будущий Market Discovery/Coordinator N-003).
 * `marketMeta` — существующий storage-контракт (`registerMarket`): recorder
 * не добавляет собственного дубликата source market id, потому что
 * `String(marketMeta.marketId)` УЖЕ равен conditionId — routing identity
 * SDK-событий (`payload.market`).
 */
export interface PolymarketRecordingRegistration {
  /** Метаданные рынка для storage (header/файл/активация по startsAt). */
  readonly marketMeta: MarketMeta;
  /** RTDS-фиды, наблюдения которых записываются в файл этого рынка. */
  readonly rtdsFeeds?: readonly PolymarketRtdsFeedKey[];
}

/**
 * Порт подписки recorder-а на общий ExternalMessageBus.
 *
 * @remarks
 * Структурное подмножество `IExternalMessageBus` (только `subscribe`):
 * recorder НЕ владеет bus и не имеет права на `publish`/`drain`/`close` —
 * lifecycle bus принадлежит composition root. Узкий тип также позволяет
 * передать сюда bus, параметризованный БОЛЕЕ ШИРОКИМ union-ом sources
 * (`PolymarketExternalMessage | CexExternalMessage | ...`): typed
 * `subscribe` контравариантен по union и сужает payload по конкретному
 * discriminator-у подписки.
 */
export type PolymarketRecordingBusSubscription = Pick<
  IExternalMessageBus<PolymarketExternalMessage>,
  'subscribe'
>;

/**
 * Порт storage-движка market-файлов, который использует recorder.
 *
 * @remarks
 * Структурное подмножество `DataRecorder` (`@polymarket/data-collection`) —
 * единственный источник истины по buffering/flush/gzip/header/cleanup.
 * Второй storage-движок не реализуется (N-002 PART 1: reuse, do not rewrite).
 */
export type PolymarketRecordingStorage = Pick<
  DataRecorder,
  | 'registerMarket'
  | 'recordMarketEvent'
  | 'sealMarket'
  | 'updateMarketMeta'
  | 'finalizeMarket'
  | 'flush'
  | 'cleanup'
  | 'close'
>;

/**
 * Порт подписки recorder-а на CEX-типы общего bus.
 *
 * @remarks
 * То же правило, что у {@link PolymarketRecordingBusSubscription}:
 * структурное подмножество (`subscribe`), контравариантное по union — сюда
 * передаётся ТОТ ЖЕ общий bus контура, параметризованный
 * `PolymarketExternalMessage | CexExternalMessage`. Второго bus нет:
 * оба порта CEX-конфигурации указывают на один объект.
 */
export type CexRecordingBusSubscription = Pick<
  IExternalMessageBus<CexExternalMessage>,
  'subscribe'
>;

/**
 * Порт оконного storage-движка CEX-партиций.
 *
 * @remarks
 * Структурное подмножество `CexWindowRecorder`
 * (`@polymarket/data-collection`) — единственный источник истины по
 * window/buffer/gzip/cleanup CEX-политики. Регистраций у CEX-потока нет:
 * routing-идентичность (`exchangeId`/`symbol`/`marketType` + тип потока)
 * приходит в каждом typed payload.
 */
export type CexRecordingStorage = Pick<CexWindowRecorder, 'start' | 'write' | 'flush' | 'close'>;

/**
 * CEX-конфигурация recorder-а: подписка на общем bus + оконный storage.
 *
 * @remarks
 * Опциональная политика ТОГО ЖЕ сервиса (не второй Recorder): при
 * отсутствии конфигурации CEX-подписки не создаются, Polymarket-путь
 * не меняется. Ownership: bus принадлежит composition root; оконный
 * storage — recorder-у (закрывается в {@link ExternalMessageRecorder.close}).
 */
export interface ExternalMessageRecorderCexDependencies {
  /** Общий bus контура (порт CEX-подписок того же объекта bus). */
  readonly bus: CexRecordingBusSubscription;
  /** Оконный storage-движок CEX-партиций. */
  readonly storage: CexRecordingStorage;
}

/**
 * Зависимости {@link ExternalMessageRecorder}.
 *
 * @remarks
 * Ownership: bus принадлежит composition root (recorder только подписывается
 * и отписывается); storage-движок принадлежит recorder-у — он его
 * единственный писатель и закрывает его в {@link ExternalMessageRecorder.close}.
 */
export interface ExternalMessageRecorderDependencies {
  /** Общий bus внешнего контура (используется только `subscribe`). */
  readonly bus: PolymarketRecordingBusSubscription;
  /** Storage-движок market-файлов (обычно `DataRecorder` с `formatVersion: 2`). */
  readonly storage: PolymarketRecordingStorage;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
  /**
   * Опциональная CEX-политика ТОГО ЖЕ сервиса: typed-подписки
   * `CEX_ORDERBOOK`/`CEX_TRADE` на том же общем bus + оконный storage.
   * Без неё recorder ведёт себя ровно как в N-002..N-004.
   */
  readonly cex?: ExternalMessageRecorderCexDependencies;
}

/**
 * Диагностические счётчики recorder-а (loss visibility, PART 17).
 */
export interface ExternalMessageRecorderStats {
  /** Market-сообщений сматчено с recording-сессией. */
  readonly marketMessagesRouted: number;
  /** RTDS-сообщений сматчено хотя бы с одной сессией (1 на сообщение). */
  readonly rtdsMessagesRouted: number;
  /** Строк принято storage в буфер записи (RTDS fan-out считается по файлам). */
  readonly recordsWritten: number;
  /** Строк сознательно пропущено activation policy (до startsAt). */
  readonly recordsSkippedInactive: number;
  /** Отказов записи storage: сериализация/активация/stream (залогированы storage). */
  readonly serializationFailures: number;
  /** Регистраций, отклонённых storage (writer не установлен; retryable). */
  readonly registrationFailures: number;
  /** Market-сообщений без зарегистрированной сессии (например, после finalize). */
  readonly unroutedMarketMessages: number;
  /** RTDS-сообщений без единого зарегистрированного (topic, symbol). */
  readonly unroutedRtdsMessages: number;
  /** Неожиданных исключений в bus-handler-ах (защитный контур). */
  readonly handlerErrors: number;
}

/**
 * Диагностические счётчики CEX-политики (loss visibility).
 *
 * @remarks
 * Отдельная структура (а не расширение
 * {@link ExternalMessageRecorderStats}): Polymarket-контракт N-002
 * не меняется. Все счётчики равны 0, если CEX-политика не сконфигурирована.
 *
 * ВАЖНО про durability: `cexRecordsAccepted` — это «строка принята в
 * memory-буфер оконного storage» (hot path остаётся buffered/async), а НЕ
 * «строка durable в завершённой партиции». Судьба партиций видна в
 * счётчиках самого storage (`CexWindowRecorder.getStats()`:
 * partitionsCompleted / rotationFailures / streamCloseFailures /
 * compressionFailures) — их читает composition root, владеющий storage.
 */
export interface ExternalMessageRecorderCexStats {
  /** CEX-сообщений принято handler-ами (orderbook + trade). */
  readonly cexMessagesRouted: number;
  /** Строк ПРИНЯТО в memory-буфер оконного storage (не durability-факт). */
  readonly cexRecordsAccepted: number;
  /** Строк сознательно отброшено оконной политикой (до выравнивания/после close). */
  readonly cexRecordsDroppedInactive: number;
  /** Отказов приёма storage (сериализация/failed writer; залогированы storage). */
  readonly cexWriteFailures: number;
  /** Неожиданных исключений в CEX bus-handler-ах (защитный контур). */
  readonly cexHandlerErrors: number;
}

/**
 * Активная recording-сессия рынка (внутреннее состояние маршрутизации).
 */
interface RecordingSession {
  /** ID рынка — ключ writer-а в storage. */
  readonly marketId: MarketId;
  /** RTDS-фиды сессии (для снятия routing при finalize). */
  readonly rtdsFeeds: readonly PolymarketRtdsFeedKey[];
}

/**
 * Собирает точный routing-ключ RTDS-фида.
 *
 * @param topic - Vendor topic (typed union SDK — narrowing вызывающих
 *   не расширяется до plain string)
 * @param symbol - Точный символ фида
 * @returns Составной ключ `(topic, symbol)` для Map
 */
function rtdsRoutingKey(topic: CryptoPricesTopic, symbol: string): string {
  return `${topic}\n${symbol}`;
}

/**
 * Recording-подписчик общего ExternalMessageBus: персистит source-native
 * `message.payload` Polymarket-сообщений в market-файлы через storage-движок.
 *
 * @remarks
 * ### Lifecycle
 *
 * ```text
 * start()            → подписка на POLYMARKET_MARKET / _CRYPTO_BINANCE / _CRYPTO_CHAINLINK
 * registerMarket()   → storage.registerMarket + routing (market + RTDS)
 * ... запись ...
 * finalizeMarket()   → снятие routing + storage.finalizeMarket (flush → gzip)
 * close()            → отписка от bus + storage.close() (идемпотентен)
 * ```
 *
 * Порядок shutdown контура (composition root):
 * 1. `source.close()` — остановить продьюсера;
 * 2. `bus.drain()` — доставить оставшиеся наблюдения (в т.ч. recorder-у);
 * 3. `recorder.close()` — отписаться и закрыть storage;
 * 4. `bus.close()` — закрыть общий bus (владелец — composition root).
 *
 * ### Hot path дёшев (PART 16)
 *
 * Bus-handler синхронный: route lookup → `JSON.stringify` + push в память —
 * и возврат. Disk flush остаётся асинхронным (threshold/периодический таймер
 * внутри storage); per-message fsync нет.
 *
 * @example
 * ```typescript
 * const storage = new DataRecorder(
 *   { ...DEFAULT_RECORDER_CONFIG, sourceSubDir: 'polymarket', formatVersion: 2 },
 *   new NDJSONFormatter(),
 *   new GzipCompressor(),
 *   logger,
 * );
 * const recorder = new ExternalMessageRecorder({ bus, storage, logger });
 * recorder.start();
 * recorder.registerMarket({
 *   marketMeta: { marketId, question, tokenIds, startsAt, expiresAt, rawMarket },
 *   rtdsFeeds: [
 *     { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
 *     { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
 *   ],
 * });
 * // ... рынок истёк:
 * await recorder.finalizeMarket(marketId, 'EXPIRED');
 * // shutdown:
 * await recorder.close();
 * ```
 */
export class ExternalMessageRecorder {
  private readonly _bus: PolymarketRecordingBusSubscription;
  private readonly _storage: PolymarketRecordingStorage;
  private readonly _cex: ExternalMessageRecorderCexDependencies | undefined;
  private readonly _logger: ILogger;

  /** Активные сессии: sourceMarketId (== String(marketId) == conditionId) → сессия. */
  private readonly _sessions = new Map<string, RecordingSession>();
  /** RTDS routing: `(topic, symbol)` → сессии, пишущие этот фид. */
  private readonly _rtdsRouting = new Map<string, Set<RecordingSession>>();
  /** Disposer-ы bus-подписок (recorder владеет только СВОИМИ подписками). */
  private _disposers: Array<() => void> = [];

  private _started = false;
  private _closed = false;
  /** Promise первого close() — повторные вызовы ждут его же. */
  private _closePromise: Promise<void> | null = null;
  /**
   * In-flight финализации: `close()` обязан дождаться их ДО `storage.close()`,
   * иначе shutdown-cleanup может удалить файл прямо во время его финализации.
   */
  private readonly _pendingFinalizations = new Set<Promise<void>>();

  // Счётчики ExternalMessageRecorderStats (mutable-состояние диагностики)
  private _marketMessagesRouted = 0;
  private _rtdsMessagesRouted = 0;
  private _recordsWritten = 0;
  private _recordsSkippedInactive = 0;
  private _serializationFailures = 0;
  private _registrationFailures = 0;
  private _unroutedMarketMessages = 0;
  private _unroutedRtdsMessages = 0;
  private _handlerErrors = 0;

  // Счётчики ExternalMessageRecorderCexStats (0, если политика отсутствует)
  private _cexMessagesRouted = 0;
  private _cexRecordsAccepted = 0;
  private _cexRecordsDroppedInactive = 0;
  private _cexWriteFailures = 0;
  private _cexHandlerErrors = 0;

  /**
   * Создаёт recorder поверх инъецированных bus/storage.
   *
   * @param deps - Зависимости (см. {@link ExternalMessageRecorderDependencies})
   */
  constructor(deps: ExternalMessageRecorderDependencies) {
    this._bus = deps.bus;
    this._storage = deps.storage;
    this._cex = deps.cex;
    this._logger = deps.logger.child({ component: 'ExternalMessageRecorder' });
  }

  /** true после {@link ExternalMessageRecorder.close}. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Подписывается на Polymarket-типы общего bus.
   *
   * @throws {Error} Если recorder уже закрыт
   *
   * @remarks
   * Идемпотентен (повторный вызов — no-op). Подписки строго typed —
   * catch-all `AnyExternalMessage` не используется, narrowing payload
   * сохраняется компилятором.
   */
  public start(): void {
    if (this._closed) {
      throw new Error('ExternalMessageRecorder is closed and cannot start');
    }
    if (this._started) {
      return;
    }
    this._disposers.push(
      this._bus.subscribe('POLYMARKET_MARKET', (message) => this._onMarketMessage(message)),
      this._bus.subscribe('POLYMARKET_CRYPTO_BINANCE', (message) => this._onRtdsMessage(message)),
      this._bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', (message) => this._onRtdsMessage(message)),
    );
    if (this._cex) {
      // CEX-политика: оконный storage стартует (выравнивание по границе),
      // подписки — на ТОМ ЖЕ общем bus
      this._cex.storage.start();
      this._disposers.push(
        this._cex.bus.subscribe('CEX_ORDERBOOK', (message) => this._onCexOrderbook(message)),
        this._cex.bus.subscribe('CEX_TRADE', (message) => this._onCexTrade(message)),
      );
    }
    this._started = true;
    this._logger.info('ExternalMessageRecorder subscribed to external message bus', {
      cexPolicy: this._cex !== undefined,
    });
  }

  /**
   * Регистрирует recording-сессию рынка: storage writer + routing.
   *
   * @param registration - Готовая routing-регистрация (см.
   *   {@link PolymarketRecordingRegistration})
   * @returns `true` — сессия установлена (или уже была зарегистрирована);
   *   `false` — регистрация отклонена (recorder закрыт либо storage не
   *   установил writer) — состояние НЕ создано, вызов можно повторить
   *
   * @remarks
   * Идемпотентен по `String(marketMeta.marketId)` (зеркалит storage).
   * Активация по `startsAt` — существующая policy storage: события до
   * активации не записываются; recorder новой scheduling-policy не вводит.
   * После `close()` регистрация отклоняется (warn) — новые файлы после
   * shutdown не создаются.
   *
   * Если storage ОТКЛОНИЛ регистрацию (writer не установлен — I/O-отказ),
   * routing-состояние НЕ создаётся: сессия без writer-а маршрутизировала бы
   * события в никуда. Отказ наблюдаем (error-лог + `registrationFailures`)
   * и retryable — повторный вызов попробует зарегистрировать заново.
   */
  public registerMarket(registration: PolymarketRecordingRegistration): boolean {
    const key = String(registration.marketMeta.marketId);
    if (this._closed) {
      this._logger.warn('Market registration ignored: recorder is closed', { marketId: key });
      return false;
    }
    if (this._sessions.has(key)) {
      this._logger.debug('Recording session already registered, skipping', { marketId: key });
      return true;
    }

    // Hook отложенной активации замыкает КОНКРЕТНУЮ session этой регистрации:
    // storage вызовет его, если активация по таймеру startsAt упала и
    // регистрация уже освобождена. Инвалидация identity-guarded — если сессию
    // под ключом успели заменить/убрать, чужое состояние не трогается.
    const session: RecordingSession = {
      marketId: registration.marketMeta.marketId,
      rtdsFeeds: [...(registration.rtdsFeeds ?? [])],
    };
    const installed = this._storage.registerMarket(registration.marketMeta, () => {
      this._invalidateSessionAfterDelayedActivationFailure(key, session);
    });
    if (!installed) {
      this._registrationFailures++;
      this._logger.error('Recording session rejected: storage failed to install market writer', {
        marketId: key,
        question: registration.marketMeta.question,
      });
      return false;
    }

    this._sessions.set(key, session);
    for (const feed of session.rtdsFeeds) {
      const routingKey = rtdsRoutingKey(feed.topic, feed.symbol);
      let sessions = this._rtdsRouting.get(routingKey);
      if (!sessions) {
        sessions = new Set();
        this._rtdsRouting.set(routingKey, sessions);
      }
      sessions.add(session);
    }

    this._logger.info('Recording session registered', {
      marketId: key,
      question: registration.marketMeta.question,
      rtdsFeeds: session.rtdsFeeds.map((feed) => `${feed.topic}:${feed.symbol}`),
    });
    return true;
  }

  /**
   * Инвалидирует сессию после асинхронного отказа отложенной активации storage.
   *
   * @param key - Ключ сессии (`String(marketId)`)
   * @param session - Именно та сессия, что была установлена при регистрации
   *
   * @remarks
   * Storage уже освободил свою регистрацию (writer удалён) — recorder обязан
   * убрать stale routing, иначе слои разъедутся: сессия без writer-а
   * маршрутизировала бы события в `'unregistered'` вечно. Инвалидация
   * identity-guarded (`_sessions.get(key) === session`): более новая сессия
   * перерегистрированного рынка не затрагивается. RTDS routing снимается
   * той же per-feed логикой, что и при finalize — чужие рынки на общем фиде
   * продолжают записываться. Идемпотентна; после `close()` — no-op (maps уже
   * очищены). Отказ учитывается в `registrationFailures` — повторный
   * `registerMarket` выполнит настоящую новую регистрацию.
   */
  private _invalidateSessionAfterDelayedActivationFailure(
    key: string,
    session: RecordingSession,
  ): void {
    if (this._closed) {
      return;
    }
    if (this._sessions.get(key) !== session) {
      return; // finalize/close/перерегистрация уже убрали или заменили сессию
    }
    this._sessions.delete(key);
    this._removeRtdsRouting(session);
    this._registrationFailures++;
    this._logger.error('Recording session invalidated: delayed storage activation failed', {
      marketId: key,
    });
  }

  /**
   * Замораживает payload-датасет рынка, снимая его realtime-маршрутизацию.
   *
   * @param marketId - ID рынка
   * @returns `true` — датасет заморожен (или был); `false` — recorder закрыт
   *   либо storage не знает такой writer
   *
   * @remarks
   * Expiry-переход N-004 (PART 7): market/RTDS routing recording-сессии
   * снимается НЕМЕДЛЕННО (новые ExternalMessages не попадают в payload),
   * storage замораживает файл ({@link DataRecorder.sealMarket}), но writer
   * СОХРАНЯЕТСЯ — доступны {@link ExternalMessageRecorder.updateMarketMeta}
   * (enrichment header-а) и {@link ExternalMessageRecorder.finalizeMarket}
   * с reason `'EXPIRED'` (архив). Общие RTDS-фиды других рынков не
   * затрагиваются (per-feed removal). Идемпотентен на уровне storage.
   */
  public async sealMarket(marketId: MarketId): Promise<boolean> {
    const key = String(marketId);
    if (this._closed) {
      this._logger.warn('Market seal ignored: recorder is closed', { marketId: key });
      return false;
    }
    const session = this._sessions.get(key);
    if (session) {
      this._sessions.delete(key);
      this._removeRtdsRouting(session);
    }
    const sealed = await this._storage.sealMarket(marketId);
    this._logger.info('Recording session sealed', { marketId: key, storageSealed: sealed });
    return sealed;
  }

  /**
   * Обновляет first-line header рынка (opaque market metadata).
   *
   * @param marketId - ID рынка
   * @param updatedRawMarket - Обновлённые сырые данные рынка
   * @returns `true` — header фактически перезаписан storage-ом; `false` —
   *   recorder закрыт либо storage пропустил обновление (наблюдаемый
   *   контракт N-004 PART 26 — finalizer не объявляет успех без записи)
   * @throws При ошибке I/O storage
   *
   * @remarks
   * Passthrough в storage: recorder НЕ ходит в Gamma сам (PART 11) — данные
   * приносит вызывающий (Market Finalizer/Coordinator). Работает и для
   * SEALED-датасета (writable header ≠ приём payload-записей).
   */
  public async updateMarketMeta(
    marketId: MarketId,
    updatedRawMarket: Record<string, unknown>,
  ): Promise<boolean> {
    if (this._closed) {
      this._logger.warn('Market meta update ignored: recorder is closed', {
        marketId: String(marketId),
      });
      return false;
    }
    return this._storage.updateMarketMeta(marketId, updatedRawMarket);
  }

  /**
   * Завершает recording-сессию: снимает routing и финализирует файл.
   *
   * @param marketId - ID рынка
   * @param reason - `'EXPIRED'` — завершённый dataset (flush → gzip-архив);
   *   `'SHUTDOWN'` — незавершённый dataset (файл удаляется storage, архива нет)
   * @returns Promise завершения финализации
   * @throws При ошибке I/O storage
   *
   * @remarks
   * Routing снимается ДО финализации: события, пришедшие после вызова,
   * считаются unrouted и не пишутся. Буфер EXPIRED не теряется — storage
   * флашит его перед gzip.
   *
   * Финализация отслеживается как in-flight: {@link ExternalMessageRecorder.close}
   * дождётся её ДО закрытия storage (иначе shutdown-cleanup мог бы удалить
   * файл во время финализации). После `close()` новые финализации
   * отклоняются (warn) — storage уже закрывается/закрыт.
   */
  public async finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const key = String(marketId);
    if (this._closed) {
      this._logger.warn('Market finalization ignored: recorder is closed', {
        marketId: key,
        reason,
      });
      return;
    }

    const session = this._sessions.get(key);
    if (session) {
      this._sessions.delete(key);
      this._removeRtdsRouting(session);
    }

    // Синхронно (до первого await) регистрируем in-flight операцию:
    // close(), вызванный позже в этом же тике, гарантированно её увидит
    const tracked: Promise<void> = this._storage.finalizeMarket(marketId, reason).finally(() => {
      this._pendingFinalizations.delete(tracked);
    });
    this._pendingFinalizations.add(tracked);
    return tracked;
  }

  /**
   * Возвращает снимок диагностических счётчиков.
   *
   * @returns Текущие значения {@link ExternalMessageRecorderStats}
   */
  public getStats(): ExternalMessageRecorderStats {
    return {
      marketMessagesRouted: this._marketMessagesRouted,
      rtdsMessagesRouted: this._rtdsMessagesRouted,
      recordsWritten: this._recordsWritten,
      recordsSkippedInactive: this._recordsSkippedInactive,
      serializationFailures: this._serializationFailures,
      registrationFailures: this._registrationFailures,
      unroutedMarketMessages: this._unroutedMarketMessages,
      unroutedRtdsMessages: this._unroutedRtdsMessages,
      handlerErrors: this._handlerErrors,
    };
  }

  /**
   * Возвращает снимок счётчиков CEX-политики.
   *
   * @returns Текущие значения {@link ExternalMessageRecorderCexStats}
   *   (все нули, если политика не сконфигурирована)
   */
  public getCexStats(): ExternalMessageRecorderCexStats {
    return {
      cexMessagesRouted: this._cexMessagesRouted,
      cexRecordsAccepted: this._cexRecordsAccepted,
      cexRecordsDroppedInactive: this._cexRecordsDroppedInactive,
      cexWriteFailures: this._cexWriteFailures,
      cexHandlerErrors: this._cexHandlerErrors,
    };
  }

  /**
   * Закрывает recorder: отписка от bus + закрытие storage.
   *
   * @returns Promise завершения shutdown
   *
   * @remarks
   * Идемпотентен (повторные вызовы ждут первый). Общий bus НЕ закрывается —
   * им владеет composition root. Перед закрытием storage дожидается ВСЕХ
   * in-flight финализаций (`allSettled` — чужая упавшая финализация не
   * роняет shutdown): иначе cleanup мог бы удалить файл, который прямо
   * сейчас финализируется. Storage закрывается здесь: recorder — его
   * единственный писатель; незавершённые файлы удаляются существующей
   * cleanup-policy storage, завершённые `.jsonl.gz` не трогаются.
   * Сообщения и финализации после close игнорируются (подписки сняты +
   * guards) — новые файлы/буферы не создаются.
   */
  public async close(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }
    this._closed = true;
    for (const dispose of this._disposers) {
      dispose();
    }
    this._disposers = [];
    this._sessions.clear();
    this._rtdsRouting.clear();

    this._closePromise = (async () => {
      // Дожидаемся in-flight финализаций ДО закрытия storage (cleanup)
      await Promise.allSettled([...this._pendingFinalizations]);
      await this._storage.close();
      // Оконный CEX-storage принадлежит recorder-у: закрывается тем же
      // shutdown-ом (незавершённые окна удаляет его собственная policy)
      await this._cex?.storage.close();
      this._logger.info('ExternalMessageRecorder closed');
    })();
    return this._closePromise;
  }

  /**
   * Handler market-сообщений: маршрутизация по source market id.
   *
   * @param message - Typed сообщение `POLYMARKET_MARKET`
   *
   * @remarks
   * Каждый вариант `StandardMarketEvent` (`book`/`price_change`/
   * `last_trade_price`/`tick_size_change`) несёт `payload.market`
   * (conditionId) — payload записывается ОДИН РАЗ в файл этого рынка;
   * `price_change` с изменениями нескольких tokenIds не разбивается.
   * Никогда не бросает.
   */
  private _onMarketMessage(message: PolymarketMarketExternalMessage): void {
    if (this._closed) {
      return;
    }
    try {
      const sourceMarketId = message.payload.payload.market;
      const session = this._sessions.get(sourceMarketId);
      if (!session) {
        this._unroutedMarketMessages++;
        return;
      }
      this._marketMessagesRouted++;
      this._recordPayload(session, message.payload);
    } catch (error) {
      this._handlerErrors++;
      this._logger.error('Market message recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handler RTDS-сообщений: маршрутизация по точному `(topic, symbol)`.
   *
   * @param message - Typed сообщение `POLYMARKET_CRYPTO_BINANCE` или
   *   `POLYMARKET_CRYPTO_CHAINLINK`
   *
   * @remarks
   * Один RTDS-фид может использоваться несколькими активными рынками —
   * payload записывается в файл КАЖДОЙ подписанной сессии (ровно одна
   * строка на файл на входное сообщение). Источник различается vendor
   * `topic`-дискриминатором, эвристика формата символа не используется.
   * Никогда не бросает.
   *
   * Ошибки storage изолируются НА КАЖДОЕ направление fan-out независимо:
   * отказ записи для одного рынка не лишает события остальные подписанные
   * рынки (storage failure — non-fatal, но наблюдаем: лог + `handlerErrors`).
   */
  private _onRtdsMessage(
    message: PolymarketCryptoBinanceExternalMessage | PolymarketCryptoChainlinkExternalMessage,
  ): void {
    if (this._closed) {
      return;
    }
    try {
      const routingKey = rtdsRoutingKey(message.payload.topic, message.payload.payload.symbol);
      const sessions = this._rtdsRouting.get(routingKey);
      if (!sessions || sessions.size === 0) {
        this._unroutedRtdsMessages++;
        return;
      }
      this._rtdsMessagesRouted++;
      for (const session of sessions) {
        try {
          this._recordPayload(session, message.payload);
        } catch (error) {
          this._handlerErrors++;
          this._logger.error('RTDS recording failed for market, continuing fan-out', {
            marketId: String(session.marketId),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this._handlerErrors++;
      this._logger.error('RTDS message recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Передаёт payload storage-движку и учитывает исход в счётчиках.
   *
   * @param session - Recording-сессия рынка-адресата
   * @param payload - НЕИЗМЕНЁННЫЙ source-native payload сообщения
   *
   * @remarks
   * Payload уходит той же ссылкой — без clone/rename/flatten/normalize
   * (PART 13). `'unregistered'` при живой сессии — рассинхрон
   * session↔storage (finalize в обход recorder-а): логируется warn-ом.
   */
  private _recordPayload(
    session: RecordingSession,
    payload: PolymarketExternalMessage['payload'],
  ): void {
    const outcome = this._storage.recordMarketEvent(session.marketId, payload);
    switch (outcome) {
      case 'recorded':
        this._recordsWritten++;
        break;
      case 'inactive':
        this._recordsSkippedInactive++;
        break;
      case 'failed':
        // Ошибка сериализации уже залогирована storage
        this._serializationFailures++;
        break;
      case 'unregistered':
        this._logger.warn('Recording session exists but storage writer is missing', {
          marketId: String(session.marketId),
        });
        break;
      case 'sealed':
        // Рассинхрон session↔storage: seal обязан снимать routing ДО заморозки
        this._logger.warn('Recording session exists but storage writer is sealed', {
          marketId: String(session.marketId),
        });
        break;
    }
  }

  /**
   * Handler CEX-стаканов: typed payload → оконный storage.
   *
   * @param message - Typed сообщение `CEX_ORDERBOOK`
   *
   * @remarks
   * Регистраций нет: routing-идентичность (`exchangeId`/`symbol`/
   * `marketType`) несёт сам typed payload; тип потока задаёт партицию
   * (`orderbook`). В storage уходит НЕИЗМЕНЁННЫЙ `message.payload`
   * (payload-only инвариант N-002/PART 17). Никогда не бросает.
   */
  private _onCexOrderbook(message: CexOrderbookExternalMessage): void {
    if (this._closed || !this._cex) {
      return;
    }
    try {
      this._cexMessagesRouted++;
      const payload = message.payload;
      this._countCexOutcome(
        this._cex.storage.write(
          payload.exchangeId,
          payload.symbol,
          payload.marketType,
          'orderbook',
          payload,
        ),
      );
    } catch (error) {
      this._cexHandlerErrors++;
      this._logger.error('CEX orderbook recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handler CEX-сделок: typed payload → оконный storage (партиция `trades`).
   *
   * @param message - Typed сообщение `CEX_TRADE`
   */
  private _onCexTrade(message: CexTradeExternalMessage): void {
    if (this._closed || !this._cex) {
      return;
    }
    try {
      this._cexMessagesRouted++;
      const payload = message.payload;
      this._countCexOutcome(
        this._cex.storage.write(
          payload.exchangeId,
          payload.symbol,
          payload.marketType,
          'trades',
          payload,
        ),
      );
    } catch (error) {
      this._cexHandlerErrors++;
      this._logger.error('CEX trade recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Учитывает исход оконной записи в счётчиках CEX-политики. */
  private _countCexOutcome(outcome: 'recorded' | 'inactive' | 'failed'): void {
    switch (outcome) {
      case 'recorded':
        this._cexRecordsAccepted++;
        break;
      case 'inactive':
        this._cexRecordsDroppedInactive++;
        break;
      case 'failed':
        // Ошибка уже залогирована storage
        this._cexWriteFailures++;
        break;
    }
  }

  /**
   * Снимает RTDS-routing сессии (при finalize).
   *
   * @param session - Завершаемая сессия
   */
  private _removeRtdsRouting(session: RecordingSession): void {
    for (const feed of session.rtdsFeeds) {
      const routingKey = rtdsRoutingKey(feed.topic, feed.symbol);
      const sessions = this._rtdsRouting.get(routingKey);
      if (!sessions) {
        continue;
      }
      sessions.delete(session);
      if (sessions.size === 0) {
        this._rtdsRouting.delete(routingKey);
      }
    }
  }
}

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
 *        ↓ toRecordedObservation(message)  (конверт ВОКРУГ payload)
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
 * - маршрутизирует RTDS-события по точному ключу фида (`topic` + `symbol`,
 *   а для settlement-потока TWAP — ещё и окно усреднения) — БЕЗ эвристик
 *   формата символа;
 * - оборачивает сообщение в {@link RecordedExternalObservationV2}, НЕ трогая
 *   `message.payload`.
 *
 * Buffering/flush/gzip/header/cleanup — ответственность storage
 * (`DataRecorder`), сюда не дублируются.
 *
 * ### Инвариант Replayable Raw Format V2
 *
 * На диск попадает `{type, ingress, payload}`, где `payload` — тот же
 * source-native объект, что пришёл на шину (та же ссылка: без
 * clone/rename/flatten/normalize). Конверт добавляется СНАРУЖИ.
 *
 * `ingress` копируется напрямую из `message.metadata` того сообщения,
 * которое реально пришло recorder-у: `runId`, `sequence` и high-resolution
 * момент наблюдения. Без них после записи терялся бы точный порядок
 * наблюдений МЕЖДУ Polymarket-файлом и CEX-партициями — физически это
 * разные файлы, а vendor-timestamp-ы у них из разных часов.
 *
 * Live-only поля metadata (`messageId`/`correlationId`/`causationId`/
 * `createdAt`) НЕ записываются: они принадлежат execution конкретного
 * процесса, а не исторической временной линии. При replay сообщение получит
 * СВОЮ runtime metadata, а записанный `ingress` — вход для replay
 * scheduler-а.
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
import type {
  CexWindowRecordOutcome,
  CexWindowRecorder,
  DataRecorder,
} from '@polymarket/data-collection';
import { ingressEpochMilliseconds, toRecordedObservation } from '@polymarket/raw-archive-format';
import type { RecordedExternalObservationV2 } from '@polymarket/raw-archive-format';
import type {
  PolymarketCryptoBinanceExternalMessage,
  PolymarketCryptoChainlinkExternalMessage,
  PolymarketCryptoChainlinkTwapExternalMessage,
  PolymarketExternalMessage,
  PolymarketMarketExternalMessage,
  PolymarketRtdsFeed,
} from '@polymarket/polymarket-v2';
import { CHAINLINK_TWAP_TOPIC, rtdsFeedKey } from '@polymarket/polymarket-v2';
import type {
  CexExternalMessage,
  CexOrderbookExternalMessage,
  CexTradeExternalMessage,
} from '@polymarket/cex-v2';

/**
 * Точный ключ маршрутизации одного RTDS-фида в файл рынка.
 *
 * @remarks
 * Это ТОТ ЖЕ тип, которым discovery описывает фиды рынка
 * (`PolymarketRtdsFeed`), а не его структурный двойник: правило
 * идентичности фида обязано быть ОДНО на весь контур, иначе координатор
 * (ref-count подписок) и recorder (routing записи) разошлись бы в том,
 * что считается «тем же фидом».
 *
 * Источник определяется по vendor `topic`-дискриминатору SDK, а НЕ по
 * формату символа: эвристика `symbol.includes('/')` из legacy-коллектора
 * сюда сознательно не переносится. `symbol` сравнивается точно (Binance —
 * `btcusdt`, Chainlink — `btc/usd`, как в подписке Source), а у
 * settlement-потока TWAP в идентичность входит ещё и окно усреднения.
 */
export type PolymarketRtdsFeedKey = PolymarketRtdsFeed;

/**
 * Регистрация recording-сессии одного Polymarket-рынка.
 *
 * @remarks
 * Recorder НЕ решает, какие символы нужны рынку — готовую routing-регистрацию
 * ему передаёт вызывающий (`MarketCollectionCoordinator`, который берёт
 * фиды из settlement-метаданных выбранного рынка).
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
 * Порт ленивого допуска рынка к записи по ПЕРВОМУ наблюдению.
 *
 * @remarks
 * ### Зачем провайдер существует
 *
 * До Collector-cutover recording-сессии создавал `MarketCollectionCoordinator`
 * ДО открытия подписки (recorder-first): рынок регистрировался заранее, и
 * первое CLOB-событие уже попадало в готовую сессию. После cutover физические
 * подписки принадлежат общему control-plane (`collector:raw`), и recorder
 * НЕ знает заранее, какой рынок и когда пришлёт первое наблюдение.
 *
 * Провайдер закрывает ровно этот разрыв: когда `POLYMARKET_MARKET` приходит
 * для рынка БЕЗ активной сессии, recorder однократно спрашивает провайдера
 * «начинать ли запись этого рынка и с какой регистрацией». Провайдер (в
 * контуре collector — политика поверх `MarketUniverse`) отвечает готовой
 * {@link PolymarketRecordingRegistration} либо `undefined` (рынок не
 * интересен/неизвестен).
 *
 * ### Ключевой инвариант: первое наблюдение НЕ теряется
 *
 * Провайдер вызывается СИНХРОННО внутри обработчика того же сообщения:
 * `нет сессии → admit → registerMarket → записать ЭТО ЖЕ сообщение`. Между
 * созданием сессии и записью нет `await` и нет «начнём со следующего
 * сообщения» — именно это делает первое raw-наблюдение, инициировавшее
 * сессию, записанным, а не потерянным.
 *
 * ### Где НЕ вызывается
 *
 * Провайдер спрашивается ТОЛЬКО при отсутствии активной сессии. Для уже
 * активной сессии policy не пересчитывается — запись идёт напрямую (contract
 * «policy решает начать, а не продолжать»). RTDS-сообщения провайдер не
 * трогают вовсе: у них нет marketId, и лениво создать по ним сессию нельзя.
 *
 * @param sourceMarketId - `payload.market` входящего события (conditionId ==
 *   `String(marketMeta.marketId)`)
 * @returns Готовая регистрация — начать запись этого рынка; `undefined` —
 *   рынок игнорируется (сессия не создаётся, сообщение не пишется)
 */
export type PolymarketRecordingSessionProvider = (
  sourceMarketId: string,
) => PolymarketRecordingRegistration | undefined;

/**
 * Read-only снимок одной recording-сессии рынка.
 *
 * @remarks
 * Всё, что нужно lifecycle-слою, чтобы принять сессию под наблюдение:
 * identity рынка, стадия, регистрация (canonical header + `expiresAt`),
 * состав RTDS-фидов и момент первой записанной строки. Handles, буферы и
 * mutable-состояние recorder-а сюда не попадают.
 */
export interface PolymarketRecordingSessionSnapshot {
  /** Canonical id рынка (== conditionId). */
  readonly marketId: MarketId;
  /** Стадия сессии: `ACTIVE` → `FINALIZING` → `SEALED`. */
  readonly state: 'ACTIVE' | 'FINALIZING' | 'SEALED';
  /** Регистрация сессии: header (`rawMarket`), `expiresAt`, tokenIds. */
  readonly marketMeta: MarketMeta;
  /** Текущий состав RTDS-фидов, пишущихся в файл рынка. */
  readonly rtdsFeeds: readonly PolymarketRtdsFeedKey[];
  /** `ingress` первой записанной строки (epoch ms); нет — строк ещё нет. */
  readonly firstObservedAtMs?: number;
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
  | 'readSealedPayloadLines'
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
  /**
   * Опциональный ленивый допуск рынка к записи по первому наблюдению.
   *
   * @remarks
   * Без провайдера recorder ведёт себя как раньше: `POLYMARKET_MARKET` для
   * незарегистрированного рынка считается unrouted (регистрацию делает
   * внешний вызов `registerMarket`). С провайдером recorder сам спрашивает
   * его при отсутствии сессии — см. {@link PolymarketRecordingSessionProvider}.
   * Это точка расширения Collector-cutover, а не второй storage-путь: сама
   * запись, routing и counters — те же.
   */
  readonly sessionProvider?: PolymarketRecordingSessionProvider;
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
  /**
   * Сессий, созданных ленивым провайдером по первому наблюдению рынка.
   *
   * @remarks
   * Ненулевое значение означает, что запись рынков инициируется наблюдаемым
   * трафиком (Collector-cutover), а не внешним `registerMarket`. Каждая такая
   * сессия немедленно записывает то самое первое сообщение, что её создало.
   */
  readonly marketSessionsAdmitted: number;
  /**
   * Market-сообщений, СОЗНАТЕЛЬНО пропущенных провайдером (рынок не интересен
   * либо неизвестен).
   *
   * @remarks
   * Отдельно от `unroutedMarketMessages`: там — потеря при отсутствующей
   * сессии и БЕЗ провайдера; здесь — штатное решение политики «этот рынок мы
   * не собираем». Смешивать их значило бы читать нормальный игнор как потерю.
   * Ноль, если провайдер не сконфигурирован.
   */
  readonly marketMessagesIgnoredByPolicy: number;
  /**
   * Market-сообщений, отброшенных СОЗНАТЕЛЬНО после истечения рынка.
   *
   * @remarks
   * Отдельно от `unroutedMarketMessages`: там — потеря (сессии нет), здесь —
   * работающая по плану граница. Сессия истёкшего рынка живёт ещё несколько
   * секунд ради граничного наблюдения settlement-потока
   * ({@link ExternalMessageRecorder.narrowRtdsFeeds}), и CLOB-события,
   * долетевшие в это окно, в датасет уже не идут. Смешивать их с настоящей
   * потерей значило бы ослабить loss-visibility ровно там, где она нужна.
   */
  readonly marketMessagesDroppedAfterExpiry: number;
  /**
   * Market-сообщений, пришедших ПОСЛЕ заморозки датасета рынка.
   *
   * @remarks
   * Отдельно от `marketMessagesDroppedAfterExpiry`: там — окно settlement
   * grace (датасет ещё пишется, но только settlement-потоком), здесь —
   * окно между `sealMarket` и снятием физического claim-а. Ненулевое
   * значение — норма (claim снимается ПОСЛЕ заморозки), а вот запись после
   * seal была бы дефектом; их нельзя смешивать в одном числе.
   */
  readonly marketMessagesDroppedAfterSeal: number;
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
  /**
   * Наблюдений, чьё окно партиции УЖЕ было заархивировано.
   *
   * @remarks
   * Отдельно от `cexRecordsDroppedInactive`: там — штатная политика
   * («окно ещё не начиналось» / «recorder закрыт»), здесь — настоящая
   * потеря наблюдения, чей ingress попал в завершённое окно.
   */
  readonly cexRecordsDroppedLate: number;
  /** Отказов приёма storage (сериализация/failed writer; залогированы storage). */
  readonly cexWriteFailures: number;
  /** Неожиданных исключений в CEX bus-handler-ах (защитный контур). */
  readonly cexHandlerErrors: number;
}

/**
 * Стадия recording-сессии рынка.
 *
 * @remarks
 * ```text
 * ACTIVE ── beginMarketFinalization ──► FINALIZING ── sealMarket ──► SEALED
 *   │              (CLOB и обычные          │       (payload заморожен)
 *   │               RTDS больше не          │
 *   │               пишутся; остаётся       └── finalizeMarket ──► сессии нет
 *   │               settlement TWAP)
 *   └── finalizeMarket(SHUTDOWN) ──────────────────────────────► сессии нет
 * ```
 *
 * `SEALED` существует как ЯВНАЯ стадия, а не как удаление сессии: между
 * заморозкой датасета и снятием физического claim-а рынок ещё присылает
 * события, и без стадии-надгробия ленивый допуск создал бы для них ВТОРУЮ
 * recording-сессию поверх уже завершённого датасета.
 */
type RecordingSessionState = 'ACTIVE' | 'FINALIZING' | 'SEALED';

/**
 * Recording-сессия рынка (внутреннее состояние маршрутизации).
 */
interface RecordingSession {
  /** ID рынка — ключ writer-а в storage. */
  readonly marketId: MarketId;
  /** Регистрация сессии (header/файл/активация) — отдаётся в снимках. */
  readonly marketMeta: MarketMeta;
  /**
   * RTDS-фиды сессии (для снятия routing при finalize).
   *
   * @remarks
   * Mutable: {@link ExternalMessageRecorder.beginMarketFinalization} сужает
   * набор до settlement-потока истёкшего рынка. Сам ОБЪЕКТ сессии при этом
   * не заменяется — его identity стережёт hook отложенной активации storage.
   */
  rtdsFeeds: readonly PolymarketRtdsFeedKey[];
  /** Стадия сессии (см. {@link RecordingSessionState}). */
  state: RecordingSessionState;
  /**
   * `ingress` ПЕРВОГО фактически записанного наблюдения сессии (epoch ms).
   *
   * @remarks
   * Именно момент первого наблюдения, а не момент регистрации: датасет
   * начинается со строки, а не с решения политики. `undefined`, пока ни
   * одной строки не принято storage.
   */
  firstObservedAtMs?: number;
}

/**
 * Собирает точный routing-ключ RTDS-фида (canonical правило контура).
 *
 * @param feed - Фид рынка (spot либо settlement TWAP с окном)
 * @returns Составной ключ для Map, различающий topic, символ и окно
 *
 * @remarks
 * Тонкая обёртка над `rtdsFeedKey` из `@polymarket/polymarket-v2` —
 * собственного правила идентичности recorder больше не держит (иначе
 * добавление окна в один слой и забвение в другом молча смешало бы
 * TWAP 30 и TWAP 60 в одном файле).
 */
function rtdsRoutingKey(feed: PolymarketRtdsFeedKey): string {
  return rtdsFeedKey(feed);
}

/**
 * Рекурсивно замораживает plain-JSON значение.
 *
 * @param value - Значение произвольной вложенности
 *
 * @remarks
 * Только для данных, а не для доменных объектов: `Timestamp`/branded id
 * сюда не попадают, потому что применяется к `rawMarket` — чистому
 * JSON-снимку canonical header-а.
 */
function deepFreezeJson(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeJson(nested);
  }
}

/**
 * Делает регистрацию рынка фактически неизменяемой.
 *
 * @param meta - Метаданные рынка из регистрации
 * @returns Тот же объект, замороженный вместе с `tokenIds` и `rawMarket`
 *
 * @remarks
 * `MarketMeta` объявлен `readonly`, но `readonly` — обещание компилятора, а
 * не рантайма. Снимок сессии отдаёт этот объект наружу
 * ({@link ExternalMessageRecorder.listMarketSessions}), и его `rawMarket` —
 * это canonical header, который финализатор позже кладёт в
 * `updateMarketMeta()`. Мутация через снимок изменила бы то, что реально
 * попадёт в LINE 1 архива, а найти такую правку по факту было бы нечем.
 *
 * Замораживается ОБЪЕКТ регистрации, а не его копия: клонировать нельзя —
 * `marketId`/`expiresAt` являются доменными значениями, и структурная копия
 * потеряла бы их прототип. Регистрация строится вызывающим заново на каждый
 * допуск и после передачи recorder-у ему уже не принадлежит.
 */
function freezeMarketMeta(meta: MarketMeta): MarketMeta {
  deepFreezeJson(meta.rawMarket);
  Object.freeze(meta.tokenIds);
  return Object.freeze(meta);
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
  private readonly _sessionProvider: PolymarketRecordingSessionProvider | undefined;
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
  private _marketSessionsAdmitted = 0;
  private _marketMessagesIgnoredByPolicy = 0;
  private _marketMessagesDroppedAfterExpiry = 0;
  private _marketMessagesDroppedAfterSeal = 0;
  private _unroutedRtdsMessages = 0;
  private _handlerErrors = 0;

  // Счётчики ExternalMessageRecorderCexStats (0, если политика отсутствует)
  private _cexMessagesRouted = 0;
  private _cexRecordsAccepted = 0;
  private _cexRecordsDroppedInactive = 0;
  private _cexRecordsDroppedLate = 0;
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
    this._sessionProvider = deps.sessionProvider;
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
      this._bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', (message) =>
        this._onTwapMessage(message),
      ),
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
      // Регистрация замораживается ЗДЕСЬ: дальше она живёт в снимках сессий
      // и в финальном header-е, и мутация через снимок меняла бы LINE 1.
      marketMeta: freezeMarketMeta(registration.marketMeta),
      rtdsFeeds: [...(registration.rtdsFeeds ?? [])],
      state: 'ACTIVE',
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
      const routingKey = rtdsRoutingKey(feed);
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
   * Переводит recording-сессию рынка в FINALIZING (граница датасета).
   *
   * @param marketId - ID рынка
   * @param settlementFeeds - Фиды, которые ПРОДОЛЖАЮТ писаться в файл рынка
   *   (точная identity settlement-потока рынка); все остальные фиды сессии
   *   перестают в него маршрутизироваться
   * @returns `true` — переход выполнен (или сессия уже была FINALIZING);
   *   `false` — recorder закрыт, сессии нет либо она уже SEALED
   *
   * @remarks
   * ### Что происходит СИНХРОННО с этим вызовом
   *
   * ```text
   * POLYMARKET_MARKET (book/price_change/...) ──► НЕ пишется
   * обычные RTDS (spot binance/chainlink)     ──► НЕ пишутся
   * settlement TWAP точной identity           ──► пишется дальше
   * ```
   *
   * Ни одного `await` до смены состояния: события, уже стоящие в очереди
   * шины, и наблюдения общих spot-фидов (живых ради ДРУГИХ рынков) не имеют
   * шанса попасть в датасет после границы. Граница датасета не должна
   * зависеть ни от того, кто ещё подписан, ни от того, когда закроется
   * физический транспорт.
   *
   * ### Почему settlement-поток остаётся
   *
   * RTDS доставляет наблюдение с vendor-timestamp `T` через 1.1–2.2 с
   * реального времени (характеризация 2026-08-26). Заморозить датасет ровно
   * на `expiresAt` означало бы потерять ГРАНИЧНОЕ наблюдение — то самое, по
   * которому рынок и рассчитывается.
   *
   * Это НЕ seal: writer остаётся принимающим записи оставленных фидов;
   * заморозку выполняет {@link ExternalMessageRecorder.sealMarket} после
   * settlement grace. Идемпотентен; фид, которого у сессии не было, просто
   * не появляется.
   *
   * @example
   * ```typescript
   * // рынок истёк: оставить только официальный settlement-поток
   * recorder.beginMarketFinalization(marketId, [
   *   { topic: 'prices.crypto.chainlink.twap', symbol: 'btc/usd', windowSeconds: 60 },
   * ]);
   * ```
   */
  public beginMarketFinalization(
    marketId: MarketId,
    settlementFeeds: readonly PolymarketRtdsFeedKey[],
  ): boolean {
    const key = String(marketId);
    const feeds = settlementFeeds;
    if (this._closed) {
      this._logger.warn('Market finalization start ignored: recorder is closed', {
        marketId: key,
      });
      return false;
    }
    const session = this._sessions.get(key);
    if (!session) {
      this._logger.debug('beginMarketFinalization: no recording session for market', {
        marketId: key,
      });
      return false;
    }
    if (session.state === 'SEALED') {
      this._logger.debug('beginMarketFinalization: dataset already sealed', { marketId: key });
      return false;
    }

    const retainedKeys = new Set(feeds.map((feed) => rtdsRoutingKey(feed)));
    const retained = session.rtdsFeeds.filter((feed) => retainedKeys.has(rtdsRoutingKey(feed)));
    const dropped = session.rtdsFeeds.filter((feed) => !retainedKeys.has(rtdsRoutingKey(feed)));

    // Снимается routing ТОЛЬКО отброшенных фидов — общие фиды других рынков
    // не затрагиваются (per-feed removal, как при finalize)
    for (const feed of dropped) {
      const routingKey = rtdsRoutingKey(feed);
      const sessions = this._rtdsRouting.get(routingKey);
      if (!sessions) {
        continue;
      }
      sessions.delete(session);
      if (sessions.size === 0) {
        this._rtdsRouting.delete(routingKey);
      }
    }
    // Сам ОБЪЕКТ сессии сохраняется (identity-guard отложенной активации) —
    // меняется только её состав фидов и стадия
    session.rtdsFeeds = retained;
    session.state = 'FINALIZING';

    this._logger.info('Recording session entered finalization', {
      marketId: key,
      retained: retained.map((feed) => rtdsRoutingKey(feed)),
      dropped: dropped.length,
    });
    return true;
  }

  /**
   * Сужает RTDS-routing рынка до указанного подмножества фидов.
   *
   * @param marketId - ID рынка
   * @param feeds - Фиды, которые ПРОДОЛЖАЮТ писаться в файл рынка
   * @returns То же, что {@link ExternalMessageRecorder.beginMarketFinalization}
   *
   * @deprecated LEGACY ALIAS. Именем `narrowRtdsFeeds` пользуется только
   *   legacy `MarketCollectionCoordinator`; canonical-имя перехода —
   *   {@link ExternalMessageRecorder.beginMarketFinalization}. Удаляется
   *   вместе с legacy-координатором на Legacy Infrastructure Cleanup.
   *
   * @example
   * ```typescript
   * recorder.narrowRtdsFeeds(marketId, [settlementFeed]);
   * ```
   */
  public narrowRtdsFeeds(marketId: MarketId, feeds: readonly PolymarketRtdsFeedKey[]): boolean {
    return this.beginMarketFinalization(marketId, feeds);
  }

  /**
   * Возвращает read-only снимки всех recording-сессий рынка.
   *
   * @returns Снимки, отсортированные по id рынка
   *
   * @remarks
   * ### Зачем это существует
   *
   * Факт «запись этого рынка началась» рождается ВНУТРИ recorder-а: сессию
   * создаёт первое наблюдение через ленивый допуск, а не внешний вызов.
   * Lifecycle-слою нужно узнавать о таких сессиях, и единственная честная
   * форма — read-only проекция владельца факта. Обратный вызов из recorder-а
   * в lifecycle завёл бы циклическую зависимость двух слоёв ради данных,
   * которые и так наблюдаемы.
   *
   * Снимок несёт `marketMeta` (в нём — canonical header и `expiresAt`,
   * то есть граница рынка) и `firstObservedAtMs` — момент ПЕРВОЙ реально
   * записанной строки. Mutable-состояние наружу не выходит: массив фидов
   * копируется, сам снимок заморожен, а регистрация (вместе с вложенным
   * `rawMarket`) заморожена ещё при `registerMarket` — иначе вызывающий мог
   * бы через снимок изменить canonical header, который позже уедет в LINE 1
   * архива.
   *
   * @example
   * ```typescript
   * for (const session of recorder.listMarketSessions()) {
   *   if (session.state === 'ACTIVE') scheduleExpiry(session.marketMeta.expiresAt);
   * }
   * ```
   */
  public listMarketSessions(): readonly PolymarketRecordingSessionSnapshot[] {
    return [...this._sessions.values()]
      .map((session) =>
        Object.freeze({
          marketId: session.marketId,
          state: session.state,
          marketMeta: session.marketMeta,
          rtdsFeeds: Object.freeze([...session.rtdsFeeds]),
          ...(session.firstObservedAtMs !== undefined
            ? { firstObservedAtMs: session.firstObservedAtMs }
            : {}),
        }),
      )
      .sort((left, right) => {
        const a = String(left.marketId);
        const b = String(right.marketId);
        if (a < b) return -1;
        return a > b ? 1 : 0;
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
   *
   * Сессия при этом НЕ удаляется, а помечается `SEALED` — надгробие живёт до
   * `finalizeMarket`. Физический claim рынка снимается ПОЗЖЕ заморозки
   * (иначе последний claim закрыл бы settlement-поток вместе с CLOB), и
   * события, долетевшие в это окно, обязаны находить завершённую сессию, а
   * не создавать ленивым допуском ВТОРУЮ поверх готового датасета.
   */
  public async sealMarket(marketId: MarketId): Promise<boolean> {
    const key = String(marketId);
    if (this._closed) {
      this._logger.warn('Market seal ignored: recorder is closed', { marketId: key });
      return false;
    }
    const session = this._sessions.get(key);
    if (session) {
      // Синхронно, до первого await: routing снят и стадия сменилась —
      // ни одно наблюдение этого тика уже не попадёт в датасет
      this._removeRtdsRouting(session);
      session.rtdsFeeds = [];
      session.state = 'SEALED';
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
   * Читает payload-строки SEALED-датасета рынка (passthrough в storage).
   *
   * @param marketId - ID рынка
   * @param filter - Предикат отбора строк
   * @param maxMatches - Потолок совпадений (см. storage default)
   * @returns Отобранные строки либо `undefined` — recorder закрыт, датасет
   *   не sealed/не активирован либо чтение отказало (залогировано storage)
   *
   * @remarks
   * Read-путь для write-time деривации finalizer-а (winner-ladder ступень
   * `recorded-rtds`): payload заморожен seal-ом — чтение не гонится с
   * записью. Recorder ничего не парсит и не преобразует.
   */
  public async readSealedPayloadLines(
    marketId: MarketId,
    filter: (line: string) => boolean,
    maxMatches?: number,
  ): Promise<readonly string[] | undefined> {
    if (this._closed) {
      return undefined;
    }
    return this._storage.readSealedPayloadLines(marketId, filter, maxMatches);
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
      marketSessionsAdmitted: this._marketSessionsAdmitted,
      marketMessagesIgnoredByPolicy: this._marketMessagesIgnoredByPolicy,
      marketMessagesDroppedAfterExpiry: this._marketMessagesDroppedAfterExpiry,
      marketMessagesDroppedAfterSeal: this._marketMessagesDroppedAfterSeal,
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
      cexRecordsDroppedLate: this._cexRecordsDroppedLate,
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
      // Оба storage закрываются ПАРАЛЛЕЛЬНО и оба дожидаются: отказ
      // закрытия Polymarket-storage не должен лишать CEX-storage его
      // shutdown-а (и наоборот). Первый отказ пробрасывается ПОСЛЕ того,
      // как оба закрытия завершились.
      const closures = await Promise.allSettled([
        this._storage.close(),
        this._cex?.storage.close() ?? Promise.resolve(),
      ]);
      const rejection = closures.find(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      );
      if (rejection) {
        this._logger.error('Recorder storage close failed', {
          error:
            rejection.reason instanceof Error
              ? rejection.reason.message
              : String(rejection.reason),
        });
        throw rejection.reason;
      }
      this._logger.info('ExternalMessageRecorder closed');
    })();
    return this._closePromise;
  }

  /**
   * Пытается лениво создать сессию рынка по первому наблюдению.
   *
   * @param sourceMarketId - `payload.market` входящего события
   * @returns Созданная активная сессия либо `undefined` (провайдера нет,
   *   рынок отклонён политикой, либо storage отверг регистрацию)
   *
   * @remarks
   * Единственная точка, где сессия создаётся ТРАФИКОМ, а не внешним
   * `registerMarket`. Вызывается синхронно из обработчика первого сообщения,
   * поэтому вернувшаяся сессия сразу же принимает это сообщение — первое
   * наблюдение не теряется. Провайдер обязан вернуть регистрацию именно
   * запрошенного рынка; регистрация другого рынка отклоняется (иначе текущее
   * сообщение всё равно осталось бы без сессии).
   */
  private _admitSession(sourceMarketId: string): RecordingSession | undefined {
    if (this._sessionProvider === undefined) {
      this._unroutedMarketMessages++;
      return undefined;
    }
    const registration = this._sessionProvider(sourceMarketId);
    if (registration === undefined) {
      this._marketMessagesIgnoredByPolicy++;
      return undefined;
    }
    if (String(registration.marketMeta.marketId) !== sourceMarketId) {
      // Провайдер вернул регистрацию ДРУГОГО рынка — записать текущее
      // сообщение было бы некуда; это дефект провайдера, а не рынка.
      this._marketMessagesIgnoredByPolicy++;
      this._logger.warn('Session provider returned a registration for a different market', {
        requested: sourceMarketId,
        returned: String(registration.marketMeta.marketId),
      });
      return undefined;
    }
    const installed = this.registerMarket(registration);
    if (!installed) {
      // registerMarket уже увеличил registrationFailures и залогировал причину.
      return undefined;
    }
    this._marketSessionsAdmitted++;
    return this._sessions.get(sourceMarketId);
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
      let session = this._sessions.get(sourceMarketId);
      if (!session) {
        // Ленивый допуск (Collector-cutover): сессии ещё нет — спрашиваем
        // провайдера СИНХРОННО и, если он согласен, создаём сессию и тут же
        // записываем ЭТО ЖЕ первое сообщение. Без провайдера — прежнее
        // поведение (unrouted).
        session = this._admitSession(sourceMarketId);
        if (!session) {
          return; // счётчик уже увеличен внутри _admitSession
        }
      }
      // Сессия истёкшего рынка market-события больше не принимает: торговый
      // lifecycle закончен на expiresAt. SEALED — датасет уже заморожен.
      if (session.state === 'SEALED') {
        this._marketMessagesDroppedAfterSeal++;
        return;
      }
      if (session.state === 'FINALIZING') {
        this._marketMessagesDroppedAfterExpiry++;
        return;
      }
      this._marketMessagesRouted++;
      this._recordObservation(session, toRecordedObservation(message));
    } catch (error) {
      this._handlerErrors++;
      this._logger.error('Market message recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handler spot-RTDS сообщений: маршрутизация по точному `(topic, symbol)`.
   *
   * @param message - Typed сообщение `POLYMARKET_CRYPTO_BINANCE` или
   *   `POLYMARKET_CRYPTO_CHAINLINK`
   *
   * @remarks
   * Источник различается vendor `topic`-дискриминатором, эвристика формата
   * символа не используется. Никогда не бросает.
   */
  private _onRtdsMessage(
    message: PolymarketCryptoBinanceExternalMessage | PolymarketCryptoChainlinkExternalMessage,
  ): void {
    if (this._closed) {
      return;
    }
    try {
      this._routeRtdsObservation(
        rtdsRoutingKey({ topic: message.payload.topic, symbol: message.payload.payload.symbol }),
        toRecordedObservation(message),
      );
    } catch (error) {
      this._handlerErrors++;
      this._logger.error('RTDS message recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handler settlement-потока Chainlink TWAP: маршрутизация с УЧЁТОМ окна.
   *
   * @param message - Typed сообщение `POLYMARKET_CRYPTO_CHAINLINK_TWAP`
   *
   * @remarks
   * Окно берётся из САМОГО события (`payload.windowSeconds`), а не из
   * внешнего контекста подписки — поэтому рынок, которому нужен `btc/usd`
   * TWAP 60, физически не может получить строку `btc/usd` TWAP 30: у них
   * разные routing-ключи. Никогда не бросает.
   */
  private _onTwapMessage(message: PolymarketCryptoChainlinkTwapExternalMessage): void {
    if (this._closed) {
      return;
    }
    try {
      const payload = message.payload.payload;
      this._routeRtdsObservation(
        rtdsRoutingKey({
          topic: CHAINLINK_TWAP_TOPIC,
          symbol: payload.symbol,
          windowSeconds: payload.windowSeconds,
        }),
        toRecordedObservation(message),
      );
    } catch (error) {
      this._handlerErrors++;
      this._logger.error('Chainlink TWAP message recording handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Общий fan-out RTDS-наблюдения по всем сессиям, подписанным на фид.
   *
   * @param routingKey - Точный ключ фида ({@link rtdsRoutingKey})
   * @param observation - V2-наблюдение с НЕИЗМЕНЁННЫМ source-native payload
   *
   * @remarks
   * Один RTDS-фид может использоваться несколькими активными рынками —
   * наблюдение записывается в файл КАЖДОЙ подписанной сессии (ровно одна
   * строка на файл на входное сообщение). Конверт строится ОДИН раз на
   * входное сообщение: все копии строки несут один и тот же `(runId,
   * sequence)`, потому что это одно и то же наблюдение, размноженное по
   * файлам, а не несколько разных.
   *
   * Ошибки storage изолируются НА КАЖДОЕ направление fan-out независимо:
   * отказ записи для одного рынка не лишает события остальные подписанные
   * рынки (storage failure — non-fatal, но наблюдаем: лог + `handlerErrors`).
   */
  private _routeRtdsObservation(
    routingKey: string,
    observation: RecordedExternalObservationV2,
  ): void {
    const sessions = this._rtdsRouting.get(routingKey);
    if (!sessions || sessions.size === 0) {
      this._unroutedRtdsMessages++;
      return;
    }
    this._rtdsMessagesRouted++;
    for (const session of sessions) {
      try {
        this._recordObservation(session, observation);
      } catch (error) {
        this._handlerErrors++;
        this._logger.error('RTDS recording failed for market, continuing fan-out', {
          marketId: String(session.marketId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Передаёт V2-наблюдение storage-движку и учитывает исход в счётчиках.
   *
   * @param session - Recording-сессия рынка-адресата
   * @param observation - V2-наблюдение с НЕИЗМЕНЁННЫМ source-native payload
   *
   * @remarks
   * `observation.payload` — та же ссылка, что пришла на шину: без
   * clone/rename/flatten/normalize (PART 13). `'unregistered'` при живой
   * сессии — рассинхрон session↔storage (finalize в обход recorder-а):
   * логируется warn-ом.
   */
  private _recordObservation(
    session: RecordingSession,
    observation: RecordedExternalObservationV2,
  ): void {
    const outcome = this._storage.recordMarketEvent(session.marketId, observation);
    switch (outcome) {
      case 'recorded':
        this._recordsWritten++;
        // Датасет начинается со СТРОКИ, а не с решения политики: моментом
        // начала записи считается ingress первого принятого наблюдения
        session.firstObservedAtMs ??= ingressEpochMilliseconds(observation.ingress);
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
   * Регистраций нет: routing-идентичность (`exchangeId`/`marketType` +
   * `symbol`) несёт сам typed payload; тип потока задаёт партицию
   * (`orderbook`) и вместе с парой биржи/рынка образует canonical identity
   * транспорта `exchangeId + marketType + stream`. В storage уходит
   * V2-наблюдение с НЕИЗМЕНЁННЫМ `message.payload` внутри; окно партиции
   * оконный storage выбирает по `ingress` ЭТОГО наблюдения, а не по
   * wall-clock момента записи. Никогда не бросает.
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
          toRecordedObservation(message),
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
          toRecordedObservation(message),
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
  private _countCexOutcome(outcome: CexWindowRecordOutcome): void {
    switch (outcome) {
      case 'recorded':
        this._cexRecordsAccepted++;
        break;
      case 'inactive':
        this._cexRecordsDroppedInactive++;
        break;
      case 'late':
        // Окно наблюдения уже заархивировано (storage залогировал причину)
        this._cexRecordsDroppedLate++;
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
      const routingKey = rtdsRoutingKey(feed);
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

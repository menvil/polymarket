/**
 * Контракт контроллера общих CEX-подписок: спрос владельцев, логические
 * claim-ы, физические пулы и узкое structural-подмножество `CexSource`.
 *
 * @remarks
 * ### CEX-спрос АВТОРИТЕТЕН — в отличие от Polymarket
 *
 * ```text
 * Polymarket:  рынок имеет startsAt → приобрести НАДО до старта
 *              → после старта claim закреплён
 *              → исчезновение из плана ≠ release   (ACQUISITION ≠ RETENTION)
 *
 * CEX:         BTC/USDT — непрерывный поток
 *              → ни startsAt, ни expiry, ни rollover
 *              → нужен ровно до тех пор, пока есть текущий спрос
 *              → исчезновение из demands = release        (desired state)
 * ```
 *
 * Разница не стилистическая. У Polymarket «рынка нет в плане» означает
 * «его уже поздно ПРИОБРЕТАТЬ», а вовсе не «он больше не нужен»: рынок
 * выпадает из плана ровно в момент старта торгов, то есть тогда, когда
 * подписка наконец начинает приносить данные. У CEX никакого момента
 * старта не существует: поток `BTC/USDT` одинаково пригоден в любую
 * секунду, поэтому единственная причина его держать — что кто-то его
 * СЕЙЧАС хочет. Значит `demands` — полный desired state, и владелец,
 * пропавший из входа, действительно теряет свои claim-ы.
 *
 * ### Логическая identity ресурса ≠ физическая identity пула
 *
 * ```text
 * logical claim:  ownerKey + exchangeId + marketType + symbol + stream
 * physical pool:            exchangeId + marketType +          stream
 * ```
 *
 * Символ есть в claim-е и НЕТ в ключе пула: один `CexSource` наблюдает
 * весь агрегированный набор символов одной биржи/типа рынка/потока —
 * ровно та архитектура, ради которой `CexSource` и оптимизирован
 * («один CCXT Pro instance на поток»).
 *
 * ### Чего здесь нет намеренно
 *
 * Ни `CexMarketUniverse`, ни `CexDiscovery`, ни `CexMarket`: `CexPolicy`
 * уже содержит точную биржу, тип рынка, символ и требования к потокам —
 * выдумывать поверх этого фальшивые инструменты значило бы заводить
 * каталог, у которого нет источника истины.
 */
import type { ILogger } from '@polymarket/logger';
import type { Timestamp } from '@polymarket/timestamp';
import type { CexPolicy } from '@polymarket/policy';
import type { CexMarketType, CexSourceConfig, CexSourceStats } from '@polymarket/cex-v2';

/**
 * Стабильный ключ владельца CEX-подписки.
 *
 * @remarks
 * Непрозрачная identity: контроллер не разбирает префикс и не знает, что
 * значит `strategy` или `collector`. Примеры реальных значений —
 * `strategy:btc-5m`, `collector:raw`, `strategy:another`.
 *
 * Тип объявлен ЗДЕСЬ, а не переиспользован из
 * `@polymarket/polymarket-subscription-control`, хотя структурно он тот
 * же. Причина — направление зависимостей: `SubscriptionOwnerKey` физически
 * живёт в Polymarket-specific пакете, и импорт из него потащил бы в
 * CEX-контур площадочный драйвер вместе с Gamma-моделями и RTDS-фидами.
 * Общий владелец у двух контуров действительно один и тот же, но общей
 * сущностью/реестром владельцев он не становится: контроллеру нужно ровно
 * одно свойство ключа — сравнимость.
 *
 * Ключ НЕ нормализуется (не обрезается): `'a'` и `'a '` — разные
 * владельцы, потому что нормализация молча склеила бы два разных claim-а.
 */
export type CexSubscriptionOwnerKey = string;

/**
 * Вид потока наблюдений CEX.
 *
 * @remarks
 * Часть identity и логического claim-а, и физического пула: стакан и
 * сделки — независимые transport-сессии `CexSource`, и делить их на
 * уровне контроллера нужно затем, чтобы смена набора символов стакана не
 * заставляла перезапускать поток сделок (см. TSDoc `CexSubscriptionController`).
 */
export type CexStreamKind = 'ORDERBOOK' | 'TRADES';

/**
 * Спрос одного владельца на один проход реконсиляции.
 *
 * @remarks
 * Ровно два поля: КТО хочет и ЧТО он хочет. Ни лимитов, ни cadence, ни
 * состояния прошлых проходов: спрос действует на один вызов
 * `reconcile()` и приходит аргументом.
 *
 * Лимита вида `acquireLimit` здесь нет СОЗНАТЕЛЬНО. У Polymarket он
 * отвечал на вопрос «сколько первых кандидатов ПЛАНА попробовать
 * приобрести», потому что кандидатов заведомо больше, чем нужно. У CEX
 * кандидатов нет вовсе: policy перечисляет конкретные биржи, типы рынков
 * и символы, и все они нужны владельцу — выбирать не из чего.
 *
 * @example
 * ```typescript
 * const demand: CexSubscriptionDemand = {
 *   ownerKey: 'strategy:btc-5m',
 *   policy: {
 *     kind: 'CEX',
 *     exchangeIds: ['binance'],
 *     marketTypes: ['swap'],
 *     symbols: ['BTC/USDT:USDT'],
 *     orderbook: true,
 *     trades: true,
 *     orderbookDepth: 10,
 *   },
 * };
 * ```
 */
export interface CexSubscriptionDemand {
  /** Стабильный непрозрачный ключ владельца. */
  readonly ownerKey: CexSubscriptionOwnerKey;
  /** Owner policy CEX: биржи × типы рынков × символы × потоки. */
  readonly policy: CexPolicy;
}

/**
 * Детерминированный ключ физического пула.
 *
 * @remarks
 * Строка вида `exchangeId|marketType|stream` (например
 * `binance|swap|ORDERBOOK`). Не случайный id и не UUID: ключ обязан
 * вычисляться из желаемого состояния, иначе сопоставить желаемый пул с
 * текущим было бы нечем. Владельцы в ключ НЕ входят — пул существует
 * ради ресурса, а не ради того, кто его захотел.
 */
export type CexPoolKey = string;

/**
 * Один логический claim владельца.
 *
 * @remarks
 * Identity — пятёрка `ownerKey + exchangeId + marketType + symbol +
 * stream`. Глубина стакана в identity НЕ входит: два владельца одного
 * `BTC/USDT` с разной желаемой глубиной — это два claim-а на ОДИН
 * ресурс, а не два разных ресурса (иначе шина получила бы две записи
 * одной routing identity, см. TSDoc `CexSubscriptionController`).
 */
export interface CexSubscriptionClaim {
  /** Владелец claim-а. */
  readonly ownerKey: CexSubscriptionOwnerKey;
  /** Биржа в нотации ccxt. */
  readonly exchangeId: string;
  /** Тип рынка. */
  readonly marketType: CexMarketType;
  /** Unified-символ инструмента. */
  readonly symbol: string;
  /** Вид потока. */
  readonly stream: CexStreamKind;
  /** Желаемая владельцем глубина стакана; только у `ORDERBOOK`. */
  readonly desiredDepth?: number;
}

/**
 * Спецификация физического пула — то, что материализуется одним `CexSource`.
 *
 * @remarks
 * Владельцев здесь НЕТ: spec описывает ресурс, а не причину его
 * существования. Именно поэтому исчезновение одного из двух владельцев
 * одинакового ресурса физически не меняет ничего (см. TSDoc
 * `CexSubscriptionController`, раздел про owner disappearance).
 *
 * `symbols` всегда отсортированы ASC и не содержат дублей: спецификация
 * обязана быть функцией МНОЖЕСТВА claim-ов, а не порядка, в котором
 * вызывающий подал спрос.
 */
export interface CexPhysicalPoolSpec {
  /** Биржа в нотации ccxt. */
  readonly exchangeId: string;
  /** Тип рынка (`options.defaultType` CCXT-инстанса). */
  readonly marketType: CexMarketType;
  /** Вид потока: ровно один на пул. */
  readonly stream: CexStreamKind;
  /** Агрегированный набор символов, ASC, без дублей. */
  readonly symbols: readonly string[];
  /**
   * Запрошенная глубина стакана — МАКСИМУМ желаемых глубин пула.
   * Только у `ORDERBOOK`.
   */
  readonly orderbookDepth?: number;
}

/**
 * Узкое structural-подмножество `CexSource`, которым пользуется контроллер.
 *
 * @remarks
 * Это НЕ новая vendor-абстракция и не второй контракт транспорта: набор
 * подобран так, чтобы реальный `CexSource` подходил под него без
 * адаптера. Нужен он ради тестовых подделок (иначе каждый тест поднимал
 * бы CCXT) и ради того, чтобы контроллер физически не мог дотянуться до
 * внутренностей источника.
 *
 * `close()` здесь ЕСТЬ — и это принципиальное отличие от Polymarket, где
 * один общий `PolymarketSource` принадлежит composition root. CEX-пулы
 * контроллер создаёт сам через фабрику, поэтому сам обязан их и
 * закрывать.
 */
export interface CexSubscriptionSource {
  /** Терминальный отказ pipeline: наблюдения больше не публикуются. */
  readonly hasFailed: boolean;
  /** Источник терминально остановлен. */
  readonly isClosed: boolean;
  /** Жив хотя бы один supervised transport-поток. */
  readonly isRunning: boolean;
  /** Запускает transport-потоки (синхронно). */
  start(): void;
  /** Graceful shutdown: дожидается остановки всех циклов. */
  close(): Promise<void>;
  /** Диагностические счётчики источника. */
  getStats(): CexSourceStats;
}

/**
 * Фабрика физических источников.
 *
 * @remarks
 * Контроллер не знает ни про `ExternalMessageBus`, ни про
 * `MessageMetadataGenerator`, ни про CCXT: всё это захватывает фабрика в
 * composition root. Контроллер умеет ровно одно — превратить желаемую
 * спецификацию пула в {@link CexSourceConfig} и попросить создать
 * источник.
 *
 * @example
 * ```typescript
 * const sourceFactory: CexSubscriptionSourceFactory = (config) =>
 *   new CexSource({ config, bus, metadataGenerator, logger });
 * ```
 */
export type CexSubscriptionSourceFactory = (config: CexSourceConfig) => CexSubscriptionSource;

/**
 * Зависимости контроллера.
 *
 * @remarks
 * Часов здесь НЕТ намеренно: момент оценки приходит аргументом
 * `reconcile(demands, now)`. Composition root читает часы один раз на тик
 * и передаёт один и тот же `now` во все решения этого тика; контроллер,
 * читающий часы сам, сделал бы проход невоспроизводимым в replay и в
 * тестах.
 */
export interface CexSubscriptionControllerDependencies {
  /** Фабрика физических источников (захватывает шину и генератор metadata). */
  readonly sourceFactory: CexSubscriptionSourceFactory;
  /** Логгер: контроллер управляет реальными ресурсами, и это наблюдаемо. */
  readonly logger: ILogger;
}

/**
 * Этап, на котором отказал переход пула.
 *
 * @remarks
 * - `open` — желаемый пул не удалось материализовать (фабрика или
 *   `start()` бросили, либо источник родился уже мёртвым);
 * - `replace` — старое поколение закрыто, новое поднять не удалось:
 *   пул остаётся ЖЕЛАЕМЫМ, но физически отсутствует;
 * - `close` — источник отказал при закрытии; пул из карты всё равно
 *   убран, потому что пользоваться им больше нельзя.
 */
export type CexPoolTransitionStage = 'open' | 'replace' | 'close';

/**
 * Отказ перехода одного пула.
 *
 * @remarks
 * Значение, а не исключение: отказ одной биржи не должен ронять
 * реконсиляцию остальных (см. TSDoc `CexSubscriptionController`).
 */
export interface CexPoolTransitionFailure {
  /** Ключ пула, переход которого не удался. */
  readonly poolKey: CexPoolKey;
  /** Этап отказа. */
  readonly stage: CexPoolTransitionStage;
  /** Сообщение исходной ошибки транспорта. */
  readonly reason: string;
}

/**
 * Снимок одного пула.
 *
 * @remarks
 * Показывает ОБА уровня сразу — и желаемое, и материализованное:
 * `ownerKeys` отвечают на вопрос «кто этого хочет», `satisfied` /
 * `running` / `failed` — «есть ли это физически». Склеить их в одно поле
 * нельзя: желаемый, но не поднявшийся пул — нормальное состояние после
 * отказа транспорта, и следующий проход обязан его отличить (см. TSDoc
 * `CexSubscriptionController`, раздел про desired vs physical).
 *
 * Vendor-объекты (CCXT-инстансы, unified-модели) наружу не выходят
 * вообще.
 */
export interface CexSubscriptionPoolSnapshot {
  /** Детерминированный ключ пула. */
  readonly poolKey: CexPoolKey;
  /** Биржа в нотации ccxt. */
  readonly exchangeId: string;
  /** Тип рынка. */
  readonly marketType: CexMarketType;
  /** Вид потока. */
  readonly stream: CexStreamKind;
  /** Агрегированный набор символов, ASC. */
  readonly symbols: readonly string[];
  /** Запрошенная глубина стакана (максимум по пулу); только у `ORDERBOOK`. */
  readonly orderbookDepth?: number;
  /**
   * Номер физического поколения пула.
   *
   * @remarks
   * Монотонно растёт на каждое СОЗДАНИЕ источника под этим ключом за
   * время жизни контроллера. `0` означает, что физического поколения
   * сейчас нет (пул желаем, но не материализован).
   */
  readonly generation: number;
  /** Владельцы хотя бы одного claim-а пула, ASC. */
  readonly ownerKeys: readonly CexSubscriptionOwnerKey[];
  /** Материализован ли пул физическим источником. */
  readonly satisfied: boolean;
  /** Жив ли transport-поток источника. */
  readonly running: boolean;
  /** Терминальный отказ источника. */
  readonly failed: boolean;
}

/**
 * Снимок состояния контроллера.
 *
 * @remarks
 * Счётчики разделены на логический и физический уровни намеренно:
 * `desiredPools` — сколько пулов ХОТЯТ владельцы, `physicalPools` —
 * сколько из них действительно материализовано. Их расхождение и есть
 * единственный честный признак деградации транспорта.
 *
 * @example
 * ```typescript
 * const stats = controller.getStats();
 * if (stats.physicalPools < stats.desiredPools) {
 *   logger.warn('cex pools degraded', { desired: stats.desiredPools, physical: stats.physicalPools });
 * }
 * ```
 */
export interface CexSubscriptionControllerStats {
  /** Владельцы, у которых есть хотя бы один claim. */
  readonly owners: number;
  /** Всего логических claim-ов. */
  readonly logicalClaims: number;
  /** Пулы, которых хочет хотя бы один claim. */
  readonly desiredPools: number;
  /** Пулы, материализованные физическим источником. */
  readonly physicalPools: number;
  /** Из материализованных — потоки стакана. */
  readonly orderbookPools: number;
  /** Из материализованных — потоки сделок. */
  readonly tradePools: number;
  /** Из материализованных — с живым transport-потоком. */
  readonly runningPools: number;
  /** Из материализованных — в терминальном отказе. */
  readonly failedPools: number;
  /** Контроллер остановлен: реконсиляция запрещена. */
  readonly closed: boolean;
}

/**
 * Отчёт одного прохода реконсиляции.
 *
 * @remarks
 * Заморожен целиком — сам отчёт, все его массивы и каждый отказ. Отчёт
 * уезжает в логи и метрики; править его им незачем, а сделать это
 * случайно легко.
 *
 * Четыре массива переходов взаимно исключающи и покрывают все пулы
 * прохода: `unchanged` (steady state), `opened`, `replaced`, `closed`.
 * Пул, чьё ОТКРЫТИЕ или ЗАМЕНА сорвались, не попадает ни в один из них —
 * физически его нет, он есть только в `failures`. Единственное
 * пересечение — отказ на этапе `close`: такой пул и убран (он в
 * `closedPools`), и отмечен отказом, потому что закрылся не начисто.
 *
 * @example
 * ```typescript
 * const result = await controller.reconcile(demands, now);
 *
 * result.unchangedPools;  // steady state: ни одного рестарта
 * result.replacedPools;   // спецификация изменилась → новое поколение
 * result.failures;        // транспорт отказал, пул остался желаемым
 * ```
 */
export interface CexSubscriptionReconcileResult {
  /** Момент, НА который выполнена реконсиляция (аргумент `now`). */
  readonly reconciledAt: Timestamp;
  /** Владельцы, чья policy действует в этот момент. */
  readonly activeDemands: number;
  /** Владельцы, чья policy в этот момент не действует. */
  readonly inactiveDemands: number;
  /** Сколько пулов требует желаемое состояние. */
  readonly desiredPools: number;
  /** Пулы, спецификация которых не изменилась: источник переиспользован. */
  readonly unchangedPools: readonly CexPoolKey[];
  /** Пулы, поднятые в этом проходе впервые. */
  readonly openedPools: readonly CexPoolKey[];
  /** Пулы, поколение которых заменено. */
  readonly replacedPools: readonly CexPoolKey[];
  /** Пулы, которых больше никто не хочет: источник закрыт. */
  readonly closedPools: readonly CexPoolKey[];
  /** Отказы переходов (транспорт), по одному на пул. */
  readonly failures: readonly CexPoolTransitionFailure[];
  /** Снимок состояния контроллера ПОСЛЕ прохода. */
  readonly stats: CexSubscriptionControllerStats;
}

/**
 * MarketUniverse — текущий известный Application universe canonical рынков.
 *
 * @remarks
 * ### Что это и чем это НЕ является
 *
 * `MarketUniverse` отвечает на вопрос «какие рынки сейчас существуют и
 * технически доступны нашему контуру». Это in-memory source of truth
 * discovery-снимка, а НЕ каталог инструментов исполнения: `IMarketCatalog`
 * решает другую задачу (`instrumentId → InstrumentInfo` для strategy/risk/
 * order path) и здесь не переиспользуется — сталкивать две концепции в
 * одном типе значило бы получить объект, у которого две несовместимые
 * причины меняться.
 *
 * ### Почему это класс, а не интерфейс + реализация
 *
 * Второй реализации нет и не предвидится: universe — простая замена
 * снимка целиком. Интерфейс без второй реализации не даёт dependency
 * inversion, он даёт лишний файл. Инверсия зависимости уже сделана ТАМ,
 * где она нужна — на порту `IMarketDiscoveryService`.
 *
 * ### Почему `replace`, а не `add`/`remove`
 *
 * Discovery отдаёт СНИМОК: «вот полный технически поддержанный universe на
 * момент `observedAt`». Инкрементальные мутации потребовали бы вычислять
 * диффы в двух местах и допускали бы состояние, которого площадка никогда
 * не наблюдала (рынок, «забытый» в universe после исчезновения из окна).
 * Замена целиком делает такое состояние непредставимым.
 *
 * @example
 * ```typescript
 * const universe = new MarketUniverse(clock);
 *
 * await discovery.refresh();
 * universe.replace(discovery.getSnapshot());
 *
 * const entry = universe.get(KnownVenues.POLYMARKET, marketId);
 * console.log(entry?.market.question);
 * ```
 */
import type { IClock } from '@polymarket/time';
import type { MarketId, VenueId } from '@polymarket/ids';
import { Timestamp } from '@polymarket/timestamp';
import { marketUniverseKey } from '@polymarket/ports';
import type {
  MarketDiscoveryDiagnostics,
  MarketDiscoveryEntry,
  MarketDiscoverySnapshot,
} from '@polymarket/ports';

/**
 * Нулевая диагностика пустого стартового universe.
 *
 * @internal
 * @remarks
 * Заморожена и переиспользуется: пустой снимок неизменяем по определению,
 * а отдавать новый объект на каждое чтение — лишний мусор.
 */
const EMPTY_DIAGNOSTICS: MarketDiscoveryDiagnostics = Object.freeze({
  pagesFetched: 0,
  marketsScanned: 0,
  tradeableMarkets: 0,
  unsupportedMarkets: 0,
  supportedCryptoUpDown: 0,
  invalidMarkets: Object.freeze({
    total: 0,
    classification: 0,
    eventUnavailable: 0,
    schedule: 0,
    seriesDuration: 0,
    canonicalMapping: 0,
  }),
  duplicateMarkets: 0,
  eventFetches: 0,
  eventFetchFailures: 0,
  eventCacheHits: 0,
});

/**
 * In-memory source of truth текущего universe canonical рынков.
 */
export class MarketUniverse {
  /**
   * Текущий снимок.
   *
   * @remarks
   * Заморожен целиком: сам снимок, массив `entries`, каждая запись в нём
   * и `metrics` каждой записи (см. {@link MarketUniverse.replace}).
   */
  private _snapshot: MarketDiscoverySnapshot;
  /** Индекс `venueId + marketId → запись` для O(1) lookup. */
  private _index: ReadonlyMap<string, MarketDiscoveryEntry> = new Map();

  /**
   * Создаёт пустой universe.
   *
   * @param clock - Источник времени (DI — детерминизм в тестах)
   *
   * @remarks
   * Стартовый снимок пуст и датирован моментом создания: «на момент
   * создания мы не наблюдали ни одного рынка». Это честнее, чем
   * `observedAt` из эпохи, и избавляет вызывающего от проверки
   * «а был ли уже хоть один refresh» перед чтением снимка.
   *
   * @example
   * ```typescript
   * const universe = new MarketUniverse(new LiveClock());
   * universe.getAll(); // → []
   * ```
   */
  constructor(clock: IClock) {
    this._snapshot = Object.freeze({
      observedAt: Timestamp.now(clock),
      entries: Object.freeze([] as readonly MarketDiscoveryEntry[]),
      diagnostics: EMPTY_DIAGNOSTICS,
    });
  }

  /**
   * Заменяет universe новым снимком discovery.
   *
   * @param snapshot - Снимок из `IMarketDiscoveryService.getSnapshot()`
   *
   * @remarks
   * Записи, которых нет в новом снимке, из universe исчезают — снимок
   * полон по контракту порта.
   *
   * ### Почему копия, а не заморозка входа
   *
   * Universe обязан быть неизменяем по ДВУМ независимым осям: он не должен
   * меняться из-под потребителя, который держит ссылку на результат
   * `getAll()`, и не должен зависеть от того, мутирует ли вызывающий
   * переданный снимок ПОСЛЕ вызова. Заморозки одного лишь массива для
   * этого мало: сами записи и их `metrics` остались бы общими объектами с
   * вызывающим, и `snapshot.entries[0].metrics.liquidity = x` тихо менял
   * бы source of truth Application.
   *
   * Поэтому `replace()` строит СВОИ объекты — новый массив, новую запись
   * `{ market, metrics }` и новый `metrics` — и замораживает именно их.
   * Заморозить объекты вызывающего было бы проще, но это побочный эффект
   * на чужих данных: снимок принадлежит discovery, а не universe.
   *
   * ### Почему `Market` остаётся по ссылке
   *
   * `Market` — иммутабельная доменная сущность `@polymarket/market`, её
   * неизменяемость обеспечивает сам пакет-владелец. Клонировать её здесь
   * значило бы дублировать чужой инвариант и ломать identity-сравнение по
   * ссылке (`universe.get(...)?.market === market`). `metrics` копируются
   * не потому, что их поля мутабельны (`Money`/`Ratio` — VO), а потому что
   * мутабелен сам контейнер: это обычный литерал, собранный адаптером.
   *
   * ### Почему дедупликация одна на оба представления
   *
   * Universe отдаёт себя ДВУМЯ способами — точечным `get()` и обходом
   * `getAll()`/`getSnapshot()`. Если дедуплицировать только индекс, а в
   * массив складывать всё подряд, снимок с дубликатом даёт объект, два
   * метода которого описывают РАЗНЫЙ universe: `get()` знает один рынок,
   * `getAll()` возвращает две записи с одинаковой идентичностью. Для
   * source of truth это худший вид расхождения — оно тихое, и каждый
   * потребитель ловит его по-своему (двойная подписка на один рынок,
   * двойной учёт в риске).
   *
   * Поэтому дедупликация происходит РОВНО ОДИН раз, и оба представления
   * строятся из одного результата: записи кладутся в `Map` по ключу
   * `marketUniverseKey()`, а массив — это её значения. `Map` хранит
   * порядок вставки, поэтому технический порядок снимка сохраняется, а
   * `get()` и `getAll()` отдают ОДИН И ТОТ ЖЕ объект записи — разойтись
   * им больше нечем.
   *
   * Побеждает ПЕРВАЯ запись — то же правило, что у дедупликации discovery
   * (`PolymarketMarketDiscovery._buildEntries`): universe не должен
   * переворачивать выбор источника, иначе одинаковый снимок давал бы
   * разный universe в зависимости от того, кто его дедуплицировал.
   *
   * ### Почему дубликат не ошибка и не пишется в лог
   *
   * Бросать на снимке с дубликатами нельзя: universe — простой holder,
   * а данные, которые он умеет корректно нормализовать, не повод ронять
   * вызывающего. Заводить ради дубликата логгер (сейчас его у класса нет)
   * — тоже плата не по пользе: дубликат уже наблюдаем ТАМ, где он возник.
   * Discovery считает его в `diagnostics.duplicateMarkets` и логирует
   * конфликт vendor-записей, зная то, чего universe не знает (какая
   * именно vendor-запись отброшена). Второй голос об одном факте не
   * добавил бы информации, а превратил бы чистый holder без побочных
   * эффектов в объект с зависимостью на инфраструктуру.
   *
   * Незамеченным дубликат при этом не остаётся: диагностика снимка НЕ
   * пересчитывается, поэтому `diagnostics.supportedCryptoUpDown !==
   * getAll().length` — арифметически видимый признак того, что снимок
   * пришёл с дубликатами (см. {@link MarketUniverse.getSnapshot}).
   *
   * @example
   * ```typescript
   * // Снимок, собранный вызывающим (тест, будущий второй источник), —
   * // обычные мутабельные объекты. Снимок из `discovery.getSnapshot()`
   * // заморожен уже самим discovery, но universe на это НЕ полагается:
   * // копию делает replace(), а не производитель снимка.
   * const entries = [entry];
   * universe.replace({ observedAt, entries, diagnostics });
   *
   * entries.pop();              // мутируем источник после replace()
   * universe.getAll().length;   // → 1: universe держит свою копию
   *
   * // а то, что отдал universe, заморожено — мутация бросает TypeError:
   * // universe.getAll()[0].metrics.liquidity = other;
   *
   * // дубликат идентичности схлопывается во ВСЕХ представлениях сразу:
   * universe.replace({ observedAt, entries: [first, secondSameId], diagnostics });
   * universe.getAll().length;                       // → 1
   * universe.get(venueId, id) === universe.getAll()[0]; // → true
   * ```
   */
  public replace(snapshot: MarketDiscoverySnapshot): void {
    // Единственная дедупликация: индекс — и результат, и источник массива.
    // Свои объекты на каждом уровне: массив → запись → metrics.
    const index = new Map<string, MarketDiscoveryEntry>();
    for (const entry of snapshot.entries) {
      const key = marketUniverseKey(entry.market.venueId, entry.market.id);
      if (index.has(key)) {
        continue; // побеждает первая запись
      }
      index.set(
        key,
        Object.freeze({
          market: entry.market,
          metrics: Object.freeze({ ...entry.metrics }),
        }),
      );
    }
    // Map хранит порядок вставки → технический порядок снимка сохранён.
    const entries: readonly MarketDiscoveryEntry[] = Object.freeze([...index.values()]);
    this._snapshot = Object.freeze({
      observedAt: snapshot.observedAt,
      entries,
      diagnostics: Object.freeze({
        ...snapshot.diagnostics,
        // Разбор причин — вложенный объект: поверхностная копия оставила бы
        // его общим с источником и мутабельным (та же ошибка, что чинилась
        // у `metrics` записи).
        invalidMarkets: Object.freeze({ ...snapshot.diagnostics.invalidMarkets }),
      }),
    });
    this._index = index;
  }

  /**
   * Находит запись universe по идентичности рынка.
   *
   * @param venueId - Площадка рынка
   * @param marketId - Идентификатор рынка в пространстве имён площадки
   * @returns Замороженная запись universe (вместе с её `metrics`) или
   *   `undefined`, если такого рынка в universe нет
   *
   * @remarks
   * Идентичность — ПАРА `venueId + marketId`: одинаковый `marketId` на
   * разных площадках означает разные рынки.
   *
   * Отдаётся та же запись, что лежит в `getAll()`: индекс и массив ссылаются
   * на одни и те же замороженные объекты, поэтому lookup и обход не могут
   * разойтись содержимым.
   *
   * @example
   * ```typescript
   * const entry = universe.get(KnownVenues.POLYMARKET, marketId);
   * ```
   */
  public get(venueId: VenueId, marketId: MarketId): MarketDiscoveryEntry | undefined {
    return this._index.get(marketUniverseKey(venueId, marketId));
  }

  /**
   * Все записи universe в техническом порядке снимка.
   *
   * @returns Замороженный readonly-массив замороженных записей: ни массив,
   *   ни запись, ни её `metrics` мутировать нельзя (в strict mode попытка
   *   бросает `TypeError`)
   *
   * @remarks
   * Записи уникальны по паре `venueId + marketId`: обход не может увидеть
   * рынок, которого не видит `get()`, и наоборот — это одни и те же
   * объекты (см. {@link MarketUniverse.replace}). Поэтому `getAll()`
   * безопасно использовать как основу подписок и учёта: одна запись — один
   * рынок.
   *
   * @example
   * ```typescript
   * const cryptoMarkets = universe
   *   .getAll()
   *   .filter((entry) => entry.market.family === 'CRYPTO_UP_DOWN');
   * ```
   */
  public getAll(): readonly MarketDiscoveryEntry[] {
    return this._snapshot.entries;
  }

  /**
   * Текущий снимок целиком (записи + диагностика + момент наблюдения).
   *
   * @returns Замороженный снимок: сам объект, `diagnostics`, массив
   *   `entries`, каждая запись и её `metrics`
   *
   * @remarks
   * ### `diagnostics` — не счётчик содержимого universe
   *
   * Диагностика копируется из снимка КАК ЕСТЬ и никогда не пересчитывается:
   * это протокол ОБХОДА discovery («сколько страниц прочитано, сколько
   * записей отсеяно и почему»), а не описание того, что лежит в universe.
   * Пересчитать её здесь и нельзя, и не нужно: universe не наблюдал обход и
   * не знает, из-за чего рынок не дошёл до снимка.
   *
   * Практическое следствие: `diagnostics.supportedCryptoUpDown` может быть
   * БОЛЬШЕ, чем `entries.length`, если снимок пришёл с дубликатами — их
   * схлопывает `replace()`, а счётчик остаётся тем, что насчитал источник.
   * Для снимка от корректного discovery числа совпадают (он дедуплицирует
   * сам), поэтому расхождение — полезный признак «источник отдал дубликат»,
   * а не поломка. Размер universe читайте из `entries.length`/`getAll()`,
   * а не из диагностики.
   *
   * @example
   * ```typescript
   * const { observedAt, entries, diagnostics } = universe.getSnapshot();
   * logger.info('Universe', { observedAt: observedAt.toISO(), ...diagnostics });
   *
   * entries.length;                     // сколько рынков в universe
   * diagnostics.supportedCryptoUpDown;  // сколько их насчитал обход discovery
   * ```
   */
  public getSnapshot(): MarketDiscoverySnapshot {
    return this._snapshot;
  }
}

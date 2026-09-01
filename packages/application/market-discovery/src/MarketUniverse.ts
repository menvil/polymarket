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
  invalidMarkets: 0,
  duplicateMarkets: 0,
  eventFetches: 0,
  eventCacheHits: 0,
});

/**
 * In-memory source of truth текущего universe canonical рынков.
 */
export class MarketUniverse {
  /** Текущий снимок (заморожен вместе с массивом записей). */
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
   * полон по контракту порта. Массив записей копируется и замораживается:
   * source of truth не должен меняться из-под потребителя, который держит
   * ссылку на результат `getAll()`.
   *
   * Дубликаты `venueId + marketId` в снимке невозможны (их снимает
   * discovery); если они всё же придут, индекс сохранит ПЕРВУЮ запись —
   * то же правило, что у дедупликации discovery, чтобы lookup и порядок
   * `getAll()` не расходились.
   *
   * @example
   * ```typescript
   * universe.replace(discovery.getSnapshot());
   * ```
   */
  public replace(snapshot: MarketDiscoverySnapshot): void {
    const entries = Object.freeze([...snapshot.entries]);
    const index = new Map<string, MarketDiscoveryEntry>();
    for (const entry of entries) {
      const key = marketUniverseKey(entry.market.venueId, entry.market.id);
      if (!index.has(key)) {
        index.set(key, entry);
      }
    }
    this._snapshot = Object.freeze({
      observedAt: snapshot.observedAt,
      entries,
      diagnostics: Object.freeze({ ...snapshot.diagnostics }),
    });
    this._index = index;
  }

  /**
   * Находит запись universe по идентичности рынка.
   *
   * @param venueId - Площадка рынка
   * @param marketId - Идентификатор рынка в пространстве имён площадки
   * @returns Запись или `undefined`, если такого рынка в universe нет
   *
   * @remarks
   * Идентичность — ПАРА `venueId + marketId`: одинаковый `marketId` на
   * разных площадках означает разные рынки.
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
   * @returns Замороженный readonly-массив записей
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
   * @returns Замороженный снимок
   *
   * @example
   * ```typescript
   * const { observedAt, diagnostics } = universe.getSnapshot();
   * logger.info('Universe', { observedAt: observedAt.toISO(), ...diagnostics });
   * ```
   */
  public getSnapshot(): MarketDiscoverySnapshot {
    return this._snapshot;
  }
}

/**
 * Реестр стаканов — хранит Orderbook экземпляры per (marketId, tokenId).
 *
 * @remarks
 * `Orderbook` (`@polymarket/orderbook`) иммутабелен — каждое обновление стакана
 * строит НОВЫЙ экземпляр (`Object.freeze()`-нут в конструкторе), не мутирует
 * существующий. `BookUpdateHandler` владеет записью: строит новый `Orderbook`
 * через `Orderbook.fromLevels(...)` и кладёт его в реестр через `set()` —
 * в отличие от старого mutable `OrderBook` (`@polymarket/order-book`, заменён в
 * Этапе 10a, пакет физически удалён в Этапе 10d), который вызывающий код
 * мутировал напрямую через `getOrCreate()`.
 *
 * Ключ реестра: `(marketId, tokenId)` (составной, уникален в системе).
 * MarketDataFeedAdapter управляет жизненным циклом реестра.
 */
import type { Orderbook } from '@polymarket/orderbook';
import type { MarketId, InstrumentId } from '@polymarket/ids';

/**
 * Порт реестра стаканов — CRUD по ключу (marketId, tokenId).
 *
 * @remarks
 * Подробности владения и immutable-паттерна записи — см. докблок модуля выше.
 */
export interface IBookRegistry {
  /**
   * Возвращает Orderbook по ключу (marketId, tokenId) или undefined.
   *
   * @param marketId - ID рынка (condition_id)
   * @param tokenId - ID токена (UP/DOWN outcome token)
   * @returns Orderbook или undefined если не найден
   */
  get(marketId: MarketId, tokenId: InstrumentId): Orderbook | undefined;

  /**
   * Возвращает существующий Orderbook или пустой (`Orderbook.empty(...)`), если
   * для этого ключа ещё не было ни одного снапшота.
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   * @returns Orderbook (всегда ненулевой)
   */
  getOrCreate(marketId: MarketId, tokenId: InstrumentId): Orderbook;

  /**
   * Кладёт (заменяет) Orderbook для ключа (marketId, tokenId).
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   * @param book - Новый (иммутабельный) экземпляр Orderbook
   *
   * @remarks
   * Обязательная точка записи после immutable-обновления — `Orderbook` не
   * мутируется на месте, вызывающий код обязан явно положить новый экземпляр
   * назад в реестр.
   */
  set(marketId: MarketId, tokenId: InstrumentId, book: Orderbook): void;

  /**
   * Удаляет Orderbook из реестра.
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   */
  delete(marketId: MarketId, tokenId: InstrumentId): void;

  /**
   * Удаляет все Orderbook для указанного рынка.
   *
   * @param marketId - ID рынка
   *
   * @remarks
   * Вызывается при закрытии рынка (MARKET_CLOSED) для освобождения памяти.
   * Удаляет все токены (YES/NO), связанные с данным рынком.
   */
  deleteMarket(marketId: MarketId): void;
}

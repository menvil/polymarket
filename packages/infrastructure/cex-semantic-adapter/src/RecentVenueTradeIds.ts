/**
 * Ограниченная память недавно виденных venue-идентификаторов сделок.
 *
 * @remarks
 * ### Зачем это существует
 *
 * `CexSource` создаёт инстансы с `newUpdates: true` — официальным
 * механизмом CCXT Pro «отдавать только новые сделки с прошлого вызова».
 * Этого достаточно в пределах одной сессии, но НЕ переживает пересоздание
 * инстанса: при плановом рестарте (15 мин в production) и при reconnect
 * новый клиент повторно отдаёт часть кэша, и мы видим ту же сделку второй
 * раз.
 *
 * Это не гипотеза, а замер на записанном raw-архиве (5 прогонов
 * checkpoint-а, 6 бирж, 1 128 052 сделки):
 *
 * ```text
 * биржа       сделок    дублей (venue+symbol+id)
 * binance     812 346   0
 * bybit       105 738   0
 * kraken       10 170   0
 * okx          62 799   0
 * coinbase     45 742   8
 * cryptocom    91 257   517
 * ```
 *
 * Все 525 дублей — ПОБАЙТНО идентичные повторы наблюдения с тем же
 * стабильным venue-id, то есть повторная выдача, а не две разные сделки с
 * совпавшим идентификатором. Дистанция повтора (в сделках того же
 * инструмента): медиана 47, p95 50, максимум 74.
 *
 * ### Почему именно так, а не generic-подсистема
 *
 * Дедуп ключуется ТОЛЬКО настоящим идентификатором биржи: сделка без id
 * сюда не попадает вовсе (см. `CexSemanticAdapter`), потому что
 * синтетический ключ склеивал бы легитимно одинаковые сделки. Ёмкость
 * фиксированная и общая на инструмент — при наблюдённом максимуме 74
 * дефолт 512 даёт семикратный запас и при этом ограничивает память
 * сверху: 512 строк на инструмент, а не растущий на весь процесс индекс.
 *
 * Вытеснение — FIFO по порядку наблюдения, а не LRU: повтор приходит
 * пачкой сразу после reconnect, «частота обращения» тут смысла не имеет,
 * а FIFO не требует перестройки порядка на каждом попадании.
 */

/** Ёмкость окна по умолчанию — 7× наблюдённого максимума повтора (74). */
export const DEFAULT_RECENT_TRADE_IDS_CAPACITY = 512;

/**
 * FIFO-окно недавно виденных идентификаторов сделок одного инструмента.
 *
 * @remarks
 * Инвариант: `size <= capacity` в любой момент. Класс не знает ни про
 * биржи, ни про сообщения — вызывающий сам держит по экземпляру на
 * `venueId + instrumentId`.
 *
 * @example
 * ```typescript
 * const seen = new RecentVenueTradeIds(512);
 * seen.registerIfNew('6617804453'); // → true  (новая)
 * seen.registerIfNew('6617804453'); // → false (повтор)
 * ```
 */
export class RecentVenueTradeIds {
  private readonly _capacity: number;
  private readonly _seen = new Set<string>();
  /** Порядок наблюдения — источник истины для вытеснения. */
  private readonly _order: string[] = [];
  /** Индекс головы очереди: сдвиг вместо `shift()` (O(1) вместо O(n)). */
  private _head = 0;

  /**
   * Создаёт окно заданной ёмкости.
   *
   * @param capacity - Максимум хранимых идентификаторов
   * @throws {RangeError} Если ёмкость не является положительным целым
   */
  constructor(capacity: number = DEFAULT_RECENT_TRADE_IDS_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RecentVenueTradeIds capacity must be a positive integer, got ${capacity}`);
    }
    this._capacity = capacity;
  }

  /** Сколько идентификаторов помнится сейчас. */
  public get size(): number {
    return this._seen.size;
  }

  /**
   * Регистрирует идентификатор, если он ещё не встречался.
   *
   * @param venueTradeId - Настоящий идентификатор сделки на бирже
   * @returns `true`, если идентификатор новый (сделку следует
   *   опубликовать); `false`, если это повтор уже виденного наблюдения
   *
   * @remarks
   * Регистрация и проверка — одна операция специально: раздельные
   * `has()`/`add()` позволили бы вызывающему проверить и забыть добавить,
   * и дедуп молча перестал бы работать.
   *
   * @example
   * ```typescript
   * if (seen.registerIfNew(id)) {
   *   await publishTrade();
   * }
   * ```
   */
  public registerIfNew(venueTradeId: string): boolean {
    if (this._seen.has(venueTradeId)) {
      return false;
    }
    this._seen.add(venueTradeId);
    this._order.push(venueTradeId);
    if (this._seen.size > this._capacity) {
      const evicted = this._order[this._head];
      this._head++;
      if (evicted !== undefined) {
        this._seen.delete(evicted);
      }
      // Хвост отработанных ячеек не растёт бесконечно: как только его
      // накопилось больше самой ёмкости, массив пересобирается
      if (this._head > this._capacity) {
        this._order.splice(0, this._head);
        this._head = 0;
      }
    }
    return true;
  }
}

/**
 * Raw DTO типы для Orderbook
 *
 * @remarks
 * Типы для "сырых" данных, как они приходят от exchange/API.
 * Допускают нули, дубликаты, несортированность - всё что может прийти извне.
 *
 * Raw данные проходят через OrderbookNormalizer для создания
 * validated Orderbook entity.
 */

/**
 * Raw уровень стакана (как приходит от API)
 *
 * @remarks
 * Примитивные типы - number вместо Price/Quantity VO.
 * Может содержать некорректные данные:
 * - price = 0 или отрицательное
 * - quantity = 0 или отрицательное
 * - дубликаты price
 */
export interface RawLevel {
  readonly price: number;
  readonly quantity: number;
}

/**
 * Raw orderbook snapshot (как приходит от API)
 *
 * @remarks
 * Сырые данные без гарантий инвариантов.
 *
 * Может содержать:
 * - Несортированные уровни
 * - Дубликаты price
 * - Нулевые quantity
 * - Crossed book (bid >= ask)
 * - Отсутствующие timestamps
 * - Некорректные ID
 */
export interface RawOrderbook {
  /**
   * Идентификатор рынка/инструмента
   *
   * @remarks
   * Raw string - может быть пустым или некорректным.
   */
  readonly marketId?: string;

  /**
   * Идентификатор asset/token
   *
   * @remarks
   * Raw string - может быть пустым или некорректным.
   */
  readonly tokenId?: string;

  /**
   * Массив bid уровней
   *
   * @remarks
   * Может быть несортированным, содержать дубликаты, нулевые quantity.
   */
  readonly bids: readonly RawLevel[];

  /**
   * Массив ask уровней
   *
   * @remarks
   * Может быть несортированным, содержать дубликаты, нулевые quantity.
   */
  readonly asks: readonly RawLevel[];

  /**
   * Timestamp от venue/exchange (если есть)
   *
   * @remarks
   * Когда exchange сгенерировал этот snapshot.
   * Может быть ISO string, unix timestamp (ms), или отсутствовать.
   * Используется для анализа latency и stale detection.
   */
  readonly venueTimestamp?: string | number;

  /**
   * Timestamp получения данных (локально)
   *
   * @remarks
   * Когда мы получили эти данные.
   * Если отсутствует - будет установлен при нормализации.
   * Используется для stale detection и age calculation.
   */
  readonly receivedAt?: number; // unix timestamp ms
}

/**
 * Снапшоты mutable-объектов CCXT Pro в момент наблюдения.
 *
 * @remarks
 * CCXT Pro возвращает из `watchOrderBook*` ЖИВЫЕ объекты своих внутренних
 * кэшей: стакан мутируется in-place при каждом delta-обновлении, стороны
 * (`bids`/`asks`) — кастомные Array-подклассы со скрытым состоянием.
 * Публиковать ссылку на такой объект нельзя — к моменту чтения consumer-ом
 * vendor его уже изменит.
 *
 * Снапшот = **JSON-совместимая структурная копия состояния в момент
 * наблюдения**: имена и значения vendor-полей сохраняются как есть,
 * прототипы кэшей отбрасываются, результат владеется сообщением и
 * гарантированно сериализуем. Это ownership/immutability/serializability,
 * а НЕ семантическая нормализация (никаких rename/VO/Entity).
 *
 * Единственная транспортная модификация — truncate сторон стакана до
 * эффективной depth подписки: некоторые биржи игнорируют `limit` и отдают
 * полный кэш; запись полной глубины при подписке на N уровней раздувала бы
 * партиции на порядки (legacy-коллектор делал тот же slice).
 */
import type { CcxtOrderBookSnapshot, CcxtTradeSnapshot } from './CexExternalMessage.js';
import type { CcxtRawOrderBook, CcxtRawTrade } from './CcxtVendorPort.js';

/**
 * Снимает JSON-совместимую структурную копию значения.
 *
 * @param value - Любой JSON-сериализуемый объект vendor-а
 * @returns Глубокая копия: только enumerable own-поля, `undefined`-поля
 *   отброшены (эквивалент JSON-представления)
 * @throws {TypeError} Если значение не сериализуемо в JSON (циклические
 *   ссылки, BigInt) — вызывающий обязан обработать и не ронять поток
 */
function toJsonSnapshot<T>(value: object): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Снимает снапшот unified стакана CCXT с truncate до эффективной depth.
 *
 * @param raw - Живой объект стакана из `watchOrderBook*`/`fetchOrderBook`
 * @param depth - Эффективная глубина подписки (количество уровней на сторону)
 * @returns Immutable JSON-снапшот: vendor-поля as-is, `bids`/`asks`
 *   ограничены depth
 * @throws {TypeError} Если vendor-объект не сериализуем в JSON
 *
 * @example
 * ```typescript
 * const ob = await instance.watchOrderBook('BTC/USDT', 10);
 * const snapshot = snapshotOrderBook(ob, 10);
 * // vendor мутирует ob дальше — snapshot не изменится
 * ```
 */
export function snapshotOrderBook(raw: CcxtRawOrderBook, depth: number): CcxtOrderBookSnapshot {
  // Shallow-копия ДО JSON-round-trip: срезаем стороны заранее, чтобы не
  // сериализовывать полный кэш глубины ради нескольких уровней.
  const shallow: Record<string, unknown> = { ...raw };
  const bids = raw.bids;
  if (Array.isArray(bids)) {
    shallow['bids'] = Array.prototype.slice.call(bids, 0, depth);
  }
  const asks = raw.asks;
  if (Array.isArray(asks)) {
    shallow['asks'] = Array.prototype.slice.call(asks, 0, depth);
  }
  return toJsonSnapshot<CcxtOrderBookSnapshot>(shallow);
}

/**
 * Снимает снапшот одной unified сделки CCXT.
 *
 * @param raw - Unified сделка из batch-а `watchTrades*`
 * @returns Immutable JSON-снапшот сделки (включая vendor-поле `info`)
 * @throws {TypeError} Если vendor-объект не сериализуем в JSON
 *
 * @example
 * ```typescript
 * const trades = await instance.watchTrades('BTC/USDT');
 * const snapshots = trades.map((trade) => snapshotTrade(trade));
 * ```
 */
export function snapshotTrade(raw: CcxtRawTrade): CcxtTradeSnapshot {
  return toJsonSnapshot<CcxtTradeSnapshot>(raw);
}

/**
 * Canonical идентичность биржевого наблюдения: площадка и инструмент.
 *
 * @remarks
 * Единственное место, где routing-поля raw-payload (`exchangeId`,
 * `marketType`, `symbol`) превращаются в canonical `VenueId`/`InstrumentId`.
 * Вынесено из адаптера отдельным модулем, потому что это самостоятельная
 * ответственность с собственными инвариантами (детерминизм, отсутствие
 * коллизий между типами рынка) и собственным набором тестов — а не просто
 * пара строковых операций.
 */
import type { InstrumentId, VenueId } from '@polymarket/ids';
import { asInstrumentId, asVenueId } from '@polymarket/ids';
import type { CexMarketType } from '@polymarket/cex-v2';

/** Разделитель типа рынка и vendor-символа внутри `InstrumentId`. */
const MARKET_TYPE_SEPARATOR = ':';

/** Идентичность наблюдения внутри контура. */
export interface CexInstrumentIdentity {
  /** Площадка (биржа), которой принадлежит наблюдение. */
  readonly venueId: VenueId;
  /** Инструмент внутри площадки. */
  readonly instrumentId: InstrumentId;
}

/**
 * Routing-поля raw-наблюдения, из которых выводится идентичность.
 *
 * @remarks
 * Структурное подмножество `CexOrderbookPayload`/`CexTradePayload`: оба
 * payload-а несут одни и те же три поля, и идентичность считается по ним
 * одинаково.
 */
export interface CexIdentitySource {
  /** Идентификатор биржи в ccxt (`exchange.id`, напр. `binance`). */
  readonly exchangeId: string;
  /** Тип рынка CCXT-инстанса (`options.defaultType`). */
  readonly marketType: CexMarketType;
  /** Unified-символ наблюдения. */
  readonly symbol: string;
}

/**
 * Выводит `VenueId` из идентификатора биржи ccxt.
 *
 * @param exchangeId - `exchange.id` инстанса CCXT (напр. `binance`)
 * @returns `VenueId` либо `undefined`, если идентификатор биржи не
 *   укладывается в формат canonical-типа
 *
 * @remarks
 * Отображение детерминированное и единственное: `exchangeId` в ccxt —
 * lower-case ключ (`binance`, `okx`, `cryptocom`), а `VenueId` требует
 * upper-case (`^[A-Z_][A-Z0-9_]{0,31}$`), поэтому преобразование сводится к
 * подъёму регистра. Никакой таблицы «binance → BINANCE» нет и быть не
 * должно: она означала бы, что новая биржа в конфиге молча не получает
 * идентичности, — один адаптер обязан работать для ВСЕХ настроенных бирж.
 *
 * Биржа, чей ccxt-идентификатор не проходит формат (например, начинается с
 * цифры), получает `undefined` — вызывающий обязан отбросить наблюдение со
 * счётчиком. Подставлять суррогат запрещено: чужой `venueId` смешал бы
 * книги разных площадок.
 *
 * @example
 * ```typescript
 * toVenueId('binance');   // → 'BINANCE' as VenueId
 * toVenueId('cryptocom'); // → 'CRYPTOCOM' as VenueId
 * toVenueId('1btcxe');    // → undefined (canonical-формат запрещает цифру первой)
 * ```
 */
export function toVenueId(exchangeId: string): VenueId | undefined {
  if (typeof exchangeId !== 'string') return undefined;
  return asVenueId(exchangeId.trim().toUpperCase());
}

/**
 * Выводит `InstrumentId` из типа рынка и unified-символа CCXT.
 *
 * @param marketType - Тип рынка инстанса (`spot` | `future` | `swap`)
 * @param symbol - Unified-символ наблюдения (`BTC/USDT`, `BTC/USDT:USDT`)
 * @returns `InstrumentId` вида `{marketType}:{symbol}` либо `undefined`,
 *   если символ пуст/непригоден
 *
 * @remarks
 * ### Почему тип рынка входит в идентичность
 *
 * Спотовый `BTC/USDT` и бессрочный своп `BTC/USDT` — РАЗНЫЕ инструменты с
 * разными книгами и разными ценами. Unified-символ CCXT обычно разводит их
 * сам (`BTC/USDT` против `BTC/USDT:USDT`), но НАШ source-контракт этого не
 * гарантирует: `CexSource` берёт символ как `rawOb.symbol ?? symbolFallback`,
 * где fallback — символ из конфигурации подписки. Настроенный как
 * `{"type":"swap","symbols":["BTC/USDT"]}` инстанс на бирже, которая символ
 * в стакане не проставляет, дал бы ровно `BTC/USDT` — и своп слился бы со
 * спотом в один инструмент.
 *
 * `marketType` же гарантирован всегда: это `options.defaultType` инстанса,
 * который задаём мы сами. Поэтому идентичность строится на нём, а не на
 * надежде, что vendor заполнил суффикс.
 *
 * ### Почему не `venueId` в префиксе
 *
 * `venueId` — отдельное поле и сущности стакана, и всех canonical-событий.
 * Инструмент обязан быть однозначен ВНУТРИ площадки, а не глобально;
 * дублировать биржу в идентификаторе значило бы хранить её дважды.
 *
 * ### Почему vendor-символ сохранён дословно
 *
 * Значащая часть символа не нормализуется: регистр, разделители, суффикс
 * расчётной валюты `:USDT`, дата экспирации `-260327` остаются тем, чем их
 * назвала биржа. Любая «умная» нормализация схлопывала бы разные контракты
 * в один инструмент, а это ровно то, что запрещено.
 *
 * Единственное исключение — обрамляющие пробелы, и они срезаются НЕ ради
 * нормализации, а чтобы идентификатор вообще был корректен: `asInstrumentId`
 * обрезает только края готовой строки, поэтому символ `' BTC/USDT'` без
 * этого дал бы `'spot: BTC/USDT'` — пробел уехал бы внутрь идентификатора.
 * Схлопнуть этим ничего нельзя: unified-символы CCXT обрамляющих пробелов
 * не несут (замер на записанном архиве: 0 из 36 120 наблюдений), а отвергать
 * из-за них всё наблюдение значило бы терять поток биржи из-за косметики.
 *
 * @example
 * ```typescript
 * toInstrumentId('spot', 'BTC/USDT');       // → 'spot:BTC/USDT'
 * toInstrumentId('swap', 'BTC/USDT:USDT');  // → 'swap:BTC/USDT:USDT'
 * toInstrumentId('swap', 'BTC/USDT');       // → 'swap:BTC/USDT' (НЕ равен споту)
 * toInstrumentId('future', 'BTC/USDT:USDT-260327'); // → 'future:BTC/USDT:USDT-260327'
 * ```
 */
export function toInstrumentId(
  marketType: CexMarketType,
  symbol: string,
): InstrumentId | undefined {
  if (typeof symbol !== 'string') return undefined;
  const trimmed = symbol.trim();
  if (trimmed.length === 0) return undefined;
  return asInstrumentId(`${marketType}${MARKET_TYPE_SEPARATOR}${trimmed}`);
}

/**
 * Выводит полную идентичность наблюдения из его routing-полей.
 *
 * @param source - Routing-поля raw-payload (`exchangeId`/`marketType`/`symbol`)
 * @returns Пара `venueId`/`instrumentId` либо `undefined`, если хотя бы одна
 *   часть непригодна
 *
 * @remarks
 * Идентичность выводится ЦЕЛИКОМ или не выводится вовсе: наблюдение с
 * площадкой, но без инструмента (или наоборот) опубликовать нельзя —
 * canonical-контракт требует обоих, а выдумывать недостающую часть
 * запрещено.
 *
 * @example
 * ```typescript
 * resolveCexIdentity({ exchangeId: 'binance', marketType: 'spot', symbol: 'BTC/USDT' });
 * // → { venueId: 'BINANCE', instrumentId: 'spot:BTC/USDT' }
 * ```
 */
export function resolveCexIdentity(
  source: CexIdentitySource,
): CexInstrumentIdentity | undefined {
  const venueId = toVenueId(source.exchangeId);
  if (venueId === undefined) return undefined;
  const instrumentId = toInstrumentId(source.marketType, source.symbol);
  if (instrumentId === undefined) return undefined;
  return { venueId, instrumentId };
}

/**
 * Строит ключ per-venue+instrument состояния адаптера.
 *
 * @param identity - Идентичность наблюдения
 * @returns Строковый ключ, различающий площадки и инструменты
 *
 * @remarks
 * Ключевать состояние ОДНИМ символом нельзя: `BTC/USDT` на binance и на okx
 * — разные книги с разными верхушками и независимой нумерацией, и общий
 * ключ смешал бы их в одно состояние. ` ` как разделитель выбран
 * потому, что оба branded-типа запрещают control characters, — коллизия
 * ключей из-за разделителя невозможна.
 *
 * @example
 * ```typescript
 * instrumentStateKey({ venueId, instrumentId }); // → 'BINANCE spot:BTC/USDT'
 * ```
 */
export function instrumentStateKey(identity: CexInstrumentIdentity): string {
  return `${identity.venueId} ${identity.instrumentId}`;
}

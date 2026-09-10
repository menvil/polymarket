/**
 * Идентичность торгового аккаунта в приватном состоянии.
 *
 * @remarks
 * Аккаунт адресуется ПАРОЙ «площадка + аккаунт», и обе части обязательны:
 *
 * ```text
 * VenueId
 *   └── accountKey(AccountId)   canonical строка
 *         └── AccountRuntimeState
 * ```
 *
 * ### Почему не `Map<AccountId, …>`
 *
 * `AccountId` — обычный объект, а `Map` ключуется по ссылке. Два
 * эквивалентных `AccountId`, собранных в разных местах (один разобран из
 * снапшота, другой построен фабрикой), — это два разных JS-объекта, и
 * состояние, ключёванное объектом, увидело бы два разных аккаунта там, где
 * есть один. Поэтому ключ — canonical строка `accountIdToString`.
 *
 * ### Почему вложенные `Map`, а не составная строка
 *
 * `"POLYMARKET:venue:POLYMARKET:user_1"` теряет типы, а склейка через
 * разделитель делает совпадение идентификаторов неотличимым от опечатки. То
 * же решение принято в `TradingHotState` для пары `venueId + marketId`.
 */
import { accountIdToString, type AccountId } from '@polymarket/ids';

/**
 * Canonical ключ аккаунта внутри пространства имён площадки.
 *
 * @param accountId - Идентификатор аккаунта любого вида
 * @returns Строковое представление, пригодное как ключ `Map`
 *
 * @remarks
 * Тонкая обёртка над `accountIdToString` из `@polymarket/ids` — сознательно
 * своей реализации нет. Свой `JSON.stringify` дал бы ключ, зависящий от
 * порядка полей, а два эквивалентных аккаунта с разным порядком свойств
 * стали бы разными записями состояния.
 *
 * @example
 * ```typescript
 * const key = accountKey(accountIdFromWallet(address));
 * accounts.get(venueId)?.get(key);
 * ```
 */
export function accountKey(accountId: AccountId): string {
  return accountIdToString(accountId);
}

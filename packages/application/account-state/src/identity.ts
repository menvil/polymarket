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
import {
  accountIdToString,
  isSubaccount,
  isVenueAccount,
  type AccountId,
  type VenueId,
} from '@polymarket/ids';

/**
 * Предел раскрутки цепочки SUBACCOUNT при поиске venue-корня.
 *
 * @remarks
 * Совпадает с ограничением глубины в `@polymarket/ids`
 * (`MAX_SUBACCOUNT_DEPTH = 5`) плюс запас: фабрика `accountIdForSubaccount`
 * держит инвариант, и цикл нужен только как защита от испорченной структуры,
 * собранной в обход фабрики.
 */
const MAX_ACCOUNT_ROOT_DEPTH = 16;

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

/**
 * Площадка, «встроенная» в сам `AccountId`, если она там есть.
 *
 * @param accountId - Идентификатор аккаунта
 * @returns `VenueId` для VENUE-аккаунта и SUBACCOUNT с VENUE-корнем;
 *   `undefined` для WALLET-аккаунта и SUBACCOUNT с WALLET-корнем
 *
 * @remarks
 * `AccountId` бывает трёх видов, и площадку содержит только один из них:
 *
 * ```text
 * WALLET       0x1234…                       venue НЕ задан
 * VENUE        POLYMARKET:user_1              venue задан явно
 * SUBACCOUNT   base + name                    venue = venue корня
 * ```
 *
 * У WALLET-аккаунта отсутствие площадки — это норма, а не дефект: один и тот
 * же кошелёк торгует на нескольких площадках, и venue namespace ему задаёт
 * payload события. Поэтому `undefined` здесь означает «проверять нечего», а
 * не «проверка не прошла».
 *
 * Цикл раскрутки ограничен {@link MAX_ACCOUNT_ROOT_DEPTH}: при испорченной
 * структуре функция возвращает `undefined` вместо бесконечной рекурсии, и
 * вызывающий просто не выполняет venue-проверку — отказ в этом случае дадут
 * проверки портфеля, а не переполнение стека.
 *
 * @example
 * ```typescript
 * embeddedVenueId(accountIdFromWallet(address));            // → undefined
 * embeddedVenueId(venueAccount);                            // → 'POLYMARKET'
 * embeddedVenueId(accountIdForSubaccount(venueAccount, 'a')); // → 'POLYMARKET'
 * ```
 */
export function embeddedVenueId(accountId: AccountId): VenueId | undefined {
  let current: AccountId = accountId;
  for (let depth = 0; depth < MAX_ACCOUNT_ROOT_DEPTH; depth += 1) {
    if (isVenueAccount(current)) return current.venueId;
    if (!isSubaccount(current)) return undefined;
    current = current.base;
  }
  return undefined;
}

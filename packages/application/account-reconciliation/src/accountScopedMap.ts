/**
 * Отображение «площадка + аккаунт → значение» на вложенных `Map`.
 *
 * @remarks
 * Та же структура, что у `AccountHotState`:
 *
 * ```text
 * VenueId
 *   └── accountKey(AccountId)   canonical строка
 *         └── T
 * ```
 *
 * Ключ второго уровня — canonical `accountIdToString` (через `accountKey` из
 * `@polymarket/account-state`), а не сам объект: `Map` ключуется по ссылке, и
 * два эквивалентных `AccountId`, собранных в разных местах, дали бы два
 * аккаунта. Составной строки `"venue:account"` с ручным разбором тоже нет —
 * она теряет типы.
 */
import { accountKey } from '@polymarket/account-state';
import type { AccountId, VenueId } from '@polymarket/ids';

/**
 * Значения по паре «площадка + аккаунт».
 *
 * @example
 * ```typescript
 * const slots = new AccountScopedMap<Slot>();
 * const slot = slots.getOrCreate(venueId, accountId, () => ({ running: false }));
 * ```
 */
export class AccountScopedMap<T> {
  private readonly _byVenue = new Map<VenueId, Map<string, T>>();

  /**
   * Значение для пары либо `undefined`.
   *
   * @param venueId - Площадка
   * @param accountId - Аккаунт
   * @returns Сохранённое значение
   */
  public get(venueId: VenueId, accountId: AccountId): T | undefined {
    return this._byVenue.get(venueId)?.get(accountKey(accountId));
  }

  /**
   * Сохраняет значение для пары.
   *
   * @param venueId - Площадка
   * @param accountId - Аккаунт
   * @param value - Новое значение
   */
  public set(venueId: VenueId, accountId: AccountId, value: T): void {
    let byAccount = this._byVenue.get(venueId);
    if (byAccount === undefined) {
      byAccount = new Map<string, T>();
      this._byVenue.set(venueId, byAccount);
    }
    byAccount.set(accountKey(accountId), value);
  }

  /**
   * Значение для пары; при отсутствии — создаёт и сохраняет.
   *
   * @param venueId - Площадка
   * @param accountId - Аккаунт
   * @param create - Фабрика значения для новой пары
   * @returns Существующее либо только что созданное значение
   */
  public getOrCreate(venueId: VenueId, accountId: AccountId, create: () => T): T {
    const existing = this.get(venueId, accountId);
    if (existing !== undefined) return existing;
    const created = create();
    this.set(venueId, accountId, created);
    return created;
  }
}

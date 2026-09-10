/**
 * Идентичность торгового АККАУНТА — прямые unit-тесты.
 *
 * @remarks
 * Метки `§44` и `§10` соответствуют плану MR.
 *
 * Сравнение заявок и исполнений живёт в своих доменных пакетах и там же
 * тестируется (`@polymarket/order` → `orderIdentity.test.ts`,
 * `@polymarket/fill` → `fillFactIdentity.test.ts`). Здесь остаётся то, что
 * действительно принадлежит приватному состоянию: как аккаунт адресуется и
 * какая площадка в него встроена.
 */
import { describe, expect, it } from '@jest/globals';
import { accountIdFromVenue } from '@polymarket/ids';
import { accountKey } from '../src/index.js';
import {
  OTHER_VENUE,
  VENUE,
  must,
  venueAccount,
  venueSubaccount,
  walletAccount,
} from './helpers/fixtures.js';

describe('§44. ключ аккаунта — canonical строка', () => {
  it('эквивалентные, но разные объекты дают один ключ', () => {
    const a = walletAccount();
    const b = walletAccount();
    expect(a).not.toBe(b);
    expect(accountKey(a)).toBe(accountKey(b));
  });

  it('разные виды аккаунта дают разные ключи', () => {
    const keys = new Set([
      accountKey(walletAccount()),
      accountKey(venueAccount(VENUE, 'user-1')),
      accountKey(venueAccount(OTHER_VENUE, 'user-1')),
      accountKey(venueSubaccount(VENUE, 'trading')),
    ]);
    expect(keys.size).toBe(4);
  });

  it('escaping не даёт коллизии на разделителе', () => {
    // `user:1` и `user` + subaccount `1` склеились бы при наивной конкатенации.
    const tricky = must(accountIdFromVenue(VENUE, 'user:1'));
    expect(accountKey(tricky)).not.toBe(accountKey(venueSubaccount(VENUE, '1')));
  });
});

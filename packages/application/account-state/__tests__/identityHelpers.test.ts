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
import {
  KnownVenues,
  accountIdForSubaccount,
  accountIdFromVenue,
  asVenueId,
} from '@polymarket/ids';
import { accountKey, embeddedVenueId } from '../src/index.js';
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

describe('§10. встроенная площадка AccountId', () => {
  it('WALLET встроенной площадки не имеет', () => {
    expect(embeddedVenueId(walletAccount())).toBeUndefined();
  });

  it('VENUE отдаёт свою площадку', () => {
    expect(embeddedVenueId(venueAccount(VENUE, 'user-1'))).toBe(VENUE);
    expect(embeddedVenueId(venueAccount(OTHER_VENUE, 'user-1'))).toBe(OTHER_VENUE);
  });

  it('SUBACCOUNT наследует площадку venue-корня через всю цепочку', () => {
    const level1 = venueSubaccount(OTHER_VENUE, 'a');
    const level2 = must(accountIdForSubaccount(level1, 'b'));
    const level3 = must(accountIdForSubaccount(level2, 'c'));
    expect(embeddedVenueId(level3)).toBe(OTHER_VENUE);
  });

  it('SUBACCOUNT над кошельком встроенной площадки не имеет', () => {
    const overWallet = must(accountIdForSubaccount(walletAccount(), 'trading'));
    expect(embeddedVenueId(overWallet)).toBeUndefined();
  });

  it('custom venue тоже распознаётся', () => {
    const custom = asVenueId('MY_VENUE');
    if (custom === undefined) throw new Error('test setup failed: invalid custom venue');
    expect(embeddedVenueId(venueAccount(custom, 'user-1'))).toBe(custom);
    expect(KnownVenues.POLYMARKET).toBe(VENUE);
  });
});

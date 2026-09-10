/**
 * Помощники сравнения идентичности — прямые unit-тесты.
 *
 * @remarks
 * Метки `§44`…`§46` соответствуют плану MR.
 *
 * Через проектор эти функции уже проверены на реальных сценариях. Здесь
 * проверяется то, чего сценарий не показывает: что сравнение действительно
 * идёт по canonical-равенствам, а не по ссылке и не по строке. Разница видна
 * только на парах, где ссылки различаются, а значения совпадают, — и наоборот.
 */
import { describe, expect, it } from '@jest/globals';
import {
  KnownVenues,
  accountIdForSubaccount,
  accountIdFromVenue,
  asVenueId,
} from '@polymarket/ids';
import {
  accountKey,
  embeddedVenueId,
  findFillFactDifference,
  findOrderIdentityDifference,
  sameFillFact,
  sameOrderIdentity,
  sameOrderState,
} from '../src/index.js';
import {
  DOWN_TOKEN,
  OTHER_VENUE,
  VENUE,
  fill as makeFill,
  must,
  order,
  strategyId,
  venueAccount,
  venueSubaccount,
  walletAccount,
  withFill,
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

describe('§45. идентичность и состояние заявки', () => {
  it('пересобранная заявка равна исходной по идентичности и по состоянию', () => {
    const a = order({ accountId: walletAccount() });
    const b = order({ accountId: walletAccount() });
    expect(a).not.toBe(b);
    expect(sameOrderIdentity(a, b)).toBe(true);
    expect(sameOrderState(a, b)).toBe(true);
    expect(findOrderIdentityDifference(a, b)).toBeUndefined();
  });

  it('разные OrderId различаются по полю id', () => {
    const difference = findOrderIdentityDifference(order({ id: 'order-1' }), order({ id: 'order-2' }));
    expect(difference?.field).toBe('id');
    expect(difference?.stored).toBe('order-1');
    expect(difference?.incoming).toBe('order-2');
  });

  it('отсутствующий владелец отличается от присутствующего', () => {
    const withOwner = order({ accountId: walletAccount() });
    const withoutOwner = order({ accountId: null });
    expect(findOrderIdentityDifference(withOwner, withoutOwner)?.field).toBe('accountId');
    expect(findOrderIdentityDifference(withoutOwner, withOwner)?.field).toBe('accountId');
    expect(findOrderIdentityDifference(withoutOwner, order({ accountId: null }))).toBeUndefined();
  });

  it('отсутствующая стратегия отличается от заданной', () => {
    const difference = findOrderIdentityDifference(
      order({ strategyId: strategyId('alpha') }),
      order(),
    );
    expect(difference?.field).toBe('strategyId');
    expect(difference?.stored).toBe('alpha');
    expect(difference?.incoming).toBe('<none>');
  });

  it('идентичность равна, а состояние — нет: это и есть законное обновление', () => {
    const open = must(order({ accountId: walletAccount() }).accept());
    const partially = withFill(open, { size: 40 });

    expect(sameOrderIdentity(open, partially)).toBe(true);
    expect(sameOrderState(open, partially)).toBe(false);
  });

  it('состояние различается по каждому изменяемому полю', () => {
    const open = must(order({ accountId: walletAccount() }).accept());

    // status
    expect(sameOrderState(open, order({ accountId: walletAccount() }))).toBe(false);
    // reason
    const canceled = must(open.cancel('risk'));
    const canceledOther = must(open.cancel('strategy'));
    expect(sameOrderIdentity(canceled, canceledOther)).toBe(true);
    expect(sameOrderState(canceled, canceledOther)).toBe(false);
    // filledSize и averagePrice
    const fortyAt65 = withFill(open, { id: 'fill-a', size: 40 });
    const twentyAt65 = withFill(open, { id: 'fill-a', size: 20 });
    expect(sameOrderState(fortyAt65, twentyAt65)).toBe(false);
    // averagePrice при равном объёме, но разной цене
    const fortyAt70 = withFill(open, { id: 'fill-a', size: 40, price: 0.7 });
    expect(sameOrderState(fortyAt65, fortyAt70)).toBe(false);
    // averagePrice: undefined против заданного
    expect(sameOrderState(open, fortyAt65)).toBe(false);
    // fillIds: тот же объём, но другое исполнение
    const fortyOtherFill = withFill(open, { id: 'fill-b', size: 40 });
    expect(sameOrderIdentity(fortyAt65, fortyOtherFill)).toBe(true);
    expect(sameOrderState(fortyAt65, fortyOtherFill)).toBe(false);
    // fillIds: разное количество исполнений при равном суммарном объёме
    const twiceTwenty = withFill(withFill(open, { id: 'fill-a', size: 20 }), {
      id: 'fill-b',
      size: 20,
    });
    expect(sameOrderState(fortyAt65, twiceTwenty)).toBe(false);
  });
});

describe('§46. неизменяемый факт исполнения', () => {
  it('пересобранное исполнение равно исходному', () => {
    const a = makeFill({ accountId: walletAccount() });
    const b = makeFill({ accountId: walletAccount() });
    expect(a).not.toBe(b);
    expect(sameFillFact(a, b)).toBe(true);
    expect(findFillFactDifference(a, b)).toBeUndefined();
  });

  it('каждое поле факта участвует в сравнении', () => {
    const base = makeFill({ accountId: walletAccount() });
    const cases: ReadonlyArray<[string, ReturnType<typeof makeFill>]> = [
      ['id', makeFill({ id: 'fill-2' })],
      ['orderId', makeFill({ orderId: 'order-2' })],
      ['accountId', makeFill({ accountId: walletAccount('0x9999999999999999999999999999999999999999') })],
      ['venueId', makeFill({ venueId: OTHER_VENUE })],
      ['marketId', makeFill({ marketId: 'market-other' as never })],
      ['tokenId', makeFill({ tokenId: DOWN_TOKEN })],
      ['side', makeFill({ side: 'SELL' })],
      ['price', makeFill({ price: 0.7 })],
      ['size', makeFill({ size: 41 })],
      ['timestamp', makeFill({ timestampMs: 1_700_000_200_000 })],
      ['fee', makeFill({ fee: 0.07 })],
    ];

    for (const [field, other] of cases) {
      expect(findFillFactDifference(base, other)?.field).toBe(field);
      expect(sameFillFact(base, other)).toBe(false);
    }
  });

  it('расчётный актив тоже входит в факт', () => {
    const base = makeFill({ accountId: walletAccount() });
    const otherSettlement = makeFill({ settlementAssetId: DOWN_TOKEN });
    expect(findFillFactDifference(base, otherSettlement)?.field).toBe('settlementAssetId');
  });

  it('одинаковая величина комиссии в разных активах фактом не совпадает', () => {
    // Fee.equals сравнивает и актив, и величину — «0.07 чего-то» недостаточно.
    const usdcFee = makeFill({ accountId: walletAccount(), fee: 0.07 });
    const zeroFee = makeFill({ accountId: walletAccount(), fee: 0 });
    expect(findFillFactDifference(usdcFee, zeroFee)?.field).toBe('fee');
  });
});

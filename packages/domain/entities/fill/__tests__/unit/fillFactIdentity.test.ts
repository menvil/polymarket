/**
 * Сравнение неизменяемых фактов исполнения.
 *
 * @remarks
 * У `Fill` нет изменяемой части, поэтому в сравнение входят ВСЕ его поля.
 * Проверяется, что сравнение идёт по canonical-равенствам, а не по ссылке и
 * не по строке.
 */
import { describe, expect, it } from '@jest/globals';
import { findFillFactDifference, sameFillFact } from '../../src/factIdentity';
import {
  DOWN_TOKEN,
  OTHER_VENUE,
  OUTCOME_TOKEN_ASSET,
  fill as makeFill,
  walletAccount,
} from '../identityFixtures';

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
    // Актив комиссии — часть факта, а не оформление: `Fee.equals` делегирует в
    // `AssetQuantity.equals`, который сравнивает И актив, И величину.
    //
    // Величины здесь равны и равны НУЛЮ — и это единственная форма, которую
    // домен допускает: `Fill.create` требует `fee.asset === settlementAssetId`
    // для НЕнулевой комиссии (инвариант корректности `getNetCashFlow`).
    // Поэтому «0.07 USDC против 0.07 в другом активе» не построить вовсе, а
    // ненулевое расхождение активов приходит в состояние уже как расхождение
    // `settlementAssetId` — оно проверено выше.
    const usdcFee = makeFill({ accountId: walletAccount(), fee: 0 });
    const outcomeTokenFee = makeFill({
      accountId: walletAccount(),
      fee: 0,
      feeAsset: OUTCOME_TOKEN_ASSET,
    });

    expect(usdcFee.fee.quantity.amount().equals(outcomeTokenFee.fee.quantity.amount())).toBe(true);
    expect(usdcFee.fee.asset).not.toEqual(outcomeTokenFee.fee.asset);
    expect(findFillFactDifference(usdcFee, outcomeTokenFee)?.field).toBe('fee');
    expect(sameFillFact(usdcFee, outcomeTokenFee)).toBe(false);
  });
});

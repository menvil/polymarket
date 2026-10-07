/**
 * `PolymarketStaticTakerFeeRateResolver`: ставка taker-комиссии по рынку из
 * заранее известного набора.
 *
 * @remarks
 * Неизвестный рынок и невалидная ставка — отказ, а не нулевая ставка:
 * нулевая комиссия тейкера разошлась бы с фактом приватного WS.
 */
import { describe, expect, it } from '@jest/globals';
import { PolymarketStaticTakerFeeRateResolver } from '@polymarket/polymarket-v2/account';
import { CRYPTO_TAKER_FEE_RATE, MARKET_A, MARKET_B } from './helpers/accountFixtures.js';

describe('PolymarketStaticTakerFeeRateResolver', () => {
  it('отдаёт ставку рынка; condition id сравнивается без учёта регистра', () => {
    const created = PolymarketStaticTakerFeeRateResolver.create([
      [MARKET_A, CRYPTO_TAKER_FEE_RATE],
      [MARKET_B, 0],
    ]);
    if (!created.ok) throw created.error;

    expect(created.value.getTakerFeeRate(MARKET_A)).toEqual({ ok: true, value: CRYPTO_TAKER_FEE_RATE });
    expect(created.value.getTakerFeeRate(String(MARKET_A).toUpperCase().replace('0X', '0x') as typeof MARKET_A))
      .toEqual({ ok: true, value: CRYPTO_TAKER_FEE_RATE });
    expect(created.value.getTakerFeeRate(MARKET_B)).toEqual({ ok: true, value: 0 });
  });

  it('рынок вне набора → Err, а не нулевая ставка', () => {
    const created = PolymarketStaticTakerFeeRateResolver.create([[MARKET_A, CRYPTO_TAKER_FEE_RATE]]);
    if (!created.ok) throw created.error;

    const rate = created.value.getTakerFeeRate(MARKET_B);
    expect(rate.ok).toBe(false);
    if (!rate.ok) expect(rate.error.message).toContain('taker fee rate is unknown');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])('ставка %p → отказ создания', (rate) => {
    expect(PolymarketStaticTakerFeeRateResolver.create([[MARKET_A, rate]]).ok).toBe(false);
  });

  it('один рынок дважды (в том числе в другом регистре) → отказ создания', () => {
    const upper = String(MARKET_A).toUpperCase().replace('0X', '0x') as typeof MARKET_A;
    const created = PolymarketStaticTakerFeeRateResolver.create([
      [MARKET_A, CRYPTO_TAKER_FEE_RATE],
      [upper, CRYPTO_TAKER_FEE_RATE],
    ]);
    expect(created.ok).toBe(false);
  });
});

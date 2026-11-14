/**
 * Portfolio: один денежный collateral, без подмены валюты.
 *
 * @remarks
 * Polymarket CLOB V2 рассчитывается в pUSD. Портфель такого аккаунта держит
 * баланс в pUSD, и каждая денежная операция — резервирование, освобождение,
 * списание, зачисление, применение исполнения — обязана быть в той же валюте.
 * Чужая валюта — отказ ДО изменения состояния, а не «та же цифра» в своей.
 *
 * Отдельно — регрессии прежних дыр:
 * - `applyDirectDebit` строил результат как `Money.of(…, 'USDC')`;
 * - `applyFill` переводил суммы `Fill` в валюту портфеля, не сверив
 *   `settlementAssetId`, — USDC-исполнение молча прошло бы как pUSD.
 */
import { describe, it, expect } from '@jest/globals';
import { Portfolio } from '../../src/Portfolio.js';
import { asPortfolioId } from '../../src/value-objects/index.js';
import { Balance } from '@polymarket/value-objects/balance';
import type { Money } from '@polymarket/value-objects/money';
import {
  Fee,
  AssetQuantity,
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type OutcomePrice,
  type Quantity,
} from '@polymarket/value-objects';
import {
  AssetIdHelpers,
  accountIdFromWallet,
  asPositionId,
  parseWalletAddress,
  type AccountId,
  type AssetId,
  type FillId,
  type InstrumentId,
  type MarketId,
  type OrderId,
  type PositionId,
  type VenueId,
} from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import { Fill, FillMapper, POLYMARKET_COLLATERAL_ASSET_ID } from '@polymarket/fill';

// ==================== Хелперы ====================

type Currency = 'USDC' | 'pUSD';

const ACCOUNT: AccountId = (() => {
  const wallet = parseWalletAddress('0x1234567890abcdef1234567890abcdef12345678');
  if (wallet === undefined) throw new Error('fixture failed: wallet');
  return accountIdFromWallet(wallet);
})();
const VENUE = 'POLYMARKET' as VenueId;
const TOKEN_ID = '55695501845784092214174724531633766378641431459789650894538985540007126410391';
const FILL_TOKEN = { type: 'POLYMARKET_CTF_TOKEN', tokenId: TOKEN_ID } as unknown as AssetId;
const FILL_INSTRUMENT = TOKEN_ID as InstrumentId;

function positionId(raw: string): PositionId {
  const id = asPositionId(raw);
  if (id === undefined) throw new Error(`fixture failed: positionId ${raw}`);
  return id;
}
const POSITION_ID = positionId('position-1');

const FILL_TIME = (() => {
  const created = TimestampService.create(1_700_000_000_000);
  if (!created.ok) throw new Error('fixture failed: timestamp');
  return created.value;
})();

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value;
}

function money(amount: number, currency: Currency): Money {
  return must(MoneyService.create(amount, currency));
}

function qty(n: number): Quantity {
  return must(QuantityService.create(n));
}

function price(n: number): OutcomePrice {
  return must(OutcomePriceService.create(n));
}

function currencyAsset(currency: Currency): AssetId {
  return currency === 'pUSD' ? AssetIdHelpers.PUSD : AssetIdHelpers.USDC;
}

/** Портфель с балансом available/reserved в заданной валюте. */
function portfolio(currency: Currency, available = 100, reserved = 0): Portfolio {
  const created = Portfolio.create({
    id: asPortfolioId('portfolio-currency'),
    accountId: ACCOUNT,
    balance: Balance.of(money(available, currency), money(reserved, currency), ACCOUNT, VENUE),
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.error.message}`);
  return created.value;
}

/** Исполнение с расчётом (и комиссией) в заданной валюте. */
function fill(params: { currency: Currency; side: 'BUY' | 'SELL'; size: number; price: number; fee?: number; id?: string }): Fill {
  const asset = currencyAsset(params.currency);
  const created = Fill.create({
    id: (params.id ?? 'fill-1') as unknown as FillId,
    orderId: 'order-1' as unknown as OrderId,
    accountId: ACCOUNT,
    venueId: VENUE,
    marketId: 'market-1' as unknown as MarketId,
    tokenId: FILL_TOKEN,
    settlementAssetId: asset,
    price: price(params.price),
    size: qty(params.size),
    side: params.side,
    timestamp: FILL_TIME,
    fee: params.fee === undefined ? Fee.zero(asset) : Fee.of(new AssetQuantity(asset, qty(params.fee))),
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.error.message}`);
  return created.value;
}

/** Всё наблюдаемое состояние портфеля — для проверки «отказ ничего не изменил». */
function state(p: Portfolio) {
  return {
    available: p.balance.available().value().toString(),
    reserved: p.balance.reserved().value().toString(),
    currency: p.balance.currency(),
    positions: p.getPositionCount(),
    availableTokens: p.availableTokens(FILL_INSTRUMENT).value().toString(),
    reservedTokens: p.reservedTokens(FILL_INSTRUMENT).value().toString(),
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`unexpected Err: ${result.error.message}`);
  return result.value;
}

// ==================== Тесты ====================

describe('Portfolio pUSD: баланс и резервации в своей валюте', () => {
  it('available и reserved — pUSD', () => {
    const p = portfolio('pUSD', 100, 5);
    expect(p.balance.currency()).toBe('pUSD');
    expect(p.balance.available().currency()).toBe('pUSD');
    expect(p.balance.reserved().currency()).toBe('pUSD');
  });

  it('reserve 20 pUSD → OK; release 20 pUSD → обратно', () => {
    const reserved = unwrap(portfolio('pUSD').reserveForOrder(money(20, 'pUSD')));
    expect(state(reserved)).toMatchObject({ available: '80', reserved: '20', currency: 'pUSD' });
    const released = unwrap(reserved.releaseReservation(money(20, 'pUSD')));
    expect(state(released)).toMatchObject({ available: '100', reserved: '0', currency: 'pUSD' });
  });

  it('applyDebit / applyCredit в pUSD', () => {
    const debited = unwrap(portfolio('pUSD', 80, 20).applyDebit(money(20, 'pUSD')));
    expect(state(debited)).toMatchObject({ available: '80', reserved: '0', currency: 'pUSD' });
    const credited = unwrap(debited.applyCredit(money(10, 'pUSD')));
    expect(state(credited)).toMatchObject({ available: '90', currency: 'pUSD' });
  });

  it('applyDirectDebit в pUSD работает и оставляет баланс в pUSD (прежде результат строился в USDC)', () => {
    const debited = unwrap(portfolio('pUSD').applyDirectDebit(money(30, 'pUSD')));
    expect(state(debited)).toMatchObject({ available: '70', reserved: '0', currency: 'pUSD' });
    const clamped = unwrap(portfolio('pUSD').applyDirectDebit(money(500, 'pUSD')));
    expect(state(clamped)).toMatchObject({ available: '0', currency: 'pUSD' });
  });

  it.each<[string, (p: Portfolio) => { ok: boolean }]>([
    ['reserveForOrder 20 USDC', (p) => p.reserveForOrder(money(20, 'USDC'))],
    ['releaseReservation 5 USDC', (p) => p.releaseReservation(money(5, 'USDC'))],
    ['applyDebit 5 USDC', (p) => p.applyDebit(money(5, 'USDC'))],
    ['applyCredit 10 USDC', (p) => p.applyCredit(money(10, 'USDC'))],
    ['applyDirectDebit 10 USDC', (p) => p.applyDirectDebit(money(10, 'USDC'))],
  ])('портфель pUSD: %s → Err, состояние не изменено', (_label, run) => {
    const p = portfolio('pUSD', 100, 5);
    const before = state(p);
    expect(run(p).ok).toBe(false);
    expect(state(p)).toEqual(before);
  });

  it('и наоборот: USDC-портфель отвергает резервацию pUSD', () => {
    const p = portfolio('USDC');
    expect(p.reserveForOrder(money(20, 'pUSD')).ok).toBe(false);
    expect(state(p)).toMatchObject({ available: '100', reserved: '0', currency: 'USDC' });
  });
});

describe('Portfolio.applyFill: валюта расчёта = валюта портфеля', () => {
  /** pUSD-портфель с резервацией 50 pUSD под покупку. */
  function reservedForBuy(): Portfolio {
    return unwrap(portfolio('pUSD').reserveForOrder(money(50, 'pUSD')));
  }

  it('BUY pUSD-исполнения с комиссией: номинал из reserved, комиссия из available — в pUSD', () => {
    const applied = unwrap(
      reservedForBuy().applyFill(fill({ currency: 'pUSD', side: 'BUY', size: 100, price: 0.5, fee: 1.75 }), {
        positionId: POSITION_ID,
        reservedNotional: money(50, 'pUSD'),
      }),
    );
    expect(state(applied)).toMatchObject({ available: '48.25', reserved: '0', currency: 'pUSD', positions: 1 });
  });

  it('SELL pUSD-исполнения: нетто-поток зачисляется в pUSD', () => {
    const bought = unwrap(
      reservedForBuy().applyFill(fill({ id: 'f1', currency: 'pUSD', side: 'BUY', size: 100, price: 0.5 }), {
        positionId: POSITION_ID,
        reservedNotional: money(50, 'pUSD'),
      }),
    );
    const ready = unwrap(bought.reserveTokens(FILL_INSTRUMENT, qty(100)));
    const sold = unwrap(
      ready.applyFill(fill({ id: 'f2', currency: 'pUSD', side: 'SELL', size: 100, price: 0.6, fee: 1.68 }), {
        positionId: POSITION_ID,
      }),
    );
    // 50 + (60 − 1.68) = 108.32
    expect(state(sold)).toMatchObject({ available: '108.32', currency: 'pUSD', positions: 0 });
  });

  it.each<[string, () => Fill]>([
    ['BUY с комиссией', () => fill({ currency: 'USDC', side: 'BUY', size: 100, price: 0.5, fee: 1.75 })],
    ['BUY без комиссии', () => fill({ currency: 'USDC', side: 'BUY', size: 100, price: 0.5 })],
  ])('портфель pUSD + USDC-исполнение (%s) → Err до изменения состояния', (_label, make) => {
    const p = reservedForBuy();
    const before = state(p);
    const applied = p.applyFill(make(), { positionId: POSITION_ID, reservedNotional: money(50, 'pUSD') });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.message).toContain('fill settles in CURRENCY:USDC');
      expect(applied.error.message).toContain('portfolio balance is in pUSD');
    }
    expect(state(p)).toEqual(before);
  });

  it('портфель pUSD + USDC SELL → Err: позиция и токенная резервация не тронуты', () => {
    const bought = unwrap(
      reservedForBuy().applyFill(fill({ id: 'f1', currency: 'pUSD', side: 'BUY', size: 100, price: 0.5 }), {
        positionId: POSITION_ID,
        reservedNotional: money(50, 'pUSD'),
      }),
    );
    const ready = unwrap(bought.reserveTokens(FILL_INSTRUMENT, qty(100)));
    const before = state(ready);
    expect(ready.applyFill(fill({ id: 'f2', currency: 'USDC', side: 'SELL', size: 100, price: 0.6 }), { positionId: POSITION_ID }).ok).toBe(false);
    expect(state(ready)).toEqual(before);
  });

  it('портфель USDC + pUSD-исполнение → Err (в обе стороны)', () => {
    const p = unwrap(portfolio('USDC').reserveForOrder(money(50, 'USDC')));
    const before = state(p);
    const applied = p.applyFill(fill({ currency: 'pUSD', side: 'BUY', size: 100, price: 0.5 }), {
      positionId: POSITION_ID,
      reservedNotional: money(50, 'USDC'),
    });
    expect(applied.ok).toBe(false);
    expect(state(p)).toEqual(before);
  });

  it('pUSD-исполнение, но reservedNotional в USDC → Err, состояние не изменено', () => {
    const p = reservedForBuy();
    const before = state(p);
    const applied = p.applyFill(fill({ currency: 'pUSD', side: 'BUY', size: 100, price: 0.5 }), {
      positionId: POSITION_ID,
      reservedNotional: money(50, 'USDC'),
    });
    expect(applied.ok).toBe(false);
    expect(state(p)).toEqual(before);
  });

  it('прежний сценарий USDC-портфеля и USDC-исполнения работает как раньше', () => {
    const p = unwrap(portfolio('USDC').reserveForOrder(money(50, 'USDC')));
    const applied = unwrap(
      p.applyFill(fill({ currency: 'USDC', side: 'BUY', size: 100, price: 0.5, fee: 1 }), {
        positionId: POSITION_ID,
        reservedNotional: money(50, 'USDC'),
      }),
    );
    expect(state(applied)).toMatchObject({ available: '49', reserved: '0', currency: 'USDC', positions: 1 });
  });
});

describe('Polymarket CLOB V2: исполнение из FillMapper применяется к pUSD-портфелю', () => {
  /** TAKER BUY 100 @ 0.5 нашего аккаунта, разобранный production-маппером. */
  function polymarketTakerBuy(): Fill {
    const mapped = FillMapper.allFromPolymarketTradeEvent(
      {
        id: 'trade-1',
        taker_order_id: 'order-1',
        trader_side: 'TAKER',
        market: '0x' + 'b'.repeat(64),
        asset_id: TOKEN_ID,
        side: 'BUY',
        price: '0.5',
        size: '100',
        status: 'MATCHED',
        match_time: '1700000000',
        maker_orders: [],
      },
      ACCOUNT,
      { takerFeeRate: 0.07 },
    );
    if (!mapped.ok) throw new Error(`fixture failed: ${mapped.error.message}`);
    return mapped.value[0]!.fill;
  }

  it('settlement и комиссия — pUSD; применяется к pUSD-портфелю', () => {
    const polymarketFill = polymarketTakerBuy();
    expect(AssetIdHelpers.equals(polymarketFill.settlementAssetId, POLYMARKET_COLLATERAL_ASSET_ID)).toBe(true);
    const applied = unwrap(
      reservedForBuyPusd().applyFill(polymarketFill, { positionId: POSITION_ID, reservedNotional: money(50, 'pUSD') }),
    );
    // комиссия 100 × 0.07 × 0.5 × 0.5 = 1.75 pUSD
    expect(state(applied)).toMatchObject({ available: '48.25', reserved: '0', currency: 'pUSD', positions: 1 });
  });

  it('USDC-портфель больше не поглощает Polymarket-исполнение молча', () => {
    const p = unwrap(portfolio('USDC').reserveForOrder(money(50, 'USDC')));
    const before = state(p);
    expect(p.applyFill(polymarketTakerBuy(), { positionId: POSITION_ID, reservedNotional: money(50, 'USDC') }).ok).toBe(false);
    expect(state(p)).toEqual(before);
  });

  function reservedForBuyPusd(): Portfolio {
    return unwrap(portfolio('pUSD').reserveForOrder(money(50, 'pUSD')));
  }
});

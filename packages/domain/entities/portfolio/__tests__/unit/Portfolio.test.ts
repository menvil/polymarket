/**
 * Тесты для Portfolio aggregate
 *
 * @remarks
 * Проверяет:
 * - create() с валидными/невалидными данными
 * - reserveForOrder / releaseReservation / applyDebit / applyCredit
 * - reserveTokensForOrder / releaseTokenReservation / availableTokenQuantity
 * - upsertPosition (добавление, обновление, удаление закрытых позиций)
 * - Immutability: операции с деньгами сохраняют tokenBalances
 * - getPosition / hasPosition / getPositions / getPositionCount / isEmpty
 * - toString()
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import type { Position } from '@polymarket/position';
import { Portfolio } from '../../src/Portfolio.js';
import { position } from '../positionFixture.js';
import { asPortfolioId } from '../../src/value-objects/index.js';
import { PortfolioValidationError } from '@polymarket/errors/portfolio';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';
import { TokenBalance } from '@polymarket/value-objects/token-balance';
import { Quantity, Fee, AssetQuantity, OutcomePrice } from '@polymarket/value-objects';
import { AssetIdHelpers, asPositionId, type AssetId, type FillId, type OrderId, type MarketId, type PositionId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import { Fill } from '@polymarket/fill';
import type { InstrumentId, AccountId, VenueId, WalletAddress } from '@polymarket/ids';

// ==================== Хелперы ====================

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress,
};

const venueId = 'POLYMARKET' as VenueId;

// Чужие идентичности — для проверок владения. Портфель обязан отвергать
// позицию, токенный баланс или исполнение, принадлежащие не ему.
const otherAccountId: AccountId = {
  ...accountId,
  address: '0x9999999999999999999999999999999999999999' as WalletAddress,
};
const OTHER_VENUE = 'KALSHI' as VenueId;

/** Создаёт Money(amount, 'USDC') */
function mkMoney(amount: number): Money {
  return Money.of(new Decimal(amount), 'USDC');
}

function makeBalance(available = 10000, reserved = 0): Balance {
  return Balance.of(
    mkMoney(available),
    mkMoney(reserved),
    accountId,
    venueId
  );
}

function makePortfolio(overrides: Partial<Parameters<typeof Portfolio.create>[0]> = {}) {
  return Portfolio.create({
    id: asPortfolioId('portfolio-abc'),
    accountId,
    balance: makeBalance(),
    ...overrides,
  });
}

function makeInstrumentId(raw: string): InstrumentId {
  return raw as InstrumentId;
}

// Позиции строятся НАСТОЯЩИМ `Position`: структурных заглушек больше нет —
// вместе с `IPosition` исчезла и возможность подставить объект, которого в
// проде не существует.
function makeOpenPosition(instrumentId: InstrumentId): Position {
  // accountId ЯВНО: агрегат отвергает чужую позицию, а фикстура позиции имеет
  // собственный дефолтный аккаунт — совпадать они не обязаны.
  return position(instrumentId, { quantity: 100, entryPrice: 0.65, accountId });
}

function qty(n: number): Quantity {
  return Quantity.of(new Decimal(n));
}

/**
 * Токенный баланс, согласованный с позицией.
 *
 * @remarks
 * `available + reserved` обязано равняться количеству позиции — иначе
 * `Portfolio.create()` отвергнет набор. Раньше портфель с позицией и без
 * токенного баланса собирался молча, а «доступное» ВЫЧИСЛЯЛОСЬ как
 * `quantity − reserved`; теперь это две хранимые части одного инварианта.
 */
function makeTokenBalance(instrumentId: InstrumentId, available: number, reserved = 0): TokenBalance {
  return TokenBalance.of(instrumentId, qty(available), qty(reserved), accountId, venueId);
}

/**
 * Токенные балансы, согласованные с переданными позициями.
 *
 * @remarks
 * Инвариант агрегата требует, чтобы у каждой позиции был токенный двойник на
 * то же количество. Раньше портфель с позицией и без токенов собирался молча —
 * теперь `create()` такой набор отвергает, и фикстуры обязаны быть честными.
 */
function tokensFor(positions: ReadonlyMap<InstrumentId, Position>): Map<InstrumentId, TokenBalance> {
  const out = new Map<InstrumentId, TokenBalance>();
  for (const [instrumentId, pos] of positions) {
    out.set(instrumentId, TokenBalance.of(instrumentId, pos.quantity, qty(0), accountId, venueId));
  }
  return out;
}

/** Портфель с позицией на 100 и согласованным токенным балансом. */
function makePortfolioWithTokens(instrumentId: InstrumentId, reserved = 0) {
  return makePortfolio({
    positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
    tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 100 - reserved, reserved)]]),
  });
}

/** Идентификатор позиции для фикстур: отказ здесь — дефект самого теста. */
function positionId(raw: string): PositionId {
  const id = asPositionId(raw);
  if (id === undefined) throw new Error(`fixture failed: invalid positionId ${raw}`);
  return id;
}

/** Момент времени для фикстур. */
function ts(ms: number) {
  const r = TimestampService.create(ms);
  if (!r.ok) throw new Error('fixture timestamp');
  return r.value;
}

// Настоящий outcome-токен, а не USDC: `assetIdToInstrumentId` от USDC даёт
// `CURRENCY:USDC`, и получился бы портфель, покупающий доллары за доллары.
const FILL_TOKEN = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: '55695501845784092214174724531633766378641431459789650894538985540007126410391',
} as unknown as AssetId;

/** Инструмент, в который резолвится `FILL_TOKEN`. */
const FILL_INSTRUMENT =
  '55695501845784092214174724531633766378641431459789650894538985540007126410391' as InstrumentId;

/**
 * Исполнение с явной комиссией.
 *
 * @remarks
 * Комиссия задаётся в USDC — это её единственный законный актив
 * (`Fill.create` требует совпадения с settlement-активом), и ровно так
 * площадка её и удерживает: деньгами, а не шарами.
 */
function makeFill(params: {
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  feeUSDC?: number;
  id?: string;
  accountId?: AccountId;
  venueId?: VenueId;
}): Fill {
  const fee = params.feeUSDC
    ? Fee.of(new AssetQuantity(AssetIdHelpers.USDC, qty(params.feeUSDC)))
    : Fee.zero(AssetIdHelpers.USDC);
  const result = Fill.create({
    id: (params.id ?? 'fill-1') as unknown as FillId,
    orderId: 'order-1' as unknown as OrderId,
    accountId: params.accountId ?? accountId,
    venueId: params.venueId ?? venueId,
    marketId: 'market-1' as unknown as MarketId,
    tokenId: FILL_TOKEN,
    settlementAssetId: AssetIdHelpers.USDC,
    price: OutcomePrice.of(new Decimal(params.price)),
    size: qty(params.size),
    side: params.side,
    timestamp: ts(1_700_000_000_000),
    fee,
  });
  if (!result.ok) throw new Error(`fixture failed: ${result.error.message}`);
  return result.value;
}

// ==================== Тесты ====================

describe('Portfolio.create()', () => {
  it('создаёт Portfolio с валидными данными', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('portfolio-abc');
      expect(result.value.getPositionCount()).toBe(0);
      expect(result.value.balance.available().value().toNumber()).toBe(10000);
    }
  });

  it('создаёт Portfolio с начальными позициями', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions, tokenBalances: tokensFor(positions) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getPositionCount()).toBe(1);
    }
  });

  it('возвращает Err при пустом id', () => {
    const result = Portfolio.create({
      // @ts-expect-error - намеренно передаём невалидный id
      id: '',
      accountId,
      balance: makeBalance(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.context?.field).toBe('id');
    }
  });

  it('возвращает Err при отсутствующем accountId', () => {
    const result = Portfolio.create({
      id: asPortfolioId('portfolio-abc'),
      // @ts-expect-error - намеренно передаём null
      accountId: null,
      balance: makeBalance(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.context?.field).toBe('accountId');
    }
  });

  it('возвращает Err при отсутствующем balance', () => {
    const result = Portfolio.create({
      id: asPortfolioId('portfolio-abc'),
      accountId,
      // @ts-expect-error - намеренно передаём null
      balance: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.context?.field).toBe('balance');
    }
  });
});

describe('Portfolio.reserveForOrder()', () => {
  it('резервирует средства: available уменьшается, reserved увеличивается', () => {
    const result = makePortfolio({ balance: makeBalance(10000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveForOrder(mkMoney(3000));
    expect(reserveResult.ok).toBe(true);
    if (reserveResult.ok) {
      expect(reserveResult.value.balance.available().value().toNumber()).toBe(7000);
      expect(reserveResult.value.balance.reserved().value().toNumber()).toBe(3000);
    }
  });

  it('не мутирует исходный Portfolio', () => {
    const result = makePortfolio({ balance: makeBalance(10000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    original.reserveForOrder(mkMoney(3000));
    expect(original.balance.available().value().toNumber()).toBe(10000);
    expect(original.balance.reserved().value().toNumber()).toBe(0);
  });

  it('возвращает Err при недостаточных средствах', () => {
    const result = makePortfolio({ balance: makeBalance(1000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveForOrder(mkMoney(5000));
    expect(reserveResult.ok).toBe(false);
  });
});

describe('Portfolio.releaseReservation()', () => {
  it('возвращает зарезервированные средства: reserved уменьшается, available увеличивается', () => {
    const result = makePortfolio({ balance: makeBalance(7000, 3000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const releaseResult = result.value.releaseReservation(mkMoney(2000));
    expect(releaseResult.ok).toBe(true);
    if (releaseResult.ok) {
      expect(releaseResult.value.balance.available().value().toNumber()).toBe(9000);
      expect(releaseResult.value.balance.reserved().value().toNumber()).toBe(1000);
    }
  });

  it('возвращает Err если недостаточно reserved', () => {
    const result = makePortfolio({ balance: makeBalance(7000, 1000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const releaseResult = result.value.releaseReservation(mkMoney(5000));
    expect(releaseResult.ok).toBe(false);
  });
});

describe('Portfolio.applyDebit()', () => {
  it('списывает из reserved, available не меняется', () => {
    const result = makePortfolio({ balance: makeBalance(7000, 3000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const debitResult = result.value.applyDebit(mkMoney(2000));
    expect(debitResult.ok).toBe(true);
    if (debitResult.ok) {
      expect(debitResult.value.balance.available().value().toNumber()).toBe(7000);
      expect(debitResult.value.balance.reserved().value().toNumber()).toBe(1000);
    }
  });

  it('возвращает Err если reserved < amount', () => {
    const result = makePortfolio({ balance: makeBalance(7000, 1000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const debitResult = result.value.applyDebit(mkMoney(5000));
    expect(debitResult.ok).toBe(false);
  });
});

describe('Portfolio.applyCredit()', () => {
  it('зачисляет в available, reserved не меняется', () => {
    const result = makePortfolio({ balance: makeBalance(7000, 1000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const creditResult = result.value.applyCredit(mkMoney(500));
    expect(creditResult.ok).toBe(true);
    if (creditResult.ok) {
      expect(creditResult.value.balance.available().value().toNumber()).toBe(7500);
      expect(creditResult.value.balance.reserved().value().toNumber()).toBe(1000);
    }
  });

  it('возвращает Err при currency mismatch (duck-typed Money)', () => {
    const result = makePortfolio({ balance: makeBalance(7000, 0) }); // USDC
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Money.of() бросает при неизвестной валюте — используем duck typing
    // для имитации Money с currency='USD' (≠ USDC), BalanceService.credit
    // вернёт Err на проверке ValidateCurrencyMatch до вызова других методов
    const wrongCurrency = {
      value: () => new Decimal(500),
      currency: () => 'USD',
    } as unknown as Money;

    const creditResult = result.value.applyCredit(wrongCurrency);
    expect(creditResult.ok).toBe(false);
    if (!creditResult.ok) {
      expect(creditResult.error).toBeInstanceOf(InvalidBalanceError);
    }
  });
});

describe('Portfolio.applyFill() — normal path: исполнение потребляет резервацию', () => {
  // `upsertPosition()` не публичен, отдельной замены `TokenBalance` нет — те же
  // поведения проверяются через единственный оставшийся путь.
  //
  // Обе стороны СИММЕТРИЧНЫ: каждая потребляет свою резервацию. Резервируются
  // разные вещи (деньги под BUY, токены под SELL), но ни одна сторона не лезет
  // в свободный остаток.

  const POSITION_ID = positionId('position-1');
  const NOTIONAL_50 = mkMoney(50);

  /** Портфель, где под покупку на 50 USDC уже создана резервация. */
  function reservedForBuy(notional = 50) {
    const created = makePortfolio();
    if (!created.ok) throw new Error('fixture failed');
    const reserved = created.value.reserveForOrder(mkMoney(notional));
    if (!reserved.ok) throw new Error('fixture failed: reserveForOrder');
    return reserved.value;
  }

  it('BUY уменьшает reserved, а НЕ available', () => {
    const portfolio = reservedForBuy();
    const availableBefore = portfolio.balance.available().value().toNumber();
    const reservedBefore = portfolio.balance.reserved().value().toNumber();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Номинал ушёл из reserved; available не тронут — комиссии не было.
    expect(applied.value.balance.reserved().value().toNumber()).toBe(reservedBefore - 50);
    expect(applied.value.balance.available().value().toNumber()).toBe(availableBefore);
  });

  it('полное исполнение не оставляет резервацию зависшей', () => {
    const portfolio = reservedForBuy();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.balance.reserved().value().toNumber()).toBe(0);
  });

  it('частичное исполнение потребляет часть резервации', () => {
    const portfolio = reservedForBuy();

    // Половина заявки: 50 шар из 100, потребляем 25 из 50 зарезервированных.
    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 50, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(25) },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Остаток резервации ждёт неисполненный объём заявки.
    expect(applied.value.balance.reserved().value().toNumber()).toBe(25);
    expect(applied.value.getPosition(FILL_INSTRUMENT)?.quantity.value().toNumber()).toBe(50);
  });

  it('комиссия тейкера снимается ОТДЕЛЬНО, из available', () => {
    const portfolio = reservedForBuy();
    const availableBefore = portfolio.balance.available().value().toNumber();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, feeUSDC: 1.0 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Резервацию никто не создавал под комиссию: при размещении заявки ещё
    // неизвестно, окажемся мы тейкером или мейкером.
    expect(applied.value.balance.reserved().value().toNumber()).toBe(0);
    expect(applied.value.balance.available().value().toNumber()).toBeCloseTo(availableBefore - 1.0, 8);
  });

  it('BUY без reservedNotional отвергается', () => {
    const portfolio = reservedForBuy();

    // Восстанавливать сумму по округлённой `fill.price` нельзя — резервация
    // создавалась по цене ЗАЯВКИ.
    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID },
    );

    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.message).toContain('reservedNotional is required');
  });

  it('нехватка reserved → Err, портфель не изменён', () => {
    const portfolio = reservedForBuy(30);
    const snapshot = portfolio.toString();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );

    expect(applied.ok).toBe(false);
    expect(portfolio.balance.reserved().value().toNumber()).toBe(30);
    expect(portfolio.getPositionCount()).toBe(0);
    expect(portfolio.toString()).toBe(snapshot);
  });

  it('нехватка available под комиссию → Err без частичной мутации', () => {
    // Весь баланс в резервации: номинал спишется, а комиссию платить нечем.
    const created = makePortfolio({ balance: makeBalance(0, 50) });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const portfolio = created.value;

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, feeUSDC: 1.0 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );

    expect(applied.ok).toBe(false);
    // Резервация НЕ потреблена: потребление номинала и комиссии — одна
    // транзакция, а не два шага, из которых первый уже случился.
    expect(portfolio.balance.reserved().value().toNumber()).toBe(50);
    expect(portfolio.balance.available().value().toNumber()).toBe(0);
    expect(portfolio.getPositionCount()).toBe(0);
  });

  it('второй BUY наращивает ту же позицию, а не заводит вторую', () => {
    const portfolio = reservedForBuy(85);

    const first = portfolio.applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = first.value.applyFill(
      makeFill({ id: 'f2', side: 'BUY', size: 50, price: 0.7 }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(35) },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.getPositionCount()).toBe(1);
    expect(second.value.getPosition(FILL_INSTRUMENT)?.quantity.value().toNumber()).toBe(150);
    expect(second.value.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(150);
  });

  it('SELL потребляет ТОКЕННУЮ резервацию и зачисляет деньги', () => {
    const bought = reservedForBuy().applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const reserved = bought.value.reserveTokens(FILL_INSTRUMENT, qty(100));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const availableBefore = reserved.value.balance.available().value().toNumber();

    const sold = reserved.value.applyFill(
      makeFill({ id: 'f2', side: 'SELL', size: 100, price: 0.6 }),
      { positionId: POSITION_ID },
    );
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;

    expect(sold.value.hasPosition(FILL_INSTRUMENT)).toBe(false);
    expect(sold.value.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
    expect(sold.value.reservedTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
    expect(sold.value.balance.available().value().toNumber()).toBeCloseTo(availableBefore + 60, 8);
  });

  it('SELL без токенной резервации отвергается', () => {
    const bought = reservedForBuy().applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    // Токены есть, но лежат в available: продать незарезервированное нельзя.
    const sold = bought.value.applyFill(
      makeFill({ id: 'f2', side: 'SELL', size: 100, price: 0.6 }),
      { positionId: POSITION_ID },
    );

    expect(sold.ok).toBe(false);
    expect(bought.value.getPosition(FILL_INSTRUMENT)?.quantity.value().toNumber()).toBe(100);
  });

  it('не мутирует исходный Portfolio', () => {
    const portfolio = reservedForBuy();
    const reservedBefore = portfolio.balance.reserved().value().toNumber();

    portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: NOTIONAL_50 },
    );

    expect(portfolio.getPositionCount()).toBe(0);
    expect(portfolio.balance.reserved().value().toNumber()).toBe(reservedBefore);
    expect(portfolio.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
  });
});

describe('Portfolio.applyFill() — владелец проверяется до вычислений', () => {
  const POSITION_ID = positionId('position-owner');

  function reserved() {
    const created = makePortfolio();
    if (!created.ok) throw new Error('fixture failed');
    const r = created.value.reserveForOrder(mkMoney(50));
    if (!r.ok) throw new Error('fixture failed');
    return r.value;
  }

  it('чужой accountId у Fill → Err без мутации', () => {
    const portfolio = reserved();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, accountId: otherAccountId }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(50) },
    );

    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.message).toContain('different account');
    expect(portfolio.balance.reserved().value().toNumber()).toBe(50);
  });

  it('чужая площадка у Fill → Err без мутации', () => {
    const portfolio = reserved();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, venueId: OTHER_VENUE }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(50) },
    );

    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.message).toContain('venue');
    expect(portfolio.balance.reserved().value().toNumber()).toBe(50);
  });
});

describe('Portfolio.getPosition() / hasPosition()', () => {
  it('getPosition возвращает позицию если есть', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const position = makeOpenPosition(instrumentId);
    const positions = new Map([[instrumentId, position]]);
    const result = makePortfolio({ positions, tokenBalances: tokensFor(positions) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.getPosition(instrumentId)).toBe(position);
  });

  it('getPosition возвращает undefined если нет позиции', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unknownId = makeInstrumentId('unknown-instrument');
    expect(result.value.getPosition(unknownId)).toBeUndefined();
  });

  it('hasPosition возвращает true для существующей позиции', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions, tokenBalances: tokensFor(positions) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasPosition(instrumentId)).toBe(true);
  });

  it('hasPosition возвращает false для отсутствующей позиции', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasPosition(makeInstrumentId('unknown'))).toBe(false);
  });
});

describe('Portfolio.getPositions()', () => {
  it('возвращает все позиции с корректными instrumentId', () => {
    const id1 = makeInstrumentId('instrument-1');
    const id2 = makeInstrumentId('instrument-2');
    const pos1 = makeOpenPosition(id1);
    const pos2 = makeOpenPosition(id2);
    const positions = new Map([
      [id1, pos1],
      [id2, pos2],
    ]);
    const result = makePortfolio({ positions, tokenBalances: tokensFor(positions) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const all = Array.from(result.value.getPositions());
    expect(all.length).toBe(2);
    const ids = all.map((p) => p.instrumentId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('возвращает пустой итератор при отсутствии позиций', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.from(result.value.getPositions())).toEqual([]);
  });

  it('изолирован от мутации исходного Map (immutability)', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const sourceMap = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions: sourceMap, tokenBalances: tokensFor(sourceMap) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const portfolio = result.value;
    expect(portfolio.getPositionCount()).toBe(1);

    // Мутируем исходный Map после создания портфеля
    const extraId = makeInstrumentId('instrument-extra');
    sourceMap.set(extraId, makeOpenPosition(extraId));
    sourceMap.delete(instrumentId);

    // Портфель не должен измениться
    expect(portfolio.getPositionCount()).toBe(1);
    expect(portfolio.hasPosition(instrumentId)).toBe(true);
    expect(portfolio.hasPosition(extraId)).toBe(false);
  });
});

describe('Portfolio.isEmpty()', () => {
  it('isEmpty = true при нулевом балансе и без позиций', () => {
    const result = makePortfolio({ balance: makeBalance(0, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty()).toBe(true);
  });

  it('isEmpty = false при ненулевом балансе', () => {
    const result = makePortfolio({ balance: makeBalance(1000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty()).toBe(false);
  });

  it('isEmpty = false при наличии позиций', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({
      balance: makeBalance(0, 0),
      positions,
      tokenBalances: tokensFor(positions),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty()).toBe(false);
  });
});

describe('Portfolio.toString()', () => {
  it('содержит id, баланс, валюту и количество позиций', () => {
    const result = makePortfolio({ balance: makeBalance(10000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const str = result.value.toString();
    expect(str).toContain('portfolio-abc');
    expect(str).toContain('10000');
    expect(str).toContain('USDC');
    // Количество позиций — строго "positions=0", не просто символ '0'
    expect(str).toContain('positions=0');
  });

  it('отражает актуальное количество позиций', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions, tokenBalances: tokensFor(positions) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const str = result.value.toString();
    expect(str).toContain('positions=1');
  });
});

describe('Portfolio полный lifecycle операций с балансом', () => {
  it('reserve → releaseReservation возвращает исходный баланс', () => {
    const result = makePortfolio({ balance: makeBalance(10000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveForOrder(mkMoney(3000));
    expect(reserveResult.ok).toBe(true);
    if (!reserveResult.ok) return;

    const releaseResult = reserveResult.value.releaseReservation(mkMoney(3000));
    expect(releaseResult.ok).toBe(true);
    if (releaseResult.ok) {
      expect(releaseResult.value.balance.available().value().toNumber()).toBe(10000);
      expect(releaseResult.value.balance.reserved().value().toNumber()).toBe(0);
    }
  });

  it('reserve → applyDebit уменьшает total', () => {
    const result = makePortfolio({ balance: makeBalance(10000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveForOrder(mkMoney(3000));
    expect(reserveResult.ok).toBe(true);
    if (!reserveResult.ok) return;

    const debitResult = reserveResult.value.applyDebit(mkMoney(3000));
    expect(debitResult.ok).toBe(true);
    if (debitResult.ok) {
      expect(debitResult.value.balance.total().value().toNumber()).toBe(7000);
    }
  });
});

// ==================== Токенные резервации (SELL ордера) ====================

describe('Portfolio.availableTokens() / reservedTokens()', () => {
  // Раньше «доступное» ВЫЧИСЛЯЛОСЬ как `position.quantity − reserved` и при
  // отрицательном результате молча зажималось в ноль — то есть нарушенный
  // инвариант не просто не ловился, а маскировался. Теперь обе части хранятся,
  // а их согласие с позицией проверяет сам агрегат.

  it('нули, если инструмент неизвестен', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unknown = makeInstrumentId('unknown');
    expect(result.value.availableTokens(unknown).value().toNumber()).toBe(0);
    expect(result.value.reservedTokens(unknown).value().toNumber()).toBe(0);
  });

  it('весь объём доступен, пока ничего не зарезервировано', () => {
    const instrumentId = makeInstrumentId('token-1');
    const result = makePortfolioWithTokens(instrumentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.availableTokens(instrumentId).value().toNumber()).toBe(100);
    expect(result.value.reservedTokens(instrumentId).value().toNumber()).toBe(0);
  });

  it('резервация перекладывает объём, а не уменьшает его', () => {
    const instrumentId = makeInstrumentId('token-1');
    const result = makePortfolioWithTokens(instrumentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserved = result.value.reserveTokens(instrumentId, qty(30));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    expect(reserved.value.availableTokens(instrumentId).value().toNumber()).toBe(70);
    expect(reserved.value.reservedTokens(instrumentId).value().toNumber()).toBe(30);
    // Позиция не изменилась: резервация — это не расход.
    expect(reserved.value.getPosition(instrumentId)?.quantity.value().toNumber()).toBe(100);
  });
});

describe('Portfolio.reserveTokens()', () => {
  const instrumentId = makeInstrumentId('token-1');

  it('накапливает резервации при нескольких заявках', () => {
    const result = makePortfolioWithTokens(instrumentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.value.reserveTokens(instrumentId, qty(30));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = first.value.reserveTokens(instrumentId, qty(20));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.reservedTokens(instrumentId).value().toNumber()).toBe(50);
    expect(second.value.availableTokens(instrumentId).value().toNumber()).toBe(50);
  });

  it('отвергает резервацию сверх доступного', () => {
    const result = makePortfolioWithTokens(instrumentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.reserveTokens(instrumentId, qty(150)).ok).toBe(false);
  });

  it('отвергает резервацию по неизвестному инструменту', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.reserveTokens(makeInstrumentId('nonexistent'), qty(10)).ok).toBe(false);
  });

  it('не мутирует исходный Portfolio', () => {
    const result = makePortfolioWithTokens(instrumentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    original.reserveTokens(instrumentId, qty(40));

    expect(original.reservedTokens(instrumentId).value().toNumber()).toBe(0);
    expect(original.availableTokens(instrumentId).value().toNumber()).toBe(100);
  });
});

describe('Portfolio.releaseTokens()', () => {
  const instrumentId = makeInstrumentId('token-1');

  it('возвращает объём в available', () => {
    const result = makePortfolioWithTokens(instrumentId, 60);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const released = result.value.releaseTokens(instrumentId, qty(25));
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    expect(released.value.reservedTokens(instrumentId).value().toNumber()).toBe(35);
    expect(released.value.availableTokens(instrumentId).value().toNumber()).toBe(65);
  });

  it('полное освобождение обнуляет reserved, но не удаляет инструмент', () => {
    const result = makePortfolioWithTokens(instrumentId, 50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const released = result.value.releaseTokens(instrumentId, qty(50));
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // Запись остаётся: позиция никуда не делась, и её 100 обязаны иметь
    // токенного двойника — иначе инвариант нарушен.
    expect(released.value.reservedTokens(instrumentId).value().toNumber()).toBe(0);
    expect(released.value.availableTokens(instrumentId).value().toNumber()).toBe(100);
  });

  it('отвергает освобождение сверх зарезервированного', () => {
    const result = makePortfolioWithTokens(instrumentId, 30);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.releaseTokens(instrumentId, qty(50)).ok).toBe(false);
  });

  it('отвергает освобождение, когда резерваций нет вовсе', () => {
    const result = makePortfolioWithTokens(instrumentId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.releaseTokens(instrumentId, qty(10)).ok).toBe(false);
  });
});

describe('Portfolio: токенные балансы переживают операции с деньгами', () => {
  it('резервация USDC не трогает токены', () => {
    const instrumentId = makeInstrumentId('token-1');
    const result = makePortfolioWithTokens(instrumentId, 50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const usdcReserved = result.value.reserveForOrder(mkMoney(1000));
    expect(usdcReserved.ok).toBe(true);
    if (!usdcReserved.ok) return;

    expect(usdcReserved.value.reservedTokens(instrumentId).value().toNumber()).toBe(50);
    expect(usdcReserved.value.availableTokens(instrumentId).value().toNumber()).toBe(50);
    expect(usdcReserved.value.balance.available().value().toNumber()).toBe(9000);
  });
});

describe('Portfolio: инвариант количества', () => {
  const instrumentId = makeInstrumentId('token-1');

  it('расхождение позиции с токенным балансом отвергается', () => {
    const result = makePortfolio({
      positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
      tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 40, 0)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.message).toContain('100 != token available+reserved 40');
    }
  });

  it('резервация расхождения не создаёт: available + reserved = quantity', () => {
    const result = makePortfolioWithTokens(instrumentId, 40);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const total = result.value.availableTokens(instrumentId).value()
      .plus(result.value.reservedTokens(instrumentId).value());

    expect(result.value.getPosition(instrumentId)?.quantity.value().equals(total)).toBe(true);
  });
});

describe('Portfolio.applyFill() — комиссия платится деньгами, не шарами', () => {
  // Комиссию на Polymarket платит только тейкер, платит ДЕНЬГАМИ и из того,
  // что получает; количество шар не изменяется никогда. Измерено на 2898
  // реальных сделках — `docs/guides/polymarket-fee-settlement.md`.

  const POSITION_ID = positionId('position-fee');
  const instrumentId = FILL_INSTRUMENT;

  function reservedForBuy(notional = 50) {
    const created = makePortfolio();
    if (!created.ok) throw new Error('fixture failed');
    const r = created.value.reserveForOrder(mkMoney(notional));
    if (!r.ok) throw new Error('fixture failed');
    return r.value;
  }

  it('BUY с комиссией: позиция на ПОЛНЫЙ размер', () => {
    const portfolio = reservedForBuy();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, feeUSDC: 1.0 }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(50) },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.getPosition(instrumentId)?.quantity.value().toNumber()).toBe(100);
    expect(applied.value.availableTokens(instrumentId).value().toNumber()).toBe(100);
  });

  it('мейкерский BUY: комиссии нет, available не тронут', () => {
    const portfolio = reservedForBuy();
    const before = portfolio.balance.available().value().toNumber();

    const applied = portfolio.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(50) },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.balance.available().value().toNumber()).toBe(before);
    expect(applied.value.getPosition(instrumentId)?.quantity.value().toNumber()).toBe(100);
  });

  it('SELL с комиссией: отдаём ПОЛНЫЙ размер, получаем номинал минус комиссию', () => {
    const bought = reservedForBuy().applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(50) },
    );
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const reserved = bought.value.reserveTokens(instrumentId, qty(100));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const before = reserved.value.balance.available().value().toNumber();

    // 100 × 0.6 = 60 номинала, комиссия 1.2 удерживается из выручки.
    const sold = reserved.value.applyFill(
      makeFill({ id: 'f2', side: 'SELL', size: 100, price: 0.6, feeUSDC: 1.2 }),
      { positionId: POSITION_ID },
    );
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;

    expect(sold.value.balance.available().value().toNumber()).toBeCloseTo(before + 58.8, 8);
    expect(sold.value.hasPosition(instrumentId)).toBe(false);
  });

  it('комиссия не создаёт расхождения позиции с токенами', () => {
    // Вычитайся она из шар, инвариант разошёлся бы ровно на `fee/price`, и
    // агрегат отверг бы собственную мутацию.
    const applied = reservedForBuy().applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, feeUSDC: 1.0 }),
      { positionId: POSITION_ID, reservedNotional: mkMoney(50) },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const position = applied.value.getPosition(instrumentId)!;
    const total = applied.value.availableTokens(instrumentId).value()
      .plus(applied.value.reservedTokens(instrumentId).value());

    expect(position.quantity.value().equals(total)).toBe(true);
  });
});

describe('Portfolio.create() — структура и владение', () => {
  const instrumentId = makeInstrumentId('token-1');
  const otherId = makeInstrumentId('token-2');

  it('ключ карты позиций обязан совпадать с самой позицией', () => {
    // Ключ — не метка, а утверждение об идентичности: разойдись он с записью,
    // поиск по инструменту вернул бы чужой объект.
    const result = makePortfolio({
      positions: new Map([[otherId, makeOpenPosition(instrumentId)]]),
      tokenBalances: new Map([[otherId, makeTokenBalance(otherId, 100)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('declares');
  });

  it('ключ карты токенов обязан совпадать с самим балансом', () => {
    const result = makePortfolio({
      positions: new Map([[otherId, makeOpenPosition(otherId)]]),
      tokenBalances: new Map([[otherId, makeTokenBalance(instrumentId, 100)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('declares');
  });

  it('чужая позиция отвергается', () => {
    const foreign = position(instrumentId, { quantity: 100, accountId: otherAccountId });
    const result = makePortfolio({
      positions: new Map([[instrumentId, foreign]]),
      tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 100)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('different account');
  });

  it('чужой токенный баланс отвергается', () => {
    const foreign = TokenBalance.of(instrumentId, qty(100), qty(0), otherAccountId, venueId);
    const result = makePortfolio({
      positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
      tokenBalances: new Map([[instrumentId, foreign]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('different account');
  });

  it('токенный баланс с чужой площадки отвергается', () => {
    const foreign = TokenBalance.of(instrumentId, qty(100), qty(0), accountId, OTHER_VENUE);
    const result = makePortfolio({
      positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
      tokenBalances: new Map([[instrumentId, foreign]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('venue');
  });

  it('баланс чужого аккаунта отвергается', () => {
    const foreignBalance = Balance.of(mkMoney(10_000), mkMoney(0), otherAccountId, venueId);
    const result = makePortfolio({ balance: foreignBalance });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('different account');
  });

  it('инструмент только в одной карте отвергается', () => {
    expect(makePortfolio({
      positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
    }).ok).toBe(false);

    expect(makePortfolio({
      tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 100)]]),
    }).ok).toBe(false);
  });

  it('нулевой токенный баланс без позиции отвергается — ноль это отсутствие', () => {
    // Мутаторы нормализуют ноль в отсутствие; принимать состояние, которого
    // они не производят, значит впустить набор, из которого сами не выйдем.
    const result = makePortfolio({
      tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 0, 0)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('present only in');
  });

  it('согласованный набор принимается', () => {
    expect(makePortfolioWithTokens(instrumentId).ok).toBe(true);
    expect(makePortfolioWithTokens(instrumentId, 40).ok).toBe(true);
  });
});

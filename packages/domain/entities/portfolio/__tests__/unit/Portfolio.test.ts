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
  return position(instrumentId, { quantity: 100, entryPrice: 0.65 });
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
}): Fill {
  const fee = params.feeUSDC
    ? Fee.of(new AssetQuantity(AssetIdHelpers.USDC, qty(params.feeUSDC)))
    : Fee.zero(AssetIdHelpers.USDC);
  const result = Fill.create({
    id: (params.id ?? 'fill-1') as unknown as FillId,
    orderId: 'order-1' as unknown as OrderId,
    accountId,
    venueId,
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

describe('Portfolio.applyFill() — позиция и токены двигаются вместе', () => {
  // `upsertPosition()` больше не публичен, и заменять хранимый `TokenBalance`
  // отдельно тоже нельзя. Те же поведения — открытие, наращивание, закрытие,
  // неизменяемость — проверяются через единственный оставшийся путь.

  const POSITION_ID = positionId('position-1');

  it('BUY открывает позицию и начисляет токены', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const applied = result.value.applyFill(makeFill({ side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.hasPosition(FILL_INSTRUMENT)).toBe(true);
    expect(applied.value.getPosition(FILL_INSTRUMENT)?.quantity.value().toNumber()).toBe(100);
    expect(applied.value.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(100);
    expect(applied.value.reservedTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
  });

  it('второй BUY наращивает ту же позицию, а не заводит вторую', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.value.applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = first.value.applyFill(
      makeFill({ id: 'f2', side: 'BUY', size: 50, price: 0.7 }), POSITION_ID);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.getPositionCount()).toBe(1);
    expect(second.value.getPosition(FILL_INSTRUMENT)?.quantity.value().toNumber()).toBe(150);
    expect(second.value.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(150);
  });

  it('SELL на весь объём закрывает позицию и обнуляет токены', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bought = result.value.applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    // Продавать можно только зарезервированное — сначала резервация под заявку.
    const reserved = bought.value.reserveTokens(FILL_INSTRUMENT, qty(100));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const sold = reserved.value.applyFill(
      makeFill({ id: 'f2', side: 'SELL', size: 100, price: 0.6 }), POSITION_ID);
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;

    expect(sold.value.hasPosition(FILL_INSTRUMENT)).toBe(false);
    expect(sold.value.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
    expect(sold.value.reservedTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
  });

  it('SELL без резервации отвергается', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bought = result.value.applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    // Токены есть, но лежат в available — продать их, не зарезервировав под
    // заявку, нельзя: иначе учёт разъехался бы с биржевым.
    const sold = bought.value.applyFill(
      makeFill({ id: 'f2', side: 'SELL', size: 100, price: 0.6 }), POSITION_ID);
    expect(sold.ok).toBe(false);
  });

  it('не мутирует исходный Portfolio', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    original.applyFill(makeFill({ side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);

    expect(original.getPositionCount()).toBe(0);
    expect(original.availableTokens(FILL_INSTRUMENT).value().toNumber()).toBe(0);
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

describe('Portfolio: инвариант агрегата', () => {
  const instrumentId = makeInstrumentId('token-1');

  it('create отвергает позицию без токенного двойника', () => {
    // Дыра, которую это закрывает: раньше такой набор собирался молча, и
    // первая же мутация отвергала состояние, которое сама не создавала.
    const result = makePortfolio({
      positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.message).toContain('invariant violated');
    }
  });

  it('create отвергает расхождение количества', () => {
    const result = makePortfolio({
      positions: new Map([[instrumentId, makeOpenPosition(instrumentId)]]),
      tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 40, 0)]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('100 != token available+reserved 40');
  });

  it('create отвергает токены без позиции', () => {
    const result = makePortfolio({
      tokenBalances: new Map([[instrumentId, makeTokenBalance(instrumentId, 10, 0)]]),
    });

    expect(result.ok).toBe(false);
  });

  it('согласованный набор принимается', () => {
    expect(makePortfolioWithTokens(instrumentId).ok).toBe(true);
    expect(makePortfolioWithTokens(instrumentId, 40).ok).toBe(true);
  });
});

describe('Portfolio.applyFill() — комиссия платится деньгами, не шарами', () => {
  // Комиссию на Polymarket платит только тейкер, платит ДЕНЬГАМИ и из того,
  // что получает; количество шар не изменяется никогда. Измерено на 2898
  // реальных сделках — `docs/guides/polymarket-fee-settlement.md`.
  //
  // Портфель эту экономику НЕ пересчитывает: он применяет нетто-поток самого
  // `Fill` (`getNetCashFlow()`), а количество берёт валовым.

  const POSITION_ID = positionId('position-fee');
  const instrumentId = FILL_INSTRUMENT;

  it('BUY с комиссией: позиция на ПОЛНЫЙ размер, деньги на номинал + комиссию', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = result.value.balance.available().value().toNumber();

    // 100 × 0.5 = 50 номинала, комиссия 1.0 USDC сверх.
    const applied = result.value.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, feeUSDC: 1.0 }), POSITION_ID);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.getPosition(instrumentId)?.quantity.value().toNumber()).toBe(100);
    expect(applied.value.availableTokens(instrumentId).value().toNumber()).toBe(100);
    expect(applied.value.balance.available().value().toNumber()).toBeCloseTo(before - 51, 8);
  });

  it('мейкерский BUY: комиссии нет, деньги ровно на номинал', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = result.value.balance.available().value().toNumber();
    const applied = result.value.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.balance.available().value().toNumber()).toBeCloseTo(before - 50, 8);
    expect(applied.value.getPosition(instrumentId)?.quantity.value().toNumber()).toBe(100);
  });

  it('SELL с комиссией: отдаём ПОЛНЫЙ размер, получаем номинал минус комиссию', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bought = result.value.applyFill(
      makeFill({ id: 'f1', side: 'BUY', size: 100, price: 0.5 }), POSITION_ID);
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const reserved = bought.value.reserveTokens(instrumentId, qty(100));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const before = reserved.value.balance.available().value().toNumber();

    // 100 × 0.6 = 60 номинала, комиссия 1.2 USDC удерживается из выручки.
    const sold = reserved.value.applyFill(
      makeFill({ id: 'f2', side: 'SELL', size: 100, price: 0.6, feeUSDC: 1.2 }), POSITION_ID);
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;

    expect(sold.value.balance.available().value().toNumber()).toBeCloseTo(before + 58.8, 8);
    // Отдали полные 100 шар — комиссия их не касается.
    expect(sold.value.hasPosition(instrumentId)).toBe(false);
    expect(sold.value.availableTokens(instrumentId).value().toNumber()).toBe(0);
    expect(sold.value.reservedTokens(instrumentId).value().toNumber()).toBe(0);
  });

  it('комиссия не создаёт расхождения позиции с токенами', () => {
    // Если бы комиссия вычиталась из шар, инвариант разошёлся бы ровно на
    // fee/price — и агрегат отверг бы собственную мутацию.
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const applied = result.value.applyFill(
      makeFill({ side: 'BUY', size: 100, price: 0.5, feeUSDC: 1.0 }), POSITION_ID);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const position = applied.value.getPosition(instrumentId)!;
    const total =
      applied.value.availableTokens(instrumentId).value().plus(
        applied.value.reservedTokens(instrumentId).value());

    expect(position.quantity.value().equals(total)).toBe(true);
  });
});

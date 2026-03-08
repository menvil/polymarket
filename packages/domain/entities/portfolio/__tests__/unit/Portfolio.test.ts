/**
 * Тесты для Portfolio aggregate
 *
 * @remarks
 * Проверяет:
 * - create() с валидными/невалидными данными
 * - reserveForOrder / releaseReservation / applyDebit / applyCredit
 * - upsertPosition (добавление, обновление, удаление закрытых позиций)
 * - getPosition / hasPosition / getAllPositions / getPositionCount / isEmpty
 * - toString()
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Portfolio } from '../../src/Portfolio.js';
import { asPortfolioId } from '../../src/value-objects/index.js';
import { PortfolioValidationError } from '@polymarket/errors/portfolio';
import { Balance } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';
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

const ZERO = { value: () => new Decimal(0) };
const PRICE = { value: () => new Decimal(0.65) };
const QTY   = { value: () => new Decimal(100) };

function makeOpenPosition(instrumentId: InstrumentId) {
  return {
    instrumentId,
    quantity: QTY,
    side: 'LONG' as const,
    averageEntryPrice: PRICE,
    isClosed: () => false,
    getUnrealizedPnL: () => ZERO,
  };
}

function makeClosedPosition(instrumentId: InstrumentId) {
  return {
    instrumentId,
    quantity: ZERO,
    side: 'LONG' as const,
    averageEntryPrice: PRICE,
    isClosed: () => true,
    getUnrealizedPnL: () => ZERO,
  };
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
    const result = makePortfolio({ positions });
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
});

describe('Portfolio.upsertPosition()', () => {
  it('добавляет открытую позицию', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instrumentId = makeInstrumentId('instrument-1');
    const updated = result.value.upsertPosition(makeOpenPosition(instrumentId));
    expect(updated.hasPosition(instrumentId)).toBe(true);
    expect(updated.getPositionCount()).toBe(1);
  });

  it('обновляет существующую позицию', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newPosition = { ...makeOpenPosition(instrumentId), extraField: 'updated' };
    const updated = result.value.upsertPosition(newPosition);
    expect(updated.getPositionCount()).toBe(1);
    expect(updated.getPosition(instrumentId)).toBe(newPosition);
  });

  it('удаляет закрытую позицию', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = result.value.upsertPosition(makeClosedPosition(instrumentId));
    expect(updated.hasPosition(instrumentId)).toBe(false);
    expect(updated.getPositionCount()).toBe(0);
  });

  it('не мутирует исходный Portfolio', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    const instrumentId = makeInstrumentId('instrument-1');
    original.upsertPosition(makeOpenPosition(instrumentId));
    expect(original.getPositionCount()).toBe(0); // оригинал не изменился
  });
});

describe('Portfolio.getPosition() / hasPosition()', () => {
  it('getPosition возвращает позицию если есть', () => {
    const instrumentId = makeInstrumentId('instrument-1');
    const position = makeOpenPosition(instrumentId);
    const positions = new Map([[instrumentId, position]]);
    const result = makePortfolio({ positions });
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
    const result = makePortfolio({ positions });
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
  it('возвращает все позиции', () => {
    const id1 = makeInstrumentId('instrument-1');
    const id2 = makeInstrumentId('instrument-2');
    const positions = new Map([
      [id1, makeOpenPosition(id1)],
      [id2, makeOpenPosition(id2)],
    ]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const all = Array.from(result.value.getPositions());
    expect(all.length).toBe(2);
  });

  it('возвращает пустой итератор при отсутствии позиций', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.from(result.value.getPositions())).toEqual([]);
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
    const result = makePortfolio({ balance: makeBalance(0, 0), positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isEmpty()).toBe(false);
  });
});

describe('Portfolio.toString()', () => {
  it('содержит id, баланс и количество позиций', () => {
    const result = makePortfolio({ balance: makeBalance(10000, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const str = result.value.toString();
    expect(str).toContain('portfolio-abc');
    expect(str).toContain('10000');
    expect(str).toContain('USDC');
    expect(str).toContain('0');
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

/**
 * Тесты для Portfolio aggregate
 *
 * @remarks
 * Проверяет:
 * - create() с валидными/невалидными данными
 * - reserveForOrder / releaseReservation / applyDebit / applyCredit
 * - reserveTokensForOrder / releaseTokenReservation / availableTokenQuantity
 * - upsertPosition (добавление, обновление, удаление закрытых позиций)
 * - Immutability: upsertPosition и withBalance сохраняют tokenReservations
 * - getPosition / hasPosition / getPositions / getPositionCount / isEmpty
 * - toString()
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Portfolio } from '../../src/Portfolio.js';
import { asPortfolioId } from '../../src/value-objects/index.js';
import { PortfolioValidationError } from '@polymarket/errors/portfolio';
import { InvalidBalanceError } from '@polymarket/errors';
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
  it('возвращает все позиции с корректными instrumentId', () => {
    const id1 = makeInstrumentId('instrument-1');
    const id2 = makeInstrumentId('instrument-2');
    const pos1 = makeOpenPosition(id1);
    const pos2 = makeOpenPosition(id2);
    const positions = new Map([
      [id1, pos1],
      [id2, pos2],
    ]);
    const result = makePortfolio({ positions });
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
    const result = makePortfolio({ positions: sourceMap });
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
    const result = makePortfolio({ balance: makeBalance(0, 0), positions });
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
    const result = makePortfolio({ positions });
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

describe('Portfolio.availableTokenQuantity()', () => {
  it('возвращает 0 если позиции нет', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const available = result.value.availableTokenQuantity(makeInstrumentId('unknown'));
    expect(available.toNumber()).toBe(0);
  });

  it('возвращает полную позицию если резерваций нет', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // QTY = 100
    const available = result.value.availableTokenQuantity(instrumentId);
    expect(available.toNumber()).toBe(100);
  });

  it('возвращает позицию минус резервации', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveTokensForOrder(instrumentId, new Decimal(30));
    expect(reserveResult.ok).toBe(true);
    if (!reserveResult.ok) return;

    const available = reserveResult.value.availableTokenQuantity(instrumentId);
    expect(available.toNumber()).toBe(70); // 100 - 30
  });
});

describe('Portfolio.reserveTokensForOrder()', () => {
  it('резервирует токены: available уменьшается, tokenReservations обновляется', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveTokensForOrder(instrumentId, new Decimal(40));
    expect(reserveResult.ok).toBe(true);
    if (!reserveResult.ok) return;

    const portfolio = reserveResult.value;
    expect(portfolio.tokenReservations.get(instrumentId)?.toNumber()).toBe(40);
    expect(portfolio.availableTokenQuantity(instrumentId).toNumber()).toBe(60); // 100 - 40
  });

  it('накапливает резервации при нескольких SELL ордерах', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.value.reserveTokensForOrder(instrumentId, new Decimal(30));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = first.value.reserveTokensForOrder(instrumentId, new Decimal(20));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.tokenReservations.get(instrumentId)?.toNumber()).toBe(50); // 30 + 20
    expect(second.value.availableTokenQuantity(instrumentId).toNumber()).toBe(50); // 100 - 50
  });

  it('возвращает Err если available < qty', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // QTY = 100, пытаемся зарезервировать 150
    const reserveResult = result.value.reserveTokensForOrder(instrumentId, new Decimal(150));
    expect(reserveResult.ok).toBe(false);
    if (!reserveResult.ok) {
      expect(reserveResult.error).toBeInstanceOf(InvalidBalanceError);
    }
  });

  it('возвращает Err если позиции нет (нечего резервировать)', () => {
    const result = makePortfolio();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserveResult = result.value.reserveTokensForOrder(
      makeInstrumentId('nonexistent'),
      new Decimal(10),
    );
    expect(reserveResult.ok).toBe(false);
    if (!reserveResult.ok) {
      expect(reserveResult.error).toBeInstanceOf(InvalidBalanceError);
    }
  });

  it('не мутирует исходный Portfolio', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    original.reserveTokensForOrder(instrumentId, new Decimal(50));

    // Оригинал не изменился
    expect(original.tokenReservations.get(instrumentId)).toBeUndefined();
    expect(original.availableTokenQuantity(instrumentId).toNumber()).toBe(100);
  });
});

describe('Portfolio.releaseTokenReservation()', () => {
  it('уменьшает резервацию после освобождения', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(60));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const released = reserved.value.releaseTokenReservation(instrumentId, new Decimal(25));
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    expect(released.value.tokenReservations.get(instrumentId)?.toNumber()).toBe(35); // 60 - 25
    expect(released.value.availableTokenQuantity(instrumentId).toNumber()).toBe(65); // 100 - 35
  });

  it('удаляет запись из Map если резервация стала 0', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(50));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const released = reserved.value.releaseTokenReservation(instrumentId, new Decimal(50));
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // Запись должна быть удалена из Map
    expect(released.value.tokenReservations.get(instrumentId)).toBeUndefined();
    expect(released.value.tokenReservations.size).toBe(0);
  });

  it('возвращает Err если резервация < qty', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(30));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    // Пытаемся освободить больше, чем зарезервировано
    const released = reserved.value.releaseTokenReservation(instrumentId, new Decimal(50));
    expect(released.ok).toBe(false);
    if (!released.ok) {
      expect(released.error).toBeInstanceOf(InvalidBalanceError);
    }
  });

  it('возвращает Err если резерваций нет вовсе', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Нет резерваций — пытаемся освободить
    const released = result.value.releaseTokenReservation(instrumentId, new Decimal(10));
    expect(released.ok).toBe(false);
    if (!released.ok) {
      expect(released.error).toBeInstanceOf(InvalidBalanceError);
    }
  });
});

describe('Portfolio immutability: tokenReservations сохраняются при других операциях', () => {
  it('upsertPosition сохраняет tokenReservations', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Резервируем токены
    const reserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(40));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    // Обновляем позицию
    const otherId = makeInstrumentId('token-2');
    const updated = reserved.value.upsertPosition(makeOpenPosition(otherId));

    // tokenReservations должны сохраниться
    expect(updated.tokenReservations.get(instrumentId)?.toNumber()).toBe(40);
    expect(updated.tokenReservations.size).toBe(1);
  });

  it('withBalance (через reserveForOrder) сохраняет tokenReservations', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Резервируем токены
    const tokenReserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(50));
    expect(tokenReserved.ok).toBe(true);
    if (!tokenReserved.ok) return;

    // Теперь резервируем USDC (вызывает withBalance внутри)
    const usdcReserved = tokenReserved.value.reserveForOrder(mkMoney(1000));
    expect(usdcReserved.ok).toBe(true);
    if (!usdcReserved.ok) return;

    // tokenReservations должны сохраниться после операции с балансом
    expect(usdcReserved.value.tokenReservations.get(instrumentId)?.toNumber()).toBe(50);
    expect(usdcReserved.value.balance.available().value().toNumber()).toBe(9000); // 10000 - 1000
  });
});

describe('Portfolio полный lifecycle токенных резерваций', () => {
  it('reserve → releaseTokenReservation (cancel) восстанавливает доступный объём', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(80));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    expect(reserved.value.availableTokenQuantity(instrumentId).toNumber()).toBe(20);

    const released = reserved.value.releaseTokenReservation(instrumentId, new Decimal(80));
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // Должно вернуться к полному объёму
    expect(released.value.availableTokenQuantity(instrumentId).toNumber()).toBe(100);
    expect(released.value.tokenReservations.size).toBe(0);
  });

  it('reserve → releaseTokenReservation (fill partial) снижает резервацию пропорционально', () => {
    const instrumentId = makeInstrumentId('token-1');
    const positions = new Map([[instrumentId, makeOpenPosition(instrumentId)]]);
    const result = makePortfolio({ positions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Разместили SELL на 60 токенов
    const reserved = result.value.reserveTokensForOrder(instrumentId, new Decimal(60));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    // Пришёл partial fill на 40
    const afterFill = reserved.value.releaseTokenReservation(instrumentId, new Decimal(40));
    expect(afterFill.ok).toBe(true);
    if (!afterFill.ok) return;

    // Осталась резервация на 20 (неисполненный остаток)
    expect(afterFill.value.tokenReservations.get(instrumentId)?.toNumber()).toBe(20);
    expect(afterFill.value.availableTokenQuantity(instrumentId).toNumber()).toBe(80); // 100 - 20
  });
});

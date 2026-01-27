/**
 * Тесты для Portfolio entity
 */
import { describe, it, expect } from '@jest/globals';
import {
  Portfolio,
  Position,
  PositionLot,
  DuplicatePositionError,
  PositionNotFoundError
} from '../../src/index.js';
import {
  PortfolioValidationError,
  InsufficientFundsError
} from '@polymarket/errors';
import { Price, Quantity, Money } from '@polymarket/value-objects';
import type { Result } from '@polymarket/result';

// Helper functions
function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Unwrap failed`);
  return result.value;
}

function createPrice(value: number): Price {
  const result = Price.fromValue(value);
  if (!result.ok) throw new Error(`Failed to create Price: ${result.error.message}`);
  return result.value;
}

function createQuantity(value: number): Quantity {
  const result = Quantity.fromValue(value);
  if (!result.ok) throw new Error(`Failed to create Quantity: ${result.error.message}`);
  return result.value;
}

function createMoney(value: number): Money {
  const result = Money.fromValue(value);
  if (!result.ok) throw new Error(`Failed to create Money: ${result.error.message}`);
  return result.value;
}

function createPosition(tokenId: string, side: 'YES' | 'NO', lots: PositionLot[]): Position {
  let position = Position.empty(tokenId, side);

  for (const lot of lots) {
    const addResult = position.addLot(lot);
    if (!addResult.ok) throw new Error(`Failed to add lot: ${addResult.error.message}`);
    position = addResult.value;
  }

  return position;
}

describe('Portfolio', () => {
  describe('create()', () => {
    it('должен создать новый портфель с валидными параметрами', () => {
      const result = Portfolio.create('p-1', createMoney(1000));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe('p-1');
      expect(result.value.cash.getAmount()).toBe(1000);
      expect(result.value.reservedCash.getAmount()).toBe(0);
      expect(result.value.getPositionCount()).toBe(0);
    });

    it('должен создать портфель с большой суммой', () => {
      const result = Portfolio.create('p-3', createMoney(1000000));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.cash.getAmount()).toBe(1000000);
    });

    it('должен вернуть ошибку для пустого id', () => {
      const result = Portfolio.create('', createMoney(1000));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.message).toContain('non-empty string');
    });

    it('должен вернуть ошибку для whitespace id', () => {
      const result = Portfolio.create('   ', createMoney(1000));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(PortfolioValidationError);
    });

    it('должен вернуть ошибку для отрицательного initialCash', () => {
      const result = Portfolio.create('p-1', createMoney(-100));

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(PortfolioValidationError);
      expect(result.error.message).toContain('cannot be negative');
    });
  });

  describe('availableCash getter', () => {
    it('должен возвращать доступный кэш (cash - reservedCash)', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const reserveResult = createResult.value.reserveCash(createMoney(300));
      if (!reserveResult.ok) throw new Error('Failed to reserve cash');

      expect(reserveResult.value.availableCash.getAmount()).toBe(700);
    });

    it('должен возвращать 0 если весь кэш зарезервирован', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const reserveResult = createResult.value.reserveCash(createMoney(1000));
      if (!reserveResult.ok) throw new Error('Failed to reserve cash');

      expect(reserveResult.value.availableCash.getAmount()).toBe(0);
    });
  });

  describe('reserveCash()', () => {
    it('должен зарезервировать кэш', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const reserveResult = createResult.value.reserveCash(createMoney(300));

      expect(reserveResult.ok).toBe(true);
      if (!reserveResult.ok) return;

      expect(reserveResult.value.reservedCash.getAmount()).toBe(300);
      expect(reserveResult.value.availableCash.getAmount()).toBe(700);
    });

    it('должен вернуть ошибку если недостаточно доступного кэша', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const reserveResult = createResult.value.reserveCash(createMoney(1500));

      expect(reserveResult.ok).toBe(false);
      if (reserveResult.ok) return;

      expect(reserveResult.error).toBeInstanceOf(InsufficientFundsError);
      expect(reserveResult.error.requested).toBe(1500);
      expect(reserveResult.error.available).toBe(1000);
    });
  });

  describe('releaseCash()', () => {
    it('должен освободить зарезервированный кэш', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const reserveResult = createResult.value.reserveCash(createMoney(300));
      if (!reserveResult.ok) throw new Error('Failed to reserve cash');

      const releaseResult = reserveResult.value.releaseCash(createMoney(100));

      expect(releaseResult.ok).toBe(true);
      if (!releaseResult.ok) return;

      expect(releaseResult.value.reservedCash.getAmount()).toBe(200);
      expect(releaseResult.value.availableCash.getAmount()).toBe(800);
    });

    it('должен вернуть ошибку при попытке освободить больше чем зарезервировано', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const reserveResult = createResult.value.reserveCash(createMoney(300));
      if (!reserveResult.ok) throw new Error('Failed to reserve cash');

      const releaseResult = reserveResult.value.releaseCash(createMoney(500));

      expect(releaseResult.ok).toBe(false);
      if (releaseResult.ok) return;

      expect(releaseResult.error).toBeInstanceOf(PortfolioValidationError);
      expect(releaseResult.error.message).toContain('Cannot release');
    });
  });

  describe('updateCash()', () => {
    it('должен увеличить кэш при положительном amount', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const updateResult = createResult.value.updateCash(createMoney(500));

      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      expect(updateResult.value.cash.getAmount()).toBe(1500);
    });

    it('должен уменьшить кэш при отрицательном amount', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const updateResult = createResult.value.updateCash(createMoney(-300));

      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      expect(updateResult.value.cash.getAmount()).toBe(700);
    });

    it('должен вернуть ошибку если кэш становится отрицательным', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const updateResult = createResult.value.updateCash(createMoney(-1500));

      expect(updateResult.ok).toBe(false);
      if (updateResult.ok) return;

      expect(updateResult.error).toBeInstanceOf(PortfolioValidationError);
      expect(updateResult.error.message).toContain('cannot be negative');
    });
  });

  describe('addPosition()', () => {
    it('должен добавить новую позицию', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const lot = unwrap(PositionLot.create(
        'lot-1',
        'token-1',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      ));
      const position = createPosition('token-1', 'YES', [lot]);

      const addResult = createResult.value.addPosition(position);

      expect(addResult.ok).toBe(true);
      if (!addResult.ok) return;

      expect(addResult.value.getPositionCount()).toBe(1);
      expect(addResult.value.getPosition('token-1')).toBeDefined();
    });

    it('должен вернуть ошибку при дубликате tokenId', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const position1 = Position.empty('token-1', 'YES');

      const add1 = createResult.value.addPosition(position1);
      if (!add1.ok) throw new Error('Failed to add first position');

      const position2 = Position.empty('token-1', 'NO');

      const add2 = add1.value.addPosition(position2);

      expect(add2.ok).toBe(false);
      if (add2.ok) return;

      expect(add2.error).toBeInstanceOf(DuplicatePositionError);
      if (add2.error instanceof DuplicatePositionError) {
        expect(add2.error.marketId).toBe('token-1');
      }
    });
  });

  describe('updatePosition()', () => {
    it('должен обновить существующую позицию', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const lot1 = unwrap(PositionLot.create('lot-1', 'token-1', 'YES', createQuantity(10), createPrice(0.65), Date.now()));
      const position1 = createPosition('token-1', 'YES', [lot1]);

      const add = createResult.value.addPosition(position1);
      if (!add.ok) throw new Error('Failed to add position');

      const lot2 = unwrap(PositionLot.create('lot-2', 'token-1', 'YES', createQuantity(20), createPrice(0.70), Date.now()));
      const position2 = createPosition('token-1', 'YES', [lot2]);

      const updateResult = add.value.updatePosition('token-1', position2);

      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      const updated = updateResult.value.getPosition('token-1');
      expect(updated?.totalQuantity.value).toBe(20);
    });

    it('должен удалить позицию если она пустая', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const lot1 = unwrap(PositionLot.create('lot-1', 'token-1', 'YES', createQuantity(10), createPrice(0.65), Date.now()));
      const position1 = createPosition('token-1', 'YES', [lot1]);

      const add = createResult.value.addPosition(position1);
      if (!add.ok) throw new Error('Failed to add position');

      const emptyPosition = Position.empty('token-1', 'YES');

      const updateResult = add.value.updatePosition('token-1', emptyPosition);

      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      expect(updateResult.value.getPosition('token-1')).toBeUndefined();
      expect(updateResult.value.getPositionCount()).toBe(0);
    });

    it('должен вернуть ошибку для несуществующей позиции', () => {
      const createResult = Portfolio.create('p-1', createMoney(1000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      const position = Position.empty('token-999', 'YES');

      const updateResult = createResult.value.updatePosition('token-999', position);

      expect(updateResult.ok).toBe(false);
      if (updateResult.ok) return;

      expect(updateResult.error).toBeInstanceOf(PositionNotFoundError);
      if (updateResult.error instanceof PositionNotFoundError) {
        expect(updateResult.error.marketId).toBe('token-999');
      }
    });
  });

  describe('Complex scenario: reserve -> add position -> release', () => {
    it('должен корректно обработать последовательность операций', () => {
      const createResult = Portfolio.create('p-1', createMoney(10000));
      if (!createResult.ok) throw new Error('Failed to create portfolio');

      // Reserve cash for order
      const reserve1 = createResult.value.reserveCash(createMoney(1000));
      if (!reserve1.ok) throw new Error('Failed to reserve cash 1');

      // Add position
      const lotResult = PositionLot.create(
        'lot-1',
        'token-1',
        'YES',
        createQuantity(100),
        createPrice(0.65),
        Date.now()
      );
      if (!lotResult.ok) throw new Error('Failed to create lot');

      const position = createPosition('token-1', 'YES', [lotResult.value]);
      const addPos = reserve1.value.addPosition(position);
      if (!addPos.ok) throw new Error('Failed to add position');

      // Reserve more cash
      const reserve2 = addPos.value.reserveCash(createMoney(500));
      if (!reserve2.ok) throw new Error('Failed to reserve cash 2');

      // Release cash
      const release1 = reserve2.value.releaseCash(createMoney(1000));
      if (!release1.ok) throw new Error('Failed to release cash');

      expect(release1.value.cash.getAmount()).toBe(10000);
      expect(release1.value.reservedCash.getAmount()).toBe(500);
      expect(release1.value.availableCash.getAmount()).toBe(9500);
      expect(release1.value.getPositionCount()).toBe(1);
    });
  });
});

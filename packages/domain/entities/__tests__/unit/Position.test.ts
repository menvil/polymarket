/**
 * Position entity tests - Result pattern
 *
 * @remarks
 * Comprehensive тесты для Position entity после рефакторинга с Result pattern.
 * Покрывают:
 * - Создание пустой позиции
 * - Добавление лотов (addLot)
 * - Удаление лотов (removeLot)
 * - Расчёт средней цены
 * - Расчёт unrealized P&L
 * - FIFO алгоритм
 */
import { describe, it, expect } from '@jest/globals';
import { Position, LotNotFoundError } from '../../src/Position.js';
import { PositionLot, InsufficientLotQuantityError } from '../../src/PositionLot.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { PositionValidationError } from '@polymarket/errors';

describe('Position Entity (Result pattern)', () => {
  // Helpers
  const createPrice = (value: number): Price => {
    const result = Price.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Price: ${result.error.message}`);
    return result.value;
  };

  const createQuantity = (value: number): Quantity => {
    const result = Quantity.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Quantity: ${result.error.message}`);
    return result.value;
  };

  const createLot = (
    lotId: string,
    tokenId: string,
    side: 'YES' | 'NO',
    quantity: number,
    price: number
  ): PositionLot => {
    const result = PositionLot.create(
      lotId,
      tokenId,
      side,
      createQuantity(quantity),
      createPrice(price),
      Date.now()
    );
    if (!result.ok) throw new Error(`Failed to create lot: ${result.error.message}`);
    return result.value;
  };

  describe('Position.empty()', () => {
    it('должен создать пустую позицию для YES', () => {
      const position = Position.empty('token-123', 'YES');

      expect(position.tokenId).toBe('token-123');
      expect(position.side).toBe('YES');
      expect(position.totalQuantity.value).toBe(0);
      expect(position.averageEntryPrice.value).toBe(0.5); // Neutral price
      expect(position.lots.length).toBe(0);
      expect(position.isEmpty()).toBe(true);
    });

    it('должен создать пустую позицию для NO', () => {
      const position = Position.empty('token-456', 'NO');

      expect(position.tokenId).toBe('token-456');
      expect(position.side).toBe('NO');
      expect(position.isEmpty()).toBe(true);
    });
  });

  describe('Position.addLot() - успешное добавление', () => {
    it('должен добавить первый лот', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const result = position.addLot(lot);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const updated = result.value;
        expect(updated.totalQuantity.value).toBe(10);
        expect(updated.averageEntryPrice.value).toBe(0.60);
        expect(updated.lots.length).toBe(1);
        expect(updated.isEmpty()).toBe(false);
      }
    });

    it('должен добавить второй лот и вычислить weighted average', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const result1 = position.addLot(lot1);
      if (!result1.ok) throw new Error('Failed to add lot1');

      const result2 = result1.value.addLot(lot2);
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        const updated = result2.value;
        expect(updated.totalQuantity.value).toBe(15);
        // (10 * 0.60 + 5 * 0.70) / 15 = 9.5 / 15 = 0.6333...
        expect(updated.averageEntryPrice.value).toBeCloseTo(0.6333, 3);
        expect(updated.lots.length).toBe(2);
      }
    });

    it('должен добавить три лота и правильно вычислить среднюю цену', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.50);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 20, 0.60);
      const lot3 = createLot('lot-3', 'token-123', 'YES', 15, 0.70);

      const result1 = position.addLot(lot1);
      if (!result1.ok) throw new Error('Failed to add lot1');

      const result2 = result1.value.addLot(lot2);
      if (!result2.ok) throw new Error('Failed to add lot2');

      const result3 = result2.value.addLot(lot3);
      expect(result3.ok).toBe(true);
      if (result3.ok) {
        const updated = result3.value;
        expect(updated.totalQuantity.value).toBe(45);
        // (10*0.50 + 20*0.60 + 15*0.70) / 45 = 27.5 / 45 = 0.6111...
        expect(updated.averageEntryPrice.value).toBeCloseTo(0.6111, 3);
        expect(updated.lots.length).toBe(3);
      }
    });

    it('оригинальная позиция должна остаться неизменной (immutability)', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const result = position.addLot(lot);
      expect(result.ok).toBe(true);

      // Оригинальная позиция не изменилась
      expect(position.lots.length).toBe(0);
      expect(position.totalQuantity.value).toBe(0);
    });
  });

  describe('Position.addLot() - валидация', () => {
    it('должен вернуть ошибку если tokenId не совпадает', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-456', 'YES', 10, 0.60);

      const result = position.addLot(lot);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PositionValidationError);
        expect(result.error.message).toContain('Token mismatch');
        expect(result.error.message).toContain('token-456');
        expect(result.error.message).toContain('token-123');
      }
    });

    it('должен вернуть ошибку если side не совпадает', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'NO', 10, 0.60);

      const result = position.addLot(lot);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PositionValidationError);
        expect(result.error.message).toContain('Side mismatch');
        expect(result.error.message).toContain('NO');
        expect(result.error.message).toContain('YES');
      }
    });
  });

  describe('Position.removeLot() - успешное удаление', () => {
    it('должен частично закрыть лот', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const removeResult = addResult.value.removeLot('lot-1', createQuantity(6));
      expect(removeResult.ok).toBe(true);
      if (removeResult.ok) {
        const updated = removeResult.value;
        expect(updated.totalQuantity.value).toBe(4);
        expect(updated.averageEntryPrice.value).toBe(0.60);
        expect(updated.lots.length).toBe(1);
        expect(updated.lots[0].quantity.value).toBe(4);
      }
    });

    it('должен полностью закрыть лот и удалить его из массива', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const removeResult = addResult.value.removeLot('lot-1', createQuantity(10));
      expect(removeResult.ok).toBe(true);
      if (removeResult.ok) {
        const updated = removeResult.value;
        expect(updated.totalQuantity.value).toBe(0);
        expect(updated.lots.length).toBe(0);
        expect(updated.isEmpty()).toBe(true);
      }
    });

    it('должен удалить один лот из нескольких', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      const removeResult = add2.value.removeLot('lot-1', createQuantity(10));
      expect(removeResult.ok).toBe(true);
      if (removeResult.ok) {
        const updated = removeResult.value;
        expect(updated.totalQuantity.value).toBe(5);
        expect(updated.averageEntryPrice.value).toBe(0.70);
        expect(updated.lots.length).toBe(1);
        expect(updated.lots[0].lotId).toBe('lot-2');
      }
    });

    it('должен пересчитать среднюю цену после частичного удаления', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.50);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 10, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      // Средняя цена: (10*0.50 + 10*0.70) / 20 = 0.60
      expect(add2.value.averageEntryPrice.value).toBe(0.60);

      // Удаляем 5 из lot-1 (цена 0.50)
      const removeResult = add2.value.removeLot('lot-1', createQuantity(5));
      expect(removeResult.ok).toBe(true);
      if (removeResult.ok) {
        const updated = removeResult.value;
        // Осталось: 5*0.50 + 10*0.70 = 9.5 / 15 = 0.6333...
        expect(updated.totalQuantity.value).toBe(15);
        expect(updated.averageEntryPrice.value).toBeCloseTo(0.6333, 3);
      }
    });
  });

  describe('Position.removeLot() - ошибки', () => {
    it('должен вернуть ошибку если лот не найден', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const removeResult = addResult.value.removeLot('lot-999', createQuantity(5));
      expect(removeResult.ok).toBe(false);
      if (!removeResult.ok) {
        expect(removeResult.error).toBeInstanceOf(LotNotFoundError);
        if (removeResult.error instanceof LotNotFoundError) {
          expect(removeResult.error.lotId).toBe('lot-999');
        }
      }
    });

    it('должен вернуть ошибку если удаляем больше чем есть', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const removeResult = addResult.value.removeLot('lot-1', createQuantity(15));
      expect(removeResult.ok).toBe(false);
      if (!removeResult.ok) {
        expect(removeResult.error).toBeInstanceOf(InsufficientLotQuantityError);
      }
    });
  });

  describe('Position.calculateUnrealizedPnL()', () => {
    it('должен вернуть ноль для пустой позиции', () => {
      const position = Position.empty('token-123', 'YES');
      const pnl = position.calculateUnrealizedPnL(createPrice(0.70));
      expect(pnl.getAmount()).toBe(0);
    });

    it('должен вычислить P&L для одного лота', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const pnl = addResult.value.calculateUnrealizedPnL(createPrice(0.70));
      expect(pnl.getAmount()).toBeCloseTo(1.0, 6); // (0.70 - 0.60) * 10
    });

    it('должен вычислить суммарный P&L для нескольких лотов', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      const pnl = add2.value.calculateUnrealizedPnL(createPrice(0.75));
      // lot1: (0.75 - 0.60) * 10 = 1.5
      // lot2: (0.75 - 0.70) * 5 = 0.25
      // total: 1.75
      expect(pnl.getAmount()).toBeCloseTo(1.75, 6);
    });
  });

  describe('Position.getOldestLot()', () => {
    it('должен вернуть undefined для пустой позиции', () => {
      const position = Position.empty('token-123', 'YES');
      expect(position.getOldestLot()).toBeUndefined();
    });

    it('должен вернуть первый лот', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      const oldest = add2.value.getOldestLot();
      expect(oldest?.lotId).toBe('lot-1');
    });
  });

  describe('Position.getTotalCost()', () => {
    it('должен вернуть ноль для пустой позиции', () => {
      const position = Position.empty('token-123', 'YES');
      const cost = position.getTotalCost();
      expect(cost.getAmount()).toBe(0);
    });

    it('должен вычислить total cost для одного лота', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const cost = addResult.value.getTotalCost();
      expect(cost.getAmount()).toBe(6.0); // 10 * 0.60
    });

    it('должен вычислить total cost для нескольких лотов', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      const cost = add2.value.getTotalCost();
      expect(cost.getAmount()).toBe(9.5); // 10*0.60 + 5*0.70
    });
  });

  describe('Position.getLotCount()', () => {
    it('должен вернуть 0 для пустой позиции', () => {
      const position = Position.empty('token-123', 'YES');
      expect(position.getLotCount()).toBe(0);
    });

    it('должен вернуть количество лотов', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      expect(add1.value.getLotCount()).toBe(1);

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      expect(add2.value.getLotCount()).toBe(2);
    });
  });

  describe('Position.isEmpty()', () => {
    it('должен вернуть true для новой пустой позиции', () => {
      const position = Position.empty('token-123', 'YES');
      expect(position.isEmpty()).toBe(true);
    });

    it('должен вернуть false после добавления лота', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      expect(addResult.value.isEmpty()).toBe(false);
    });

    it('должен вернуть true после удаления всех лотов', () => {
      const position = Position.empty('token-123', 'YES');
      const lot = createLot('lot-1', 'token-123', 'YES', 10, 0.60);

      const addResult = position.addLot(lot);
      if (!addResult.ok) throw new Error('Failed to add lot');

      const removeResult = addResult.value.removeLot('lot-1', createQuantity(10));
      if (!removeResult.ok) throw new Error('Failed to remove lot');

      expect(removeResult.value.isEmpty()).toBe(true);
    });
  });

  describe('Position.toString()', () => {
    it('должен создать корректное строковое представление', () => {
      const position = Position.empty('token-123', 'YES');
      const lot1 = createLot('lot-1', 'token-123', 'YES', 10, 0.60);
      const lot2 = createLot('lot-2', 'token-123', 'YES', 5, 0.70);

      const add1 = position.addLot(lot1);
      if (!add1.ok) throw new Error('Failed to add lot1');

      const add2 = add1.value.addLot(lot2);
      if (!add2.ok) throw new Error('Failed to add lot2');

      const str = add2.value.toString();
      expect(str).toContain('token-123');
      expect(str).toContain('YES');
      expect(str).toContain('15'); // total quantity
      expect(str).toContain('2 lots');
    });
  });
});

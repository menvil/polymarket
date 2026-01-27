/**
 * PositionLot entity tests - Result pattern
 *
 * @remarks
 * Comprehensive тесты для PositionLot entity после рефакторинга с Result pattern.
 * Покрывают:
 * - Создание через factory method (create)
 * - Валидацию параметров
 * - Закрытие лота (close)
 * - Расчёт стоимости и P&L
 * - Timestamp immutability
 */
import { describe, it, expect } from '@jest/globals';
import { PositionLot, InsufficientLotQuantityError } from '../../src/PositionLot.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { PositionValidationError } from '@polymarket/errors';

describe('PositionLot Entity (Result pattern)', () => {
  // Helper для создания валидных value objects
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

  describe('PositionLot.create() - успешное создание', () => {
    it('должен создать PositionLot с Date timestamp', () => {
      const timestamp = new Date('2024-01-15T10:00:00Z');
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        timestamp
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const lot = result.value;
        expect(lot.lotId).toBe('lot-1');
        expect(lot.tokenId).toBe('token-123');
        expect(lot.side).toBe('YES');
        expect(lot.quantity.value).toBe(10);
        expect(lot.entryPrice.value).toBe(0.65);
        expect(lot.timestampMs).toBe(timestamp.getTime());
        expect(lot.getTimestamp()).toEqual(timestamp);
      }
    });

    it('должен создать PositionLot с Unix ms timestamp', () => {
      const timestampMs = Date.now();
      const result = PositionLot.create(
        'lot-2',
        'token-456',
        'NO',
        createQuantity(20),
        createPrice(0.35),
        timestampMs
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const lot = result.value;
        expect(lot.timestampMs).toBe(timestampMs);
        expect(lot.getTimestamp().getTime()).toBe(timestampMs);
      }
    });

    it('должен создать лот для YES side', () => {
      const result = PositionLot.create(
        'lot-yes',
        'token-123',
        'YES',
        createQuantity(100),
        createPrice(0.70),
        Date.now()
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('YES');
      }
    });

    it('должен создать лот для NO side', () => {
      const result = PositionLot.create(
        'lot-no',
        'token-123',
        'NO',
        createQuantity(50),
        createPrice(0.30),
        Date.now()
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('NO');
      }
    });
  });

  describe('PositionLot.create() - валидация lotId', () => {
    it('должен вернуть ошибку если lotId пустая строка', () => {
      const result = PositionLot.create(
        '',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PositionValidationError);
        expect(result.error.message).toContain('Lot ID must be a non-empty string');
      }
    });

    it('должен вернуть ошибку если lotId только пробелы', () => {
      const result = PositionLot.create(
        '   ',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PositionValidationError);
      }
    });
  });

  describe('PositionLot.create() - валидация tokenId', () => {
    it('должен вернуть ошибку если tokenId пустая строка', () => {
      const result = PositionLot.create(
        'lot-1',
        '',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PositionValidationError);
        expect(result.error.message).toContain('Token ID must be a non-empty string');
      }
    });

    it('должен вернуть ошибку если tokenId только пробелы', () => {
      const result = PositionLot.create(
        'lot-1',
        '   ',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PositionValidationError);
      }
    });
  });

  describe('PositionLot.create() - валидация quantity', () => {
    it('должен принять нулевое quantity (для закрытых лотов)', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        Quantity.zero(),
        createPrice(0.65),
        Date.now()
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.value).toBe(0);
        expect(result.value.isClosed()).toBe(true);
      }
    });

    it('должен принять минимальное положительное quantity', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(1),
        createPrice(0.65),
        Date.now()
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('PositionLot.getTimestamp() - immutability', () => {
    it('должен возвращать новую копию Date каждый раз', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        new Date('2024-01-15T10:00:00Z')
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const date1 = lot.getTimestamp();
      const date2 = lot.getTimestamp();

      // Разные объекты
      expect(date1).not.toBe(date2);
      // Но равны по значению
      expect(date1.getTime()).toBe(date2.getTime());
      expect(date1.getTime()).toBe(lot.timestampMs);
    });

    it('мутация возвращённого Date не должна влиять на lot', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        new Date('2024-01-15T10:00:00Z')
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const originalMs = lot.timestampMs;
      const date = lot.getTimestamp();

      // Мутируем возвращённый Date
      date.setFullYear(2050);

      // Внутренний timestampMs не изменился
      expect(lot.timestampMs).toBe(originalMs);
      expect(lot.getTimestamp().getFullYear()).toBe(2024);
    });
  });

  describe('PositionLot.calculateCost()', () => {
    it('должен вычислить стоимость лота', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const cost = lot.calculateCost();
      expect(cost.getAmount()).toBe(6.5); // 10 * 0.65
    });

    it('должен вычислить стоимость для большого quantity', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(1000),
        createPrice(0.55),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const cost = lot.calculateCost();
      expect(cost.getAmount()).toBe(550); // 1000 * 0.55
    });
  });

  describe('PositionLot.calculateUnrealizedPnL() - YES side', () => {
    it('должен вычислить прибыль когда цена выросла', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.60),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const pnl = lot.calculateUnrealizedPnL(createPrice(0.70));
      expect(pnl.getAmount()).toBeCloseTo(1.0, 6); // (0.70 - 0.60) * 10
    });

    it('должен вычислить убыток когда цена упала', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.70),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const pnl = lot.calculateUnrealizedPnL(createPrice(0.60));
      expect(pnl.getAmount()).toBeCloseTo(-1.0, 6); // (0.60 - 0.70) * 10
    });

    it('должен вернуть ноль когда цена не изменилась', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const pnl = lot.calculateUnrealizedPnL(createPrice(0.65));
      expect(pnl.getAmount()).toBe(0);
    });
  });

  describe('PositionLot.calculateUnrealizedPnL() - NO side', () => {
    it('должен вычислить прибыль когда цена упала', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'NO',
        createQuantity(10),
        createPrice(0.60),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      // NO token: прибыль когда цена падает
      const pnl = lot.calculateUnrealizedPnL(createPrice(0.50));
      expect(pnl.getAmount()).toBeCloseTo(1.0, 6); // (0.60 - 0.50) * 10
    });

    it('должен вычислить убыток когда цена выросла', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'NO',
        createQuantity(10),
        createPrice(0.40),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      // NO token: убыток когда цена растёт
      const pnl = lot.calculateUnrealizedPnL(createPrice(0.50));
      expect(pnl.getAmount()).toBeCloseTo(-1.0, 6); // (0.40 - 0.50) * 10
    });
  });

  describe('PositionLot.close() - успешное закрытие', () => {
    it('должен закрыть часть лота', () => {
      const createResult = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!createResult.ok) throw new Error('Failed to create lot');
      const lot = createResult.value;

      const closeResult = lot.close(createQuantity(6));
      expect(closeResult.ok).toBe(true);
      if (closeResult.ok) {
        const remaining = closeResult.value;
        expect(remaining.quantity.value).toBe(4);
        expect(remaining.lotId).toBe('lot-1');
        expect(remaining.entryPrice.value).toBe(0.65);
        expect(remaining.isClosed()).toBe(false);
      }
    });

    it('должен закрыть весь лот', () => {
      const createResult = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!createResult.ok) throw new Error('Failed to create lot');
      const lot = createResult.value;

      const closeResult = lot.close(createQuantity(10));
      expect(closeResult.ok).toBe(true);
      if (closeResult.ok) {
        const closed = closeResult.value;
        expect(closed.quantity.value).toBe(0);
        expect(closed.isClosed()).toBe(true);
      }
    });

    it('оригинальный лот должен остаться неизменным (immutability)', () => {
      const createResult = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!createResult.ok) throw new Error('Failed to create lot');
      const lot = createResult.value;

      const closeResult = lot.close(createQuantity(6));
      expect(closeResult.ok).toBe(true);

      // Оригинальный лот не изменился
      expect(lot.quantity.value).toBe(10);
    });
  });

  describe('PositionLot.close() - ошибки', () => {
    it('должен вернуть ошибку если закрываем больше чем есть', () => {
      const createResult = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!createResult.ok) throw new Error('Failed to create lot');
      const lot = createResult.value;

      const closeResult = lot.close(createQuantity(15));
      expect(closeResult.ok).toBe(false);
      if (!closeResult.ok) {
        expect(closeResult.error).toBeInstanceOf(InsufficientLotQuantityError);
        if (closeResult.error instanceof InsufficientLotQuantityError) {
          expect(closeResult.error.requested).toBe(15);
          expect(closeResult.error.available).toBe(10);
        }
      }
    });
  });

  describe('PositionLot.isClosed()', () => {
    it('должен вернуть false для непустого лота', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!result.ok) throw new Error('Failed to create lot');
      expect(result.value.isClosed()).toBe(false);
    });

    it('должен вернуть true для полностью закрытого лота', () => {
      const createResult = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        Date.now()
      );

      if (!createResult.ok) throw new Error('Failed to create lot');

      const closeResult = createResult.value.close(createQuantity(10));
      if (!closeResult.ok) throw new Error('Failed to close lot');

      expect(closeResult.value.isClosed()).toBe(true);
    });
  });

  describe('PositionLot.toString()', () => {
    it('должен создать корректное строковое представление', () => {
      const result = PositionLot.create(
        'lot-1',
        'token-123',
        'YES',
        createQuantity(10),
        createPrice(0.65),
        new Date('2024-01-15T10:00:00Z')
      );

      if (!result.ok) throw new Error('Failed to create lot');
      const lot = result.value;

      const str = lot.toString();
      expect(str).toContain('lot-1');
      expect(str).toContain('10');
      expect(str).toContain('YES');
      expect(str).toContain('0.6500');
      expect(str).toContain('2024-01-15');
    });
  });
});

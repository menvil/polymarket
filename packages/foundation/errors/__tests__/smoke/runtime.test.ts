/**
 * Smoke-тесты для runtime-публикации пакета
 *
 * @remarks
 * Проверяет, что:
 * - Пакет успешно собирается (dist/ существует)
 * - Все публичные экспорты доступны в runtime
 * - Value objects можно создавать и использовать
 * - ErrorUtils работают корректно
 *
 * Этот тест защищает от багов сборки, которые могут сломать
 * опубликованный npm-пакет.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Импорты из исходного кода (для проверки API)
import { TradingError } from '../../src/base/TradingError.js';
import { InvalidPriceError } from '../../src/value-objects/InvalidPriceError.js';
import { InvalidMoneyError } from '../../src/value-objects/InvalidMoneyError.js';
import { InvalidQuantityError } from '../../src/value-objects/InvalidQuantityError.js';
import { InvalidBalanceError } from '../../src/value-objects/InvalidBalanceError.js';
import { ArithmeticOverflowError } from '../../src/value-objects/ArithmeticOverflowError.js';
import { DivisionByZeroError } from '../../src/value-objects/DivisionByZeroError.js';
import {
  toDecimal,
  rewrap,
  wrapOp,
  isExpectedMathError,
} from '../../src/utils/errorUtils.js';
import { ErrorSource } from '../../src/ErrorSource.js';

describe('Runtime Publication Smoke Tests', () => {
  const distPath = resolve(__dirname, '../../dist');

  beforeAll(() => {
    // Убеждаемся, что dist/ существует
    if (!existsSync(distPath)) {
      throw new Error(
        'dist/ folder not found. Run "npm run build" before running smoke tests.'
      );
    }
  });

  describe('Build artifacts', () => {
    it('should have dist/index.js', () => {
      const indexPath = resolve(distPath, 'index.js');
      expect(existsSync(indexPath)).toBe(true);
    });

    it('should have dist/index.d.ts', () => {
      const indexDtsPath = resolve(distPath, 'index.d.ts');
      expect(existsSync(indexDtsPath)).toBe(true);
    });

    it('should have package.json with correct exports', () => {
      const pkgPath = resolve(__dirname, '../../package.json');
      expect(existsSync(pkgPath)).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(pkgPath);
      expect(pkg.main).toBeDefined();
      expect(pkg.types).toBeDefined();
    });
  });

  describe('Public API exports', () => {
    it('should export TradingError base class', () => {
      expect(TradingError).toBeDefined();
      expect(typeof TradingError).toBe('function');
    });

    it('should export all value object errors', () => {
      expect(InvalidMoneyError).toBeDefined();
      expect(InvalidPriceError).toBeDefined();
      expect(InvalidQuantityError).toBeDefined();
      expect(InvalidBalanceError).toBeDefined();
      expect(ArithmeticOverflowError).toBeDefined();
      expect(DivisionByZeroError).toBeDefined();
    });

    it('should export error utils', () => {
      expect(toDecimal).toBeDefined();
      expect(rewrap).toBeDefined();
      expect(wrapOp).toBeDefined();
      expect(isExpectedMathError).toBeDefined();
    });

    it('should export ErrorSource enum', () => {
      expect(ErrorSource).toBeDefined();
      expect(ErrorSource.PARSING).toBeDefined();
      expect(ErrorSource.CORE_INVARIANT).toBeDefined();
      expect(ErrorSource.RULE_VALIDATION).toBeDefined();
    });
  });

  describe('Runtime behavior', () => {
    it('should create InvalidPriceError with correct properties', () => {
      const error = new InvalidPriceError('Price must be positive', {
        code: 'PRICE_NEGATIVE',
        context: {
          source: ErrorSource.CORE_INVARIANT,
          price: '-10',
        },
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TradingError);
      expect(error.message).toBe('Price must be positive');
      expect(error.code).toBe('PRICE_NEGATIVE');
      expect(error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
      expect(error.context?.price).toBe('-10');
    });

    it('should use toDecimal successfully', () => {
      const result = toDecimal(
        'price',
        '123.45',
        'INVALID_FORMAT',
        InvalidPriceError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('123.45');
      }
    });

    it('should use rewrap to preserve error metadata', () => {
      const originalError = new InvalidPriceError('Original error', {
        code: 'PRICE_TOO_HIGH',
        context: { price: '1000' },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        { orderId: 'order-123' },
        originalError,
        InvalidPriceError
      );

      expect(rewrapped.message).toBe('Original error');
      expect(rewrapped.code).toBe('PRICE_TOO_HIGH');
      expect(rewrapped.context?.service).toBe('PriceService');
      expect(rewrapped.context?.op).toBe('validate');
      expect(rewrapped.context?.orderId).toBe('order-123');
      expect(rewrapped.context?.price).toBe('1000');
    });

    it('should use isExpectedMathError correctly', () => {
      const overflowErr = new ArithmeticOverflowError('Overflow', {
        context: {},
      });
      const divZeroErr = new DivisionByZeroError('Division by zero', {
        context: {},
      });
      const priceErr = new InvalidPriceError('Invalid price', {
        context: {},
      });

      expect(isExpectedMathError(overflowErr)).toBe(true);
      expect(isExpectedMathError(divZeroErr)).toBe(true);
      expect(isExpectedMathError(priceErr)).toBe(false);
    });
  });

  describe('Type definitions', () => {
    it('should have .d.ts files for core modules', () => {
      const requiredDts = [
        'index.d.ts',
        'ErrorSource.d.ts',
        'base/TradingError.d.ts',
        'value-objects/InvalidMoneyError.d.ts',
        'value-objects/InvalidPriceError.d.ts',
        'value-objects/InvalidQuantityError.d.ts',
        'utils/errorUtils.d.ts',
      ];

      for (const dtsFile of requiredDts) {
        const dtsPath = resolve(distPath, dtsFile);
        expect(existsSync(dtsPath)).toBe(true);
      }
    });
  });
});

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
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// Импорты из исходного кода (для проверки API)
import { TradingError } from '../../src/base/TradingError.js';
import { InvalidPriceError } from '../../src/value-objects/InvalidPriceError.js';
import { InvalidMoneyError } from '../../src/value-objects/InvalidMoneyError.js';
import { InvalidQuantityError } from '../../src/value-objects/InvalidQuantityError.js';
import { InvalidBalanceError } from '../../src/value-objects/InvalidBalanceError.js';
import { ArithmeticOverflowError } from '../../src/value-objects/ArithmeticOverflowError.js';
import { DivisionByZeroError } from '../../src/value-objects/DivisionByZeroError.js';
import { InvalidRoundingModeError } from '../../src/math/InvalidRoundingModeError.js';
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

  describe('Runtime dist/ validation', () => {
    it('should import main package entrypoint in Node.js runtime', () => {
      // Тест реального импорта пакета (как после npm install)
      const script = `
import('@polymarket/errors')
  .then((mod) => {
    if (!mod.TradingError) throw new Error('TradingError not exported');
    if (!mod.InvalidPriceError) throw new Error('InvalidPriceError not exported');
    if (!mod.ErrorSource) throw new Error('ErrorSource not exported');
    console.log('SUCCESS: @polymarket/errors imports correctly');
    process.exit(0);
  })
  .catch((err) => {
    console.error('IMPORT_ERROR:', err.message);
    process.exit(1);
  });
`;

      const pkgRoot = resolve(__dirname, '../..');
      const testScriptPath = resolve(pkgRoot, '__test_package_import__.mjs');

      try {
        writeFileSync(testScriptPath, script, 'utf-8');

        const result = execSync(`node ${testScriptPath}`, {
          cwd: pkgRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        });

        expect(result).toContain('SUCCESS');
      } finally {
        if (existsSync(testScriptPath)) {
          unlinkSync(testScriptPath);
        }
      }
    });

    it('should import /base subpath export in Node.js runtime', () => {
      // Тест subpath export @polymarket/errors/base
      const script = `
import('@polymarket/errors/base')
  .then((mod) => {
    if (!mod.TradingError) throw new Error('TradingError not exported from /base');
    console.log('SUCCESS: @polymarket/errors/base imports correctly');
    process.exit(0);
  })
  .catch((err) => {
    console.error('IMPORT_ERROR:', err.message);
    process.exit(1);
  });
`;

      const pkgRoot = resolve(__dirname, '../..');
      const testScriptPath = resolve(pkgRoot, '__test_base_import__.mjs');

      try {
        writeFileSync(testScriptPath, script, 'utf-8');

        const result = execSync(`node ${testScriptPath}`, {
          cwd: pkgRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        });

        expect(result).toContain('SUCCESS');
      } finally {
        if (existsSync(testScriptPath)) {
          unlinkSync(testScriptPath);
        }
      }
    });

    it('should import /value-objects subpath export in Node.js runtime', () => {
      // Тест subpath export @polymarket/errors/value-objects
      const script = `
import('@polymarket/errors/value-objects')
  .then((mod) => {
    if (!mod.InvalidPriceError) throw new Error('InvalidPriceError not exported from /value-objects');
    if (!mod.InvalidMoneyError) throw new Error('InvalidMoneyError not exported from /value-objects');
    console.log('SUCCESS: @polymarket/errors/value-objects imports correctly');
    process.exit(0);
  })
  .catch((err) => {
    console.error('IMPORT_ERROR:', err.message);
    process.exit(1);
  });
`;

      const pkgRoot = resolve(__dirname, '../..');
      const testScriptPath = resolve(pkgRoot, '__test_vo_import__.mjs');

      try {
        writeFileSync(testScriptPath, script, 'utf-8');

        const result = execSync(`node ${testScriptPath}`, {
          cwd: pkgRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        });

        expect(result).toContain('SUCCESS');
      } finally {
        if (existsSync(testScriptPath)) {
          unlinkSync(testScriptPath);
        }
      }
    });

    it('should have correct ESM imports with .js extensions in dist/', () => {
      // Проверяем что в dist/ все относительные импорты имеют .js расширения
      const indexPath = resolve(distPath, 'value-objects/InvalidPriceError.js');
      const content = readFileSync(indexPath, 'utf-8');

      // Проверяем что нет импортов вида "from '../base'" (без .js)
      const badImports = content.match(/from ['"]\.\.\/[^'"]+(?<!\.js)['"]/g);
      expect(badImports).toBeNull();

      // Проверяем что есть правильные импорты с .js
      expect(content).toMatch(/from ['"]\.\.\/base\/index\.js['"]/);
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
      expect(InvalidRoundingModeError).toBeDefined();
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

/**
 * Тесты для parsePortfolioId и asPortfolioId
 *
 * @remarks
 * Покрывает:
 * - parsePortfolioId: trim, пустая строка, только пробелы
 * - asPortfolioId: валидная строка, throw на пустых значениях
 */

import { describe, it, expect } from '@jest/globals';
import { parsePortfolioId, asPortfolioId } from '../../../src/value-objects/index.js';

describe('parsePortfolioId()', () => {
  it('возвращает PortfolioId для непустой строки', () => {
    const result = parsePortfolioId('portfolio-abc');
    expect(result).toBe('portfolio-abc');
  });

  it('применяет trim к строке', () => {
    const result = parsePortfolioId('  portfolio-abc  ');
    expect(result).toBe('portfolio-abc');
  });

  it('возвращает undefined для пустой строки', () => {
    expect(parsePortfolioId('')).toBeUndefined();
  });

  it('возвращает undefined для строки из пробелов', () => {
    expect(parsePortfolioId('   ')).toBeUndefined();
  });
});

describe('asPortfolioId()', () => {
  it('возвращает PortfolioId для непустой строки', () => {
    const result = asPortfolioId('portfolio-abc');
    expect(result).toBe('portfolio-abc');
  });

  it('бросает Error при пустой строке', () => {
    expect(() => asPortfolioId('')).toThrow('PortfolioId cannot be empty');
  });

  it('бросает Error при строке из пробелов', () => {
    expect(() => asPortfolioId('   ')).toThrow('PortfolioId cannot be empty');
  });
});

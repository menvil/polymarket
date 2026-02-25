/**
 * Тесты для MarketSlug branded type (URL-safe символы)
 */

import { describe, it, expect } from '@jest/globals';
import { parseMarketSlug } from '../../../src/value-objects/MarketSlug.js';

describe('MarketSlug', () => {
  describe('parseMarketSlug()', () => {
    it('принимает строчные буквы и цифры', () => {
      expect(parseMarketSlug('will-trump-win-2024')).toBe('will-trump-win-2024');
      expect(parseMarketSlug('market123')).toBe('market123');
      expect(parseMarketSlug('abc')).toBe('abc');
    });

    it('принимает одиночный дефис', () => {
      expect(parseMarketSlug('a-b')).toBe('a-b');
    });

    it('отклоняет пустую строку', () => {
      expect(parseMarketSlug('')).toBeUndefined();
    });

    it('отклоняет заглавные буквы', () => {
      expect(parseMarketSlug('UPPER')).toBeUndefined();
      expect(parseMarketSlug('mixedCase')).toBeUndefined();
    });

    it('отклоняет пробелы', () => {
      expect(parseMarketSlug('with space')).toBeUndefined();
    });

    it('отклоняет подчёркивание', () => {
      expect(parseMarketSlug('with_underscore')).toBeUndefined();
    });

    it('отклоняет спецсимволы', () => {
      expect(parseMarketSlug('market?')).toBeUndefined();
      expect(parseMarketSlug('market/path')).toBeUndefined();
    });
  });
});

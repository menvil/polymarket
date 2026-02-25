/**
 * Тесты для MarketId branded type
 */

import { describe, it, expect } from '@jest/globals';
import { parseMarketId, asMarketId } from '../../../src/value-objects/MarketId.js';

describe('MarketId', () => {
  describe('parseMarketId()', () => {
    it('возвращает MarketId для непустой строки', () => {
      const id = parseMarketId('market-abc');
      expect(id).toBe('market-abc');
    });

    it('возвращает undefined для пустой строки', () => {
      expect(parseMarketId('')).toBeUndefined();
    });

    it('возвращает undefined для строки из пробелов', () => {
      expect(parseMarketId('   ')).toBeUndefined();
    });

    it('возвращает undefined для non-string', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parseMarketId(null as any)).toBeUndefined();
    });
  });

  describe('asMarketId()', () => {
    it('возвращает MarketId для валидной строки', () => {
      const id = asMarketId('market-xyz');
      expect(id).toBe('market-xyz');
    });

    it('бросает Error для пустой строки', () => {
      expect(() => asMarketId('')).toThrow(Error);
    });

    it('бросает Error для строки из пробелов', () => {
      expect(() => asMarketId('   ')).toThrow(Error);
    });
  });
});

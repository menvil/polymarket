/**
 * Тесты для MarketId из @polymarket/ids
 *
 * @remarks
 * Проверяет:
 * - asMarketId() возвращает MarketId для валидных строк
 * - asMarketId() возвращает undefined для невалидных строк
 * - unsafeMarketId() возвращает MarketId без проверки
 */

import { describe, it, expect } from '@jest/globals';
import { asMarketId, unsafeMarketId } from '@polymarket/ids';

describe('asMarketId()', () => {
  it('возвращает MarketId для непустой строки', () => {
    const id = asMarketId('market-abc');
    expect(id).toBe('market-abc');
  });

  it('возвращает undefined для пустой строки', () => {
    expect(asMarketId('')).toBeUndefined();
  });

  it('возвращает undefined для строки из пробелов', () => {
    expect(asMarketId('   ')).toBeUndefined();
  });
});

describe('unsafeMarketId()', () => {
  it('возвращает MarketId без проверки', () => {
    const id = unsafeMarketId('market-xyz');
    expect(id).toBe('market-xyz');
  });
});

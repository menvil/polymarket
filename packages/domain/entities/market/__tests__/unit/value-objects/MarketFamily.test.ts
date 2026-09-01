/**
 * Тесты MarketFamily — семейство рынка
 *
 * @remarks
 * Проверяет закрытость множества семейств и runtime-guard, который защищает
 * границу с внешними данными.
 */

import { describe, it, expect } from '@jest/globals';
import {
  MARKET_FAMILY_VALUES,
  isValidMarketFamily,
} from '../../../src/value-objects/MarketFamily.js';

describe('MARKET_FAMILY_VALUES', () => {
  it('содержит единственное поддерживаемое семейство', () => {
    expect(MARKET_FAMILY_VALUES).toEqual(['CRYPTO_UP_DOWN']);
  });
});

describe('isValidMarketFamily()', () => {
  it('принимает известное семейство', () => {
    expect(isValidMarketFamily('CRYPTO_UP_DOWN')).toBe(true);
  });

  it.each([
    ['неизвестное семейство', 'SPORTS'],
    ['пустую строку', ''],
    ['нижний регистр', 'crypto_up_down'],
    ['null', null],
    ['undefined', undefined],
    ['число', 1],
    ['объект', { family: 'CRYPTO_UP_DOWN' }],
  ])('отклоняет %s', (_label, value) => {
    expect(isValidMarketFamily(value)).toBe(false);
  });
});

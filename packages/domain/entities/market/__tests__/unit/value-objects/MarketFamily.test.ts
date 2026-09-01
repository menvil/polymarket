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
  it('содержит оба поддерживаемых семейства', () => {
    expect(MARKET_FAMILY_VALUES).toEqual(['CRYPTO_UP_DOWN', 'BINARY_OUTCOME']);
  });
});

describe('isValidMarketFamily()', () => {
  it.each(['CRYPTO_UP_DOWN', 'BINARY_OUTCOME'])('принимает известное семейство %s', (family) => {
    expect(isValidMarketFamily(family)).toBe(true);
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

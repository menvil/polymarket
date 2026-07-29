import { describe, it, expect } from '@jest/globals';
import { KNOWN_TRIGGER_REASONS } from '../../src/types/TriggerReason.js';

describe('KNOWN_TRIGGER_REASONS', () => {
  it('содержит все известные reasons', () => {
    expect(KNOWN_TRIGGER_REASONS).toEqual([
      'BOOK',
      'TRADE',
      'FILL',
      'ORDER_UPDATE',
      'TIMER',
      'CRYPTO_PRICE',
      'CRYPTO_MARKET_DATA',
    ]);
  });

  it('runtime-immutable — Object.freeze бросает при попытке мутации (strict mode)', () => {
    // Unsafe cast допустим ИСКЛЮЧИТЕЛЬНО здесь — проверка runtime-инварианта,
    // а не production-код: TypeScript readonly не мешает push() без cast.
    expect(() => {
      (KNOWN_TRIGGER_REASONS as unknown as string[]).push('INVALID');
    }).toThrow();
  });

  it('присвоение элемента по индексу тоже бросает', () => {
    expect(() => {
      (KNOWN_TRIGGER_REASONS as unknown as string[])[0] = 'INVALID';
    }).toThrow();
  });
});

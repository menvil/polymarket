import Decimal from 'decimal.js';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { TokenBalanceService } from '../../../../src/token-balance/facade/TokenBalanceService.js';
import { TokenBalance } from '../../../../src/token-balance/core/TokenBalance.js';
import { OutcomeTokenService } from '../../../../src/outcome-token/facade/OutcomeTokenService.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { TokenBalanceErrorReason } from '../../../../src/token-balance/errors/TokenBalanceErrorReason.js';
import { TEST_ACCOUNT_ID, TEST_VENUE_ID } from '../../../helpers/balanceTestHelpers.js';
import type { OnChainConditionRef, ConditionId, WalletAddress, VenueId } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols, KnownChainIds } from '@polymarket/ids';

describe('TokenBalanceService', () => {
  // Фикстуры
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as ConditionId,
  };

  const createTestToken = () => {
    const result = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
    if (!result.ok) throw new Error('Failed to create test token');
    return result.value;
  };

  // Shared balance fixtures (used across multiple test suites)
  const createBalanceAvailable10000Reserved2000 = () => {
    const token = createTestToken();
    const result = TokenBalanceService.create(
      token,
      Quantity.of(new Decimal(10000)),
      Quantity.of(new Decimal(2000)),
      TEST_ACCOUNT_ID,
      TEST_VENUE_ID
    );
    if (!result.ok) throw new Error('Failed to create balance');
    return result.value;
  };

  const createBalanceAvailable7000Reserved5000 = () => {
    const token = createTestToken();
    const result = TokenBalanceService.create(
      token,
      Quantity.of(new Decimal(7000)),
      Quantity.of(new Decimal(5000)),
      TEST_ACCOUNT_ID,
      TEST_VENUE_ID
    );
    if (!result.ok) throw new Error('Failed to create balance');
    return result.value;
  };

  describe('create()', () => {
    describe('успешное создание', () => {
      it('создаёт баланс из token, available и reserved', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(10000);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
          expect(result.value.total().value().toNumber()).toBe(12000);
          expect(result.value.accountId()).toEqual(TEST_ACCOUNT_ID);
          expect(result.value.venueId()).toBe(TEST_VENUE_ID);
        }
      });

      it('создаёт баланс с нулевым reserved', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.hasReserved()).toBe(false);
          expect(result.value.reserved().value().toNumber()).toBe(0);
        }
      });

      it('создаёт пустой баланс', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.ZERO,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      });
    });

    describe('ошибки создания', () => {
      // ПРИМЕЧАНИЕ: Тесты на NEGATIVE_AVAILABLE и NEGATIVE_RESERVED невозможны,
      // так как Quantity.of() бросает исключение для отрицательных значений.
      // Валидация происходит на уровне Quantity, не TokenBalance.

      // ПРИМЕЧАНИЕ: Тесты на NAN и NON_FINITE невозможны,
      // так как Quantity.of() бросает исключение для NaN и Infinity.
      // Валидация происходит на уровне Quantity, не TokenBalance.

      it('возвращает Err для null token', () => {
        const result = TokenBalanceService.create(
          null as any,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_TOKEN);
          expect(result.error.message).toContain('token is required');
        }
      });

      it('возвращает Err для null available', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          null as any,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
          expect(result.error.message).toContain('available is required');
        }
      });

      it('возвращает Err для null reserved', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          null as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
          expect(result.error.message).toContain('reserved is required');
        }
      });

      it('возвращает Err для null accountId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          null as any,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
          expect(result.error.message).toContain('accountId is required');
        }
      });

      it('возвращает Err для null venueId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          null as any
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
          expect(result.error.message).toContain('venueId is required');
        }
      });

      it('возвращает Err для undefined token', () => {
        const result = TokenBalanceService.create(
          undefined as any,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_TOKEN);
        }
      });

      it('возвращает Err для undefined available', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          undefined as any,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        }
      });

      it('возвращает Err для undefined reserved', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          undefined as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        }
      });

      it('возвращает Err для undefined accountId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          undefined as any,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает Err для undefined venueId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          undefined as any
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });
    });

    describe('безопасность (never throws)', () => {
      it('не бросает исключение при null token', () => {
        expect(() => TokenBalanceService.create(
          null as any,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined token', () => {
        expect(() => TokenBalanceService.create(
          undefined as any,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null available', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          null as any,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined available', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          undefined as any,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null reserved', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          null as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined reserved', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          undefined as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null accountId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          null as any,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined accountId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          undefined as any,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null venueId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          null as any
        )).not.toThrow();
      });

      it('не бросает исключение при undefined venueId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          undefined as any
        )).not.toThrow();
      });
    });
  });

  describe('createWithZeroReserved()', () => {
    it('создаёт баланс с нулевым reserved', () => {
      const token = createTestToken();
      const result = TokenBalanceService.createWithZeroReserved(
        token,
        Quantity.of(new Decimal(10000)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.available().value().toNumber()).toBe(10000);
        expect(result.value.reserved().value().toNumber()).toBe(0);
        expect(result.value.total().value().toNumber()).toBe(10000);
        expect(result.value.hasReserved()).toBe(false);
      }
    });

    // ПРИМЕЧАНИЕ: Тест на NEGATIVE_AVAILABLE невозможен,
    // так как Quantity.of() бросает исключение для отрицательных значений.

    describe('валидация инвариантов (null inputs)', () => {
      it('возвращает Err для null token', () => {
        const result = TokenBalanceService.createWithZeroReserved(
          null as any,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_TOKEN);
          expect(result.error.message).toContain('token is required');
        }
      });

      it('возвращает Err для null available', () => {
        const token = createTestToken();
        const result = TokenBalanceService.createWithZeroReserved(
          token,
          null as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
          expect(result.error.message).toContain('available is required');
        }
      });

      it('возвращает Err для null accountId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          null as any,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
          expect(result.error.message).toContain('accountId is required');
        }
      });

      it('возвращает Err для null venueId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          null as any
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
          expect(result.error.message).toContain('venueId is required');
        }
      });

      it('возвращает Err для undefined token', () => {
        const result = TokenBalanceService.createWithZeroReserved(
          undefined as any,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_TOKEN);
        }
      });

      it('возвращает Err для undefined available', () => {
        const token = createTestToken();
        const result = TokenBalanceService.createWithZeroReserved(
          token,
          undefined as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_AMOUNT);
        }
      });

      it('возвращает Err для undefined accountId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          undefined as any,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает Err для undefined venueId', () => {
        const token = createTestToken();
        const result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          undefined as any
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });
    });

    describe('безопасность (never throws)', () => {
      it('не бросает исключение при null token', () => {
        expect(() => TokenBalanceService.createWithZeroReserved(
          null as any,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined token', () => {
        expect(() => TokenBalanceService.createWithZeroReserved(
          undefined as any,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null available', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.createWithZeroReserved(
          token,
          null as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined available', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.createWithZeroReserved(
          token,
          undefined as any,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null accountId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          null as any,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при undefined accountId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          undefined as any,
          TEST_VENUE_ID
        )).not.toThrow();
      });

      it('не бросает исключение при null venueId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          null as any
        )).not.toThrow();
      });

      it('не бросает исключение при undefined venueId', () => {
        const token = createTestToken();
        expect(() => TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          undefined as any
        )).not.toThrow();
      });
    });
  });

  describe('reserve()', () => {
    describe('успешное резервирование', () => {
      it('резервирует токены из available', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(3000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000);
          expect(result.value.reserved().value().toNumber()).toBe(5000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('резервирует все available', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(10000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(0);
          expect(result.value.reserved().value().toNumber()).toBe(12000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(1000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(10000); // оригинал не изменён
          expect(balance.reserved().value().toNumber()).toBe(2000); // оригинал не изменён
        }
      });
    });

    describe('ошибки резервирования', () => {
      it('возвращает ошибку INSUFFICIENT_AVAILABLE', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(15000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('reserve');
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE);
        }
      });

      it('возвращает ошибку для нулевого количества', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.reserve(balance, Quantity.ZERO);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });

      // ПРИМЕЧАНИЕ: Тест на отрицательное количество невозможен,
      // так как Quantity.of() бросает исключение для отрицательных значений.
    });
  });

  describe('unfreezeReserved()', () => {
    describe('успешное освобождение', () => {
      it('освобождает зарезервированные токены', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.unfreezeReserved(balance, Quantity.of(new Decimal(2000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(9000);
          expect(result.value.reserved().value().toNumber()).toBe(3000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('освобождает все reserved', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.unfreezeReserved(balance, Quantity.of(new Decimal(5000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(12000);
          expect(result.value.reserved().value().toNumber()).toBe(0);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.unfreezeReserved(balance, Quantity.of(new Decimal(1000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(7000); // оригинал не изменён
          expect(balance.reserved().value().toNumber()).toBe(5000); // оригинал не изменён
        }
      });
    });

    describe('ошибки освобождения', () => {
      it('возвращает ошибку INSUFFICIENT_RESERVED', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.unfreezeReserved(balance, Quantity.of(new Decimal(10000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('unfreezeReserved');
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_RESERVED);
        }
      });

      it('возвращает ошибку для нулевого количества', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.unfreezeReserved(balance, Quantity.ZERO);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });

      // ПРИМЕЧАНИЕ: Тест на отрицательное количество невозможен,
      // так как Quantity.of() бросает исключение для отрицательных значений.
    });
  });

  describe('consumeReserved()', () => {
    describe('успешное списание', () => {
      it('списывает часть зарезервированных токенов', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.consumeReserved(balance, Quantity.of(new Decimal(2000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000); // available не изменился
          expect(result.value.reserved().value().toNumber()).toBe(3000); // reserved уменьшился
          expect(result.value.total().value().toNumber()).toBe(10000); // total уменьшился
        }
      });

      it('списывает все reserved', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.consumeReserved(balance, Quantity.of(new Decimal(5000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000);
          expect(result.value.reserved().value().toNumber()).toBe(0);
          expect(result.value.total().value().toNumber()).toBe(7000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.consumeReserved(balance, Quantity.of(new Decimal(1000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(7000); // оригинал не изменён
          expect(balance.reserved().value().toNumber()).toBe(5000); // оригинал не изменён
        }
      });

      it('available остаётся неизменным при списании', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const initialAvailable = balance.available().value().toNumber();
        const result = TokenBalanceService.consumeReserved(balance, Quantity.of(new Decimal(3000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(initialAvailable);
        }
      });
    });

    describe('ошибки списания', () => {
      it('возвращает ошибку INSUFFICIENT_RESERVED с контекстом фасада', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.consumeReserved(balance, Quantity.of(new Decimal(10000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('consumeReserved');
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_RESERVED);
          expect(result.error.context).toHaveProperty('token');
          expect(result.error.context).toHaveProperty('available');
          expect(result.error.context).toHaveProperty('reserved');
          expect(result.error.context).toHaveProperty('qty');
        }
      });

      it('возвращает ошибку для нулевого количества', () => {
        const balance = createBalanceAvailable7000Reserved5000();
        const result = TokenBalanceService.consumeReserved(balance, Quantity.ZERO);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        }
      });
    });
  });

  describe('updateAvailable()', () => {
    describe('успешное обновление', () => {
      it('обновляет available, сохраняя reserved', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.updateAvailable(balance, Quantity.of(new Decimal(15000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(15000);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
          expect(result.value.total().value().toNumber()).toBe(17000);
        }
      });

      it('обновляет available на 0', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.updateAvailable(balance, Quantity.ZERO);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(0);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const result = TokenBalanceService.updateAvailable(balance, Quantity.of(new Decimal(20000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(10000); // оригинал не изменён
        }
      });
    });

    describe('ошибки обновления', () => {
      // ПРИМЕЧАНИЕ: Тесты на отрицательный available невозможны,
      // так как Quantity.of() бросает исключение для отрицательных значений.
      // Валидация происходит на уровне Quantity, не TokenBalance.
    });
  });

  describe('canReserve()', () => {
    describe('успешная проверка', () => {
      it('возвращает true если available >= qty', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const canReserve = TokenBalanceService.canReserve(balance, Quantity.of(new Decimal(5000)));

        expect(canReserve).toBe(true);
      });

      it('возвращает true если available === qty (граница)', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const canReserve = TokenBalanceService.canReserve(balance, Quantity.of(new Decimal(10000)));

        expect(canReserve).toBe(true);
      });

      it('возвращает false если available < qty', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const canReserve = TokenBalanceService.canReserve(balance, Quantity.of(new Decimal(15000)));

        expect(canReserve).toBe(false);
      });

      it('возвращает false для нулевого количества (qty must be positive)', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const canReserve = TokenBalanceService.canReserve(balance, Quantity.ZERO);

        expect(canReserve).toBe(false);
      });

      it('возвращает false для пустого баланса с ненулевым количеством', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const canReserve = TokenBalanceService.canReserve(balanceResult.value, Quantity.of(new Decimal(100)));

        expect(canReserve).toBe(false);
      });

      it('не учитывает reserved при проверке (только available)', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(1000)),
          Quantity.of(new Decimal(9000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // total = 10000, но available только 1000
        const canReserve = TokenBalanceService.canReserve(balanceResult.value, Quantity.of(new Decimal(5000)));

        expect(canReserve).toBe(false);
      });
    });

    describe('безопасность (never throws)', () => {
      it('возвращает false для null balance', () => {
        const canReserve = TokenBalanceService.canReserve(null as any, Quantity.of(new Decimal(100)));
        expect(canReserve).toBe(false);
      });

      it('возвращает false для undefined balance', () => {
        const canReserve = TokenBalanceService.canReserve(undefined as any, Quantity.of(new Decimal(100)));
        expect(canReserve).toBe(false);
      });

      it('возвращает false для null qty', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const canReserve = TokenBalanceService.canReserve(balance, null as any);
        expect(canReserve).toBe(false);
      });

      it('возвращает false для undefined qty', () => {
        const balance = createBalanceAvailable10000Reserved2000();
        const canReserve = TokenBalanceService.canReserve(balance, undefined as any);
        expect(canReserve).toBe(false);
      });
    });
  });

  describe('equals()', () => {
    describe('успешное сравнение', () => {
      it('возвращает true для идентичных балансов', () => {
        const token = createTestToken();
        const balance1Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(true);
      });

      it('возвращает false для балансов с разным available', () => {
        const token = createTestToken();
        const balance1Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10001)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(false);
      });

      it('возвращает false для балансов с разным reserved', () => {
        const token = createTestToken();
        const balance1Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2001)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(false);
      });

      it('возвращает true для нулевых балансов', () => {
        const token = createTestToken();
        const balance1Result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(true);
      });

      it('возвращает false для разных токенов', () => {
        const token1Result = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
        const token2Result = OutcomeTokenService.create(testConditionRef, BinaryOutcome.DOWN);
        if (!token1Result.ok || !token2Result.ok) throw new Error('Token creation failed');

        const balance1Result = TokenBalanceService.create(
          token1Result.value,
          Quantity.of(new Decimal(10000)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.create(
          token2Result.value,
          Quantity.of(new Decimal(10000)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(false);
      });

      it('возвращает false для балансов с разным accountId', () => {
        const token = createTestToken();
        const differentAccountId = {
          kind: 'WALLET' as const,
          address: '0x9999999999999999999999999999999999999999' as WalletAddress
        };
        const balance1Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          differentAccountId,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(false);
      });

      it('возвращает false для балансов с разным venueId', () => {
        const token = createTestToken();
        const differentVenueId = 'DIFFERENT_VENUE' as VenueId;
        const balance1Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(10000)),
          Quantity.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          differentVenueId
        );

        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balance1Result.value, balance2Result.value);

        expect(isEqual).toBe(false);
      });
    });

    describe('безопасность (never throws)', () => {
      it('возвращает false для null balance (первый аргумент)', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(null as any, balanceResult.value);
        expect(isEqual).toBe(false);
      });

      it('возвращает false для null balance (второй аргумент)', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balanceResult.value, null as any);
        expect(isEqual).toBe(false);
      });

      it('возвращает false для undefined balance (первый аргумент)', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(undefined as any, balanceResult.value);
        expect(isEqual).toBe(false);
      });

      it('возвращает false для undefined balance (второй аргумент)', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(100)),
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isEqual = TokenBalanceService.equals(balanceResult.value, undefined as any);
        expect(isEqual).toBe(false);
      });
    });
  });

  describe('isZero()', () => {
    describe('успешная проверка', () => {
      it('возвращает true для нулевого баланса', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isZero = TokenBalanceService.isZero(balanceResult.value);
        expect(isZero).toBe(true);
      });

      it('возвращает false для баланса с ненулевым available', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isZero = TokenBalanceService.isZero(balanceResult.value);
        expect(isZero).toBe(false);
      });

      it('возвращает false для баланса с ненулевым reserved', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.ZERO,
          Quantity.of(new Decimal(20)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isZero = TokenBalanceService.isZero(balanceResult.value);
        expect(isZero).toBe(false);
      });
    });

    describe('безопасность (never throws)', () => {
      it('возвращает false для null balance', () => {
        const isZero = TokenBalanceService.isZero(null as any);
        expect(isZero).toBe(false);
      });

      it('возвращает false для undefined balance', () => {
        const isZero = TokenBalanceService.isZero(undefined as any);
        expect(isZero).toBe(false);
      });
    });
  });

  describe('isPositive()', () => {
    describe('успешная проверка', () => {
      it('возвращает true для баланса с положительным available', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(100)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isPositive = TokenBalanceService.isPositive(balanceResult.value);
        expect(isPositive).toBe(true);
      });

      it('возвращает true для баланса с положительным reserved', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.create(
          token,
          Quantity.ZERO,
          Quantity.of(new Decimal(20)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isPositive = TokenBalanceService.isPositive(balanceResult.value);
        expect(isPositive).toBe(true);
      });

      it('возвращает false для нулевого баланса', () => {
        const token = createTestToken();
        const balanceResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.ZERO,
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        const isPositive = TokenBalanceService.isPositive(balanceResult.value);
        expect(isPositive).toBe(false);
      });
    });

    describe('безопасность (never throws)', () => {
      it('возвращает false для null balance', () => {
        const isPositive = TokenBalanceService.isPositive(null as any);
        expect(isPositive).toBe(false);
      });

      it('возвращает false для undefined balance', () => {
        const isPositive = TokenBalanceService.isPositive(undefined as any);
        expect(isPositive).toBe(false);
      });
    });
  });

  describe('Order Lifecycle Scenarios', () => {
    describe('Полный цикл: создание ордера → исполнение → отмена остатка', () => {
      it('резервирование → частичное исполнение → разморозка остатка', () => {
        const token = createTestToken();

        // Шаг 1: Начальный баланс
        const initialResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(10000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!initialResult.ok) throw new Error('Initial balance creation failed');
        const initial = initialResult.value;

        expect(initial.available().value().toNumber()).toBe(10000);
        expect(initial.reserved().value().toNumber()).toBe(0);

        // Шаг 2: Создание ордера - резервируем 5000 токенов
        const afterReserveResult = TokenBalanceService.reserve(initial, Quantity.of(new Decimal(5000)));
        if (!afterReserveResult.ok) throw new Error('Reserve failed');
        const afterReserve = afterReserveResult.value;

        expect(afterReserve.available().value().toNumber()).toBe(5000);
        expect(afterReserve.reserved().value().toNumber()).toBe(5000);

        // Шаг 3: Частичное исполнение - списываем 3000 из reserved
        const afterConsumeResult = TokenBalanceService.consumeReserved(afterReserve, Quantity.of(new Decimal(3000)));
        if (!afterConsumeResult.ok) throw new Error('Consume failed');
        const afterConsume = afterConsumeResult.value;

        expect(afterConsume.available().value().toNumber()).toBe(5000); // available не изменился
        expect(afterConsume.reserved().value().toNumber()).toBe(2000); // осталось 2000

        // Шаг 4: Отмена остатка ордера - размораживаем оставшиеся 2000
        const finalResult = TokenBalanceService.unfreezeReserved(afterConsume, Quantity.of(new Decimal(2000)));
        if (!finalResult.ok) throw new Error('Unfreeze failed');
        const finalBalance = finalResult.value;

        expect(finalBalance.available().value().toNumber()).toBe(7000); // 5000 + 2000
        expect(finalBalance.reserved().value().toNumber()).toBe(0);
        expect(finalBalance.total().value().toNumber()).toBe(7000); // было 10000, списали 3000
      });

      it('резервирование → полное исполнение', () => {
        const token = createTestToken();

        // Шаг 1: Начальный баланс
        const initialResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(10000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!initialResult.ok) throw new Error('Initial balance creation failed');

        // Шаг 2: Резервируем все токены
        const afterReserveResult = TokenBalanceService.reserve(initialResult.value, Quantity.of(new Decimal(10000)));
        if (!afterReserveResult.ok) throw new Error('Reserve failed');

        expect(afterReserveResult.value.available().value().toNumber()).toBe(0);
        expect(afterReserveResult.value.reserved().value().toNumber()).toBe(10000);

        // Шаг 3: Полное исполнение - списываем все reserved
        const finalResult = TokenBalanceService.consumeReserved(afterReserveResult.value, Quantity.of(new Decimal(10000)));
        if (!finalResult.ok) throw new Error('Consume failed');

        expect(finalResult.value.available().value().toNumber()).toBe(0);
        expect(finalResult.value.reserved().value().toNumber()).toBe(0);
        expect(finalResult.value.isZero()).toBe(true);
      });

      it('резервирование → полная отмена (без исполнения)', () => {
        const token = createTestToken();

        // Шаг 1: Начальный баланс
        const initialResult = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(10000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!initialResult.ok) throw new Error('Initial balance creation failed');

        // Шаг 2: Резервируем токены
        const afterReserveResult = TokenBalanceService.reserve(initialResult.value, Quantity.of(new Decimal(5000)));
        if (!afterReserveResult.ok) throw new Error('Reserve failed');

        expect(afterReserveResult.value.available().value().toNumber()).toBe(5000);
        expect(afterReserveResult.value.reserved().value().toNumber()).toBe(5000);

        // Шаг 3: Полная отмена - размораживаем все reserved
        const finalResult = TokenBalanceService.unfreezeReserved(afterReserveResult.value, Quantity.of(new Decimal(5000)));
        if (!finalResult.ok) throw new Error('Unfreeze failed');

        expect(finalResult.value.available().value().toNumber()).toBe(10000);
        expect(finalResult.value.reserved().value().toNumber()).toBe(0);
        expect(finalResult.value.total().value().toNumber()).toBe(10000); // вернулись к начальному
      });
    });

    describe('Множественные ордера', () => {
      it('создание нескольких ордеров последовательно', () => {
        const token = createTestToken();

        // Начальный баланс: 10000 токенов
        const b0Result = TokenBalanceService.createWithZeroReserved(
          token,
          Quantity.of(new Decimal(10000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!b0Result.ok) throw new Error('Initial balance creation failed');

        // Ордер 1: резервируем 3000
        const b1Result = TokenBalanceService.reserve(b0Result.value, Quantity.of(new Decimal(3000)));
        if (!b1Result.ok) throw new Error('Reserve 1 failed');
        expect(b1Result.value.available().value().toNumber()).toBe(7000);
        expect(b1Result.value.reserved().value().toNumber()).toBe(3000);

        // Ордер 2: резервируем еще 2000
        const b2Result = TokenBalanceService.reserve(b1Result.value, Quantity.of(new Decimal(2000)));
        if (!b2Result.ok) throw new Error('Reserve 2 failed');
        expect(b2Result.value.available().value().toNumber()).toBe(5000);
        expect(b2Result.value.reserved().value().toNumber()).toBe(5000);

        // Ордер 3: резервируем еще 1000
        const b3Result = TokenBalanceService.reserve(b2Result.value, Quantity.of(new Decimal(1000)));
        if (!b3Result.ok) throw new Error('Reserve 3 failed');
        expect(b3Result.value.available().value().toNumber()).toBe(4000);
        expect(b3Result.value.reserved().value().toNumber()).toBe(6000);
      });
    });

    describe('Обновление баланса из blockchain', () => {
      it('синхронизация available после внешнего изменения', () => {
        const token = createTestToken();

        // Начальный баланс с зарезервированными токенами
        const initialResult = TokenBalanceService.create(
          token,
          Quantity.of(new Decimal(5000)),
          Quantity.of(new Decimal(3000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!initialResult.ok) throw new Error('Initial balance creation failed');

        // После синхронизации с blockchain available изменился
        const updatedResult = TokenBalanceService.updateAvailable(
          initialResult.value,
          Quantity.of(new Decimal(7000))
        );
        if (!updatedResult.ok) throw new Error('Update failed');

        expect(updatedResult.value.available().value().toNumber()).toBe(7000);
        expect(updatedResult.value.reserved().value().toNumber()).toBe(3000); // reserved не изменился
        expect(updatedResult.value.total().value().toNumber()).toBe(10000);
      });
    });
  });

  describe('Never Throw контракт для null/undefined входов', () => {
    let balance: TokenBalance;
    let qty: Quantity;

    beforeAll(() => {
      const token = createTestToken();
      const testBalance = TokenBalanceService.create(
        token,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(20)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!testBalance.ok) throw new Error('Failed to create test balance');
      balance = testBalance.value;
      qty = Quantity.of(new Decimal(10));
    });

    describe('reserve()', () => {
      it('возвращает Result.Err при null balance', () => {
        const result = TokenBalanceService.reserve(null as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined balance', () => {
        const result = TokenBalanceService.reserve(undefined as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при null qty', () => {
        const result = TokenBalanceService.reserve(balance, null as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined qty', () => {
        const result = TokenBalanceService.reserve(balance, undefined as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('не бросает исключение при null balance и null qty', () => {
        expect(() => TokenBalanceService.reserve(null as any, null as any)).not.toThrow();
      });

      it('не бросает исключение при undefined balance', () => {
        expect(() => TokenBalanceService.reserve(undefined as any, qty)).not.toThrow();
      });

      it('не бросает исключение при undefined qty', () => {
        expect(() => TokenBalanceService.reserve(balance, undefined as any)).not.toThrow();
      });
    });

    describe('unfreezeReserved()', () => {
      it('возвращает Result.Err при null balance', () => {
        const result = TokenBalanceService.unfreezeReserved(null as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined balance', () => {
        const result = TokenBalanceService.unfreezeReserved(undefined as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при null qty', () => {
        const result = TokenBalanceService.unfreezeReserved(balance, null as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined qty', () => {
        const result = TokenBalanceService.unfreezeReserved(balance, undefined as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('не бросает исключение при null balance и null qty', () => {
        expect(() => TokenBalanceService.unfreezeReserved(null as any, null as any)).not.toThrow();
      });

      it('не бросает исключение при undefined balance', () => {
        expect(() => TokenBalanceService.unfreezeReserved(undefined as any, qty)).not.toThrow();
      });

      it('не бросает исключение при undefined qty', () => {
        expect(() => TokenBalanceService.unfreezeReserved(balance, undefined as any)).not.toThrow();
      });
    });

    describe('consumeReserved()', () => {
      it('возвращает Result.Err при null balance', () => {
        const result = TokenBalanceService.consumeReserved(null as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined balance', () => {
        const result = TokenBalanceService.consumeReserved(undefined as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при null qty', () => {
        const result = TokenBalanceService.consumeReserved(balance, null as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined qty', () => {
        const result = TokenBalanceService.consumeReserved(balance, undefined as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('не бросает исключение при null balance и null qty', () => {
        expect(() => TokenBalanceService.consumeReserved(null as any, null as any)).not.toThrow();
      });

      it('не бросает исключение при undefined balance', () => {
        expect(() => TokenBalanceService.consumeReserved(undefined as any, qty)).not.toThrow();
      });

      it('не бросает исключение при undefined qty', () => {
        expect(() => TokenBalanceService.consumeReserved(balance, undefined as any)).not.toThrow();
      });
    });

    describe('updateAvailable()', () => {
      it('возвращает Result.Err при null balance', () => {
        const result = TokenBalanceService.updateAvailable(null as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined balance', () => {
        const result = TokenBalanceService.updateAvailable(undefined as any, qty);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при null newAvailable', () => {
        const result = TokenBalanceService.updateAvailable(balance, null as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('возвращает Result.Err при undefined newAvailable', () => {
        const result = TokenBalanceService.updateAvailable(balance, undefined as any);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('не бросает исключение при null balance и null newAvailable', () => {
        expect(() => TokenBalanceService.updateAvailable(null as any, null as any)).not.toThrow();
      });

      it('не бросает исключение при undefined balance', () => {
        expect(() => TokenBalanceService.updateAvailable(undefined as any, qty)).not.toThrow();
      });

      it('не бросает исключение при undefined newAvailable', () => {
        expect(() => TokenBalanceService.updateAvailable(balance, undefined as any)).not.toThrow();
      });
    });
  });
});

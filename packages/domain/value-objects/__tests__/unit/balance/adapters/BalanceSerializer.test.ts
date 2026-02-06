import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { BalanceSerializer } from '../../../../src/balance/adapters/BalanceSerializer.js';
import { BalanceService } from '../../../../src/balance/facade/BalanceService.js';
import { Money } from '../../../../src/money/core/Money.js';
import { BalanceErrorReason } from '../../../../src/balance/errors/BalanceErrorReason.js';
import { TEST_ACCOUNT_ID, TEST_VENUE_ID } from '../../../helpers/balanceTestHelpers.js';

describe('BalanceSerializer', () => {
  describe('toJSON()', () => {
    it('сериализует баланс в JSON', () => {
      const balanceResult = BalanceService.create(
        Money.of(new Decimal(10000)),
        Money.of(new Decimal(2000)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!balanceResult.ok) fail('Balance creation failed');

      const json = BalanceSerializer.toJSON(balanceResult.value);

      expect(json).toEqual({
        available: { amount: '10000', currency: 'USDC' },
        reserved: { amount: '2000', currency: 'USDC' },
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 'POLYMARKET'
      });
    });

    it('использует string для amount (сохранение точности)', () => {
      const balanceResult = BalanceService.create(
        Money.of(new Decimal(100.123456)),
        Money.of(new Decimal(50.654321)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!balanceResult.ok) fail('Balance creation failed');

      const json = BalanceSerializer.toJSON(balanceResult.value);

      expect(typeof json.available.amount).toBe('string');
      expect(typeof json.reserved.amount).toBe('string');
      expect(json.available.amount).toBe('100.123456');
      expect(json.reserved.amount).toBe('50.654321');
    });

    it('сериализует пустой баланс', () => {
      const balanceResult = BalanceService.create(
        Money.of(new Decimal(0)),
        Money.of(new Decimal(0)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!balanceResult.ok) fail('Balance creation failed');

      const json = BalanceSerializer.toJSON(balanceResult.value);

      expect(json).toEqual({
        available: { amount: '0', currency: 'USDC' },
        reserved: { amount: '0', currency: 'USDC' },
        accountId: 'wallet:0x1234567890123456789012345678901234567890',
        venueId: 'POLYMARKET'
      });
    });
  });

  describe('fromJSON()', () => {
    describe('успешная десериализация', () => {
      it('десериализует баланс из JSON', () => {
        const json = {
          available: { amount: '10000', currency: 'USDC' },
          reserved: { amount: '2000', currency: 'USDC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(10000);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
          expect(result.value.currency()).toBe('USDC');
        }
      });

      it('десериализует с amount как number', () => {
        const json = {
          available: { amount: 10000, currency: 'USDC' },
          reserved: { amount: 2000, currency: 'USDC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(10000);
        }
      });

      it('десериализует пустой баланс', () => {
        const json = {
          available: { amount: '0', currency: 'USDC' },
          reserved: { amount: '0', currency: 'USDC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      });
    });

    describe('структурные ошибки', () => {
      it('возвращает ошибку для null', () => {
        const result = BalanceSerializer.fromJSON(null);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('fromJSON');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает ошибку для массива', () => {
        const result = BalanceSerializer.fromJSON([]);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает ошибку для примитива', () => {
        const result = BalanceSerializer.fromJSON('string');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает ошибку если отсутствует available', () => {
        const json = {
          reserved: { amount: '2000', currency: 'USDC' }
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Missing required field 'available'");
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает ошибку если отсутствует reserved', () => {
        const json = {
          available: { amount: '10000', currency: 'USDC' }
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Missing required field 'reserved'");
        }
      });

      it('возвращает ошибку если available не объект', () => {
        const json = {
          available: 'not-an-object',
          reserved: { amount: '2000', currency: 'USDC' }
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Field 'available' must be an object");
        }
      });

      it('возвращает ошибку если reserved не объект', () => {
        const json = {
          available: { amount: '10000', currency: 'USDC' },
          reserved: 'not-an-object'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Field 'reserved' must be an object");
        }
      });
    });

    describe('бизнес-ошибки валидации', () => {
      it('возвращает ошибку для отрицательного available', () => {
        const json = {
          available: { amount: '-100', currency: 'USDC' },
          reserved: { amount: '0', currency: 'USDC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_AVAILABLE);
        }
      });

      it('возвращает ошибку для отрицательного reserved', () => {
        const json = {
          available: { amount: '10000', currency: 'USDC' },
          reserved: { amount: '-100', currency: 'USDC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_RESERVED);
        }
      });

      it('возвращает ошибку для неподдерживаемой валюты', () => {
        const json = {
          available: { amount: '10000', currency: 'USDC' },
          reserved: { amount: '2000', currency: 'BTC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.UNSUPPORTED_CURRENCY);
        }
      });

      it('возвращает ошибку для невалидного available amount', () => {
        const json = {
          available: { amount: 'invalid', currency: 'USDC' },
          reserved: { amount: '2000', currency: 'USDC' },
          accountId: 'wallet:0x1234567890123456789012345678901234567890',
          venueId: 'POLYMARKET'
        };

        const result = BalanceSerializer.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Failed to deserialize 'available'");
          expect(result.error.context?.field).toBe('available');
        }
      });
    });

    describe('round-trip сериализация', () => {
      it('сохраняет баланс через сериализацию и десериализацию', () => {
        const originalResult = BalanceService.create(
          Money.of(new Decimal(12345.6789)),
          Money.of(new Decimal(9876.5432)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!originalResult.ok) fail('Balance creation failed');

        const json = BalanceSerializer.toJSON(originalResult.value);
        const deserializedResult = BalanceSerializer.fromJSON(json);

        expect(deserializedResult.ok).toBe(true);
        if (deserializedResult.ok) {
          expect(deserializedResult.value.available().value().toNumber())
            .toBe(originalResult.value.available().value().toNumber());
          expect(deserializedResult.value.reserved().value().toNumber())
            .toBe(originalResult.value.reserved().value().toNumber());
        }
      });
    });
  });
});

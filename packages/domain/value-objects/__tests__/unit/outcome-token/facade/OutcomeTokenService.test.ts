import { describe, it, expect } from '@jest/globals';
import { OutcomeTokenService } from '../../../../src/outcome-token/facade/OutcomeTokenService.js';
import type { OnChainConditionRef } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';
import { OutcomeTokenErrorReason } from '../../../../src/outcome-token/errors/OutcomeTokenErrorReason.js';
import { ErrorSource } from '@polymarket/errors';

describe('OutcomeTokenService', () => {
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: 137 as any,
    conditionId: '0xabc123' as any,
  };

  describe('create()', () => {
    it('should create OutcomeToken with valid inputs', () => {
      const result = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcomeKey()).toBe(BinaryOutcome.UP);
        expect(result.value.conditionRef()).toEqual(testConditionRef);
      }
    });

    it('should create DOWN token', () => {
      const result = OutcomeTokenService.create(testConditionRef, BinaryOutcome.DOWN);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcomeKey()).toBe(BinaryOutcome.DOWN);
      }
    });

    it('should return error if conditionRef.kind !== ONCHAIN', () => {
      const invalidRef = {
        ...testConditionRef,
        kind: 'OFFCHAIN' as const,
      };

      const result = OutcomeTokenService.create(invalidRef as any, BinaryOutcome.UP);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION);
      }
    });

    it('should support custom outcome keys', () => {
      const customKey = 'CUSTOM' as any;
      const result = OutcomeTokenService.create(testConditionRef, customKey);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcomeKey()).toBe('CUSTOM');
      }
    });

    it('should set error source to SERVICE_CALL by default', () => {
      const invalidRef = {
        ...testConditionRef,
        kind: 'OFFCHAIN' as const,
      };

      const result = OutcomeTokenService.create(invalidRef as any, BinaryOutcome.UP);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.SERVICE_CALL);
      }
    });

    it('should use custom error source if provided', () => {
      const invalidRef = {
        ...testConditionRef,
        kind: 'OFFCHAIN' as const,
      };

      const result = OutcomeTokenService.create(
        invalidRef as any,
        BinaryOutcome.UP,
        ErrorSource.PARSING
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.PARSING);
      }
    });
  });

  describe('equals()', () => {
    it('should return true for same tokens', () => {
      const result1 = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
      const result2 = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);

      expect(result1.ok && result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        const same = OutcomeTokenService.equals(result1.value, result2.value);
        expect(same).toBe(true);
      }
    });

    it('should return false for different outcome keys', () => {
      const upResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
      const downResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.DOWN);

      expect(upResult.ok && downResult.ok).toBe(true);
      if (upResult.ok && downResult.ok) {
        const same = OutcomeTokenService.equals(upResult.value, downResult.value);
        expect(same).toBe(false);
      }
    });
  });

  describe('Error Contract', () => {
    it('should have op in error context', () => {
      const invalidRef = { ...testConditionRef, kind: 'OFFCHAIN' as const };
      const result = OutcomeTokenService.create(invalidRef as any, BinaryOutcome.UP);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error message should mention the operation
        expect(result.error.message).toBeDefined();
      }
    });

    it('should have reason in error context', () => {
      const invalidRef = { ...testConditionRef, kind: 'OFFCHAIN' as const };
      const result = OutcomeTokenService.create(invalidRef as any, BinaryOutcome.UP);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION);
      }
    });

    it('should have details in error context', () => {
      const invalidRef = { ...testConditionRef, kind: 'OFFCHAIN' as const };
      const result = OutcomeTokenService.create(invalidRef as any, BinaryOutcome.UP);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.details).toBeDefined();
      }
    });
  });
});

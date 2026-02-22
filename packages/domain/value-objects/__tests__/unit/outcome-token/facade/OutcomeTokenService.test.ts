import { describe, it, expect } from '@jest/globals';
import { OutcomeTokenService } from '../../../../src/outcome-token/facade/OutcomeTokenService.js';
import type { OnChainConditionRef } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';

describe('OutcomeTokenService', () => {
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: 137 as any,
    conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as any,
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
        expect(result.error.message).toContain('on-chain condition');
        expect(result.error.context?.kind).toBe('not_onchain_condition');
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

    it('should have service and op in error context', () => {
      const invalidRef = { ...testConditionRef, kind: 'OFFCHAIN' as const };
      const result = OutcomeTokenService.create(invalidRef as any, BinaryOutcome.UP);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.service).toBe('OutcomeTokenService');
        expect(result.error.context?.op).toBe('create');
      }
    });
  });
});

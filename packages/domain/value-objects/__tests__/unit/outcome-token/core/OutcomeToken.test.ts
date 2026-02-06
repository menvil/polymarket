import { describe, it, expect } from '@jest/globals';
import { OutcomeToken, OutcomeTokenInvariantViolation } from '../../../../src/outcome-token/core/index.js';
import type { OnChainConditionRef } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols, unsafeOutcomeKey } from '@polymarket/ids';

describe('OutcomeToken (Core)', () => {
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: 137 as any,
    conditionId: '0xabc123' as any,
  };

  describe('of()', () => {
    it('should create OutcomeToken with valid inputs', () => {
      const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);

      expect(token).toBeDefined();
      expect(token.outcomeKey()).toBe(BinaryOutcome.UP);
      expect(token.conditionRef()).toEqual(testConditionRef);
    });

    it('should create DOWN token', () => {
      const token = OutcomeToken.of(testConditionRef, BinaryOutcome.DOWN);

      expect(token.outcomeKey()).toBe(BinaryOutcome.DOWN);
    });

    it('should create assetId automatically', () => {
      const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
      const assetId = token.assetId();

      expect(assetId.type).toBe('OUTCOME_TOKEN');
      if (assetId.type === 'OUTCOME_TOKEN') {
        expect(assetId.outcomeKey).toBe(BinaryOutcome.UP);
        expect(assetId.conditionRef).toEqual(testConditionRef);
      }
    });

    it('should throw if conditionRef.kind !== ONCHAIN', () => {
      const invalidRef = {
        ...testConditionRef,
        kind: 'OFFCHAIN' as const,
      };

      expect(() => {
        OutcomeToken.of(invalidRef as any, BinaryOutcome.UP);
      }).toThrow(OutcomeTokenInvariantViolation);
    });
  });

  describe('accessors', () => {
    it('should provide conditionRef()', () => {
      const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);

      const ref = token.conditionRef();
      expect(ref.kind).toBe('ONCHAIN');
      expect(ref.protocolId).toBe(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(ref.chainId).toBe(137);
      expect(ref.conditionId).toBe('0xabc123');
    });

    it('should provide outcomeKey()', () => {
      const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);

      expect(token.outcomeKey()).toBe('UP');
    });

    it('should provide assetId()', () => {
      const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);

      const assetId = token.assetId();
      expect(assetId.type).toBe('OUTCOME_TOKEN');
    });
  });

  describe('equals()', () => {
    it('should return true for same tokens', () => {
      const token1 = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
      const token2 = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);

      expect(token1.equals(token2)).toBe(true);
    });

    it('should return false for different outcome keys', () => {
      const upToken = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
      const downToken = OutcomeToken.of(testConditionRef, BinaryOutcome.DOWN);

      expect(upToken.equals(downToken)).toBe(false);
    });

    it('should return false for different conditions', () => {
      const ref1 = testConditionRef;
      const ref2: OnChainConditionRef = {
        ...testConditionRef,
        conditionId: '0xdifferent' as any,
      };

      const token1 = OutcomeToken.of(ref1, BinaryOutcome.UP);
      const token2 = OutcomeToken.of(ref2, BinaryOutcome.UP);

      expect(token1.equals(token2)).toBe(false);
    });
  });

  describe('custom outcome keys', () => {
    it('should support custom outcome keys', () => {
      const customKey = unsafeOutcomeKey('TEAM_A');
      const token = OutcomeToken.of(testConditionRef, customKey);

      expect(token.outcomeKey()).toBe('TEAM_A');
    });
  });
});

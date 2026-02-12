import { describe, it, expect } from '@jest/globals';
import { OutcomeToken } from '../../../../src/outcome-token/core/index.js';
import type { OnChainConditionRef } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';

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
      const customKey = 'TEAM_A' as any;
      const token = OutcomeToken.of(testConditionRef, customKey);

      expect(token.outcomeKey()).toBe('TEAM_A');
    });
  });

  describe('immutability (defensive copy)', () => {
    it('should create frozen copy in fromAssetId() - mutation of input does not affect token', () => {
      // Create mutable AssetId (simulating parseAssetId behavior)
      const mutableAssetId = {
        type: 'OUTCOME_TOKEN' as const,
        conditionRef: {
          kind: 'ONCHAIN' as const,
          protocolId: testConditionRef.protocolId,
          chainId: testConditionRef.chainId,
          conditionId: testConditionRef.conditionId,
        },
        outcomeKey: BinaryOutcome.UP,
      };

      // Create token from mutable AssetId
      const token = OutcomeToken.fromAssetId(mutableAssetId);

      // Mutate input AssetId
      (mutableAssetId.conditionRef as any).chainId = 999;
      (mutableAssetId as any).outcomeKey = 'MUTATED';

      // Token should NOT be affected (defensive copy was made)
      expect(token.conditionRef().chainId).toBe(137);
      expect(token.outcomeKey()).toBe('UP');
    });
  });
});

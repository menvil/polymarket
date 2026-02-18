import { describe, it, expect } from '@jest/globals';
import { OutcomeTokenSerializer } from '../../../../src/outcome-token/adapters/OutcomeTokenSerializer.js';
import { OutcomeTokenService } from '../../../../src/outcome-token/facade/OutcomeTokenService.js';
import type { OnChainConditionRef } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols, parseChainId, parseConditionId } from '@polymarket/ids';

describe('OutcomeTokenSerializer', () => {
  // Валидные тестовые данные (32-byte hex conditionId)
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: parseChainId('137')!,
    conditionId: parseConditionId('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')!,
  };

  describe('toJSON()', () => {
    it('should serialize OutcomeToken to JSON', () => {
      const tokenResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
      expect(tokenResult.ok).toBe(true);

      if (tokenResult.ok) {
        const json = OutcomeTokenSerializer.toJSON(tokenResult.value);

        expect(json.outcomeKey).toBe('UP');
        expect(json.conditionRef.kind).toBe('ONCHAIN');
        expect(json.conditionRef.protocolId).toBe('POLYMARKET_CTF');
        expect(json.conditionRef.chainId).toBe(137);
        expect(json.conditionRef.conditionId).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      }
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize valid JSON', () => {
      const json = {
        conditionRef: {
          kind: 'ONCHAIN' as const,
          protocolId: 'POLYMARKET_CTF',
          chainId: 137,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        outcomeKey: 'UP',
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcomeKey()).toBe('UP');
        expect(result.value.conditionRef().chainId).toBe(137);
      }
    });

    it('should reject null input', () => {
      const result = OutcomeTokenSerializer.fromJSON(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('invalid_json');
      }
    });

    it('should reject missing conditionRef', () => {
      const json = {
        outcomeKey: 'UP',
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('invalid_json');
      }
    });

    it('should reject missing outcomeKey', () => {
      const json = {
        conditionRef: {
          kind: 'ONCHAIN' as const,
          protocolId: 'POLYMARKET_CTF',
          chainId: 137,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('invalid_json');
      }
    });

    it('should reject invalid outcomeKey format', () => {
      const json = {
        conditionRef: {
          kind: 'ONCHAIN' as const,
          protocolId: 'POLYMARKET_CTF',
          chainId: 137,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        outcomeKey: 'INVALID:KEY',
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('invalid_outcome_key');
      }
    });

    it('should reject invalid conditionId format', () => {
      const json = {
        conditionRef: {
          kind: 'ONCHAIN' as const,
          protocolId: 'POLYMARKET_CTF',
          chainId: 137,
          conditionId: 'not-a-hex-condition-id',
        },
        outcomeKey: 'UP',
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('invalid_condition_ref');
      }
    });

    it('should reject invalid chainId (zero)', () => {
      const json = {
        conditionRef: {
          kind: 'ONCHAIN' as const,
          protocolId: 'POLYMARKET_CTF',
          chainId: 0,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        outcomeKey: 'UP',
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('invalid_condition_ref');
      }
    });

    it('should reject OFFCHAIN conditionRef', () => {
      const json = {
        conditionRef: {
          kind: 'OFFCHAIN',
          protocolId: 'POLYMARKET_CTF',
          chainId: 137,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        outcomeKey: 'UP',
      };

      const result = OutcomeTokenSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.kind).toBe('not_onchain_condition');
      }
    });

    it('should support round-trip serialization', () => {
      const tokenResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.DOWN);
      expect(tokenResult.ok).toBe(true);

      if (tokenResult.ok) {
        const json = OutcomeTokenSerializer.toJSON(tokenResult.value);
        const deserializeResult = OutcomeTokenSerializer.fromJSON(json);

        expect(deserializeResult.ok).toBe(true);
        if (deserializeResult.ok) {
          expect(tokenResult.value.equals(deserializeResult.value)).toBe(true);
        }
      }
    });
  });
});

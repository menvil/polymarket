import { describe, it, expect } from '@jest/globals';
import { OutcomeTokenFormatter } from '../../../../src/outcome-token/adapters/OutcomeTokenFormatter.js';
import { OutcomeTokenService } from '../../../../src/outcome-token/facade/OutcomeTokenService.js';
import type { OnChainConditionRef } from '@polymarket/ids';
import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';

describe('OutcomeTokenFormatter', () => {
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: 137 as any,
    conditionId: '0xabc1234567890000000000000000000000000000000000000000000000000000' as any,
  };

  describe('toString()', () => {
    it('should format OutcomeToken as full string', () => {
      const tokenResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
      expect(tokenResult.ok).toBe(true);

      if (tokenResult.ok) {
        const str = OutcomeTokenFormatter.toString(tokenResult.value);

        expect(str).toContain('OUTCOME_TOKEN');
        expect(str).toContain('POLYMARKET_CTF');
        expect(str).toContain('137');
        expect(str).toContain('UP');
      }
    });
  });

  describe('toDisplayString()', () => {
    it('should format OutcomeToken for display', () => {
      const tokenResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
      expect(tokenResult.ok).toBe(true);

      if (tokenResult.ok) {
        const display = OutcomeTokenFormatter.toDisplayString(tokenResult.value);

        expect(display).toContain('UP');
        expect(display).toContain('POLYMARKET_CTF');
        expect(display).toContain('137');
        expect(display).toContain('0xabc1'); // shortened conditionId
      }
    });
  });

  describe('toShortString()', () => {
    it('should format OutcomeToken as short string (just outcome key)', () => {
      const tokenResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.DOWN);
      expect(tokenResult.ok).toBe(true);

      if (tokenResult.ok) {
        const short = OutcomeTokenFormatter.toShortString(tokenResult.value);

        expect(short).toBe('DOWN');
      }
    });
  });

  describe('toVerboseString()', () => {
    it('should format OutcomeToken with full details', () => {
      const tokenResult = OutcomeTokenService.create(testConditionRef, BinaryOutcome.UP);
      expect(tokenResult.ok).toBe(true);

      if (tokenResult.ok) {
        const verbose = OutcomeTokenFormatter.toVerboseString(tokenResult.value);

        expect(verbose).toContain('OutcomeToken');
        expect(verbose).toContain('outcomeKey=UP');
        expect(verbose).toContain('condition=');
        expect(verbose).toContain('POLYMARKET_CTF');
      }
    });
  });
});

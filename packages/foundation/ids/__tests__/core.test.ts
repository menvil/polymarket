import { describe, it, expect } from '@jest/globals';
import {
  type ConditionRef,
  type OutcomeIndex,
  type VenueId,
  OutcomeIndexValues,
  KnownChainIds,
  KnownVenues,
  AssetIdHelpers,
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  outcomeIndexToString,
  parseOutcomeIndex,
  oppositeOutcome,
  assetIdEquals,
  assetIdToString,
} from '../src/index.js';

describe('Core IDs', () => {
  describe('ConditionRef', () => {
    it('should create valid condition ref', () => {
      const conditionRef: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
      };

      expect(conditionRef.protocolId).toBe('POLYMARKET_CTF');
      expect(conditionRef.chainId).toBe(137);
    });

    it('should compare condition refs', () => {
      const ref1: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
      };

      const ref2: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
      };

      const ref3: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xdifferent' as any,
      };

      expect(conditionRefEquals(ref1, ref2)).toBe(true);
      expect(conditionRefEquals(ref1, ref3)).toBe(false);
    });

    it('should convert to string', () => {
      const ref: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
      };

      const str = conditionRefToString(ref);
      expect(str).toBe('POLYMARKET_CTF:137:0xabc123');
    });

    it('should parse from string', () => {
      const str = 'POLYMARKET_CTF:137:0xabc123';
      const ref = parseConditionRef(str);

      expect(ref).toBeDefined();
      expect(ref?.protocolId).toBe('POLYMARKET_CTF');
      expect(ref?.chainId).toBe(137);
      expect(ref?.conditionId).toBe('0xabc123');
    });
  });

  describe('OutcomeIndex', () => {
    it('should have YES and NO constants', () => {
      const yes: OutcomeIndex = OutcomeIndexValues.YES;
      const no: OutcomeIndex = OutcomeIndexValues.NO;

      expect(yes).toBe(1);
      expect(no).toBe(0);
    });

    it('should convert to string', () => {
      expect(outcomeIndexToString(1)).toBe('YES');
      expect(outcomeIndexToString(0)).toBe('NO');
    });

    it('should parse from string', () => {
      expect(parseOutcomeIndex('YES')).toBe(1);
      expect(parseOutcomeIndex('NO')).toBe(0);
      expect(parseOutcomeIndex('yes')).toBe(1);
      expect(parseOutcomeIndex('no')).toBe(0);
      expect(parseOutcomeIndex('1')).toBe(1);
      expect(parseOutcomeIndex('0')).toBe(0);
      expect(parseOutcomeIndex('invalid')).toBeUndefined();
    });

    it('should get opposite outcome', () => {
      expect(oppositeOutcome(1)).toBe(0);
      expect(oppositeOutcome(0)).toBe(1);
    });
  });

  describe('VenueId', () => {
    it('should have known venues', () => {
      const polymarket: VenueId = KnownVenues.POLYMARKET;
      const kalshi: VenueId = KnownVenues.KALSHI;

      expect(polymarket).toBe('POLYMARKET');
      expect(kalshi).toBe('KALSHI');
    });
  });

  describe('AssetId', () => {
    it('should create currency asset', () => {
      const usdc = AssetIdHelpers.USDC;

      expect(usdc.type).toBe('CURRENCY');
      if (usdc.type === 'CURRENCY') {
        expect(usdc.currency).toBe('USDC');
      }
    });

    it('should create outcome token asset', () => {
      const conditionRef: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
      };

      const tokenAsset = AssetIdHelpers.fromOutcomeToken(conditionRef, OutcomeIndexValues.YES);

      expect(tokenAsset.type).toBe('OUTCOME_TOKEN');
      if (tokenAsset.type === 'OUTCOME_TOKEN') {
        expect(tokenAsset.outcomeIndex).toBe(1);
      }
    });

    it('should compare assets', () => {
      const usdc1 = AssetIdHelpers.USDC;
      const usdc2 = AssetIdHelpers.fromCurrency('USDC');
      const usdt = AssetIdHelpers.USDT;

      expect(assetIdEquals(usdc1, usdc2)).toBe(true);
      expect(assetIdEquals(usdc1, usdt)).toBe(false);
    });

    it('should convert to string', () => {
      const usdc = AssetIdHelpers.USDC;
      expect(assetIdToString(usdc)).toBe('CURRENCY:USDC');

      const conditionRef: ConditionRef = {
        protocolId: 'POLYMARKET_CTF',
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
      };
      const token = AssetIdHelpers.fromOutcomeToken(conditionRef, OutcomeIndexValues.YES);
      expect(assetIdToString(token)).toBe('TOKEN:POLYMARKET_CTF:137:0xabc123:1');
    });
  });
});

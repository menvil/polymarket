import { describe, it, expect } from '@jest/globals';
import {
  type AccountId,
  type ConditionRef,
  type OnChainConditionRef,
  type OffChainConditionRef,
  type VenueId,
  KnownChainIds,
  KnownVenues,
  KnownOnChainProtocols,
  isKnownVenue,
  asVenueId,
  isKnownOnChainProtocol,
  asOnChainProtocolId,
  AssetIdHelpers,
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  assetIdEquals,
  assetIdToString,
  parseAssetId,
  parseOutcomeKey,
  BinaryOutcome,
  outcomeKeyToIndex,
  indexToOutcomeKey,
  outcomeKeyEquals,
  oppositeOutcomeKey,
  normalizeCurrency,
  asSupportedCurrency,
  currencyEquals,
  isValidChainId,
  chainId,
  parseChainId,
  isValidConditionId,
  parseConditionId,
  normalizeConditionId,
  parseWalletAddress,
  walletAddressEquals,
  walletAddressToString,
  accountIdFromWallet,
  accountIdFromVenue,
  accountIdForSubaccount,
  accountIdToString,
  parseAccountId,
  accountIdEquals,
  isWalletAccount,
  isVenueAccount,
  isSubaccount,
  getSubaccountDepth,
} from '../src/index.js';

describe('Core IDs', () => {
  describe('ConditionRef', () => {
    describe('OnChainConditionRef', () => {
      it('should create valid on-chain condition ref', () => {
        const conditionRef: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        expect(conditionRef.kind).toBe('ONCHAIN');
        if (conditionRef.kind === 'ONCHAIN') {
          expect(conditionRef.protocolId).toBe('POLYMARKET_CTF');
          expect(conditionRef.chainId).toBe(137);
        }
      });

      it('should compare on-chain condition refs', () => {
        const ref1: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const ref2: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const ref3: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as any,
        };

        expect(conditionRefEquals(ref1, ref2)).toBe(true);
        expect(conditionRefEquals(ref1, ref3)).toBe(false);
      });

      it('should convert on-chain ref to string', () => {
        const ref: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const str = conditionRefToString(ref);
        expect(str).toBe('ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      });

      it('should parse on-chain ref from string', () => {
        const str = 'ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const ref = parseConditionRef(str);

        expect(ref).toBeDefined();
        expect(ref?.kind).toBe('ONCHAIN');
        if (ref?.kind === 'ONCHAIN') {
          expect(ref.protocolId).toBe('POLYMARKET_CTF');
          expect(ref.chainId).toBe(137);
          expect(ref.conditionId).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        }
      });
    });

    describe('OffChainConditionRef', () => {
      it('should create valid off-chain condition ref', () => {
        const conditionRef: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'KXBTCUSDM-24APR',
        };

        expect(conditionRef.kind).toBe('OFFCHAIN');
        if (conditionRef.kind === 'OFFCHAIN') {
          expect(conditionRef.venueId).toBe('KALSHI');
          expect(conditionRef.marketId).toBe('KXBTCUSDM-24APR');
        }
      });

      it('should compare off-chain condition refs', () => {
        const ref1: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'KXBTCUSDM-24APR',
        };

        const ref2: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'KXBTCUSDM-24APR',
        };

        const ref3: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'DIFFERENT-MARKET',
        };

        expect(conditionRefEquals(ref1, ref2)).toBe(true);
        expect(conditionRefEquals(ref1, ref3)).toBe(false);
      });

      it('should convert off-chain ref to string', () => {
        const ref: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'KXBTCUSDM-24APR',
        };

        const str = conditionRefToString(ref);
        expect(str).toBe('OFFCHAIN:KALSHI:KXBTCUSDM-24APR');
      });

      it('should parse off-chain ref from string', () => {
        const str = 'OFFCHAIN:KALSHI:KXBTCUSDM-24APR';
        const ref = parseConditionRef(str);

        expect(ref).toBeDefined();
        expect(ref?.kind).toBe('OFFCHAIN');
        if (ref?.kind === 'OFFCHAIN') {
          expect(ref.venueId).toBe('KALSHI');
          expect(ref.marketId).toBe('KXBTCUSDM-24APR');
        }
      });
    });

    describe('Mixed comparisons', () => {
      it('should return false when comparing on-chain and off-chain refs', () => {
        const onChain: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const offChain: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'KXBTCUSDM-24APR',
        };

        expect(conditionRefEquals(onChain, offChain)).toBe(false);
      });
    });

    describe('parseConditionRef validation', () => {
      describe('ONCHAIN validation', () => {
        it('should accept valid ONCHAIN ref', () => {
          const ref = parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          expect(ref).toBeDefined();
          expect(ref?.kind).toBe('ONCHAIN');
          if (ref?.kind === 'ONCHAIN') {
            expect(ref.protocolId).toBe('POLYMARKET_CTF');
            expect(ref.chainId).toBe(137);
            expect(ref.conditionId).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          }
        });

        it('should reject invalid ChainId - parseInt bypass', () => {
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137abc:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137.5:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:-1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:0:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
        });

        it('should accept custom OnChainProtocolId with valid format', () => {
          // Custom protocols с валидным форматом должны приниматься
          const customProto1 = parseConditionRef('ONCHAIN:CUSTOM_PROTOCOL:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          expect(customProto1).toBeDefined();
          expect(customProto1?.kind).toBe('ONCHAIN');
          if (customProto1?.kind === 'ONCHAIN') {
            expect(customProto1.protocolId).toBe('CUSTOM_PROTOCOL');
          }

          const customProto2 = parseConditionRef('ONCHAIN:MY_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          expect(customProto2).toBeDefined();
          expect(customProto2?.kind).toBe('ONCHAIN');
          if (customProto2?.kind === 'ONCHAIN') {
            expect(customProto2.protocolId).toBe('MY_CTF');
          }
        });

        it('should reject invalid OnChainProtocolId format', () => {
          // Lowercase (невалидный формат)
          expect(parseConditionRef('ONCHAIN:custom_protocol:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
          // Содержит дефис
          expect(parseConditionRef('ONCHAIN:CUSTOM-PROTOCOL:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
          // Начинается с цифры
          expect(parseConditionRef('ONCHAIN:123PROTOCOL:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
        });

        it('should reject invalid ConditionId format', () => {
          // Не hex формат
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:not-hex')).toBeUndefined();
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:abc123')).toBeUndefined(); // нет 0x
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xGGGGGG')).toBeUndefined(); // не hex символы

          // Слишком короткий
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xabc')).toBeUndefined();

          // Пустой
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:')).toBeUndefined();
        });

        it('should support round-trip for valid ONCHAIN ref', () => {
          const original: OnChainConditionRef = {
            kind: 'ONCHAIN',
            protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
            chainId: KnownChainIds.POLYGON,
            conditionId: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as any,
          };

          const str = conditionRefToString(original);
          const parsed = parseConditionRef(str);

          expect(parsed).toBeDefined();
          expect(conditionRefEquals(original, parsed!)).toBe(true);
        });
      });

      describe('OFFCHAIN validation', () => {
        it('should accept valid OFFCHAIN ref', () => {
          const ref = parseConditionRef('OFFCHAIN:KALSHI:KXBTCUSDM-24APR');
          expect(ref).toBeDefined();
          expect(ref?.kind).toBe('OFFCHAIN');
          if (ref?.kind === 'OFFCHAIN') {
            expect(ref.venueId).toBe('KALSHI');
            expect(ref.marketId).toBe('KXBTCUSDM-24APR');
          }
        });

        it('should accept PREDICTIT with numeric marketId', () => {
          const ref = parseConditionRef('OFFCHAIN:KALSHI:7456');
          expect(ref).toBeDefined();
          if (ref?.kind === 'OFFCHAIN') {
            expect(ref.marketId).toBe('7456');
          }
        });

        it('should reject invalid VenueId format', () => {
          // Lowercase (не uppercase)
          expect(parseConditionRef('OFFCHAIN:fake:MARKET123')).toBeUndefined();
          expect(parseConditionRef('OFFCHAIN:lowercase:MARKET123')).toBeUndefined();

          // Содержит дефис (не UPPER_SNAKE_CASE)
          expect(parseConditionRef('OFFCHAIN:MY-VENUE:MARKET123')).toBeUndefined();

          // Начинается с цифры
          expect(parseConditionRef('OFFCHAIN:123VENUE:MARKET123')).toBeUndefined();

          // Пустой
          expect(parseConditionRef('OFFCHAIN::MARKET123')).toBeUndefined();
        });

        it('should reject empty marketId', () => {
          expect(parseConditionRef('OFFCHAIN:KALSHI:')).toBeUndefined();
        });

        it('should reject marketId containing colon (breaks round-trip)', () => {
          expect(parseConditionRef('OFFCHAIN:KALSHI:MARKET:WITH:COLON')).toBeUndefined();
        });

        it('should support round-trip for valid OFFCHAIN ref', () => {
          const original: OffChainConditionRef = {
            kind: 'OFFCHAIN',
            venueId: KnownVenues.KALSHI,
            marketId: 'KXBTCUSDM-24APR',
          };

          const str = conditionRefToString(original);
          const parsed = parseConditionRef(str);

          expect(parsed).toBeDefined();
          expect(conditionRefEquals(original, parsed!)).toBe(true);
        });
      });
    });
  });

  describe('VenueId', () => {
    it('should have known venues', () => {
      const polymarket: VenueId = KnownVenues.POLYMARKET;
      const kalshi: VenueId = KnownVenues.KALSHI;

      expect(polymarket).toBe('POLYMARKET');
      expect(kalshi).toBe('KALSHI');
    });

    it('should validate known venues', () => {
      expect(isKnownVenue('POLYMARKET')).toBe(true);
      expect(isKnownVenue('KALSHI')).toBe(true);
      expect(isKnownVenue('CUSTOM_VENUE')).toBe(false);
      expect(isKnownVenue('invalid')).toBe(false);
    });

    it('should parse valid venue ids', () => {
      expect(asVenueId('POLYMARKET')).toBe('POLYMARKET');
      expect(asVenueId('KALSHI')).toBe('KALSHI');
      expect(asVenueId('MY_CUSTOM_VENUE')).toBe('MY_CUSTOM_VENUE');
      expect(asVenueId('VENUE_123')).toBe('VENUE_123');
    });

    it('should reject invalid venue formats', () => {
      expect(asVenueId('invalid-venue')).toBeUndefined(); // дефис
      expect(asVenueId('123VENUE')).toBeUndefined(); // начинается с цифры
      expect(asVenueId('')).toBeUndefined(); // пустая строка
      expect(asVenueId('has:colon')).toBeUndefined(); // двоеточие
      expect(asVenueId('has\\backslash')).toBeUndefined(); // backslash
      expect(asVenueId('lowercase')).toBeUndefined(); // lowercase
      expect(asVenueId('A'.repeat(33))).toBeUndefined(); // слишком длинная (>32)
    });
  });

  describe('OnChainProtocolId', () => {
    it('should have known protocols', () => {
      const polymarket = KnownOnChainProtocols.POLYMARKET_CTF;
      const uma = KnownOnChainProtocols.UMA_CTF;
      const gnosis = KnownOnChainProtocols.GNOSIS_CTF;

      expect(polymarket).toBe('POLYMARKET_CTF');
      expect(uma).toBe('UMA_CTF');
      expect(gnosis).toBe('GNOSIS_CTF');
    });

    it('should validate known protocols', () => {
      expect(isKnownOnChainProtocol('POLYMARKET_CTF')).toBe(true);
      expect(isKnownOnChainProtocol('UMA_CTF')).toBe(true);
      expect(isKnownOnChainProtocol('GNOSIS_CTF')).toBe(true);
      expect(isKnownOnChainProtocol('CUSTOM_PROTO')).toBe(false);
      expect(isKnownOnChainProtocol('invalid')).toBe(false);
    });

    it('should parse valid protocol ids', () => {
      expect(asOnChainProtocolId('POLYMARKET_CTF')).toBe('POLYMARKET_CTF');
      expect(asOnChainProtocolId('UMA_CTF')).toBe('UMA_CTF');
      expect(asOnChainProtocolId('CUSTOM_PROTO')).toBe('CUSTOM_PROTO');
      expect(asOnChainProtocolId('MY_CTF_123')).toBe('MY_CTF_123');
    });

    it('should reject invalid protocol formats', () => {
      expect(asOnChainProtocolId('invalid-proto')).toBeUndefined(); // дефис
      expect(asOnChainProtocolId('123PROTO')).toBeUndefined(); // начинается с цифры
      expect(asOnChainProtocolId('')).toBeUndefined(); // пустая строка
      expect(asOnChainProtocolId('has:colon')).toBeUndefined(); // двоеточие
      expect(asOnChainProtocolId('has\\backslash')).toBeUndefined(); // backslash
      expect(asOnChainProtocolId('lowercase')).toBeUndefined(); // lowercase
      expect(asOnChainProtocolId('A'.repeat(33))).toBeUndefined(); // слишком длинная (>32)
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
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };

      const tokenAsset = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);

      expect(tokenAsset.type).toBe('OUTCOME_TOKEN');
      if (tokenAsset.type === 'OUTCOME_TOKEN') {
        expect(tokenAsset.outcomeKey).toBe(BinaryOutcome.UP);
        expect(tokenAsset.conditionRef.kind).toBe('ONCHAIN');
      }
    });

    it('should compare assets', () => {
      const usdc1 = AssetIdHelpers.USDC;
      const usdc2 = AssetIdHelpers.fromCurrency('USDC');

      // Different asset types should not be equal
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };
      const tokenAsset = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);

      expect(assetIdEquals(usdc1, usdc2)).toBe(true);
      expect(assetIdEquals(usdc1, tokenAsset)).toBe(false);
    });

    it('should convert to string', () => {
      const usdc = AssetIdHelpers.USDC;
      expect(assetIdToString(usdc)).toBe('CURRENCY:USDC');

      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };
      const token = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      expect(assetIdToString(token)).toBe('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
    });

    it('should parse AssetId from string', () => {
      // Parse CURRENCY
      const usdc = parseAssetId('CURRENCY:USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.type).toBe('CURRENCY');
      if (usdc?.type === 'CURRENCY') {
        expect(usdc.currency).toBe('USDC');
      }

      // Parse OUTCOME_TOKEN
      const token = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
      expect(token).toBeDefined();
      expect(token?.type).toBe('OUTCOME_TOKEN');
      if (token?.type === 'OUTCOME_TOKEN') {
        expect(token.outcomeKey).toBe(BinaryOutcome.UP);
        expect(token.conditionRef.kind).toBe('ONCHAIN');
        expect(token.conditionRef.protocolId).toBe('POLYMARKET_CTF');
        expect(token.conditionRef.chainId).toBe(137);
        expect(token.conditionRef.conditionId).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      }

      // Invalid formats
      expect(parseAssetId('INVALID:FORMAT')).toBeUndefined();
      expect(parseAssetId('CURRENCY:UNKNOWN_CURRENCY')).toBeUndefined();
      expect(parseAssetId('OUTCOME_TOKEN:INVALID')).toBeUndefined();
    });

    describe('parseAssetId validation', () => {
      it('should reject invalid ChainId - parseInt bypass', () => {
        // parseInt("137abc", 10) возвращает 137, но мы должны это отклонить
        const invalid1 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137abc:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(invalid1).toBeUndefined();

        // Нечисловая строка
        const invalid2 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:abc:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(invalid2).toBeUndefined();

        // Отрицательное число
        const invalid3 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:-1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(invalid3).toBeUndefined();

        // Дробное число
        const invalid4 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137.5:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(invalid4).toBeUndefined();
      });

      it('should accept custom OnChainProtocolId with valid format', () => {
        // Custom protocol с валидным форматом
        const customAsset = parseAssetId('OUTCOME_TOKEN:ONCHAIN:CUSTOM_PROTOCOL:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(customAsset).toBeDefined();
        expect(customAsset?.type).toBe('OUTCOME_TOKEN');
        if (customAsset?.type === 'OUTCOME_TOKEN') {
          expect(customAsset.conditionRef.protocolId).toBe('CUSTOM_PROTOCOL');
        }
      });

      it('should reject invalid OnChainProtocolId format', () => {
        // Lowercase (невалидный формат)
        const invalid1 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:custom_protocol:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(invalid1).toBeUndefined();

        // Содержит дефис
        const invalid2 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:CUSTOM-PROTOCOL:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(invalid2).toBeUndefined();
      });

      it('should reject invalid ConditionId', () => {
        // Без 0x префикса
        const invalid1 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:abc123:UP');
        expect(invalid1).toBeUndefined();

        // Не hex символы
        const invalid2 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xGGGGGG:UP');
        expect(invalid2).toBeUndefined();

        // Слишком короткий
        const invalid3 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc:UP');
        expect(invalid3).toBeUndefined();

        // Пустой
        const invalid4 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137::UP');
        expect(invalid4).toBeUndefined();
      });

      it('should reject invalid OutcomeKey', () => {
        // Пустой OutcomeKey
        const invalid1 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:');
        expect(invalid1).toBeUndefined();

        // OutcomeKey с двоеточием
        const invalid2 = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP:DOWN');
        expect(invalid2).toBeUndefined();

        // OutcomeKey слишком длинный (>32 символов)
        const tooLong = 'A'.repeat(33);
        const invalid3 = parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${tooLong}`);
        expect(invalid3).toBeUndefined();
      });

      it('should accept valid OUTCOME_TOKEN with all fields validated', () => {
        const valid = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');
        expect(valid).toBeDefined();
        expect(valid?.type).toBe('OUTCOME_TOKEN');
        if (valid?.type === 'OUTCOME_TOKEN') {
          expect(valid.conditionRef.protocolId).toBe('POLYMARKET_CTF');
          expect(valid.conditionRef.chainId).toBe(137);
          expect(valid.conditionRef.conditionId).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          expect(valid.outcomeKey).toBe('UP');
        }
      });
    });

    it('should support round-trip serialization', () => {
      // CURRENCY round-trip
      const usdc = AssetIdHelpers.USDC;
      const usdcStr = assetIdToString(usdc);
      const usdcParsed = parseAssetId(usdcStr);
      expect(assetIdEquals(usdc, usdcParsed!)).toBe(true);

      // OUTCOME_TOKEN round-trip
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };
      const token = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.DOWN);
      const tokenStr = assetIdToString(token);
      const tokenParsed = parseAssetId(tokenStr);
      expect(assetIdEquals(token, tokenParsed!)).toBe(true);
    });
  });

  describe('OutcomeKey', () => {
    it('should have binary outcome constants', () => {
      expect(BinaryOutcome.UP).toBe('UP');
      expect(BinaryOutcome.DOWN).toBe('DOWN');
    });

    it('should convert outcome key to index', () => {
      expect(outcomeKeyToIndex(BinaryOutcome.DOWN)).toBe(0);
      expect(outcomeKeyToIndex(BinaryOutcome.UP)).toBe(1);
      // Unknown outcome key (не UP/DOWN)
      const unknownKey = parseOutcomeKey('UNKNOWN');
      expect(outcomeKeyToIndex(unknownKey!)).toBeUndefined();
    });

    it('should convert index to outcome key', () => {
      expect(indexToOutcomeKey(0)).toBe(BinaryOutcome.DOWN);
      expect(indexToOutcomeKey(1)).toBe(BinaryOutcome.UP);
      expect(indexToOutcomeKey(2)).toBeUndefined();
    });

    it('should compare outcome keys', () => {
      const up1 = BinaryOutcome.UP;
      const up2 = parseOutcomeKey('UP')!;
      const down = BinaryOutcome.DOWN;

      expect(outcomeKeyEquals(up1, up2)).toBe(true);
      expect(outcomeKeyEquals(up1, down)).toBe(false);
    });

    it('should get opposite outcome for binary', () => {
      expect(oppositeOutcomeKey(BinaryOutcome.UP)).toBe(BinaryOutcome.DOWN);
      expect(oppositeOutcomeKey(BinaryOutcome.DOWN)).toBe(BinaryOutcome.UP);
      // Custom outcome key (не binary)
      const customKey = parseOutcomeKey('CUSTOM')!;
      expect(oppositeOutcomeKey(customKey)).toBeUndefined();
    });

    it('should support round-trip conversion', () => {
      // DOWN: key -> index -> key
      const downIndex = outcomeKeyToIndex(BinaryOutcome.DOWN);
      expect(downIndex).toBe(0);
      expect(indexToOutcomeKey(downIndex!)).toBe(BinaryOutcome.DOWN);

      // UP: key -> index -> key
      const upIndex = outcomeKeyToIndex(BinaryOutcome.UP);
      expect(upIndex).toBe(1);
      expect(indexToOutcomeKey(upIndex!)).toBe(BinaryOutcome.UP);
    });

    describe('parseOutcomeKey validation', () => {
      it('should accept valid outcome keys', () => {
        expect(parseOutcomeKey('UP')).toBe('UP');
        expect(parseOutcomeKey('DOWN')).toBe('DOWN');
        expect(parseOutcomeKey('TEAM_A')).toBe('TEAM_A');
        expect(parseOutcomeKey('OPTION_1')).toBe('OPTION_1');
        expect(parseOutcomeKey('A')).toBe('A');
        expect(parseOutcomeKey('A'.repeat(32))).toBe('A'.repeat(32)); // max length
      });

      it('should reject empty string', () => {
        expect(parseOutcomeKey('')).toBeUndefined();
      });

      it('should reject too long strings', () => {
        const tooLong = 'A'.repeat(33); // max = 32
        expect(parseOutcomeKey(tooLong)).toBeUndefined();
      });

      it('should reject strings containing colon', () => {
        expect(parseOutcomeKey('UP:DOWN')).toBeUndefined();
        expect(parseOutcomeKey('TEAM:A')).toBeUndefined();
        expect(parseOutcomeKey(':UP')).toBeUndefined();
        expect(parseOutcomeKey('UP:')).toBeUndefined();
      });

      it('should reject strings containing backslash', () => {
        expect(parseOutcomeKey('UP\\DOWN')).toBeUndefined();
        expect(parseOutcomeKey('TEAM\\A')).toBeUndefined();
        expect(parseOutcomeKey('\\UP')).toBeUndefined();
        expect(parseOutcomeKey('UP\\')).toBeUndefined();
        expect(parseOutcomeKey('key\\value')).toBeUndefined();
      });
    });
  });

  describe('Currency', () => {
    it('should normalize currency code', () => {
      expect(normalizeCurrency('usdc')).toBe('USDC');
      expect(normalizeCurrency(' USDC ')).toBe('USDC');
      expect(normalizeCurrency('UsD c')).toBe('USD C');
      expect(normalizeCurrency('USDC')).toBe('USDC');
    });

    it('should validate and convert to SupportedCurrency', () => {
      expect(asSupportedCurrency('usdc')).toBe('USDC');
      expect(asSupportedCurrency('USDC')).toBe('USDC');
      expect(asSupportedCurrency(' USDC ')).toBe('USDC');
      expect(asSupportedCurrency('UNKNOWN')).toBeUndefined();
      expect(asSupportedCurrency('btc')).toBeUndefined();
    });

    it('should compare currency codes case-insensitively', () => {
      expect(currencyEquals('USDC', 'usdc')).toBe(true);
      expect(currencyEquals('USDC', 'USDC')).toBe(true);
      expect(currencyEquals(' USDC ', 'USDC')).toBe(true);
      expect(currencyEquals('USDC', 'USDT')).toBe(false);
    });
  });

  describe('ChainId', () => {
    describe('isValidChainId', () => {
      it('should accept valid chain IDs', () => {
        expect(isValidChainId(1)).toBe(true); // Ethereum
        expect(isValidChainId(137)).toBe(true); // Polygon
        expect(isValidChainId(8453)).toBe(true); // Base
        expect(isValidChainId(999999)).toBe(true); // Arbitrary valid ID
      });

      it('should reject zero', () => {
        expect(isValidChainId(0)).toBe(false);
      });

      it('should reject negative numbers', () => {
        expect(isValidChainId(-1)).toBe(false);
        expect(isValidChainId(-137)).toBe(false);
      });

      it('should reject floats', () => {
        expect(isValidChainId(3.14)).toBe(false);
        expect(isValidChainId(137.5)).toBe(false);
      });

      it('should reject NaN', () => {
        expect(isValidChainId(NaN)).toBe(false);
      });

      it('should reject Infinity', () => {
        expect(isValidChainId(Infinity)).toBe(false);
        expect(isValidChainId(-Infinity)).toBe(false);
      });

      it('should reject unsafe integers', () => {
        expect(isValidChainId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
      });
    });

    describe('chainId factory', () => {
      it('should create ChainId from valid numbers', () => {
        const polygon = chainId(137);
        expect(polygon).toBe(137);

        const ethereum = chainId(1);
        expect(ethereum).toBe(1);
      });

      it('should return undefined for invalid numbers', () => {
        expect(chainId(0)).toBeUndefined();
        expect(chainId(-1)).toBeUndefined();
        expect(chainId(3.14)).toBeUndefined();
        expect(chainId(NaN)).toBeUndefined();
        expect(chainId(Infinity)).toBeUndefined();
      });
    });

    describe('parseChainId', () => {
      it('should parse valid chain ID strings', () => {
        expect(parseChainId('1')).toBe(1); // Ethereum
        expect(parseChainId('137')).toBe(137); // Polygon
        expect(parseChainId('8453')).toBe(8453); // Base
        expect(parseChainId('999999')).toBe(999999);
      });

      it('should reject zero string', () => {
        expect(parseChainId('0')).toBeUndefined();
      });

      it('should reject negative number strings', () => {
        expect(parseChainId('-1')).toBeUndefined();
        expect(parseChainId('-137')).toBeUndefined();
      });

      it('should reject float strings', () => {
        expect(parseChainId('3.14')).toBeUndefined();
        expect(parseChainId('137.5')).toBeUndefined();
      });

      it('should reject strings with non-digit characters', () => {
        expect(parseChainId('137abc')).toBeUndefined(); // parseInt bypass
        expect(parseChainId('abc')).toBeUndefined();
        expect(parseChainId('abc137')).toBeUndefined();
      });

      it('should reject empty string', () => {
        expect(parseChainId('')).toBeUndefined();
      });

      it('should reject strings with whitespace', () => {
        expect(parseChainId(' 137')).toBeUndefined();
        expect(parseChainId('137 ')).toBeUndefined();
        expect(parseChainId(' 137 ')).toBeUndefined();
      });

      it('should reject hex format', () => {
        expect(parseChainId('0x89')).toBeUndefined(); // Polygon в hex
        expect(parseChainId('0x1')).toBeUndefined();
      });

      it('should reject special values', () => {
        expect(parseChainId('NaN')).toBeUndefined();
        expect(parseChainId('Infinity')).toBeUndefined();
      });
    });
  });

  describe('ConditionId', () => {
    describe('isValidConditionId', () => {
      it('should accept valid 32-byte hex hash', () => {
        const validHash = '0x' + 'a'.repeat(64);
        expect(isValidConditionId(validHash)).toBe(true);

        const validHashUpper = '0x' + 'A'.repeat(64);
        expect(isValidConditionId(validHashUpper)).toBe(true);

        const validHashMixed = '0x' + 'AbCd'.repeat(16);
        expect(isValidConditionId(validHashMixed)).toBe(true);
      });

      it('should reject hash shorter than 32 bytes', () => {
        expect(isValidConditionId('0x' + 'a'.repeat(63))).toBe(false); // 63 символа
        expect(isValidConditionId('0x12345678')).toBe(false); // 8 символов
        expect(isValidConditionId('0x' + 'a'.repeat(10))).toBe(false); // 10 символов
      });

      it('should reject hash longer than 32 bytes', () => {
        expect(isValidConditionId('0x' + 'a'.repeat(65))).toBe(false);
        expect(isValidConditionId('0x' + 'a'.repeat(100))).toBe(false);
      });

      it('should reject non-hex characters', () => {
        expect(isValidConditionId('0x' + 'G'.repeat(64))).toBe(false);
        expect(isValidConditionId('0x' + 'z'.repeat(64))).toBe(false);
        expect(isValidConditionId('0x' + 'a'.repeat(63) + 'G')).toBe(false);
      });

      it('should reject missing 0x prefix', () => {
        expect(isValidConditionId('a'.repeat(64))).toBe(false);
        expect(isValidConditionId('abc123')).toBe(false);
      });

      it('should reject empty string', () => {
        expect(isValidConditionId('')).toBe(false);
      });
    });

    describe('parseConditionId', () => {
      it('should parse and normalize valid hash to lowercase', () => {
        const upperHash = '0x' + 'ABCD'.repeat(16);
        const parsed = parseConditionId(upperHash);

        expect(parsed).toBeDefined();
        expect(parsed).toBe('0x' + 'abcd'.repeat(16));
      });

      it('should parse lowercase hash', () => {
        const lowerHash = '0x' + 'abcd'.repeat(16);
        const parsed = parseConditionId(lowerHash);

        expect(parsed).toBeDefined();
        expect(parsed).toBe(lowerHash);
      });

      it('should parse mixed case hash and normalize', () => {
        const mixedHash = '0x' + 'AbCd'.repeat(16);
        const parsed = parseConditionId(mixedHash);

        expect(parsed).toBeDefined();
        expect(parsed).toBe('0x' + 'abcd'.repeat(16));
      });

      it('should reject invalid formats', () => {
        expect(parseConditionId('0x12345678')).toBeUndefined(); // too short
        expect(parseConditionId('0x' + 'a'.repeat(65))).toBeUndefined(); // too long
        expect(parseConditionId('0x' + 'G'.repeat(64))).toBeUndefined(); // non-hex
        expect(parseConditionId('garbage')).toBeUndefined(); // garbage
        expect(parseConditionId('')).toBeUndefined(); // empty
      });

      it('should support round-trip', () => {
        const original = '0x' + 'AbCdEf12'.repeat(8);
        const parsed = parseConditionId(original);
        const parsedAgain = parseConditionId(parsed!);

        expect(parsed).toBeDefined();
        expect(parsedAgain).toBe(parsed);
      });
    });

    describe('normalizeConditionId', () => {
      it('should normalize to lowercase', () => {
        const upperHash = ('0x' + 'ABCD'.repeat(16)) as any;
        const normalized = normalizeConditionId(upperHash);

        expect(normalized).toBe('0x' + 'abcd'.repeat(16));
      });

      it('should keep lowercase unchanged', () => {
        const lowerHash = ('0x' + 'abcd'.repeat(16)) as any;
        const normalized = normalizeConditionId(lowerHash);

        expect(normalized).toBe(lowerHash);
      });
    });
  });

  describe('WalletAddress', () => {
    const testAddr = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';

    it('should parse valid wallet address', () => {
      const wallet = parseWalletAddress(testAddr);
      expect(wallet).toBeDefined();
      expect(wallet).toBe(testAddr); // lowercase canonical

      // Parse mixed case
      const mixedCase = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
      expect(mixedCase).toBe(testAddr); // normalized to lowercase
    });

    it('should reject invalid wallet addresses', () => {
      expect(parseWalletAddress('invalid')).toBeUndefined();
      expect(parseWalletAddress('0x123')).toBeUndefined(); // too short
      expect(parseWalletAddress('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBeUndefined(); // no 0x
      expect(parseWalletAddress('0xINVALID0000000000000000000000000000000')).toBeUndefined(); // invalid hex
    });

    it('should compare addresses case-insensitively', () => {
      const addr1 = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
      const addr2 = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;

      expect(walletAddressEquals(addr1, addr2)).toBe(true);
    });

    it('should convert to canonical string', () => {
      const wallet = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;
      const str = walletAddressToString(wallet);

      expect(str).toBe(testAddr); // lowercase canonical
    });

    it('should support round-trip: parse -> lowercase -> parse', () => {
      const wallet = parseWalletAddress(testAddr)!;
      const canonical = walletAddressToString(wallet);
      const parsed = parseWalletAddress(canonical)!;

      expect(walletAddressEquals(wallet, parsed)).toBe(true);
      expect(parsed).toBe(canonical);
    });
  });

  describe('AccountId', () => {
    const testWallet = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;

    it('should create wallet account', () => {
      const accountId = accountIdFromWallet(testWallet);

      expect(accountId.kind).toBe('WALLET');
      expect(isWalletAccount(accountId)).toBe(true);
      if (accountId.kind === 'WALLET') {
        expect(accountId.address).toBe(testWallet);
      }
    });

    it('should create venue account', () => {
      const accountId = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');

      expect(accountId.kind).toBe('VENUE');
      expect(isVenueAccount(accountId)).toBe(true);
      if (accountId.kind === 'VENUE') {
        expect(accountId.venueId).toBe('POLYMARKET');
        expect(accountId.userId).toBe('user_123');
      }
    });

    it('should create subaccount', () => {
      const baseAccount = accountIdFromWallet(testWallet);
      const result = accountIdForSubaccount(baseAccount, 'trading');

      expect(result.ok).toBe(true);
      if (result.ok) {
        const subaccount = result.value;
        expect(subaccount.kind).toBe('SUBACCOUNT');
        expect(isSubaccount(subaccount)).toBe(true);
        if (subaccount.kind === 'SUBACCOUNT') {
          expect(subaccount.base).toEqual(baseAccount);
          expect(subaccount.name).toBe('trading');
        }
      }
    });

    it('should convert to string', () => {
      // Wallet account
      const walletAcc = accountIdFromWallet(testWallet);
      expect(accountIdToString(walletAcc)).toBe(`wallet:${testWallet}`);

      // Venue account
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
      expect(accountIdToString(venueAcc)).toBe('venue:POLYMARKET:user_123');

      // Subaccount
      const subResult = accountIdForSubaccount(walletAcc, 'trading');
      expect(subResult.ok).toBe(true);
      if (subResult.ok) {
        expect(accountIdToString(subResult.value)).toBe(`sub:wallet:${testWallet}:trading`);
      }
    });

    it('should escape colons in userId and name', () => {
      // Venue account with colon in userId
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
      expect(accountIdToString(venueAcc)).toBe('venue:POLYMARKET:user\\:123');

      // Subaccount with colon in name
      const walletAcc = accountIdFromWallet(testWallet);
      const subResult = accountIdForSubaccount(walletAcc, 'strategy:main');
      expect(subResult.ok).toBe(true);
      if (subResult.ok) {
        expect(accountIdToString(subResult.value)).toContain('strategy\\:main');
      }
    });

    it('should parse AccountId from string', () => {
      // Parse wallet account
      const walletStr = `wallet:${testWallet}`;
      const walletAcc = parseAccountId(walletStr);
      expect(walletAcc).toBeDefined();
      expect(walletAcc?.kind).toBe('WALLET');

      // Parse venue account
      const venueStr = 'venue:POLYMARKET:user_123';
      const venueAcc = parseAccountId(venueStr);
      expect(venueAcc).toBeDefined();
      expect(venueAcc?.kind).toBe('VENUE');
      if (venueAcc?.kind === 'VENUE') {
        expect(venueAcc.venueId).toBe('POLYMARKET');
        expect(venueAcc.userId).toBe('user_123');
      }

      // Parse subaccount
      const subStr = `sub:wallet:${testWallet}:trading`;
      const subAcc = parseAccountId(subStr);
      expect(subAcc).toBeDefined();
      expect(subAcc?.kind).toBe('SUBACCOUNT');
      if (subAcc?.kind === 'SUBACCOUNT') {
        expect(subAcc.name).toBe('trading');
        expect(subAcc.base.kind).toBe('WALLET');
      }

      // Invalid formats
      expect(parseAccountId('INVALID')).toBeUndefined();
      expect(parseAccountId('wallet')).toBeUndefined();
    });

    it('should parse escaped colons', () => {
      // Venue account with escaped colon
      const venueStr = 'venue:POLYMARKET:user\\:123';
      const venueAcc = parseAccountId(venueStr);
      expect(venueAcc).toBeDefined();
      if (venueAcc?.kind === 'VENUE') {
        expect(venueAcc.userId).toBe('user:123'); // unescaped
      }
    });

    it('should support round-trip serialization', () => {
      // Wallet account
      const walletAcc = accountIdFromWallet(testWallet);
      const walletStr = accountIdToString(walletAcc);
      const walletParsed = parseAccountId(walletStr);
      expect(accountIdEquals(walletAcc, walletParsed!)).toBe(true);

      // Venue account
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
      const venueStr = accountIdToString(venueAcc);
      const venueParsed = parseAccountId(venueStr);
      expect(accountIdEquals(venueAcc, venueParsed!)).toBe(true);

      // Subaccount
      const subResult = accountIdForSubaccount(walletAcc, 'strategy:main');
      expect(subResult.ok).toBe(true);
      if (subResult.ok) {
        const subStr = accountIdToString(subResult.value);
        const subParsed = parseAccountId(subStr);
        expect(accountIdEquals(subResult.value, subParsed!)).toBe(true);
      }
    });

    it('should compare AccountIds', () => {
      // Same wallet accounts (case-insensitive)
      const addr1 = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;
      const addr2 = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
      const acc1 = accountIdFromWallet(addr1);
      const acc2 = accountIdFromWallet(addr2);
      expect(accountIdEquals(acc1, acc2)).toBe(true);

      // Same venue accounts
      const venue1 = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
      const venue2 = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
      expect(accountIdEquals(venue1, venue2)).toBe(true);

      // Different accounts
      const walletAcc = accountIdFromWallet(testWallet);
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
      expect(accountIdEquals(walletAcc, venueAcc)).toBe(false);
    });

    it('should support nested subaccounts', () => {
      const walletAcc = accountIdFromWallet(testWallet);
      const subResult1 = accountIdForSubaccount(walletAcc, 'main');
      expect(subResult1.ok).toBe(true);
      if (!subResult1.ok) return;

      const subResult2 = accountIdForSubaccount(subResult1.value, 'strategy_a');
      expect(subResult2.ok).toBe(true);
      if (!subResult2.ok) return;

      const str = accountIdToString(subResult2.value);
      expect(str).toContain('sub:sub:wallet');

      const parsed = parseAccountId(str);
      expect(accountIdEquals(subResult2.value, parsed!)).toBe(true);
    });

    it('should use type guards correctly', () => {
      const walletAcc = accountIdFromWallet(testWallet);
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
      const subResult = accountIdForSubaccount(walletAcc, 'trading');
      expect(subResult.ok).toBe(true);
      if (!subResult.ok) return;

      const subAcc = subResult.value;

      expect(isWalletAccount(walletAcc)).toBe(true);
      expect(isWalletAccount(venueAcc)).toBe(false);
      expect(isWalletAccount(subAcc)).toBe(false);

      expect(isVenueAccount(venueAcc)).toBe(true);
      expect(isVenueAccount(walletAcc)).toBe(false);

      expect(isSubaccount(subAcc)).toBe(true);
      expect(isSubaccount(walletAcc)).toBe(false);
    });

    describe('Escaping fixes', () => {
      it('should handle backslashes in round-trip', () => {
        // Строка с backslash и colon
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user\\:123');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('user\\:123'); // round-trip сохраняет backslash
        }
      });

      it('should handle double backslashes', () => {
        // Строка с двойным backslash
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'name\\\\with\\\\slashes');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('name\\\\with\\\\slashes');
        }
      });

      it('should handle empty strings', () => {
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, '');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('');
        }
      });

      it('should handle only colon', () => {
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, ':');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe(':');
        }
      });

      it('should handle only backslash', () => {
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, '\\');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('\\');
        }
      });

      it('should handle complex escaped sequences', () => {
        // Комплексная строка с различными escape-последовательностями
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'a]\\\\:b');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('a]\\\\:b');
        }
      });

      it('should handle user\\:123 (backslash + colon)', () => {
        // Буквально "user\:123" (backslash перед двоеточием)
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user\\:123');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('user\\:123');
        }
      });

      it('should handle user\\\\:123 (double backslash + colon)', () => {
        // Буквально "user\\:123" (двойной backslash + двоеточие)
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user\\\\:123');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('user\\\\:123');
        }
      });

      it('should handle a\\b (backslash between letters)', () => {
        // Буквально "a\b"
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'a\\b');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('a\\b');
        }
      });

      it('should handle path\\to\\file (multiple backslashes)', () => {
        // Путь с backslashes
        const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'path\\to\\file');
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe('path\\to\\file');
        }
      });
    });

    describe('Depth limit protection', () => {
      it('should calculate subaccount depth correctly', () => {
        const walletAcc = accountIdFromWallet(testWallet);
        expect(getSubaccountDepth(walletAcc)).toBe(0);

        const result1 = accountIdForSubaccount(walletAcc, 'level1');
        expect(result1.ok).toBe(true);
        if (!result1.ok) return;
        expect(getSubaccountDepth(result1.value)).toBe(1);

        const result2 = accountIdForSubaccount(result1.value, 'level2');
        expect(result2.ok).toBe(true);
        if (!result2.ok) return;
        expect(getSubaccountDepth(result2.value)).toBe(2);

        const result3 = accountIdForSubaccount(result2.value, 'level3');
        expect(result3.ok).toBe(true);
        if (!result3.ok) return;
        expect(getSubaccountDepth(result3.value)).toBe(3);
      });

      it('should return Err when creating subaccount exceeds depth limit', () => {
        const walletAcc = accountIdFromWallet(testWallet);

        // Создаём цепочку глубиной 5 (максимум)
        let current: AccountId = walletAcc;
        for (let i = 1; i <= 5; i++) {
          const result = accountIdForSubaccount(current, `level${i}`);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          current = result.value;
        }

        expect(getSubaccountDepth(current)).toBe(5);

        // Попытка создать ещё один уровень должна вернуть Err
        const tooDeepResult = accountIdForSubaccount(current, 'tooDeep');
        expect(tooDeepResult.ok).toBe(false);
        if (!tooDeepResult.ok) {
          expect(tooDeepResult.error).toBeInstanceOf(Error);
          expect(tooDeepResult.error.message).toMatch(/depth limit exceeded/i);
        }
      });

      it('should serialize max depth subaccount', () => {
        const walletAcc = accountIdFromWallet(testWallet);

        // Создаём структуру глубиной 5
        let current: AccountId = walletAcc;
        for (let i = 1; i <= 5; i++) {
          const result = accountIdForSubaccount(current, `level${i}`);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          current = result.value;
        }

        // Сериализация должна работать для глубины 5 (тотальная функция)
        const str = accountIdToString(current);
        expect(str).toContain('sub:sub:sub:sub:sub:wallet');
      });

      it('should return undefined when parsing deeply nested string', () => {
        // Строка с глубиной вложенности 6 (превышает лимит 5)
        const deepStr = `sub:sub:sub:sub:sub:sub:wallet:${testWallet}:a:b:c:d:e:f`;

        const parsed = parseAccountId(deepStr);
        expect(parsed).toBeUndefined(); // должно вернуть undefined из-за превышения depth limit
      });

      it('should return undefined when parsing with custom maxDepth', () => {
        const str = `sub:sub:wallet:${testWallet}:a:b`; // глубина 2

        // С maxDepth=1 должно вернуть undefined
        const parsed = parseAccountId(str, { maxDepth: 1 });
        expect(parsed).toBeUndefined();

        // С maxDepth=2 должно распарситься
        const parsed2 = parseAccountId(str, { maxDepth: 2 });
        expect(parsed2).toBeDefined();
      });

      it('should return false when comparing deeply nested subaccounts', () => {
        const walletAcc = accountIdFromWallet(testWallet);

        // Создаём структуру глубиной 5
        let acc1: AccountId = walletAcc;
        for (let i = 1; i <= 5; i++) {
          const result = accountIdForSubaccount(acc1, `level${i}`);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          acc1 = result.value;
        }

        let acc2: AccountId = walletAcc;
        for (let i = 1; i <= 5; i++) {
          const result = accountIdForSubaccount(acc2, `level${i}`);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          acc2 = result.value;
        }

        // Сравнение должно работать для глубины 5
        expect(accountIdEquals(acc1, acc2)).toBe(true);

        // Для проверки fallback на false при превышении лимита
        // создаём структуру вручную (обходя защиту)
        const veryDeep1 = {
          kind: 'SUBACCOUNT' as const,
          base: {
            kind: 'SUBACCOUNT' as const,
            base: {
              kind: 'SUBACCOUNT' as const,
              base: {
                kind: 'SUBACCOUNT' as const,
                base: {
                  kind: 'SUBACCOUNT' as const,
                  base: {
                    kind: 'SUBACCOUNT' as const,
                    base: walletAcc,
                    name: 'level6',
                  },
                  name: 'level5',
                },
                name: 'level4',
              },
              name: 'level3',
            },
            name: 'level2',
          },
          name: 'level1',
        };

        // Сравнение должно вернуть false (безопасный fallback)
        expect(accountIdEquals(veryDeep1, veryDeep1)).toBe(false);
      });
    });

    describe('Max length protection', () => {
      it('should return undefined for very long strings', () => {
        // Создаём строку длиннее 512 символов
        const longStr = 'wallet:' + '0'.repeat(600);

        const parsed = parseAccountId(longStr);
        expect(parsed).toBeUndefined();
      });

      it('should parse strings within limit', () => {
        // Строка близко к лимиту, но в пределах
        const normalStr = `wallet:${testWallet}`;

        const parsed = parseAccountId(normalStr);
        expect(parsed).toBeDefined();
      });

      it('should respect custom maxLen', () => {
        const str = `wallet:${testWallet}`;

        // С maxLen=10 должно вернуть undefined (строка длиннее)
        const parsed1 = parseAccountId(str, { maxLen: 10 });
        expect(parsed1).toBeUndefined();

        // С maxLen=1000 должно распарситься
        const parsed2 = parseAccountId(str, { maxLen: 1000 });
        expect(parsed2).toBeDefined();
      });
    });

    describe('WalletAddress validation', () => {
      it('should validate wallet address with custom validator', () => {
        // Валидатор, который принимает только адреса с '0xabc' в начале
        const validator = (raw: string) => {
          return raw.toLowerCase().startsWith('0xabc') ? (raw as any) : undefined;
        };

        // Невалидный адрес
        const invalidStr = `wallet:${testWallet}`;
        const parsed1 = parseAccountId(invalidStr, { validateWalletAddress: validator });
        expect(parsed1).toBeUndefined();

        // Валидный адрес (начинается с 0xabc для custom validator)
        const validStr = 'wallet:0xabc0000000000000000000000000000000000000';
        const parsed2 = parseAccountId(validStr, { validateWalletAddress: validator });
        expect(parsed2).toBeDefined();
      });

      it('should reject invalid wallet address with default validator', () => {
        // Дефолтная валидация через parseWalletAddress - отклоняет невалидные адреса
        const invalidStr = 'wallet:INVALID_ADDRESS';
        const parsed = parseAccountId(invalidStr);

        expect(parsed).toBeUndefined(); // должно вернуть undefined
      });

      it('should accept valid wallet address with default validator', () => {
        // Дефолтная валидация принимает валидные адреса
        const validAddr = '0x1234567890123456789012345678901234567890';
        const validStr = `wallet:${validAddr}`;
        const parsed = parseAccountId(validStr);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'WALLET') {
          expect(parsed.address).toBe(validAddr.toLowerCase()); // lowercase canonical
        }
      });

      it('should validate real wallet addresses', () => {
        // Валидатор с реальной проверкой формата Ethereum адреса
        const validator = (raw: string) => {
          const valid = /^0x[0-9a-f]{40}$/i.test(raw);
          return valid ? (raw.toLowerCase() as any) : undefined;
        };

        const validStr = `wallet:${testWallet}`;
        const parsed1 = parseAccountId(validStr, { validateWalletAddress: validator });
        expect(parsed1).toBeDefined();

        const invalidStr = 'wallet:0xINVALID';
        const parsed2 = parseAccountId(invalidStr, { validateWalletAddress: validator });
        expect(parsed2).toBeUndefined();
      });
    });

    describe('VenueId validation', () => {
      it('should accept valid known venues', () => {
        const str = 'venue:POLYMARKET:user_123';
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.venueId).toBe('POLYMARKET');
        }
      });

      it('should accept valid custom venues', () => {
        const str = 'venue:MY_CUSTOM_VENUE:user_123';
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.venueId).toBe('MY_CUSTOM_VENUE');
        }
      });

      it('should reject invalid venue format (lowercase)', () => {
        const str = 'venue:polymarket:user_123';
        const parsed = parseAccountId(str);

        expect(parsed).toBeUndefined(); // lowercase не валидно
      });

      it('should reject invalid venue format (special chars)', () => {
        const str = 'venue:POLY-MARKET:user_123';
        const parsed = parseAccountId(str);

        expect(parsed).toBeUndefined(); // дефис не валиден
      });

      it('should reject invalid venue format (starts with digit)', () => {
        const str = 'venue:123VENUE:user_123';
        const parsed = parseAccountId(str);

        expect(parsed).toBeUndefined(); // не может начинаться с цифры
      });

      it('should reject empty venue', () => {
        const str = 'venue::user_123';
        const parsed = parseAccountId(str);

        expect(parsed).toBeUndefined(); // пустой venue
      });
    });
  });
});

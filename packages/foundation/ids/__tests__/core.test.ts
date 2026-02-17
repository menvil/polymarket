import { describe, it, expect, jest } from '@jest/globals';
import { validateBrandedId } from '../src/core/utils/validateBrandedId.js';
import {
  KnownMarketDataSources,
  isKnownMarketDataSource,
  sourceToVenue,
  isLiveSource,
  isReplaySource,
} from '../src/market-data/index.js';
import {
  type AccountId,
  type AssetId,
  type ConditionRef,
  type OnChainConditionRef,
  type OffChainConditionRef,
  type VenueId,
  type ConditionId,
  type OutcomeKey,
  KnownChainIds,
  KnownVenues,
  KnownOnChainProtocols,
  isKnownVenue,
  asVenueId,
  isKnownOnChainProtocol,
  asOnChainProtocolId,
  AssetIdHelpers,
  AssetIdValidationError,
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  isOnChainConditionRef,
  isOffChainConditionRef,
  assetIdToString,
  parseAssetId,
  isCurrencyAsset,
  isOutcomeTokenAsset,
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
  getChainName,
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
  AccountIdDepthError,
} from '../src/index.js';

// Helper для unwrap Result в тестах
function unwrapVenue(venueId: VenueId, userId: string): AccountId {
  const result = accountIdFromVenue(venueId, userId);
  if (!result.ok) {
    throw new Error(`Failed to create venue account: ${result.error.message}`);
  }
  return result.value;
}

// Helper для unwrap fromOutcomeToken Result в тестах
function unwrapToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): AssetId {
  const result = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
  if (!result.ok) {
    throw new Error(`Failed to create outcome token: ${result.error.message}`);
  }
  return result.value;
}

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

      it('should handle marketId with colons and backslashes (round-trip)', () => {
        // marketId содержащий и ':' и '\'
        const ref: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'market:with\\colon:and\\\\backslash',
        };

        // Сериализация
        const str = conditionRefToString(ref);
        expect(str).toContain('OFFCHAIN:KALSHI:');

        // Парсинг обратно
        const parsed = parseConditionRef(str);
        expect(parsed).toBeDefined();
        expect(parsed?.kind).toBe('OFFCHAIN');

        if (parsed?.kind === 'OFFCHAIN') {
          expect(parsed.venueId).toBe('KALSHI');
          // Проверяем что marketId сохранился точно
          expect(parsed.marketId).toBe('market:with\\colon:and\\\\backslash');
        }

        // Проверяем что refs равны
        expect(conditionRefEquals(ref, parsed!)).toBe(true);
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

    describe('parseConditionRef non-string input guard', () => {
      it('should return undefined for null input (not throw)', () => {
        expect(parseConditionRef(null as any)).toBeUndefined();
      });

      it('should return undefined for undefined input (not throw)', () => {
        expect(parseConditionRef(undefined as any)).toBeUndefined();
      });

      it('should return undefined for number input (not throw)', () => {
        expect(parseConditionRef(0 as any)).toBeUndefined();
      });

      it('should return undefined for object input (not throw)', () => {
        expect(parseConditionRef({} as any)).toBeUndefined();
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

        it('should accept KALSHI with numeric marketId', () => {
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

        it('should reject raw unescaped marketId containing colon', () => {
          expect(parseConditionRef('OFFCHAIN:KALSHI:MARKET:WITH:COLON')).toBeUndefined();
        });

        it('should support round-trip for OFFCHAIN ref with colon in marketId (via conditionRefToString)', () => {
          const original: OffChainConditionRef = {
            kind: 'OFFCHAIN',
            venueId: KnownVenues.KALSHI,
            marketId: 'MARKET:WITH:COLON',
          };

          // conditionRefToString escapes colons in marketId automatically
          const str = conditionRefToString(original);
          const parsed = parseConditionRef(str);

          expect(parsed).toBeDefined();
          expect(conditionRefEquals(original, parsed!)).toBe(true);
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

      describe('Malformed input (defensive branches)', () => {
        it('should reject string without colon', () => {
          // Line 277: if (firstColon === -1)
          expect(parseConditionRef('ONCHAIN')).toBeUndefined();
          expect(parseConditionRef('OFFCHAIN')).toBeUndefined();
          expect(parseConditionRef('INVALID')).toBeUndefined();
          expect(parseConditionRef('')).toBeUndefined();
        });

        it('should reject ONCHAIN with wrong number of parts', () => {
          // Line 288: if (parts.length !== 4)
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF')).toBeUndefined(); // too few
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137')).toBeUndefined(); // missing conditionId
          expect(parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xaaa:extra')).toBeUndefined(); // too many
        });

        it('should reject OFFCHAIN with wrong number of parts', () => {
          expect(parseConditionRef('OFFCHAIN:KALSHI')).toBeUndefined(); // missing marketId
          expect(parseConditionRef('OFFCHAIN')).toBeUndefined(); // missing everything
        });

        it('should reject unknown kind', () => {
          // Line 351: return undefined (unknown kind)
          expect(parseConditionRef('UNKNOWN:foo:bar')).toBeUndefined();
          expect(parseConditionRef('CUSTOM:venue:market')).toBeUndefined();
          expect(parseConditionRef('onchain:POLYMARKET_CTF:137:0xaaa')).toBeUndefined(); // lowercase
        });
      });
    });

    describe('Type guards', () => {
      it('should correctly identify OnChainConditionRef', () => {
        const onChainRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const offChainRef: OffChainConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.POLYMARKET,
          marketId: 'market-123',
        };

        expect(isOnChainConditionRef(onChainRef)).toBe(true);
        expect(isOnChainConditionRef(offChainRef)).toBe(false);

        // TypeScript narrowing test
        if (isOnChainConditionRef(onChainRef)) {
          expect(onChainRef.protocolId).toBe('POLYMARKET_CTF');
          expect(onChainRef.chainId).toBe(137);
        }
      });

      it('should correctly identify OffChainConditionRef', () => {
        const onChainRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const offChainRef: OffChainConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.POLYMARKET,
          marketId: 'market-123',
        };

        expect(isOffChainConditionRef(offChainRef)).toBe(true);
        expect(isOffChainConditionRef(onChainRef)).toBe(false);

        // TypeScript narrowing test
        if (isOffChainConditionRef(offChainRef)) {
          expect(offChainRef.venueId).toBe('POLYMARKET');
          expect(offChainRef.marketId).toBe('market-123');
        }
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

    it('should use known venues in real API scenarios', () => {
      // Сценарий 1: Создание venue account с известным venue
      const venueResult = accountIdFromVenue(KnownVenues.POLYMARKET, 'user-123');
      expect(venueResult.ok).toBe(true);
      if (venueResult.ok) {
        expect(venueResult.value.kind).toBe('VENUE');
        if (venueResult.value.kind === 'VENUE') {
          expect(venueResult.value.venueId).toBe('POLYMARKET');
        }
      }

      // Сценарий 2: Создание off-chain condition ref
      const offChainRef: OffChainConditionRef = {
        kind: 'OFFCHAIN',
        venueId: KnownVenues.KALSHI,
        marketId: 'KXBTCUSDM-24APR',
      };
      const refString = conditionRefToString(offChainRef);
      expect(refString).toBe('OFFCHAIN:KALSHI:KXBTCUSDM-24APR');

      // Сценарий 3: Round-trip через serialization
      const parsed = parseConditionRef(refString);
      expect(parsed).toBeDefined();
      if (parsed?.kind === 'OFFCHAIN') {
        expect(parsed.venueId).toBe(KnownVenues.KALSHI);
      }
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

    describe('Format validation (table-driven)', () => {
      it.each([
        ['max length (32 chars)', 'A'.repeat(32)],
        ['consecutive underscores', 'VENUE__NAME'],
        ['triple underscores', 'MY___VENUE'],
        ['leading underscore', '_VENUE'],
        ['trailing underscore', 'VENUE_'],
        ['both leading and trailing', '_VENUE_'],
      ])('should accept %s', (_description, venueId) => {
        expect(asVenueId(venueId)).toBe(venueId);
      });
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

    it('should use known protocols in real API scenarios', () => {
      // Сценарий 1: Создание on-chain condition ref с протоколом
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };

      // Сценарий 2: Использование в AssetId (outcome token)
      const tokenAsset = unwrapToken(conditionRef, BinaryOutcome.UP);
      expect(tokenAsset.type).toBe('OUTCOME_TOKEN');
      if (tokenAsset.type === 'OUTCOME_TOKEN') {
        expect(tokenAsset.conditionRef.protocolId).toBe('POLYMARKET_CTF');
      }

      // Сценарий 3: Serialization и parsing
      const assetString = assetIdToString(tokenAsset);
      expect(assetString).toBe('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP');

      const parsedAsset = parseAssetId(assetString);
      expect(parsedAsset).toBeDefined();
      if (parsedAsset?.type === 'OUTCOME_TOKEN' && parsedAsset.conditionRef.kind === 'ONCHAIN') {
        expect(parsedAsset.conditionRef.protocolId).toBe(KnownOnChainProtocols.POLYMARKET_CTF);
      }
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

    describe('Format validation (table-driven)', () => {
      it.each([
        ['max length (32 chars)', 'A'.repeat(32)],
        ['consecutive underscores', 'PROTOCOL__NAME'],
        ['triple underscores', 'MY___CTF'],
        ['leading underscore', '_PROTOCOL'],
        ['trailing underscore', 'PROTOCOL_'],
        ['both leading and trailing', '_PROTOCOL_'],
      ])('should accept %s', (_description, protocolId) => {
        expect(asOnChainProtocolId(protocolId)).toBe(protocolId);
      });
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

      const result = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('OUTCOME_TOKEN');
        if (result.value.type === 'OUTCOME_TOKEN') {
          expect(result.value.outcomeKey).toBe(BinaryOutcome.UP);
          expect(result.value.conditionRef.kind).toBe('ONCHAIN');
        }
      }
    });

    it('should return Err on invalid OutcomeKey in fromOutcomeToken', () => {
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };

      // Invalid OutcomeKey — должен возвращать Err, а не throw
      const r1 = AssetIdHelpers.fromOutcomeToken(conditionRef, 'UP:DOWN' as any);
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.error).toBeInstanceOf(AssetIdValidationError);
        expect(r1.error.message).toMatch(/Invalid outcomeKey/);
        expect(r1.error.context?.field).toBe('outcomeKey');
      }

      const r2 = AssetIdHelpers.fromOutcomeToken(conditionRef, '' as any);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error.message).toMatch(/Invalid outcomeKey/);

      const r3 = AssetIdHelpers.fromOutcomeToken(conditionRef, 'x'.repeat(100) as any);
      expect(r3.ok).toBe(false);
      if (!r3.ok) expect(r3.error.message).toMatch(/Invalid outcomeKey/);

      const r4 = AssetIdHelpers.fromOutcomeToken(conditionRef, 'KEY\\VALUE' as any);
      expect(r4.ok).toBe(false);
      if (!r4.ok) expect(r4.error.message).toMatch(/Invalid outcomeKey/);
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
      const tokenAsset = unwrapToken(conditionRef, BinaryOutcome.UP);

      expect(AssetIdHelpers.equals(usdc1, usdc2)).toBe(true);
      expect(AssetIdHelpers.equals(usdc1, tokenAsset)).toBe(false);
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
      const token = unwrapToken(conditionRef, BinaryOutcome.UP);
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

    describe('parseAssetId non-string input guard', () => {
      it('should return undefined for null input (not throw)', () => {
        expect(parseAssetId(null as any)).toBeUndefined();
      });

      it('should return undefined for undefined input (not throw)', () => {
        expect(parseAssetId(undefined as any)).toBeUndefined();
      });

      it('should return undefined for number input (not throw)', () => {
        expect(parseAssetId(137 as any)).toBeUndefined();
      });

      it('should return undefined for object input (not throw)', () => {
        expect(parseAssetId({ type: 'CURRENCY' } as any)).toBeUndefined();
      });
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

      describe('Malformed input (defensive branches)', () => {
        it('should reject string with too few parts', () => {
          // Line 238: if (parts.length < 2)
          expect(parseAssetId('CURRENCY')).toBeUndefined();
          expect(parseAssetId('OUTCOME_TOKEN')).toBeUndefined();
          expect(parseAssetId('INVALID')).toBeUndefined();
          expect(parseAssetId('')).toBeUndefined();
        });

        it('should reject CURRENCY with wrong number of parts', () => {
          // Line 245: if (parts.length !== 2)
          expect(parseAssetId('CURRENCY:USDC:extra')).toBeUndefined();
          expect(parseAssetId('CURRENCY:USDC:extra:more')).toBeUndefined();
        });

        it('should reject OUTCOME_TOKEN with non-ONCHAIN kind', () => {
          // Line 268: if (kind !== 'ONCHAIN')
          expect(parseAssetId('OUTCOME_TOKEN:OFFCHAIN:KALSHI:market:UP')).toBeUndefined();
          expect(parseAssetId('OUTCOME_TOKEN:CUSTOM:proto:137:0xaaa:UP')).toBeUndefined();
          expect(parseAssetId('OUTCOME_TOKEN:onchain:POLYMARKET_CTF:137:0xaaa:UP')).toBeUndefined(); // lowercase
        });

        it('should reject unknown asset type', () => {
          expect(parseAssetId('UNKNOWN:value')).toBeUndefined();
          expect(parseAssetId('TOKEN:USDC')).toBeUndefined();
          expect(parseAssetId('currency:USDC')).toBeUndefined(); // lowercase
        });
      });
    });

    it('should support round-trip serialization', () => {
      // CURRENCY round-trip
      const usdc = AssetIdHelpers.USDC;
      const usdcStr = assetIdToString(usdc);
      const usdcParsed = parseAssetId(usdcStr);
      expect(AssetIdHelpers.equals(usdc, usdcParsed!)).toBe(true);

      // OUTCOME_TOKEN round-trip
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };
      const token = unwrapToken(conditionRef, BinaryOutcome.DOWN);
      const tokenStr = assetIdToString(token);
      const tokenParsed = parseAssetId(tokenStr);
      expect(AssetIdHelpers.equals(token, tokenParsed!)).toBe(true);
    });

    describe('Type guards', () => {
      it('should correctly identify currency assets', () => {
        const usdc = AssetIdHelpers.USDC;
        const usdc2 = AssetIdHelpers.fromCurrency('USDC');

        expect(isCurrencyAsset(usdc)).toBe(true);
        expect(isCurrencyAsset(usdc2)).toBe(true);

        // TypeScript narrowing
        if (isCurrencyAsset(usdc)) {
          expect(usdc.currency).toBe('USDC');
        }

        // Outcome token не является currency
        const conditionRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };
        const token = unwrapToken(conditionRef, BinaryOutcome.UP);
        expect(isCurrencyAsset(token)).toBe(false);
      });

      it('should correctly identify outcome token assets', () => {
        const conditionRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };
        const token = unwrapToken(conditionRef, BinaryOutcome.UP);

        expect(isOutcomeTokenAsset(token)).toBe(true);

        // TypeScript narrowing
        if (isOutcomeTokenAsset(token)) {
          expect(token.outcomeKey).toBe('UP');
          expect(token.conditionRef.kind).toBe('ONCHAIN');
        }

        // Currency не является outcome token
        const usdc = AssetIdHelpers.USDC;
        expect(isOutcomeTokenAsset(usdc)).toBe(false);
      });

      it('should use type guards in routing logic', () => {
        const usdc = AssetIdHelpers.USDC;
        const conditionRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };
        const token = unwrapToken(conditionRef, BinaryOutcome.UP);

        // Сценарий: routing балансов по типу актива
        const assets = [usdc, token];
        const currencies = assets.filter(isCurrencyAsset);
        const tokens = assets.filter(isOutcomeTokenAsset);

        expect(currencies).toHaveLength(1);
        expect(tokens).toHaveLength(1);
        expect(currencies[0].currency).toBe('USDC');
        expect(tokens[0].outcomeKey).toBe('UP');
      });
    });

    describe('Immutability (Object.freeze)', () => {
      it('should freeze CURRENCY assets to prevent mutations', () => {
        const usdc = AssetIdHelpers.fromCurrency('USDC');

        // Проверяем что объект заморожен
        expect(Object.isFrozen(usdc)).toBe(true);

        // Попытка мутации должна быть проигнорирована (или throw в strict mode)
        expect(() => {
          (usdc as any).type = 'HACKED';
        }).toThrow();

        expect(() => {
          (usdc as any).currency = 'HACKED';
        }).toThrow();

        // Исходное значение должно остаться неизменным
        expect(usdc.type).toBe('CURRENCY');
        if (usdc.type === 'CURRENCY') {
          expect(usdc.currency).toBe('USDC');
        }
      });

      it('should freeze USDC constant to prevent mutations', () => {
        const usdc = AssetIdHelpers.USDC;

        // USDC константа должна быть замороженной
        expect(Object.isFrozen(usdc)).toBe(true);

        // Попытка мутации должна быть проигнорирована (или throw в strict mode)
        expect(() => {
          (usdc as any).currency = 'HACKED';
        }).toThrow();

        // Исходное значение должно остаться неизменным
        expect(usdc.type).toBe('CURRENCY');
        if (usdc.type === 'CURRENCY') {
          expect(usdc.currency).toBe('USDC');
        }
      });

      it('should deep freeze OUTCOME_TOKEN assets (including conditionRef)', () => {
        const conditionRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        const token = unwrapToken(conditionRef, BinaryOutcome.UP);

        // Проверяем что AssetId заморожен
        expect(Object.isFrozen(token)).toBe(true);

        // Проверяем что вложенный conditionRef тоже заморожен (deep freeze)
        if (token.type === 'OUTCOME_TOKEN') {
          expect(Object.isFrozen(token.conditionRef)).toBe(true);
        }

        // Попытка мутации AssetId должна быть заблокирована
        expect(() => {
          (token as any).type = 'HACKED';
        }).toThrow();

        expect(() => {
          (token as any).outcomeKey = 'HACKED';
        }).toThrow();

        // Попытка мутации вложенного conditionRef должна быть заблокирована
        if (token.type === 'OUTCOME_TOKEN') {
          expect(() => {
            (token.conditionRef as any).conditionId = 'HACKED';
          }).toThrow();

          expect(() => {
            (token.conditionRef as any).chainId = 999;
          }).toThrow();

          expect(() => {
            (token.conditionRef as any).protocolId = 'HACKED';
          }).toThrow();
        }

        // Исходное значение должно остаться неизменным
        expect(token.type).toBe('OUTCOME_TOKEN');
        if (token.type === 'OUTCOME_TOKEN') {
          expect(token.outcomeKey).toBe('UP');
          expect(token.conditionRef.kind).toBe('ONCHAIN');
          expect(token.conditionRef.protocolId).toBe('POLYMARKET_CTF');
          expect(token.conditionRef.chainId).toBe(137);
          expect(token.conditionRef.conditionId).toBe(
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          );
        }
      });

      it('should not mutate input conditionRef when creating frozen AssetId', () => {
        // Создаем не замороженный conditionRef
        const conditionRef: OnChainConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
        };

        // Входной объект НЕ должен быть заморожен (defensive design)
        expect(Object.isFrozen(conditionRef)).toBe(false);

        const token = unwrapToken(conditionRef, BinaryOutcome.UP);

        // AssetId и его conditionRef должны быть замороженными
        expect(Object.isFrozen(token)).toBe(true);
        if (token.type === 'OUTCOME_TOKEN') {
          expect(Object.isFrozen(token.conditionRef)).toBe(true);
        }

        // ВАЖНО: Входной conditionRef НЕ должен мутироваться (defensive copy + freeze)
        // fromOutcomeToken создает НОВЫЙ замороженный объект, а не замораживает входной
        expect(Object.isFrozen(conditionRef)).toBe(false);

        // Входной объект можно продолжать использовать
        (conditionRef as any).chainId = 1; // Должно работать без ошибки
        expect(conditionRef.chainId).toBe(1);

        // Но AssetId остается неизменным (использует свою копию)
        if (token.type === 'OUTCOME_TOKEN') {
          expect(token.conditionRef.chainId).toBe(137); // Оригинальное значение
        }
      });
    });

    describe('fromOutcomeToken validation safe-контракт (возвращает Err)', () => {
      const validRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };

      it('should return Err on invalid protocolId (lowercase)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(
          { ...validRef, protocolId: 'polymarket_ctf' as any },
          BinaryOutcome.UP
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.message).toMatch(/Invalid protocolId/);
          expect(result.error.context?.field).toBe('protocolId');
        }
      });

      it('should return Err on invalid protocolId (contains dash)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(
          { ...validRef, protocolId: 'POLY-MARKET' as any },
          BinaryOutcome.UP
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/Invalid protocolId/);
          expect(result.error.context?.field).toBe('protocolId');
        }
      });

      it('should return Err on invalid chainId (zero)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(
          { ...validRef, chainId: 0 as any },
          BinaryOutcome.UP
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/Invalid chainId/);
          expect(result.error.context?.field).toBe('chainId');
        }
      });

      it('should return Err on invalid chainId (negative)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(
          { ...validRef, chainId: -1 as any },
          BinaryOutcome.UP
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/Invalid chainId/);
          expect(result.error.context?.field).toBe('chainId');
        }
      });

      it('should return Err on invalid conditionId (too short)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(
          { ...validRef, conditionId: '0xabcd' as any },
          BinaryOutcome.UP
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/Invalid conditionId/);
          expect(result.error.context?.field).toBe('conditionId');
        }
      });

      it('should return Err on invalid conditionId (not hex)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(
          { ...validRef, conditionId: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG' as any },
          BinaryOutcome.UP
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/Invalid conditionId/);
          expect(result.error.context?.field).toBe('conditionId');
        }
      });

      it('should return Err when outcomeKey is null (passed as any)', () => {
        // Защита от runtime-атаки через as any: null не является валидным OutcomeKey
        const result = AssetIdHelpers.fromOutcomeToken(validRef, null as any);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('outcomeKey');
        }
      });

      it('should return Err when outcomeKey is undefined (passed as any)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(validRef, undefined as any);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('outcomeKey');
        }
      });

      it('should return Err when outcomeKey is number 0 (passed as any)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(validRef, 0 as any);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('outcomeKey');
        }
      });

      it('should return Err when outcomeKey is plain object (passed as any)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(validRef, {} as any);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('outcomeKey');
        }
      });

      it('should return Err when conditionRef is null (passed as any)', () => {
        // Safe-контракт: null conditionRef → Err, не TypeError
        const result = AssetIdHelpers.fromOutcomeToken(null as any, BinaryOutcome.UP);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('conditionRef');
        }
      });

      it('should return Err when conditionRef is undefined (passed as any)', () => {
        const result = AssetIdHelpers.fromOutcomeToken(undefined as any, BinaryOutcome.UP);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('conditionRef');
        }
      });

      it('should return Err when conditionRef is plain string (passed as any)', () => {
        const result = AssetIdHelpers.fromOutcomeToken('not-an-object' as any, BinaryOutcome.UP);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetIdValidationError);
          expect(result.error.context?.field).toBe('conditionRef');
        }
      });
    });

    describe('AssetIdHelpers.equals', () => {
      const ref: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };
      const refDifferentChain: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: parseChainId('1')!, // Ethereum mainnet
        conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
      };

      it('should return true for identical CURRENCY assets', () => {
        const a = AssetIdHelpers.fromCurrency('USDC');
        const b = AssetIdHelpers.fromCurrency('USDC');
        expect(AssetIdHelpers.equals(a, b)).toBe(true);
      });

      it('should return false for CURRENCY assets with different currency values', () => {
        const a = AssetIdHelpers.fromCurrency('USDC');
        // Создаём asset с другой валютой через прямое приведение типа (для теста)
        const b = { type: 'CURRENCY' as const, currency: 'USDT' as any };
        expect(AssetIdHelpers.equals(a, b)).toBe(false);
      });

      it('should return false when types differ (CURRENCY vs OUTCOME_TOKEN)', () => {
        const currency = AssetIdHelpers.fromCurrency('USDC');
        const token = unwrapToken(ref, BinaryOutcome.UP);
        expect(AssetIdHelpers.equals(currency, token)).toBe(false);
      });

      it('should return true for identical OUTCOME_TOKEN assets', () => {
        const a = unwrapToken(ref, BinaryOutcome.UP);
        const b = unwrapToken(ref, BinaryOutcome.UP);
        expect(AssetIdHelpers.equals(a, b)).toBe(true);
      });

      it('should return false for OUTCOME_TOKEN with different conditionId', () => {
        const refB = { ...ref, conditionId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as ConditionId };
        const a = unwrapToken(ref, BinaryOutcome.UP);
        const b = unwrapToken(refB, BinaryOutcome.UP);
        expect(AssetIdHelpers.equals(a, b)).toBe(false);
      });

      it('should return false for OUTCOME_TOKEN with different outcomeKey', () => {
        const a = unwrapToken(ref, BinaryOutcome.UP);
        const b = unwrapToken(ref, BinaryOutcome.DOWN);
        expect(AssetIdHelpers.equals(a, b)).toBe(false);
      });

      it('should return false for OUTCOME_TOKEN with different chainId', () => {
        const a = unwrapToken(ref, BinaryOutcome.UP);
        const b = unwrapToken(refDifferentChain, BinaryOutcome.UP);
        expect(AssetIdHelpers.equals(a, b)).toBe(false);
      });

    });

    describe('parseAssetId immutability', () => {
      it('should return frozen CURRENCY object from parseAssetId', () => {
        const parsed = parseAssetId('CURRENCY:USDC');
        expect(parsed).toBeDefined();
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(() => {
          (parsed as any).type = 'HACKED';
        }).toThrow();
      });

      it('should return frozen OUTCOME_TOKEN object from parseAssetId (including conditionRef)', () => {
        const str = 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:UP';
        const parsed = parseAssetId(str);
        expect(parsed).toBeDefined();
        expect(Object.isFrozen(parsed)).toBe(true);
        if (parsed && parsed.type === 'OUTCOME_TOKEN') {
          expect(Object.isFrozen(parsed.conditionRef)).toBe(true);
          expect(() => {
            (parsed.conditionRef as any).chainId = 999;
          }).toThrow();
        }
      });
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

    it('should handle invalid indices', () => {
      // Negative indices
      expect(indexToOutcomeKey(-1)).toBeUndefined();
      expect(indexToOutcomeKey(-999)).toBeUndefined();

      // Very large indices
      expect(indexToOutcomeKey(999999)).toBeUndefined();
      expect(indexToOutcomeKey(Number.MAX_SAFE_INTEGER)).toBeUndefined();
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
    });

    it('should return undefined for non-binary outcome keys', () => {
      // Custom outcome keys (не UP/DOWN)
      const customKey = parseOutcomeKey('CUSTOM')!;
      expect(oppositeOutcomeKey(customKey)).toBeUndefined();

      // OUTCOME_0/OUTCOME_1 не поддерживаются (только UP/DOWN)
      const outcome0 = parseOutcomeKey('OUTCOME_0')!;
      const outcome1 = parseOutcomeKey('OUTCOME_1')!;
      expect(oppositeOutcomeKey(outcome0)).toBeUndefined();
      expect(oppositeOutcomeKey(outcome1)).toBeUndefined();
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

      it('should reject strings containing control characters (U+0000..U+001F)', () => {
        expect(parseOutcomeKey('\x00')).toBeUndefined();      // NUL
        expect(parseOutcomeKey('\x01UP')).toBeUndefined();    // SOH prefix
        expect(parseOutcomeKey('UP\x09')).toBeUndefined();    // HT (tab)
        expect(parseOutcomeKey('UP\x0A')).toBeUndefined();    // LF (newline)
        expect(parseOutcomeKey('UP\x0D')).toBeUndefined();    // CR
        expect(parseOutcomeKey('UP\x1F')).toBeUndefined();    // US (unit separator)
      });

      it('should reject strings containing control characters (U+007F..U+009F)', () => {
        expect(parseOutcomeKey('UP\x7F')).toBeUndefined();    // DEL
        expect(parseOutcomeKey('UP\x80')).toBeUndefined();    // PAD
        expect(parseOutcomeKey('UP\x9F')).toBeUndefined();    // APC
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

    it('should return undefined for non-string input (not throw)', () => {
      // Защита от as any — не должен вызывать null.trim()
      expect(asSupportedCurrency(null as any)).toBeUndefined();
      expect(asSupportedCurrency(undefined as any)).toBeUndefined();
      expect(asSupportedCurrency(0 as any)).toBeUndefined();
      expect(asSupportedCurrency({} as any)).toBeUndefined();
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

      it('should return undefined for non-string input (not throw)', () => {
        // Защита от as any: regex коэрсирует числа в строку, что нарушает parser-контракт
        expect(parseChainId(137 as any)).toBeUndefined(); // без guard: 137 → '137' → valid!
        expect(parseChainId(null as any)).toBeUndefined();
        expect(parseChainId(undefined as any)).toBeUndefined();
        expect(parseChainId({} as any)).toBeUndefined();
      });
    });

    describe('getChainName', () => {
      it('should return names for known chains', () => {
        expect(getChainName(KnownChainIds.ETHEREUM_MAINNET)).toBe('Ethereum Mainnet');
        expect(getChainName(KnownChainIds.POLYGON)).toBe('Polygon');
        expect(getChainName(KnownChainIds.BASE)).toBe('Base');
      });

      it('should return generic name for unknown chains', () => {
        expect(getChainName(999 as any)).toBe('Chain 999');
        expect(getChainName(12345 as any)).toBe('Chain 12345');
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
      it('should convert to lowercase', () => {
        const uppercase = '0x' + 'A'.repeat(64);
        const mixed = '0x' + 'AbCdEf12'.repeat(8);

        expect(normalizeConditionId(uppercase as any)).toBe(('0x' + 'a'.repeat(64)));
        expect(normalizeConditionId(mixed as any)).toBe(mixed.toLowerCase());
      });

      it('should preserve already lowercase IDs', () => {
        const lowercase = '0x' + 'a'.repeat(64);
        expect(normalizeConditionId(lowercase as any)).toBe(lowercase);
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

    it('should return undefined for non-string input (not throw)', () => {
      // Защита от as any runtime-ввода — не должен вызывать null.toLowerCase()
      expect(parseWalletAddress(null as any)).toBeUndefined();
      expect(parseWalletAddress(undefined as any)).toBeUndefined();
      expect(parseWalletAddress(42 as any)).toBeUndefined();
      expect(parseWalletAddress({} as any)).toBeUndefined();
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
      const result = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const accountId = result.value;
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
      const venueAcc = unwrapVenue(KnownVenues.POLYMARKET, 'user_123');
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
      const venueAcc = unwrapVenue(KnownVenues.POLYMARKET, 'user:123');
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
      const venueAcc = unwrapVenue(KnownVenues.POLYMARKET, 'user:123');
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
      const venue1 = unwrapVenue(KnownVenues.POLYMARKET, 'user_123');
      const venue2 = unwrapVenue(KnownVenues.POLYMARKET, 'user_123');
      expect(accountIdEquals(venue1, venue2)).toBe(true);

      // Different accounts
      const walletAcc = accountIdFromWallet(testWallet);
      const venueAcc = unwrapVenue(KnownVenues.POLYMARKET, 'user_123');
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

    describe('Escaping round-trip', () => {
      it.each([
        ['user\\:123', 'backslash + colon'],
        ['user\\\\:123', 'double backslash + colon'],
        ['a\\b', 'backslash between letters'],
        ['path\\to\\file', 'multiple backslashes'],
        ['name\\\\with\\\\slashes', 'double backslashes'],
        ['a]\\\\:b', 'complex escaped sequences'],
        [':', 'only colon'],
        ['\\', 'only backslash'],
      ])('should handle %s (%s)', (userId, _description) => {
        const venueAcc = unwrapVenue(KnownVenues.POLYMARKET, userId);
        const str = accountIdToString(venueAcc);
        const parsed = parseAccountId(str);

        expect(parsed).toBeDefined();
        if (parsed?.kind === 'VENUE') {
          expect(parsed.userId).toBe(userId);
        }
      });
    });

    describe('parseAccountId boundary tests', () => {
      it('should reject strings exceeding maxLen', () => {
        // Создаём валидный AccountId и проверяем с разными maxLen
        const wallet = accountIdFromWallet(testWallet);
        const serialized = accountIdToString(wallet);

        // С дефолтным maxLen (512) должно парситься
        expect(parseAccountId(serialized)).toBeDefined();

        // С маленьким maxLen должно отклониться
        expect(parseAccountId(serialized, { maxLen: 10 })).toBeUndefined();

        // Создаём слишком длинную строку (> 512)
        const tooLongStr = 'x'.repeat(600);
        expect(parseAccountId(tooLongStr)).toBeUndefined();
      });

      it('should respect custom maxDepth', () => {
        // Создаём depth 2
        const wallet = accountIdFromWallet(testWallet);
        const sub1 = accountIdForSubaccount(wallet, 'level1');
        if (!sub1.ok) throw new Error('Failed to create sub1');
        const sub2 = accountIdForSubaccount(sub1.value, 'level2');
        if (!sub2.ok) throw new Error('Failed to create sub2');

        const serialized = accountIdToString(sub2.value);

        // С maxDepth=2 должно парситься
        expect(parseAccountId(serialized, { maxDepth: 2 })).toBeDefined();

        // С maxDepth=1 должно отклониться
        expect(parseAccountId(serialized, { maxDepth: 1 })).toBeUndefined();
      });

      it('should handle escape sequences at boundaries', () => {
        // userId с escape последовательностями на границах
        const userId1 = '\\:start'; // начинается с escape
        const venueAcc1 = unwrapVenue(KnownVenues.POLYMARKET, userId1);
        const str1 = accountIdToString(venueAcc1);
        const parsed1 = parseAccountId(str1);
        expect(parsed1).toBeDefined();
        if (parsed1?.kind === 'VENUE') {
          expect(parsed1.userId).toBe(userId1);
        }

        const userId2 = 'end\\:'; // заканчивается на escape
        const venueAcc2 = unwrapVenue(KnownVenues.POLYMARKET, userId2);
        const str2 = accountIdToString(venueAcc2);
        const parsed2 = parseAccountId(str2);
        expect(parsed2).toBeDefined();
        if (parsed2?.kind === 'VENUE') {
          expect(parsed2.userId).toBe(userId2);
        }
      });
    });

    describe('parseAccountId invalid kind and extra parts', () => {
      it('should reject wallet with extra parts', () => {
        const addr = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
        expect(parseAccountId(`wallet:${addr}:extra`)).toBeUndefined();
      });

      it('should reject venue with extra parts', () => {
        expect(parseAccountId('venue:POLYMARKET:user:extra')).toBeUndefined();
      });

      it('should reject sub with too few parts', () => {
        // 'sub:name' → splitEscaped gives 2 parts → parts.length < 3 → undefined
        expect(parseAccountId('sub:onlyone')).toBeUndefined();
      });

      it('should reject unknown kind', () => {
        expect(parseAccountId('unknown:payload')).toBeUndefined();
      });
    });

    describe('Factory validation', () => {
      it('should reject invalid userId in accountIdFromVenue', () => {
        // Empty string
        let result = accountIdFromVenue(KnownVenues.POLYMARKET, '');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('empty string');
        }

        // Too long (> 256 chars)
        result = accountIdFromVenue(KnownVenues.POLYMARKET, 'x'.repeat(300));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('exceeds 256 characters');
        }

        // Control characters → explicit reason
        result = accountIdFromVenue(KnownVenues.POLYMARKET, 'user\x00id');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('contains control characters');
        }
      });

      it('should reject invalid name in accountIdForSubaccount', () => {
        const walletAcc = accountIdFromWallet(testWallet);

        // Empty string
        let result = accountIdForSubaccount(walletAcc, '');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('empty string');
        }

        // Too long (> 256 chars)
        result = accountIdForSubaccount(walletAcc, 'x'.repeat(300));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('exceeds 256 characters');
        }

        // Control characters → explicit reason
        result = accountIdForSubaccount(walletAcc, 'sub\x00name');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('contains control characters');
        }
      });

      it('should allow valid userId and name', () => {
        // Valid userId
        const venueResult = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
        expect(venueResult.ok).toBe(true);

        // Valid name
        const walletAcc = accountIdFromWallet(testWallet);
        const subResult = accountIdForSubaccount(walletAcc, 'trading');
        expect(subResult.ok).toBe(true);

        // Max length (256 chars)
        const maxUserId = 'a'.repeat(256);
        const maxVenueResult = accountIdFromVenue(KnownVenues.POLYMARKET, maxUserId);
        expect(maxVenueResult.ok).toBe(true);

        const maxName = 'b'.repeat(256);
        const maxSubResult = accountIdForSubaccount(walletAcc, maxName);
        expect(maxSubResult.ok).toBe(true);
      });

      it('should guarantee round-trip for valid inputs', () => {
        // Create with factory, serialize, parse - должно work
        const venueResult = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:with:colons');
        expect(venueResult.ok).toBe(true);
        if (!venueResult.ok) return;

        const str = accountIdToString(venueResult.value);
        const parsed = parseAccountId(str);
        expect(parsed).toBeDefined();
        expect(accountIdEquals(venueResult.value, parsed!)).toBe(true);
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

      it('should allow creating subaccount at exactly max depth', () => {
        const walletAcc = accountIdFromWallet(testWallet);

        // Создаём 4 уровня (depth будет 4)
        let current: AccountId = walletAcc;
        for (let i = 1; i <= 4; i++) {
          const result = accountIdForSubaccount(current, `level${i}`);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          current = result.value;
        }

        expect(getSubaccountDepth(current)).toBe(4);

        // Попытка создать 5-й уровень (depth станет 5 - максимум) должна УСПЕШНО пройти
        const maxDepthResult = accountIdForSubaccount(current, 'level5');
        expect(maxDepthResult.ok).toBe(true);
        if (!maxDepthResult.ok) return;
        expect(getSubaccountDepth(maxDepthResult.value)).toBe(5);

        // А вот 6-й уже должен отклониться
        const tooDeepResult = accountIdForSubaccount(maxDepthResult.value, 'level6');
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

      it('should support round-trip for max depth (5)', () => {
        const walletAcc = accountIdFromWallet(testWallet);

        // Создаём структуру глубиной 5
        let current: AccountId = walletAcc;
        for (let i = 1; i <= 5; i++) {
          const result = accountIdForSubaccount(current, `level${i}`);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          current = result.value;
        }

        expect(getSubaccountDepth(current)).toBe(5);

        // Сериализуем
        const serialized = accountIdToString(current);
        expect(serialized).toContain('sub:sub:sub:sub:sub:wallet');

        // Парсим обратно - ДОЛЖНО работать для depth 5!
        const parsed = parseAccountId(serialized);
        expect(parsed).toBeDefined();
        if (!parsed) return;

        expect(getSubaccountDepth(parsed)).toBe(5);
        expect(accountIdEquals(current, parsed)).toBe(true);
      });

      it('should return undefined when parsing deeply nested string', () => {
        // Строка с глубиной вложенности 6 (превышает лимит 5)
        const deepStr = `sub:sub:sub:sub:sub:sub:wallet:${testWallet}:a:b:c:d:e:f`;

        const parsed = parseAccountId(deepStr);
        expect(parsed).toBeUndefined(); // должно вернуть undefined из-за превышения depth limit
      });

      it('should return undefined when parsing with custom maxDepth', () => {
        const str = `sub:sub:wallet:${testWallet}:a:b`; // глубина 2

        // С maxDepth=1 должно вернуть undefined (разрешена только depth 0-1)
        const parsed = parseAccountId(str, { maxDepth: 1 });
        expect(parsed).toBeUndefined();

        // С maxDepth=2 должно распарситься (разрешена depth 0-2)
        const parsed2 = parseAccountId(str, { maxDepth: 2 });
        expect(parsed2).toBeDefined();

        // С maxDepth=3 тоже должно распарситься (разрешена depth 0-3)
        const parsed3 = parseAccountId(str, { maxDepth: 3 });
        expect(parsed3).toBeDefined();
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
        // создаём структуру вручную (обходя защиту фабрики).
        // veryDeep1: wallet + 6 SUBACCOUNT = depth 6, превышает MAX_SUBACCOUNT_DEPTH (5),
        // поэтому accountIdEquals возвращает false вместо рекурсивного сравнения.
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

      it('should handle cyclic base in getSubaccountDepth without infinite loop', () => {
        // Создаём цикл в обход TypeScript через as any — тест защитного кода
        const mutableSub = {
          kind: 'SUBACCOUNT' as const,
          base: accountIdFromWallet(testWallet),
          name: 'cyclic',
        };
        // Цикл: mutableSub.base → mutableSub
        (mutableSub as { base: object }).base = mutableSub;
        const cyclicId = mutableSub as AccountId;

        // Функция должна завершиться быстро и вернуть > MAX_SUBACCOUNT_DEPTH (5)
        const depth = getSubaccountDepth(cyclicId);
        expect(depth).toBeGreaterThan(5);
      });

      it('should return Err(AccountIdDepthError) for accountIdForSubaccount with cyclic base', () => {
        // Создаём цикл аналогичным образом
        const mutableSub = {
          kind: 'SUBACCOUNT' as const,
          base: accountIdFromWallet(testWallet),
          name: 'cyclic',
        };
        (mutableSub as { base: object }).base = mutableSub;
        const cyclicId = mutableSub as AccountId;

        // Попытка добавить child к цикличному base — должна вернуть Err
        const result = accountIdForSubaccount(cyclicId, 'child');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AccountIdDepthError);
        }
      });

      it('should return > MAX_SUBACCOUNT_DEPTH for corrupted SUBACCOUNT with base: null', () => {
        // Инвариант цепочки: SUBACCOUNT.base должен завершиться на WALLET или VENUE.
        // null-base нарушает инвариант — getSubaccountDepth возвращает MAX+1 (как corrupted chain)
        const corrupted = { kind: 'SUBACCOUNT' as const, base: null, name: 'broken' } as any as AccountId;
        const depth = getSubaccountDepth(corrupted);
        expect(typeof depth).toBe('number');
        expect(depth).toBeGreaterThan(5); // цепочка не заканчивается на WALLET/VENUE → MAX+1
      });

      it('should return > MAX_SUBACCOUNT_DEPTH for corrupted SUBACCOUNT with base: undefined', () => {
        // undefined-base нарушает инвариант — chain не завершается на валидном корне
        const corrupted = { kind: 'SUBACCOUNT' as const, base: undefined, name: 'broken' } as any as AccountId;
        const depth = getSubaccountDepth(corrupted);
        expect(typeof depth).toBe('number');
        expect(depth).toBeGreaterThan(5); // chain не заканчивается на WALLET/VENUE → MAX+1
      });

      it('should return > MAX_SUBACCOUNT_DEPTH for corrupted SUBACCOUNT with base: plain object', () => {
        // {} без known kind — chain не завершается на WALLET/VENUE
        const corrupted = { kind: 'SUBACCOUNT' as const, base: {}, name: 'broken' } as any as AccountId;
        const depth = getSubaccountDepth(corrupted);
        expect(typeof depth).toBe('number');
        expect(depth).toBeGreaterThan(5); // {}.kind !== 'WALLET'/'VENUE' → MAX+1
      });

      it('should return Err(AccountIdDepthError) for accountIdForSubaccount with corrupted base: null', () => {
        // getSubaccountDepth(corrupted) → MAX+1 → accountIdForSubaccount возвращает Err
        const corrupted = { kind: 'SUBACCOUNT' as const, base: null, name: 'broken' } as any as AccountId;
        const result = accountIdForSubaccount(corrupted, 'child');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AccountIdDepthError);
        }
      });

      it('should return Err(AccountIdDepthError) for accountIdForSubaccount with null as any base', () => {
        // null напрямую как base — chain не начинается с объекта → MAX+1
        const result = accountIdForSubaccount(null as any, 'child');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AccountIdDepthError);
        }
      });
    });

    describe('parseAccountId non-string input guard', () => {
      it('should return undefined for null input (not throw)', () => {
        expect(parseAccountId(null as any)).toBeUndefined();
      });

      it('should return undefined for undefined input (not throw)', () => {
        expect(parseAccountId(undefined as any)).toBeUndefined();
      });

      it('should return undefined for number input (not throw)', () => {
        expect(parseAccountId(42 as any)).toBeUndefined();
      });

      it('should return undefined for object input (not throw)', () => {
        expect(parseAccountId({} as any)).toBeUndefined();
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
    });

    describe('ParseAccountIdOptions corruption guard', () => {
      const validWalletStr = `wallet:${testWallet}`;

      it('should return undefined (not throw) when validateWalletAddress is null as any', () => {
        // validate is not a function — дефолтная валидация должна использоваться
        const result = parseAccountId(validWalletStr, { validateWalletAddress: null as any });
        expect(result).toBeDefined(); // null → fallback to parseWalletAddress → Ok
      });

      it('should return undefined (not throw) when validateWalletAddress is number as any', () => {
        const result = parseAccountId(validWalletStr, { validateWalletAddress: 42 as any });
        expect(result).toBeDefined(); // 42 → fallback to parseWalletAddress → Ok
      });

      it('should return undefined (not throw) when validateWalletAddress is object as any', () => {
        const result = parseAccountId(validWalletStr, { validateWalletAddress: {} as any });
        expect(result).toBeDefined(); // {} → fallback to parseWalletAddress → Ok
      });

      it('should fall back to default maxLen when maxLen is NaN', () => {
        // NaN maxLen → дефолт MAX_ACCOUNT_ID_STRING_LENGTH
        const result = parseAccountId(validWalletStr, { maxLen: NaN });
        expect(result).toBeDefined(); // дефолтный лимит, строка валидной длины
      });

      it('should fall back to default maxLen when maxLen is string as any', () => {
        const result = parseAccountId(validWalletStr, { maxLen: 'bad' as any });
        expect(result).toBeDefined(); // строковый maxLen → дефолт
      });

      it('should fall back to default maxDepth when maxDepth is NaN', () => {
        const result = parseAccountId(validWalletStr, { maxDepth: NaN });
        expect(result).toBeDefined(); // дефолтный лимит глубины
      });

      it('should fall back to default maxDepth when maxDepth is string as any', () => {
        const result = parseAccountId(validWalletStr, { maxDepth: 'bad' as any });
        expect(result).toBeDefined(); // строковый maxDepth → дефолт
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

    describe('accountIdEquals defensive depth guard', () => {
      it('should return false (not crash) when comparing deeply nested structures exceeding MAX_SUBACCOUNT_DEPTH', () => {
        // Создаём два идентичных дерева глубиной 5 (максимум), проверяем что equals работает
        const wallet = accountIdFromWallet(parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!);
        let base: AccountId = wallet;
        for (let i = 0; i < 5; i++) {
          const result = accountIdForSubaccount(base, `level${i}`);
          if (!result.ok) break;
          base = result.value;
        }
        // deep=5: сравниваем с собой — должно быть true (5 === MAX_SUBACCOUNT_DEPTH, depth tracking с 0)
        expect(accountIdEquals(base, base)).toBe(true);

        // Handcrafted структура с depth > MAX через прямое построение объекта (обходим фабрику)
        const deepId: AccountId = {
          kind: 'SUBACCOUNT',
          base: { kind: 'SUBACCOUNT', base: { kind: 'SUBACCOUNT', base: { kind: 'SUBACCOUNT',
            base: { kind: 'SUBACCOUNT', base: { kind: 'SUBACCOUNT',
              base: wallet, name: 'l0' }, name: 'l1' }, name: 'l2' }, name: 'l3' }, name: 'l4' }, name: 'l5' };
        // accountIdEquals должен вернуть false при превышении depth, а не упасть
        expect(accountIdEquals(deepId, deepId)).toBe(false);
      });
    });

    describe('accountIdToString corrupted base guard', () => {
      it('should return fallback string for SUBACCOUNT with base: null, not throw', () => {
        // accountIdToString должен быть тотальным — не падать на corrupted base
        const corrupted = { kind: 'SUBACCOUNT' as const, base: null, name: 'broken' } as any as AccountId;
        const result = accountIdToString(corrupted);
        expect(typeof result).toBe('string');
        expect(result).toContain('[INVALID:NULL_BASE]');
      });

      it('should return fallback string for SUBACCOUNT with base: undefined, not throw', () => {
        const corrupted = { kind: 'SUBACCOUNT' as const, base: undefined, name: 'broken' } as any as AccountId;
        const result = accountIdToString(corrupted);
        expect(typeof result).toBe('string');
        expect(result).toContain('[INVALID:NULL_BASE]');
      });

      it('should return fallback string for SUBACCOUNT with base: plain object, not throw', () => {
        // base = {} имеет kind === undefined → UNKNOWN_KIND fallback (не crash)
        const corrupted = { kind: 'SUBACCOUNT' as const, base: {}, name: 'broken' } as any as AccountId;
        const result = accountIdToString(corrupted);
        expect(typeof result).toBe('string');
        // {} пройдёт typeof object check, но kind === undefined → UNKNOWN_KIND fallback
        expect(result).toContain('[INVALID:UNKNOWN_KIND]');
      });
    });

    describe('accountIdToString depth safety guard', () => {
      it('should return fallback string instead of crashing for handcrafted over-deep structure', () => {
        const wallet = accountIdFromWallet(parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!);
        // Создаём структуру depth=16 (превышает MAX+SAFETY_MARGIN=5+10=15)
        let deep: AccountId = wallet;
        for (let i = 0; i < 16; i++) {
          deep = { kind: 'SUBACCOUNT', base: deep, name: `l${i}` };
        }
        // Тест намеренно триггерит console.assert — подавляем шум в выводе
        const assertSpy = jest.spyOn(console, 'assert').mockImplementation(() => {});
        const result = accountIdToString(deep);
        assertSpy.mockRestore();
        // Должен вернуть строку (не упасть), содержащую fallback
        expect(typeof result).toBe('string');
        expect(result).toContain('[INVALID:DEPTH_EXCEEDED]');
      });
    });
  });
});

describe('MarketDataSource metadata completeness', () => {
  it('should have sourceToVenue defined for all known sources', () => {
    // POLYGON_RPC не имеет venue (RPC не привязан к venue — это ожидаемо)
    const sourcesWithVenue = [
      KnownMarketDataSources.POLYMARKET_WS,
      KnownMarketDataSources.POLYMARKET_REST,
      KnownMarketDataSources.POLYMARKET_REPLAY,
      KnownMarketDataSources.KALSHI_WS,
      KnownMarketDataSources.KALSHI_REST,
      KnownMarketDataSources.KALSHI_REPLAY,
    ];
    for (const source of sourcesWithVenue) {
      expect(sourceToVenue(source)).toBeDefined();
    }
    // POLYGON_RPC осознанно возвращает undefined
    expect(sourceToVenue(KnownMarketDataSources.POLYGON_RPC)).toBeUndefined();
  });

  it('should have isLiveSource defined for all known sources', () => {
    const allSources = Object.values(KnownMarketDataSources);
    for (const source of allSources) {
      expect(isLiveSource(source)).not.toBeUndefined();
    }
    // Unknown source возвращает undefined
    const unknownSource = 'MY_CUSTOM_SOURCE' as any;
    expect(isLiveSource(unknownSource)).toBeUndefined();
  });

  it('should correctly classify live vs replay sources', () => {
    expect(isLiveSource(KnownMarketDataSources.POLYMARKET_WS)).toBe(true);
    expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REST)).toBe(true);
    expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(false);
    expect(isLiveSource(KnownMarketDataSources.KALSHI_WS)).toBe(true);
    expect(isLiveSource(KnownMarketDataSources.KALSHI_REST)).toBe(true);
    expect(isLiveSource(KnownMarketDataSources.KALSHI_REPLAY)).toBe(false);
    expect(isLiveSource(KnownMarketDataSources.POLYGON_RPC)).toBe(true);
  });

  it('should have isReplaySource as inverse of isLiveSource for known sources', () => {
    const allSources = Object.values(KnownMarketDataSources);
    for (const source of allSources) {
      const live = isLiveSource(source);
      const replay = isReplaySource(source);
      if (live !== undefined && replay !== undefined) {
        expect(live).toBe(!replay);
      }
    }
  });

  it('should have metadata for every key in KnownMarketDataSources (coverage invariant)', () => {
    const allKeys = Object.values(KnownMarketDataSources);
    // Каждый known source должен быть известен isKnownMarketDataSource
    for (const source of allKeys) {
      expect(isKnownMarketDataSource(source)).toBe(true);
    }
    // isLiveSource должен возвращать non-undefined для каждого known source
    for (const source of allKeys) {
      expect(isLiveSource(source)).not.toBeUndefined();
    }
  });
});

describe('validateBrandedId', () => {
  it('should return trimmed valid string', () => {
    expect(validateBrandedId('fill_456', 256)).toBe('fill_456');
    expect(validateBrandedId('  valid  ', 256)).toBe('valid');
  });

  it('should return undefined for empty string after trim', () => {
    expect(validateBrandedId('', 256)).toBeUndefined();
    expect(validateBrandedId('   ', 256)).toBeUndefined();
  });

  it('should return undefined for string exceeding maxLength', () => {
    expect(validateBrandedId('x'.repeat(300), 256)).toBeUndefined();
    expect(validateBrandedId('x'.repeat(257), 256)).toBeUndefined();
    expect(validateBrandedId('x'.repeat(256), 256)).toBe('x'.repeat(256));
  });

  it('should return undefined for string with control characters', () => {
    expect(validateBrandedId('a\u0000b', 256)).toBeUndefined();
    expect(validateBrandedId('a\u001fb', 256)).toBeUndefined();
    expect(validateBrandedId('a\u007fb', 256)).toBeUndefined();
    expect(validateBrandedId('a\u009fb', 256)).toBeUndefined();
  });

  describe('invalid maxLength values', () => {
    it('should return undefined for NaN maxLength', () => {
      expect(validateBrandedId('valid', NaN)).toBeUndefined();
    });

    it('should return undefined for Infinity maxLength', () => {
      expect(validateBrandedId('valid', Infinity)).toBeUndefined();
    });

    it('should return undefined for negative maxLength', () => {
      expect(validateBrandedId('valid', -1)).toBeUndefined();
    });
  });
});

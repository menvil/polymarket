import { describe, it, expect } from '@jest/globals';
import {
  type ConditionRef,
  type OnChainConditionRef,
  type OutcomeIndex,
  type VenueId,
  OutcomeIndexValues,
  KnownChainIds,
  KnownVenues,
  KnownOnChainProtocols,
  AssetIdHelpers,
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  outcomeIndexToString,
  parseOutcomeIndex,
  oppositeOutcome,
  assetIdEquals,
  assetIdToString,
  parseAssetId,
  outcomeKey,
  BinaryOutcome,
  outcomeKeyToIndex,
  indexToOutcomeKey,
  outcomeKeyEquals,
  oppositeOutcomeKey,
  normalizeCurrency,
  asSupportedCurrency,
  currencyEquals,
  parseWalletAddress,
  toChecksumAddress,
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
} from '../src/index.js';

describe('Core IDs', () => {
  describe('ConditionRef', () => {
    describe('OnChainConditionRef', () => {
      it('should create valid on-chain condition ref', () => {
        const conditionRef: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xabc123' as any,
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
          conditionId: '0xabc123' as any,
        };

        const ref2: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xabc123' as any,
        };

        const ref3: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xdifferent' as any,
        };

        expect(conditionRefEquals(ref1, ref2)).toBe(true);
        expect(conditionRefEquals(ref1, ref3)).toBe(false);
      });

      it('should convert on-chain ref to string', () => {
        const ref: ConditionRef = {
          kind: 'ONCHAIN',
          protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
          chainId: KnownChainIds.POLYGON,
          conditionId: '0xabc123' as any,
        };

        const str = conditionRefToString(ref);
        expect(str).toBe('ONCHAIN:POLYMARKET_CTF:137:0xabc123');
      });

      it('should parse on-chain ref from string', () => {
        const str = 'ONCHAIN:POLYMARKET_CTF:137:0xabc123';
        const ref = parseConditionRef(str);

        expect(ref).toBeDefined();
        expect(ref?.kind).toBe('ONCHAIN');
        if (ref?.kind === 'ONCHAIN') {
          expect(ref.protocolId).toBe('POLYMARKET_CTF');
          expect(ref.chainId).toBe(137);
          expect(ref.conditionId).toBe('0xabc123');
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
          conditionId: '0xabc123' as any,
        };

        const offChain: ConditionRef = {
          kind: 'OFFCHAIN',
          venueId: KnownVenues.KALSHI,
          marketId: 'KXBTCUSDM-24APR',
        };

        expect(conditionRefEquals(onChain, offChain)).toBe(false);
      });
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
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xabc123' as any,
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
        conditionId: '0xabc123' as any,
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
        conditionId: '0xabc123' as any,
      };
      const token = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      expect(assetIdToString(token)).toBe('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP');
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
      const token = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP');
      expect(token).toBeDefined();
      expect(token?.type).toBe('OUTCOME_TOKEN');
      if (token?.type === 'OUTCOME_TOKEN') {
        expect(token.outcomeKey).toBe(BinaryOutcome.UP);
        expect(token.conditionRef.kind).toBe('ONCHAIN');
        expect(token.conditionRef.protocolId).toBe('POLYMARKET_CTF');
        expect(token.conditionRef.chainId).toBe(137);
        expect(token.conditionRef.conditionId).toBe('0xabc123');
      }

      // Invalid formats
      expect(parseAssetId('INVALID:FORMAT')).toBeUndefined();
      expect(parseAssetId('CURRENCY:UNKNOWN_CURRENCY')).toBeUndefined();
      expect(parseAssetId('OUTCOME_TOKEN:INVALID')).toBeUndefined();
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
        conditionId: '0xabc123' as any,
      };
      const token = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.DOWN);
      const tokenStr = assetIdToString(token);
      const tokenParsed = parseAssetId(tokenStr);
      expect(assetIdEquals(token, tokenParsed!)).toBe(true);
    });
  });

  describe('OutcomeKey', () => {
    it('should create outcome key from string', () => {
      const upKey = outcomeKey('UP');
      const downKey = outcomeKey('DOWN');
      const customKey = outcomeKey('TEAM_A');

      expect(upKey).toBe('UP');
      expect(downKey).toBe('DOWN');
      expect(customKey).toBe('TEAM_A');
    });

    it('should have binary outcome constants', () => {
      expect(BinaryOutcome.UP).toBe('UP');
      expect(BinaryOutcome.DOWN).toBe('DOWN');
    });

    it('should convert outcome key to index', () => {
      expect(outcomeKeyToIndex(BinaryOutcome.DOWN)).toBe(0);
      expect(outcomeKeyToIndex(BinaryOutcome.UP)).toBe(1);
      expect(outcomeKeyToIndex(outcomeKey('UNKNOWN'))).toBeUndefined();
    });

    it('should convert index to outcome key', () => {
      expect(indexToOutcomeKey(0)).toBe(BinaryOutcome.DOWN);
      expect(indexToOutcomeKey(1)).toBe(BinaryOutcome.UP);
      expect(indexToOutcomeKey(2)).toBeUndefined();
    });

    it('should compare outcome keys', () => {
      const up1 = BinaryOutcome.UP;
      const up2 = outcomeKey('UP');
      const down = BinaryOutcome.DOWN;

      expect(outcomeKeyEquals(up1, up2)).toBe(true);
      expect(outcomeKeyEquals(up1, down)).toBe(false);
    });

    it('should get opposite outcome for binary', () => {
      expect(oppositeOutcomeKey(BinaryOutcome.UP)).toBe(BinaryOutcome.DOWN);
      expect(oppositeOutcomeKey(BinaryOutcome.DOWN)).toBe(BinaryOutcome.UP);
      expect(oppositeOutcomeKey(outcomeKey('CUSTOM'))).toBeUndefined();
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

    it('should convert to checksum address', () => {
      const wallet = parseWalletAddress(testAddr)!;
      const checksum = toChecksumAddress(wallet);

      // Checksum should be mixed case (exact format depends on keccak256)
      expect(checksum).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(checksum.toLowerCase()).toBe(testAddr);
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

    it('should support round-trip: parse -> checksum -> parse', () => {
      const wallet = parseWalletAddress(testAddr)!;
      const checksum = toChecksumAddress(wallet);
      const parsed = parseWalletAddress(checksum)!;

      expect(walletAddressEquals(wallet, parsed)).toBe(true);
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
      const subaccount = accountIdForSubaccount(baseAccount, 'trading');

      expect(subaccount.kind).toBe('SUBACCOUNT');
      expect(isSubaccount(subaccount)).toBe(true);
      if (subaccount.kind === 'SUBACCOUNT') {
        expect(subaccount.base).toEqual(baseAccount);
        expect(subaccount.name).toBe('trading');
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
      const subAcc = accountIdForSubaccount(walletAcc, 'trading');
      expect(accountIdToString(subAcc)).toBe(`sub:wallet:${testWallet}:trading`);
    });

    it('should escape colons in userId and name', () => {
      // Venue account with colon in userId
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
      expect(accountIdToString(venueAcc)).toBe('venue:POLYMARKET:user\\:123');

      // Subaccount with colon in name
      const walletAcc = accountIdFromWallet(testWallet);
      const subAcc = accountIdForSubaccount(walletAcc, 'strategy:main');
      expect(accountIdToString(subAcc)).toContain('strategy\\:main');
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
      const subAcc = accountIdForSubaccount(walletAcc, 'strategy:main');
      const subStr = accountIdToString(subAcc);
      const subParsed = parseAccountId(subStr);
      expect(accountIdEquals(subAcc, subParsed!)).toBe(true);
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
      const subAcc1 = accountIdForSubaccount(walletAcc, 'main');
      const subAcc2 = accountIdForSubaccount(subAcc1, 'strategy_a');

      const str = accountIdToString(subAcc2);
      expect(str).toContain('sub:sub:wallet');

      const parsed = parseAccountId(str);
      expect(accountIdEquals(subAcc2, parsed!)).toBe(true);
    });

    it('should use type guards correctly', () => {
      const walletAcc = accountIdFromWallet(testWallet);
      const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
      const subAcc = accountIdForSubaccount(walletAcc, 'trading');

      expect(isWalletAccount(walletAcc)).toBe(true);
      expect(isWalletAccount(venueAcc)).toBe(false);
      expect(isWalletAccount(subAcc)).toBe(false);

      expect(isVenueAccount(venueAcc)).toBe(true);
      expect(isVenueAccount(walletAcc)).toBe(false);

      expect(isSubaccount(subAcc)).toBe(true);
      expect(isSubaccount(walletAcc)).toBe(false);
    });
  });
});

/**
 * Core ID types - фундаментальные идентификаторы домена
 *
 * @packageDocumentation
 */

// Currency
export type { SupportedCurrency } from './Currency.js';
export {
  SUPPORTED_CURRENCIES,
  KnownCurrencies,
  isSupportedCurrency,
  normalizeCurrency,
  asSupportedCurrency,
  currencyEquals,
} from './Currency.js';

// Protocol, Chain, Condition
export type { OnChainProtocolId, ProtocolId } from './ProtocolId.js';
export {
  isKnownOnChainProtocol,
  isKnownProtocol,
  KnownOnChainProtocols,
} from './ProtocolId.js';

export type { ChainId } from './ChainId.js';
export { KnownChainIds, getChainName } from './ChainId.js';

export type { ConditionId } from './ConditionId.js';
export { isValidConditionId } from './ConditionId.js';

export type { ConditionRef, OnChainConditionRef, OffChainConditionRef } from './ConditionRef.js';
export {
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  isOnChainConditionRef,
  isOffChainConditionRef,
} from './ConditionRef.js';

// Outcome
export type { OutcomeIndex } from './OutcomeIndex.js';
export {
  OutcomeIndex as OutcomeIndexValues,
  isValidOutcomeIndex,
  oppositeOutcome,
  outcomeIndexToString,
  parseOutcomeIndex,
} from './OutcomeIndex.js';

export type { OutcomeKey } from './OutcomeKey.js';
export {
  outcomeKey,
  BinaryOutcome,
  outcomeKeyToIndex,
  indexToOutcomeKey,
  outcomeKeyEquals,
  oppositeOutcome as oppositeOutcomeKey,
} from './OutcomeKey.js';

// Account & Wallet
export type { WalletAddress } from './WalletAddress.js';
export {
  isValidWalletAddress,
  normalizeWalletAddress,
  parseWalletAddress,
  toChecksumAddress,
  walletAddressEquals,
  walletAddressToString,
} from './WalletAddress.js';

export type { AccountId } from './AccountId.js';
export {
  accountIdFromWallet,
  accountIdFromVenue,
  accountIdForSubaccount,
  accountIdToString,
  parseAccountId,
  accountIdEquals,
  isWalletAccount,
  isVenueAccount,
  isSubaccount,
} from './AccountId.js';

// Venue
export type { VenueId } from './VenueId.js';
export { KnownVenues, isKnownVenue } from './VenueId.js';

// Asset
export type { AssetId } from './AssetId.js';
export {
  AssetId as AssetIdHelpers,
  assetIdEquals,
  assetIdToString,
  parseAssetId,
  isCurrencyAsset,
  isOutcomeTokenAsset,
} from './AssetId.js';

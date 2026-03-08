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
export type { OnChainProtocolId } from './ProtocolId.js';
export {
  isKnownOnChainProtocol,
  KnownOnChainProtocols,
  asOnChainProtocolId,
} from './ProtocolId.js';

export type { ChainId } from './ChainId.js';
export { KnownChainIds, getChainName, isValidChainId, chainId, parseChainId } from './ChainId.js';

export type { ConditionId } from './ConditionId.js';
export { isValidConditionId, parseConditionId, normalizeConditionId } from './ConditionId.js';

export type { ConditionRef, OnChainConditionRef, OffChainConditionRef } from './ConditionRef.js';
export {
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  isOnChainConditionRef,
  isOffChainConditionRef,
} from './ConditionRef.js';

// Outcome
export type { OutcomeKey } from './OutcomeKey.js';
export {
  parseOutcomeKey,
  BinaryOutcome,
  outcomeKeyToIndex,
  indexToOutcomeKey,
  outcomeKeyEquals,
  oppositeOutcomeKey,
} from './OutcomeKey.js';
// Note: unsafeOutcomeKey intentionally NOT exported (marked @internal, bypasses validation)

// Account & Wallet
export type { WalletAddress } from './WalletAddress.js';
export {
  isValidWalletAddressFormat,
  parseWalletAddress,
  walletAddressEquals,
  walletAddressToString,
} from './WalletAddress.js';

export type { AccountId, ParseAccountIdOptions } from './AccountId.js';
export {
  AccountIdDepthError,
  AccountIdValidationError,
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
} from './AccountId.js';

// Venue
export type { VenueId } from './VenueId.js';
export { KnownVenues, isKnownVenue, asVenueId } from './VenueId.js';

// Asset
export type { AssetId } from './AssetId.js';
export {
  AssetId as AssetIdHelpers,
  AssetIdValidationError,
  assetIdToString,
  parseAssetId,
  asPolymarketCtfToken,
  isCurrencyAsset,
  isOutcomeTokenAsset,
  isPolymarketCtfToken,
} from './AssetId.js';

// Blockchain
export type { TxHash } from './TxHash.js';
export { asTxHash } from './TxHash.js';

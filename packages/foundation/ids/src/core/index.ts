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

// Outcome - Primary API (используй это)
export type { OutcomeKey } from './OutcomeKey.js';
export {
  unsafeOutcomeKey,
  parseOutcomeKey,
  BinaryOutcome,
  outcomeKeyToIndex,
  indexToOutcomeKey,
  outcomeKeyEquals,
  oppositeOutcomeKey,
  oppositeOutcome, // @deprecated - используй oppositeOutcomeKey
} from './OutcomeKey.js';

// Outcome - Legacy API (deprecated, только для on-chain адаптеров)
/**
 * @deprecated OutcomeIndex устарел. Используй OutcomeKey (BinaryOutcome.UP/DOWN) в core/domain коде.
 * OutcomeIndex оставлен только для on-chain адаптеров.
 */
export type { OutcomeIndex } from './OutcomeIndex.js';
/**
 * @deprecated OutcomeIndex устарел. Используй OutcomeKey (BinaryOutcome.UP/DOWN) в core/domain коде.
 */
export {
  OutcomeIndex as OutcomeIndexValues,
  isValidOutcomeIndex,
  oppositeOutcomeIndex,
  outcomeIndexToString,
  parseOutcomeIndex,
} from './OutcomeIndex.js';

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

export type { AccountId, ParseAccountIdOptions } from './AccountId.js';
export {
  AccountIdDepthError,
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
  assetIdEquals,
  assetIdToString,
  parseAssetId,
  isCurrencyAsset,
  isOutcomeTokenAsset,
} from './AssetId.js';

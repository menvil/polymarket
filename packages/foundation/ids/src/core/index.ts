/**
 * Core ID types - фундаментальные идентификаторы домена
 *
 * @packageDocumentation
 */

// Protocol, Chain, Condition
export type { ProtocolId } from './ProtocolId.js';
export { isKnownProtocol } from './ProtocolId.js';

export type { ChainId } from './ChainId.js';
export { KnownChainIds, getChainName } from './ChainId.js';

export type { ConditionId } from './ConditionId.js';
export { isValidConditionId } from './ConditionId.js';

export type { ConditionRef } from './ConditionRef.js';
export {
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
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

// Account & Wallet
export type { WalletAddress } from './WalletAddress.js';
export { isValidWalletAddress, normalizeWalletAddress } from './WalletAddress.js';

export type { AccountId } from './AccountId.js';
export {
  accountIdFromWallet,
  accountIdFromVenue,
  accountIdForSubaccount,
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
  isCurrencyAsset,
  isOutcomeTokenAsset,
} from './AssetId.js';

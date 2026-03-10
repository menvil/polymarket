/**
 * Core ID types - фундаментальные идентификаторы домена
 *
 * @packageDocumentation
 */
export { SUPPORTED_CURRENCIES, KnownCurrencies, isSupportedCurrency, normalizeCurrency, asSupportedCurrency, currencyEquals, } from './Currency.js';
export { isKnownOnChainProtocol, KnownOnChainProtocols, asOnChainProtocolId, } from './ProtocolId.js';
export { KnownChainIds, getChainName, isValidChainId, chainId, parseChainId } from './ChainId.js';
export { isValidConditionId, parseConditionId, normalizeConditionId } from './ConditionId.js';
export { conditionRefEquals, conditionRefToString, parseConditionRef, isOnChainConditionRef, isOffChainConditionRef, } from './ConditionRef.js';
export { parseOutcomeKey, BinaryOutcome, outcomeKeyToIndex, indexToOutcomeKey, outcomeKeyEquals, oppositeOutcomeKey, } from './OutcomeKey.js';
export { isValidWalletAddressFormat, parseWalletAddress, walletAddressEquals, walletAddressToString, } from './WalletAddress.js';
export { AccountIdDepthError, AccountIdValidationError, accountIdFromWallet, accountIdFromVenue, accountIdForSubaccount, accountIdToString, parseAccountId, accountIdEquals, isWalletAccount, isVenueAccount, isSubaccount, getSubaccountDepth, } from './AccountId.js';
export { KnownVenues, isKnownVenue, asVenueId } from './VenueId.js';
export { AssetId as AssetIdHelpers, AssetIdValidationError, assetIdToString, parseAssetId, asPolymarketCtfToken, isCurrencyAsset, isOutcomeTokenAsset, isPolymarketCtfToken, } from './AssetId.js';
// unsafeTxHash экспортируется намеренно: нужен в serializer/mapper слоях,
// где строка уже прошла валидацию и повторный парсинг — лишние аллокации.
// В отличие от unsafeOutcomeKey (только @internal use), TxHash часто
// десериализуется из доверенных DB/event-store источников.
export { asTxHash, unsafeTxHash } from './TxHash.js';
//# sourceMappingURL=index.js.map
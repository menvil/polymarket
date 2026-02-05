/**
 * ChainId - идентификатор blockchain сети
 *
 * @remarks
 * Branded type для type safety.
 * Представляет EVM chain ID.
 *
 * Известные chain IDs:
 * - 1: Ethereum Mainnet
 * - 137: Polygon (Polymarket)
 * - 8453: Base
 *
 * @example
 * ```typescript
 * const polygonChainId = 137 as ChainId;
 * const mainnetChainId = 1 as ChainId;
 * ```
 */
export type ChainId = number & { readonly __brand: 'ChainId' };

/**
 * Известные chain IDs
 */
export const KnownChainIds = {
  ETHEREUM_MAINNET: 1 as ChainId,
  POLYGON: 137 as ChainId,
  BASE: 8453 as ChainId,
} as const;

/**
 * Получить имя сети по chain ID
 */
export function getChainName(chainId: ChainId): string {
  switch (chainId) {
    case KnownChainIds.ETHEREUM_MAINNET:
      return 'Ethereum Mainnet';
    case KnownChainIds.POLYGON:
      return 'Polygon';
    case KnownChainIds.BASE:
      return 'Base';
    default:
      return `Chain ${chainId}`;
  }
}

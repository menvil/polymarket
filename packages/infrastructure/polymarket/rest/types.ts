/**
 * Polymarket REST API types
 *
 * @remarks
 * Common types for Polymarket REST implementation.
 */

/**
 * Polymarket L2 API credentials
 */
export interface PolymarketL2Credentials {
  /** API key (UUID format) */
  apiKey: string;

  /** API secret (base64url encoded - may contain - and _ characters) */
  secret: string;

  /** API passphrase (hex string) */
  passphrase: string;
}

/**
 * Signature type for Polymarket orders
 *
 * @remarks
 * Determines which type of wallet is used for signing:
 * - EOA (0): Standard Ethereum account (MetaMask, hardware wallet)
 * - POLY_PROXY (1): Polymarket proxy wallet (when using funder address)
 * - POLY_GNOSIS_SAFE (2): Gnosis Safe multisig
 */
export enum SignatureType {
  /** Standard EOA (Externally Owned Account) */
  EOA = 0,
  /** Polymarket proxy wallet (funder address) */
  POLY_PROXY = 1,
  /** Gnosis Safe multisig */
  POLY_GNOSIS_SAFE = 2,
}

/**
 * Polymarket REST Client configuration
 */
export interface PolymarketRestConfig {
  /** Base URL for CLOB API */
  baseUrl: string;

  /** Private key for signing requests */
  privateKey: string;

  /** Chain ID (137 for Polygon) */
  chainId: number;

  /** L2 API credentials (apiKey, secret, passphrase) */
  l2Credentials?: PolymarketL2Credentials;

  /**
   * Signature type for wallet
   *
   * @remarks
   * Use POLY_PROXY (1) when using funder address (proxy wallet).
   * Use EOA (0) for standard wallets.
   *
   * @default SignatureType.EOA (0)
   */
  signatureType?: SignatureType;

  /**
   * Funder address (for proxy wallets)
   *
   * @remarks
   * When using POLY_PROXY signature type, this is the maker/funder address.
   * If not specified, wallet address is used.
   */
  funderAddress?: string;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Max retry attempts */
  maxRetries?: number;

  /** Retry delay in milliseconds */
  retryDelay?: number;
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  /** Error message */
  error: string;

  /** Error code */
  code?: string;

  /** Additional details */
  details?: unknown;
}

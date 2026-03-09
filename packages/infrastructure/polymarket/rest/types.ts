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
  /** API ключ (формат UUID) */
  apiKey: string;

  /** API секрет (base64url — может содержать символы - и _) */
  secret: string;

  /** API пароль (hex-строка) */
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
  /** Стандартный EOA (Externally Owned Account) */
  EOA = 0,
  /** Proxy-кошелёк Polymarket (адрес фандера) */
  POLY_PROXY = 1,
  /** Gnosis Safe мультиподпись */
  POLY_GNOSIS_SAFE = 2,
}

/**
 * Polymarket REST Client configuration
 */
export interface PolymarketRestConfig {
  /** Базовый URL для CLOB API */
  baseUrl: string;

  /** Приватный ключ для подписи запросов */
  privateKey: string;

  /** ID сети (137 для Polygon) */
  chainId: number;

  /** L2 API учётные данные (apiKey, secret, passphrase) */
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

  /** Таймаут запроса в миллисекундах */
  timeout?: number;

  /** Максимальное количество повторных попыток */
  maxRetries?: number;

  /** Задержка повтора в миллисекундах */
  retryDelay?: number;
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  /** Сообщение об ошибке */
  error: string;

  /** Код ошибки */
  code?: string;

  /** Дополнительные детали */
  details?: unknown;
}

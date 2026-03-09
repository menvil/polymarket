/**
 * Polymarket L2 Authenticator
 *
 * @remarks
 * Handles L2 authentication for Polymarket CLOB API.
 * Uses HMAC-SHA256 to sign requests with API credentials.
 *
 * Authentication flow (matching official Polymarket client):
 * 1. Create signature string: timestamp + method + requestPath + body
 * 2. Decode secret from base64url using Buffer.from(secret, 'base64url')
 * 3. Sign with HMAC-SHA256 using decoded secret key
 * 4. Return signature as base64url (digest('base64url'))
 * 5. Add headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
 *
 * @example
 * ```typescript
 * const auth = new PolymarketL2Authenticator({
 *   apiKey: '550e8400-e29b-41d4-a716-446655440000',
 *   secret: 'L-VjT8weg_KHTYkU1gPqCXGpgk8VuZ0mtizM8KObMV0=', // base64url
 *   passphrase: 'c72eb0fad6f390d26d5e322baeebb084bce0ddcc0893d58efdad23dbd991b6bc',
 * }, address);
 *
 * const headers = auth.createAuthHeaders('GET', '/balance-allowance', '');
 * // Headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
 * ```
 */

import { createHmac } from 'crypto';
import type { PolymarketL2Credentials } from '../types.js';

/**
 * Polymarket L2 Authenticator
 */
export class PolymarketL2Authenticator {
  private readonly credentials: PolymarketL2Credentials;
  private readonly address: string;

  /**
   * Create L2 authenticator
   *
   * @param credentials - L2 API credentials (apiKey, secret, passphrase)
   * @param address - Wallet address (0x...)
   *
   * @example
   * ```typescript
   * const auth = new PolymarketL2Authenticator({
   *   apiKey: process.env.POLYMARKET_API_KEY!,
   *   secret: process.env.POLYMARKET_API_SECRET!,
   *   passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
   * }, walletAddress);
   * ```
   */
  constructor(credentials: PolymarketL2Credentials, address: string) {
    this.credentials = credentials;
    this.address = address;
  }

  /**
   * Create authentication headers for L2 requests
   *
   * @param method - HTTP method (GET, POST, DELETE, etc.)
   * @param requestPath - Request path (e.g., '/balance-allowance')
   * @param body - Request body (empty string for GET requests)
   * @returns Authentication headers
   *
   * @remarks
   * Creates HMAC-SHA256 signature:
   * - Message: timestamp + method + requestPath + body
   * - Key: secret (base64 decoded)
   * - Signature: base64 encoded HMAC
   *
   * @example
   * ```typescript
   * // GET request
   * const headers = auth.createAuthHeaders('GET', '/balance-allowance', '');
   *
   * // POST request
   * const body = JSON.stringify({ tokenId: '0x123', side: 'BUY' });
   * const headers = auth.createAuthHeaders('POST', '/order', body);
   * ```
   */
  createAuthHeaders(
    method: string,
    requestPath: string,
    body: string
  ): Record<string, string> {
    // ВАЖНО: Timestamp должен быть в СЕКУНДАХ, не миллисекундах!
    // Официальный клиент использует: Math.floor(Date.now() / 1000)
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Создаём строку сообщения для подписи: timestamp + method + requestPath + body
    const message = timestamp + method + requestPath + body;

    // Подписываем с HMAC-SHA256
    const signature = this.sign(message);

    return {
      POLY_ADDRESS: this.address,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_API_KEY: this.credentials.apiKey,
      POLY_PASSPHRASE: this.credentials.passphrase,
    };
  }

  /**
   * Sign message with HMAC-SHA256
   *
   * @param message - Message to sign
   * @returns Base64url encoded signature
   *
   * @remarks
   * HMAC-SHA256 signature (matching official Polymarket client):
   * 1. Decode secret from base64url (Node.js Buffer handles url-safe alphabet natively)
   * 2. Create HMAC with decoded secret key
   * 3. Digest and return as base64url
   *
   * @example
   * ```typescript
   * const message = '1234567890GET/balance-allowance';
   * const signature = auth.sign(message);
   * // Returns: base64url encoded HMAC signature
   * ```
   */
  private sign(message: string): string {
    // Декодируем секрет из base64url — Buffer нативно поддерживает url-safe алфавит
    const secretBuffer = Buffer.from(this.credentials.secret, 'base64url');

    // Создаём HMAC-SHA256 и возвращаем как base64url
    const hmac = createHmac('sha256', secretBuffer);
    hmac.update(message);
    return hmac.digest('base64url');
  }

  /**
   * Get API key
   *
   * @returns API key
   */
  getApiKey(): string {
    return this.credentials.apiKey;
  }

  /**
   * Get address
   *
   * @returns Wallet address
   */
  getAddress(): string {
    return this.address;
  }
}

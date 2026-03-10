/**
 * L2-аутентификатор Polymarket
 *
 * @remarks
 * Обрабатывает L2-аутентификацию для CLOB API Polymarket.
 * Использует HMAC-SHA256 для подписи запросов с API-учётными данными.
 *
 * Алгоритм аутентификации (соответствует официальному клиенту Polymarket):
 * 1. Создаём строку подписи: timestamp + method + requestPath + body
 * 2. Декодируем секрет из base64url с помощью Buffer.from(secret, 'base64url')
 * 3. Подписываем с HMAC-SHA256 используя декодированный секретный ключ
 * 4. Возвращаем подпись как base64url (digest('base64url'))
 * 5. Добавляем заголовки: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
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
 * // Заголовки: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
 * ```
 */

import { createHmac } from 'crypto';
import type { PolymarketL2Credentials } from '../types.js';

/**
 * L2-аутентификатор Polymarket
 */
export class PolymarketL2Authenticator {
  private readonly credentials: PolymarketL2Credentials;
  private readonly address: string;

  /**
   * Создать L2-аутентификатор
   *
   * @param credentials - L2 API-учётные данные (apiKey, secret, passphrase)
   * @param address - Адрес кошелька (0x...)
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
   * Создать заголовки аутентификации для L2-запросов
   *
   * @param method - HTTP-метод (GET, POST, DELETE и т.д.)
   * @param requestPath - Путь запроса (например, '/balance-allowance')
   * @param body - Тело запроса (пустая строка для GET-запросов)
   * @returns Заголовки аутентификации
   *
   * @remarks
   * Создаёт подпись HMAC-SHA256:
   * - Сообщение: timestamp + method + requestPath + body
   * - Ключ: secret (декодированный из base64)
   * - Подпись: HMAC в кодировке base64
   *
   * @example
   * ```typescript
   * // GET-запрос
   * const headers = auth.createAuthHeaders('GET', '/balance-allowance', '');
   *
   * // POST-запрос
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
   * Подписать сообщение с HMAC-SHA256
   *
   * @param message - Сообщение для подписи
   * @returns Подпись в кодировке base64url
   *
   * @remarks
   * Подпись HMAC-SHA256 (соответствует официальному клиенту Polymarket):
   * 1. Декодируем секрет из base64url (Node.js Buffer нативно поддерживает url-safe алфавит)
   * 2. Создаём HMAC с декодированным секретным ключом
   * 3. Формируем дайджест и возвращаем как base64url
   *
   * @example
   * ```typescript
   * const message = '1234567890GET/balance-allowance';
   * const signature = auth.sign(message);
   * // Возвращает: HMAC-подпись в кодировке base64url
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
   * Получить API-ключ
   *
   * @returns API-ключ
   */
  getApiKey(): string {
    return this.credentials.apiKey;
  }

  /**
   * Получить адрес кошелька
   *
   * @returns Адрес кошелька
   */
  getAddress(): string {
    return this.address;
  }
}

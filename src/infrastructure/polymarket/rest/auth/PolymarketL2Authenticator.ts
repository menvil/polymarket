/**
 * Аутентификатор Polymarket L2
 *
 * @remarks
 * Обрабатывает L2 аутентификацию для Polymarket CLOB API.
 * Использует HMAC-SHA256 для подписи запросов с учетными данными API.
 *
 * Процесс аутентификации (соответствует официальному клиенту Polymarket):
 * 1. Создать строку подписи: timestamp + method + requestPath + body
 * 2. Предобработать секрет: base64url → base64 (заменить - на +, _ на /)
 * 3. Подписать с помощью HMAC-SHA256 используя декодированный из base64 секрет
 * 4. Закодировать подпись в base64url (заменить + на -, / на _)
 * 5. Добавить заголовки: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
 *
 * @example
 * ```typescript
 * const auth = new PolymarketL2Authenticator({
 *   apiKey: 'apiKey',
 *   secret: 'secret', // base64url
 *   passphrase: 'passphrase',
 * }, address);
 *
 * const headers = auth.createAuthHeaders('GET', '/balance-allowance', '');
 * // Заголовки: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
 * ```
 */

import { createHmac } from 'crypto';
import type { PolymarketL2Credentials } from '../types.js';

/**
 * Аутентификатор Polymarket L2
 */
export class PolymarketL2Authenticator {
  private readonly credentials: PolymarketL2Credentials;
  private readonly address: string;

  /**
   * Создать L2 аутентификатор
   *
   * @param credentials - Учетные данные L2 API (apiKey, secret, passphrase)
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
   * Создать заголовки аутентификации для L2 запросов
   *
   * @param method - HTTP метод (GET, POST, DELETE, и т.д.)
   * @param requestPath - Путь запроса (например, '/balance-allowance')
   * @param body - Тело запроса (пустая строка для GET запросов)
   * @returns Заголовки аутентификации
   *
   * @remarks
   * Создает HMAC-SHA256 подпись:
   * - Сообщение: timestamp + method + requestPath + body
   * - Ключ: secret (декодированный из base64)
   * - Подпись: закодированный в base64 HMAC
   *
   * @example
   * ```typescript
   * // GET запрос
   * const headers = auth.createAuthHeaders('GET', '/balance-allowance', '');
   *
   * // POST запрос
   * const body = JSON.stringify({ tokenId: '0x123', side: 'BUY' });
   * const headers = auth.createAuthHeaders('POST', '/order', body);
   * ```
   */
  createAuthHeaders(
    method: string,
    requestPath: string,
    body: string
  ): Record<string, string> {
    // ВАЖНО: Временная метка должна быть в СЕКУНДАХ, а не миллисекундах!
    // Официальный клиент использует: Math.floor(Date.now() / 1000)
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Создать сообщение подписи: timestamp + method + requestPath + body
    const message = timestamp + method + requestPath + body;

    // Подписать с помощью HMAC-SHA256
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
   * Подписать сообщение с помощью HMAC-SHA256
   *
   * @param message - Сообщение для подписи
   * @returns Подпись закодированная в base64url
   *
   * @remarks
   * HMAC-SHA256 подпись (соответствует официальному клиенту Polymarket):
   * 1. Предобработать секрет: base64url → base64 (заменить - на +, _ на /)
   * 2. Декодировать секрет из base64
   * 3. Создать HMAC с секретом
   * 4. Обновить с сообщением
   * 5. Вычислить хеш и закодировать в base64url (заменить + на -, / на _)
   *
   * @example
   * ```typescript
   * const message = '1234567890GET/balance-allowance';
   * const signature = auth.sign(message);
   * // Возвращает: закодированную в base64url HMAC подпись
   * ```
   */
  private sign(message: string): string {
    // Предобработать секрет: base64url → base64
    // Заменить - на + и _ на / (base64url в стандартный base64)
    let secret = this.credentials.secret;
    secret = secret.replace(/-/g, '+').replace(/_/g, '/');

    // Декодировать секрет из base64
    const secretBuffer = Buffer.from(secret, 'base64');

    // Создать HMAC-SHA256
    const hmac = createHmac('sha256', secretBuffer);
    hmac.update(message);

    // Вычислить хеш в base64
    let signature = hmac.digest('base64');

    // Конвертировать в base64url: заменить + на -, / на _
    signature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    return signature;
  }

  /**
   * Получить API ключ
   *
   * @returns API ключ
   */
  getApiKey(): string {
    return this.credentials.apiKey;
  }

  /**
   * Получить адрес
   *
   * @returns Адрес кошелька
   */
  getAddress(): string {
    return this.address;
  }
}

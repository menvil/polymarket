/**
 * Подписант запросов Polymarket
 *
 * @remarks
 * Подписывает HTTP запросы для Polymarket CLOB API используя приватный ключ.
 * Использует Wallet из ethers.js для ECDSA подписи.
 *
 * Процесс подписи:
 * 1. Кодировать данные запроса (параметры ордера, параметры отмены и т.д.)
 * 2. Подписать сообщение приватным ключом (ECDSA)
 * 3. Вернуть hex-строку подписи
 *
 * @example
 * ```typescript
 * const signer = new PolymarketSigner(privateKey, chainId);
 *
 * const signature = await signer.signOrderData({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: '0.52',
 *   size: '100',
 *   nonce: Date.now(),
 * });
 *
 * // Использовать подпись в заголовках или теле API запроса
 * ```
 */

import { ethers } from 'ethers';

/**
 * Подписант запросов Polymarket
 */
export class PolymarketSigner {
  private readonly wallet: ethers.Wallet;
  private readonly chainId: number;

  /**
   * Создать подписанта Polymarket
   *
   * @param privateKey - Приватный ключ для подписи (hex-строка с префиксом 0x или без него)
   * @param chainId - ID сети (137 для Polygon)
   *
   * @throws {Error} Если приватный ключ недействителен
   *
   * @example
   * ```typescript
   * const signer = new PolymarketSigner(process.env.PRIVATE_KEY!, 137);
   * ```
   */
  constructor(privateKey: string, chainId: number) {
    this.wallet = new ethers.Wallet(privateKey);
    this.chainId = chainId;
  }

  /**
   * Подписать данные ордера
   *
   * @param orderData - Данные ордера для подписи
   * @returns Hex-строка подписи
   *
   * @throws {Error} Если подпись не удалась
   *
   * @remarks
   * В продакшене это должно использовать подпись типизированных данных EIP-712.
   * В настоящее время использует простую подпись сообщения для демонстрации.
   *
   * @example
   * ```typescript
   * const signature = await signer.signOrderData({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: '0.52',
   *   size: '100',
   *   nonce: Date.now(),
   * });
   * ```
   */
  async signOrderData(orderData: Record<string, unknown>): Promise<string> {
    const message = this.encodeOrderData(orderData);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  /**
   * Подписать данные отмены ордера
   *
   * @param cancelData - Данные отмены для подписи
   * @returns Hex-строка подписи
   *
   * @throws {Error} Если подпись не удалась
   *
   * @example
   * ```typescript
   * const signature = await signer.signCancelData({
   *   orderId: 'order-123',
   *   timestamp: Date.now(),
   * });
   * ```
   */
  async signCancelData(cancelData: Record<string, unknown>): Promise<string> {
    const message = this.encodeCancelData(cancelData);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  /**
   * Подписать универсальные данные запроса
   *
   * @param data - Данные для подписи
   * @returns Hex-строка подписи
   *
   * @throws {Error} Если подпись не удалась
   *
   * @remarks
   * Универсальный метод подписи для любых данных запроса.
   *
   * @example
   * ```typescript
   * const signature = await signer.signData({ foo: 'bar' });
   * ```
   */
  async signData(data: Record<string, unknown>): Promise<string> {
    const message = JSON.stringify(data);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  /**
   * Получить адрес кошелька
   *
   * @returns Адрес кошелька (0x...)
   *
   * @example
   * ```typescript
   * const address = signer.getAddress();
   * console.log(`Address: ${address}`);
   * ```
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Получить ID сети
   *
   * @returns ID сети
   */
  getChainId(): number {
    return this.chainId;
  }

  /**
   * Получить экземпляр кошелька
   *
   * @returns Экземпляр Ethers Wallet для подписи EIP-712
   *
   * @example
   * ```typescript
   * const wallet = signer.getWallet();
   * const signature = await wallet.signTypedData(domain, types, value);
   * ```
   */
  getWallet(): ethers.Wallet {
    return this.wallet;
  }

  /**
   * Кодировать данные ордера для подписи
   *
   * @param orderData - Данные ордера
   * @returns Закодированная строка сообщения
   *
   * @remarks
   * В продакшене это должно использовать кодирование типизированных данных EIP-712.
   * В настоящее время использует простое JSON кодирование для демонстрации.
   */
  private encodeOrderData(orderData: Record<string, unknown>): string {
    // TODO: Реализовать кодирование типизированных данных EIP-712 в продакшене
    // Пока используем простое JSON кодирование
    return JSON.stringify(orderData);
  }

  /**
   * Кодировать данные отмены для подписи
   *
   * @param cancelData - Данные отмены
   * @returns Закодированная строка сообщения
   */
  private encodeCancelData(cancelData: Record<string, unknown>): string {
    // TODO: Реализовать кодирование типизированных данных EIP-712 в продакшене
    return JSON.stringify(cancelData);
  }
}

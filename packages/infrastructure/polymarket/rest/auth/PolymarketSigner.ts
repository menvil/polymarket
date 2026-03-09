/**
 * Polymarket Request Signer
 *
 * @remarks
 * Signs HTTP requests for Polymarket CLOB API using private key.
 * Uses ethers.js Wallet for ECDSA signing.
 *
 * Signing flow:
 * 1. Encode request data (order params, cancel params, etc.)
 * 2. Sign message with private key (ECDSA)
 * 3. Return signature hex string
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
 * // Use signature in API request headers or body
 * ```
 */

import { ethers } from 'ethers';

/**
 * Polymarket request signer
 */
export class PolymarketSigner {
  private readonly wallet: ethers.Wallet;
  private readonly chainId: number;

  /**
   * Create Polymarket signer
   *
   * @param privateKey - Private key for signing (hex string with or without 0x prefix)
   * @param chainId - Chain ID (137 for Polygon)
   *
   * @throws {Error} If private key is invalid
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
   * Sign order data
   *
   * @param orderData - Order data to sign
   * @returns Signature hex string
   *
   * @throws {Error} If signing fails
   *
   * @remarks
   * In production, this should use EIP-712 typed data signing.
   * Currently uses simple message signing for demonstration.
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
   * Sign cancel order data
   *
   * @param cancelData - Cancel data to sign
   * @returns Signature hex string
   *
   * @throws {Error} If signing fails
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
   * Sign generic request data
   *
   * @param data - Data to sign
   * @returns Signature hex string
   *
   * @throws {Error} If signing fails
   *
   * @remarks
   * Generic signing method for any request data.
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
   * Get wallet address
   *
   * @returns Wallet address (0x...)
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
   * Get chain ID
   *
   * @returns Chain ID
   */
  getChainId(): number {
    return this.chainId;
  }

  /**
   * Get wallet instance
   *
   * @returns Ethers Wallet instance for EIP-712 signing
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
   * Encode order data for signing
   *
   * @param orderData - Order data
   * @returns Encoded message string
   *
   * @remarks
   * In production, this should use EIP-712 typed data encoding.
   * Currently uses simple JSON encoding for demonstration.
   */
  private encodeOrderData(orderData: Record<string, unknown>): string {
    // TODO: Реализовать EIP-712 typed data encoding в production
    // Пока используем простое JSON-кодирование
    return JSON.stringify(orderData);
  }

  /**
   * Encode cancel data for signing
   *
   * @param cancelData - Cancel data
   * @returns Encoded message string
   */
  private encodeCancelData(cancelData: Record<string, unknown>): string {
    // TODO: Реализовать EIP-712 typed data encoding в production
    return JSON.stringify(cancelData);
  }
}

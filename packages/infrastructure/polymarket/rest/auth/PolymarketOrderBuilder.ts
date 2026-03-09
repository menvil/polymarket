/**
 * Polymarket Order Builder
 *
 * @remarks
 * Builds EIP-712 signed orders for Polymarket CLOB API.
 *
 * Order structure:
 * - salt: Random number for uniqueness
 * - maker: Funder address (who provides liquidity)
 * - signer: Signing address (EOA that signs)
 * - taker: Zero address (anyone can take)
 * - tokenId: Outcome token ID
 * - makerAmount: Amount maker spends (in minimum units)
 * - takerAmount: Amount taker pays (in minimum units)
 * - expiration: Unix timestamp (0 = no expiration)
 * - nonce: Current exchange nonce
 * - feeRateBps: Fee rate in basis points
 * - side: 0 = BUY, 1 = SELL
 * - signatureType: Signature type (EOA, POLY_PROXY, etc.)
 * - signature: EIP-712 signature
 *
 * @example
 * ```typescript
 * const builder = new PolymarketOrderBuilder(signer, chainId, makerAddress);
 *
 * const signedOrder = await builder.buildOrder({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 *   feeRateBps: 0,
 *   nonce: 123,
 * });
 *
 * // Use signedOrder in POST /order request
 * ```
 */

import type { Wallet } from 'ethers';
import type { SignatureType } from '../types.js';

/**
 * Order parameters for building
 */
export interface BuildOrderParams {
  /** Token ID */
  tokenId: string;

  /** Order side */
  side: 'BUY' | 'SELL';

  /** Price (0-1) */
  price: number;

  /** Size (number of shares) */
  size: number;

  /** Fee rate in basis points */
  feeRateBps: number;

  /** Exchange nonce */
  nonce: number;

  /** Expiration timestamp (0 = no expiration) */
  expiration?: number;

  /** Price tick size for rounding (default: 0.01) */
  priceTick?: number;
}

/**
 * Signed order (ready for API)
 */
export interface SignedOrder {
  salt: number; // Number (not string!)
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: 'BUY' | 'SELL'; // String "BUY"/"SELL" (not "0"/"1"!)
  signatureType: number; // Number (not string!)
  signature: string;
}

/**
 * Contract addresses by chain ID
 */
const CONTRACT_ADDRESSES: Record<number, string> = {
  137: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Polygon Mainnet
  80002: '0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40', // Amoy Testnet
};

/**
 * EIP-712 Order type
 */
const ORDER_TYPE = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

/**
 * Polymarket Order Builder
 */
export class PolymarketOrderBuilder {
  private readonly ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  constructor(
    private readonly signer: Wallet,
    private readonly chainId: number,
    private readonly makerAddress: string,
    private readonly signatureType: SignatureType
  ) {}

  /**
   * Build and sign order
   *
   * @param params - Order parameters
   * @returns Signed order ready for API
   *
   * @example
   * ```typescript
   * const signedOrder = await builder.buildOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   *   feeRateBps: 0,
   *   nonce: 123,
   * });
   * ```
   */
  async buildOrder(params: BuildOrderParams): Promise<SignedOrder> {
    // Generate random salt
    const salt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    // CRITICAL: Determine price tick size
    // If not provided, use safe default (0.001)
    const priceTick = params.priceTick ?? this.inferPriceTick(params.price);

    // Round price to tick size (avoid floating-point errors)
    // API requirement: "Price (0.588) breaks minimum tick size rule: 0.01"
    const tickMultiplier = 1 / priceTick; // 0.001 → 1000, 0.01 → 100
    const priceRounded = Math.round(params.price * tickMultiplier) / tickMultiplier;

    // ✅ v7.7.15: DEBUG - Log price calculation details
    console.log('[PolymarketOrderBuilder] Price calculation:', {
      inputPrice: params.price,
      priceTick,
      tickMultiplier,
      priceRounded,
      size: params.size,
      expectedUSDC: (params.price * params.size).toFixed(4),
      roundedUSDC: (priceRounded * params.size).toFixed(4),
    });

    // Calculate amounts in minimum units
    const { makerAmount, takerAmount } = this.calculateAmounts(
      params.side,
      priceRounded,
      params.size
    );

    // Build order object (for API)
    const order = {
      salt, // Number
      maker: this.makerAddress,
      signer: this.signer.address,
      taker: this.ZERO_ADDRESS, // Anyone can take
      tokenId: params.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: (params.expiration || 0).toString(),
      nonce: params.nonce.toString(),
      feeRateBps: params.feeRateBps.toString(),
      side: params.side, // 'BUY' or 'SELL' string
      signatureType: this.signatureType, // Number
    };

    // Sign order with EIP-712
    const signature = await this.signOrder(order);

    return {
      ...order,
      signature,
    };
  }

  /**
   * Get safe default price tick size
   *
   * @param price - Order price (unused, kept for future enhancements)
   * @returns Safe default tick size
   *
   * @remarks
   * Always returns 0.01 as the safest default tick size.
   * This is more conservative than 0.001 and most compatible with Polymarket markets.
   *
   * Important: This is a FALLBACK. The correct approach is to pass
   * explicit priceTick from market constraints.
   *
   * @example
   * ```typescript
   * inferPriceTick(0.52)   // 0.01 (will round 0.52 → 0.52)
   * inferPriceTick(0.843)  // 0.01 (will round 0.843 → 0.84)
   * inferPriceTick(0.9506) // 0.01 (will round 0.9506 → 0.95)
   * ```
   */
  private inferPriceTick(_price: number): number {
    // CRITICAL: Always use 0.01 as default tick size
    // This is the safest tick size on Polymarket (most common)
    // DO NOT infer from price decimals - tick is determined by market, not price!
    return 0.01;
  }

  /**
   * Calculate maker and taker amounts
   *
   * @param side - Order side
   * @param price - Order price (0-1)
   * @param size - Order size (shares)
   * @returns Maker and taker amounts in minimum units
   *
   * @remarks
   * BUY order:
   * - Maker spends: price * size (USDC)
   * - Taker receives: size (outcome tokens)
   *
   * SELL order:
   * - Maker spends: size (outcome tokens)
   * - Taker receives: price * size (USDC)
   */
  private calculateAmounts(
    side: 'BUY' | 'SELL',
    price: number,
    size: number
  ): { makerAmount: number; takerAmount: number } {
    const multiplier = 1e6; // 10^6 for USDC decimals

    // ✅ v7.7.15: CRITICAL - Price already rounded to priceTick in buildOrder()!
    // API calculates: makerAmount / takerAmount and validates against priceTick.
    // DO NOT round again - use price as-is (already rounded to correct tick).
    const usdcAmount = price * size;

    if (side === 'BUY') {
      // BUY: Maker spends USDC, taker provides outcome tokens
      // ✅ v7.7.16: API требует ТОЧНОЕ значение makerAmount
      // Проблема: floating point precision errors!
      //
      // Пример 1: price × size = 0.459 × 5.05 = 2.31795
      //   → Math.floor(23179.5) / 10000 = 2.3179 ✅
      //
      // Пример 2: price × size = 0.31 × 5.05 = 1.5655
      //   → НО в JS: 0.31 * 5.05 = 1.56549999999999995 (float precision!)
      //   → Math.floor(15654.999...) / 10000 = 1.5654 ❌ API хочет 1.5655!
      //
      // РЕШЕНИЕ: Используем Math.round() вместо Math.floor() для корректной обработки float errors!
      const usdcRounded = Math.round(usdcAmount * 10000) / 10000;
      const makerAmount = Math.round(usdcRounded * multiplier);
      const takerAmount = Math.round(size * multiplier);

      // ✅ v7.7.16: DEBUG - Log amount calculation details
      console.log('[PolymarketOrderBuilder] Amount calculation (BUY):', {
        price,
        size,
        usdcAmount,
        usdcRounded,
        makerAmount,
        makerAmountUSDC: (makerAmount / multiplier).toFixed(4),
        takerAmount,
        calculatedPrice: (makerAmount / takerAmount).toFixed(4), // What API will see
      });

      return { makerAmount, takerAmount };
    } else {
      // SELL: Maker spends outcome tokens, taker provides USDC
      // makerAmount (tokens) - max 2 decimals
      // takerAmount (USDC) - exact calculation (no rounding to cents)
      const makerAmount = Math.round(size * multiplier);
      const takerAmount = Math.round(usdcAmount * multiplier);
      return { makerAmount, takerAmount };
    }
  }

  /**
   * Sign order with EIP-712
   *
   * @param order - Order object (without signature)
   * @returns Hex signature
   */
  private async signOrder(order: Omit<SignedOrder, 'signature'>): Promise<string> {
    // Get verifying contract for this chain
    const verifyingContract = CONTRACT_ADDRESSES[this.chainId];
    if (!verifyingContract) {
      throw new Error(`No contract address for chain ID ${this.chainId}`);
    }

    // Create EIP-712 typed data domain
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: this.chainId,
      verifyingContract,
    };

    // Convert fields to proper types for EIP-712 signing
    const message = {
      salt: BigInt(order.salt),
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount),
      takerAmount: BigInt(order.takerAmount),
      expiration: BigInt(order.expiration),
      nonce: BigInt(order.nonce),
      feeRateBps: BigInt(order.feeRateBps),
      side: order.side === 'BUY' ? 0 : 1, // Convert "BUY"/"SELL" to 0/1 for signing
      signatureType: order.signatureType, // Already a number
    };

    // Sign with EIP-712
    const signature = await this.signer.signTypedData(domain, ORDER_TYPE, message);

    return signature;
  }
}

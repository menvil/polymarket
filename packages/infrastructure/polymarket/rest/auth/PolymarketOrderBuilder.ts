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
import type { ILogger } from '@polymarket/logger';
import { USDC_MULTIPLIER, DEFAULT_PRICE_TICK } from '../constants.js';

/**
 * Order parameters for building
 */
export interface BuildOrderParams {
  /** Идентификатор токена */
  tokenId: string;

  /** Направление ордера */
  side: 'BUY' | 'SELL';

  /** Цена (0-1) */
  price: number;

  /** Размер (количество акций) */
  size: number;

  /** Ставка комиссии в базисных пунктах */
  feeRateBps: number;

  /** Nonce биржи */
  nonce: number;

  /** Метка времени истечения (0 = без истечения) */
  expiration?: number;

  /** Шаг цены для округления (по умолчанию: 0.01) */
  priceTick?: number;
}

/**
 * Signed order (ready for API)
 */
export interface SignedOrder {
  salt: number; // Число (не строка!)
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: 'BUY' | 'SELL'; // Строка "BUY"/"SELL" (не "0"/"1"!)
  signatureType: number; // Число (не строка!)
  signature: string;
}

/**
 * Contract addresses by chain ID
 */
const CONTRACT_ADDRESSES: Record<number, string> = {
  137: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Polygon Mainnet (основная сеть)
  80002: '0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40', // Amoy Testnet (тестовая сеть)
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
    private readonly signatureType: SignatureType,
    private readonly logger: ILogger
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
    // Генерируем случайный salt
    const salt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    // КРИТИЧНО: Определяем шаг цены
    // Если не передан — используем безопасный дефолт (DEFAULT_PRICE_TICK = 0.01)
    const priceTick = params.priceTick ?? this.inferPriceTick(params.price);

    // Округляем цену до шага (избегаем ошибок плавающей точки)
    // Требование API: "Price (0.588) breaks minimum tick size rule: 0.01"
    const tickMultiplier = 1 / priceTick; // 0.001 → 1000, 0.01 → 100
    const priceRounded = Math.round(params.price * tickMultiplier) / tickMultiplier;

    this.logger.debug('Price calculation', {
      inputPrice: params.price,
      priceTick,
      tickMultiplier,
      priceRounded,
      size: params.size,
      expectedUSDC: (params.price * params.size).toFixed(4),
      roundedUSDC: (priceRounded * params.size).toFixed(4),
    });

    // Вычисляем суммы в минимальных единицах
    const { makerAmount, takerAmount } = this.calculateAmounts(
      params.side,
      priceRounded,
      params.size
    );

    // Строим объект ордера (для API)
    const order = {
      salt, // Число
      maker: this.makerAddress,
      signer: this.signer.address,
      taker: this.ZERO_ADDRESS, // Любой может принять
      tokenId: params.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: (params.expiration || 0).toString(),
      nonce: params.nonce.toString(),
      feeRateBps: params.feeRateBps.toString(),
      side: params.side, // Строка 'BUY' или 'SELL'
      signatureType: this.signatureType, // Число
    };

    // Подписываем ордер с EIP-712
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
    // КРИТИЧНО: Всегда используем DEFAULT_PRICE_TICK (0.01) как дефолт
    // Это самый безопасный шаг на Polymarket (наиболее распространённый)
    // НЕ выводить из десятичных знаков цены — шаг определяется маркетом, не ценой!
    return DEFAULT_PRICE_TICK;
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
    const multiplier = USDC_MULTIPLIER;

    // КРИТИЧНО: Цена уже округлена до priceTick в buildOrder()!
    // API вычисляет: makerAmount / takerAmount и проверяет против priceTick.
    // НЕ округлять повторно — использовать цену как есть (уже округлена до нужного шага).
    const usdcAmount = price * size;

    if (side === 'BUY') {
      // BUY: Maker тратит USDC, taker предоставляет outcome токены
      // API требует ТОЧНОЕ значение makerAmount
      // Проблема: ошибки точности плавающей точки!
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

      this.logger.debug('Amount calculation (BUY)', {
        price,
        size,
        usdcAmount,
        usdcRounded,
        makerAmount,
        makerAmountUSDC: (makerAmount / multiplier).toFixed(4),
        takerAmount,
        calculatedPrice: (makerAmount / takerAmount).toFixed(4),
      });

      return { makerAmount, takerAmount };
    } else {
      // SELL: Maker тратит outcome токены, taker предоставляет USDC
      // makerAmount (токены) — максимум 2 знака после запятой
      // takerAmount (USDC) — точное вычисление (без округления до центов)
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
    // Получаем адрес верифицирующего контракта для этой цепочки
    const verifyingContract = CONTRACT_ADDRESSES[this.chainId];
    if (!verifyingContract) {
      throw new Error(`No contract address for chain ID ${this.chainId}`);
    }

    // Создаём домен типизированных данных EIP-712
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: this.chainId,
      verifyingContract,
    };

    // Конвертируем поля в правильные типы для подписи EIP-712
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
      side: order.side === 'BUY' ? 0 : 1, // Конвертируем "BUY"/"SELL" в 0/1 для подписи
      signatureType: order.signatureType, // Уже число
    };

    // Подписываем с EIP-712
    const signature = await this.signer.signTypedData(domain, ORDER_TYPE, message);

    return signature;
  }
}

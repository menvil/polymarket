/**
 * Конструктор ордеров Polymarket
 *
 * @remarks
 * Строит ордера с EIP-712 подписью для Polymarket CLOB API.
 *
 * Структура ордера:
 * - salt: Случайное число для уникальности
 * - maker: Адрес финансирующей стороны (кто предоставляет ликвидность)
 * - signer: Адрес подписанта (EOA, которая подписывает)
 * - taker: Нулевой адрес (может принять любой)
 * - tokenId: ID токена исхода
 * - makerAmount: Сумма, которую тратит maker (в минимальных единицах)
 * - takerAmount: Сумма, которую платит taker (в минимальных единицах)
 * - expiration: Unix временная метка (0 = без истечения)
 * - nonce: Текущий nonce обменника
 * - feeRateBps: Ставка комиссии в базисных пунктах
 * - side: 0 = BUY, 1 = SELL
 * - signatureType: Тип подписи (EOA, POLY_PROXY и т.д.)
 * - signature: EIP-712 подпись
 *
 * @example
 * ```typescript
 * const builder = new PolymarketOrderBuilder(signer, chainId, makerAddress, signatureType, logger);
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
 * // Использовать signedOrder в POST /order запросе
 * ```
 */

import type { Wallet } from 'ethers';
import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { SignatureType } from '../types.js';

/**
 * Параметры ордера для построения
 */
export interface BuildOrderParams {
  /** ID токена */
  tokenId: string;

  /** Сторона ордера */
  side: 'BUY' | 'SELL';

  /** Цена (0-1) */
  price: number;

  /** Размер (количество акций) */
  size: number;

  /** Ставка комиссии в базисных пунктах */
  feeRateBps: number;

  /** Nonce обменника */
  nonce: number;

  /** Временная метка истечения (0 = без истечения) */
  expiration?: number;

  /** Размер шага цены для округления (по умолчанию: 0.01) */
  priceTick?: number;
}

/**
 * Подписанный ордер (готов для API)
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
 * Адреса контрактов по ID сети
 */
const CONTRACT_ADDRESSES: Record<number, string> = {
  137: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Polygon Mainnet
  80002: '0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40', // Amoy Testnet
};

/**
 * Тип Order для EIP-712
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
 * Конструктор ордеров Polymarket
 */
export class PolymarketOrderBuilder {
  private readonly ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  constructor(
    private readonly signer: Wallet,
    private readonly chainId: number,
    private readonly makerAddress: string,
    private readonly signatureType: SignatureType,
    private readonly logger?: ILogger
  ) {}

  /**
   * Построить и подписать ордер
   *
   * @param params - Параметры ордера
   * @returns Подписанный ордер готовый для API
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
    // Сгенерировать случайную соль
    const salt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    // КРИТИЧНО: Определить размер шага цены
    // Если не предоставлен, использовать безопасное значение по умолчанию (0.01)
    const priceTick = params.priceTick ?? this.inferPriceTick(params.price);

    // Округлить цену до размера шага (избежать ошибок с плавающей точкой)
    // Требование API: "Price (0.588) breaks minimum tick size rule: 0.01"
    const tickMultiplier = 1 / priceTick; // 0.001 → 1000, 0.01 → 100
    const priceRounded = Math.round(params.price * tickMultiplier) / tickMultiplier;

    // ✅ v7.7.15: DEBUG - Логирование деталей расчета цены
    this.logger?.debug('Price calculation', {
      inputPrice: params.price,
      priceTick,
      tickMultiplier,
      priceRounded,
      size: params.size,
      expectedUSDC: (params.price * params.size).toFixed(4),
      roundedUSDC: (priceRounded * params.size).toFixed(4),
    });

    // Рассчитать суммы в минимальных единицах
    const { makerAmount, takerAmount } = this.calculateAmounts(
      params.side,
      priceRounded,
      params.size
    );

    // Построить объект ордера (для API)
    const order = {
      salt, // Число
      maker: this.makerAddress,
      signer: this.signer.address,
      taker: this.ZERO_ADDRESS, // Может принять любой
      tokenId: params.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: (params.expiration || 0).toString(),
      nonce: params.nonce.toString(),
      feeRateBps: params.feeRateBps.toString(),
      side: params.side, // Строка 'BUY' или 'SELL'
      signatureType: this.signatureType, // Число
    };

    // Подписать ордер с помощью EIP-712
    const signature = await this.signOrder(order);

    return {
      ...order,
      signature,
    };
  }

  /**
   * Получить безопасный размер шага цены по умолчанию
   *
   * @param price - Цена ордера (не используется, оставлен для будущих улучшений)
   * @returns Безопасный размер шага по умолчанию
   *
   * @remarks
   * Всегда возвращает 0.01 как самый безопасный размер шага по умолчанию.
   * Это более консервативное значение чем 0.001 и наиболее совместимо с рынками Polymarket.
   *
   * Важно: Это ЗАПАСНОЙ ВАРИАНТ. Правильный подход - передавать
   * явный priceTick из ограничений рынка.
   *
   * @example
   * ```typescript
   * inferPriceTick(0.52)   // 0.01 (округлит 0.52 → 0.52)
   * inferPriceTick(0.843)  // 0.01 (округлит 0.843 → 0.84)
   * inferPriceTick(0.9506) // 0.01 (округлит 0.9506 → 0.95)
   * ```
   */
  private inferPriceTick(_price: number): number {
    // КРИТИЧНО: Всегда использовать 0.01 как размер шага по умолчанию
    // Это самый безопасный размер шага на Polymarket (наиболее распространенный)
    // НЕ определять из десятичных знаков цены - шаг определяется рынком, а не ценой!
    return 0.01;
  }

  /**
   * Рассчитать суммы maker и taker
   *
   * @param side - Сторона ордера
   * @param price - Цена ордера (0-1)
   * @param size - Размер ордера (акции)
   * @returns Суммы maker и taker в минимальных единицах
   *
   * @remarks
   * BUY ордер:
   * - Maker тратит: price * size (USDC)
   * - Taker получает: size (токены исходов)
   *
   * SELL ордер:
   * - Maker тратит: size (токены исходов)
   * - Taker получает: price * size (USDC)
   */
  private calculateAmounts(
    side: 'BUY' | 'SELL',
    price: number,
    size: number
  ): { makerAmount: number; takerAmount: number } {
    const multiplier = 1e6; // 10^6 для десятичных знаков USDC

    // ✅ v7.7.15: КРИТИЧНО - Цена уже округлена до priceTick в buildOrder()!
    // API рассчитывает: makerAmount / takerAmount и проверяет относительно priceTick.
    // НЕ округлять снова - использовать цену как есть (уже округлена до правильного шага).
    const usdcAmount = price * size;

    if (side === 'BUY') {
      // BUY: Maker тратит USDC, taker предоставляет токены исходов
      // ✅ v7.7.16: API требует ТОЧНОЕ значение makerAmount
      // Проблема: ошибки точности с плавающей точкой!
      //
      // Пример 1: price × size = 0.459 × 5.05 = 2.31795
      //   → Math.floor(23179.5) / 10000 = 2.3179 ✅
      //
      // Пример 2: price × size = 0.31 × 5.05 = 1.5655
      //   → НО в JS: 0.31 * 5.05 = 1.56549999999999995 (точность float!)
      //   → Math.floor(15654.999...) / 10000 = 1.5654 ❌ API хочет 1.5655!
      //
      // РЕШЕНИЕ: Используем Math.round() вместо Math.floor() для корректной обработки ошибок float!
      const usdcRounded = Math.round(usdcAmount * 10000) / 10000;
      const makerAmount = Math.round(usdcRounded * multiplier);
      const takerAmount = Math.round(size * multiplier);

      // ✅ v7.7.16: DEBUG - Логирование деталей расчета сумм
      this.logger?.debug('Amount calculation (BUY)', {
        price,
        size,
        usdcAmount,
        usdcRounded,
        makerAmount,
        makerAmountUSDC: (makerAmount / multiplier).toFixed(4),
        takerAmount,
        calculatedPrice: (makerAmount / takerAmount).toFixed(4), // Что увидит API
      });

      return { makerAmount, takerAmount };
    } else {
      // SELL: Maker тратит токены исходов, taker предоставляет USDC
      // makerAmount (токены) - максимум 2 десятичных знака
      // takerAmount (USDC) - точный расчет (без округления до центов)
      const makerAmount = Math.round(size * multiplier);
      const takerAmount = Math.round(usdcAmount * multiplier);
      return { makerAmount, takerAmount };
    }
  }

  /**
   * Подписать ордер с помощью EIP-712
   *
   * @param order - Объект ордера (без подписи)
   * @returns Hex подпись
   */
  private async signOrder(order: Omit<SignedOrder, 'signature'>): Promise<string> {
    // Получить проверяющий контракт для этой сети
    const verifyingContract = CONTRACT_ADDRESSES[this.chainId];
    if (!verifyingContract) {
      throw new Error(`No contract address for chain ID ${this.chainId}`);
    }

    // Создать домен типизированных данных EIP-712
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: this.chainId,
      verifyingContract,
    };

    // Конвертировать поля в правильные типы для подписи EIP-712
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
      side: order.side === 'BUY' ? 0 : 1, // Конвертировать "BUY"/"SELL" в 0/1 для подписи
      signatureType: order.signatureType, // Уже число
    };

    // Подписать с помощью EIP-712
    const signature = await this.signer.signTypedData(domain, ORDER_TYPE, message);

    return signature;
  }
}

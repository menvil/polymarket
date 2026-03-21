/**
 * Построитель ордеров Polymarket
 *
 * @remarks
 * Строит EIP-712 подписанные ордера для CLOB API Polymarket.
 *
 * Структура ордера:
 * - salt: Случайное число для уникальности
 * - maker: Адрес фандера (кто предоставляет ликвидность)
 * - signer: Адрес подписанта (EOA который подписывает)
 * - taker: Нулевой адрес (любой может принять)
 * - tokenId: Идентификатор токена исхода
 * - makerAmount: Сумма которую тратит maker (в минимальных единицах)
 * - takerAmount: Сумма которую платит taker (в минимальных единицах)
 * - expiration: Unix timestamp (0 = без истечения)
 * - nonce: Текущий nonce биржи
 * - feeRateBps: Ставка комиссии в базисных пунктах
 * - side: 0 = BUY, 1 = SELL
 * - signatureType: Тип подписи (EOA, POLY_PROXY и т.д.)
 * - signature: Подпись EIP-712
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
 * // Использовать signedOrder в запросе POST /order
 * ```
 */

import type { Wallet } from 'ethers';
import type { SignatureType } from '../types.js';
import type { ILogger } from '@polymarket/logger';
import { USDC_MULTIPLIER, DEFAULT_PRICE_TICK } from '../constants.js';

/**
 * Параметры для построения ордера
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
 * Адреса контрактов по идентификатору цепочки
 */
const CONTRACT_ADDRESSES: Record<number, string> = {
  137: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Polygon Mainnet (основная сеть)
  80002: '0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40', // Amoy Testnet (тестовая сеть)
};

/**
 * Тип ордера EIP-712
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
 * Построитель ордеров Polymarket
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
   * Получить безопасный шаг цены по умолчанию
   *
   * @param price - Цена ордера (не используется, сохранён для будущих улучшений)
   * @returns Безопасный шаг цены по умолчанию
   *
   * @remarks
   * Всегда возвращает 0.01 как наиболее безопасный шаг цены по умолчанию.
   * Это более консервативно, чем 0.001, и наиболее совместимо с маркетами Polymarket.
   *
   * Важно: Это ЗАПАСНОЙ ВАРИАНТ. Правильный подход — передавать
   * явный priceTick из ограничений маркета.
   *
   * @example
   * ```typescript
   * inferPriceTick(0.52)   // 0.01 (округлит 0.52 → 0.52)
   * inferPriceTick(0.843)  // 0.01 (округлит 0.843 → 0.84)
   * inferPriceTick(0.9506) // 0.01 (округлит 0.9506 → 0.95)
   * ```
   */
  private inferPriceTick(_price: number): number {
    // КРИТИЧНО: Всегда используем DEFAULT_PRICE_TICK (0.01) как дефолт
    // Это самый безопасный шаг на Polymarket (наиболее распространённый)
    // НЕ выводить из десятичных знаков цены — шаг определяется маркетом, не ценой!
    return DEFAULT_PRICE_TICK;
  }

  /**
   * Вычислить суммы для maker и taker
   *
   * @param side - Направление ордера
   * @param price - Цена ордера (0-1)
   * @param size - Размер ордера (акции)
   * @returns Суммы для maker и taker в минимальных единицах
   *
   * @remarks
   * Ордер BUY:
   * - Maker тратит: price * size (USDC)
   * - Taker получает: size (токены исходов)
   *
   * Ордер SELL:
   * - Maker тратит: size (токены исходов)
   * - Taker получает: price * size (USDC)
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
      // SELL: Maker тратит outcome токены, taker предоставляет USDC.
      // Polymarket API ограничения точности для SELL:
      //   makerAmount (токены) — макс 2 знака после запятой
      //   takerAmount (USDC)   — макс 4 знака после запятой
      //
      // В минимальных единицах (1e6):
      //   makerAmount должен быть кратен 10000 (1e6 / 1e2)
      //   takerAmount должен быть кратен 100   (1e6 / 1e4)
      //
      // КРИТИЧНО: takerAmount ДОЛЖЕН использовать усечённый size (после truncation до 2 знаков),
      // а НЕ оригинальный size! API проверяет: takerAmount === truncated_size × rounded_price.
      // Если использовать оригинальный size → рассогласование → "invalid amounts" ошибка.
      //
      // Math.floor для makerAmount — не продать больше, чем имеем на балансе.
      const truncatedSize = Math.floor(size * 100) / 100; // 6.8907... → 6.89
      const makerAmount = truncatedSize * multiplier; // 6.89 * 1e6 = 6890000
      const sellUsdcAmount = truncatedSize * price; // Используем усечённый size!
      const takerAmount = Math.round(sellUsdcAmount * 10000) * 100;
      return { makerAmount, takerAmount };
    }
  }

  /**
   * Подписать ордер с EIP-712
   *
   * @param order - Объект ордера (без подписи)
   * @returns Подпись в hex-формате
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

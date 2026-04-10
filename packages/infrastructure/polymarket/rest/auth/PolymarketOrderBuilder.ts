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
import { DEFAULT_PRICE_TICK } from '../constants.js';
import {
  OrderBuilder as OfficialOrderBuilder,
  Side as OfficialSide,
  SignatureType as OfficialSignatureType,
  type TickSize as OfficialTickSize,
} from '@polymarket/clob-client';

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

  /** true если рынок использует negRisk exchange contract */
  negRisk?: boolean;
}

/**
 * Подписанный ордер (готов для API)
 */
export interface SignedOrder {
  salt: string | number;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number | 'BUY' | 'SELL';
  signatureType: number;
  signature: string;
}

/**
 * Построитель ордеров Polymarket
 */
export class PolymarketOrderBuilder {
  private readonly _officialBuilder: OfficialOrderBuilder;

  constructor(
    private readonly signer: Wallet,
    private readonly chainId: number,
    private readonly makerAddress: string,
    private readonly signatureType: SignatureType,
    private readonly logger: ILogger
  ) {
    const signerBridge = {
      getAddress: async (): Promise<string> => this.signer.address,
      _signTypedData: async (
        domain: Record<string, unknown>,
        types: Record<string, Array<{ name: string; type: string }>>,
        value: Record<string, unknown>,
      ): Promise<string> =>
        this.signer.signTypedData(
          domain as any,
          types as any,
          value as any,
        ),
    };

    this._officialBuilder = new OfficialOrderBuilder(
      signerBridge as any,
      this.chainId as any,
      this.signatureType as unknown as OfficialSignatureType,
      this.makerAddress,
    );
  }

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
    const priceTick = params.priceTick ?? this.inferPriceTick(params.price);
    const priceRounded = this.roundNormal(
      params.price,
      this.getRoundConfig(priceTick).price,
    );

    this.logger.debug('Price calculation', {
      inputPrice: params.price,
      priceTick,
      priceRounded,
      size: params.size,
      expectedUSDC: (params.price * params.size).toFixed(4),
      roundedUSDC: (priceRounded * params.size).toFixed(4),
      negRisk: params.negRisk === true,
    });

    const signedOrder = await this._officialBuilder.buildOrder(
      {
        tokenID: params.tokenId,
        side: params.side === 'BUY' ? OfficialSide.BUY : OfficialSide.SELL,
        price: priceRounded,
        size: params.size,
        feeRateBps: params.feeRateBps,
        nonce: params.nonce,
        expiration: params.expiration,
      },
      {
        tickSize: this.toOfficialTickSize(priceTick),
        negRisk: params.negRisk === true,
      },
    );

    return signedOrder as unknown as SignedOrder;
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
  private getRoundConfig(priceTick: number): { price: number; size: number; amount: number } {
    if (priceTick >= 0.1) return { price: 1, size: 2, amount: 3 };
    if (priceTick >= 0.01) return { price: 2, size: 2, amount: 4 };
    if (priceTick >= 0.001) return { price: 3, size: 2, amount: 5 };
    return { price: 4, size: 2, amount: 6 };
  }

  private decimalPlaces(num: number): number {
    if (Number.isInteger(num)) return 0;
    const arr = num.toString().split('.');
    return arr.length <= 1 ? 0 : arr[1]!.length;
  }

  private roundNormal(num: number, decimals: number): number {
    if (this.decimalPlaces(num) <= decimals) return num;
    return Math.round((num + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;
  }

  private toOfficialTickSize(priceTick: number): OfficialTickSize {
    if (priceTick >= 0.1) return '0.1';
    if (priceTick >= 0.01) return '0.01';
    if (priceTick >= 0.001) return '0.001';
    return '0.0001';
  }
}

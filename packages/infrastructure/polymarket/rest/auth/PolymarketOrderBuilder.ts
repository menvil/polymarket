/**
 * Построитель ордеров Polymarket (CLOB V2)
 *
 * @remarks
 * Строит EIP-712 подписанные ордера для CLOB API Polymarket V2.
 *
 * Структура ордера V2:
 * - salt: Случайное число для уникальности
 * - maker: Адрес фандера (кто предоставляет ликвидность)
 * - signer: Адрес подписанта (EOA который подписывает)
 * - tokenId: Идентификатор токена исхода
 * - makerAmount: Сумма которую тратит maker (в минимальных единицах)
 * - takerAmount: Сумма которую платит taker (в минимальных единицах)
 * - side: BUY или SELL
 * - timestamp: Unix timestamp в миллисекундах
 * - metadata: Метаданные (bytes32)
 * - builder: Адрес/код билдера (bytes32)
 * - expiration: Unix timestamp (0 = без истечения)
 * - signatureType: Тип подписи (EOA, POLY_PROXY и т.д.)
 * - signature: Подпись EIP-712
 *
 * Изменения V2 относительно V1:
 * - Удалены: nonce, feeRateBps, taker
 * - Добавлены: timestamp (ms), metadata, builder
 * - EIP-712 domain version: "2"
 * - Комиссии устанавливаются биржей в момент матчинга, не в ордере
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
  SignatureTypeV2 as OfficialSignatureTypeV2,
  type TickSize as OfficialTickSize,
} from '@polymarket/clob-client-v2';

/**
 * Параметры для построения ордера V2
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

  /** Метка времени истечения (0 = без истечения) */
  expiration?: number;

  /** Шаг цены для округления (по умолчанию: 0.01) */
  priceTick?: number;

  /** true если рынок использует negRisk exchange contract */
  negRisk?: boolean;

  /** Код билдера для атрибуции (bytes32 hex-строка) */
  builderCode?: string;

  /** Метаданные ордера (bytes32 hex-строка) */
  metadata?: string;
}

/**
 * Подписанный ордер V2 (готов для API)
 */
export interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  side: string | number;
  signatureType: number;
  timestamp: string;
  metadata: string;
  builder: string;
  signature: string;
}

/**
 * Построитель ордеров Polymarket V2
 */
export class PolymarketOrderBuilder {
  private readonly _officialBuilder: OfficialOrderBuilder;

  constructor(
    private readonly signer: Wallet,
    private readonly chainId: number,
    private readonly makerAddress: string,
    private readonly signatureType: SignatureType,
    private readonly logger: ILogger,
    /** Builder code для атрибуции (bytes32 hex, из Polymarket Builder Profile) */
    private readonly builderCode?: string,
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
      this.signatureType as unknown as OfficialSignatureTypeV2,
      this.makerAddress,
    );
  }

  /**
   * Построить и подписать ордер V2
   *
   * @param params - Параметры ордера
   * @returns Подписанный ордер готовый для API
   *
   * @remarks
   * В V2 SDK генерирует timestamp самостоятельно.
   * feeRateBps и nonce больше не нужны — комиссии устанавливаются биржей.
   *
   * @example
   * ```typescript
   * const signedOrder = await builder.buildOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   * ```
   */
  async buildOrder(params: BuildOrderParams): Promise<SignedOrder> {
    const priceTick = params.priceTick ?? this.inferPriceTick(params.price);
    const priceRounded = this.roundNormal(
      params.price,
      this.getRoundConfig(priceTick).price,
    );

    this.logger.debug('OutcomePrice calculation', {
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
        expiration: params.expiration,
        builderCode: params.builderCode ?? this.builderCode,
        metadata: params.metadata,
      },
      {
        tickSize: this.toOfficialTickSize(priceTick),
        negRisk: params.negRisk === true,
      },
      2, // V2 EIP-712 domain
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
   *
   * @example
   * ```typescript
   * inferPriceTick(0.52)   // 0.01
   * inferPriceTick(0.843)  // 0.01
   * ```
   */
  private inferPriceTick(_price: number): number {
    // КРИТИЧНО: Всегда используем DEFAULT_PRICE_TICK (0.01) как дефолт
    // Шаг определяется маркетом, не ценой!
    return DEFAULT_PRICE_TICK;
  }

  /**
   * Получить конфиг округления для заданного шага цены
   *
   * @param priceTick - Шаг цены
   * @returns Конфиг с количеством знаков после запятой для цены, размера и суммы
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

/**
 * REST-клиент балансов Polymarket
 *
 * @remarks
 * Обрабатывает endpoint /balance-allowance:
 * - GET /balance-allowance - Получить баланс и разрешение пользователя
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется маппером в вышестоящих слоях.
 *
 * @example
 * ```typescript
 * const client = new PolymarketBalanceRestClient(restClient, logger);
 *
 * const balances = await client.getBalances();
 * const usdcBalance = balances.find(b => b.asset === 'USDC');
 * console.log(`Available: ${usdcBalance.available}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Тип актива для запросов баланса/разрешения
 */
export type AssetType = 'COLLATERAL' | 'CONDITIONAL';

/**
 * Ответ с балансом и разрешением (сырой формат API)
 */
export interface BalanceAllowanceResponse {
  /** Баланс (строковый формат) */
  balance: string;

  /** Разрешение (строковый формат) */
  allowance: string;
}

/**
 * Ответ с балансом (наш внутренний формат)
 */
export interface BalanceResponse {
  /** Символ актива/токена (например, "USDC") */
  asset: string;

  /** Общий баланс (строковый формат) */
  total: string;

  /** Доступный баланс (строковый формат) */
  available: string;

  /** Заблокированный баланс в открытых ордерах (строковый формат) */
  locked: string;
}

/**
 * Ответ на запрос балансов
 */
export interface GetBalancesResponse {
  /** Массив балансов */
  balances: BalanceResponse[];
}

/**
 * REST-клиент балансов Polymarket
 */
export class PolymarketBalanceRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить балансы пользователя
   *
   * @returns Массив балансов
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Возвращает сырой ответ API. Нормализация должна выполняться маппером.
   *
   * Использует endpoint /balance-allowance с asset_type=COLLATERAL для баланса USDC.
   *
   * @example
   * ```typescript
   * const balances = await client.getBalances();
   *
   * const usdcBalance = balances.find(b => b.asset === 'USDC');
   * console.log(`Available USDC: ${usdcBalance.available}`);
   * console.log(`Locked USDC: ${usdcBalance.locked}`);
   * ```
   */
  async getBalances(): Promise<BalanceResponse[]> {
    this.logger.debug('Getting balances', {
      address: this.restClient.getAddress(),
      signatureType: this.restClient.getSignatureType(),
    });

    const params: Record<string, string> = {
      asset_type: 'COLLATERAL', // Баланс USDC
      signature_type: this.restClient.getSignatureType().toString(), // КРИТИЧНО: Обязательно для proxy-кошельков
    };

    const response = await this.restClient.get<BalanceAllowanceResponse>(
      '/balance-allowance',
      params
    );

    this.logger.debug('Balance retrieved', {
      balance: response.balance,
      allowance: response.allowance,
    });

    // Конвертируем ответ balance-allowance в наш внутренний формат
    const balanceResponse: BalanceResponse = {
      asset: 'USDC',
      total: response.balance,
      available: response.balance, // Весь баланс доступен (не заблокирован в ордерах здесь)
      locked: '0', // Этот endpoint не предоставляет заблокированный баланс
    };

    return [balanceResponse];
  }

  /**
   * Получить баланс для конкретного актива
   *
   * @param asset - Символ актива (например, "USDC")
   * @returns Ответ с балансом или undefined если не найден
   * @throws {ApiError} При ошибке API-вызова
   *
   * @example
   * ```typescript
   * const usdcBalance = await client.getBalanceForAsset('USDC');
   *
   * if (usdcBalance) {
   *   console.log(`Available: ${usdcBalance.available}`);
   * }
   * ```
   */
  async getBalanceForAsset(asset: string): Promise<BalanceResponse | undefined> {
    this.logger.debug('Getting balance for asset', { asset });

    const balances = await this.getBalances();
    const balance = balances.find((b) => b.asset === asset);

    if (balance) {
      this.logger.debug('Balance found', {
        asset,
        available: balance.available,
        locked: balance.locked,
      });
    } else {
      this.logger.warn('Balance not found', { asset });
    }

    return balance;
  }

  /**
   * Получить баланс для конкретного токена исхода
   *
   * @param tokenId - Идентификатор токена исхода
   * @returns Баланс (как число)
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Использует endpoint /balance-allowance с asset_type=CONDITIONAL.
   *
   * @example
   * ```typescript
   * const tokenBalance = await client.getOutcomeTokenBalance('0x123...');
   * console.log(`Token balance: ${tokenBalance}`);
   * ```
   */
  async getOutcomeTokenBalance(tokenId: string): Promise<number> {
    this.logger.debug('Getting outcome token balance', {
      tokenId,
      signatureType: this.restClient.getSignatureType(),
    });

    const params: Record<string, string> = {
      asset_type: 'CONDITIONAL',
      token_id: tokenId,
      signature_type: this.restClient.getSignatureType().toString(), // КРИТИЧНО: Обязательно для proxy-кошельков
    };

    const response = await this.restClient.get<BalanceAllowanceResponse>(
      '/balance-allowance',
      params
    );

    // КРИТИЧНО: Конвертируем из минимальных единиц в реальное количество токенов
    // Outcome-токены также используют 6 знаков после запятой, как USDC
    const OUTCOME_TOKEN_DECIMALS = 6;
    const rawBalance = parseFloat(response.balance);
    const actualBalance = rawBalance / Math.pow(10, OUTCOME_TOKEN_DECIMALS);

    this.logger.debug('Outcome token balance retrieved', {
      tokenId,
      rawBalance,
      actualBalance,
    });

    return actualBalance;
  }
}

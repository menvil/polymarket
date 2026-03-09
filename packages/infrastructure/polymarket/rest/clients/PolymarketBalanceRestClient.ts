/**
 * Polymarket Balance REST Client
 *
 * @remarks
 * Handles /balance-allowance endpoint:
 * - GET /balance-allowance - Get user balance and allowance
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Asset type for balance/allowance queries
 */
export type AssetType = 'COLLATERAL' | 'CONDITIONAL';

/**
 * Balance and allowance response (raw API format)
 */
export interface BalanceAllowanceResponse {
  /** Balance (string format) */
  balance: string;

  /** Allowance (string format) */
  allowance: string;
}

/**
 * Balance response (our internal format)
 */
export interface BalanceResponse {
  /** Asset/token symbol (e.g., "USDC") */
  asset: string;

  /** Total balance (string format) */
  total: string;

  /** Available balance (string format) */
  available: string;

  /** Locked balance in open orders (string format) */
  locked: string;
}

/**
 * Get balances response
 */
export interface GetBalancesResponse {
  /** Array of balances */
  balances: BalanceResponse[];
}

/**
 * Polymarket Balance REST Client
 */
export class PolymarketBalanceRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Get user balances
   *
   * @returns Array of balances
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns raw API response. Normalization should be done by mapper.
   *
   * Uses /balance-allowance endpoint with asset_type=COLLATERAL for USDC balance.
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
      asset_type: 'COLLATERAL', // USDC balance
      signature_type: this.restClient.getSignatureType().toString(), // CRITICAL: Required for proxy wallets
    };

    const response = await this.restClient.get<BalanceAllowanceResponse>(
      '/balance-allowance',
      params
    );

    this.logger.debug('Balance retrieved', {
      balance: response.balance,
      allowance: response.allowance,
    });

    // Convert balance-allowance response to our internal format
    const balanceResponse: BalanceResponse = {
      asset: 'USDC',
      total: response.balance,
      available: response.balance, // All balance is available (not locked in orders here)
      locked: '0', // This endpoint doesn't provide locked balance
    };

    return [balanceResponse];
  }

  /**
   * Get balance for specific asset
   *
   * @param asset - Asset symbol (e.g., "USDC")
   * @returns Balance response or undefined if not found
   * @throws {ApiError} If API call fails
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
   * Get balance for specific outcome token
   *
   * @param tokenId - Outcome token ID
   * @returns Balance (as number)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Uses /balance-allowance endpoint with asset_type=CONDITIONAL.
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
      signature_type: this.restClient.getSignatureType().toString(), // CRITICAL: Required for proxy wallets
    };

    const response = await this.restClient.get<BalanceAllowanceResponse>(
      '/balance-allowance',
      params
    );

    // CRITICAL: Convert from minimum units to actual token amount
    // Outcome tokens also use 6 decimal places like USDC
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

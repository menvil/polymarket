/**
 * PolymarketRedeemer — immediate redeem trigger поверх общего executor.
 */
import type { ILogger } from '@polymarket/logger';
import {
  PolymarketRedeemExecutor,
  type RedeemResult,
  type RelayerRedeemerConfig,
} from './PolymarketRedeemExecutor.js';

export interface PolymarketRedeemerConfig extends RelayerRedeemerConfig {}

export { type RedeemResult };

export class PolymarketRedeemer {
  private readonly _executor: PolymarketRedeemExecutor;

  private constructor(executor: PolymarketRedeemExecutor) {
    this._executor = executor;
  }

  public static create(config: PolymarketRedeemerConfig, logger: ILogger): PolymarketRedeemer {
    return new PolymarketRedeemer(PolymarketRedeemExecutor.create(config, logger));
  }

  public static fromEnv(logger: ILogger): PolymarketRedeemer {
    return new PolymarketRedeemer(PolymarketRedeemExecutor.fromEnv(logger));
  }

  public async redeem(conditionId: string): Promise<RedeemResult> {
    return this._executor.redeem(conditionId, {
      metadataPrefix: 'Redeem',
      skipOraclePrecheck: false,
    });
  }
}

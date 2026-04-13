import { ethers } from 'ethers';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import type { ILogger } from '@polymarket/logger';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

/** Адрес CTF контракта на Polygon */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** Адрес USDC.e (Bridged USDC) на Polygon */
export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Data API для получения redeemable позиций */
export const DATA_API_HOST = 'https://data-api.polymarket.com';

/** Polygon RPC по умолчанию */
export const DEFAULT_POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com';

/** Сообщение об ошибке оракула CTF */
const ORACLE_NOT_READY_MSG = 'result for condition not received yet';

/** ABI для redeemPositions */
const CTF_INTERFACE = new ethers.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

export interface RelayerRedeemerConfig {
  readonly privateKey: string;
  readonly funderAddress: string;
  readonly builderApiKey: string;
  readonly builderApiSecret: string;
  readonly builderApiPassphrase: string;
  readonly rpcUrl?: string;
}

export interface RedeemResult {
  readonly success: boolean;
  readonly txHash?: string;
  readonly error?: string;
}

export interface DataApiPosition {
  readonly conditionId: string;
  readonly asset: string;
  readonly size: number;
  readonly currentValue: number;
  readonly redeemable: boolean;
}

export class PolymarketRedeemExecutor {
  private readonly _relayClient: RelayClient;
  private readonly _provider: ethers.JsonRpcProvider;
  private readonly _funderAddress: string;
  private readonly _logger: ILogger;

  private constructor(
    relayClient: RelayClient,
    provider: ethers.JsonRpcProvider,
    funderAddress: string,
    logger: ILogger,
  ) {
    this._relayClient = relayClient;
    this._provider = provider;
    this._funderAddress = funderAddress;
    this._logger = logger.child({ component: 'PolymarketRedeemExecutor' });
  }

  public static create(config: RelayerRedeemerConfig, logger: ILogger): PolymarketRedeemExecutor {
    const rpcUrl = config.rpcUrl ?? DEFAULT_POLYGON_RPC;
    const provider = new ethers.JsonRpcProvider(rpcUrl, 137, { staticNetwork: true });
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(rpcUrl),
    });

    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.builderApiKey,
        secret: config.builderApiSecret,
        passphrase: config.builderApiPassphrase,
      },
    });

    const relayClient = new RelayClient(
      'https://relayer-v2.polymarket.com',
      137,
      walletClient as any,
      builderConfig as any,
      RelayerTxType.PROXY,
    );

    return new PolymarketRedeemExecutor(relayClient, provider, config.funderAddress, logger);
  }

  public static fromEnv(logger: ILogger): PolymarketRedeemExecutor {
    const required = (key: string): string => {
      const val = process.env[key];
      if (!val) throw new Error(`Missing env var: ${key}`);
      return val;
    };

    return PolymarketRedeemExecutor.create({
      privateKey: required('PRIVATE_KEY'),
      funderAddress: required('FUNDER_ADDRESS'),
      builderApiKey: required('BUILDER_API_KEY'),
      builderApiSecret: required('BUILDER_API_SECRET'),
      builderApiPassphrase: required('BUILDER_API_PASSPHRASE'),
    }, logger);
  }

  public async getRedeemablePositions(): Promise<DataApiPosition[]> {
    const url = `${DATA_API_HOST}/positions?user=${this._funderAddress}`;
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${url} failed: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json() as DataApiPosition[];
    const positions = Array.isArray(data) ? data : [];
    return positions.filter((p) => p.redeemable === true && p.size > 0);
  }

  public async redeem(
    conditionId: string,
    options: { metadataPrefix?: string; skipOraclePrecheck?: boolean } = {},
  ): Promise<RedeemResult> {
    const { metadataPrefix = 'Redeem', skipOraclePrecheck = false } = options;
    const calldata = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
      USDC_E_ADDRESS,
      ethers.ZeroHash,
      conditionId,
      [1, 2],
    ]);

    try {
      if (!skipOraclePrecheck) {
        try {
          await this._provider.estimateGas({
            to: CTF_ADDRESS,
            data: calldata,
            from: this._funderAddress,
          });
        } catch (preCheckErr) {
          const preMsg = preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr);
          if (preMsg.includes(ORACLE_NOT_READY_MSG)) {
            this._logger.info('Oracle not ready — redeem deferred', { conditionId });
            return { success: false, error: 'Oracle not ready yet' };
          }
        }
      }

      const response = await this._relayClient.execute(
        [{ to: CTF_ADDRESS, data: calldata, value: '0x0' }],
        `${metadataPrefix}: ${conditionId.slice(0, 10)}`,
      );

      this._logger.info('Redeem submitted to relayer', {
        conditionId: conditionId.slice(0, 20),
        transactionID: response.transactionID,
      });

      const receipt = await response.wait();
      if (!receipt) {
        return { success: false, error: 'No receipt from relayer' };
      }

      const success = receipt.state === 'STATE_MINED' || receipt.state === 'STATE_CONFIRMED';

      this._logger.info('Redeem result', {
        conditionId: conditionId.slice(0, 20),
        state: receipt.state,
        success,
        txHash: receipt.transactionHash,
      });

      return {
        success,
        txHash: receipt.transactionHash,
        error: success ? undefined : `Relayer state: ${receipt.state}`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (errorMsg.includes('revert') || errorMsg.includes('execution reverted')) {
        this._logger.debug('Redeem reverted (expected: no tokens or already redeemed)', {
          conditionId,
          error: errorMsg,
        });
        return { success: false, error: 'Reverted: no tokens to redeem or already redeemed' };
      }

      this._logger.error('Redeem failed', {
        conditionId,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    }
  }
}

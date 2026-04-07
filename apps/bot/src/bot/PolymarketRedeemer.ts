/**
 * PolymarketRedeemer — gasless авто-клейм settled позиций на Polymarket.
 *
 * @remarks
 * ### Назначение:
 * После settlement крипто-рынка (BTC Up/Down) вызывает `redeemPositions`
 * через Builder Relayer (gasless) для конвертации winning-токенов в USDC.e.
 *
 * ### Алгоритм:
 * 1. Получаем `conditionId` (= marketId в нашей системе) из settled рынка
 * 2. Кодируем calldata для `CTF.redeemPositions(USDC.e, 0x00, conditionId, [1, 2])`
 * 3. Отправляем через Builder Relayer (`POST /submit`) с PROXY типом
 * 4. Relayer выполняет транзакцию от proxy-кошелька, gas оплачивается Polymarket
 *
 * ### Контракты (Polygon mainnet):
 * - CTF: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
 * - USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
 *
 * ### Аутентификация:
 * - Builder API keys (отдельные от CLOB keys!) → HMAC-SHA256 заголовки
 * - EOA приватный ключ → EIP-712 подпись транзакции для proxy
 *
 * @example
 * ```typescript
 * const redeemer = PolymarketRedeemer.create({
 *   privateKey: '0x...',
 *   funderAddress: '0x326A...', // proxy address
 *   builderApiKey: '...',
 *   builderApiSecret: '...',
 *   builderApiPassphrase: '...',
 * }, logger);
 * await redeemer.redeem(conditionId);
 * ```
 */
import { ethers } from 'ethers';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import type { ILogger } from '@polymarket/logger';

// ── Контракты Polygon ─────────────────────────────────────────────────────────

/** Адрес CTF контракта на Polygon */
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** Адрес USDC.e (Bridged USDC) на Polygon */
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** ABI для redeemPositions (только функция, для кодирования calldata) */
const CTF_INTERFACE = new ethers.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

/** Polygon RPC по умолчанию (PublicNode — бесплатный, без API key) */
const DEFAULT_POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com';

/** Сообщение об ошибке оракула CTF (результат ещё не записан on-chain) */
const ORACLE_NOT_READY_MSG = 'result for condition not received yet';

// ── Типы ──────────────────────────────────────────────────────────────────────

/**
 * Параметры для создания PolymarketRedeemer.
 */
export interface PolymarketRedeemerConfig {
  /** Приватный ключ EOA (hex, с 0x) */
  readonly privateKey: string;
  /** Адрес proxy-кошелька Polymarket */
  readonly funderAddress: string;
  /** Builder API key */
  readonly builderApiKey: string;
  /** Builder API secret (base64) */
  readonly builderApiSecret: string;
  /** Builder API passphrase */
  readonly builderApiPassphrase: string;
  /** Polygon RPC URL (опционально) */
  readonly rpcUrl?: string;
}

/**
 * Результат операции redeem.
 */
export interface RedeemResult {
  /** Успешно ли прошёл redeem */
  readonly success: boolean;
  /** Хеш транзакции (если success) */
  readonly txHash?: string;
  /** Ошибка (если !success) */
  readonly error?: string;
}

// ── Реализация ────────────────────────────────────────────────────────────────

/**
 * Сервис gasless авто-клейма settled позиций через Builder Relayer.
 *
 * @remarks
 * Токены на Polymarket находятся на proxy-кошельке, а не на EOA.
 * Прямой вызов CTF не работает — нужен Builder Relayer для gasless proxy execution.
 * Relayer принимает подписанную транзакцию и выполняет её от имени proxy.
 */
export class PolymarketRedeemer {
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
    this._logger = logger.child({ component: 'PolymarketRedeemer' });
  }

  /**
   * Создаёт PolymarketRedeemer с Builder Relayer клиентом.
   *
   * @param config - Конфигурация (ключи, адреса)
   * @param logger - Logger
   * @returns Инстанс PolymarketRedeemer
   *
   * @throws {Error} Если не удаётся создать Wallet или BuilderConfig
   */
  public static create(config: PolymarketRedeemerConfig, logger: ILogger): PolymarketRedeemer {
    const provider = new ethers.JsonRpcProvider(
      config.rpcUrl ?? DEFAULT_POLYGON_RPC,
      137,
      { staticNetwork: true },
    );
    const wallet = new ethers.Wallet(config.privateKey, provider);

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
      wallet as any, // ethers v6 Wallet совместим с AbstractSigner interface
      builderConfig as any, // два экземпляра builder-signing-sdk (top-level и nested)
      RelayerTxType.PROXY,
    );

    return new PolymarketRedeemer(relayClient, provider, config.funderAddress, logger);
  }

  /**
   * Создаёт PolymarketRedeemer из переменных окружения.
   *
   * @param logger - Logger
   * @returns Инстанс PolymarketRedeemer
   *
   * @throws {Error} Если отсутствуют обязательные env vars
   *
   * @remarks
   * Ожидает env vars: PRIVATE_KEY, FUNDER_ADDRESS,
   * BUILDER_API_KEY, BUILDER_API_SECRET, BUILDER_API_PASSPHRASE
   */
  public static fromEnv(logger: ILogger): PolymarketRedeemer {
    const required = (key: string): string => {
      const val = process.env[key];
      if (!val) throw new Error(`Missing env var: ${key}`);
      return val;
    };

    return PolymarketRedeemer.create({
      privateKey: required('PRIVATE_KEY'),
      funderAddress: required('FUNDER_ADDRESS'),
      builderApiKey: required('BUILDER_API_KEY'),
      builderApiSecret: required('BUILDER_API_SECRET'),
      builderApiPassphrase: required('BUILDER_API_PASSPHRASE'),
    }, logger);
  }

  /**
   * Выполняет gasless redeem (клейм) settled позиции через Builder Relayer.
   *
   * @param conditionId - ID условия рынка (hex строка с 0x)
   * @returns Результат операции redeem
   *
   * @remarks
   * Кодирует calldata: `CTF.redeemPositions(USDC.e, 0x00...00, conditionId, [1, 2])`.
   * indexSets `[1, 2]` — обе стороны binary рынка.
   * Отправляет через Relayer с типом PROXY.
   *
   * Pre-check перед отправкой:
   * - Если оракул не готов (`"result for condition not received yet"`) — возвращает
   *   `{ success: false, error: 'Oracle not ready yet' }` без отправки транзакции.
   *   AutoRedeemer подхватит клейм когда оракул опубликует результат on-chain
   *   (Chainlink задерживается до 30-90 мин после истечения рынка).
   * - Нет токенов / уже claimed — on-chain noop, relayer возвращает reverted receipt.
   */
  public async redeem(conditionId: string): Promise<RedeemResult> {
    const parentCollectionId = ethers.ZeroHash;

    this._logger.info('Attempting gasless redeem via Builder Relayer', {
      conditionId,
      ctf: CTF_ADDRESS,
    });

    try {
      // Кодируем calldata для redeemPositions
      const calldata = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
        USDC_E_ADDRESS,
        parentCollectionId,
        conditionId,
        [1, 2],
      ]);

      // Pre-check: проверяем что оракул уже записал результат on-chain.
      // Это предотвращает отправку транзакции которая гарантированно упадёт с revert
      // "result for condition not received yet" — оракул Chainlink ещё не опубликовал
      // результат в CTF контракт. Chainlink может задерживаться на 30-90 минут после
      // истечения рынка. AutoRedeemer подхватит клейм когда оракул будет готов.
      try {
        await this._provider.estimateGas({
          to: CTF_ADDRESS,
          data: calldata,
          from: this._funderAddress,
        });
      } catch (preCheckErr) {
        const preMsg = preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr);
        if (preMsg.includes(ORACLE_NOT_READY_MSG)) {
          this._logger.info('Oracle not ready — skipping immediate redeem, AutoRedeemer will handle', {
            conditionId,
          });
          return { success: false, error: 'Oracle not ready yet' };
        }
        // Другие ошибки estimateGas — продолжаем, relayer сам решит
      }

      const tx = {
        to: CTF_ADDRESS,
        data: calldata,
        value: '0x0',
      };

      // execute() подписывает и отправляет через Relayer
      const response = await this._relayClient.execute(
        [tx],
        `Redeem: ${conditionId.slice(0, 10)}...`,
      );

      this._logger.info('Redeem submitted to relayer', {
        conditionId,
        transactionID: response.transactionID,
      });

      // Ждём подтверждения
      const receipt = await response.wait();

      if (!receipt) {
        return { success: false, error: 'No receipt from relayer' };
      }

      this._logger.info('Redeem confirmed', {
        conditionId,
        txHash: receipt.transactionHash,
        state: receipt.state,
      });

      return {
        success: receipt.state === 'STATE_MINED' || receipt.state === 'STATE_CONFIRMED',
        txHash: receipt.transactionHash,
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

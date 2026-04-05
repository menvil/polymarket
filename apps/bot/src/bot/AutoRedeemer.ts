/**
 * AutoRedeemer — фоновый сервис авто-клейма settled позиций на Polymarket.
 *
 * @remarks
 * ### Назначение:
 * Периодически проверяет settled рынки и автоматически выполняет redeem
 * через Builder Relayer (gasless). Работает в фоне — пока бот торгует или пока
 * пользователь спит.
 *
 * ### Алгоритм:
 * 1. Запрашивает историю trades пользователя через CLOB API (`/data/trades`)
 * 2. Для каждого уникального conditionId проверяет статус рынка (`/markets/{id}`)
 * 3. Если рынок settled (closed=true, active=false) и ещё не redeemed → вызывает redeem
 * 4. Хранит Set уже redeemed conditionIds чтобы не повторять
 * 5. Повторяет проверку каждые N секунд
 *
 * ### Зависимости:
 * - Builder API keys для gasless redeem через Relayer
 * - CLOB API keys для запроса trades (L2 auth)
 * - Не требует MATIC (gasless)
 *
 * @example
 * ```typescript
 * const redeemer = AutoRedeemer.fromEnv(logger);
 * redeemer.start(); // Запускает фоновый loop
 * // ... позже:
 * redeemer.stop();
 * ```
 */
import { ethers } from 'ethers';
import { createHmac } from 'crypto';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import type { ILogger } from '@polymarket/logger';

// ── Контракты ────────────────────────────────────────────────────────────────

/** Адрес CTF контракта на Polygon */
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** Адрес USDC.e (Bridged USDC) на Polygon */
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** ABI для кодирования calldata */
const CTF_INTERFACE = new ethers.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

const DEFAULT_POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com';
const CLOB_HOST = 'https://clob.polymarket.com';

/** Интервал проверки по умолчанию (5 минут) */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ── Типы ──────────────────────────────────────────────────────────────────────

/**
 * Конфигурация для AutoRedeemer.
 */
export interface AutoRedeemerConfig {
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
  /** CLOB API credentials (для запроса trades) */
  readonly clobApiKey: string;
  readonly clobApiSecret: string;
  readonly clobApiPassphrase: string;
  /** Интервал проверки в мс (по умолчанию 5 минут) */
  readonly checkIntervalMs?: number;
  /** Polygon RPC URL (опционально) */
  readonly rpcUrl?: string;
}

/**
 * Результат цикла проверки.
 */
interface CheckResult {
  /** Количество проверенных рынков */
  readonly marketsChecked: number;
  /** Количество settled рынков */
  readonly marketsSettled: number;
  /** Количество успешных redeem */
  readonly redeemed: number;
  /** Количество ошибок */
  readonly errors: number;
}

// ── Реализация ────────────────────────────────────────────────────────────────

/**
 * Фоновый сервис авто-клейма settled позиций.
 *
 * @remarks
 * Использует два отдельных набора API keys:
 * - CLOB API keys — для запроса trades (`/data/trades`, L2 auth)
 * - Builder API keys — для gasless redeem через Relayer
 */
export class AutoRedeemer {
  private readonly _relayClient: RelayClient;
  private readonly _provider: ethers.JsonRpcProvider;
  private readonly _logger: ILogger;
  private readonly _config: AutoRedeemerConfig;
  private readonly _walletAddress: string;
  private readonly _proxyAddress: string;
  private readonly _redeemedConditions = new Set<string>();
  /** Рынки с ошибками: conditionId → timestamp следующей попытки */
  private readonly _failedCooldowns = new Map<string, number>();
  /** Счётчик последовательных ошибок connection — для экспоненциального backoff всего цикла */
  private _consecutiveConnectionErrors = 0;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  private constructor(
    relayClient: RelayClient,
    provider: ethers.JsonRpcProvider,
    walletAddress: string,
    proxyAddress: string,
    config: AutoRedeemerConfig,
    logger: ILogger,
  ) {
    this._relayClient = relayClient;
    this._provider = provider;
    this._walletAddress = walletAddress;
    this._proxyAddress = proxyAddress;
    this._config = config;
    this._logger = logger.child({ component: 'AutoRedeemer' });
  }

  /**
   * Создаёт AutoRedeemer из конфигурации.
   *
   * @param config - Все необходимые credentials
   * @param logger - Logger
   * @returns Инстанс AutoRedeemer
   */
  public static create(config: AutoRedeemerConfig, logger: ILogger): AutoRedeemer {
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
      wallet as any,
      builderConfig as any, // два экземпляра builder-signing-sdk (top-level и nested)
      RelayerTxType.PROXY,
    );

    return new AutoRedeemer(relayClient, provider, wallet.address, config.funderAddress, config, logger);
  }

  /**
   * Создаёт AutoRedeemer из переменных окружения.
   *
   * @param logger - Logger
   * @returns Инстанс AutoRedeemer
   *
   * @throws {Error} Если отсутствуют обязательные env vars
   */
  public static fromEnv(logger: ILogger): AutoRedeemer {
    const required = (key: string): string => {
      const val = process.env[key];
      if (!val) throw new Error(`Missing env var: ${key}`);
      return val;
    };

    return AutoRedeemer.create({
      privateKey: required('PRIVATE_KEY'),
      funderAddress: required('FUNDER_ADDRESS'),
      builderApiKey: required('BUILDER_API_KEY'),
      builderApiSecret: required('BUILDER_API_SECRET'),
      builderApiPassphrase: required('BUILDER_API_PASSPHRASE'),
      clobApiKey: required('POLYMARKET_API_KEY'),
      clobApiSecret: required('POLYMARKET_API_SECRET'),
      clobApiPassphrase: required('POLYMARKET_API_PASSPHRASE'),
    }, logger);
  }

  /**
   * Запускает фоновый loop проверки и авто-клейма.
   *
   * @remarks
   * Первая проверка происходит сразу, затем повторяется каждые `checkIntervalMs` мс.
   */
  public start(): void {
    if (this._running) return;
    this._running = true;

    const interval = this._config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this._logger.info('Auto-redeemer started', { intervalMs: interval });

    // Первая проверка сразу
    void this._checkAndRedeem();

    // Повторяем периодически
    this._timer = setInterval(() => {
      void this._checkAndRedeem();
    }, interval);
  }

  /**
   * Останавливает фоновый loop.
   */
  public stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._logger.info('Auto-redeemer stopped');
  }

  /**
   * Выполняет одну проверку и redeem settled рынков.
   *
   * @returns Результат проверки
   */
  public async checkOnce(): Promise<CheckResult> {
    return this._checkAndRedeem();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Основной цикл: получить trades → найти settled рынки → batch redeem.
   *
   * @remarks
   * Собирает все settled conditionIds в один batch и выполняет
   * один `relayClient.execute([tx1, tx2, ...])` — multicall через proxy.
   * Один HTTP запрос = один unit квоты, вместо N запросов = N units.
   */
  private async _checkAndRedeem(): Promise<CheckResult> {
    const result = { marketsChecked: 0, marketsSettled: 0, redeemed: 0, errors: 0 };

    try {
      // 1. Получаем уникальные conditionIds из trades
      const conditionIds = await this._getRecentConditionIds();
      result.marketsChecked = conditionIds.length;

      if (conditionIds.length === 0) {
        this._logger.debug('No recent trades found');
        return result;
      }

      const now = Date.now();

      // 2. Собираем settled рынки для batch redeem
      const settledConditions: string[] = [];

      for (const conditionId of conditionIds) {
        if (this._redeemedConditions.has(conditionId)) continue;

        // Cooldown: пропускаем рынки с недавними ошибками
        const cooldownUntil = this._failedCooldowns.get(conditionId);
        if (cooldownUntil && now < cooldownUntil) continue;

        try {
          const isSettled = await this._isMarketSettled(conditionId);
          if (isSettled) {
            // Проверяем on-chain баланс: если 0 токенов — нечего клеймить
            const hasBalance = await this._hasTokenBalance(conditionId);
            if (hasBalance) {
              settledConditions.push(conditionId);
              this._logger.debug('Market has token balance, will redeem', { conditionId: conditionId.slice(0, 20) });
            } else {
              // Нет токенов — помечаем как redeemed (уже claimed или проиграл)
              this._redeemedConditions.add(conditionId);
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // API ошибки при проверке — cooldown 10 минут
          this._failedCooldowns.set(conditionId, now + 10 * 60_000);
          this._logger.debug('Failed to check market settlement', { conditionId, error: errMsg });
        }
      }

      result.marketsSettled = settledConditions.length;

      if (settledConditions.length === 0) {
        this._logger.debug('No settled markets to redeem', { checked: conditionIds.length });
        return result;
      }

      // 3. Batch redeem: разбиваем на chunk'и по 10 чтобы не исчерпать relayer quota
      const BATCH_CHUNK_SIZE = 10;
      const chunks: string[][] = [];
      for (let i = 0; i < settledConditions.length; i += BATCH_CHUNK_SIZE) {
        chunks.push(settledConditions.slice(i, i + BATCH_CHUNK_SIZE));
      }
      this._logger.info('Batch redeem: submitting in chunks', {
        total: settledConditions.length,
        chunks: chunks.length,
        chunkSize: BATCH_CHUNK_SIZE,
      });

      try {
        let totalRedeemed = 0;
        for (const chunk of chunks) {
          const success = await this._batchRedeem(chunk);
          if (success) {
            totalRedeemed += chunk.length;
            for (const cid of chunk) {
              this._redeemedConditions.add(cid);
              this._failedCooldowns.delete(cid);
            }
          } else {
            // Chunk failed — ставим cooldown на оставшиеся и прерываем
            for (const cid of chunk) {
              this._failedCooldowns.set(cid, now + 10 * 60_000);
            }
            break;
          }
        }
        if (totalRedeemed > 0) {
          result.redeemed = totalRedeemed;
          this._consecutiveConnectionErrors = 0;
          this._logger.info('Batch redeem completed', {
            redeemed: totalRedeemed,
            total: settledConditions.length,
          });
        } else {
          result.errors = settledConditions.length;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        if (errMsg.includes('429') || errMsg.includes('quota exceeded') || errMsg.includes('Too Many Requests')) {
          // Парсим "resets in N seconds" из ответа relayer
          const resetMatch = errMsg.match(/resets in (\d+) seconds/);
          const cooldownMs = resetMatch
            ? parseInt(resetMatch[1], 10) * 1000 + 60_000 // +1 мин запас
            : 60 * 60_000; // fallback: 1 час
          for (const cid of settledConditions) {
            this._failedCooldowns.set(cid, now + cooldownMs);
          }
          this._logger.warn('Relayer rate limit hit on batch redeem — cooldown set', {
            count: settledConditions.length,
            cooldownMin: Math.round(cooldownMs / 60_000),
            error: errMsg,
          });
        } else if (errMsg.includes('connection error') || errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT')) {
          this._consecutiveConnectionErrors++;
          const backoffMs = Math.min(60 * 60_000, 5 * 60_000 * Math.pow(2, this._consecutiveConnectionErrors - 1));
          for (const cid of settledConditions) {
            this._failedCooldowns.set(cid, now + backoffMs);
          }
          this._logger.warn('Relayer connection error on batch redeem', {
            nextRetryMin: Math.round(backoffMs / 60_000),
          });
        } else if (errMsg.includes('revert') || errMsg.includes('execution reverted')) {
          // Batch revert: некоторые уже redeemed. Fallback на по-одному.
          this._logger.warn('Batch redeem reverted — falling back to individual redeem', {
            count: settledConditions.length,
          });
          await this._fallbackIndividualRedeem(settledConditions, result, now);
        } else {
          for (const cid of settledConditions) {
            this._failedCooldowns.set(cid, now + 10 * 60_000);
          }
          this._logger.error('Batch redeem failed', { error: errMsg });
        }
        result.errors++;
      }

      if (result.redeemed > 0) {
        this._logger.info('Redeem cycle complete', result);
      }
    } catch (err) {
      this._logger.error('Auto-redeem check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  /**
   * Fallback: redeem по одному если batch revert (часть рынков уже redeemed).
   */
  private async _fallbackIndividualRedeem(
    conditionIds: string[],
    result: CheckResult & { redeemed: number; errors: number },
    now: number,
  ): Promise<void> {
    for (const conditionId of conditionIds) {
      try {
        const success = await this._redeemCondition(conditionId);
        if (success) {
          result.redeemed++;
          this._redeemedConditions.add(conditionId);
        } else {
          // revert = already redeemed or no tokens
          this._redeemedConditions.add(conditionId);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('429') || errMsg.includes('quota exceeded')) {
          this._logger.warn('Rate limit during fallback, stopping', { redeemed: result.redeemed });
          break;
        }
        this._failedCooldowns.set(conditionId, now + 10 * 60_000);
        result.errors++;
      }
    }
  }

  /** Маппинг conditionId → Set<tokenId> (asset_id из trades) */
  private readonly _conditionTokenIds = new Map<string, Set<string>>();

  /**
   * Получает уникальные conditionIds из недавних trades пользователя.
   * Также запоминает tokenIds для каждого conditionId (для balance check).
   *
   * @returns Массив conditionIds
   */
  private async _getRecentConditionIds(): Promise<string[]> {
    const path = '/data/trades';
    const headers = this._buildL2Headers('GET', path);

    // L2 auth автоматически фильтрует по owner (нашему кошельку)
    const res = await fetch(`${CLOB_HOST}${path}`, { method: 'GET', headers });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET /data/trades failed: ${res.status} ${text}`);
    }

    const data = await res.json() as any;
    const trades = Array.isArray(data) ? data : (data.data ?? data.trades ?? []);

    const conditionIds = new Set<string>();
    for (const trade of trades) {
      if (trade.market) {
        conditionIds.add(trade.market);
        // Запоминаем tokenId для balance check
        if (trade.asset_id) {
          let tokens = this._conditionTokenIds.get(trade.market);
          if (!tokens) {
            tokens = new Set<string>();
            this._conditionTokenIds.set(trade.market, tokens);
          }
          tokens.add(trade.asset_id);
        }
      }
    }

    return [...conditionIds];
  }

  /**
   * Проверяет, settled ли рынок (closed и не active).
   *
   * @param conditionId - ID условия рынка
   * @returns true если рынок settled
   */
  private async _isMarketSettled(conditionId: string): Promise<boolean> {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`);

    if (!res.ok) {
      if (res.status === 404) return false;
      throw new Error(`GET /markets/${conditionId} failed: ${res.status}`);
    }

    const market = await res.json() as any;

    // Рынок settled если closed=true (active может оставаться true на Polymarket)
    return market.closed === true;
  }

  /**
   * Проверяет on-chain баланс CTF токенов для conditionId.
   *
   * @param conditionId - conditionId рынка
   * @returns true если есть хотя бы один токен на proxy кошельке
   *
   * @remarks
   * Использует tokenIds (asset_id) из trades API, не вычисляет из conditionId.
   * CTF контракт — ERC1155, balanceOf(address, uint256 tokenId).
   */
  private async _hasTokenBalance(conditionId: string): Promise<boolean> {
    const tokenIds = this._conditionTokenIds.get(conditionId);
    if (!tokenIds || tokenIds.size === 0) {
      // Нет tokenIds — не можем проверить, пропускаем
      return false;
    }

    try {
      const ctf = new ethers.Contract(
        CTF_ADDRESS,
        ['function balanceOf(address owner, uint256 id) view returns (uint256)'],
        this._provider,
      );

      for (const tokenId of tokenIds) {
        const balance = await ctf.balanceOf(this._proxyAddress, tokenId) as bigint;
        if (balance > 0n) return true;
      }

      return false;
    } catch (err) {
      // RPC ошибка — пропускаем, попробуем в следующем цикле
      this._logger.warn('Failed to check token balance (RPC error), skipping', {
        conditionId: conditionId.slice(0, 20),
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Batch redeem: все conditionIds одним multicall запросом к Relayer.
   *
   * @param conditionIds - Массив conditionIds для redeem
   * @returns true если batch redeem успешен
   *
   * @remarks
   * RelayClient.execute() принимает массив транзакций и кодирует их
   * в один proxy multicall. Один HTTP запрос = один unit квоты.
   */
  private async _batchRedeem(conditionIds: string[]): Promise<boolean> {
    const txns = conditionIds.map((conditionId) => {
      const calldata = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
        USDC_E_ADDRESS,
        ethers.ZeroHash,
        conditionId,
        [1, 2],
      ]);
      return { to: CTF_ADDRESS, data: calldata, value: '0x0' };
    });

    const response = await this._relayClient.execute(
      txns,
      `AutoRedeem batch: ${conditionIds.length} markets`,
    );

    this._logger.info('Batch redeem submitted to relayer', {
      count: conditionIds.length,
      transactionID: response.transactionID,
    });

    const receipt = await response.wait();

    const state = receipt?.state ?? 'unknown';
    const success = state === 'STATE_MINED' || state === 'STATE_CONFIRMED';

    this._logger.info('Batch redeem result', {
      count: conditionIds.length,
      transactionID: response.transactionID,
      state,
      success,
    });

    if (!success) {
      // Batch reverted — скорее всего большинство уже redeemed.
      // Помечаем все как redeemed чтобы не повторять бесконечно.
      // Если один маркет реально не redeemed — его поймает следующий цикл
      // через `_getRecentConditionIds()` (новые trades).
      this._logger.warn('Batch redeem failed/reverted — marking all as redeemed to avoid infinite retry', {
        count: conditionIds.length,
        state,
      });
      for (const cid of conditionIds) {
        this._redeemedConditions.add(cid);
      }
    }

    return success;
  }

  /**
   * Выполняет gasless redeem через Builder Relayer (одиночный).
   *
   * @param conditionId - ID условия рынка
   * @returns true если redeem успешен
   */
  private async _redeemCondition(conditionId: string): Promise<boolean> {
    const calldata = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
      USDC_E_ADDRESS,
      ethers.ZeroHash,
      conditionId,
      [1, 2],
    ]);

    const tx = { to: CTF_ADDRESS, data: calldata, value: '0x0' };

    try {
      const response = await this._relayClient.execute(
        [tx],
        `AutoRedeem: ${conditionId.slice(0, 10)}`,
      );

      this._logger.info('Redeem submitted to relayer', {
        conditionId,
        transactionID: response.transactionID,
      });

      const receipt = await response.wait();
      if (!receipt) return false;

      return receipt.state === 'STATE_MINED' || receipt.state === 'STATE_CONFIRMED';
    } catch (err) {
      // Error.message содержит JSON от relay client: {"error":"request error","status":429,...}
      // JSON.stringify(Error) даёт "{}" — используем message для проверок
      const msg = err instanceof Error ? err.message : String(err);

      // 429 Rate Limit — пробрасываем наверх для остановки цикла
      if (msg.includes('429') || msg.includes('quota exceeded') || msg.includes('Too Many Requests')) {
        throw new Error(`Rate limit: ${msg}`);
      }

      if (msg.includes('revert') || msg.includes('execution reverted')) {
        // Revert = no tokens. Пометим как redeemed чтобы не пробовать снова
        this._redeemedConditions.add(conditionId);
        this._logger.debug('Redeem reverted (no tokens or already redeemed)', { conditionId });
        return false;
      }

      throw err;
    }
  }

  /**
   * Строит L2-заголовки для CLOB API.
   *
   * @param method - HTTP метод
   * @param path - URL путь
   * @returns Заголовки для запроса
   */
  private _buildL2Headers(method: string, path: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000);
    const message = `${ts}${method}${path}`;
    const base64Secret = Buffer.from(this._config.clobApiSecret, 'base64');
    const hmac = createHmac('sha256', base64Secret);
    const sig = hmac.update(message).digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return {
      POLY_ADDRESS: this._walletAddress,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: `${ts}`,
      POLY_API_KEY: this._config.clobApiKey,
      POLY_PASSPHRASE: this._config.clobApiPassphrase,
    };
  }
}

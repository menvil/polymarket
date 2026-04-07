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
 * 3. Если settled (closed=true) — проверяет on-chain баланс CTF токенов
 * 4. Если баланс > 0 → вызывает redeemPositions через Builder Relayer (gasless)
 * 5. Никакого постоянного состояния — каждый цикл проверяет заново
 *    (redeemPositions идемпотентен: noop если токенов нет)
 *
 * ### Зависимости:
 * - Builder API keys для gasless redeem через Relayer
 * - CLOB API keys для запроса trades (L2 auth)
 * - Polygon RPC для проверки on-chain балансов (только чтение)
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
  /** Адрес proxy-кошелька Polymarket (для проверки on-chain баланса) */
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
  readonly marketsChecked: number;
  readonly marketsSettled: number;
  readonly redeemed: number;
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
  /** Накапливает tokenIds по conditionId из trades API для balance check */
  private readonly _conditionTokenIds = new Map<string, Set<string>>();
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
      config.rpcUrl ?? 'https://polygon-bor-rpc.publicnode.com',
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
      builderConfig as any,
      RelayerTxType.PROXY,
    );

    return new AutoRedeemer(relayClient, provider, wallet.address, config.funderAddress, config, logger);
  }

  /**
   * Создаёт AutoRedeemer из переменных окружения.
   *
   * @param logger - Logger
   * @returns Инстанс AutoRedeemer
   * @throws {Error} Если отсутствуют обязательные env vars
   */
  public static fromEnv(logger: ILogger): AutoRedeemer {
    const required = (key: string): string => {
      const val = process.env[key];
      if (!val) throw new Error(`Missing env var: ${key}`);
      return val;
    };

    return AutoRedeemer.create({
      privateKey:          required('PRIVATE_KEY'),
      funderAddress:       required('FUNDER_ADDRESS'),
      builderApiKey:       required('BUILDER_API_KEY'),
      builderApiSecret:    required('BUILDER_API_SECRET'),
      builderApiPassphrase: required('BUILDER_API_PASSPHRASE'),
      clobApiKey:          required('POLYMARKET_API_KEY'),
      clobApiSecret:       required('POLYMARKET_API_SECRET'),
      clobApiPassphrase:   required('POLYMARKET_API_PASSPHRASE'),
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

    void this._checkAndRedeem();

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
   * Основной цикл: получить trades → для settled рынков проверить баланс → redeem.
   *
   * @remarks
   * Намеренно без постоянного состояния (нет `_redeemedConditions` Set):
   * - Отсутствие состояния = нет риска permanent skip при ошибках
   * - RPC ошибка при balance check → throw → пропустить этот цикл, попробуем снова через 5 мин
   * - redeemPositions idempotent: если токенов нет → on-chain noop, не тратим relayer впустую
   * - Balance check защищает от лишних relayer вызовов для уже claimed/losing позиций
   */
  private async _checkAndRedeem(): Promise<CheckResult> {
    const result = { marketsChecked: 0, marketsSettled: 0, redeemed: 0, errors: 0 };

    try {
      const conditionIds = await this._getRecentConditionIds();
      result.marketsChecked = conditionIds.length;

      this._logger.info('Auto-redeem cycle: checking markets', {
        marketsFromTrades: conditionIds.length,
      });

      if (conditionIds.length === 0) {
        return result;
      }

      // Шаг 1: параллельно проверяем статус всех рынков (settled/active)
      const settledResults = await Promise.allSettled(
        conditionIds.map((id) => this._isMarketSettled(id)),
      );
      const settledIds = conditionIds.filter((_, i) => {
        const r = settledResults[i];
        return r.status === 'fulfilled' && r.value === true;
      });
      result.marketsSettled = settledIds.length;

      // Шаг 2: для settled рынков — проверяем баланс и клеймим последовательно
      // (redeem sequential: каждый нонс на proxy кошельке должен идти по порядку)
      for (const conditionId of settledIds) {
        try {
          // Balance check: если 0 — уже claimed или проиграли, relayer не дёргаем
          // Если RPC ошибка — _hasTokenBalance бросит исключение → catch → следующий цикл
          const hasBalance = await this._hasTokenBalance(conditionId);
          if (!hasBalance) continue;

          const success = await this._redeemCondition(conditionId);
          if (success) result.redeemed++;
        } catch (err) {
          this._logger.info('Redeem error — will retry in next cycle', {
            conditionId: conditionId.slice(0, 20),
            error: err instanceof Error ? err.message.slice(0, 150) : String(err),
          });
          result.errors++;
        }
      }

      this._logger.info('Auto-redeem cycle complete', result);
    } catch (err) {
      this._logger.info('Auto-redeem check failed — will retry in next cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  /**
   * Получает уникальные conditionIds из недавних trades пользователя.
   * Попутно накапливает tokenIds → `_conditionTokenIds` для balance check.
   *
   * @returns Массив conditionIds
   */
  private async _getRecentConditionIds(): Promise<string[]> {
    const path = '/data/trades';
    const headers = this._buildL2Headers('GET', path);

    const res = await fetch(`${CLOB_HOST}${path}`, { method: 'GET', headers });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET /data/trades failed: ${res.status} ${text}`);
    }

    const data = await res.json() as any;
    const trades = Array.isArray(data) ? data : (data.data ?? data.trades ?? []);

    const conditionIds = new Set<string>();
    for (const trade of trades) {
      if (!trade.market) continue;
      conditionIds.add(trade.market);
      if (trade.asset_id) {
        let tokens = this._conditionTokenIds.get(trade.market);
        if (!tokens) {
          tokens = new Set<string>();
          this._conditionTokenIds.set(trade.market, tokens);
        }
        tokens.add(trade.asset_id);
      }
    }

    return [...conditionIds];
  }

  /**
   * Проверяет, settled ли рынок (closed=true в CLOB API).
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
    return market.closed === true;
  }

  /**
   * Проверяет on-chain баланс CTF токенов для conditionId на proxy кошельке.
   *
   * @param conditionId - conditionId рынка
   * @returns true если есть хотя бы один токен
   * @throws При ошибке RPC — caller пропускает этот цикл и повторит через 5 минут
   *
   * @remarks
   * НЕ возвращает false при ошибке RPC (старый баг: false → caller думал "0 баланс" →
   * добавлял в _redeemedConditions → навсегда пропускал conditionId).
   * Вместо этого — throws, чтобы caller обработал ошибку без postоянного skip.
   */
  private async _hasTokenBalance(conditionId: string): Promise<boolean> {
    const tokenIds = this._conditionTokenIds.get(conditionId);

    if (!tokenIds || tokenIds.size === 0) {
      // tokenIds неизвестны — пробуем redeem оптимистично (не пропустим выигрыш)
      return true;
    }

    const ctf = new ethers.Contract(
      CTF_ADDRESS,
      ['function balanceOf(address owner, uint256 id) view returns (uint256)'],
      this._provider,
    );

    for (const tokenId of tokenIds) {
      // RPC ошибка здесь бросит исключение → выйдет наверх в _checkAndRedeem catch
      const balance = await ctf.balanceOf(this._proxyAddress, tokenId) as bigint;
      if (balance > 0n) return true;
    }

    return false;
  }

  /**
   * Выполняет gasless redeem через Builder Relayer.
   *
   * @param conditionId - ID условия рынка
   * @returns true если STATE_MINED или STATE_CONFIRMED
   */
  private async _redeemCondition(conditionId: string): Promise<boolean> {
    const calldata = CTF_INTERFACE.encodeFunctionData('redeemPositions', [
      USDC_E_ADDRESS,
      ethers.ZeroHash,
      conditionId,
      [1, 2],
    ]);

    const response = await this._relayClient.execute(
      [{ to: CTF_ADDRESS, data: calldata, value: '0x0' }],
      `AutoRedeem: ${conditionId.slice(0, 10)}`,
    );

    this._logger.info('Redeem submitted to relayer', {
      conditionId: conditionId.slice(0, 20),
      transactionID: response.transactionID,
    });

    const receipt = await response.wait();
    if (!receipt) return false;

    const success = receipt.state === 'STATE_MINED' || receipt.state === 'STATE_CONFIRMED';

    this._logger.info('Redeem result', {
      conditionId: conditionId.slice(0, 20),
      state: receipt.state,
      success,
    });

    return success;
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
      POLY_ADDRESS:    this._walletAddress,
      POLY_SIGNATURE:  sig,
      POLY_TIMESTAMP:  `${ts}`,
      POLY_API_KEY:    this._config.clobApiKey,
      POLY_PASSPHRASE: this._config.clobApiPassphrase,
    };
  }
}

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
 * 1. Запрашивает redeemable позиции с proxy-кошелька через `data-api.polymarket.com/positions`
 * 2. Для каждой redeemable позиции вызывает `redeemPositions` через Builder Relayer (gasless)
 * 3. Никакого постоянного состояния — каждый цикл проверяет заново
 *    (redeemPositions идемпотентен: noop если токенов нет)
 *
 * ### Зависимости:
 * - Builder API keys для gasless redeem через Relayer
 * - Polygon RPC (только для создания Wallet под Relayer)
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

/** Data API для получения позиций (не требует CLOB авторизации) */
const DATA_API_HOST = 'https://data-api.polymarket.com';

/** Интервал проверки по умолчанию (5 минут) */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ── Типы ──────────────────────────────────────────────────────────────────────

/**
 * Конфигурация для AutoRedeemer.
 */
export interface AutoRedeemerConfig {
  /** Приватный ключ EOA (hex, с 0x) */
  readonly privateKey: string;
  /** Адрес proxy-кошелька Polymarket (для получения позиций) */
  readonly funderAddress: string;
  /** Builder API key */
  readonly builderApiKey: string;
  /** Builder API secret (base64) */
  readonly builderApiSecret: string;
  /** Builder API passphrase */
  readonly builderApiPassphrase: string;
  /** CLOB API credentials (опционально — больше не используются для основного flow) */
  readonly clobApiKey?: string;
  readonly clobApiSecret?: string;
  readonly clobApiPassphrase?: string;
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

/**
 * Позиция из data-api.polymarket.com/positions.
 *
 * @remarks
 * `asset` — корректный CTF position tokenId (uint256 в decimal).
 * Отличается от `asset_id` в /data/trades (тот — CLOB-внутренний идентификатор).
 */
interface DataApiPosition {
  readonly conditionId: string;
  readonly asset: string;
  readonly size: number;
  readonly currentValue: number;
  readonly redeemable: boolean;
}

// ── Реализация ────────────────────────────────────────────────────────────────

/**
 * Фоновый сервис авто-клейма settled позиций.
 *
 * @remarks
 * Использует `data-api.polymarket.com/positions` как источник redeemable позиций —
 * не требует CLOB авторизации. Builder API keys нужны для gasless redeem через Relayer.
 */
export class AutoRedeemer {
  private readonly _relayClient: RelayClient;
  private readonly _logger: ILogger;
  private readonly _config: AutoRedeemerConfig;
  /** Proxy-кошелёк Polymarket — здесь хранятся CTF токены */
  private readonly _proxyAddress: string;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  private constructor(
    relayClient: RelayClient,
    _provider: ethers.JsonRpcProvider,
    _walletAddress: string,
    proxyAddress: string,
    config: AutoRedeemerConfig,
    logger: ILogger,
  ) {
    this._relayClient = relayClient;
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
      privateKey:           required('PRIVATE_KEY'),
      funderAddress:        required('FUNDER_ADDRESS'),
      builderApiKey:        required('BUILDER_API_KEY'),
      builderApiSecret:     required('BUILDER_API_SECRET'),
      builderApiPassphrase: required('BUILDER_API_PASSPHRASE'),
      // CLOB ключи опциональны — больше не используются для основного flow
      clobApiKey:           process.env['POLYMARKET_API_KEY'],
      clobApiSecret:        process.env['POLYMARKET_API_SECRET'],
      clobApiPassphrase:    process.env['POLYMARKET_API_PASSPHRASE'],
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
   * Основной цикл: получить redeemable позиции из data-api → клеймить последовательно.
   *
   * @remarks
   * ### Почему data-api, а не /data/trades + /markets/{id} + CTF.balanceOf:
   *
   * Старый pipeline содержал баг: `trade.asset_id` из CLOB API — это
   * CLOB-внутренний идентификатор, который НЕ совпадает с CTF position tokenId.
   * `CTF.balanceOf(proxy, trade.asset_id)` всегда возвращал 0, хотя реальный
   * баланс был 5_000_000 (5 токенов). Правильный CTF tokenId хранится в поле
   * `asset` ответа `data-api.polymarket.com/positions`.
   *
   * Дополнительно старый pipeline имел проблему пагинации: `/data/trades`
   * возвращает только 300 последних трейдов без автоматического обхода страниц.
   *
   * data-api решает обе проблемы:
   * - Уже знает какие позиции `redeemable=true` (рынок settled + есть токены)
   * - Не требует CLOB авторизации
   * - Не зависит от пагинации трейдов
   * - redeemPositions идемпотентен: losing позиции клеймятся в noop (0 USDC)
   */
  private async _checkAndRedeem(): Promise<CheckResult> {
    const result = { marketsChecked: 0, marketsSettled: 0, redeemed: 0, errors: 0 };

    try {
      const positions = await this._getRedeemablePositions();
      result.marketsChecked = positions.length;
      result.marketsSettled = positions.length;

      this._logger.info('Auto-redeem cycle: checking positions', {
        redeemable: positions.length,
      });

      if (positions.length === 0) {
        this._logger.info('Auto-redeem cycle complete', result);
        return result;
      }

      // Дедуплицируем по conditionId — одна позиция на рынок
      const uniqueConditionIds = [...new Map(positions.map((p) => [p.conditionId, p])).values()];

      // Клеймим последовательно (нонсы proxy-кошелька должны идти по порядку)
      for (const position of uniqueConditionIds) {
        try {
          const success = await this._redeemCondition(position.conditionId);
          if (success) result.redeemed++;
        } catch (err) {
          this._logger.info('Redeem error — will retry in next cycle', {
            conditionId: position.conditionId.slice(0, 20),
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
   * Получает redeemable позиции с proxy-кошелька через data-api.
   *
   * @returns Массив позиций с redeemable=true
   *
   * @remarks
   * `data-api.polymarket.com/positions?user={proxy}` возвращает все открытые позиции
   * пользователя. Поле `redeemable=true` означает: рынок settled И на proxy есть CTF-токены.
   * Поле `asset` содержит корректный CTF position tokenId для `balanceOf()`.
   */
  private async _getRedeemablePositions(): Promise<DataApiPosition[]> {
    const url = `${DATA_API_HOST}/positions?user=${this._proxyAddress}`;
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${url} failed: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json() as DataApiPosition[];
    const positions = Array.isArray(data) ? data : [];

    return positions.filter((p) => p.redeemable === true && p.size > 0);
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
}

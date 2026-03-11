/**
 * Провайдер баланса Polymarket
 *
 * @remarks
 * Реализует интерфейс IBalanceProvider.
 * Использует PolymarketBalanceRestClient + PolymarketBalanceMapper.
 *
 * Обязанности:
 * - Получение данных баланса из API
 * - Нормализация данных с помощью маппера
 * - Возврат балансов в доменном формате (Money / AssetQuantity)
 *
 * @example
 * ```typescript
 * const provider = new PolymarketBalanceProvider(
 *   balanceClient,
 *   mapper,
 *   logger
 * );
 *
 * const available = await provider.getAvailableBalance();
 * console.log(`Available: ${available.toNumber()} USDC`);
 *
 * const outcomeBalance = await provider.getOutcomeBalance('62305...');
 * console.log(`Outcome tokens: ${outcomeBalance.amount().value().toNumber()}`);
 * ```
 */

import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { Money, AssetQuantity, Quantity } from '@polymarket/value-objects';
import { asPolymarketCtfToken } from '@polymarket/ids';
import type { IBalanceProvider } from '../../ports/IBalanceProvider.js';
import type { PolymarketBalanceRestClient } from '../clients/PolymarketBalanceRestClient.js';
import type { PolymarketBalanceMapper } from '../mappers/PolymarketBalanceMapper.js';

/** Виртуальный баланс в режиме симуляции (1M USDC) */
const SIMULATION_USDC_BALANCE = new Decimal(1_000_000);

/**
 * Провайдер баланса Polymarket
 *
 * @remarks
 * Реализует IBalanceProvider для Polymarket.
 */
export class PolymarketBalanceProvider implements IBalanceProvider {
  constructor(
    private readonly balanceClient: PolymarketBalanceRestClient,
    private readonly mapper: PolymarketBalanceMapper,
    private readonly logger: ILogger,
    private readonly simulationMode: boolean = false
  ) {}

  /**
   * Получить доступный баланс USDC.
   *
   * @returns Money в USDC (не заблокированный в открытых ордерах)
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const balance = await provider.getAvailableBalance();
   * console.log(`Available: ${balance.toNumber()} USDC`);
   * ```
   */
  async getAvailableBalance(): Promise<Money> {
    if (this.simulationMode) {
      const virtualBalance = Money.of(SIMULATION_USDC_BALANCE, 'USDC');
      this.logger.debug('Getting available balance (SIMULATION MODE)', {
        virtualBalance: virtualBalance.toNumber(),
      });
      return virtualBalance;
    }

    this.logger.debug('Getting available balance');

    const rawBalances = await this.balanceClient.getBalances();
    const normalized  = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Available balance retrieved', {
      availableUSDC: normalized.available.toNumber(),
    });

    return normalized.available;
  }

  /**
   * Получить баланс outcome-токена для конкретного токена.
   *
   * @param tokenId - Числовой идентификатор токена из Polymarket API
   * @returns AssetQuantity с типом POLYMARKET_CTF_TOKEN
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const balance = await provider.getOutcomeBalance('62305...');
   * console.log(`Outcome tokens: ${balance.amount().value().toNumber()}`);
   * ```
   */
  async getOutcomeBalance(tokenId: string): Promise<AssetQuantity> {
    if (this.simulationMode) {
      this.logger.debug('Getting outcome balance (SIMULATION MODE)', { tokenId });
      return this._zeroTokenBalance(tokenId);
    }

    this.logger.debug('Getting outcome balance', { tokenId });

    const balance = await this.balanceClient.getOutcomeTokenBalance(tokenId);
    const assetId = asPolymarketCtfToken(tokenId);

    if (!assetId) {
      this.logger.warn('Invalid tokenId format, returning zero balance', { tokenId });
      return this._zeroTokenBalance(tokenId);
    }

    const qty = Quantity.of(new Decimal(balance));

    this.logger.debug('Outcome balance retrieved', {
      tokenId,
      balance,
    });

    return new AssetQuantity(assetId, qty);
  }

  /**
   * Получить заблокированный баланс USDC (в открытых ордерах на бирже).
   *
   * @returns Money в USDC
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const locked = await provider.getLockedBalance();
   * console.log(`Locked in orders: ${locked.toNumber()} USDC`);
   * ```
   */
  async getLockedBalance(): Promise<Money> {
    if (this.simulationMode) {
      const virtualLocked = Money.ZERO['USDC'];
      this.logger.debug('Getting locked balance (SIMULATION MODE)', {
        virtualLocked: virtualLocked.toNumber(),
      });
      return virtualLocked;
    }

    this.logger.debug('Getting locked balance');

    const rawBalances = await this.balanceClient.getBalances();
    const normalized  = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Locked balance retrieved', {
      lockedUSDC: normalized.locked.toNumber(),
    });

    return normalized.locked;
  }

  /**
   * Получить общий баланс USDC (доступный + заблокированный).
   *
   * @returns Money в USDC
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const total = await provider.getTotalBalance();
   * console.log(`Total: ${total.toNumber()} USDC`);
   * ```
   */
  async getTotalBalance(): Promise<Money> {
    if (this.simulationMode) {
      const virtualTotal = Money.of(SIMULATION_USDC_BALANCE, 'USDC');
      this.logger.debug('Getting total balance (SIMULATION MODE)', {
        virtualTotal: virtualTotal.toNumber(),
      });
      return virtualTotal;
    }

    this.logger.debug('Getting total balance');

    const rawBalances = await this.balanceClient.getBalances();
    const normalized  = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Total balance retrieved', {
      totalUSDC: normalized.total.toNumber(),
    });

    return normalized.total;
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Создаёт нулевой AssetQuantity для outcome-токена по tokenId.
   *
   * @param tokenId - Числовой идентификатор токена
   * @returns AssetQuantity с нулевым количеством
   *
   * @remarks
   * Fallback для симуляции или невалидного tokenId.
   * Если tokenId не является валидным числовым строком — использует USDC как заглушку.
   */
  private _zeroTokenBalance(tokenId: string): AssetQuantity {
    const assetId = asPolymarketCtfToken(tokenId);
    if (assetId) {
      return new AssetQuantity(assetId, Quantity.ZERO);
    }
    // Fallback: невалидный tokenId — возвращаем нулевой USDC как заглушку
    return AssetQuantity.usdc(Quantity.ZERO);
  }
}

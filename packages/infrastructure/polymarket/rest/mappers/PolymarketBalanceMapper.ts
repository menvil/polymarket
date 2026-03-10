/**
 * Маппер баланса Polymarket
 *
 * @remarks
 * Преобразует необработанные ответы API Polymarket по балансу в доменные типы.
 *
 * Преобразования:
 * - Конвертация строки → число
 * - Нормализация имён полей
 * - Безопасные значения по умолчанию для отсутствующих полей
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketBalanceMapper(logger);
 *
 * const rawBalance = {
 *   asset: 'USDC',
 *   total: '1000.50',
 *   available: '900.25',
 *   locked: '100.25',
 * };
 *
 * const normalized = mapper.toDomainBalance(rawBalance);
 * // { availableUSDC: 900.25, lockedUSDC: 100.25, totalUSDC: 1000.50 }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { BalanceResponse } from '../clients/PolymarketBalanceRestClient.js';
import { USDC_MULTIPLIER } from '../constants.js';

/**
 * Нормализованный баланс (доменный формат)
 */
export interface NormalizedBalance {
  /** Доступный баланс USDC */
  availableUSDC: number;

  /** Заблокированный баланс USDC (в открытых ордерах) */
  lockedUSDC: number;

  /** Общий баланс USDC */
  totalUSDC: number;

  /** Балансы outcome-токенов (tokenId → баланс) */
  outcomeTokens: Record<string, number>;
}

/**
 * Маппер баланса Polymarket
 */
export class PolymarketBalanceMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Преобразовать ответ по балансу в доменный формат
   *
   * @param response - Необработанный ответ по балансу
   * @returns Нормализованный баланс
   *
   * @example
   * ```typescript
   * const rawBalance = {
   *   asset: 'USDC',
   *   total: '1000.50',
   *   available: '900.25',
   *   locked: '100.25',
   * };
   *
   * const normalized = mapper.toDomainBalance(rawBalance);
   * console.log(`Available: ${normalized.availableUSDC}`);
   * ```
   */
  toDomainBalance(response: BalanceResponse): NormalizedBalance {
    const available = this.parseBalance(response.available);
    const locked = this.parseBalance(response.locked);
    const total = this.parseBalance(response.total);

    return {
      availableUSDC: available,
      lockedUSDC: locked,
      totalUSDC: total,
      outcomeTokens: {},
    };
  }

  /**
   * Преобразовать несколько ответов по балансу в доменный формат
   *
   * @param responses - Массив необработанных ответов по балансу
   * @returns Нормализованный баланс с outcome-токенами
   *
   * @example
   * ```typescript
   * const balances = await balanceClient.getBalances();
   * const normalized = mapper.toDomainBalances(balances);
   *
   * console.log(`USDC: ${normalized.availableUSDC}`);
   * console.log(`Outcome tokens: ${Object.keys(normalized.outcomeTokens).length}`);
   * ```
   */
  toDomainBalances(responses: BalanceResponse[]): NormalizedBalance {
    const result: NormalizedBalance = {
      availableUSDC: 0,
      lockedUSDC: 0,
      totalUSDC: 0,
      outcomeTokens: {},
    };

    for (const response of responses) {
      if (response.asset === 'USDC') {
        result.availableUSDC = this.parseBalance(response.available);
        result.lockedUSDC = this.parseBalance(response.locked);
        result.totalUSDC = this.parseBalance(response.total);
      } else {
        // Outcome-токен
        const tokenId = response.asset;
        const balance = this.parseBalance(response.available);
        result.outcomeTokens[tokenId] = balance;
      }
    }

    return result;
  }

  /**
   * Разобрать строку баланса в число
   *
   * @param balance - Строка баланса (в минимальных единицах — 6 знаков для USDC)
   * @returns Разобранное число в USDC (делится на 10^6) или 0 при невалидном значении
   *
   * @remarks
   * КРИТИЧНО: API Polymarket возвращает баланс в минимальных единицах (wei-подобный формат).
   * У USDC 6 знаков после запятой, поэтому делим на 1 000 000 для получения реальной суммы USDC.
   *
   * Пример:
   * - API возвращает: "9572736" (минимальные единицы)
   * - Реальный баланс: 9.572736 USDC (9572736 / 10^6)
   */
  private parseBalance(balance: string): number {
    const parsed = parseFloat(balance);

    if (isNaN(parsed)) {
      this.logger.warn('Invalid balance value', { balance });
      return 0;
    }

    // КРИТИЧНО: Конвертируем из минимальных единиц в USDC (делим на 10^6)
    const balanceInUSDC = parsed / USDC_MULTIPLIER;

    this.logger.debug('Balance converted from minimum units', {
      raw: parsed,
      usdc: balanceInUSDC,
    });

    return balanceInUSDC;
  }
}

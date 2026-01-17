/**
 * Маппер балансов Polymarket
 *
 * @remarks
 * Преобразует сырые ответы API Polymarket по балансам в доменные типы.
 *
 * Преобразования:
 * - Конвертация строк → чисел
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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { BalanceResponse } from '../clients/PolymarketBalanceRestClient.js';

/**
 * Нормализованный баланс (формат домена)
 */
export interface NormalizedBalance {
  /** Доступный баланс USDC */
  availableUSDC: number;

  /** Заблокированный баланс USDC (в открытых ордерах) */
  lockedUSDC: number;

  /** Общий баланс USDC */
  totalUSDC: number;

  /** Балансы токенов исходов (tokenId → баланс) */
  outcomeTokens: Record<string, number>;
}

/**
 * Маппер балансов Polymarket
 */
export class PolymarketBalanceMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Преобразует ответ баланса в формат домена
   *
   * @param response - Сырой ответ баланса
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
   * Преобразует несколько ответов баланса в формат домена
   *
   * @param responses - Массив сырых ответов баланса
   * @returns Нормализованный баланс с токенами исходов
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
        // Токен исхода
        const tokenId = response.asset;
        const balance = this.parseBalance(response.available);
        result.outcomeTokens[tokenId] = balance;
      }
    }

    return result;
  }

  /**
   * Парсит строку баланса в число
   *
   * @param balance - Строка баланса (в минимальных единицах - 6 десятичных знаков для USDC)
   * @returns Распарсенное число в USDC (разделённое на 10^6) или 0 при некорректном значении
   *
   * @remarks
   * КРИТИЧНО: API Polymarket возвращает баланс в минимальных единицах (подобно wei).
   * USDC имеет 6 десятичных знаков, поэтому делим на 1,000,000 для получения реального количества USDC.
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

    // КРИТИЧНО: Конвертация из минимальных единиц в USDC (6 десятичных знаков)
    const USDC_DECIMALS = 6;
    const balanceInUSDC = parsed / Math.pow(10, USDC_DECIMALS);

    this.logger.silly('Balance converted from minimum units', {
      raw: parsed,
      usdc: balanceInUSDC,
    });

    return balanceInUSDC;
  }
}

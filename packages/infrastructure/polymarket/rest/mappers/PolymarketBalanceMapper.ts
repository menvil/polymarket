/**
 * Маппер баланса Polymarket
 *
 * @remarks
 * Преобразует необработанные ответы API Polymarket по балансу в доменные типы.
 *
 * Преобразования:
 * - Конвертация строки → типизированный VO
 * - USDC-баланс: число в микроединицах → Money (делится на 10^6)
 * - Outcome-токены: число в микроединицах → AssetQuantity (POLYMARKET_CTF_TOKEN)
 * - Нормализация имён полей
 * - Безопасные значения по умолчанию для отсутствующих полей
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketBalanceMapper(logger);
 *
 * const rawBalance = {
 *   asset: 'USDC',
 *   total: '9572736',
 *   available: '9000000',
 *   locked: '572736',
 * };
 *
 * const normalized = mapper.toDomainBalance(rawBalance);
 * // { available: Money(9.0 USDC), locked: Money(0.572736 USDC), ... }
 * ```
 */

import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { BalanceResponse } from '../clients/PolymarketBalanceRestClient.js';
import { Money, AssetQuantity, Quantity } from '@polymarket/value-objects';
import { asPolymarketCtfToken } from '@polymarket/ids';
import { USDC_MULTIPLIER } from '../constants.js';

/**
 * Нормализованный баланс (доменный формат).
 *
 * @remarks
 * Фиатный USDC-баланс представлен тремя полями типа Money.
 * Балансы prediction-market токенов хранятся отдельно в виде AssetQuantity,
 * чтобы исключить случайное смешение фиата и outcome-токенов на уровне типов.
 */
export interface NormalizedBalance {
  /** Доступный баланс USDC */
  readonly available: Money;

  /** Заблокированный баланс USDC (в открытых ордерах на бирже) */
  readonly locked: Money;

  /** Общий баланс USDC (available + locked) */
  readonly total: Money;

  /** Балансы outcome-токенов: tokenId → количество токенов */
  readonly outcomeTokens: ReadonlyMap<string, AssetQuantity>;
}

/**
 * Маппер баланса Polymarket
 *
 * @remarks
 * Реализует Anti-Corruption Layer между Polymarket REST API и доменными типами.
 * Отвечает только за конвертацию типов — без бизнес-логики.
 */
export class PolymarketBalanceMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Преобразовать единственный ответ по балансу в доменный формат.
   *
   * @param response - Необработанный ответ по балансу
   * @returns Нормализованный баланс (outcomeTokens пустой — нет токенов в одиночном ответе)
   *
   * @example
   * ```typescript
   * const rawBalance = { asset: 'USDC', total: '9572736', available: '9000000', locked: '572736' };
   * const normalized = mapper.toDomainBalance(rawBalance);
   * console.log(normalized.available.toNumber()); // 9.0
   * ```
   */
  toDomainBalance(response: BalanceResponse): NormalizedBalance {
    return {
      available: this.parseUSDC(response.available),
      locked:    this.parseUSDC(response.locked),
      total:     this.parseUSDC(response.total),
      outcomeTokens: new Map(),
    };
  }

  /**
   * Преобразовать массив ответов по балансу в доменный формат.
   *
   * @param responses - Массив необработанных ответов по балансу
   * @returns Нормализованный баланс: USDC-поля + outcome-токены
   *
   * @remarks
   * Итерирует по ответам:
   * - asset === 'USDC' → заполняет available / locked / total
   * - иначе → парсит как outcome-токен (POLYMARKET_CTF_TOKEN) и добавляет в outcomeTokens
   *
   * @example
   * ```typescript
   * const balances = await balanceClient.getBalances();
   * const normalized = mapper.toDomainBalances(balances);
   * console.log(normalized.available.toNumber()); // e.g. 9.0
   * console.log(normalized.outcomeTokens.size);   // e.g. 2
   * ```
   */
  toDomainBalances(responses: BalanceResponse[]): NormalizedBalance {
    let available = Money.ZERO['USDC'];
    let locked    = Money.ZERO['USDC'];
    let total     = Money.ZERO['USDC'];

    const outcomeTokens = new Map<string, AssetQuantity>();

    for (const response of responses) {
      if (response.asset === 'USDC') {
        available = this.parseUSDC(response.available);
        locked    = this.parseUSDC(response.locked);
        total     = this.parseUSDC(response.total);
      } else {
        const qty = this.parseTokenBalance(response.asset, response.available);
        if (qty !== null) {
          outcomeTokens.set(response.asset, qty);
        }
      }
    }

    return { available, locked, total, outcomeTokens };
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Разобрать строку USDC-баланса в Money.
   *
   * @param balance - Строка баланса в микроединицах (6 знаков для USDC)
   * @returns Money в USDC или Money.ZERO['USDC'] при невалидном значении
   *
   * @remarks
   * API Polymarket возвращает баланс в минимальных единицах (wei-подобный формат).
   * USDC имеет 6 знаков после запятой, поэтому делим на USDC_MULTIPLIER (10^6).
   *
   * Пример:
   * - API возвращает: "9572736"
   * - Реальный баланс: Money(9.572736 USDC)
   */
  private parseUSDC(balance: string): Money {
    const parsed = parseFloat(balance);

    if (isNaN(parsed)) {
      this.logger.warn('Invalid USDC balance value, defaulting to zero', { balance });
      return Money.ZERO['USDC'];
    }

    const amount = new Decimal(parsed).div(USDC_MULTIPLIER);

    this.logger.debug('USDC balance converted from minimum units', {
      raw:  parsed,
      usdc: amount.toNumber(),
    });

    return Money.of(amount, 'USDC');
  }

  /**
   * Разобрать строку баланса outcome-токена в AssetQuantity.
   *
   * @param tokenId - Числовой идентификатор токена из Polymarket API
   * @param balance - Строка баланса токена в микроединицах
   * @returns AssetQuantity или null при невалидном tokenId / балансе
   *
   * @remarks
   * Создаёт AssetId типа POLYMARKET_CTF_TOKEN из числового tokenId.
   * Возвращает null если tokenId не является валидным числовым строком.
   */
  private parseTokenBalance(tokenId: string, balance: string): AssetQuantity | null {
    const assetId = asPolymarketCtfToken(tokenId);
    if (!assetId) {
      this.logger.warn('Invalid outcome token ID, skipping', { tokenId });
      return null;
    }

    const parsed = parseFloat(balance);
    if (isNaN(parsed)) {
      this.logger.warn('Invalid outcome token balance, skipping', { tokenId, balance });
      return null;
    }

    const amount   = new Decimal(parsed).div(USDC_MULTIPLIER);
    const quantity = Quantity.of(amount);

    this.logger.debug('Outcome token balance converted from minimum units', {
      tokenId,
      raw:      parsed,
      quantity: amount.toNumber(),
    });

    return new AssetQuantity(assetId, quantity);
  }
}

/**
 * Политика рыночных ограничений Polymarket
 *
 * @remarks
 * Обрабатывает:
 * - Нормализацию размера (округление до sizeTick)
 * - Валидацию минимального/максимального размера
 * - Обучение на ошибках API ("size too small")
 * - Кэширование ограничений в памяти
 *
 * Эта политика используется в PortfolioAdapter.canPlaceOrder() для валидации
 * и нормализации параметров ордера ДО отправки в API.
 *
 * Ключевые особенности:
 * - Безопасные значения по умолчанию при отсутствии данных: { minOrderSize: 1, sizeTick: 0.01, maxOrderSize: 10000 }
 * - Обучается на ошибках API и обновляет кэш
 * - Быстрый кэш в памяти (без запросов к БД)
 *
 * @example
 * ```typescript
 * const policy = new PolymarketMarketConstraintsPolicy(marketDataClient, logger);
 *
 * const normalized = await policy.normalizeSize('0x123', 15.7777);
 * // Returns 15.78 (rounded to sizeTick=0.01)
 *
 * policy.learnFromError('0x123', 'size too small: minimum is 20');
 * // Updates cache: minOrderSize = 20
 *
 * const validation = await policy.validateSize('0x123', 5);
 * // Returns { ok: false, reason: 'Size 5 below minimum 20' }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketMarketDataRestClient } from '../clients/PolymarketMarketDataRestClient.js';

/**
 * Рыночные ограничения (кэшированные)
 */
interface MarketConstraints {
  /** Минимальная СТОИМОСТЬ ордера в USD для BUY-ордеров (0 = нет минимума, только минимальное количество акций) */
  minOrderValue: number;

  /** Минимальный РАЗМЕР ордера в акциях (для BUY и SELL) */
  minOrderSize: number;

  /** Максимальный размер ордера */
  maxOrderSize: number;

  /** Шаг размера (минимальный шаг изменения размера) */
  sizeTick: number;

  /** Шаг цены (минимальный шаг изменения цены) */
  priceTick: number;

  /** Ставка комиссии в базисных пунктах (полученная из ошибок API) */
  feeRateBps?: number;
}

/**
 * Политика рыночных ограничений Polymarket
 */
export class PolymarketMarketConstraintsPolicy {
  private readonly cache: Map<string, MarketConstraints> = new Map();
  private readonly defaultConstraints: MarketConstraints = {
    minOrderValue: 0, // Нет минимального значения
    minOrderSize: 1, // Минимум 1 акция (безопасный дефолт)
    maxOrderSize: 10000,
    sizeTick: 0.01,
    priceTick: 0.01, // КРИТИЧНО: Используем 0.01 как наиболее безопасный дефолт (наиболее распространён на Polymarket)
  };

  constructor(
    private readonly marketDataClient: PolymarketMarketDataRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить рыночные ограничения (из кэша или API)
   *
   * @param tokenId - Идентификатор токена
   * @returns Рыночные ограничения
   *
   * @remarks
   * Безопасные значения по умолчанию при отсутствии данных: { minOrderSize: 1, sizeTick: 0.01, maxOrderSize: 10000 }
   * Результаты кэшируются в памяти.
   *
   * @example
   * ```typescript
   * const constraints = await policy.getConstraints('0x123');
   * console.log(`Min size: ${constraints.minOrderSize}`);
   * ```
   */
  async getConstraints(tokenId: string): Promise<MarketConstraints> {
    // Сначала проверяем кэш
    if (this.cache.has(tokenId)) {
      return this.cache.get(tokenId)!;
    }

    // Запрашиваем из API
    try {
      const apiConstraints = await this.marketDataClient.getMarketConstraints(tokenId);

      // КРИТИЧНО: API иногда возвращает priceTick < 0.01, но ОТКЛОНЯЕТ ордера с таким шагом!
      // Пример: API возвращает minimum_price_tick=0.0001, но отклоняет ордер с ошибкой:
      // "Price (0.518990099009901) breaks minimum tick size rule: 0.01"
      //
      // Причина: API вычисляет цену как makerAmount/takerAmount и проверяет против шага 0.01.
      // Решение: Используем max(0.01, minimum_price_tick) как безопасный минимум.
      const apiPriceTick = apiConstraints.minimum_price_tick;
      const priceTick = Math.max(0.01, apiPriceTick);

      // Логируем все ограничения из API
      this.logger.debug('API constraints fetched', {
        tokenId: tokenId.substring(0, 16) + '...',
        apiPriceTick,
        correctedPriceTick: priceTick,
        wasCorrected: apiPriceTick !== priceTick,
        minimum_tick_size: apiConstraints.minimum_tick_size,
        minimum_order_size: apiConstraints.minimum_order_size,
        minimum_order_value: apiConstraints.minimum_order_value,
        maximum_order_size: apiConstraints.maximum_order_size,
      });

      this.logger.debug('Using priceTick from API', {
        tokenId,
        priceTick,
      });

      const constraints: MarketConstraints = {
        minOrderValue: apiConstraints.minimum_order_value ?? this.defaultConstraints.minOrderValue,
        minOrderSize: apiConstraints.minimum_order_size ?? this.defaultConstraints.minOrderSize,
        maxOrderSize: apiConstraints.maximum_order_size,
        sizeTick: apiConstraints.minimum_tick_size,
        priceTick,
      };

      this.cache.set(tokenId, constraints);
      this.logger.info('Market constraints fetched and cached', {
        tokenId,
        constraints,
      });

      return constraints;
    } catch (error) {
      this.logger.warn('Failed to fetch constraints, using defaults', {
        tokenId,
        error,
      });

      // Используем ограничения по умолчанию
      this.cache.set(tokenId, this.defaultConstraints);
      return this.defaultConstraints;
    }
  }

  /**
   * Нормализовать размер до sizeTick
   *
   * @param tokenId - Идентификатор токена рынка
   * @param size - Исходный размер
   * @returns Нормализованный размер (округлённый до sizeTick)
   *
   * @example
   * ```typescript
   * await policy.normalizeSize('0x123', 15.7777); // → 15.78
   * await policy.normalizeSize('0x123', 15.7333); // → 15.73
   * ```
   */
  async normalizeSize(tokenId: string, size: number): Promise<number> {
    const constraints = await this.getConstraints(tokenId);

    // Округляем до ближайшего sizeTick
    const normalized = Math.round(size / constraints.sizeTick) * constraints.sizeTick;

    // Гарантируем минимум 2 знака после запятой
    const rounded = Math.round(normalized * 100) / 100;

    this.logger.debug('Normalized size', {
      tokenId,
      original: size,
      normalized: rounded,
      sizeTick: constraints.sizeTick,
    });

    return rounded;
  }

  /**
   * Нормализовать цену до priceTick
   *
   * @param tokenId - Идентификатор токена рынка
   * @param price - Исходная цена
   * @returns Нормализованная цена (округлённая до priceTick)
   *
   * @example
   * ```typescript
   * await policy.normalizePrice('0x123', 0.5234); // → 0.5234
   * ```
   */
  async normalizePrice(tokenId: string, price: number): Promise<number> {
    const constraints = await this.getConstraints(tokenId);

    // Округляем до ближайшего priceTick
    const normalized = Math.round(price / constraints.priceTick) * constraints.priceTick;

    // Гарантируем минимум 4 знака после запятой (0.0001)
    const rounded = Math.round(normalized * 10000) / 10000;

    this.logger.debug('Normalized price', {
      tokenId,
      original: price,
      normalized: rounded,
      priceTick: constraints.priceTick,
    });

    return rounded;
  }

  /**
   * Валидировать размер против ограничений
   *
   * @param tokenId - Идентификатор токена
   * @param size - Размер для валидации
   * @param price - Цена ордера
   * @param side - Сторона ордера ('buy' или 'sell')
   * @returns Результат валидации
   *
   * @remarks
   * BUY-ордера: минимум 1 акция (если minOrderValue=0) ИЛИ минимальная СТОИМОСТЬ ордера (если minOrderValue>0)
   * SELL-ордера: нет минимального РАЗМЕРА (только проверка maxOrderSize)
   *
   * Примеры (BUY с minOrderValue=0):
   * - Любая цена → минимум 1 акция
   *
   * Примеры (BUY с minOrderValue=$1):
   * - Цена $0.60 → минимум 2 акции (2 × $0.60 = $1.20)
   * - Цена $0.10 → минимум 10 акций (10 × $0.10 = $1.00)
   *
   * @example
   * ```typescript
   * const result = await policy.validateSize('0x123', 5, 0.60, 'buy');
   * if (!result.ok) {
   *   console.error(result.reason);
   * }
   * ```
   */
  async validateSize(
    tokenId: string,
    size: number,
    price: number,
    side: 'buy' | 'sell'
  ): Promise<{ ok: boolean; reason?: string; minShares?: number }> {
    const constraints = await this.getConstraints(tokenId);

    // BUY: проверяем минимальный SIZE и VALUE ордера
    if (side === 'buy') {
      // Сначала проверяем минимальный SIZE (акции)
      if (size < constraints.minOrderSize) {
        return {
          ok: false,
          reason: `Size ${size} below minimum ${constraints.minOrderSize} shares`,
          minShares: constraints.minOrderSize,
        };
      }

      // Затем проверяем минимальный VALUE ордера (если > 0)
      if (constraints.minOrderValue > 0) {
        const orderValue = size * price;
        const minSharesForValue = Math.ceil(constraints.minOrderValue / price);

        if (size < minSharesForValue) {
          return {
            ok: false,
            reason: `Size ${size} × $${price.toFixed(2)} = $${orderValue.toFixed(2)} below minimum $${constraints.minOrderValue.toFixed(2)} (need ${minSharesForValue} shares)`,
            minShares: minSharesForValue,
          };
        }
      }

      if (size > constraints.maxOrderSize) {
        return {
          ok: false,
          reason: `Size ${size} exceeds maximum ${constraints.maxOrderSize}`,
        };
      }

      return { ok: true };
    }

    // SELL: проверяем минимальный SIZE и максимум
    if (size < constraints.minOrderSize) {
      return {
        ok: false,
        reason: `Size ${size} below minimum ${constraints.minOrderSize} shares`,
        minShares: constraints.minOrderSize,
      };
    }

    if (size > constraints.maxOrderSize) {
      return {
        ok: false,
        reason: `Size ${size} exceeds maximum ${constraints.maxOrderSize}`,
      };
    }

    return { ok: true };
  }

  /**
   * Обучиться на ошибке API и обновить ограничения
   *
   * @param tokenId - Идентификатор токена рынка
   * @param errorMsg - Сообщение об ошибке API
   *
   * @remarks
   * Разбирает сообщения об ошибках вида "min size: $1" и обновляет кэш.
   * Поддерживаемые шаблоны:
   * - "min size: $X" → обновить minOrderValue
   * - "minimum is $X" → обновить minOrderValue
   * - "maximum is X" → обновить maxOrderSize
   * - "minimum tick size is X" → обновить sizeTick
   *
   * @example
   * ```typescript
   * policy.learnFromError('0x123', 'invalid amount ($0.50), min size: $1');
   * // Updates cache: minOrderValue = 1.0
   *
   * policy.learnFromError('0x123', 'size too large: maximum is 5000');
   * // Updates cache: maxOrderSize = 5000
   * ```
   */
  learnFromError(tokenId: string, errorMsg: string): void {
    const constraints = this.cache.get(tokenId) ?? { ...this.defaultConstraints };

    let updated = false;

    // Парсим "min size: $X" или "minimum is $X"
    const minValueMatch = errorMsg.match(/min(?:imum)?\s+(?:size|is):\s*\$(\d+(?:\.\d+)?)/i);
    if (minValueMatch) {
      const newMin = parseFloat(minValueMatch[1]);
      if (newMin > constraints.minOrderValue) {
        constraints.minOrderValue = newMin;
        updated = true;
        this.logger.info('Learned minOrderValue from error', {
          tokenId,
          minOrderValue: newMin,
          errorMsg,
        });
      }
    }

    // Парсим "maximum is X"
    const maxSizeMatch = errorMsg.match(/maximum\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
    if (maxSizeMatch) {
      const newMax = parseFloat(maxSizeMatch[1]);
      if (newMax < constraints.maxOrderSize) {
        constraints.maxOrderSize = newMax;
        updated = true;
        this.logger.info('Learned maxOrderSize from error', {
          tokenId,
          maxOrderSize: newMax,
          errorMsg,
        });
      }
    }

    // Парсим "minimum tick size is X"
    const tickSizeMatch = errorMsg.match(/tick\s+size\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
    if (tickSizeMatch) {
      const newTick = parseFloat(tickSizeMatch[1]);
      if (newTick !== constraints.sizeTick) {
        constraints.sizeTick = newTick;
        updated = true;
        this.logger.info('Learned sizeTick from error', {
          tokenId,
          sizeTick: newTick,
          errorMsg,
        });
      }
    }

    // Парсим "invalid fee rate (X), current market's maker fee: Y"
    const feeRateMatch = errorMsg.match(/invalid fee rate \((\d+)\), current market's maker fee:\s*(\d+)/i);
    if (feeRateMatch) {
      const correctFeeRate = parseInt(feeRateMatch[2], 10);
      // Сохраняем feeRateBps в ограничениях (добавляем новое поле)
      if ((constraints as any).feeRateBps !== correctFeeRate) {
        (constraints as any).feeRateBps = correctFeeRate;
        updated = true;
        this.logger.warn('Learned feeRateBps from error', {
          tokenId,
          feeRateBps: correctFeeRate,
          errorMsg,
        });
      }
    }

    if (updated) {
      this.cache.set(tokenId, constraints);
      this.logger.info('Updated constraints from error', {
        tokenId,
        constraints,
      });
    } else {
      this.logger.debug('No learnable constraints in error', {
        tokenId,
        errorMsg,
      });
    }
  }

  /**
   * Получить ставку комиссии в базисных пунктах для токена
   *
   * @param tokenId - Идентификатор токена
   * @returns Ставка комиссии в базисных пунктах (по умолчанию: 1000 если не получена)
   *
   * @remarks
   * Возвращает кэшированную ставку комиссии если она получена из ошибки, иначе дефолт 1000 (10%).
   * Большинство рынков используют 1000 б.п., некоторые — 0 б.п.
   *
   * @example
   * ```typescript
   * const feeRate = policy.getFeeRateBps('0x123');
   * // Returns 1000 (default) or learned value like 0
   * ```
   */
  getFeeRateBps(tokenId: string): number {
    const constraints = this.cache.get(tokenId);
    const feeRate = constraints?.feeRateBps ?? 1000; // Дефолт: 10% maker fee

    this.logger.debug('Getting feeRateBps', {
      tokenId: tokenId.substring(0, 16) + '...',
      feeRate,
      learned: constraints?.feeRateBps !== undefined,
    });

    return feeRate;
  }

  /**
   * Очистить кэш для конкретного токена
   *
   * @param tokenId - Идентификатор токена
   *
   * @remarks
   * Принудительно повторно запрашивает ограничения при следующем обращении.
   */
  clearCache(tokenId: string): void {
    this.cache.delete(tokenId);
    this.logger.debug('Cleared constraints cache', { tokenId });
  }

  /**
   * Очистить весь кэш ограничений
   *
   * @remarks
   * Принудительно повторно запрашивает все ограничения при следующем обращении.
   */
  clearAllCache(): void {
    this.cache.clear();
    this.logger.debug('Cleared all constraints cache');
  }
}

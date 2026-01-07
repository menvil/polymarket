/**
 * MarketConstraintsPolicy - политика для market constraints
 *
 * @remarks
 * Управляет constraints для рынков (minOrderSize, sizeTick, maxOrderSize).
 *
 * Алгоритм получения constraints (комбинированный):
 * 1. Проверка TTL cache (10 минут)
 * 2. Если нет → попытка fetch из API (/markets/{id})
 * 3. Если API не дал → используем дефолты
 * 4. learnFromError() для обновления из ошибок API
 *
 * Responsibilities:
 * - TTL cache для constraints
 * - Нормализация размера ордера (округление по tick + min/max validation)
 * - Парсинг ошибок API для извлечения constraints
 * - Fallback к дефолтным значениям
 *
 * @example
 * ```typescript
 * const policy = new MarketConstraintsPolicy(logger);
 *
 * // Normalize size
 * const result = await policy.normalizeSize('0xabc', 15.567);
 * console.log(result.normalizedSize); // 15.57 (rounded to sizeTick=0.01)
 *
 * // Learn from error
 * policy.learnFromError('0xabc', 'size 5.5 is lower than min 10');
 * // Constraints updated: minOrderSize = 10
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { MarketConstraints, NormalizedSize } from './types.js';
import { DEFAULT_CONSTRAINTS } from './types.js';

/**
 * Cache entry для constraints
 */
interface ConstraintsCacheEntry {
  constraints: MarketConstraints;
  cachedAt: number;
}

/**
 * MarketConstraintsPolicy - управление market constraints
 *
 * @remarks
 * Stateful класс с TTL cache.
 * Thread-safe для single-threaded JS (no locks needed).
 */
export class MarketConstraintsPolicy {
  /**
   * TTL cache: tokenId → {constraints, cachedAt}
   */
  private readonly cache: Map<string, ConstraintsCacheEntry> = new Map();

  /**
   * TTL для cache (миллисекунды)
   */
  private readonly TTL_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Создаёт MarketConstraintsPolicy
   *
   * @param logger - Logger для debugging
   *
   * @example
   * ```typescript
   * const policy = new MarketConstraintsPolicy(logger);
   * ```
   */
  constructor(private readonly logger: ILogger) {}

  /**
   * Получает constraints для токена
   *
   * @param tokenId - ID токена
   * @returns Market constraints
   *
   * @remarks
   * Алгоритм (комбинированный):
   * 1. Проверка cache (TTL 10 минут)
   * 2. Если нет или expired → дефолтные значения
   * 3. NOTE: В Step 6 будет добавлен fetch из API
   *
   * @example
   * ```typescript
   * const constraints = await policy.getConstraints('0xabc123');
   * console.log(`Min size: ${constraints.minOrderSize}`);
   * ```
   */
  public async getConstraints(tokenId: string): Promise<MarketConstraints> {
    // 1. Проверка cache
    const cached = this.cache.get(tokenId);
    if (cached && !this.isCacheExpired(cached.cachedAt)) {
      this.logger.debug(`[MarketConstraintsPolicy] Using cached constraints for ${tokenId.substring(0, 16)}...`);
      return cached.constraints;
    }

    // 2. TODO: В Step 6 добавим fetch из API
    // const apiConstraints = await this.fetchFromApi(tokenId);
    // if (apiConstraints) {
    //   this.updateCache(tokenId, apiConstraints);
    //   return apiConstraints;
    // }

    // 3. Fallback к дефолтам
    this.logger.debug(`[MarketConstraintsPolicy] Using default constraints for ${tokenId.substring(0, 16)}...`);
    const defaultConstraints = {
      ...DEFAULT_CONSTRAINTS,
      timestamp: Date.now(),
    };

    // Сохраняем в cache
    this.updateCache(tokenId, defaultConstraints);

    return defaultConstraints;
  }

  /**
   * Нормализует размер ордера согласно constraints
   *
   * @param tokenId - ID токена
   * @param requestedSize - Запрошенный размер (USDC)
   * @returns Результат нормализации
   * @throws {Error} Если размер < minOrderSize или > maxOrderSize
   *
   * @remarks
   * Алгоритм:
   * 1. Получает constraints для токена
   * 2. Округляет размер по sizeTick
   * 3. Проверяет min/max limits
   * 4. Возвращает нормализованный размер
   *
   * @example
   * ```typescript
   * const result = await policy.normalizeSize('0xabc', 15.567);
   * console.log(result.normalizedSize); // 15.57 (rounded to tick=0.01)
   * console.log(result.wasNormalized); // true
   * console.log(result.reason); // 'Rounded to sizeTick=0.01'
   * ```
   */
  public async normalizeSize(tokenId: string, requestedSize: number): Promise<NormalizedSize> {
    // Получаем constraints
    const constraints = await this.getConstraints(tokenId);

    // Округляем по sizeTick
    const normalizedSize = this.roundToTick(requestedSize, constraints.sizeTick);

    // Проверяем min/max
    if (normalizedSize < constraints.minOrderSize) {
      throw new Error(
        `Order size ${normalizedSize} is below minimum ${constraints.minOrderSize} USDC`
      );
    }

    if (constraints.maxOrderSize && normalizedSize > constraints.maxOrderSize) {
      throw new Error(
        `Order size ${normalizedSize} exceeds maximum ${constraints.maxOrderSize} USDC`
      );
    }

    // Формируем результат
    const wasNormalized = normalizedSize !== requestedSize;
    const reason = wasNormalized
      ? `Rounded to sizeTick=${constraints.sizeTick}`
      : undefined;

    this.logger.debug(
      `[MarketConstraintsPolicy] Normalized size: ${requestedSize} → ${normalizedSize} (${wasNormalized ? reason : 'no change'})`
    );

    return {
      normalizedSize,
      originalSize: requestedSize,
      reason,
      wasNormalized,
    };
  }

  /**
   * Извлекает constraints из ошибки API
   *
   * @param tokenId - ID токена
   * @param errorMessage - Сообщение об ошибке от API
   *
   * @remarks
   * Парсит ошибки формата:
   * - "size 5.5 is lower than min 10"
   * - "size X below minimum Y"
   * - "order size must be at least X"
   *
   * Обновляет cache с извлечёнными constraints.
   *
   * @example
   * ```typescript
   * policy.learnFromError('0xabc', 'size 5.5 is lower than min 10');
   * // Cache updated: minOrderSize = 10
   *
   * const constraints = await policy.getConstraints('0xabc');
   * console.log(constraints.minOrderSize); // 10
   * ```
   */
  public learnFromError(tokenId: string, errorMessage: string): void {
    this.logger.debug(`[MarketConstraintsPolicy] Learning from error: ${errorMessage}`);

    // Парсим minOrderSize
    const minSizeMatch = errorMessage.match(/(?:min|minimum|at least)\s+(\d+(?:\.\d+)?)/i);
    if (minSizeMatch) {
      const minOrderSize = parseFloat(minSizeMatch[1]);
      if (!isNaN(minOrderSize) && minOrderSize > 0) {
        this.logger.info(`[MarketConstraintsPolicy] Learned minOrderSize=${minOrderSize} from error`);

        // Получаем текущие constraints или дефолты
        const current = this.cache.get(tokenId)?.constraints || {
          ...DEFAULT_CONSTRAINTS,
          timestamp: Date.now(),
        };

        // Обновляем minOrderSize
        const updated: MarketConstraints = {
          ...current,
          minOrderSize,
          timestamp: Date.now(),
        };

        this.updateCache(tokenId, updated);
      }
    }

    // TODO: Парсить другие constraints (sizeTick, maxOrderSize) если нужно
  }

  /**
   * Обновляет cache для токена
   *
   * @param tokenId - ID токена
   * @param constraints - Новые constraints
   */
  private updateCache(tokenId: string, constraints: MarketConstraints): void {
    this.cache.set(tokenId, {
      constraints,
      cachedAt: Date.now(),
    });
  }

  /**
   * Проверяет, истёк ли cache entry
   *
   * @param cachedAt - Timestamp когда entry был добавлен
   * @returns true если истёк (> TTL)
   */
  private isCacheExpired(cachedAt: number): boolean {
    return Date.now() - cachedAt > this.TTL_MS;
  }

  /**
   * Округляет размер по sizeTick
   *
   * @param size - Исходный размер
   * @param tick - Шаг округления
   * @returns Округлённый размер
   *
   * @remarks
   * Алгоритм: round(size / tick) * tick
   *
   * @example
   * ```typescript
   * roundToTick(15.567, 0.01) // 15.57
   * roundToTick(15.564, 0.01) // 15.56
   * roundToTick(123.456, 0.1) // 123.5
   * ```
   */
  private roundToTick(size: number, tick: number): number {
    return Math.round(size / tick) * tick;
  }

  /**
   * Очищает cache (для тестирования)
   *
   * @remarks
   * Utility метод для очистки cache.
   * Используется в тестах.
   */
  public clearCache(): void {
    this.cache.clear();
    this.logger.debug('[MarketConstraintsPolicy] Cache cleared');
  }

  /**
   * Получает размер cache (для тестирования/debugging)
   *
   * @returns Количество entries в cache
   */
  public getCacheSize(): number {
    return this.cache.size;
  }
}

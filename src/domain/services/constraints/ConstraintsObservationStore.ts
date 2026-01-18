/**
 * ConstraintsObservationStore - Хранилище наблюдений на основе LRU с TTL
 *
 * @remarks
 * Хранит наблюдения нарушений ограничений с обучением на основе уверенности.
 * Предотвращает утечку памяти используя LRU вытеснение при превышении maxSize.
 *
 * Возможности:
 * - LRU вытеснение: старейшие наблюдения удаляются при size > maxSize
 * - TTL истечение: наблюдения истекают через observationTTL мс
 * - Расчёт уверенности: confidence = min(1.0, count / minObservations)
 * - Периодическая очистка: опциональная полная TTL очистка каждые N мс
 *
 * Стратегия вытеснения:
 * 1. При observe(): если size > maxSize → удалить старейшее (первое в Map)
 * 2. При getConfidence(): переместить в конец (LRU: недавно использованное)
 * 3. Периодическая очистка: удалить истёкшие наблюдения (опционально)
 *
 * @example
 * ```typescript
 * const store = new ConstraintsObservationStore({
 *   minObservations: 3,
 *   confidenceThreshold: 0.8,
 *   observationTTL: 3600000, // 1 час
 *   maxObservations: 10000,
 *   cleanupInterval: 600000, // 10 мин
 * }, logger);
 *
 * // Наблюдать нарушение
 * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
 * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
 * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
 *
 * // Проверить уверенность
 * const confidence = store.getConfidence(tokenId, { type: 'MIN_SIZE', value: 10 });
 * // confidence = 1.0 (3 наблюдения / 3 minObservations)
 *
 * // Стоит ли обучаться?
 * if (store.shouldLearn(tokenId, violation)) {
 *   knowledgeBase.learn(tokenId, violation);
 * }
 *
 * // Очистка при завершении
 * store.stop();
 * ```
 */

import type { ILogger } from '../../ports/ILogger.js';

/**
 * Типы нарушений ограничений
 */
export type ConstraintViolationType =
  | 'MIN_SIZE'
  | 'MAX_SIZE'
  | 'SIZE_INCREMENT'
  | 'MIN_PRICE'
  | 'MAX_PRICE'
  | 'PRICE_INCREMENT';

/**
 * Данные нарушения ограничения
 */
export interface ConstraintViolation {
  /** Тип нарушения */
  type: ConstraintViolationType;
  /** Значение нарушения (например, минимальный размер) */
  value: number;
}

/**
 * Запись наблюдения, хранимая в Map
 */
export interface ObservationRecord {
  /** ID токена */
  tokenId: string;
  /** Нарушение ограничения */
  violation: ConstraintViolation;
  /** Количество наблюдений */
  count: number;
  /** Временная метка первого обнаружения (мс) */
  firstSeen: number;
  /** Временная метка последнего обнаружения (мс) */
  lastSeen: number;
}

/**
 * Конфигурация ConstraintsObservationStore
 */
export interface ConstraintsObservationStoreConfig {
  /** Минимальное количество наблюдений для обучения */
  minObservations: number;
  /** Порог уверенности для обучения (0-1) */
  confidenceThreshold: number;
  /** TTL наблюдения (мс) */
  observationTTL: number;
  /** Максимальное количество хранимых наблюдений (LRU вытеснение) */
  maxObservations?: number;
  /** Интервал периодической очистки (мс, опционально) */
  cleanupInterval?: number;
}

/**
 * ConstraintsObservationStore - Хранилище наблюдений на основе LRU
 *
 * @remarks
 * Хранит наблюдения с автоматическим LRU вытеснением при превышении maxSize.
 * Предотвращает утечку памяти для долго работающих сервисов.
 *
 * Гарантии:
 * - Нулевая утечка памяти: размер Map ≤ maxObservations
 * - LRU вытеснение: старейшие наблюдения удаляются первыми
 * - TTL истечение: истёкшие наблюдения игнорируются
 * - Периодическая очистка: опциональный таймер полной очистки
 */
export class ConstraintsObservationStore {
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly maxSize: number;
  private cleanupTimer?: NodeJS.Timeout;

  /**
   * Создать хранилище наблюдений
   *
   * @param config - Конфигурация хранилища
   * @param logger - Экземпляр логгера
   *
   * @remarks
   * Если указан cleanupInterval, запускает таймер периодической очистки.
   *
   * @example
   * ```typescript
   * const store = new ConstraintsObservationStore({
   *   minObservations: 3,
   *   confidenceThreshold: 0.8,
   *   observationTTL: 3600000,
   *   maxObservations: 10000,
   *   cleanupInterval: 600000,
   * }, logger);
   * ```
   */
  constructor(
    private readonly config: ConstraintsObservationStoreConfig,
    private readonly logger: ILogger
  ) {
    // Валидация конфига для предотвращения ошибок в рантайме
    this.validateConfig(config);

    this.maxSize = config.maxObservations ?? 10000;

    if (config.cleanupInterval && config.cleanupInterval > 0) {
      this.startPeriodicCleanup();
    }

    this.logger.debug('[ObservationStore] Initialized', {
      minObservations: config.minObservations,
      confidenceThreshold: config.confidenceThreshold,
      observationTTL: config.observationTTL,
      maxObservations: this.maxSize,
      cleanupInterval: config.cleanupInterval,
    });
  }

  /**
   * Валидация конфигурации хранилища
   *
   * @param config - Конфигурация для валидации
   * @throws {Error} При невалидных значениях конфигурации
   *
   * @remarks
   * Проверяет:
   * - minObservations > 0 (защита от деления на ноль в getConfidence)
   * - confidenceThreshold в диапазоне (0, 1]
   * - observationTTL > 0
   * - maxObservations > 0 (если указан)
   * - cleanupInterval > 0 (если указан)
   */
  private validateConfig(config: ConstraintsObservationStoreConfig): void {
    // minObservations > 0 (деление на ноль в getConfidence)
    if (config.minObservations <= 0) {
      throw new Error(
        `[ObservationStore] Invalid config: minObservations must be > 0, got ${config.minObservations}`
      );
    }

    // confidenceThreshold в диапазоне (0, 1]
    if (config.confidenceThreshold <= 0 || config.confidenceThreshold > 1) {
      throw new Error(
        `[ObservationStore] Invalid config: confidenceThreshold must be in range (0, 1], got ${config.confidenceThreshold}`
      );
    }

    // observationTTL > 0
    if (config.observationTTL <= 0) {
      throw new Error(
        `[ObservationStore] Invalid config: observationTTL must be > 0, got ${config.observationTTL}`
      );
    }

    // maxObservations > 0 (если указан)
    if (config.maxObservations !== undefined && config.maxObservations <= 0) {
      throw new Error(
        `[ObservationStore] Invalid config: maxObservations must be > 0, got ${config.maxObservations}`
      );
    }

    // cleanupInterval > 0 (если указан)
    if (config.cleanupInterval !== undefined && config.cleanupInterval <= 0) {
      this.logger.warn('[ObservationStore] Invalid cleanupInterval <= 0, periodic cleanup disabled', {
        cleanupInterval: config.cleanupInterval,
      });
    }
  }

  /**
   * Записать наблюдение с автоматическим LRU вытеснением
   *
   * @param tokenId - ID токена
   * @param violation - Нарушение ограничения
   *
   * @remarks
   * Алгоритм:
   * 1. Если наблюдение существует:
   *    a. Проверить TTL: если истекло → удалить и создать новую запись (count=1)
   *    b. Если не истекло: обновить count + lastSeen, переместить в конец (строгий LRU)
   * 2. Если новое наблюдение:
   *    a. Проверить size >= maxSize → удалить старейшее (ГАРАНТИРОВАННО первое в Map)
   *    b. Добавить новое наблюдение в конец
   *
   * КРИТИЧЕСКИЕ гарантии LRU:
   * - Порядок итерации Map = порядок вставки (спецификация ES2015+)
   * - Самые свежие наблюдения в КОНЦЕ Map
   * - Старейшие наблюдения в НАЧАЛЕ Map
   * - Размер НИКОГДА не превышает maxSize
   * - Вытеснение ВСЕГДА старейшей записи (Map.keys().next().value)
   *
   * Безопасность при высокой нагрузке:
   * - Однопоточный JS: нет гонки данных
   * - Атомарное delete+set: перемещение в конец безопасно
   * - TTL проверяется при observe() и getConfidence() для предотвращения
   *   накопления устаревших наблюдений через длительные промежутки
   *
   * @example
   * ```typescript
   * store.observe(tokenId, { type: 'MIN_SIZE', value: 10 });
   * ```
   */
  observe(tokenId: string, violation: ConstraintViolation): void {
    const key = this.makeKey(tokenId, violation);
    const now = Date.now();

    // Проверить существует ли наблюдение
    if (this.observations.has(key)) {
      const existing = this.observations.get(key)!;

      // Проверить TTL: если запись истекла, удалить и создать новую
      // Это предотвращает накопление устаревших наблюдений через длительные промежутки
      if (now - existing.lastSeen > this.config.observationTTL) {
        this.observations.delete(key);

        this.logger.trace('[ObservationStore] Удалено истёкшее наблюдение при observe()', {
          tokenId,
          violation,
          age: now - existing.lastSeen,
          oldCount: existing.count,
        });

        // Продолжить создание новой записи ниже (не return)
      } else {
        // КРИТИЧНО: Удалить ПЕРЕД повторным добавлением, чтобы переместить в конец (строгий LRU)
        this.observations.delete(key);

        // Обновить поля
        existing.count++;
        existing.lastSeen = now;

        // Добавить снова в конец
        this.observations.set(key, existing);

        this.logger.trace('[ObservationStore] Обновлено наблюдение (перемещено в конец)', {
          tokenId,
          violation,
          count: existing.count,
        });

        return;
      }
    }

    // Новое наблюдение: проверить размер ПЕРЕД добавлением
    if (this.observations.size >= this.maxSize) {
      // ГАРАНТИРОВАННО: Первая запись старейшая (Map сохраняет порядок вставки)
      const firstKey = this.observations.keys().next().value as string;
      this.observations.delete(firstKey);

      this.logger.trace('[ObservationStore] LRU вытеснение (лимит размера)', {
        evictedKey: firstKey,
        size: this.observations.size,
      });
    }

    // Добавить новое наблюдение в конец
    this.observations.set(key, {
      tokenId,
      violation,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });

    this.logger.trace('[ObservationStore] Новое наблюдение', {
      tokenId,
      violation,
      size: this.observations.size,
    });
  }

  /**
   * Получить уверенность для наблюдения
   *
   * @param tokenId - ID токена
   * @param violation - Нарушение ограничения
   * @returns Уверенность [0.0, 1.0] или 0.0 если истекло
   *
   * @remarks
   * Уверенность = min(1.0, count / minObservations)
   *
   * Возвращает 0.0 если:
   * - Наблюдение не найдено
   * - Наблюдение истекло (TTL)
   *
   * Побочный эффект: Перемещает наблюдение в конец (LRU: недавно использованное)
   *
   * Обработка TTL:
   * - Проверяет истечение используя Date.now() для консистентности
   * - Истёкшие наблюдения удаляются немедленно (агрессивная очистка)
   * - Предотвращает раздувание Map устаревшими записями
   *
   * @example
   * ```typescript
   * const confidence = store.getConfidence(tokenId, violation);
   * if (confidence >= 0.8) {
   *   // Высокая уверенность - безопасно обучаться
   * }
   * ```
   */
  getConfidence(tokenId: string, violation: ConstraintViolation): number {
    const key = this.makeKey(tokenId, violation);
    const record = this.observations.get(key);

    if (!record) return 0.0;

    // Проверить TTL с явной временной меткой
    const now = Date.now();
    if (now - record.lastSeen > this.config.observationTTL) {
      // АГРЕССИВНАЯ очистка: удалить истёкшую запись немедленно
      this.observations.delete(key);

      this.logger.trace('[ObservationStore] Удалено истёкшее наблюдение', {
        tokenId,
        violation,
        age: now - record.lastSeen,
      });

      return 0.0;
    }

    // Переместить в конец (LRU: недавно использованное)
    // КРИТИЧНО: Удалить ПЕРЕД повторным добавлением, чтобы переместить в конец
    this.observations.delete(key);
    this.observations.set(key, record);

    return Math.min(1.0, record.count / this.config.minObservations);
  }

  /**
   * Проверить стоит ли обучаться ограничению
   *
   * @param tokenId - ID токена
   * @param violation - Нарушение ограничения
   * @returns true если уверенность >= порога
   *
   * @remarks
   * Вспомогательный метод: getConfidence() >= confidenceThreshold
   *
   * @example
   * ```typescript
   * if (store.shouldLearn(tokenId, violation)) {
   *   knowledgeBase.learn(tokenId, violation);
   * }
   * ```
   */
  shouldLearn(tokenId: string, violation: ConstraintViolation): boolean {
    return this.getConfidence(tokenId, violation) >= this.config.confidenceThreshold;
  }

  /**
   * Создать ключ кэша из tokenId и violation
   *
   * @param tokenId - ID токена
   * @param violation - Нарушение ограничения
   * @returns Ключ кэша
   *
   * @remarks
   * Формат: `${tokenId}:${violation.type}:${violation.value}`
   */
  private makeKey(tokenId: string, violation: ConstraintViolation): string {
    return `${tokenId}:${violation.type}:${violation.value}`;
  }

  /**
   * Проверяет, истекла ли запись наблюдения
   *
   * @param record - Запись наблюдения для проверки
   * @param now - Текущая временная метка
   * @returns True если запись истекла
   */
  private isExpired(record: ObservationRecord, now: number): boolean {
    return now - record.lastSeen > this.config.observationTTL;
  }

  /**
   * Полная очистка: удалить все истёкшие наблюдения
   *
   * @remarks
   * Вызывается периодически если настроен cleanupInterval.
   * Проходит через все наблюдения и удаляет истёкшие.
   *
   * КРИТИЧНО: Предотвращает раздувание Map устаревшими записями
   * - Без агрессивной очистки Map может вырасти до maxSize с истёкшими записями
   * - Это вызывает скрытую утечку памяти: Map "полная" но содержит устаревшие данные
   * - При высокой нагрузке это тратит память и препятствует новым наблюдениям
   *
   * Алгоритм:
   * 1. Получить текущую временную метку (Date.now())
   * 2. Пройти по всем записям в Map
   * 3. Проверить TTL: now - lastSeen > observationTTL
   * 4. Удалить истёкшие записи немедленно
   * 5. Залогировать статистику очистки для мониторинга
   *
   * Производительность:
   * - O(n) итерация по Map
   * - Приемлемо для периодической очистки (не горячий путь)
   * - Должна запускаться с интервалом ~10 мин (настраиваемо)
   */
  private fullCleanup(): void {
    const before = this.observations.size;
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, record] of Array.from(this.observations.entries())) {
      if (this.isExpired(record, now)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.observations.delete(key);
    }

    if (keysToDelete.length > 0) {
      const percentCleared = before === 0
        ? '0.0%'
        : ((keysToDelete.length / before) * 100).toFixed(1) + '%';

      this.logger.debug('[ObservationStore] Periodic cleanup', {
        deleted: keysToDelete.length,
        before,
        after: this.observations.size,
        percentCleared,
      });
    }
  }

  /** Минимальный интервал очистки (1 секунда) */
  private static readonly MIN_CLEANUP_INTERVAL_MS = 1000;
  /** Максимальный интервал очистки (24 часа) */
  private static readonly MAX_CLEANUP_INTERVAL_MS = 86400000;

  /**
   * Запустить таймер периодической очистки
   *
   * @remarks
   * Вызывает fullCleanup() каждые cleanupInterval мс.
   * Таймер не удерживает процесс живым (unref()).
   *
   * Валидация cleanupInterval:
   * - Должен быть конечным числом
   * - Минимум MIN_CLEANUP_INTERVAL_MS (1 секунда)
   * - Максимум MAX_CLEANUP_INTERVAL_MS (24 часа)
   * - При невалидном значении очистка не запускается (логируется предупреждение)
   */
  private startPeriodicCleanup(): void {
    const interval = this.config.cleanupInterval;

    // Валидация: должен быть конечным числом
    if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      this.logger.warn('[ObservationStore] cleanupInterval is not a finite number, periodic cleanup disabled', {
        cleanupInterval: interval,
        type: typeof interval,
      });
      return;
    }

    // Валидация: минимальный интервал
    if (interval < ConstraintsObservationStore.MIN_CLEANUP_INTERVAL_MS) {
      this.logger.warn('[ObservationStore] cleanupInterval too small, periodic cleanup disabled', {
        cleanupInterval: interval,
        minRequired: ConstraintsObservationStore.MIN_CLEANUP_INTERVAL_MS,
      });
      return;
    }

    // Валидация: максимальный интервал
    if (interval > ConstraintsObservationStore.MAX_CLEANUP_INTERVAL_MS) {
      this.logger.warn('[ObservationStore] cleanupInterval too large, periodic cleanup disabled', {
        cleanupInterval: interval,
        maxAllowed: ConstraintsObservationStore.MAX_CLEANUP_INTERVAL_MS,
      });
      return;
    }

    // Интервал валиден - запускаем таймер
    this.cleanupTimer = setInterval(() => {
      this.fullCleanup();
    }, interval);

    // Не удерживать процесс живым
    this.cleanupTimer.unref();

    this.logger.info('[ObservationStore] Periodic cleanup started', {
      interval,
      minInterval: ConstraintsObservationStore.MIN_CLEANUP_INTERVAL_MS,
      maxInterval: ConstraintsObservationStore.MAX_CLEANUP_INTERVAL_MS,
    });
  }

  /**
   * Остановить таймер периодической очистки
   *
   * @remarks
   * Вызвать при завершении чтобы предотвратить утечку таймера.
   *
   * @example
   * ```typescript
   * // При завершении приложения
   * observationStore.stop();
   * ```
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;

      this.logger.info('[ObservationStore] Periodic cleanup stopped');
    }
  }

  /**
   * Получить текущий размер хранилища
   *
   * @returns Количество хранимых наблюдений
   *
   * @remarks
   * Для мониторинга и отладки.
   */
  getSize(): number {
    return this.observations.size;
  }

  /**
   * Очистить все наблюдения
   *
   * @remarks
   * Только для тестирования. Не должно использоваться в продакшене.
   */
  clear(): void {
    this.observations.clear();
    this.logger.warn('[ObservationStore] All observations cleared');
  }
}

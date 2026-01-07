/**
 * SubscriptionRegistry - Слой управления подписками и callbacks
 *
 * @remarks
 * Чистое управление подписками, предоставляющее:
 * - Регистрацию callbacks для каждого asset_id
 * - Множественных подписчиков на один asset
 * - Вызов callbacks (notify)
 * - Управление жизненным циклом подписок
 * - Типобезопасные generic callbacks
 *
 * Ответственность:
 * - Регистрация callbacks для конкретного asset_id
 * - Поддержка mapping: asset_id → Set<callback>
 * - Уведомление всех подписчиков при поступлении данных
 * - Обработка операций subscribe/unsubscribe
 * - Отслеживание статистики подписок
 *
 * НЕ отвечает за:
 * - WebSocket соединение (обрабатывается PolymarketWsClient)
 * - Парсинг сообщений (обрабатывается PolymarketMessageRouter)
 * - Создание domain entities (обрабатывается Adapter)
 *
 * @example
 * ```typescript
 * const registry = new SubscriptionRegistry<OrderbookData>();
 *
 * // Подписка на asset
 * const unsubscribe = registry.subscribe('123456', (data) => {
 *   console.log('Orderbook update:', data);
 * });
 *
 * // Уведомление всех подписчиков
 * registry.notify('123456', orderbookData);
 *
 * // Отписка
 * unsubscribe();
 * // или
 * registry.unsubscribe('123456', callback);
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Тип callback для подписки
 *
 * @template T - Тип данных, передаваемых в callback
 */
export type SubscriptionCallback<T> = (data: T) => void;

/**
 * Функция отписки, возвращаемая subscribe()
 */
export type UnsubscribeFunction = () => void;

/**
 * Статистика Registry
 */
export interface RegistryStats {
  /** Всего уникальных asset ID с подписками */
  uniqueAssets: number;
  /** Всего callbacks по всем assets */
  totalCallbacks: number;
  /** Всего отправлено уведомлений */
  totalNotifications: number;
  /** Всего ошибок при выполнении callbacks */
  callbackErrors: number;
}

/**
 * SubscriptionRegistry
 *
 * @remarks
 * Generic registry подписок для управления callbacks по asset_id.
 * Thread-safe для синхронных операций.
 *
 * Принципы дизайна:
 * 1. **Типобезопасность**: Generic T для типа данных callback
 * 2. **Множественные подписчики**: Set-based хранилище callbacks
 * 3. **Лёгкая очистка**: Возвращает unsubscribe функцию
 * 4. **Изоляция ошибок**: Ошибки в одном callback не влияют на другие
 * 5. **Статистика**: Отслеживание подписок и уведомлений
 *
 * @template T - Тип данных, передаваемых в callbacks
 */
export class SubscriptionRegistry<T> {
  private readonly subscriptions: Map<string, Set<SubscriptionCallback<T>>>;
  private readonly logger: ILogger;
  private stats: RegistryStats;

  /**
   * Создаёт SubscriptionRegistry
   *
   * @param logger - Logger для операций registry
   *
   * @throws {Error} Если logger равен null
   *
   * @example
   * ```typescript
   * const registry = new SubscriptionRegistry<OrderbookData>(logger);
   * ```
   */
  constructor(logger: ILogger) {
    if (!logger) {
      throw new Error('logger is required');
    }

    this.subscriptions = new Map();
    this.logger = logger.child ? logger.child('SubscriptionRegistry') : logger;
    this.stats = {
      uniqueAssets: 0,
      totalCallbacks: 0,
      totalNotifications: 0,
      callbackErrors: 0,
    };
  }

  /**
   * Подписывается на обновления asset
   *
   * @param assetId - Asset ID для подписки
   * @param callback - Callback для вызова при обновлениях
   * @returns Функция отписки
   *
   * @throws {Error} Если assetId пустой
   * @throws {Error} Если callback не функция
   *
   * @remarks
   * Алгоритм:
   * 1. Валидировать assetId и callback
   * 2. Получить или создать Set для assetId
   * 3. Добавить callback в Set
   * 4. Обновить статистику
   * 5. Вернуть функцию отписки
   *
   * Множественные вызовы с одним и тем же callback добавят его только один раз (поведение Set).
   *
   * @example
   * ```typescript
   * const unsubscribe = registry.subscribe('123456', (data) => {
   *   console.log('Update:', data);
   * });
   *
   * // Позже...
   * unsubscribe();
   * ```
   */
  public subscribe(assetId: string, callback: SubscriptionCallback<T>): UnsubscribeFunction {
    if (!assetId || assetId.trim() === '') {
      throw new Error('assetId cannot be empty');
    }

    if (typeof callback !== 'function') {
      throw new Error('callback must be a function');
    }

    // Получаем или создаём набор callbacks для этого asset
    let callbacks = this.subscriptions.get(assetId);
    if (!callbacks) {
      callbacks = new Set();
      this.subscriptions.set(assetId, callbacks);
      this.stats.uniqueAssets++;
    }

    const previousSize = callbacks.size;
    callbacks.add(callback);

    // Инкрементируем только если callback действительно добавлен (поведение Set)
    if (callbacks.size > previousSize) {
      this.stats.totalCallbacks++;
      this.logger.debug('Subscription added', {
        assetId: assetId.substring(0, 16) + '...',
        callbackCount: callbacks.size,
      });
    }

    // Возвращаем функцию отписки
    return () => this.unsubscribe(assetId, callback);
  }

  /**
   * Отписывает конкретный callback от asset
   *
   * @param assetId - Asset ID для отписки
   * @param callback - Callback для удаления
   * @returns true если callback был удалён, false если не найден
   *
   * @remarks
   * Алгоритм:
   * 1. Найти набор callbacks для assetId
   * 2. Удалить callback из Set
   * 3. Если Set пустой, удалить запись assetId
   * 4. Обновить статистику
   *
   * @example
   * ```typescript
   * const callback = (data) => console.log(data);
   * registry.subscribe('123456', callback);
   *
   * // Позже...
   * const removed = registry.unsubscribe('123456', callback);
   * console.log('Removed:', removed); // true
   * ```
   */
  public unsubscribe(assetId: string, callback: SubscriptionCallback<T>): boolean {
    const callbacks = this.subscriptions.get(assetId);
    if (!callbacks) {
      return false;
    }

    const removed = callbacks.delete(callback);

    if (removed) {
      this.stats.totalCallbacks--;

      // Очищаем пустые sets
      if (callbacks.size === 0) {
        this.subscriptions.delete(assetId);
        this.stats.uniqueAssets--;
      }

      this.logger.debug('Subscription removed', {
        assetId: assetId.substring(0, 16) + '...',
        callbackCount: callbacks.size,
      });
    }

    return removed;
  }

  /**
   * Отписывает все callbacks от asset(ов)
   *
   * @param assetId - Asset ID для очистки (опционально, очищает все если не указан)
   * @returns Количество удалённых callbacks
   *
   * @remarks
   * Если assetId указан, удаляет все callbacks для этого asset.
   * Если assetId не указан, очищает все подписки.
   *
   * @example
   * ```typescript
   * // Очистить конкретный asset
   * const removed = registry.unsubscribeAll('123456');
   * console.log('Removed:', removed, 'callbacks');
   *
   * // Очистить все
   * const total = registry.unsubscribeAll();
   * console.log('Removed all:', total, 'callbacks');
   * ```
   */
  public unsubscribeAll(assetId?: string): number {
    if (assetId !== undefined) {
      // Очищаем конкретный asset
      const callbacks = this.subscriptions.get(assetId);
      if (!callbacks) {
        return 0;
      }

      const count = callbacks.size;
      this.subscriptions.delete(assetId);
      this.stats.totalCallbacks -= count;
      this.stats.uniqueAssets--;

      this.logger.debug('All subscriptions removed for asset', {
        assetId: assetId.substring(0, 16) + '...',
        count,
      });

      return count;
    } else {
      // Очищаем все подписки
      const count = this.stats.totalCallbacks;
      this.subscriptions.clear();
      this.stats.uniqueAssets = 0;
      this.stats.totalCallbacks = 0;

      this.logger.debug('All subscriptions cleared', { count });

      return count;
    }
  }

  /**
   * Уведомляет всех подписчиков для asset
   *
   * @param assetId - Asset ID для уведомления
   * @param data - Данные для передачи в callbacks
   * @returns Количество вызванных callbacks
   *
   * @remarks
   * Алгоритм:
   * 1. Найти callbacks для assetId
   * 2. Вызвать каждый callback с данными
   * 3. Поймать и залогировать ошибки в отдельных callbacks
   * 4. Обновить статистику
   *
   * Ошибки в одном callback не влияют на другие.
   *
   * @example
   * ```typescript
   * const count = registry.notify('123456', orderbookData);
   * console.log('Notified', count, 'subscribers');
   * ```
   */
  public notify(assetId: string, data: T): number {
    const callbacks = this.subscriptions.get(assetId);
    if (!callbacks || callbacks.size === 0) {
      return 0;
    }

    let successCount = 0;

    // Вызываем все callbacks, изолируя ошибки
    for (const callback of callbacks) {
      try {
        callback(data);
        successCount++;
      } catch (error) {
        this.stats.callbackErrors++;
        this.logger.error('Error in subscription callback', {
          assetId: assetId.substring(0, 16) + '...',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.stats.totalNotifications++;

    this.logger.trace('Notifications sent', {
      assetId: assetId.substring(0, 16) + '...',
      count: successCount,
      errors: callbacks.size - successCount,
    });

    return successCount;
  }

  /**
   * Проверяет есть ли подписки на asset
   *
   * @param assetId - Asset ID для проверки
   * @returns true если asset имеет хотя бы одну подписку
   *
   * @example
   * ```typescript
   * if (registry.has('123456')) {
   *   console.log('Has subscribers');
   * }
   * ```
   */
  public has(assetId: string): boolean {
    const callbacks = this.subscriptions.get(assetId);
    return callbacks !== undefined && callbacks.size > 0;
  }

  /**
   * Получает все подписанные asset IDs
   *
   * @returns Массив asset IDs с активными подписками
   *
   * @example
   * ```typescript
   * const assets = registry.getAssetIds();
   * console.log('Subscribed to:', assets.length, 'assets');
   * ```
   */
  public getAssetIds(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Получает количество callbacks для asset или всего
   *
   * @param assetId - Asset ID для подсчёта (опционально, считает все если не указан)
   * @returns Количество callbacks
   *
   * @example
   * ```typescript
   * // Подсчёт для конкретного asset
   * const count = registry.getCallbackCount('123456');
   *
   * // Подсчёт всех
   * const total = registry.getCallbackCount();
   * ```
   */
  public getCallbackCount(assetId?: string): number {
    if (assetId !== undefined) {
      const callbacks = this.subscriptions.get(assetId);
      return callbacks ? callbacks.size : 0;
    } else {
      return this.stats.totalCallbacks;
    }
  }

  /**
   * Получает статистику registry
   *
   * @returns Текущая статистика
   *
   * @example
   * ```typescript
   * const stats = registry.getStats();
   * console.log('Assets:', stats.uniqueAssets);
   * console.log('Callbacks:', stats.totalCallbacks);
   * console.log('Notifications:', stats.totalNotifications);
   * console.log('Errors:', stats.callbackErrors);
   * ```
   */
  public getStats(): Readonly<RegistryStats> {
    return { ...this.stats };
  }

  /**
   * Сбрасывает статистику уведомлений
   *
   * @remarks
   * Сбрасывает счётчики totalNotifications и callbackErrors.
   * НЕ влияет на подписки или счётчики callbacks.
   *
   * @example
   * ```typescript
   * registry.resetStats();
   * ```
   */
  public resetStats(): void {
    this.stats.totalNotifications = 0;
    this.stats.callbackErrors = 0;
    this.logger.debug('Registry statistics reset');
  }

  /**
   * Очищает все подписки
   *
   * @remarks
   * Удаляет все callbacks для всех assets.
   * Сбрасывает счётчики uniqueAssets и totalCallbacks.
   *
   * @example
   * ```typescript
   * registry.clear();
   * console.log('Cleared all subscriptions');
   * ```
   */
  public clear(): void {
    const count = this.stats.totalCallbacks;
    this.subscriptions.clear();
    this.stats.uniqueAssets = 0;
    this.stats.totalCallbacks = 0;

    this.logger.debug('Registry cleared', { removedCallbacks: count });
  }
}

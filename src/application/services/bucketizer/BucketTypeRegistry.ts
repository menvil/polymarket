/**
 * Bucket Type Registry
 *
 * @remarks
 * Реестр для регистрации и получения bucket types.
 *
 * Принципы:
 * - Immutable после регистрации (нельзя переопределить тип)
 * - Singleton pattern не используется (можно создавать несколько реестров)
 * - Type-safe доступ к bucket types
 *
 * @example
 * ```typescript
 * const registry = new BucketTypeRegistry();
 *
 * // Регистрируем bucket types
 * registry.register(new VolumeLevelProbabilityFillBucketType());
 * registry.register(new AnotherBucketType());
 *
 * // Получаем bucket type
 * const bucketType = registry.get('volume_level_probability_fill');
 * if (bucketType) {
 *   const keys = bucketType.getBucketKeys(event);
 * }
 *
 * // Получаем все типы
 * const allTypes = registry.getAll();
 * ```
 *
 * @module application/services/bucketizer
 */

import type { IBucketType } from './types/bucket.js';

/**
 * Bucket Type Registry
 *
 * @remarks
 * Управляет коллекцией bucket types.
 * Обеспечивает type-safe доступ и предотвращает дублирование.
 */
export class BucketTypeRegistry {
  private readonly types: Map<string, IBucketType> = new Map();

  /**
   * Регистрирует bucket type
   *
   * @param bucketType - Bucket type для регистрации
   *
   * @throws {Error} Если тип с таким именем уже зарегистрирован
   *
   * @remarks
   * После регистрации bucket type нельзя переопределить.
   * Это предотвращает случайное изменение поведения.
   *
   * @example
   * ```typescript
   * const registry = new BucketTypeRegistry();
   * registry.register(new MyBucketType());
   *
   * // Попытка зарегистрировать снова → Error
   * registry.register(new MyBucketType()); // throws
   * ```
   */
  register(bucketType: IBucketType): void {
    const name = bucketType.getName();

    if (this.types.has(name)) {
      throw new Error(
        `Bucket type '${name}' is already registered. Cannot overwrite.`
      );
    }

    this.types.set(name, bucketType);
  }

  /**
   * Получает bucket type по имени
   *
   * @param name - Имя bucket type
   * @returns Bucket type или null если не найден
   *
   * @example
   * ```typescript
   * const bucketType = registry.get('volume_level_probability_fill');
   * if (bucketType) {
   *   // Use bucket type
   * } else {
   *   console.error('Bucket type not found');
   * }
   * ```
   */
  get(name: string): IBucketType | null {
    return this.types.get(name) ?? null;
  }

  /**
   * Проверяет наличие bucket type
   *
   * @param name - Имя bucket type
   * @returns true если зарегистрирован
   *
   * @example
   * ```typescript
   * if (registry.has('volume_level_probability_fill')) {
   *   console.log('Type is registered');
   * }
   * ```
   */
  has(name: string): boolean {
    return this.types.has(name);
  }

  /**
   * Получает все зарегистрированные bucket types
   *
   * @returns Массив всех bucket types
   *
   * @remarks
   * Порядок не гарантируется.
   * Возвращает новый массив (не мутирует внутреннее состояние).
   *
   * @example
   * ```typescript
   * const allTypes = registry.getAll();
   * console.log(`Registered ${allTypes.length} bucket types`);
   *
   * for (const type of allTypes) {
   *   console.log(type.getName());
   * }
   * ```
   */
  getAll(): IBucketType[] {
    return Array.from(this.types.values());
  }

  /**
   * Получает количество зарегистрированных типов
   *
   * @returns Количество типов
   *
   * @example
   * ```typescript
   * console.log(`Registry contains ${registry.size()} types`);
   * ```
   */
  size(): number {
    return this.types.size;
  }

  /**
   * Очищает все зарегистрированные типы
   *
   * @remarks
   * Используется в основном для тестов.
   * В production не рекомендуется вызывать.
   *
   * @example
   * ```typescript
   * // В тестах
   * afterEach(() => {
   *   registry.clear();
   * });
   * ```
   */
  clear(): void {
    this.types.clear();
  }
}

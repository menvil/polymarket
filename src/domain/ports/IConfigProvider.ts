/**
 * IConfigProvider port
 *
 * @remarks
 * Интерфейс для доступа к конфигурации приложения.
 * Реализация находится в infrastructure layer (env vars, config files, и т.д.).
 *
 * Responsibilities:
 * - Чтение конфигурационных значений
 * - Типобезопасный доступ к настройкам
 * - Валидация обязательных параметров
 *
 * @example
 * ```typescript
 * class EnvConfigProvider implements IConfigProvider {
 *   get<T>(key: string): T | undefined {
 *     const value = process.env[key];
 *     return value as T;
 *   }
 *
 *   getOrThrow<T>(key: string): T {
 *     const value = this.get<T>(key);
 *     if (value === undefined) {
 *       throw new Error(`Config key ${key} is required`);
 *     }
 *     return value;
 *   }
 * }
 * ```
 */

/**
 * Configuration provider interface
 *
 * @remarks
 * Простой интерфейс для чтения конфигурации с типобезопасностью.
 */
export interface IConfigProvider {
  /**
   * Получает значение конфигурации
   *
   * @param key - Ключ конфигурации
   * @returns Значение или undefined если не найдено
   *
   * @remarks
   * - Возвращает undefined если ключ не существует
   * - Не выбрасывает ошибку
   * - Используйте для опциональных параметров
   *
   * @example
   * ```typescript
   * const maxRetries = config.get<number>('MAX_RETRIES') ?? 3;
   * ```
   */
  get<T>(key: string): T | undefined;

  /**
   * Получает значение конфигурации или выбрасывает ошибку
   *
   * @param key - Ключ конфигурации
   * @returns Значение
   * @throws {Error} Если ключ не найден
   *
   * @remarks
   * - Выбрасывает ошибку если ключ не существует
   * - Используйте для обязательных параметров
   * - Приложение не запустится без обязательных настроек
   *
   * @example
   * ```typescript
   * const apiKey = config.getOrThrow<string>('API_KEY');
   * const privateKey = config.getOrThrow<string>('PRIVATE_KEY');
   * ```
   */
  getOrThrow<T>(key: string): T;

  /**
   * Получает значение с значением по умолчанию
   *
   * @param key - Ключ конфигурации
   * @param defaultValue - Значение по умолчанию
   * @returns Значение из конфига или defaultValue
   *
   * @remarks
   * - Возвращает defaultValue если ключ не найден
   * - Никогда не возвращает undefined
   * - Удобно для настроек с разумными defaults
   *
   * @example
   * ```typescript
   * const maxPositionSize = config.getOrDefault('MAX_POSITION_SIZE', 1000);
   * const logLevel = config.getOrDefault('LOG_LEVEL', 'info');
   * ```
   */
  getOrDefault<T>(key: string, defaultValue: T): T;

  /**
   * Проверяет наличие ключа
   *
   * @param key - Ключ для проверки
   * @returns True если ключ существует
   *
   * @remarks
   * - Проверяет наличие не проверяя значение
   * - Полезно для условной логики
   *
   * @example
   * ```typescript
   * if (config.has('ENABLE_FEATURE_X')) {
   *   // Enable feature X
   * }
   * ```
   */
  has(key: string): boolean;

  /**
   * Получает все ключи конфигурации
   *
   * @returns Массив всех ключей
   *
   * @remarks
   * - Возвращает список всех доступных ключей
   * - Полезно для отладки и валидации
   *
   * @example
   * ```typescript
   * const allKeys = config.getAllKeys();
   * console.log('Available config keys:', allKeys);
   * ```
   */
  getAllKeys?(): string[];
}

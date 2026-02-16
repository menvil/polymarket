/**
 * Автоматическое обнаружение и тестирование всех классов ошибок
 *
 * @remarks
 * Этот тест автоматически сканирует директорию src/, находит все классы,
 * наследующие TradingError, и запускает для них базовые тесты.
 *
 * ✨ При создании нового класса ошибки:
 * 1. Создайте файл в src/base/, src/value-objects/, или src/math/ (например, MyError.ts)
 * 2. Экспортируйте класс: export class MyError extends TradingError { ... }
 * 3. Добавьте в соответствующий index.ts: export * from './MyError.js';
 * 4. Запустите npm test - базовые тесты запустятся автоматически!
 *
 * Ничего больше не нужно! Никаких registry, никакой ручной регистрации!
 *
 * Механизм работы:
 * - Рекурсивно сканирует src/ и находит все .ts файлы
 * - Игнорирует index.ts, интерфейсы (I*.ts) и TradingError.ts (базовый класс)
 * - Импортирует файлы напрямую из TypeScript источников через require()
 * - Jest с ts-jest автоматически транспилирует TypeScript код
 * - Для каждого найденного класса создаёт экземпляр и читает severity
 * - Генерирует describe блок с 28 базовыми тестами
 *
 * @example
 * ```typescript
 * // src/base/MyError.ts
 * import { TradingError } from './TradingError.js';
 *
 * export class MyError extends TradingError {
 *   public readonly severity = 'high' as const;
 * }
 *
 * // src/base/index.ts
 * export * from './MyError.js';
 *
 * // Всё! Тесты запустятся автоматически при npm test
 * ```
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { TradingError, type ErrorSeverity } from '../../src/base';
import { testTradingError, TradingErrorConstructor } from '../helpers/sharedErrorTests';

/**
 * Рекурсивно находит все .ts файлы в директории
 *
 * Алгоритм:
 * 1. Читает содержимое директории с помощью readdirSync
 * 2. Для каждой записи проверяет, является ли она директорией или файлом
 * 3. Если директория - рекурсивно сканирует её (игнорируя node_modules, dist, __tests__, coverage)
 * 4. Если файл с расширением .ts - добавляет в результат (игнорируя index.ts, I*.ts, TradingError.ts)
 * 5. Игнорирует ошибки доступа к файлам и директориям
 *
 * @param dir - Директория для сканирования
 * @param files - Массив для накопления найденных файлов (используется при рекурсии)
 * @returns Массив абсолютных путей к найденным .ts файлам
 *
 * @remarks
 * Функция игнорирует:
 * - Служебные директории: node_modules, dist, __tests__, coverage
 * - Файлы index.ts (файлы экспорта)
 * - Интерфейсы TypeScript (файлы вида I<UpperCase>, например ITradingError, IValidator)
 * - Классы ошибок вида I<lowercase> (InsufficientFundsError, InvalidOrderError) НЕ игнорируются
 * - Файл TradingError.ts (базовый класс)
 *
 * @example
 * ```typescript
 * const files = findTsFiles('/path/to/src');
 * // ['/path/to/src/base/ValidationError.ts', '/path/to/src/base/NetworkError.ts', ...]
 * ```
 */
function findTsFiles(dir: string, files: string[] = []): string[] {
  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Игнорируем node_modules, dist, __tests__
          if (!['node_modules', 'dist', '__tests__', 'coverage', 'utils'].includes(entry)) {
            findTsFiles(fullPath, files);
          }
        } else if (stat.isFile() && extname(entry) === '.ts' && !entry.endsWith('.d.ts')) {
          // Игнорируем index.ts, интерфейсы (I<UpperCase>), TradingError.ts (базовый класс), .d.ts файлы
          const fileName = basename(entry, '.ts');

          // Интерфейсы TypeScript именуются как I<Name> где вторая буква заглавная
          // (ITradingError, IValidator), в отличие от классов ошибок (InsufficientFundsError, InvalidOrderError)
          const isInterface =
            fileName.startsWith('I') &&
            fileName.length > 1 &&
            fileName[1] === fileName[1].toUpperCase();

          if (fileName !== 'index' && !isInterface && fileName !== 'TradingError') {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Логируем ошибки доступа к файлам для отладки (не ломая тесты)
        if (process.env.DEBUG) {
          console.debug(`[auto-discovery] File access error for ${fullPath}:`, error);
        }
      }
    }
  } catch (error) {
    // Логируем ошибки чтения директории для отладки (не ломая тесты)
    if (process.env.DEBUG) {
      console.debug(`[auto-discovery] Directory read error for ${dir}:`, error);
    }
  }

  return files;
}

/**
 * Импортирует и анализирует все классы ошибок из src/ директории
 *
 * Алгоритм:
 * 1. Использует findTsFiles() для получения списка всех .ts файлов в src/
 * 2. Для каждого найденного файла:
 *    - Импортирует модуль через require() (Jest с ts-jest транспилирует TypeScript автоматически)
 *    - Проверяет все экспорты модуля
 *    - Определяет, является ли экспорт классом, наследующим TradingError
 *    - Создаёт экземпляр класса для получения значения severity
 *    - Добавляет класс в результирующий массив
 * 3. Возвращает массив найденных классов с метаданными
 *
 * @returns Массив объектов с метаданными о найденных классах ошибок
 *
 * @remarks
 * Используется require() вместо import для синхронного импорта на этапе инициализации модуля.
 * Jest с ts-jest автоматически транспилирует TypeScript файлы при их загрузке через require().
 * Ошибки импорта (например, для файлов с интерфейсами) игнорируются.
 *
 * Почему это работает:
 * - Jest настроен с ts-jest, который перехватывает require() для .ts файлов
 * - TypeScript код транспилируется в память на лету
 * - Не требуется предварительная сборка в dist/
 *
 * @example
 * ```typescript
 * const classes = discoverErrorClasses();
 * // [
 * //   { name: 'ValidationError', ErrorClass: ValidationError, severity: 'low' },
 * //   { name: 'NetworkError', ErrorClass: NetworkError, severity: 'high' },
 * //   ...
 * // ]
 * ```
 */
function discoverErrorClasses(): Array<{
  name: string;
  ErrorClass: TradingErrorConstructor;
  severity: ErrorSeverity;
}> {
  const srcDir = join(__dirname, '../../src');
  const tsFiles = findTsFiles(srcDir);
  const errorClasses: Array<{
    name: string;
    ErrorClass: TradingErrorConstructor;
    severity: ErrorSeverity;
  }> = [];

  for (const tsFilePath of tsFiles) {
    try {
      // Импортируем напрямую из TypeScript источников
      // Jest с ts-jest может обрабатывать .ts файлы через require()
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(tsFilePath);

      // Проверяем все экспорты модуля
      for (const [exportName, exportValue] of Object.entries(module)) {
        // Проверяем, что это класс, наследующий TradingError
        if (
          typeof exportValue === 'function' &&
          exportValue.prototype instanceof TradingError
        ) {
          // Создаём экземпляр чтобы получить severity
          const instance = new (exportValue as any)('Test');
          const severity = instance.severity;

          errorClasses.push({
            name: exportName,
            ErrorClass: exportValue as TradingErrorConstructor,
            severity,
          });
        }
      }
    } catch (error) {
      // Различаем ожидаемые доброкачественные ошибки от реальных проблем
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = (error as any)?.code;

      // Паттерны ожидаемых ошибок:
      // - Файлы только с интерфейсами/типами (нет экспортируемых классов)
      // - TypeScript ошибки компиляции (TS2306 - module not found)
      // - ES modules ошибки в CommonJS окружении
      const isBenignError =
        errorMessage.includes('Cannot use import statement') ||
        errorMessage.includes('TS2306') ||
        errorCode === 'ERR_REQUIRE_ESM' ||
        // Пустой модуль (только интерфейсы/типы)
        errorMessage.includes('is not a constructor');

      if (isBenignError) {
        // Ожидаемая ошибка - логируем только в DEBUG режиме
        if (process.env.DEBUG) {
          console.debug(`[auto-discovery] Benign import error for ${tsFilePath}:`, errorMessage);
        }
      } else {
        // Неожиданная ошибка - логируем всегда, это может быть синтаксическая ошибка или проблема с зависимостями
        console.error(
          `[auto-discovery] Unexpected import error for ${tsFilePath}:`,
          error
        );
        // Неожиданные ошибки должны валить тесты
        throw error;
      }
    }
  }

  return errorClasses;
}

// Находим все классы на момент загрузки модуля
const discoveredClasses = discoverErrorClasses();

describe('Auto-discovery: All TradingError classes', () => {
  it(`должен найти хотя бы один класс ошибки (найдено: ${discoveredClasses.length})`, () => {
    expect(discoveredClasses.length).toBeGreaterThan(0);
    console.log(
      `\n✨ Автоматически обнаружено ${discoveredClasses.length} класс(ов) ошибок:\n` +
        discoveredClasses.map((c) => `   - ${c.name} (severity: ${c.severity})`).join('\n')
    );
  });

  // Динамически создаём describe блоки для каждого класса
  discoveredClasses.forEach(({ name, ErrorClass, severity }) => {
    describe(`${name} (auto-discovered, severity: ${severity})`, () => {
      testTradingError({
        ErrorClass,
        expectedName: name,
        expectedSeverity: severity,
        testMessage: `Test ${name} message`,
      });
    });
  });
});

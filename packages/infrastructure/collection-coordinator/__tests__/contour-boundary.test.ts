/**
 * Границы контура collection-coordinator (N-003 PART 44).
 *
 * @remarks
 * Желаемый граф зависимостей:
 *
 * ```text
 * Coordinator ── polymarket-v2 (discovery/source)
 *      └──────── external-message-recorder
 * ```
 *
 * Запрещено:
 * - зависимость от общего bus (`external-message-bus`) — координатор не
 *   владеет bus и не публикует в него (data plane его не касается);
 * - прямые зависимости от storage (`data-collection`) — файлы пишет recorder;
 * - semantic/trading/legacy пакеты — никаких OrderBook/Trade/Strategy/exchange;
 * - прямой SDK (`@polymarket/client`/`@polymarket/bindings`) — transport
 *   принадлежит polymarket-v2.
 *
 * Тест фиксирует границу по РЕАЛЬНЫМ артефактам: runtime-dependencies
 * package.json и import-ы исходников.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');

/** Runtime-зависимости, запрещённые координатору. */
const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  '@polymarket/external-message-bus',
  '@polymarket/external-messages',
  '@polymarket/message-bus',
  '@polymarket/messages',
  '@polymarket/data-collection',
  '@polymarket/client',
  '@polymarket/bindings',
  '@polymarket/exchange',
  '@polymarket/market-discovery',
  '@polymarket/value-objects',
  '@polymarket/orderbook',
  '@polymarket/trade',
  '@polymarket/entities',
  '@polymarket/strategy',
  '@polymarket/market-state',
  '@polymarket/use-cases',
  '@polymarket/handlers',
  '@polymarket/orchestrators',
  '@polymarket/event-bus',
  '@polymarket/application-events',
];

/** Разрешённые package-импорты исходников координатора. */
const ALLOWED_SOURCE_IMPORTS = new Set([
  '@polymarket/polymarket-v2',
  '@polymarket/external-message-recorder',
  '@polymarket/ids',
  '@polymarket/logger',
  '@polymarket/ports',
  '@polymarket/time',
  '@polymarket/timestamp',
]);

/** Рекурсивно собирает все .ts-файлы каталога. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Убирает блочные и строчные комментарии перед поиском импортов:
 * import-подобный текст в TSDoc/примерах не должен считаться зависимостью.
 * `//` внутри строк-URL (`https://...`) защищён предшествующим двоеточием.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Собирает все import-specifiers файла (без учёта комментариев). */
function collectImports(filePath: string): string[] {
  const content = stripComments(readFileSync(filePath, 'utf8'));
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(content);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
      match = pattern.exec(content);
    }
  }
  return specifiers;
}

describe('dependency graph boundary (PART 44)', () => {
  it('runtime dependencies не содержат bus/storage/SDK/semantic пакетов', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    // Runtime-граница покрывает все виды устанавливаемых зависимостей
    const runtime = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ];
    for (const forbidden of FORBIDDEN_RUNTIME_DEPENDENCIES) {
      expect(runtime).not.toContain(forbidden);
    }
  });

  it('исходники импортируют только polymarket-v2, recorder и Foundation-контракты', () => {
    const sourceFiles = listSourceFiles(join(PACKAGE_ROOT, 'src'));
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) {
          continue;
        }
        if (!ALLOWED_SOURCE_IMPORTS.has(specifier)) {
          throw new Error(`Forbidden import '${specifier}' in ${basename(filePath)}`);
        }
      }
    }
  });

  it('координатор не вызывает глобальные lifecycle-методы разделяемых компонентов', () => {
    // source.close()/recorder.close()/bus.drain()/bus.close() принадлежат
    // composition root (PART 26/27) — координатор закрывает только handles
    // СВОИХ сессий. Порты типа Pick сужают это на уровне типов; тест
    // дополнительно фиксирует отсутствие вызовов в исходном тексте.
    const forbiddenCalls = [/_source\s*\.\s*close\s*\(/, /_recorder\s*\.\s*close\s*\(/];
    for (const filePath of listSourceFiles(join(PACKAGE_ROOT, 'src'))) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of forbiddenCalls) {
        expect(pattern.test(content)).toBe(false);
      }
    }
  });
});

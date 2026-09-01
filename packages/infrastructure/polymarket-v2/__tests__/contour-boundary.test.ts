/**
 * Границы контура polymarket-v2 (пересмотрено вместе с canonical Discovery).
 *
 * @remarks
 * Пакет состоит из двух плоскостей с РАЗНЫМИ границами зависимостей:
 *
 * - **DATA PLANE** (`PolymarketSource`, `PolymarketExternalMessage`) —
 *   ingress boundary. Ему запрещены зависимости от Domain/Application/
 *   semantic-пакетов: конверсия в наши concepts — работа будущего
 *   SemanticAdapter ПОСЛЕ bus. Правило N-001 сохраняется без изменений.
 *
 * - **CONTROL PLANE** (`PolymarketMarketDiscovery`,
 *   `PolymarketCryptoUpDownClassifier`, `PolymarketRtdsFeeds`) — discovery
 *   boundary. Ему ДОПОЛНИТЕЛЬНО разрешены canonical Domain-сущность рынка
 *   (`@polymarket/market`), контракт снимка (`@polymarket/ports`) и VO
 *   наблюдений (`@polymarket/value-objects`, ids/timestamp/time, decimal.js).
 *   Именно в этом и состоит его работа: превратить vendor-запись в canonical
 *   `Market` ДО границы Application. `@polymarket/market-discovery`
 *   (Filter/Scorer) здесь запрещён — owner selection живёт НАД портом.
 *
 * Trading/semantic/exchange-зависимости запрещены ОБЕИМ плоскостям.
 * Тест фиксирует границу по РЕАЛЬНЫМ артефактам: package.json и import-ы
 * исходников (по-файлово).
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');

/** Путь файла относительно src в POSIX-нотации (устойчиво к подкаталогам). */
function srcRelative(filePath: string): string {
  return relative(SRC_ROOT, filePath).split(sep).join('/');
}

/** Зависимости, запрещённые пакету целиком (semantic/trading/legacy). */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/orderbook',
  '@polymarket/trade',
  '@polymarket/entities',
  // owner selection policy: Discovery не ранжирует рынки по «интересности»
  '@polymarket/market-discovery',
  '@polymarket/fill',
  '@polymarket/order',
  '@polymarket/portfolio',
  '@polymarket/position',
  '@polymarket/application-events',
  '@polymarket/event-bus',
  '@polymarket/handlers',
  '@polymarket/use-cases',
  '@polymarket/strategy',
  '@polymarket/market-state',
  '@polymarket/orchestrators',
  '@polymarket/risk',
  '@polymarket/exchange',
  '@polymarket/data-collection',
];

/** Разрешённые импорты DATA PLANE (Foundation + внешний контур + SDK). */
const ALLOWED_SOURCE_IMPORTS = new Set([
  '@polymarket/bindings/subscriptions',
  '@polymarket/client',
  '@polymarket/external-message-bus',
  '@polymarket/external-messages',
  '@polymarket/logger',
  '@polymarket/message-bus',
  '@polymarket/messages',
  '@polymarket/result',
]);

/**
 * Дополнительно разрешённые импорты CONTROL PLANE (discovery):
 * canonical Domain Market + контракт снимка + VO наблюдений + typed
 * Gamma-модели vendor.
 */
const ALLOWED_DISCOVERY_IMPORTS = new Set([
  ...ALLOWED_SOURCE_IMPORTS,
  '@polymarket/bindings/gamma',
  '@polymarket/market',
  '@polymarket/ports',
  '@polymarket/value-objects',
  '@polymarket/ids',
  '@polymarket/time',
  '@polymarket/timestamp',
  'decimal.js',
]);

/** Файлы CONTROL PLANE (discovery boundary) — пути относительно `src`. */
const DISCOVERY_FILES = new Set([
  'PolymarketMarketDiscovery.ts',
  'PolymarketCryptoUpDownClassifier.ts',
  'PolymarketRtdsFeeds.ts',
  'PolymarketFinalization.ts',
  // index.ts re-экспортирует обе плоскости (контракт пакета)
  'index.ts',
]);

/** Рекурсивно собирает все .ts-файлы каталога (включая вложенные). */
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

/**
 * Собирает все import-specifiers файла: `import/export ... from '...'`,
 * side-effect `import '...'` и dynamic `import('...')` (без комментариев).
 */
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

describe('dependency graph boundary', () => {
  it('package.json не содержит semantic/trading/legacy зависимостей', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];

    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it('DATA PLANE импортирует только Foundation, внешний контур и Polymarket V2 client', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT).filter(
      (filePath) => !DISCOVERY_FILES.has(srcRelative(filePath)),
    );
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) {
          continue; // внутренние relative-импорты пакета
        }
        if (!ALLOWED_SOURCE_IMPORTS.has(specifier)) {
          throw new Error(
            `Forbidden data-plane import '${specifier}' in ${srcRelative(filePath)}`,
          );
        }
      }
    }
  });

  it('CONTROL PLANE (discovery) добавляет только canonical Market, порт и VO', () => {
    const discoveryFiles = listSourceFiles(SRC_ROOT).filter((filePath) =>
      DISCOVERY_FILES.has(srcRelative(filePath)),
    );
    expect(discoveryFiles.length).toBeGreaterThan(0);

    for (const filePath of discoveryFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) {
          continue;
        }
        if (!ALLOWED_DISCOVERY_IMPORTS.has(specifier)) {
          throw new Error(
            `Forbidden control-plane import '${specifier}' in ${srcRelative(filePath)}`,
          );
        }
      }
    }
  });

  it('README перечисляет ОБЕ границы полностью (документация не расходится с тестом)', () => {
    // README называет свои списки полными и служит первым, что читает
    // человек про границы пакета. Неполный список там хуже отсутствующего:
    // на него полагаются как на границу. Раз тест — источник истины,
    // расхождение обязан ловить он, а не следующий review.
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');

    const missing = [...ALLOWED_DISCOVERY_IMPORTS].filter(
      (specifier) => !readme.includes(specifier),
    );
    expect(missing).toEqual([]);
  });

  it('исходники не импортируют internal paths bindings (chunk-модули)', () => {
    for (const filePath of listSourceFiles(join(PACKAGE_ROOT, 'src'))) {
      for (const specifier of collectImports(filePath)) {
        expect(specifier.includes('/dist/')).toBe(false);
        expect(specifier.includes('types-')).toBe(false);
      }
    }
  });
});

/**
 * Границы контура polymarket-v2 (N-001 PART 25 TEST 10 / PART 30,
 * пересмотрено в N-003 PART 44).
 *
 * @remarks
 * Пакет состоит из двух плоскостей с РАЗНЫМИ границами зависимостей:
 *
 * - **DATA PLANE** (`PolymarketSource`, `PolymarketExternalMessage`) —
 *   ingress boundary. Ему запрещены зависимости от Domain/Application/
 *   semantic-пакетов: конверсия в наши concepts — работа будущего
 *   SemanticAdapter ПОСЛЕ bus. Правило N-001 сохраняется без изменений.
 *
 * - **CONTROL PLANE** (`PolymarketMarketDiscovery`, `PolymarketRtdsFeeds`)
 *   — discovery boundary N-003. Ему ДОПОЛНИТЕЛЬНО разрешены существующие
 *   selection-контракты (`@polymarket/ports`, `@polymarket/market-discovery`)
 *   и VO кандидата (`@polymarket/value-objects`, ids/timestamp/time,
 *   decimal.js) — reuse selection policy вместо второго discovery-фреймворка
 *   (N-003 PART 3/4). Это тот же слой зависимостей, что у legacy
 *   `PolymarketMarketDiscoveryAdapter` в `@polymarket/exchange`.
 *
 * Trading/semantic/exchange-зависимости запрещены ОБЕИМ плоскостям.
 * Тест фиксирует границу по РЕАЛЬНЫМ артефактам: package.json и import-ы
 * исходников (по-файлово).
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');

/** Зависимости, запрещённые пакету целиком (semantic/trading/legacy). */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/orderbook',
  '@polymarket/trade',
  '@polymarket/entities',
  '@polymarket/market',
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
 * Дополнительно разрешённые импорты CONTROL PLANE (discovery, N-003):
 * существующая selection policy + VO-модель кандидата + typed Gamma-модели.
 */
const ALLOWED_DISCOVERY_IMPORTS = new Set([
  ...ALLOWED_SOURCE_IMPORTS,
  '@polymarket/bindings/gamma',
  '@polymarket/ports',
  '@polymarket/market-discovery',
  '@polymarket/value-objects',
  '@polymarket/ids',
  '@polymarket/time',
  '@polymarket/timestamp',
  'decimal.js',
]);

/** Файлы CONTROL PLANE (discovery boundary) — по basename. */
const DISCOVERY_FILES = new Set([
  'PolymarketMarketDiscovery.ts',
  'PolymarketRtdsFeeds.ts',
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
 * Собирает все import-specifiers файла: `import/export ... from '...'`,
 * side-effect `import '...'` и dynamic `import('...')`.
 */
function collectImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf8');
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

  it('DATA PLANE импортирует только Foundation, внешний контур и официальный SDK', () => {
    const sourceFiles = listSourceFiles(join(PACKAGE_ROOT, 'src')).filter(
      (filePath) => !DISCOVERY_FILES.has(basename(filePath)),
    );
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) {
          continue; // внутренние relative-импорты пакета
        }
        if (!ALLOWED_SOURCE_IMPORTS.has(specifier)) {
          throw new Error(`Forbidden data-plane import '${specifier}' in ${basename(filePath)}`);
        }
      }
    }
  });

  it('CONTROL PLANE (discovery) добавляет только selection-контракты и VO', () => {
    const discoveryFiles = listSourceFiles(join(PACKAGE_ROOT, 'src')).filter((filePath) =>
      DISCOVERY_FILES.has(basename(filePath)),
    );
    expect(discoveryFiles.length).toBeGreaterThan(0);

    for (const filePath of discoveryFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) {
          continue;
        }
        if (!ALLOWED_DISCOVERY_IMPORTS.has(specifier)) {
          throw new Error(
            `Forbidden control-plane import '${specifier}' in ${basename(filePath)}`,
          );
        }
      }
    }
  });

  it('исходники не импортируют internal paths SDK (chunk-модули)', () => {
    for (const filePath of listSourceFiles(join(PACKAGE_ROOT, 'src'))) {
      for (const specifier of collectImports(filePath)) {
        expect(specifier.includes('/dist/')).toBe(false);
        expect(specifier.includes('types-')).toBe(false);
      }
    }
  });
});

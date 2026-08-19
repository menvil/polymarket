/**
 * Границы контура external-message-recorder (PART 34/38 N-002).
 *
 * @remarks
 * Recorder — infrastructure-consumer внешнего контура, живущий строго ДО
 * semantic-конверсии. Тест фиксирует по реальным артефактам (package.json +
 * import-ы исходников):
 *
 * - recorder НЕ импортирует Domain/Application semantic-пакеты
 *   (OrderBook/Trade/VO/ApplicationEvent/Strategy);
 * - направление зависимостей: recorder → {polymarket-v2, external-message-bus,
 *   data-collection}, и НИКТО из них не зависит от recorder-а;
 * - PolymarketSource не знает о recorder-е (source ≠ recording);
 * - storage (@polymarket/data-collection) не заражён transport-concerns;
 * - второго bus нет: из external-message-bus импортируются только ТИПЫ.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');
const POLYMARKET_V2_ROOT = join(PACKAGE_ROOT, '..', '..', 'polymarket-v2');
const DATA_COLLECTION_ROOT = join(PACKAGE_ROOT, '..', 'data-collection');
const FOUNDATION_ROOT = join(PACKAGE_ROOT, '..', '..', '..', 'foundation');

/** Зависимости, запрещённые recording-контуру (Domain/Application/semantic). */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/value-objects',
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
  '@polymarket/market-discovery',
  '@polymarket/orchestrators',
  '@polymarket/risk',
  '@polymarket/exchange',
  '@polymarket/cex-market-data',
];

/** Разрешённые package-импорты исходников recorder-а. */
const ALLOWED_SOURCE_IMPORTS = new Set([
  '@polymarket/data-collection',
  '@polymarket/external-message-bus',
  '@polymarket/ids',
  '@polymarket/logger',
  '@polymarket/polymarket-v2',
  '@polymarket/ports',
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

/** Объявленные зависимости package.json (deps + devDeps). */
function declaredDependencies(packageRoot: string): string[] {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
}

describe('dependency graph boundary (PART 38)', () => {
  it('package.json не содержит Domain/Application/semantic зависимостей (PART 34)', () => {
    const declared = declaredDependencies(PACKAGE_ROOT);
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it('исходники импортируют только контур записи + Foundation', () => {
    const sourceFiles = listSourceFiles(join(PACKAGE_ROOT, 'src'));
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) {
          continue; // внутренние relative-импорты пакета
        }
        expect(ALLOWED_SOURCE_IMPORTS.has(specifier)).toBe(true);
      }
    }
  });

  it('второго bus нет: external-message-bus импортируется только как типы', () => {
    for (const filePath of listSourceFiles(join(PACKAGE_ROOT, 'src'))) {
      const content = readFileSync(filePath, 'utf8');
      const busImports = content
        .split('\n')
        .filter((line) => line.includes("from '@polymarket/external-message-bus'"));
      for (const line of busImports) {
        expect(line.trimStart().startsWith('import type')).toBe(true);
      }
      expect(content).not.toContain('new ExternalMessageBus');
    }
  });

  it('PolymarketSource не импортирует recorder (source не знает о записи)', () => {
    for (const filePath of listSourceFiles(join(POLYMARKET_V2_ROOT, 'src'))) {
      for (const specifier of collectImports(filePath)) {
        expect(specifier).not.toBe('@polymarket/external-message-recorder');
      }
    }
    expect(declaredDependencies(POLYMARKET_V2_ROOT)).not.toContain(
      '@polymarket/external-message-recorder',
    );
  });

  it('storage (@polymarket/data-collection) не заражён transport-concerns', () => {
    const declared = declaredDependencies(DATA_COLLECTION_ROOT);
    for (const transportPackage of [
      '@polymarket/external-message-recorder',
      '@polymarket/external-message-bus',
      '@polymarket/external-messages',
      '@polymarket/message-bus',
      '@polymarket/polymarket-v2',
      '@polymarket/client',
      '@polymarket/bindings',
    ]) {
      expect(declared).not.toContain(transportPackage);
    }
  });

  it('Foundation не зависит от recorder-а', () => {
    for (const entry of readdirSync(FOUNDATION_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let declared: string[];
      try {
        declared = declaredDependencies(join(FOUNDATION_ROOT, entry.name));
      } catch {
        continue; // директория без package.json
      }
      expect(declared).not.toContain('@polymarket/external-message-recorder');
    }
  });
});

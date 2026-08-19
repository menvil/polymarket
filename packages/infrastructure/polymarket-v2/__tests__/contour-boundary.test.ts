/**
 * Границы контура polymarket-v2 (PART 25 TEST 10 / PART 30).
 *
 * @remarks
 * Пакет — Infrastructure ingress boundary. Ему запрещены зависимости от
 * Domain/Application/Strategy и от semantic-пакетов (OrderBook/Trade/VO):
 * конверсия в наши concepts — работа будущего SemanticAdapter ПОСЛЕ bus.
 * Тест фиксирует границу по РЕАЛЬНЫМ артефактам: package.json и import-ы
 * исходников.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');

/** Зависимости, запрещённые контуру ingress (Domain/Application/semantic). */
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
  '@polymarket/ports',
  '@polymarket/use-cases',
  '@polymarket/strategy',
  '@polymarket/market-state',
  '@polymarket/market-discovery',
  '@polymarket/orchestrators',
  '@polymarket/risk',
  '@polymarket/exchange',
  '@polymarket/data-collection',
];

/** Разрешённые package-импорты исходников (Foundation + внешний контур + SDK). */
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
  it('package.json не содержит Domain/Application/semantic зависимостей', () => {
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

  it('исходники импортируют только Foundation, внешний контур и официальный SDK', () => {
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

  it('исходники не импортируют internal paths SDK (chunk-модули)', () => {
    for (const filePath of listSourceFiles(join(PACKAGE_ROOT, 'src'))) {
      for (const specifier of collectImports(filePath)) {
        expect(specifier.includes('/dist/')).toBe(false);
        expect(specifier.includes('types-')).toBe(false);
      }
    }
  });
});

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

/** Собирает все import-specifiers файла (import/export ... from '...'). */
function collectImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf8');
  const specifiers: string[] = [];
  const importRegex = /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null = importRegex.exec(content);
  while (match !== null) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    match = importRegex.exec(content);
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
    const srcDir = join(PACKAGE_ROOT, 'src');
    const sourceFiles = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const fileName of sourceFiles) {
      for (const specifier of collectImports(join(srcDir, fileName))) {
        if (specifier.startsWith('.')) {
          continue; // внутренние relative-импорты пакета
        }
        expect(ALLOWED_SOURCE_IMPORTS.has(specifier)).toBe(true);
      }
    }
  });

  it('исходники не импортируют internal paths SDK (chunk-модули)', () => {
    const srcDir = join(PACKAGE_ROOT, 'src');
    for (const fileName of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
      for (const specifier of collectImports(join(srcDir, fileName))) {
        expect(specifier.includes('/dist/')).toBe(false);
        expect(specifier.includes('types-')).toBe(false);
      }
    }
  });
});

/**
 * Границы контура cex-v2 (N-005 PART 22).
 *
 * @remarks
 * `cex-v2` — ingress boundary (DATA PLANE, симметрично `polymarket-v2`):
 * знает только vendor transport (ccxt), messaging, logging и source
 * configuration. Запрещены Domain/Application/semantic/trading-пакеты и
 * canonical Entity/VO. Отдельно запрещён legacy CEX-пакет: V2-контур
 * строится заново, а не оборачивает старый collector.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');

/** Путь файла относительно src в POSIX-нотации. */
function srcRelative(filePath: string): string {
  return relative(SRC_ROOT, filePath).split(sep).join('/');
}

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
  '@polymarket/value-objects',
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
  '@polymarket/ports',
  '@polymarket/market-discovery',
  '@polymarket/cex-market-data',
];

/** Разрешённые импорты исходников (Foundation + внешний контур + vendor). */
const ALLOWED_SOURCE_IMPORTS = new Set([
  'ccxt',
  '@polymarket/external-message-bus',
  '@polymarket/external-messages',
  '@polymarket/logger',
  '@polymarket/message-bus',
  '@polymarket/messages',
  '@polymarket/result',
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
 * Убирает комментарии перед поиском импортов: import-подобный текст в
 * TSDoc/примерах не должен считаться зависимостью.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Собирает все import-specifiers файла (включая dynamic import). */
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

describe('dependency graph boundary (PART 22)', () => {
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

  it('исходники импортируют только Foundation, внешний контур и ccxt', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) {
          continue; // внутренние relative-импорты пакета
        }
        if (!ALLOWED_SOURCE_IMPORTS.has(specifier)) {
          throw new Error(`Forbidden import '${specifier}' in ${srcRelative(filePath)}`);
        }
      }
    }
  });

  it('исходники не импортируют legacy CEX-пакет и internal ccxt paths', () => {
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      for (const specifier of collectImports(filePath)) {
        expect(specifier.includes('cex-market-data')).toBe(false);
        expect(specifier.startsWith('ccxt/')).toBe(false);
      }
    }
  });
});

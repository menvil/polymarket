/**
 * Граница зависимостей пакета `@polymarket/policy`.
 *
 * @remarks
 * Policy — Application-слой: он выражает потребность consumer-а и НЕ знает
 * транспорта. Стрелка зависимости здесь направлена только вниз, к домену и
 * портам; любая зависимость на Infrastructure развернула бы её и вернула
 * ровно ту связность, ради разрыва которой контур и разделён:
 *
 * ```text
 * Infrastructure Discovery
 *         ↓ MarketDiscoverySnapshot
 * ─────────────────────────────────
 * Application: MarketUniverse + Policy + Filter + Scorer
 * ```
 *
 * Правило проверяется по РЕАЛЬНЫМ артефактам — `package.json` и import-ам
 * исходников, — а не по договорённости: договорённость нарушается молча.
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

/**
 * Разрешённые внешние импорты: домен, порты и foundation-типы.
 *
 * @remarks
 * Список закрытый и полный. Открытый («всё, кроме запрещённого») пропустил
 * бы любую новую infrastructure-зависимость, о которой этот тест ещё не
 * знает, — то есть ровно тот случай, ради которого он написан.
 */
const ALLOWED_IMPORTS = new Set([
  '@polymarket/errors',
  '@polymarket/ids',
  '@polymarket/market',
  '@polymarket/ports',
  '@polymarket/timestamp',
  '@polymarket/value-objects',
  'decimal.js',
]);

/**
 * Зависимости, запрещённые пакету явно.
 *
 * @remarks
 * Дублирует закрытый allow-list СОЗНАТЕЛЬНО: allow-list ловит нарушение, а
 * этот список объясняет читателю, ЧТО именно нельзя и почему — vendor-клиенты,
 * шины и источники данных остаются за границей Application.
 */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/polymarket-v2',
  '@polymarket/cex-v2',
  '@polymarket/cex-market-data',
  '@polymarket/client',
  '@polymarket/bindings',
  '@polymarket/exchange',
  '@polymarket/external-message-bus',
  '@polymarket/external-messages',
  '@polymarket/collection-coordinator',
  '@polymarket/market-finalizer',
  '@polymarket/data-collection',
  'ccxt',
];

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

/** Убирает комментарии: import-подобный текст в TSDoc — не зависимость. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Собирает все import-specifiers файла. */
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
      if (specifier !== undefined) specifiers.push(specifier);
      match = pattern.exec(content);
    }
  }
  return specifiers;
}

describe('dependency graph boundary', () => {
  it('package.json не объявляет ни одной infrastructure/transport зависимости', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];

    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it('исходники импортируют только домен, порты и foundation', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) continue; // внутренние модули пакета
        if (!ALLOWED_IMPORTS.has(specifier)) {
          throw new Error(`Forbidden application-layer import '${specifier}' in ${srcRelative(filePath)}`);
        }
      }
    }
  });

  it('каждый импорт src объявлен рантайм-зависимостью пакета', () => {
    // Allow-list отвечает на вопрос «можно ли архитектурно», но не на вопрос
    // «объявлено ли». Разойтись они могут в обе стороны: пакет тянет в
    // рантайм то, чем не пользуется, либо src импортирует то, чего нет в
    // зависимостях, и сборка потребителя падает уже у него. Проверяется
    // именно связка «импортирую → объявляю».
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(packageJson.dependencies ?? {}));

    /** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`. */
    const packageNameOf = (specifier: string): string => {
      const parts = specifier.split('/');
      return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    };

    const undeclared = new Set<string>();
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const name = packageNameOf(specifier);
        if (!declared.has(name)) undeclared.add(name);
      }
    }

    expect([...undeclared]).toEqual([]);
  });

  it('новый контур не знает LEGACY-контрактов отбора', () => {
    // `DiscoveredMarket`/`IMarketFilterConfig` — прежний owner-контракт.
    // Новый Policy — не их переименование: он работает с canonical Market,
    // и упоминание старых имён здесь означало бы, что миграция не завершена.
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const content = readFileSync(filePath, 'utf8');
      expect(content).not.toContain('DiscoveredMarket');
      expect(content).not.toContain('IMarketFilterConfig');
    }
  });
});

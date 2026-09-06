/**
 * Границы контура коллектора по РЕАЛЬНЫМ артефактам (package.json + импорты
 * исходников). Критерии E и I Collector-cutover.
 *
 * @remarks
 * - **E. Collector не владеет source.** Пакет не импортирует ни source-классы
 *   (`CexSource`/`PolymarketSource`/`Ccxt*Watcher`), ни транспорт
 *   (`ccxt`/`@polymarket/client`/`@polymarket/cex-market-data`). Ему разрешён
 *   контракт шины/recorder-а, external message types и canonical
 *   domain/application зависимости.
 * - **I. Replay-контур не зависит от Collector.** Backtesting/replay-пакеты и
 *   storage не импортируют `@polymarket/collector`, а recorder не зависит от
 *   коллектора (провайдер сессий инъецируется, а не импортируется).
 * - **Q. Legacy boundary.** Canonical runtime сбора (коллектор, финализатор,
 *   composition root приложения) НЕ зависит от legacy
 *   `@polymarket/collection-coordinator`: тот остаётся behavior oracle и
 *   целью удаления, а не участником контура.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..');
const INFRA_ROOT = join(PACKAGE_ROOT, '..');
const PERSISTENCE_ROOT = join(INFRA_ROOT, 'persistence');

/** Пакеты-источники/транспорт, запрещённые коллектору после cutover. */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/client',
  '@polymarket/bindings',
  '@polymarket/cex-market-data',
  '@polymarket/exchange',
  'ccxt',
  // polymarket-v2/cex-v2 экспортируют source-классы и транзитивно тянут client/
  // bindings/ccxt — их src коллектора не импортирует вовсе (registration
  // строится из canonical Market, без vendor-деривации фидов).
  '@polymarket/polymarket-v2',
  '@polymarket/cex-v2',
];

/**
 * Разрешённые package-импорты исходников коллектора (ЗАКРЫТЫЙ allow-list).
 *
 * @remarks
 * polymarket-v2/cex-v2 намеренно ОТСУТСТВУЮТ: их src не импортирует, поэтому
 * транзитивного замыкания на транспорт (client/bindings/ccxt) у коллектора
 * нет. Любой их импорт уронит и этот тест, и проверку запрещённых зависимостей.
 */
const ALLOWED_SOURCE_IMPORTS = new Set([
  '@polymarket/external-message-recorder',
  '@polymarket/ids',
  '@polymarket/logger',
  '@polymarket/market',
  '@polymarket/market-discovery',
  '@polymarket/policy',
  '@polymarket/ports',
  '@polymarket/time',
  '@polymarket/timestamp',
]);

/** Идентификаторы source-классов, которые не должны встречаться в src. */
const FORBIDDEN_IDENTIFIERS = ['CexSource', 'PolymarketSource', 'CcxtExchangeWatcher', 'CcxtSymbolWatcher'];

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

/** Убирает block- и line-комментарии: имена запрещённых классов легитимно
 *  упоминаются в TSDoc (объясняя, чего коллектор НЕ делает). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

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
      if (match[1] !== undefined) specifiers.push(match[1]);
      match = pattern.exec(content);
    }
  }
  return specifiers;
}

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

/** Только РАНТАЙМ-зависимости (`dependencies`), без devDependencies. */
function runtimeDependencies(packageRoot: string): string[] {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(packageJson.dependencies ?? {});
}

describe('E. Collector не владеет source', () => {
  it('РАНТАЙМ-зависимости НЕ содержат source/transport пакетов', () => {
    // Проверяем именно `dependencies`: тестам message-типы polymarket-v2/cex-v2
    // нужны (они в devDependencies), но в рантайм коллектора они не входят.
    const runtime = runtimeDependencies(PACKAGE_ROOT);
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(runtime).not.toContain(forbidden);
    }
  });

  it('исходники импортируют только разрешённый allow-list', () => {
    const sourceFiles = listSourceFiles(join(PACKAGE_ROOT, 'src'));
    expect(sourceFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) continue;
        if (!ALLOWED_SOURCE_IMPORTS.has(specifier)) {
          violations.push(`${filePath}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('исходники не используют source-классы и не управляют подписками', () => {
    for (const filePath of listSourceFiles(join(PACKAGE_ROOT, 'src'))) {
      // Комментарии убираем: TSDoc легитимно упоминает эти имена, объясняя,
      // чего коллектор НЕ делает; проверяем именно КОД.
      const code = stripComments(readFileSync(filePath, 'utf8'));
      for (const identifier of FORBIDDEN_IDENTIFIERS) {
        expect(code).not.toContain(identifier);
      }
      expect(code).not.toContain('watchOrderBook');
      expect(code).not.toContain('watchTrades');
      // Управление физическими подписками — не дело коллектора.
      expect(code).not.toContain('prepareMarket');
      expect(code).not.toMatch(/\.subscribe(Market|CryptoPrices|ChainlinkTwap)\(/);
    }
  });
});

describe('I. Replay-контур не зависит от Collector', () => {
  it('recorder НЕ зависит от коллектора (провайдер инъецируется, а не импортируется)', () => {
    const recorderRoot = join(PERSISTENCE_ROOT, 'external-message-recorder');
    expect(declaredDependencies(recorderRoot)).not.toContain('@polymarket/collector');
    for (const filePath of listSourceFiles(join(recorderRoot, 'src'))) {
      expect(collectImports(filePath)).not.toContain('@polymarket/collector');
    }
  });

  it('backtesting и storage не импортируют коллектор', () => {
    const backtestingRoot = join(INFRA_ROOT, 'backtesting');
    const dataCollectionRoot = join(PERSISTENCE_ROOT, 'data-collection');
    const snapshotReadersRoot = join(PERSISTENCE_ROOT, 'snapshot-readers');
    for (const root of [backtestingRoot, dataCollectionRoot, snapshotReadersRoot]) {
      expect(declaredDependencies(root)).not.toContain('@polymarket/collector');
      for (const filePath of listSourceFiles(join(root, 'src'))) {
        expect(collectImports(filePath)).not.toContain('@polymarket/collector');
      }
    }
  });
});

/**
 * Импортирует ли спецификатор legacy-координатор (включая subpath).
 *
 * @param specifier - Спецификатор импорта из исходника
 * @returns `true` для корневого импорта и для любого его подпути
 *
 * @remarks
 * Точное сравнение пропускало бы
 * `@polymarket/collection-coordinator/collectionHeader`: такой импорт
 * зависит от legacy-пакета ровно так же, а после его удаления сломается
 * ровно так же — правило обязано ловить и подпути.
 */
function importsLegacyCoordinator(specifier: string): boolean {
  return (
    specifier === LEGACY_COORDINATOR_PACKAGE ||
    specifier.startsWith(`${LEGACY_COORDINATOR_PACKAGE}/`)
  );
}

/** Legacy-пакет, который удаляется после квалификации коллектора. */
const LEGACY_COORDINATOR_PACKAGE = '@polymarket/collection-coordinator';

describe('Q. Canonical runtime не зависит от legacy collection-coordinator', () => {
  /** Пакеты и приложения, образующие canonical runtime сбора. */
  const CANONICAL_RUNTIME_ROOTS: readonly string[] = [
    PACKAGE_ROOT,
    join(INFRA_ROOT, 'market-finalizer'),
    join(INFRA_ROOT, 'polymarket-subscription-control'),
    join(INFRA_ROOT, 'polymarket-control-runtime'),
    join(PERSISTENCE_ROOT, 'external-message-recorder'),
    join(PACKAGE_ROOT, '..', '..', '..', 'apps', 'collect-data'),
  ];

  it('ни один src canonical runtime не импортирует legacy-координатор (включая subpath)', () => {
    const violations: string[] = [];
    for (const root of CANONICAL_RUNTIME_ROOTS) {
      for (const filePath of listSourceFiles(join(root, 'src'))) {
        for (const specifier of collectImports(filePath)) {
          if (importsLegacyCoordinator(specifier)) {
            violations.push(`${filePath}: ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('subpath-импорт распознаётся правилом, а не обходит его', () => {
    // Защита самого правила: точное сравнение пропускало бы такой импорт.
    expect(importsLegacyCoordinator(`${LEGACY_COORDINATOR_PACKAGE}/collectionHeader`)).toBe(true);
    expect(importsLegacyCoordinator(LEGACY_COORDINATOR_PACKAGE)).toBe(true);
    // Однофамилец с общим префиксом правилом НЕ затрагивается.
    expect(importsLegacyCoordinator(`${LEGACY_COORDINATOR_PACKAGE}-v2`)).toBe(false);
  });

  it('legacy-координатора нет в РАНТАЙМ-зависимостях canonical runtime', () => {
    const violations: string[] = [];
    for (const root of CANONICAL_RUNTIME_ROOTS) {
      for (const dependency of runtimeDependencies(root)) {
        if (importsLegacyCoordinator(dependency)) {
          violations.push(`${root}: ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('legacy-координатор помечен как удаляемый (не canonical runtime)', () => {
    const legacyIndex = readFileSync(
      join(INFRA_ROOT, 'collection-coordinator', 'src', 'index.ts'),
      'utf8',
    );
    expect(legacyIndex).toContain('@deprecated');
    expect(legacyIndex).toContain('LEGACY BEHAVIOR ORACLE');
  });
});

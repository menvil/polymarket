/**
 * Architecture-инварианты внешнего контура доставки (M-004).
 *
 * @remarks
 * Детерминированная проверка по манифестам и исходникам репозитория (без
 * dependency-analysis framework — чтение package.json и статический разбор
 * import-ов):
 *
 * 1. **target dependency graph** — `external-messages → messages`,
 *    `external-message-bus → external-messages + message-bus`;
 * 2. **Foundation не зависит от Infrastructure** — обратных рёбер нет;
 * 3. **слоевая граница** — внешний контракт не тянет Application/Domain;
 * 4. **contour isolation** — Application EventBus не знает о внешнем контуре
 *    и наоборот;
 * 5. **нет дублей technical types** — внешний контур не заводит собственные
 *    Handler/Stats/Policy/Observer/error-классы.
 *
 * Тест живёт здесь, потому что именно этот пакет замыкает граф M-004: он —
 * единственная точка, где внешний контур встречается с Foundation-движком.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Корень монорепо: packages/infrastructure/external-message-bus/__tests__ → четыре уровня вверх. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Repo-относительный путь директории пакета. */
const FOUNDATION_PREFIX = ['packages', 'foundation'].join(sep) + sep;
const INFRASTRUCTURE_PREFIX = ['packages', 'infrastructure'].join(sep) + sep;

/** Манифест workspace-пакета (нужные поля). */
interface Manifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
}

/** Читает package.json пакета по repo-относительному пути директории. */
function readManifest(...segments: string[]): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...segments, 'package.json'), 'utf8')) as Manifest;
}

/** Рекурсивно собирает пути всех package.json под base (без node_modules/dist). */
function collectManifests(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'package.json') {
        out.push(full);
      }
    }
  };
  walk(base);
  return out;
}

/** Карта имени пакета → repo-относительная директория. */
function buildPackageMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const base of ['packages', 'apps']) {
    const dir = join(REPO_ROOT, base);
    if (!existsSync(dir)) continue;
    for (const manifest of collectManifests(dir)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
      if (parsed.name?.startsWith('@polymarket/')) {
        map.set(parsed.name, manifest.slice(REPO_ROOT.length + 1, -'/package.json'.length));
      }
    }
  }
  return map;
}

/** Рекурсивно собирает .ts-файлы директории. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Все формы module specifier, которыми пакет реально может быть подключён.
 *
 * @remarks
 * Узкий шаблон (только `from '...'` с одинарными кавычками) давал бы
 * false negative: нарушение границы, записанное как side-effect import или в
 * двойных кавычках, прошло бы проверку незамеченным. Покрываются:
 * `from '...'`/`"..."`, `export ... from`, side-effect `import '...'`,
 * динамический `import('...')` и `require('...')`.
 */
const MODULE_SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](@polymarket\/[^'"]+)['"]/g;

/**
 * Извлекает имена РЕАЛЬНО импортируемых `@polymarket/*` пакетов из текста модуля.
 *
 * @remarks
 * Чистая функция (отделена от чтения файла — покрыта self-тестом ниже).
 * Комментарии вырезаются до разбора: TSDoc-примеры (`@example`) содержат
 * import-строки, которые не являются зависимостями пакета. Построчные
 * комментарии удаляются только если строка с них начинается — иначе пострадали
 * бы URL внутри кода.
 */
function extractPackageImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(MODULE_SPECIFIER_PATTERN)].map((match) => match[1] as string);
}

/** Извлекает имена импортируемых `@polymarket/*` пакетов из файла. */
function importedPackages(file: string): string[] {
  return extractPackageImports(readFileSync(file, 'utf8'));
}

/**
 * Карта имени пакета → директория, построенная ОДИН раз на весь файл.
 *
 * @remarks
 * `buildPackageMap()` рекурсивно обходит `packages/` + `apps/` с синхронным
 * FS и `JSON.parse` — повторять этот обход в каждом `describe` незачем,
 * содержимое репозитория во время прогона неизменно.
 */
const PACKAGE_MAP = buildPackageMap();

/** Кэш импортов по пакету — тот же обход в разных проверках не повторяется. */
const importsCache = new Map<string, Set<string>>();

/** Собирает все `@polymarket/*` импорты пакета (src, без тестов). */
function packageImports(...segments: string[]): Set<string> {
  const key = segments.join(sep);
  const cached = importsCache.get(key);
  if (cached !== undefined) return cached;

  const imports = new Set<string>();
  for (const file of collectSources(join(REPO_ROOT, ...segments, 'src'))) {
    for (const name of importedPackages(file)) imports.add(name);
  }
  importsCache.set(key, imports);
  return imports;
}

const EXTERNAL_MESSAGES = ['packages', 'infrastructure', 'external-messages'];
const EXTERNAL_MESSAGE_BUS = ['packages', 'infrastructure', 'external-message-bus'];

describe('import extraction (self-test инструмента проверки)', () => {
  it('распознаёт все формы подключения пакета', () => {
    const fixture = [
      "import { A } from '@polymarket/single-quoted';",
      'import { B } from "@polymarket/double-quoted";',
      "import type { C } from '@polymarket/type-only';",
      "import '@polymarket/side-effect';",
      'import "@polymarket/side-effect-double";',
      "export * from '@polymarket/re-exported';",
      "const d = await import('@polymarket/dynamic');",
      "const e = require('@polymarket/required');",
    ].join('\n');

    expect(extractPackageImports(fixture).sort()).toEqual([
      '@polymarket/double-quoted',
      '@polymarket/dynamic',
      '@polymarket/re-exported',
      '@polymarket/required',
      '@polymarket/side-effect',
      '@polymarket/side-effect-double',
      '@polymarket/single-quoted',
      '@polymarket/type-only',
    ]);
  });

  it('игнорирует import-строки внутри комментариев', () => {
    const fixture = [
      '/**',
      " * @example import { X } from '@polymarket/from-tsdoc';",
      ' */',
      "// import { Y } from '@polymarket/from-line-comment';",
      "import { Z } from '@polymarket/real';",
    ].join('\n');

    expect(extractPackageImports(fixture)).toEqual(['@polymarket/real']);
  });

  it('не считает импортом посторонние вхождения имени пакета', () => {
    const fixture = [
      "const label = '@polymarket/not-an-import';",
      "logger.info('@polymarket/also-not-an-import');",
    ].join('\n');

    expect(extractPackageImports(fixture)).toEqual([]);
  });
});

describe('M-004 target dependency graph', () => {
  const packageMap = PACKAGE_MAP;

  it('карта пакетов содержит оба пакета контура (sanity)', () => {
    expect(packageMap.get('@polymarket/external-messages')).toBe(EXTERNAL_MESSAGES.join(sep));
    expect(packageMap.get('@polymarket/external-message-bus')).toBe(EXTERNAL_MESSAGE_BUS.join(sep));
  });

  it('external-messages → ровно @polymarket/messages', () => {
    const deps = Object.keys(readManifest(...EXTERNAL_MESSAGES).dependencies ?? {});
    expect(deps.filter((dep) => dep.startsWith('@polymarket/'))).toEqual(['@polymarket/messages']);
    expect([...packageImports(...EXTERNAL_MESSAGES)]).toEqual(['@polymarket/messages']);
  });

  it('external-message-bus → external-messages + message-bus (+ result)', () => {
    const deps = Object.keys(readManifest(...EXTERNAL_MESSAGE_BUS).dependencies ?? {}).sort();
    expect(deps).toEqual([
      '@polymarket/external-messages',
      '@polymarket/message-bus',
      '@polymarket/result',
    ]);

    const imports = [...packageImports(...EXTERNAL_MESSAGE_BUS)].sort();
    expect(imports).toEqual([
      '@polymarket/external-messages',
      '@polymarket/message-bus',
      '@polymarket/result',
    ]);
  });

  it('каждый импорт пакетов контура объявлен в его dependencies', () => {
    for (const segments of [EXTERNAL_MESSAGES, EXTERNAL_MESSAGE_BUS]) {
      const declared = new Set(Object.keys(readManifest(...segments).dependencies ?? {}));
      for (const imported of packageImports(...segments)) {
        expect(declared.has(imported)).toBe(true);
      }
    }
  });

  it('в графе контура нет циклов', () => {
    const bus = Object.keys(readManifest(...EXTERNAL_MESSAGE_BUS).dependencies ?? {});
    const messages = Object.keys(readManifest(...EXTERNAL_MESSAGES).dependencies ?? {});
    expect(bus).toContain('@polymarket/external-messages');
    // Обратного ребра нет: contract-пакет не знает о своём bus
    expect(messages).not.toContain('@polymarket/external-message-bus');
    expect([...packageImports(...EXTERNAL_MESSAGES)]).not.toContain('@polymarket/external-message-bus');
  });
});

describe('Foundation не зависит от Infrastructure', () => {
  const packageMap = PACKAGE_MAP;

  it('ни message-bus, ни messages не знают о внешнем контуре', () => {
    for (const foundation of [
      ['packages', 'foundation', 'messages'],
      ['packages', 'foundation', 'message-bus'],
    ]) {
      const deps = Object.keys(readManifest(...foundation).dependencies ?? {});
      expect(deps).not.toContain('@polymarket/external-messages');
      expect(deps).not.toContain('@polymarket/external-message-bus');

      const imports = packageImports(...foundation);
      expect(imports.has('@polymarket/external-messages')).toBe(false);
      expect(imports.has('@polymarket/external-message-bus')).toBe(false);
    }
  });

  it('ни один packages/foundation/* не зависит от пакета вне foundation', () => {
    const foundationDir = join(REPO_ROOT, 'packages', 'foundation');
    const violations: string[] = [];
    for (const entry of readdirSync(foundationDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(foundationDir, entry.name, 'package.json'))) continue;
      const parsed = readManifest('packages', 'foundation', entry.name);
      for (const dep of Object.keys(parsed.dependencies ?? {})) {
        if (!dep.startsWith('@polymarket/')) continue;
        const target = packageMap.get(dep);
        if (target === undefined || !target.startsWith(FOUNDATION_PREFIX)) {
          violations.push(`${parsed.name} -> ${dep} (${target ?? 'not a workspace package'})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('layer boundary внешнего контракта', () => {
  const packageMap = PACKAGE_MAP;
  /** Пакеты, тянуть которые в generic external contract запрещено. */
  const FORBIDDEN = [
    '@polymarket/application-events',
    '@polymarket/event-bus',
    '@polymarket/order-events',
    '@polymarket/order',
    '@polymarket/value-objects',
  ];

  it('external-messages не зависит от Application/Domain', () => {
    const deps = Object.keys(readManifest(...EXTERNAL_MESSAGES).dependencies ?? {});
    for (const forbidden of FORBIDDEN) expect(deps).not.toContain(forbidden);

    for (const dep of deps) {
      if (!dep.startsWith('@polymarket/')) continue;
      const target = packageMap.get(dep);
      // Единственная допустимая зависимость contract-пакета — Foundation
      expect(target?.startsWith(FOUNDATION_PREFIX)).toBe(true);
    }
  });

  it('external-message-bus не зависит от Application/Domain', () => {
    const deps = Object.keys(readManifest(...EXTERNAL_MESSAGE_BUS).dependencies ?? {});
    for (const forbidden of FORBIDDEN) expect(deps).not.toContain(forbidden);

    for (const dep of deps) {
      if (!dep.startsWith('@polymarket/')) continue;
      const target = packageMap.get(dep);
      const inFoundation = target?.startsWith(FOUNDATION_PREFIX) ?? false;
      const inInfrastructure = target?.startsWith(INFRASTRUCTURE_PREFIX) ?? false;
      expect(inFoundation || inInfrastructure).toBe(true);
    }
  });
});

describe('contour isolation: Application EventBus ↔ ExternalMessageBus', () => {
  const EVENT_BUS = ['packages', 'application', 'event-bus'];

  it('Application EventBus не знает о внешнем контуре', () => {
    const deps = Object.keys(readManifest(...EVENT_BUS).dependencies ?? {});
    expect(deps).not.toContain('@polymarket/external-messages');
    expect(deps).not.toContain('@polymarket/external-message-bus');

    const imports = packageImports(...EVENT_BUS);
    expect(imports.has('@polymarket/external-messages')).toBe(false);
    expect(imports.has('@polymarket/external-message-bus')).toBe(false);
  });

  it('внешний контур не знает об Application-событиях', () => {
    const imports = packageImports(...EXTERNAL_MESSAGE_BUS);
    expect(imports.has('@polymarket/event-bus')).toBe(false);
    expect(imports.has('@polymarket/application-events')).toBe(false);
  });

  it('оба контура используют ОДИН delivery engine', () => {
    const eventBusDeps = Object.keys(readManifest(...EVENT_BUS).dependencies ?? {});
    const externalBusDeps = Object.keys(readManifest(...EXTERNAL_MESSAGE_BUS).dependencies ?? {});
    expect(eventBusDeps).toContain('@polymarket/message-bus');
    expect(externalBusDeps).toContain('@polymarket/message-bus');
  });
});

describe('no duplicate technical types', () => {
  const busSources = collectSources(join(REPO_ROOT, ...EXTERNAL_MESSAGE_BUS, 'src'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  it('внешний контур не объявляет собственных technical types движка', () => {
    for (const duplicate of [
      'ExternalMessageHandler',
      'ExternalMessageBusStats',
      'ExternalMessageBusPolicy',
      'ExternalMessageBusObserver',
      'ExternalMessageBusOptions',
      'ExternalMessageBusPublishError',
      'ExternalMessageBusDrainError',
    ]) {
      expect(busSources).not.toMatch(new RegExp(`(interface|type|class)\\s+${duplicate}\\b`));
    }
  });

  it('внешний контур не объявляет собственного envelope', () => {
    const contractSources = collectSources(join(REPO_ROOT, ...EXTERNAL_MESSAGES, 'src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(contractSources).not.toMatch(/(interface|class)\s+ExternalMessageEnvelope\b/);
    expect(contractSources).not.toMatch(/(interface|type)\s+ExternalMessageMetadata\b/);
    // Структура конверта не воспроизводится вручную — только alias к MessageEnvelope
    expect(contractSources).not.toMatch(/readonly\s+payload\s*:/);
    expect(contractSources).not.toMatch(/readonly\s+metadata\s*:/);
    expect(contractSources).toMatch(/MessageEnvelope</);
  });

  it('фасад не наследует MessageBus (композиция, не наследование)', () => {
    expect(busSources).not.toMatch(/class\s+ExternalMessageBus[^{]*extends\s+MessageBus/);
    expect(busSources).toMatch(/class\s+ExternalMessageBus[^{]*implements\s+IExternalMessageBus/);
    // Единственный делегат — приватное поле с движком
    expect(busSources).toMatch(/private\s+readonly\s+_bus:\s*MessageBus</);
  });

  it('фасад не содержит собственной delivery-механики', () => {
    // Ни очереди, ни счётчиков, ни флагов состояния — всё это живёт в движке
    for (const forbidden of [/_queue\b/, /_subscriptions\b/, /_closed\b/, /_activeDrain\b/, /Total\+\+/]) {
      expect(busSources).not.toMatch(forbidden);
    }
  });
});

describe('M-003/M-001 untouched by M-004', () => {
  it('canonical metadata-контракт не расширен external-полями', () => {
    const metadata = readFileSync(
      join(REPO_ROOT, 'packages', 'foundation', 'messages', 'src', 'MessageMetadata.ts'),
      'utf8',
    );
    for (const forbidden of ['source', 'channel', 'exchange', 'transport', 'connectionId', 'rawTopic']) {
      expect(metadata).not.toMatch(new RegExp(`readonly\\s+${forbidden}\\s*[?]?:`));
    }
  });

  it('движок доставки не знает о semantic-контурах', () => {
    const engine = readFileSync(
      join(REPO_ROOT, 'packages', 'foundation', 'message-bus', 'src', 'MessageBus.ts'),
      'utf8',
    );
    expect(engine).not.toMatch(/ExternalMessage/);
    expect(engine).not.toMatch(/EventBusEvent/);
  });
});

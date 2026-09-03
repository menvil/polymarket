/**
 * Граница зависимостей и структурные инварианты пакета
 * `@polymarket/cex-subscription-control`.
 *
 * @remarks
 * Контроллер — Infrastructure, и зависимость на CEX-драйвер V2 у него
 * ОЖИДАЕМА: здесь живут `CexSourceConfig` и `CexSource`. Запрещено
 * обратное — знание о площадке предсказаний (`polymarket-v2`,
 * PM-контроллер и его рантайм), о том, кто ПОТРЕБЛЯЕТ данные (коллектор,
 * рекордер, стратегии), и о самом vendor-коннекторе:
 *
 * ```text
 * Application: CexPolicy
 * ─────────────────────────────────── ↓ ownerKey + policy
 * Infrastructure: Controller → CexSource → ExternalMessageBus
 *                                  ↑ ccxt виден ТОЛЬКО отсюда
 * ```
 *
 * Правила проверяются по РЕАЛЬНЫМ артефактам — `package.json` и тексту
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
 * Разрешённые внешние импорты.
 *
 * @remarks
 * Список закрытый и полный. Открытый («всё, кроме запрещённого») пропустил
 * бы новую зависимость, о которой этот тест ещё не знает, — то есть ровно
 * тот случай, ради которого он написан.
 */
const ALLOWED_IMPORTS = new Set([
  '@polymarket/cex-v2',
  '@polymarket/errors',
  '@polymarket/logger',
  '@polymarket/policy',
  '@polymarket/timestamp',
]);

/**
 * Зависимости, запрещённые пакету явно.
 *
 * @remarks
 * Дублирует закрытый allow-list СОЗНАТЕЛЬНО: allow-list ловит нарушение, а
 * этот список объясняет читателю, ЧТО именно нельзя. Три группы: площадка
 * предсказаний (у CEX своя семантика спроса, копировать PM-контур нельзя),
 * потребители данных (кто записывает и кто торгует — не дело контроллера)
 * и сам vendor-коннектор (`ccxt` виден только `CexSource`).
 */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/polymarket-v2',
  '@polymarket/polymarket-subscription-control',
  '@polymarket/polymarket-control-runtime',
  '@polymarket/subscription-planning',
  '@polymarket/market-discovery',
  '@polymarket/data-collection',
  '@polymarket/external-message-recorder',
  '@polymarket/market-finalizer',
  '@polymarket/collection-coordinator',
  '@polymarket/cex-semantic-adapter',
  '@polymarket/cex-market-data',
  '@polymarket/strategy',
  'ccxt',
];

/**
 * Конструкции, которых не должно быть в КОДЕ пакета.
 *
 * @remarks
 * Четыре класса запретов:
 *
 * - **часы** (`Date.now`, `new Date(`, `IClock`, `LiveClock`) — момент
 *   приходит аргументом `reconcile(demands, now)`;
 * - **шина и данные** (`ExternalMessageBus`, `MessageMetadataGenerator`,
 *   `publish(`) — их захватывает фабрика источников, контроллер к
 *   data-plane не подключается вовсе;
 * - **выдуманный каталог CEX** (`CexMarketUniverse`, `CexDiscovery`,
 *   `CexMarket`) — `CexPolicy` уже содержит точные ресурсы;
 * - **мутация живого источника** (`addSymbol`, `removeSymbol`,
 *   `reconfigure`, `updateConfig`) — поколения `CexSource` immutable.
 *
 * Проверяется текст БЕЗ комментариев: TSDoc объясняет, почему этих
 * конструкций нет, и запрещать упоминание значило бы запрещать объяснение.
 */
const FORBIDDEN_CODE = [
  'Date.now',
  'new Date(',
  'IClock',
  'LiveClock',
  'setInterval',
  'setTimeout',
  'ExternalMessageBus',
  'MessageMetadataGenerator',
  'CexMarketUniverse',
  'CexDiscovery',
  'CexMarket ',
  'addSymbol',
  'removeSymbol',
  'reconfigure',
  'updateConfig',
  'localeCompare',
  'Promise.all',
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

/**
 * Собирает все module-specifiers файла.
 *
 * @param filePath - Путь файла
 * @returns Список специфаеров
 *
 * @remarks
 * `require()` разбирается наравне с `import`, хотя пакет — ESM: проверка
 * существует ровно для того, чего в `src` быть НЕ должно.
 */
function collectImports(filePath: string): string[] {
  const content = stripComments(readFileSync(filePath, 'utf8'));
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
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
  it('package.json не объявляет ни площадки предсказаний, ни потребителей данных, ни ccxt', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ];

    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it('CEX-драйвер V2 и Policy — ОЖИДАЕМЫЕ зависимости', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declared = Object.keys(packageJson.dependencies ?? {});

    expect(declared).toContain('@polymarket/cex-v2');
    expect(declared).toContain('@polymarket/policy');
  });

  it('исходники импортируют только разрешённое', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) continue; // внутренние модули пакета
        if (!ALLOWED_IMPORTS.has(specifier)) {
          throw new Error(`Forbidden import '${specifier}' in ${srcRelative(filePath)}`);
        }
      }
    }
  });

  it('каждый импорт src объявлен рантайм-зависимостью пакета', () => {
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
});

describe('структурные инварианты контроллера', () => {
  it.each(FORBIDDEN_CODE)('код пакета не содержит «%s»', (forbidden) => {
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const code = stripComments(readFileSync(filePath, 'utf8'));
      if (code.includes(forbidden)) {
        throw new Error(`Forbidden construct '${forbidden}' in ${srcRelative(filePath)}`);
      }
    }
  });

  it('окно policy оценивается НА now, а не на момент старта рынка', () => {
    const controller = stripComments(
      readFileSync(join(SRC_ROOT, 'CexSubscriptionController.ts'), 'utf8'),
    );

    expect(controller).toContain('isPolicyEffectiveAt(demand.policy, now)');
    expect(controller).not.toContain('startsAt');
  });

  it('источник закрывает САМ контроллер: close() входит в его контракт', () => {
    const types = stripComments(readFileSync(join(SRC_ROOT, 'CexSubscriptionTypes.ts'), 'utf8'));
    const sourceContract = /interface CexSubscriptionSource \{[\s\S]*?\n\}/.exec(types)?.[0];

    expect(sourceContract).toBeDefined();
    expect(sourceContract).toContain('close()');
    expect(sourceContract).toContain('start()');
  });

  it('пул материализуется источником РОВНО с одним включённым потоком', () => {
    const controller = stripComments(
      readFileSync(join(SRC_ROOT, 'CexSubscriptionController.ts'), 'utf8'),
    );
    const config = /function toSourceConfig\([\s\S]*?\n\}/.exec(controller)?.[0];

    expect(config).toBeDefined();
    expect(config).toContain('watchOrderbook: true');
    expect(config).toContain('watchTrades: false');
    expect(config).toContain('watchOrderbook: false');
    expect(config).toContain('watchTrades: true');
  });
});

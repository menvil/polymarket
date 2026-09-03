/**
 * Граница зависимостей и структурные инварианты пакета
 * `@polymarket/polymarket-control-runtime`.
 *
 * @remarks
 * Рантайм — внешний слой композиции, и зависимость СРАЗУ на два контура
 * (Application: universe/policy/planner; Infrastructure: discovery/
 * контроллер) у него ожидаема — именно ради неё пакет и существует.
 * Запрещено другое: знать про сбор данных, финализацию, стратегии,
 * исполнение, CEX и legacy-координатор, а также собирать vendor-клиента.
 *
 * ```text
 * Application:     MarketUniverse · Policy · Planner · ports
 * Infrastructure:  PolymarketMarketDiscovery · SubscriptionController
 * ──────────────────────────────────────────────────────────────────
 * ЗАПРЕЩЕНО:       Collector · Recorder · Finalizer · Strategy · CEX
 *                  @polymarket/client · @polymarket/bindings в src
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
 * Разрешённые внешние импорты `src`.
 *
 * @remarks
 * Список закрытый и полный. Открытый («всё, кроме запрещённого») пропустил
 * бы новую зависимость, о которой этот тест ещё не знает, — то есть ровно
 * тот случай, ради которого он написан.
 */
const ALLOWED_IMPORTS = new Set([
  '@polymarket/errors',
  '@polymarket/ids',
  '@polymarket/logger',
  '@polymarket/market-discovery',
  '@polymarket/policy',
  '@polymarket/polymarket-subscription-control',
  '@polymarket/polymarket-v2',
  '@polymarket/ports',
  '@polymarket/subscription-planning',
  '@polymarket/time',
  '@polymarket/timestamp',
]);

/**
 * Пакеты, запрещённые в РАНТАЙМ-зависимостях.
 *
 * @remarks
 * Дублирует закрытый allow-list СОЗНАТЕЛЬНО: allow-list ловит нарушение, а
 * этот список объясняет читателю, ЧТО именно нельзя. Три группы: сбор и
 * финализация данных, торговый контур и CEX, а также vendor-SDK, который
 * живёт только на границе композиции (smoke/composition root).
 */
const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  '@polymarket/client',
  '@polymarket/bindings',
  '@polymarket/external-message-bus',
  '@polymarket/external-message-recorder',
  '@polymarket/market-finalizer',
  '@polymarket/collection-coordinator',
  '@polymarket/data-collection',
  '@polymarket/strategy',
  '@polymarket/exchange',
  '@polymarket/risk',
  '@polymarket/cex-v2',
  '@polymarket/cex-market-data',
  '@polymarket/cex-semantic-adapter',
  'ccxt',
];

/**
 * Пакеты, запрещённые ЛЮБОЙ зависимостью — включая dev.
 *
 * @remarks
 * `@polymarket/client` и `@polymarket/external-message-bus` в этот список
 * НЕ входят: live smoke обязан собирать настоящий V2-путь, и подменять его
 * самодельной шиной или фальшивым клиентом значило бы проверять не то, что
 * поедет в прод. А вот коллектор, финализатор, стратегии и CEX не нужны
 * даже smoke — их отсутствие и есть предмет этого MR.
 */
const FORBIDDEN_ANYWHERE_DEPENDENCIES = [
  '@polymarket/external-message-recorder',
  '@polymarket/market-finalizer',
  '@polymarket/collection-coordinator',
  '@polymarket/data-collection',
  '@polymarket/strategy',
  '@polymarket/exchange',
  '@polymarket/risk',
  '@polymarket/cex-v2',
  '@polymarket/cex-market-data',
  '@polymarket/cex-semantic-adapter',
  'ccxt',
];

/**
 * Конструкции, которых не должно быть в КОДЕ пакета.
 *
 * @remarks
 * Пять классов запретов:
 *
 * - **legacy-контракты отбора и подготовки** (`findCandidates`,
 *   `prepareSelected`, `PolymarketDiscoveredMarket`, `IMarketFilterConfig`)
 *   — рантайм построен на ТЕКУЩЕМ пути V2, а не на переименовании старого;
 * - **сбор и финализация** (`registerMarket`, `finalizeMarket`,
 *   `sealMarket`) — control plane не знает, записывает ли кто-нибудь данные;
 * - **собственный таймер** (`setInterval`, `setTimeout`, `cron`) — каденцию
 *   задаёт composition root, `runOnce()` детерминирован;
 * - **автоматическое снятие claim-ов** (`releaseOwner`, `release(`) и
 *   vendor-подготовка (`prepareMarket`) — ни того, ни другого рантайм не
 *   делает вовсе;
 * - **свои часы и свой отбор** (`Date.now`, `new Date(`, `MarketFilter`,
 *   `MarketScorer`, `Promise.all`) — момент приходит из инжектированных
 *   часов, порядок и пригодность — из планировщика, а владельцы
 *   обрабатываются последовательно.
 *
 * Проверяется текст БЕЗ комментариев: TSDoc объясняет, почему этих
 * конструкций нет, и запрещать упоминание значило бы запрещать объяснение.
 */
const FORBIDDEN_CODE = [
  'findCandidates',
  'prepareSelected',
  'PolymarketDiscoveredMarket',
  'IMarketFilterConfig',
  'registerMarket',
  'finalizeMarket',
  'sealMarket',
  'setInterval',
  'setTimeout',
  'cron',
  'releaseOwner',
  'release(',
  'prepareMarket',
  'Date.now',
  'new Date(',
  'MarketFilter',
  'MarketScorer',
  'Promise.all',
  'createPublicClient',
];

/**
 * Имена полей второго реестра claim-ов, которого у рантайма быть не должно.
 *
 * @remarks
 * Source of truth владения — контроллер. Любое из этих полей означало бы
 * второй ответ на вопрос «кто чем владеет», и расходиться они начали бы на
 * первом же откате транзакции контроллера.
 */
const FORBIDDEN_STATE_FIELDS = [
  '_ownedMarkets',
  '_acquiredByOwner',
  '_previousPlan',
  '_previousDemands',
  '_claims',
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

/** Секции зависимостей `package.json`, которые проверяет граница. */
interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Читает `package.json` пакета. */
function readPackageJson(): PackageManifest {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as PackageManifest;
}

describe('граница зависимостей', () => {
  it('рантайм-зависимости не содержат ни сбора данных, ни торговли, ни vendor-SDK', () => {
    const declared = Object.keys(readPackageJson().dependencies ?? {});

    for (const forbidden of FORBIDDEN_RUNTIME_DEPENDENCIES) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it('коллектор, финализатор, стратегии и CEX не объявлены даже dev-зависимостью', () => {
    const packageJson = readPackageJson();
    const declared = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ];

    for (const forbidden of FORBIDDEN_ANYWHERE_DEPENDENCIES) {
      expect(declared).not.toContain(forbidden);
    }
  });

  it('оба контура объявлены рантайм-зависимостями — это и есть предмет пакета', () => {
    const declared = Object.keys(readPackageJson().dependencies ?? {});

    // Application
    expect(declared).toContain('@polymarket/market-discovery');
    expect(declared).toContain('@polymarket/policy');
    expect(declared).toContain('@polymarket/subscription-planning');
    // Infrastructure
    expect(declared).toContain('@polymarket/polymarket-v2');
    expect(declared).toContain('@polymarket/polymarket-subscription-control');
  });

  it('vendor-SDK допустим только как dev-зависимость live smoke', () => {
    const packageJson = readPackageJson();

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@polymarket/client');
    expect(Object.keys(packageJson.devDependencies ?? {})).toContain('@polymarket/client');
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
    const declared = new Set(Object.keys(readPackageJson().dependencies ?? {}));

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

describe('структурные инварианты рантайма', () => {
  it.each(FORBIDDEN_CODE)('код пакета не содержит «%s»', (forbidden) => {
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const code = stripComments(readFileSync(filePath, 'utf8'));
      if (code.includes(forbidden)) {
        throw new Error(`Forbidden construct '${forbidden}' in ${srcRelative(filePath)}`);
      }
    }
  });

  it.each(FORBIDDEN_STATE_FIELDS)('рантайм не заводит второй реестр «%s»', (field) => {
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const code = stripComments(readFileSync(filePath, 'utf8'));
      expect(code).not.toContain(field);
    }
  });

  it('часы читаются РОВНО одним выражением на весь проход', () => {
    const code = stripComments(
      readFileSync(join(SRC_ROOT, 'PolymarketControlRuntime.ts'), 'utf8'),
    );
    const reads = code.match(/Timestamp\.now\(/g) ?? [];

    expect(reads).toHaveLength(1);
    expect(code).toContain('Timestamp.now(this._clock)');
  });

  it('universe заменяется ТОЛЬКО под проверкой исхода обхода', () => {
    const code = stripComments(
      readFileSync(join(SRC_ROOT, 'PolymarketControlRuntime.ts'), 'utf8'),
    );

    // Единственная замена universe — и она внутри ветки успешного обхода.
    expect(code.match(/_universe\.replace\(/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/if \(discoveryRefreshed\) \{\s*this\._universe\.replace\(/);
  });

  it('кандидаты берутся срезом плана, без собственной сортировки', () => {
    const code = stripComments(
      readFileSync(join(SRC_ROOT, 'PolymarketControlRuntime.ts'), 'utf8'),
    );

    expect(code).toContain('plan.candidates.slice(0, demand.acquireLimit)');
    // Единственная сортировка пакета — детерминированный порядок владельцев
    expect(code.match(/\.sort\(/g) ?? []).toHaveLength(1);
    expect(code).toContain('compareOwnerKeys(left.ownerKey, right.ownerKey)');
  });
});

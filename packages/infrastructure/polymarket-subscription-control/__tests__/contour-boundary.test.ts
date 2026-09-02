/**
 * Граница зависимостей и структурные инварианты пакета
 * `@polymarket/polymarket-subscription-control`.
 *
 * @remarks
 * Контроллер — Infrastructure, и зависимость на драйвер площадки V2 у него
 * ОЖИДАЕМА: именно здесь живут `prepareMarket()`, `PolymarketSource` и
 * vendor RTDS-фиды. Запрещено обратное — знание о том, ПОЧЕМУ владелец
 * захотел рынок (Policy/Planner/universe) и о том, записывает ли его
 * кто-нибудь (рекордер/финализатор/координатор сбора):
 *
 * ```text
 * Application: Policy → Planner → пригодные рынки
 * ─────────────────────────────────────────────── ↓ ownerKey + entry
 * Infrastructure: Controller → PolymarketSource → ExternalMessageBus
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
  '@polymarket/errors',
  '@polymarket/ids',
  '@polymarket/logger',
  '@polymarket/polymarket-v2',
  '@polymarket/ports',
  '@polymarket/time',
  '@polymarket/timestamp',
]);

/**
 * Зависимости, запрещённые пакету явно.
 *
 * @remarks
 * Дублирует закрытый allow-list СОЗНАТЕЛЬНО: allow-list ловит нарушение, а
 * этот список объясняет читателю, ЧТО именно нельзя. Две группы:
 * причина владения рынком (Policy/Planner/universe) и запись данных
 * (рекордер, финализатор, координатор сбора) — контроллер не должен знать
 * ни того, ни другого.
 */
const FORBIDDEN_DEPENDENCIES = [
  '@polymarket/policy',
  '@polymarket/subscription-planning',
  '@polymarket/market-discovery',
  '@polymarket/external-message-recorder',
  '@polymarket/market-finalizer',
  '@polymarket/collection-coordinator',
  '@polymarket/data-collection',
  '@polymarket/exchange',
  '@polymarket/cex-v2',
  '@polymarket/cex-market-data',
  'ccxt',
];

/**
 * Конструкции, которых не должно быть в КОДЕ пакета.
 *
 * @remarks
 * Три класса запретов:
 *
 * - **legacy-контракты отбора и подготовки** (`findCandidates`,
 *   `prepareSelected`, `PolymarketDiscoveredMarket`, `IMarketFilterConfig`) —
 *   контроллер построен на ТЕКУЩЕМ пути V2, а не на переименовании старого;
 * - **сбор данных** (`registerMarket`, `finalizeMarket`, `sealMarket`) —
 *   физическая подписка существует независимо от того, записывают ли её;
 * - **часы и обходы каталога** (`Date.now`, `new Date(`, `refresh(`) —
 *   момент приходит из инжектированных часов, а обходами discovery
 *   управляет composition root.
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
  'narrowRtdsFeeds',
  'Date.now',
  'new Date(',
  'refresh(',
  'PolicyWindow',
  'minLeadTime',
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
  it('package.json не объявляет ни Policy/Planner, ни контур записи данных', () => {
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

  it('драйвер площадки V2 — ОЖИДАЕМАЯ зависимость Infrastructure', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(packageJson.dependencies ?? {})).toContain('@polymarket/polymarket-v2');
  });

  it('исходники импортируют только разрешённое', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) continue; // внутренние модули пакета
        if (!ALLOWED_IMPORTS.has(specifier)) {
          throw new Error(
            `Forbidden import '${specifier}' in ${srcRelative(filePath)}`,
          );
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

  it('источник закрывается НЕ контроллером: close() нет в его контракте', () => {
    const types = readFileSync(join(SRC_ROOT, 'PolymarketSubscriptionTypes.ts'), 'utf8');
    const sourceContract = /SubscriptionSource = Pick<[\s\S]*?>;/.exec(stripComments(types))?.[0];

    expect(sourceContract).toBeDefined();
    expect(sourceContract).toContain('subscribeMarket');
    expect(sourceContract).not.toContain("'close'");
  });

  it('строгая граница старта считается доменной операцией, а не арифметикой', () => {
    const controller = stripComments(
      readFileSync(join(SRC_ROOT, 'PolymarketSubscriptionController.ts'), 'utf8'),
    );

    expect(controller).toContain('isStartedAt(Timestamp.now(this._clock))');
  });
});

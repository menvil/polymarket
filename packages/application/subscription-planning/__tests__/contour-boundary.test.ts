/**
 * Граница зависимостей и структурные инварианты пакета
 * `@polymarket/subscription-planning`.
 *
 * @remarks
 * Планировщик — Application/control-plane: он выражает, ЧТО можно
 * приобрести, и не знает ни транспорта, ни vendor-моделей, ни физических
 * подписок. Стрелка зависимости направлена только вниз — к policy, портам и
 * домену:
 *
 * ```text
 * Infrastructure Discovery / Source / Recorder
 *         ↓ MarketDiscoverySnapshot
 * ─────────────────────────────────────────────
 * Application: MarketUniverse + Policy + Subscription Planner
 * ```
 *
 * Правила проверяются по РЕАЛЬНЫМ артефактам — `package.json` и текст
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
 * Разрешённые внешние импорты: policy, порты и foundation-типы.
 *
 * @remarks
 * Список закрытый и полный. Открытый («всё, кроме запрещённого») пропустил
 * бы любую новую infrastructure-зависимость, о которой этот тест ещё не
 * знает, — то есть ровно тот случай, ради которого он написан.
 */
const ALLOWED_IMPORTS = new Set([
  '@polymarket/errors',
  '@polymarket/ids',
  '@polymarket/policy',
  '@polymarket/ports',
  '@polymarket/timestamp',
]);

/**
 * Зависимости, запрещённые пакету явно.
 *
 * @remarks
 * Дублирует закрытый allow-list СОЗНАТЕЛЬНО: allow-list ловит нарушение, а
 * этот список объясняет читателю, ЧТО именно нельзя и почему — драйверы
 * площадок, шины, рекордеры и координатор сбора остаются за границей
 * Application, и планировщик не должен знать даже об их существовании.
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
  '@polymarket/external-message-recorder',
  '@polymarket/collection-coordinator',
  '@polymarket/market-finalizer',
  '@polymarket/data-collection',
  'ccxt',
];

/**
 * Конструкции, которых не должно быть в КОДЕ пакета.
 *
 * @remarks
 * Три класса запретов, и каждый — про уже принятое решение:
 *
 * - **часы** (`Date.now`, `new Date(`, `clock`): момент планирования всегда
 *   приходит аргументом, иначе backtest и тест перестают быть
 *   воспроизводимыми;
 * - **физические подписки** (`prepareMarket`, `subscribeMarket`, …):
 *   планировщик ничего не приобретает, и знать имена этих операций ему
 *   незачем;
 * - **fallback-старт** (`fallbackMarketDuration`, арифметика по сроку
 *   истечения): canonical `Market` содержит ТОЧНОЕ начало торгов, оценивать
 *   его больше не из чего.
 *
 * Проверяется текст БЕЗ комментариев: TSDoc объясняет, почему этих
 * конструкций нет, и запрещать упоминание означало бы запрещать объяснение.
 */
const FORBIDDEN_CODE = [
  'Date.now',
  'new Date(',
  'clock',
  'Clock',
  'prepareMarket',
  'subscribeMarket',
  'subscribeCryptoPrices',
  'subscribeChainlinkTwap',
  'fallbackMarketDuration',
  'expiresAt',
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
 * @remarks
 * `require()` разбирается наравне с `import`, хотя пакет — ESM: проверка
 * существует ровно для того, чего в `src` быть НЕ должно, и пропустить
 * `require('@polymarket/client')` она не имеет права только потому, что
 * такая строка ещё и не соберётся.
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
  it('package.json не объявляет ни одной infrastructure/transport зависимости', () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    // Все ЧЕТЫРЕ поля: peer/optional объявляют связь так же настоящим
    // образом, как runtime и dev, и запрет, проверяющий только два из них,
    // пропустил бы драйвер площадки, приехавший через peerDependencies.
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

  it('исходники импортируют только policy, порты и foundation', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      for (const specifier of collectImports(filePath)) {
        if (specifier.startsWith('.')) continue; // внутренние модули пакета
        if (!ALLOWED_IMPORTS.has(specifier)) {
          throw new Error(
            `Forbidden application-layer import '${specifier}' in ${srcRelative(filePath)}`,
          );
        }
      }
    }
  });

  it('каждый импорт src объявлен рантайм-зависимостью пакета', () => {
    // Allow-list отвечает на вопрос «можно ли архитектурно», но не на вопрос
    // «объявлено ли». Разойтись они могут в обе стороны: пакет тянет в
    // рантайм то, чем не пользуется, либо src импортирует то, чего нет в
    // зависимостях, и сборка потребителя падает уже у него.
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

describe('структурные инварианты планировщика', () => {
  it.each(FORBIDDEN_CODE)('код пакета не содержит «%s»', (forbidden) => {
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const code = stripComments(readFileSync(filePath, 'utf8'));
      if (code.includes(forbidden)) {
        throw new Error(`Forbidden construct '${forbidden}' in ${srcRelative(filePath)}`);
      }
    }
  });

  it('расписание читается ТОЛЬКО через точное начало торгов', () => {
    // Отсутствие `expiresAt` в коде проверено выше; здесь фиксируется вторая
    // половина того же правила — что начало торгов вообще используется.
    const planner = readFileSync(join(SRC_ROOT, 'PolymarketSubscriptionPlanner.ts'), 'utf8');
    const code = stripComments(planner);

    expect(code).toContain('market.startsAt');
    expect(code).toContain('isStartedAt(now)');
  });

  it('новый контур не знает LEGACY-контрактов отбора и сбора', () => {
    // `DiscoveredMarket`/`IMarketFilterConfig` — прежний owner-контракт,
    // `MarketCollectionCoordinator` — прежний координатор сбора. Планировщик
    // не их переименование: он использован как поведенческий ориентир, но
    // ни одной их сущности не наследует.
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const content = readFileSync(filePath, 'utf8');
      expect(content).not.toContain('DiscoveredMarket');
      expect(content).not.toContain('IMarketFilterConfig');
      expect(content).not.toContain('MarketCollectionCoordinator');
    }
  });
});

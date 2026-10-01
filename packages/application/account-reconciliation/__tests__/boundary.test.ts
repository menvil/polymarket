/**
 * Граница зависимостей и структурные запреты пакета
 * `@polymarket/account-reconciliation`.
 *
 * @remarks
 * Сверка — Application-слой. Vendor-формат источника переводит в canonical
 * будущий Infrastructure-адаптер, поэтому пакет не зависит от инфраструктуры
 * Polymarket ни прямо, ни через devDependencies:
 *
 * ```text
 * Infrastructure: Polymarket venue adapter  (следующий этап)
 *         ↓ implements IAccountVenueStateSource
 * ─────────────────────────────────────────────────────
 * Application: контракт состояния площадки + AccountReconciler + Coordinator
 * ```
 *
 * Правила проверяются по РЕАЛЬНЫМ артефактам — `package.json`, дереву
 * `packages/infrastructure` и тексту исходников, — а не по договорённости.
 */
import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Пакет тестируется в настоящем ESM (`--experimental-vm-modules`): `__dirname`
// там нет, путь берётся из `import.meta.url`.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');
const INFRASTRUCTURE_ROOT = join(PACKAGE_ROOT, '..', '..', 'infrastructure');

/**
 * Разрешённые импорты `src` — закрытый список.
 *
 * @remarks
 * Открытый («всё, кроме запрещённого») пропустил бы любую новую зависимость,
 * о которой тест ещё не знает, — ровно тот случай, ради которого он написан.
 */
const ALLOWED_IMPORTS = new Set([
  '@polymarket/account-state',
  '@polymarket/application-events',
  '@polymarket/errors',
  '@polymarket/errors/event-bus',
  '@polymarket/event-bus',
  '@polymarket/fill',
  '@polymarket/ids',
  '@polymarket/messages',
  '@polymarket/order',
  '@polymarket/portfolio',
  '@polymarket/result',
  '@polymarket/time',
  '@polymarket/timestamp',
  '@polymarket/value-objects',
]);

/**
 * Файлы контракта состояния площадки и их ЕДИНСТВЕННО допустимые внешние
 * зависимости.
 *
 * @remarks
 * Уже, чем общий закрытый список пакета: контракт фактов площадки не зависит ни
 * от `Portfolio`/`Position` (он НЕ локальное состояние), ни от шины и
 * состояния аккаунта (он не участвует в коррекции) — только от canonical
 * идентификаторов, value objects, заявки, исполнения и `Result`. Относительные
 * импорты — только соседние файлы `src`: путь наружу (`../…`) обошёл бы
 * закрытый список.
 */
const VENUE_STATE_CONTRACT_FILES = ['AuthoritativeAccountState.ts', 'IAccountVenueStateSource.ts'];
const VENUE_STATE_CONTRACT_IMPORTS = new Set([
  '@polymarket/fill',
  '@polymarket/ids',
  '@polymarket/order',
  '@polymarket/result',
  '@polymarket/value-objects',
]);

/**
 * Что application-пакет не имеет права импортировать ни в одном файле `src`.
 *
 * @remarks
 * - vendor-клиенты Polymarket и HTTP-библиотеки: их типы и транспорт живут в
 *   Infrastructure-адаптере;
 * - фрагменты путей `infrastructure`, `apps/pnl`, `legacy-bot`: рабочий код
 *   `apps/pnl` и legacy — справочник для адаптера, а не зависимость сверки.
 */
const FORBIDDEN_PACKAGES = [
  '@polymarket/client',
  '@polymarket/bindings',
  'axios',
  'node-fetch',
  'cross-fetch',
  'undici',
];
const FORBIDDEN_PATH_FRAGMENTS = ['infrastructure', 'apps/pnl', 'legacy-bot'];

/**
 * Конструкции, которых не должно быть в КОДЕ пакета.
 *
 * @remarks
 * - часы (`Date.now`, `new Date(`): время — только от инъецированных часов;
 * - таймеры (`setTimeout`, `setInterval`): координатор выполняет запросы, а
 *   каденцию выбирает будущий runtime wiring;
 * - `JSON.stringify`: равенство domain-сущностей — только canonical;
 * - `fetch`/`axios`: HTTP живёт в адаптере источника, не здесь.
 *
 * Проверяется текст БЕЗ комментариев: TSDoc объясняет, почему этих
 * конструкций нет.
 */
const FORBIDDEN_CODE = [
  'Date.now',
  'new Date(',
  'setTimeout',
  'setInterval',
  'JSON.stringify',
  'fetch(',
  'axios',
];

/** Рекурсивно собирает файлы с заданным именем или расширением. */
function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath, accept));
    else if (entry.isFile() && accept(entry.name)) files.push(fullPath);
  }
  return files;
}

/** Убирает комментарии: import-подобный текст в TSDoc — не зависимость. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Все module-specifiers файла, включая `require()` и динамический `import()`. */
function collectImports(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Имя пакета без subpath: `@polymarket/errors/event-bus` → `@polymarket/errors`. */
function packageName(specifier: string): string {
  const [scope, name] = specifier.split('/');
  return specifier.startsWith('@') ? `${scope}/${name}` : scope;
}

/** Имена всех пакетов из `packages/infrastructure`. */
function infrastructurePackageNames(): Set<string> {
  const names = new Set<string>();
  if (!existsSync(INFRASTRUCTURE_ROOT)) return names;
  for (const file of listFiles(INFRASTRUCTURE_ROOT, (name) => name === 'package.json')) {
    const { name } = JSON.parse(readFileSync(file, 'utf8')) as { name?: string };
    if (name !== undefined) names.add(name);
  }
  return names;
}

const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const dependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
const allDependencies = new Set([...dependencies, ...Object.keys(packageJson.devDependencies ?? {})]);
const sourceFiles = listFiles(SRC_ROOT, (name) => name.endsWith('.ts'));

describe('граница пакета @polymarket/account-reconciliation', () => {
  it('ни dependencies, ни devDependencies не содержат пакетов infrastructure', () => {
    const infrastructure = infrastructurePackageNames();
    expect(infrastructure.size).toBeGreaterThan(0);
    const leaked = [...allDependencies].filter((name) => infrastructure.has(name));
    expect(leaked).toEqual([]);
  });

  it('src импортирует только canonical application/domain/foundation-контракты из закрытого списка', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      for (const specifier of collectImports(stripComments(readFileSync(file, 'utf8')))) {
        if (specifier.startsWith('.')) continue;
        if (!ALLOWED_IMPORTS.has(specifier)) {
          violations.push(`${relative(SRC_ROOT, file).split(sep).join('/')}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('каждый внешний импорт src объявлен в dependencies (не в devDependencies)', () => {
    const undeclared: string[] = [];
    for (const file of sourceFiles) {
      for (const specifier of collectImports(stripComments(readFileSync(file, 'utf8')))) {
        if (specifier.startsWith('.')) continue;
        if (!dependencies.has(packageName(specifier))) undeclared.push(specifier);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('контракт состояния площадки импортирует только canonical ids/value-objects/order/fill/result', () => {
    const violations: string[] = [];
    for (const name of VENUE_STATE_CONTRACT_FILES) {
      const file = join(SRC_ROOT, name);
      expect(existsSync(file)).toBe(true);
      for (const specifier of collectImports(stripComments(readFileSync(file, 'utf8')))) {
        const allowed = specifier.startsWith('.')
          ? specifier.startsWith('./') && !specifier.includes('..')
          : VENUE_STATE_CONTRACT_IMPORTS.has(specifier);
        if (!allowed) violations.push(`${name}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('ни src, ни зависимости не тянут vendor-клиентов, HTTP, infrastructure, apps/pnl и legacy-bot', () => {
    const leakedDependencies = [...allDependencies].filter(
      (name) => FORBIDDEN_PACKAGES.includes(name) || FORBIDDEN_PATH_FRAGMENTS.some((part) => name.includes(part)),
    );
    const leakedImports: string[] = [];
    for (const file of sourceFiles) {
      for (const specifier of collectImports(stripComments(readFileSync(file, 'utf8')))) {
        const forbidden =
          FORBIDDEN_PACKAGES.includes(packageName(specifier)) ||
          FORBIDDEN_PATH_FRAGMENTS.some((part) => specifier.includes(part));
        if (forbidden) leakedImports.push(`${relative(SRC_ROOT, file).split(sep).join('/')}: ${specifier}`);
      }
    }
    expect(leakedDependencies).toEqual([]);
    expect(leakedImports).toEqual([]);
  });

  it('в коде нет часов, таймеров, JSON-равенства и HTTP', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const forbidden of FORBIDDEN_CODE) {
        if (code.includes(forbidden)) {
          violations.push(`${relative(SRC_ROOT, file).split(sep).join('/')}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

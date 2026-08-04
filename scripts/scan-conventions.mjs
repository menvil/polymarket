#!/usr/bin/env node
/**
 * Метрика архитектурного долга по пакетам (Этап 0.2 плана миграции).
 *
 * @remarks
 * Эвристический, не типо-осведомлённый скан (без зависимости от TypeScript
 * Compiler API — по образцу остальных скриптов в scripts/, без внешних
 * зависимостей). Не претендует на абсолютную точность — задача: дать
 * ВОСПРОИЗВОДИМЫЙ, сравнимый между запусками счётчик по пакету, который
 * должен монотонно падать по мере миграции (Этапы 1-10 плана
 * `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`), а не судить
 * отдельный файл.
 *
 * Что считается на пакет (`src/**\/*.ts`; если `src/` нет — весь пакет от корня,
 * см. `packages/infrastructure/polymarket` без `src/`, — исключая `__tests__/`,
 * `*.test.ts`, `*.spec.ts`, `dist/`, `node_modules/`, `coverage/`, `stubs/`
 * — последнее содержит скомпилированный артефакт, не источник):
 * - `rawDecimal` — `: Decimal` внутри экспортированных объявлений
 *   (interface/type/class/function/const), вне `value-objects`/`math`
 *   (там Decimal — легитимное внутреннее представление).
 * - `rawNumber` / `rawString` — `: number` / `: string` внутри
 *   экспортированных объявлений (везде, включая value-objects/math —
 *   там тоже интересно видеть, что реально уходит наружу из facade).
 * - `throwSites` — `throw` вне `value-objects`/`math` (там throw — часть
 *   контракта VO-конструкторов, не нарушение).
 * - `undocumentedExports` — `export` объявления без непосредственно
 *   предшествующего TSDoc-блока (`* /` последней непустой строкой выше).
 * - `hasDocs` — есть ли `docs/*.md` в пакете.
 *
 * @example
 * ```bash
 * node scripts/scan-conventions.mjs
 * # → docs/migration/debt.md (таблица) + docs/migration/debt.json (сырые данные)
 * # + docs/migration/decimal-import-files.txt (allowlist для ESLint Этапа 0.4)
 * ```
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Пакеты, где Decimal — легитимное внутреннее представление (не считаем rawDecimal/декимал-импорт долгом). */
const DECIMAL_ALLOWED = new Set([
  'packages/domain/value-objects',
  'packages/foundation/math',
]);

const SEARCH_ROOTS = ['packages', 'apps'];
const TEST_FILE_RE = /(^|\/)__tests__\//;
const TEST_SUFFIX_RE = /\.(test|spec)\.ts$/;

/** @returns {string[]} Абсолютные пути ко всем package.json воркспейсов (без node_modules/dist). */
function findPackages() {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(full, 'package.json'))) {
          results.push(full);
        }
        walk(full);
      }
    }
  }
  for (const root of SEARCH_ROOTS) walk(path.join(ROOT, root));
  return results.sort();
}

/** Директории, не считающиеся источником ни в src/, ни в fallback-режиме без src/. */
const EXCLUDED_DIRS = new Set(['dist', 'node_modules', 'coverage', 'stubs', '.git']);

/**
 * @returns {string[]} Все .ts файлы пакета, исключая тесты.
 * @remarks Если `src/` есть — сканируется только он (стандартный layout). Если нет —
 * fallback на весь пакет от корня (см. `packages/infrastructure/polymarket`).
 */
function findSourceFiles(pkgDir) {
  const srcDir = path.join(pkgDir, 'src');
  const rootDir = fs.existsSync(srcDir) ? srcDir : pkgDir;
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(pkgDir, full);
      if (TEST_FILE_RE.test(rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !TEST_SUFFIX_RE.test(entry.name)) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

/** Убирает построчные `//`-комментарии (грубо, не учитывает строки с `//` внутри строковых литералов — приемлемо для эвристики). */
function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Считает метрики одного файла.
 *
 * @param {string} filePath - Абсолютный путь
 * @param {boolean} decimalAllowed - Разрешён ли Decimal как внутреннее представление в этом пакете
 * @returns {{rawDecimal:number, rawNumber:number, rawString:number, throwSites:number, undocumentedExports:number, totalExports:number, decimalImport:boolean}}
 */
function scanFile(filePath, decimalAllowed) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');

  const metrics = {
    rawDecimal: 0,
    rawNumber: 0,
    rawString: 0,
    throwSites: 0,
    undocumentedExports: 0,
    totalExports: 0,
    decimalImport: /^\s*import\s+.*\bfrom\s+['"]decimal\.js['"]/m.test(text),
  };

  // throw — считаем везде вне value-objects/math (throw внутри VO-конструктора легитимен).
  if (!decimalAllowed) {
    for (const raw of lines) {
      const line = stripLineComment(raw);
      if (/\bthrow\b/.test(line)) metrics.throwSites += 1;
    }
  }

  // Экспортированные объявления: открываем "трекинг" на строке export ...,
  // закрываем когда braceDepth возвращается к 0 (после того как хотя бы раз стал > 0),
  // либо сразу для однострочных export type X = ...; без {.
  let depth = 0;
  let tracking = false;
  let trackingOpenedBrace = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripLineComment(raw);
    const trimmed = line.trim();

    if (!tracking && /^export\s+(interface|type|class|function|const|enum|abstract class)\b/.test(trimmed)) {
      tracking = true;
      trackingOpenedBrace = false;
      metrics.totalExports += 1;

      // TSDoc-проверка: ближайшая непустая строка ВЫШЕ строки export должна закрывать /** */.
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === '') j--;
      const documented = j >= 0 && lines[j].trim().endsWith('*/');
      if (!documented) metrics.undocumentedExports += 1;
    }

    if (tracking) {
      for (const ch of line) {
        if (ch === '{') { depth += 1; trackingOpenedBrace = true; }
        else if (ch === '}') depth -= 1;
      }
      // Примитивы считаем, пока трекаем объявление (включая саму сигнатуру до {).
      if (/:\s*Decimal\b/.test(line)) metrics.rawDecimal += 1;
      if (/:\s*number\b/.test(line)) metrics.rawNumber += 1;
      if (/:\s*string\b/.test(line)) metrics.rawString += 1;

      const singleLineEnd = /;\s*$/.test(trimmed) && !trackingOpenedBrace;
      if ((trackingOpenedBrace && depth <= 0) || singleLineEnd) {
        tracking = false;
      }
    }
  }

  if (decimalAllowed) {
    metrics.rawDecimal = 0; // не долг — легитимное внутреннее представление
  }

  return metrics;
}

/** @returns {boolean} Есть ли непустая docs/*.md в пакете. */
function hasDocs(pkgDir) {
  const docsDir = path.join(pkgDir, 'docs');
  if (!fs.existsSync(docsDir)) return false;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && walk(full)) return true;
      if (entry.isFile() && entry.name.endsWith('.md')) return true;
    }
    return false;
  };
  return walk(docsDir);
}

function main() {
  const pkgDirs = findPackages();
  const rows = [];
  const decimalImportFiles = [];

  for (const pkgDir of pkgDirs) {
    const relPkg = path.relative(ROOT, pkgDir);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const decimalAllowed = DECIMAL_ALLOWED.has(relPkg);
    const files = findSourceFiles(pkgDir);

    const agg = {
      name: pkgJson.name ?? relPkg,
      relPath: relPkg,
      rawDecimal: 0,
      rawNumber: 0,
      rawString: 0,
      throwSites: 0,
      undocumentedExports: 0,
      totalExports: 0,
      fileCount: files.length,
      hasDocs: hasDocs(pkgDir),
    };

    for (const file of files) {
      const m = scanFile(file, decimalAllowed);
      agg.rawDecimal += m.rawDecimal;
      agg.rawNumber += m.rawNumber;
      agg.rawString += m.rawString;
      agg.throwSites += m.throwSites;
      agg.undocumentedExports += m.undocumentedExports;
      agg.totalExports += m.totalExports;
      if (m.decimalImport && !decimalAllowed) {
        decimalImportFiles.push(path.relative(ROOT, file));
      }
    }

    rows.push(agg);
  }

  // ── docs/migration/debt.json ──
  const migrationDir = path.join(ROOT, 'docs', 'migration');
  fs.mkdirSync(migrationDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(migrationDir, 'debt.json'),
    JSON.stringify({ generatedAt, packages: rows }, null, 2) + '\n',
  );

  // ── docs/migration/decimal-import-files.txt (allowlist для Этапа 0.4) ──
  decimalImportFiles.sort();
  fs.writeFileSync(
    path.join(migrationDir, 'decimal-import-files.txt'),
    decimalImportFiles.join('\n') + (decimalImportFiles.length > 0 ? '\n' : ''),
  );

  // ── docs/migration/debt.md ──
  const totalRow = rows.reduce((acc, r) => ({
    rawDecimal: acc.rawDecimal + r.rawDecimal,
    rawNumber: acc.rawNumber + r.rawNumber,
    rawString: acc.rawString + r.rawString,
    throwSites: acc.throwSites + r.throwSites,
    undocumentedExports: acc.undocumentedExports + r.undocumentedExports,
    totalExports: acc.totalExports + r.totalExports,
    noDocsCount: acc.noDocsCount + (r.hasDocs ? 0 : 1),
  }), { rawDecimal: 0, rawNumber: 0, rawString: 0, throwSites: 0, undocumentedExports: 0, totalExports: 0, noDocsCount: 0 });

  const lines = [];
  lines.push('# Метрика архитектурного долга по пакетам');
  lines.push('');
  lines.push(`Сгенерировано: \`node scripts/scan-conventions.mjs\` — ${generatedAt}`);
  lines.push('');
  lines.push('Эвристический скан (см. TSDoc в `scripts/scan-conventions.mjs`) — не типо-осведомлён,');
  lines.push('не судит отдельный файл. Задача: воспроизводимый счётчик, который должен монотонно');
  lines.push('падать по мере прохождения этапов плана миграции');
  lines.push('(`docs/architecture/boundary-contract.md`, план — `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`).');
  lines.push('');
  lines.push('| Пакет | rawDecimal | rawNumber | rawString | throw | undocumented/total exports | docs/ |');
  lines.push('|---|---:|---:|---:|---:|---:|:---:|');
  for (const r of rows) {
    lines.push(
      `| \`${r.relPath}\` | ${r.rawDecimal} | ${r.rawNumber} | ${r.rawString} | ${r.throwSites} | ${r.undocumentedExports}/${r.totalExports} | ${r.hasDocs ? '✅' : '❌'} |`,
    );
  }
  lines.push(
    `| **ИТОГО** | **${totalRow.rawDecimal}** | **${totalRow.rawNumber}** | **${totalRow.rawString}** | **${totalRow.throwSites}** | **${totalRow.undocumentedExports}/${totalRow.totalExports}** | **${totalRow.noDocsCount} пакетов без docs/** |`,
  );
  lines.push('');
  lines.push(`\`decimal.js\` импортируется вне \`value-objects\`/\`math\` в ${decimalImportFiles.length} файлах — полный список в \`docs/migration/decimal-import-files.txt\` (allowlist для ESLint-правила Этапа 0.4).`);
  lines.push('');

  fs.writeFileSync(path.join(migrationDir, 'debt.md'), lines.join('\n'));

  // eslint-disable-next-line no-console
  console.log(`Написано: docs/migration/debt.md, debt.json, decimal-import-files.txt (${rows.length} пакетов, ${decimalImportFiles.length} decimal.js-импортов вне allowlist)`);
}

main();

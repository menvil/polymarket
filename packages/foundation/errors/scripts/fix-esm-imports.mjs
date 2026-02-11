#!/usr/bin/env node
/**
 * Post-build script для исправления ESM импортов в dist/
 *
 * @remarks
 * TypeScript компилирует импорты "as-is" из source файлов.
 * В src/ мы используем TypeScript-style импорты без .js расширений:
 *   - import { Foo } from '../base';
 *   - import { Bar } from './utils';
 *
 * Но в runtime Node.js ESM требует явные расширения:
 *   - import { Foo } from '../base/index.js';
 *   - import { Bar } from './utils.js';
 *
 * Этот скрипт исправляет все относительные импорты в dist/**\/*.js файлах,
 * добавляя правильные .js расширения.
 *
 * Patterns:
 *   - from '../base' -> from '../base/index.js'
 *   - from './foo' -> from './foo.js'
 *   - from '../foo' -> from '../foo.js'
 *
 * НЕ трогает:
 *   - Абсолютные импорты (from '@polymarket/...')
 *   - Импорты с уже существующими расширениями (from './foo.js')
 *   - Node.js встроенные модули (from 'node:fs')
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, '../dist');

console.log('🔧 Fixing ESM imports in dist/...');

/**
 * Рекурсивно найти все .js файлы в директории
 */
function findJsFiles(dir, files = []) {
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      findJsFiles(fullPath, files);
    } else if (entry.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

// Найти все .js файлы в dist/
const jsFiles = findJsFiles(distPath);

let totalFixed = 0;
let totalFiles = 0;

for (const filePath of jsFiles) {
  let content = readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Fix 1: from '../base' -> from '../base/index.js'
  // Это специальный case для директорий с index.js
  content = content.replace(/from ['"](\.\.[\/\\]base)['"]/g, "from '$1/index.js'");

  // Fix 2: from './foo' or '../foo' -> from './foo.js' or '../foo.js'
  // Только для импортов БЕЗ расширения и не '../base' (уже обработан выше)
  content = content.replace(
    /from ['"](\.\.[\/\\][^'"]+|\.\/[^'"]+)(?<!\.js)['"]/g,
    (match, importPath) => {
      // Пропускаем если уже есть .js или это импорт '../base' (уже обработан выше)
      if (importPath.endsWith('.js') || importPath === '../base') {
        return match;
      }
      return `from '${importPath}.js'`;
    }
  );

  if (content !== originalContent) {
    writeFileSync(filePath, content, 'utf-8');
    totalFixed++;
  }

  totalFiles++;
}

console.log(`✅ Fixed ${totalFixed} of ${totalFiles} files`);

if (totalFixed === 0) {
  console.log('ℹ️  No files needed fixing (already correct)');
}

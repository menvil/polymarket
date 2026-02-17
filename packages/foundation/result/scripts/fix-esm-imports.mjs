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
 *   - from './foo' or '../foo' -> from './foo.js'  (file)
 *   - from '../base'           -> from '../base/index.js'  (directory)
 *
 * НЕ трогает:
 *   - Абсолютные импорты (from '@polymarket/...')
 *   - Импорты с уже существующими расширениями (from './foo.js')
 *   - Node.js встроенные модули (from 'node:fs')
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, '../dist');

console.log('🔧 Fixing ESM imports in dist/...');

/**
 * Рекурсивно найти все .js файлы в директории
 *
 * @param dir - Директория для поиска
 * @param files - Аккумулятор файлов (для рекурсии)
 * @returns Массив путей к .js файлам, или пустой массив если dir не существует
 */
function findJsFiles(dir, files = []) {
  if (!existsSync(dir)) {
    console.warn(`⚠️  dist/ directory not found at ${dir} — skipping import fix`);
    return files;
  }

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

if (jsFiles.length === 0 && existsSync(distPath)) {
  console.log('ℹ️  No .js files found in dist/');
  process.exit(0);
}

let totalFixed = 0;
let totalFiles = 0;

for (const filePath of jsFiles) {
  let content = readFileSync(filePath, 'utf-8');
  const originalContent = content;
  const fileDir = dirname(filePath);

  // Единый проход: для каждого относительного импорта без расширения
  // определяем через statSync — это файл или директория.
  content = content.replace(
    /from ['"](\.\.[/\\][^'"]+|\.\/[^'"]+)['"]/g,
    (match, importPath) => {
      // Пропускаем импорты у которых уже есть расширение файла
      if (extname(importPath) !== '') {
        return match;
      }

      const resolved = resolve(fileDir, importPath);

      let isDirectory = false;
      try {
        const s = statSync(resolved);
        isDirectory = s.isDirectory();
      } catch {
        // Файл не найден без расширения — значит это файл, добавляем .js
        isDirectory = false;
      }

      return `from '${importPath}${isDirectory ? '/index.js' : '.js'}'`;
    }
  );

  if (content !== originalContent) {
    writeFileSync(filePath, content, 'utf-8');
    totalFixed++;
  }

  totalFiles++;
}

console.log(`✅ Fixed ${totalFixed} of ${totalFiles} files`);

if (totalFixed === 0 && totalFiles > 0) {
  console.log('ℹ️  No files needed fixing (already correct)');
}

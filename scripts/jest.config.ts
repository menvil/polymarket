/**
 * Jest-конфигурация verification-скриптов репозитория.
 *
 * @remarks
 * `scripts/` не является npm-workspace (это dev-инструменты, а не пакет),
 * поэтому у них собственный минимальный проект: алиасы выводятся из
 * `tsconfig.json`, который и так обязан быть актуальным для `typecheck`.
 * Ручная копия алиасов молча расходилась бы с ним.
 *
 * `.mts` включён в `moduleFileExtensions` и в transform: валидатор написан
 * как ESM-скрипт, и тестировать его нужно ТОТ ЖЕ файл, который запускается
 * в квалификации, а не его копию.
 */
import type { Config } from 'jest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathsToModuleNameMapper } from 'ts-jest';

// __dirname, а не import.meta: файл конфигурации Jest читает через ts-node в
// CommonJS-режиме, где import.meta недоступен.
const tsconfig = JSON.parse(
  readFileSync(path.join(__dirname, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
) as { compilerOptions: { paths: Record<string, string[]> } };

const config: Config = {
  displayName: 'scripts',
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['mts', 'ts', 'js', 'json'],
  extensionsToTreatAsEsm: ['.ts', '.mts'],
  transform: {
    // Абсолютный путь: ts-jest резолвит относительный tsconfig от cwd
    // процесса, а не от rootDir конфигурации.
    '^.+\\.m?ts$': [
      'ts-jest',
      { useESM: true, tsconfig: path.join(__dirname, 'tsconfig.lint.json') },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    ...pathsToModuleNameMapper(tsconfig.compilerOptions.paths, { prefix: '<rootDir>/' }),
  },
};

export default config;

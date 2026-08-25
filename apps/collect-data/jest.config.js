/**
 * Jest-конфигурация приложения коллектора.
 *
 * @remarks
 * Алиасы пакетов НЕ дублируются вручную: они выводятся из
 * `tsconfig.json → compilerOptions.paths`, который и так обязан быть
 * актуальным для компиляции. Ручная копия расходилась бы с ним молча.
 *
 * ESM включён по-настоящему (`--experimental-vm-modules` в npm-скрипте):
 * рантайм импортирует официальный SDK как ESM-пакет из `node_modules`, и
 * подменять его моком значило бы тестировать не тот код, который работает.
 */
import { readFileSync } from 'node:fs';
import { pathsToModuleNameMapper } from 'ts-jest';

const tsconfig = JSON.parse(
  readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  ),
);

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: {
    // Относительные ESM-импорты с расширением `.js` → исходники TypeScript.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    ...pathsToModuleNameMapper(tsconfig.compilerOptions.paths, { prefix: '<rootDir>/' }),
  },
};

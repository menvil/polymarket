import type { Config } from 'jest';

/**
 * Базовая конфигурация Jest для всех пакетов foundation
 *
 * @remarks
 * Использует ESM preset для совместимости с type: "module" в package.json
 */
export const createJestConfig = (displayName: string): Config => ({
  displayName,
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/**/*.example.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@polymarket/time$': '<rootDir>/../time/src/index.ts',
    '^@polymarket/result$': '<rootDir>/../result/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.lint.json',
        useESM: true,
      },
    ],
  },
});
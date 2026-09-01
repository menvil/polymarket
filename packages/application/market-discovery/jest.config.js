export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@polymarket/errors$':                  '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/errors/(.*)$':             '<rootDir>/../../foundation/errors/src/$1',
    '^@polymarket/result$':                  '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/ids$':                     '<rootDir>/../../foundation/ids/src/index.ts',
    '^@polymarket/logger$':                  '<rootDir>/../../foundation/logger/src/index.ts',
    '^@polymarket/time$':                    '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/math$':                    '<rootDir>/../../foundation/math/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../foundation/timestamp/src/index.ts',
    '^@polymarket/value-objects$':           '<rootDir>/../../domain/value-objects/src/index.ts',
    '^@polymarket/value-objects/(.*)$':      '<rootDir>/../../domain/value-objects/src/$1',
    '^@polymarket/ports$':                   '<rootDir>/../ports/src/index.ts',
    '^@polymarket/market$':                  '<rootDir>/../../domain/entities/market/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          verbatimModuleSyntax: false,
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};

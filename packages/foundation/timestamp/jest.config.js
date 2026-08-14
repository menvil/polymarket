export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@polymarket/errors$': '<rootDir>/../errors/src/index.ts',
    '^@polymarket/errors/(.*)$': '<rootDir>/../errors/src/$1',
    '^@polymarket/result$': '<rootDir>/../result/src/index.ts',
    '^@polymarket/result/(.*)$': '<rootDir>/../result/src/$1',
    '^@polymarket/math$': '<rootDir>/../math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../time/src/index.ts',
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

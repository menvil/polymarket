export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@polymarket/errors$': '<rootDir>/../../../foundation/errors/src/index.ts',
    '^@polymarket/errors/portfolio$': '<rootDir>/../../../foundation/errors/src/portfolio/index.ts',
    '^@polymarket/result$': '<rootDir>/../../../foundation/result/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../../foundation/ids/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../../foundation/timestamp/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../value-objects/src/index.ts',
    '^@polymarket/value-objects/balance$': '<rootDir>/../../value-objects/src/balance/index.ts',
    '^@polymarket/value-objects/money$': '<rootDir>/../../value-objects/src/money/index.ts',
    '^@polymarket/value-objects/signed-quantity$': '<rootDir>/../../value-objects/src/signed-quantity/index.ts',
    '^@polymarket/math$': '<rootDir>/../../../foundation/math/src/index.ts',
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
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};

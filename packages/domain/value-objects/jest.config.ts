import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const baseConfig = createJestConfig('@polymarket/value-objects');

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Явно исключаем barrel файлы (index.ts) из coverage
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/**/*.example.ts',
  ],
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    // Переопределяем базовые правила нашими (важен порядок! наши идут после)
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/result/unsafe$': '<rootDir>/../../foundation/result/src/unsafe.ts',
    '^@polymarket/result/async$': '<rootDir>/../../foundation/result/src/async.ts',
    '^@polymarket/result/chain$': '<rootDir>/../../foundation/result/src/chain.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/math$': '<rootDir>/../../foundation/math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../foundation/ids/src/index.ts',
  },
};

export default config;
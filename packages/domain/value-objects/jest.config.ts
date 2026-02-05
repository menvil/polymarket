import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const baseConfig = createJestConfig('@polymarket/value-objects');

const config: Config = {
  ...baseConfig,
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    // Используем src/ .ts файлы для тестов
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/math$': '<rootDir>/../../foundation/math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../foundation/ids/src/index.ts',
    // Применяем базовые правила после наших (важен порядок!)
    ...baseConfig.moduleNameMapper,
  },
};

export default config;
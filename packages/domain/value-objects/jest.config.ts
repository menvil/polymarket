import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const baseConfig = createJestConfig('@polymarket/value-objects');

const config: Config = {
  ...baseConfig,
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    // Используем src/ .ts файлы для тестов
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
  },
};

export default config;
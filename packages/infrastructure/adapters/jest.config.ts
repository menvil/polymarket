import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const baseConfig = createJestConfig('@polymarket/adapters');

const config: Config = {
  ...baseConfig,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Infrastructure layer: относительные пути к foundation пакетам
    '^@polymarket/time$': '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/logger$': '<rootDir>/../../foundation/logger/src/index.ts',
  },
};

export default config;

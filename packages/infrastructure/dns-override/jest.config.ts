import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/dns-override');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@polymarket/logger$': '<rootDir>/../../foundation/logger/src/index.ts',
  },
};

export default config;

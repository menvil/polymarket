import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const baseConfig = createJestConfig('@polymarket/math');

const config: Config = {
  ...baseConfig,
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^@polymarket/errors$': '<rootDir>/../errors/src/index.ts',
  },
};

export default config;

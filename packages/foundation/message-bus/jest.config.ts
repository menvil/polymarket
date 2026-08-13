import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/message-bus');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Type-тесты импортируют публичный API через имя пакета (root export),
    // а не через приватные relative-пути — маппим имя на исходники.
    '^@polymarket/message-bus$': '<rootDir>/src/index.ts',
  },
};

export default config;

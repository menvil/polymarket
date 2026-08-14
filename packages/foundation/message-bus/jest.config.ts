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
    // Canonical message contract (M-003) + транзитивные зависимости generator-а
    '^@polymarket/messages$': '<rootDir>/../messages/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../ids/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../errors/src/index.ts',
    '^@polymarket/errors/(.*)$': '<rootDir>/../errors/src/$1',
    '^@polymarket/math$': '<rootDir>/../math/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../foundation/timestamp/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../domain/value-objects/src/index.ts',
    '^@polymarket/value-objects/(.*)$': '<rootDir>/../../domain/value-objects/src/$1',
  },
};

export default config;

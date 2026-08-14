import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/external-messages');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Type-тесты импортируют публичный API через имя пакета (root export),
    // а не через приватные relative-пути — маппим имя на исходники.
    '^@polymarket/external-messages$': '<rootDir>/src/index.ts',
    // Canonical message contract (M-003) + транзитивные зависимости generator-а.
    // Пакет живёт в infrastructure — foundation-пути на два уровня выше базовых.
    '^@polymarket/messages$': '<rootDir>/../../foundation/messages/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../foundation/ids/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/errors/(.*)$': '<rootDir>/../../foundation/errors/src/$1',
    '^@polymarket/math$': '<rootDir>/../../foundation/math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../foundation/timestamp/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../domain/value-objects/src/index.ts',
    '^@polymarket/value-objects/(.*)$': '<rootDir>/../../domain/value-objects/src/$1',
  },
};

export default config;

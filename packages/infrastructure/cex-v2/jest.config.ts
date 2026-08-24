import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/cex-v2');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Публичный API пакетов контура импортируется по имени пакета (root export),
    // а не через приватные relative-пути — маппим имена на исходники.
    '^@polymarket/cex-v2$': '<rootDir>/src/index.ts',
    '^@polymarket/external-message-bus$': '<rootDir>/../external-message-bus/src/index.ts',
    '^@polymarket/external-messages$': '<rootDir>/../external-messages/src/index.ts',
    // Foundation-движок и canonical message contract + транзитивные зависимости
    // generator-а. Пакет живёт в infrastructure — foundation-пути на два уровня выше.
    '^@polymarket/message-bus$': '<rootDir>/../../foundation/message-bus/src/index.ts',
    '^@polymarket/messages$': '<rootDir>/../../foundation/messages/src/index.ts',
    '^@polymarket/logger$': '<rootDir>/../../foundation/logger/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../foundation/ids/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/errors/(.*)$': '<rootDir>/../../foundation/errors/src/$1',
    '^@polymarket/math$': '<rootDir>/../../foundation/math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../foundation/timestamp/src/index.ts',
  },
};

export default config;

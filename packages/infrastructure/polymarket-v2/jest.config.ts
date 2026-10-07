import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/polymarket-v2');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Публичный API пакетов контура импортируется по имени пакета (root export),
    // а не через приватные relative-пути — маппим имена на исходники.
    '^@polymarket/polymarket-v2$': '<rootDir>/src/index.ts',
    '^@polymarket/polymarket-v2/account$': '<rootDir>/src/account.ts',
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
    // Discovery V2: canonical Market за vendor-границей + контракт снимка.
    '^@polymarket/market$': '<rootDir>/../../domain/entities/market/src/index.ts',
    '^@polymarket/ports$': '<rootDir>/../../application/ports/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../domain/value-objects/src/index.ts',
    // ports/market тянут доменные сущности исполнения транзитивно.
    '^@polymarket/order$': '<rootDir>/../../domain/entities/order/src/index.ts',
    '^@polymarket/fill$': '<rootDir>/../../domain/entities/fill/src/index.ts',
    '^@polymarket/portfolio$': '<rootDir>/../../domain/entities/portfolio/src/index.ts',
    // Account-state observation: порт сверки и его транзитивные зависимости.
    '^@polymarket/account-reconciliation$': '<rootDir>/../../application/account-reconciliation/src/index.ts',
    '^@polymarket/account-state$': '<rootDir>/../../application/account-state/src/index.ts',
    '^@polymarket/event-bus$': '<rootDir>/../../application/event-bus/src/index.ts',
    '^@polymarket/application-events$': '<rootDir>/../../application/events/src/index.ts',
    '^@polymarket/position$': '<rootDir>/../../domain/entities/position/src/index.ts',
    '^@polymarket/value-objects/(.*)$': '<rootDir>/../../domain/value-objects/src/$1',
  },
};

export default config;

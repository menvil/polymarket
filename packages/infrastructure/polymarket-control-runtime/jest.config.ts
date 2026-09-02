import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/polymarket-control-runtime');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Публичный API пакетов контура импортируется по имени пакета (root export),
    // а не через приватные relative-пути — маппим имена на исходники.
    '^@polymarket/polymarket-control-runtime$': '<rootDir>/src/index.ts',
    '^@polymarket/polymarket-subscription-control$':
      '<rootDir>/../polymarket-subscription-control/src/index.ts',
    '^@polymarket/polymarket-v2$': '<rootDir>/../polymarket-v2/src/index.ts',
    '^@polymarket/external-message-bus$': '<rootDir>/../external-message-bus/src/index.ts',
    '^@polymarket/external-messages$': '<rootDir>/../external-messages/src/index.ts',
    // Application-зависимости контрольного контура.
    '^@polymarket/ports$': '<rootDir>/../../application/ports/src/index.ts',
    '^@polymarket/policy$': '<rootDir>/../../application/policy/src/index.ts',
    '^@polymarket/market-discovery$': '<rootDir>/../../application/market-discovery/src/index.ts',
    '^@polymarket/subscription-planning$':
      '<rootDir>/../../application/subscription-planning/src/index.ts',
    // Foundation/Domain транзитивные зависимости: пакет живёт в
    // infrastructure — foundation-пути на два уровня выше.
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
    '^@polymarket/value-objects$': '<rootDir>/../../domain/value-objects/src/index.ts',
    '^@polymarket/market$': '<rootDir>/../../domain/entities/market/src/index.ts',
  },
};

export default config;

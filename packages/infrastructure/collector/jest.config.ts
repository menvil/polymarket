import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/collector');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Публичный API пакетов контура импортируется по имени пакета (root export),
    // а не через приватные relative-пути — маппим имена на исходники.
    '^@polymarket/collector$': '<rootDir>/src/index.ts',
    '^@polymarket/external-message-recorder$':
      '<rootDir>/../persistence/external-message-recorder/src/index.ts',
    '^@polymarket/external-message-bus$': '<rootDir>/../external-message-bus/src/index.ts',
    '^@polymarket/external-messages$': '<rootDir>/../external-messages/src/index.ts',
    '^@polymarket/data-collection$': '<rootDir>/../persistence/data-collection/src/index.ts',
    // polymarket-v2 нужен ТОЛЬКО тестам (типы CEX/PM-сообщений), не src.
    '^@polymarket/polymarket-v2$': '<rootDir>/../polymarket-v2/src/index.ts',
    '^@polymarket/cex-v2$': '<rootDir>/../cex-v2/src/index.ts',
    // Application-зависимости контура сбора.
    '^@polymarket/policy$': '<rootDir>/../../application/policy/src/index.ts',
    '^@polymarket/market-discovery$': '<rootDir>/../../application/market-discovery/src/index.ts',
    '^@polymarket/ports$': '<rootDir>/../../application/ports/src/index.ts',
    // Domain/Foundation транзитивные зависимости.
    '^@polymarket/market$': '<rootDir>/../../domain/entities/market/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../domain/value-objects/src/index.ts',
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
    '^@polymarket/rolling-window$': '<rootDir>/../../foundation/rolling-window/src/index.ts',
  },
};

export default config;

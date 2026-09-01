import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const base = createJestConfig('@polymarket/polymarket-semantic-adapter');

const config: Config = {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    // Публичный API пакетов контура импортируется по имени пакета (root export),
    // а не через приватные relative-пути — маппим имена на исходники.
    '^@polymarket/polymarket-semantic-adapter$': '<rootDir>/src/index.ts',
    '^@polymarket/polymarket-v2$': '<rootDir>/../polymarket-v2/src/index.ts',
    '^@polymarket/external-message-bus$': '<rootDir>/../external-message-bus/src/index.ts',
    '^@polymarket/external-messages$': '<rootDir>/../external-messages/src/index.ts',
    // Foundation-движок и canonical message contract. Пакет живёт в
    // infrastructure — foundation-пути на два уровня выше.
    '^@polymarket/message-bus$': '<rootDir>/../../foundation/message-bus/src/index.ts',
    '^@polymarket/messages$': '<rootDir>/../../foundation/messages/src/index.ts',
    '^@polymarket/logger$': '<rootDir>/../../foundation/logger/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../foundation/ids/src/index.ts',
    // Discovery отдаёт canonical Market за границей порта — маппим
    // доменные/портовые пакеты, которых требует его дерево импортов.
    '^@polymarket/market$': '<rootDir>/../../domain/entities/market/src/index.ts',
    '^@polymarket/ports$': '<rootDir>/../../application/ports/src/index.ts',
    '^@polymarket/order$': '<rootDir>/../../domain/entities/order/src/index.ts',
    '^@polymarket/portfolio$': '<rootDir>/../../domain/entities/portfolio/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/errors/(.*)$': '<rootDir>/../../foundation/errors/src/$1',
    '^@polymarket/math$': '<rootDir>/../../foundation/math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../../foundation/time/src/index.ts',
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../foundation/timestamp/src/index.ts',
    // Canonical Domain-модель стакана и VO + application-контур событий.
    '^@polymarket/value-objects$': '<rootDir>/../../domain/value-objects/src/index.ts',
    '^@polymarket/orderbook$': '<rootDir>/../../domain/entities/orderbook/src/index.ts',
    '^@polymarket/application-events$': '<rootDir>/../../application/events/src/index.ts',
    '^@polymarket/event-bus$': '<rootDir>/../../application/event-bus/src/index.ts',
    '^@polymarket/order-events$': '<rootDir>/../../domain/events/order/src/index.ts',
    '^@polymarket/fill$': '<rootDir>/../../domain/entities/fill/src/index.ts',
  },
};

export default config;

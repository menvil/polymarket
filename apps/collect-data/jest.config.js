/**
 * Jest-конфигурация приложения коллектора.
 *
 * @remarks
 * Пакеты контура импортируются по именам пакетов (публичный API), поэтому
 * имена маппятся на ИСХОДНИКИ — тесты не зависят от собранного `dist`.
 */
/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@polymarket/logger$': '<rootDir>/../../packages/foundation/logger/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../packages/foundation/ids/src/index.ts',
    '^@polymarket/result$': '<rootDir>/../../packages/foundation/result/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../packages/foundation/errors/src/index.ts',
    '^@polymarket/errors/(.*)$': '<rootDir>/../../packages/foundation/errors/src/$1',
    '^@polymarket/math$': '<rootDir>/../../packages/foundation/math/src/index.ts',
    '^@polymarket/time$': '<rootDir>/../../packages/foundation/time/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../packages/foundation/timestamp/src/index.ts',
    '^@polymarket/messages$': '<rootDir>/../../packages/foundation/messages/src/index.ts',
    '^@polymarket/message-bus$': '<rootDir>/../../packages/foundation/message-bus/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../packages/domain/value-objects/src/index.ts',
    '^@polymarket/ports$': '<rootDir>/../../packages/application/ports/src/index.ts',
    '^@polymarket/market-discovery$':
      '<rootDir>/../../packages/application/market-discovery/src/index.ts',
    '^@polymarket/data-collection$':
      '<rootDir>/../../packages/infrastructure/persistence/data-collection/src/index.ts',
    '^@polymarket/external-messages$':
      '<rootDir>/../../packages/infrastructure/external-messages/src/index.ts',
    '^@polymarket/external-message-bus$':
      '<rootDir>/../../packages/infrastructure/external-message-bus/src/index.ts',
    '^@polymarket/external-message-recorder$':
      '<rootDir>/../../packages/infrastructure/persistence/external-message-recorder/src/index.ts',
    '^@polymarket/polymarket-v2$':
      '<rootDir>/../../packages/infrastructure/polymarket-v2/src/index.ts',
    '^@polymarket/collection-coordinator$':
      '<rootDir>/../../packages/infrastructure/collection-coordinator/src/index.ts',
    '^@polymarket/market-finalizer$':
      '<rootDir>/../../packages/infrastructure/market-finalizer/src/index.ts',
    '^@polymarket/cex-v2$': '<rootDir>/../../packages/infrastructure/cex-v2/src/index.ts',
  },
};

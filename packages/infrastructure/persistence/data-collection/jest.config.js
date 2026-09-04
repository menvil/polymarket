export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@polymarket/logger$':        '<rootDir>/../../../foundation/logger/src/index.ts',
    '^@polymarket/ids$':           '<rootDir>/../../../foundation/ids/src/index.ts',
    '^@polymarket/timestamp$': '<rootDir>/../../../foundation/timestamp/src/index.ts',
    '^@polymarket/value-objects$': '<rootDir>/../../../domain/value-objects/src/index.ts',
    '^@polymarket/ports$':         '<rootDir>/../../../application/ports/src/index.ts',
    '^@polymarket/raw-archive-format$': '<rootDir>/../raw-archive-format/src/index.ts',
    '^@polymarket/result$':        '<rootDir>/../../../foundation/result/src/index.ts',
    '^@polymarket/errors$':        '<rootDir>/../../../foundation/errors/src/index.ts',
    '^@polymarket/errors/(.*)$':   '<rootDir>/../../../foundation/errors/src/$1',
    '^@polymarket/math$':          '<rootDir>/../../../foundation/math/src/index.ts',
    '^@polymarket/time$':          '<rootDir>/../../../foundation/time/src/index.ts',
    '^@polymarket/order$':         '<rootDir>/../../../domain/entities/order/src/index.ts',
    '^@polymarket/portfolio$':     '<rootDir>/../../../domain/entities/portfolio/src/index.ts',
    '^@polymarket/value-objects/balance$': '<rootDir>/../../../domain/value-objects/src/balance/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ESNext',
        moduleResolution: 'bundler',
      },
    }],
  },
};

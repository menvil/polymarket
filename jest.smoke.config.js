/**
 * Jest configuration for SMOKE TESTS
 *
 * @remarks
 * ⚠️ WARNING: Smoke tests run on REAL exchange with REAL money/positions!
 *
 * These tests are ISOLATED from regular tests (`npm test`).
 * Run ONLY via: `npm run test:smoke`
 *
 * Purpose:
 * - Verify production readiness
 * - Test against real Polymarket API
 * - Ensure all integrations work end-to-end
 *
 * Tests include:
 * - REST: Connect, balance, orderbook, place/cancel order, market buy/sell
 * - WebSocket: Connect, orderbook updates, trade updates
 */

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',

  // ONLY smoke tests (isolated from regular tests)
  testMatch: [
    '<rootDir>/tests/smoke/**/*.smoke.test.ts',
  ],

  // Setup file to load .env.smoke before tests
  setupFilesAfterEnv: ['<rootDir>/tests/smoke/setup.ts'],

  // Longer timeout for real API calls (30 seconds)
  testTimeout: 30000,

  // Transform TypeScript
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },

  // Clear mocks between tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Coverage (optional for smoke tests)
  collectCoverage: false,

  // Verbose output
  verbose: true,

  // Force exit after tests to prevent hanging (WebSocket connections may not close immediately)
  forceExit: true,

  // Detect open handles for debugging (if tests still hang)
  detectOpenHandles: false, // Set to true for debugging
};

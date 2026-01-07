/**
 * Mock Logger for tests
 *
 * @remarks
 * Implements ILogger interface to ensure type safety.
 * Tracks all log calls for verification in tests.
 */

import type { ILogger } from '../../src/domain/ports/ILogger.js';

export class MockLogger implements ILogger {
  public sillyCalls: Array<{ message: string; meta?: any }> = [];
  public traceCalls: Array<{ message: string; meta?: any }> = [];
  public debugCalls: Array<{ message: string; meta?: any }> = [];
  public infoCalls: Array<{ message: string; meta?: any }> = [];
  public warnCalls: Array<{ message: string; meta?: any }> = [];
  public errorCalls: Array<{ message: string; meta?: any }> = [];

  silly(message: string, meta?: any): void {
    this.sillyCalls.push({ message, meta });
  }

  trace(message: string, meta?: any): void {
    this.traceCalls.push({ message, meta });
  }

  debug(message: string, meta?: any): void {
    this.debugCalls.push({ message, meta });
  }

  info(message: string, meta?: any): void {
    this.infoCalls.push({ message, meta });
  }

  warn(message: string, meta?: any): void {
    this.warnCalls.push({ message, meta });
  }

  error(message: string, meta?: any): void {
    this.errorCalls.push({ message, meta });
  }

  child(_context: string): ILogger {
    return this;
  }

  /**
   * Resets all call tracking arrays
   */
  reset(): void {
    this.sillyCalls = [];
    this.traceCalls = [];
    this.debugCalls = [];
    this.infoCalls = [];
    this.warnCalls = [];
    this.errorCalls = [];
  }
}

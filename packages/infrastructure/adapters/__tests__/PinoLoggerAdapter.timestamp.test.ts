/**
 * Integration тест для проверки timestamp behavior в PinoLoggerAdapter
 */

import { describe, it, expect } from '@jest/globals';
import { Writable } from 'stream';
import { PinoLoggerAdapter } from '../src/PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';

describe('PinoLoggerAdapter - Timestamp Integration', () => {
  it('должен выводить только ОДНО поле time в JSON', () => {
    // Capture serialized output
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        chunks.push(chunk);
        callback();
      }
    });

    const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
    const logger = new PinoLoggerAdapter({}, clock, dest);

    logger.info('Test message', { extra: 'field' });

    // Get serialized JSON
    const output = Buffer.concat(chunks).toString();

    // Count how many "time" fields exist in raw JSON
    const timeMatches = output.match(/"time":/g);

    // Parse to see timestamp value
    const parsed = JSON.parse(output);

    // В raw JSON должно быть ОДНО поле "time" (от IClock)
    // Pino настроен использовать IClock через custom timestamp function
    expect(timeMatches).toBeDefined();
    expect(timeMatches!.length).toBe(1);

    // Проверяем что значение из IClock
    expect(parsed.time).toBe(clock.now().getTime());
  });

  it('должен использовать timestamp из IClock', () => {
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        chunks.push(chunk);
        callback();
      }
    });

    const fixedTime = new Date('2024-01-01T00:00:00Z');
    const clock = new PaperClock(fixedTime);
    const logger = new PinoLoggerAdapter({}, clock, dest);

    logger.info('Test message');

    const output = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(output);

    // IClock timestamp (milliseconds since epoch)
    const expectedTime = fixedTime.getTime();

    // Проверяем что timestamp из IClock используется в логе
    expect(parsed.time).toBe(expectedTime);
  });
});

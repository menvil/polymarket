/**
 * Integration тест для проверки timestamp behavior в PinoLoggerAdapter
 */

import { describe, it, expect } from '@jest/globals';
import { Writable } from 'stream';
import { PinoLoggerAdapter } from '../src/PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';

describe('PinoLoggerAdapter - Timestamp Integration', () => {
  it('должен выводить только ОДНО поле time в JSON (текущее поведение - баг)', () => {
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

    console.log('=== RAW JSON STRING ===');
    console.log(output);
    console.log('');

    // Count how many "time" fields exist in raw JSON
    const timeMatches = output.match(/"time":/g);
    console.log('Number of "time" fields in raw JSON:', timeMatches ? timeMatches.length : 0);

    // Parse to see which one wins
    const parsed = JSON.parse(output);
    console.log('Parsed "time" value:', parsed.time);
    console.log('Expected (from IClock):', clock.now().getTime());
    console.log('');

    // ОЖИДАЕМ: В raw JSON ОДНО поле "time" (от IClock)
    // Pino настроен использовать IClock через custom timestamp function

    expect(timeMatches).toBeDefined();
    expect(timeMatches!.length).toBe(1); // ИСПРАВЛЕНО: теперь одно поле
  });

  it('должен использовать timestamp из IClock (текущее поведение - не работает)', () => {
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

    console.log('Expected time (from IClock):', expectedTime);
    console.log('Actual time (from Pino):', parsed.time);
    console.log('Difference:', Math.abs(parsed.time - expectedTime));

    // ОЖИДАЕМ: parsed.time === expectedTime
    // РЕАЛЬНО: parsed.time !== expectedTime (Pino использует Date.now())
    // TODO: Исправить
  });
});

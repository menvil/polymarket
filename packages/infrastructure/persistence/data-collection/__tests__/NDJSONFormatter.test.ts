import { describe, it, expect } from '@jest/globals';
import { NDJSONFormatter } from '../src/formatters/NDJSONFormatter.js';

describe('NDJSONFormatter', () => {
  const fmt = new NDJSONFormatter();

  it('имеет расширение jsonl', () => {
    expect(fmt.extension).toBe('jsonl');
  });

  it('форматирует объект как JSON-строку с \\n', () => {
    const line = fmt.formatRecord({ event_type: 'book', ts: 1234 });
    expect(line).toBe('{"event_type":"book","ts":1234}\n');
  });

  it('результат является валидным JSON после strip \\n', () => {
    const line = fmt.formatRecord({ a: 1, b: 'hello' });
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed).toEqual({ a: 1, b: 'hello' });
  });

  it('каждая запись заканчивается ровно одним \\n', () => {
    const line = fmt.formatRecord({ x: 42 });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.lastIndexOf('\n')).toBe(line.length - 1);
  });

  it('обрабатывает вложенные объекты', () => {
    const obj = { bids: [{ price: '0.5', size: '100' }], asks: [] };
    const line = fmt.formatRecord(obj);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.bids[0].price).toBe('0.5');
  });
});

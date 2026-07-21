/**
 * Тесты PolymarketUserTradesRestClient.getUserFills() — cursor pagination.
 *
 * @remarks
 * Регрессия для P0-находки: `/data/trades` пагинирован через `next_cursor`
 * (сентинел `"LTE="` — страниц больше нет). Ранее `next_cursor` читался в тип
 * ответа, но игнорировался — метод возвращал только первую страницу молча.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { PolymarketUserTradesRestClient } from '../PolymarketUserTradesRestClient.js';
import type { PolymarketRestClient } from '../../PolymarketRestClient.js';
import type { ILogger } from '@polymarket/logger';

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

describe('PolymarketUserTradesRestClient.getUserFills — cursor pagination', () => {
  it('следует по next_cursor до сентинела "LTE=" и конкатенирует все страницы', async () => {
    const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>()
      .mockResolvedValueOnce({ data: [{ id: 'fill-1' }], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ data: [{ id: 'fill-2' }], next_cursor: 'cursor-3' })
      .mockResolvedValueOnce({ data: [{ id: 'fill-3' }], next_cursor: 'LTE=' });
    const restClient = { get } as unknown as PolymarketRestClient;
    const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

    const fills = await client.getUserFills({ limit: 500 });

    expect(fills.map((f) => f.id)).toEqual(['fill-1', 'fill-2', 'fill-3']);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[1][1]).toMatchObject({ next_cursor: 'cursor-2' });
    expect(get.mock.calls[2][1]).toMatchObject({ next_cursor: 'cursor-3' });
  });

  it('only_first_page: true останавливается после первой страницы, даже если есть next_cursor', async () => {
    const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>().mockResolvedValueOnce({ data: [{ id: 'fill-1' }], next_cursor: 'cursor-2' });
    const restClient = { get } as unknown as PolymarketRestClient;
    const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

    const fills = await client.getUserFills({ only_first_page: true });

    expect(fills.map((f) => f.id)).toEqual(['fill-1']);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('плоский массив без пагинации (нет next_cursor) — один запрос', async () => {
    const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>().mockResolvedValueOnce([{ id: 'fill-1' }, { id: 'fill-2' }]);
    const restClient = { get } as unknown as PolymarketRestClient;
    const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

    const fills = await client.getUserFills();

    expect(fills.map((f) => f.id)).toEqual(['fill-1', 'fill-2']);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('бросает, если пагинация не завершается сентинелом до MAX_PAGES — не возвращает частичный список молча', async () => {
    const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>().mockImplementation(async () => ({ data: [{ id: 'x' }], next_cursor: 'always-more' }));
    const restClient = { get } as unknown as PolymarketRestClient;
    const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

    await expect(client.getUserFills()).rejects.toThrow(/pagination did not terminate/i);
  });

  describe('requireCursor: true (authoritative getTrades() path)', () => {
    it('плоский bare-array ответ → бросает (schema drift, НЕ трактуется как «одна полная страница»)', async () => {
      const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>()
        .mockResolvedValueOnce([{ id: 'fill-1' }]);
      const restClient = { get } as unknown as PolymarketRestClient;
      const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

      await expect(client.getUserFills({ requireCursor: true })).rejects.toThrow(/bare array/i);
    });

    it('объектный ответ БЕЗ next_cursor (не на сентинеле) → бросает (schema drift, НЕ «страниц больше нет»)', async () => {
      const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>()
        .mockResolvedValueOnce({ data: [{ id: 'fill-1' }] });
      const restClient = { get } as unknown as PolymarketRestClient;
      const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

      await expect(client.getUserFills({ requireCursor: true })).rejects.toThrow(/missing next_cursor/i);
    });

    it('канонический объектный ответ с сентинелом "LTE=" — принимается без ошибок', async () => {
      const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>()
        .mockResolvedValueOnce({ data: [{ id: 'fill-1' }], next_cursor: 'LTE=' });
      const restClient = { get } as unknown as PolymarketRestClient;
      const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

      const fills = await client.getUserFills({ requireCursor: true });
      expect(fills.map((f) => f.id)).toEqual(['fill-1']);
    });

    it('без requireCursor (default) — bare-array и объект-без-cursor толерантно приняты (non-critical helpers)', async () => {
      const get = jest.fn<(endpoint: string, params?: Record<string, string>) => Promise<unknown>>()
        .mockResolvedValueOnce([{ id: 'fill-1' }]);
      const restClient = { get } as unknown as PolymarketRestClient;
      const client = new PolymarketUserTradesRestClient(restClient, makeLogger());

      const fills = await client.getUserFills();
      expect(fills.map((f) => f.id)).toEqual(['fill-1']);
    });
  });
});

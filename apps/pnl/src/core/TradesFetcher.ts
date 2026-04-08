/**
 * Загрузчик сделок пользователя из Polymarket CLOB API.
 *
 * @remarks
 * Реализует полную пагинацию через `next_cursor`.
 * Курсор `"LTE="` (base64 от "-1") означает последнюю страницу.
 *
 * Использует L2-аутентификацию (HMAC-подпись заголовков) через
 * существующий `PolymarketRestClient`.
 *
 * @example
 * ```typescript
 * const fetcher = new TradesFetcher(restClient, logger);
 * const trades = await fetcher.fetchAll({
 *   makerAddress: '0xabc...',
 *   fromTs: 1740787200,
 *   toTs:   1743465599,
 * });
 * console.log(`Fetched ${trades.length} trades`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestClient } from '@polymarket/exchange/rest';
import type { RawTrade, TradesPageResponse } from '../types.js';

/** Cursor означающий конец пагинации */
const NO_MORE_PAGES = 'LTE=';

/**
 * Параметры запроса сделок.
 */
export interface FetchTradesParams {
  /** Адрес кошелька для фильтрации (maker_address) */
  makerAddress: string;
  /** Начало периода в секундах Unix */
  fromTs: number;
  /** Конец периода в секундах Unix */
  toTs: number;
}

/**
 * Загрузчик сделок пользователя с поддержкой полной пагинации.
 */
export class TradesFetcher {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Загружает все сделки за период, обходя все страницы пагинации.
   *
   * @param params - Параметры запроса
   * @returns Массив всех сделок за период
   * @throws {Error} При ошибке API
   *
   * @remarks
   * Алгоритм:
   * 1. Запрашиваем первую страницу с after/before фильтрами.
   * 2. Если ответ содержит `next_cursor` (не "LTE=") — запрашиваем следующую.
   * 3. Повторяем до `next_cursor === "LTE="` или пустого `data[]`.
   *
   * @example
   * ```typescript
   * const trades = await fetcher.fetchAll({
   *   makerAddress: '0x1234...',
   *   fromTs: 1740787200,  // 2026-03-01 00:00:00 UTC
   *   toTs:   1743465599,  // 2026-03-31 23:59:59 UTC
   * });
   * ```
   */
  async fetchAll(params: FetchTradesParams): Promise<RawTrade[]> {
    const all: RawTrade[] = [];
    let nextCursor: string | undefined;
    let page = 0;

    this.logger.info('Fetching trades', {
      makerAddress: params.makerAddress,
      fromTs: params.fromTs,
      toTs: params.toTs,
    });

    do {
      page++;
      const queryParams: Record<string, string> = {
        maker_address: params.makerAddress,
        after: params.fromTs.toString(),
        before: params.toTs.toString(),
      };
      if (nextCursor) {
        queryParams['next_cursor'] = nextCursor;
      }

      this.logger.debug(`Fetching trades page ${page}`, { nextCursor });

      const raw = await this.restClient.get<TradesPageResponse | RawTrade[]>(
        '/data/trades',
        queryParams
      );

      // API может вернуть массив (без пагинации) или объект с пагинацией
      if (Array.isArray(raw)) {
        all.push(...raw);
        break;
      }

      const batch = raw.data ?? [];
      all.push(...batch);

      this.logger.debug(`Page ${page}: got ${batch.length} trades (total so far: ${all.length})`);

      const cursor = raw.next_cursor;
      nextCursor = (cursor && cursor !== NO_MORE_PAGES) ? cursor : undefined;

      // Защита от пустых страниц с ненулевым cursor
      if (batch.length === 0) break;
    } while (nextCursor);

    // Оставляем только исполненные сделки (исключаем FAILED/RETRYING)
    // API может возвращать как "CONFIRMED", так и "TRADE_STATUS_CONFIRMED"
    const confirmed = all.filter(t => {
      const status = (t as unknown as { status?: string }).status ?? '';
      const s = status.replace('TRADE_STATUS_', '');
      return !status || s === 'CONFIRMED' || s === 'MINED' || s === 'MATCHED';
    });

    // Логируем уникальные статусы для диагностики
    const statusCounts = new Map<string, number>();
    for (const t of all) {
      const s = (t as unknown as { status?: string }).status ?? 'NO_STATUS';
      statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
    }
    this.logger.info(`Fetched ${confirmed.length} valid trades (${all.length} total, ${page} pages)`, {
      statuses: Object.fromEntries(statusCounts),
    });

    return confirmed;
  }
}

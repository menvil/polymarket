/**
 * Загрузчик и нормализатор сделок пользователя из Polymarket CLOB API.
 *
 * @remarks
 * Реализует полную пагинацию через `next_cursor`.
 * Курсор `"LTE="` (base64 от "-1") означает последнюю страницу.
 *
 * ### Нормализация fills
 * CLOB API возвращает трейды с точки зрения тейкера. Если наш адрес является
 * суб-мейкером (находится в `maker_orders[i].maker_address`), то настоящие
 * параметры нашей сделки берутся из `maker_orders[i]`, а не с верхнего уровня.
 *
 * Случаи:
 * 1. `trader_side === 'TAKER'` → верхний уровень содержит наши данные.
 * 2. Иначе → ищем наш адрес в `maker_orders[i].maker_address` и берём оттуда
 *    `asset_id`, `side`, `matched_amount`, `price`, `fee_rate_bps`, `outcome`.
 *
 * Использует L2-аутентификацию (HMAC-подпись заголовков) через
 * существующий `PolymarketRestClient`.
 *
 * @example
 * ```typescript
 * const fetcher = new TradesFetcher(restClient, logger);
 * const fills = await fetcher.fetchAll({
 *   makerAddress: '0xabc...',
 *   fromTs: 1740787200,
 *   toTs:   1743465599,
 * });
 * console.log(`Fetched ${fills.length} normalized fills`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestClient } from '@polymarket/exchange/rest';
import type { RawTrade, NormalizedFill, TradesPageResponse } from '../types.js';

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
 * Загрузчик сделок пользователя с поддержкой полной пагинации и нормализацией fills.
 */
export class TradesFetcher {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Загружает сырые трейды из API без нормализации (для диагностики).
   *
   * @param params - Параметры запроса
   * @returns Массив сырых трейдов как пришли из API
   *
   * @example
   * ```typescript
   * const raw = await fetcher.fetchRaw({ makerAddress, fromTs, toTs });
   * console.log(JSON.stringify(raw[0], null, 2));
   * ```
   */
  async fetchRaw(params: FetchTradesParams): Promise<RawTrade[]> {
    const all: RawTrade[] = [];
    let nextCursor: string | undefined;
    let page = 0;

    do {
      page++;
      const queryParams: Record<string, string> = {
        maker_address: params.makerAddress,
        after: params.fromTs.toString(),
        before: params.toTs.toString(),
      };
      if (nextCursor) queryParams['next_cursor'] = nextCursor;

      const raw = await this.restClient.get<TradesPageResponse | RawTrade[]>(
        '/data/trades',
        queryParams
      );

      if (Array.isArray(raw)) { all.push(...raw); break; }

      const batch = raw.data ?? [];
      all.push(...batch);

      const cursor = raw.next_cursor;
      nextCursor = (cursor && cursor !== NO_MORE_PAGES) ? cursor : undefined;
      if (batch.length === 0) break;
    } while (nextCursor);

    return all;
  }

  /**
   * Загружает все сделки за период, нормализует их до наших реальных fills.
   *
   * @param params - Параметры запроса
   * @returns Массив нормализованных fills (каждый отражает нашу реальную сторону сделки)
   * @throws {Error} При ошибке API
   *
   * @remarks
   * Алгоритм:
   * 1. Запрашиваем первую страницу с after/before фильтрами.
   * 2. Если ответ содержит `next_cursor` (не "LTE=") — запрашиваем следующую.
   * 3. Повторяем до `next_cursor === "LTE="` или пустого `data[]`.
   * 4. Оставляем только CONFIRMED/MINED/MATCHED трейды.
   * 5. Нормализуем каждый трейд до наших реальных fills.
   *
   * @example
   * ```typescript
   * const fills = await fetcher.fetchAll({
   *   makerAddress: '0x1234...',
   *   fromTs: 1740787200,
   *   toTs:   1743465599,
   * });
   * ```
   */
  async fetchAll(params: FetchTradesParams): Promise<NormalizedFill[]> {
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

    // Нормализуем каждый трейд до наших реальных fills
    const fills: NormalizedFill[] = [];
    for (const trade of confirmed) {
      const normalized = this.normalizeTrade(trade, params.makerAddress);
      fills.push(...normalized);
    }

    this.logger.info(`Normalized to ${fills.length} fills`);
    return fills;
  }

  /**
   * Нормализует один сырой трейд до наших реальных fills.
   *
   * @param trade - Сырой трейд из CLOB API
   * @param ourAddress - Адрес нашего кошелька (для поиска в maker_orders)
   * @returns Массив NormalizedFill (обычно 1, иногда больше при мультипартийных матчах)
   *
   * @remarks
   * Когда мы тейкер (`trader_side === 'TAKER'`), используем верхний уровень трейда.
   * Когда мы мейкер — ищем наш адрес в `maker_orders[i].maker_address` и
   * берём `asset_id`, `side`, `matched_amount`, `price` из соответствующего элемента.
   */
  private normalizeTrade(trade: RawTrade, ourAddress: string): NormalizedFill[] {
    const lowerOur = ourAddress.toLowerCase();

    // Случай 1: мы тейкер — верхний уровень содержит наши данные
    if (trade.trader_side === 'TAKER') {
      return [this.topLevelFill(trade)];
    }

    // Случай 2: ищем наш адрес в maker_orders
    const fromMakerOrders: NormalizedFill[] = [];
    for (const mo of trade.maker_orders ?? []) {
      if (mo.maker_address?.toLowerCase() !== lowerOur) continue;
      const size = parseFloat(mo.matched_amount);
      if (size <= 0) continue;

      fromMakerOrders.push({
        id: trade.id,
        market: trade.market,
        asset_id: mo.asset_id ?? trade.asset_id,
        side: mo.side ?? trade.side,
        size: mo.matched_amount,
        price: mo.price ?? trade.price,
        fee_rate_bps: mo.fee_rate_bps,
        match_time: trade.match_time,
        outcome: mo.outcome,
      });
    }

    if (fromMakerOrders.length > 0) return fromMakerOrders;

    // Fallback: используем верхний уровень (адрес не найден в maker_orders)
    this.logger.debug(`Trade ${trade.id}: our address not found in maker_orders, using top-level`);
    return [this.topLevelFill(trade)];
  }

  /**
   * Создаёт NormalizedFill из верхнего уровня трейда.
   *
   * @param trade - Сырой трейд
   * @returns NormalizedFill с данными верхнего уровня
   */
  private topLevelFill(trade: RawTrade): NormalizedFill {
    return {
      id: trade.id,
      market: trade.market,
      asset_id: trade.asset_id,
      side: trade.side,
      size: trade.size,
      price: trade.price,
      fee_rate_bps: trade.fee_rate_bps,
      match_time: trade.match_time,
      outcome: trade.outcome,
    };
  }
}

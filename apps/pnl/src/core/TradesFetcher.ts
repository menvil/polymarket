/**
 * Загрузчик сделок с комиссиями — аутентифицированный путь.
 *
 * @remarks
 * Дополняет `ActivityFetcher`, а не заменяет его. Публичная лента активности
 * даёт сделки без двух вещей, и обе видны только своему аккаунту:
 *
 * - **роль MAKER/TAKER** — публичная лента её не различает.
 *
 * Комиссию здесь приходится СЧИТАТЬ по документированной формуле: поля
 * `amount` (реально перемещённый USDC) этот эндпоинт не отдаёт, а
 * `feeRateBps` приходит `"0"` — не заполняется. Публичная лента в этом
 * смысле точнее: там комиссия измеряется, а не моделируется.
 *
 * Ценой за них служит аутентификация: `listAccountTrades` живёт на
 * `createSecureClient`, а тот требует настоящий signer даже с готовыми
 * `credentials`. Поэтому путь включается только когда в окружении есть
 * `PRIVATE_KEY` и тройка `POLYMARKET_API_*`; без них отчёт строится по
 * публичным данным и печатает `—` в колонке комиссий.
 *
 * ### Нормализация sub-maker сделок
 * CLOB отдаёт сделку с точки зрения **тейкера**. Если наш адрес выступил
 * суб-мейкером, он лежит в `makerOrders[i].makerAddress`, и настоящие
 * параметры НАШЕЙ сделки (`tokenId`, `side`, `matchedAmount`, `price`,
 * `feeRateBps`, `outcome`) надо брать оттуда, а не с верхнего уровня —
 * иначе PnL считается по чужой стороне сделки.
 *
 * Публичной ленте эта нормализация не нужна: она отдаёт события уже от лица
 * кошелька.
 *
 * @example
 * ```typescript
 * const fetcher = new TradesFetcher(secureClient, logger);
 * const fills = await fetcher.fetchAll({ makerAddress, fromTs, toTs });
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { ClobTrade } from '@polymarket/bindings/clob';
import { money, price, quantity, timestamp } from './vo.js';
import type { NormalizedFill } from '../types.js';

/** Узкий порт: из secure-клиента нужен один метод. */
export interface AccountTradesClient {
  listAccountTrades(request?: {
    makerAddress?: string;
    after?: string;
    before?: string;
  }): AsyncIterable<{ items: ClobTrade[] }>;
}

/** Параметры запроса сделок. */
export interface FetchTradesParams {
  /** Наш адрес */
  makerAddress: string;
  /** Начало периода в секундах Unix */
  fromTs: number;
  /** Конец периода в секундах Unix */
  toTs: number;
}

/** Статусы, которые считаем реально исполненными. */
const EXECUTED_STATUSES = new Set(['CONFIRMED', 'MINED', 'MATCHED']);

/**
 * Загружает сделки аккаунта вместе со ставками комиссий.
 */
export class TradesFetcher {
  /**
   * @param _client - Аутентифицированный клиент SDK
   * @param _logger - Логгер
   */
  constructor(
    private readonly _client: AccountTradesClient,
    private readonly _logger: ILogger
  ) {}

  /**
   * Загружает и нормализует все сделки за период.
   *
   * Алгоритм:
   * 1. Итерируем страницы `listAccountTrades()` — курсор ведёт SDK.
   * 2. Оставляем исполненные статусы (отбрасываем FAILED/RETRYING).
   * 3. Нормализуем sub-maker сделки к нашей стороне.
   *
   * @param params - Наш адрес и границы периода
   * @returns Fills со ставкой комиссии и ролью по ликвидности
   * @throws {Error} При сетевом сбое или отказе API
   *
   * @example
   * ```typescript
   * const fills = await fetcher.fetchAll({ makerAddress, fromTs, toTs });
   * const withFees = fills.filter((f) => f.feeRateBps !== undefined);
   * ```
   */
  async fetchAll(params: FetchTradesParams): Promise<NormalizedFill[]> {
    this._logger.info('Fetching account trades (authenticated)', {
      makerAddress: params.makerAddress,
      fromTs: params.fromTs,
      toTs: params.toTs,
    });

    const all: ClobTrade[] = [];
    for await (const page of this._client.listAccountTrades({
      makerAddress: params.makerAddress,
      after: params.fromTs.toString(),
      before: params.toTs.toString(),
    })) {
      all.push(...page.items);
    }

    // API возвращает и "CONFIRMED", и "TRADE_STATUS_CONFIRMED".
    const confirmed = all.filter((t) => {
      const status = t.status ?? '';
      return status === '' || EXECUTED_STATUSES.has(status.replace('TRADE_STATUS_', ''));
    });

    const fills: NormalizedFill[] = [];
    for (const trade of confirmed) {
      fills.push(...this._normalizeTrade(trade, params.makerAddress));
    }

    fills.sort((a, b) => a.matchedAt.toNumber() - b.matchedAt.toNumber());
    this._logger.info(
      `Fetched ${confirmed.length} trades (${all.length} total) → ${fills.length} fills`
    );
    return fills;
  }

  /**
   * Приводит одну сделку к нашим fills.
   *
   * @param trade - Сделка из SDK
   * @param ourAddress - Наш адрес для поиска в `makerOrders`
   * @returns Обычно один fill, при мультипартийном матче — несколько
   */
  private _normalizeTrade(trade: ClobTrade, ourAddress: string): NormalizedFill[] {
    if (trade.traderSide === 'TAKER') {
      return [this._topLevelFill(trade)];
    }

    const ours = ourAddress.toLowerCase();
    const fromMakerOrders: NormalizedFill[] = [];
    for (const mo of trade.makerOrders ?? []) {
      if (mo.makerAddress.toLowerCase() !== ours) continue;
      const matched = Number(mo.matchedAmount);
      if (matched <= 0) continue;
      const executionPrice = Number(mo.price);

      fromMakerOrders.push({
        transactionHash: trade.transactionHash,
        market: trade.conditionId,
        asset_id: mo.tokenId,
        side: mo.side as NormalizedFill['side'],
        size: quantity(matched),
        price: price(executionPrice),
        usdcSize: money(matched * executionPrice),
        matchedAt: timestamp(Date.parse(trade.matchedAt)),
        outcome: mo.outcome,
        liquidityRole: 'MAKER',
      });
    }

    if (fromMakerOrders.length > 0) return fromMakerOrders;

    this._logger.debug(`Trade ${trade.id}: our address not in makerOrders, using top-level`);
    return [this._topLevelFill(trade)];
  }

  /**
   * Строит fill из верхнего уровня сделки.
   *
   * @param trade - Сделка из SDK
   * @returns Fill с данными верхнего уровня
   */
  private _topLevelFill(trade: ClobTrade): NormalizedFill {
    const size = Number(trade.size);
    const executionPrice = Number(trade.price);
    return {
      transactionHash: trade.transactionHash,
      market: trade.conditionId,
      asset_id: trade.tokenId,
      side: trade.side as NormalizedFill['side'],
      size: quantity(size),
      price: price(executionPrice),
      usdcSize: money(size * executionPrice),
      matchedAt: timestamp(Date.parse(trade.matchedAt)),
      outcome: trade.outcome,
      liquidityRole: trade.traderSide === 'TAKER' ? 'TAKER' : 'MAKER',
    };
  }
}

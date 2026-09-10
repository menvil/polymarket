/**
 * Загрузчик наших сделок из публичной ленты активности.
 *
 * @remarks
 * Заменяет прежний `TradesFetcher`, который ходил в CLOB `/data/trades` с
 * L2-подписью через собственный REST-клиент. Публичная лента
 * `listActivity()` отдаёт те же сделки по адресу кошелька и **не требует ни
 * ключей, ни приватного ключа** — аналитике не нужны права на подпись.
 *
 * Что изменилось по сравнению с аутентифицированным путём:
 *
 * - пагинацию ведёт SDK (`Paginated` — асинхронно итерируемые страницы),
 *   ручной обход `next_cursor` с магическим `"LTE="` больше не нужен;
 * - нормализация sub-maker сделок исчезла вместе с причиной: лента отдаёт
 *   события **от лица нашего кошелька**, а не с точки зрения тейкера, так
 *   что подменять сторону сделки не из чего и незачем;
 * - **комиссия здесь точнее, чем на аутентифицированном пути.** Лента отдаёт
 *   `amount` — фактически перемещённый USDC. Комиссия равна МОДУЛЮ разницы
 *   между `shares × price` и `amount`; знак разницы говорит лишь о том, с
 *   какой стороны она удержана (см. комментарий у расчёта). Это измерение, а
 *   не расчёт по ставке: не сломается, если Polymarket поменяет тариф.
 *
 * Роль (maker/taker) лента НЕ отдаёт — таких полей в записи нет. Но она и не
 * нужна: у мейкерского фила разница нулевая, потому что комиссии не было.
 *
 * @example
 * ```typescript
 * const fetcher = new ActivityFetcher(createPublicClient(), logger);
 * const fills = await fetcher.fetchAll({
 *   wallet: '0xabc...',
 *   fromTs: 1740787200,
 *   toTs:   1743465599,
 * });
 * console.log(`Fetched ${fills.length} fills`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { createPublicClient } from '@polymarket/client';
import { ActivityType } from '@polymarket/bindings/data';
import { money, price, quantity, timestamp } from './vo.js';
import type { NormalizedFill } from '../types.js';

/** Узкий порт: из всего клиента нужен один метод. */
export type ActivityClient = Pick<ReturnType<typeof createPublicClient>, 'listActivity'>;

/** Параметры запроса активности. */
export interface FetchActivityParams {
  /** Адрес кошелька */
  wallet: string;
  /** Начало периода в секундах Unix */
  fromTs: number;
  /** Конец периода в секундах Unix */
  toTs: number;
}

/**
 * Загружает и приводит нашу торговую активность за период.
 */
export class ActivityFetcher {
  /**
   * @param _client - Публичный клиент SDK (`createPublicClient()`)
   * @param _logger - Логгер
   */
  constructor(
    private readonly _client: ActivityClient,
    private readonly _logger: ILogger
  ) {}

  /**
   * Загружает все сделки за период.
   *
   * Алгоритм:
   * 1. Итерируем страницы `listActivity()` — курсор ведёт SDK.
   * 2. Оставляем только `type === 'TRADE'` (в ленте есть ещё DEPOSIT,
   *    REDEEM, SPLIT, MERGE — это не сделки и в PnL по входу не идут).
   * 3. Приводим к `NormalizedFill`.
   *
   * @param params - Кошелёк и границы периода
   * @returns Наши fills, отсортированные по времени
   * @throws {Error} При сетевом сбое или отказе API (типизированные ошибки SDK)
   *
   * @example
   * ```typescript
   * const fills = await fetcher.fetchAll({ wallet, fromTs, toTs });
   * ```
   */
  async fetchAll(params: FetchActivityParams): Promise<NormalizedFill[]> {
    this._logger.info('Fetching activity', {
      wallet: params.wallet,
      fromTs: params.fromTs,
      toTs: params.toTs,
    });

    const paginated = this._client.listActivity({
      user: params.wallet,
      start: params.fromTs,
      end: params.toTs,
      type: [ActivityType.TRADE],
    });

    const fills: NormalizedFill[] = [];
    const typeCounts = new Map<string, number>();
    let pages = 0;

    for await (const page of paginated) {
      pages += 1;
      for (const item of page.items) {
        typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
        if (item.type !== ActivityType.TRADE) continue;
        // Combo-сделки живут в другой системе координат (позиция протокола
        // v2, а не outcome-токен рынка) и в этот отчёт не входят.
        if (item.isCombo) continue;

        const shares = Number(item.shares);
        const executionPrice = Number(item.price);
        const amount = Number(item.amount);

        // `amount` — фактически перемещённый USDC, `shares × price` —
        // номинал. Комиссия и есть их расхождение, но ЗНАК у него разный по
        // сторонам, потому что платится она из того, что мы получаем:
        //
        //   BUY  тейкер   amount = номинал + fee   → разница отрицательна
        //   SELL тейкер   amount = номинал − fee   → разница положительна
        //   мейкер        amount = номинал         → разница нулевая
        //
        // Поэтому берётся МОДУЛЬ. Прежний `Math.max(0, …)` обнулял всю
        // покупательскую сторону: на 2898 реальных сделках это 31 тейкерская
        // покупка и 2.92 USDC комиссий, не попадавших в отчёт.
        //
        // Округление до 5 знаков убирает −1e-16 у мейкерских филов; сама
        // площадка считает комиссию с той же точностью.
        const feeUsdc = Math.round(Math.abs(shares * executionPrice - amount) * 1e5) / 1e5;

        fills.push({
          transactionHash: item.transactionHash,
          market: item.conditionId,
          asset_id: item.tokenId,
          side: item.side,
          size: quantity(shares),
          price: price(executionPrice),
          usdcSize: money(amount),
          feeUsdc: money(feeUsdc),
          matchedAt: timestamp(Number(item.timestamp)),
          outcome: item.outcome,
          outcomeIndex: item.outcomeIndex,
          title: item.title,
        });
      }
    }

    fills.sort((a, b) => a.matchedAt.toNumber() - b.matchedAt.toNumber());
    this._logger.info(`Fetched ${fills.length} fills over ${pages} pages`, {
      types: Object.fromEntries(typeCounts),
    });
    return fills;
  }
}

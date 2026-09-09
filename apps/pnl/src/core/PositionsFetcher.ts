/**
 * Загрузчик позиций с PnL, посчитанным площадкой.
 *
 * @remarks
 * Заменяет прежний `MarketEnricher`, который дотягивал resolved-статус рынка
 * по одному запросу на `conditionId` — только чтобы наша формула могла
 * досчитать `redeem_value`.
 *
 * Теперь этого шага нет вовсе: публичный Data API отдаёт позицию сразу с
 * `realizedPnl`, `avgPrice`, `totalBought` и `curPrice`. Это авторитетный
 * источник — ровно то число, которое показывает сайт, уже с учётом комиссий.
 *
 * **Почему больше не считаем PnL сами.** Прежняя формула воспроизводила
 * комиссию по `feeRateBps` из аутентифицированного эндпоинта. Публичный
 * контур ставку не отдаёт, а подставлять предполагаемую — значит тихо
 * разойтись с реальностью на величину, которую никто не заметит в отчёте.
 * Лучше взять число площадки, чем правдоподобно ошибиться.
 *
 * Ограничение API: ни `listClosedPositions`, ни `listPositions` не принимают
 * период. Отбор по датам делается здесь, после загрузки.
 *
 * @example
 * ```typescript
 * const fetcher = new PositionsFetcher(createPublicClient(), logger);
 * const positions = await fetcher.fetchAll({ wallet, fromTs, toTs });
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { createPublicClient } from '@polymarket/client';
import { money, price, quantity, timestamp } from './vo.js';
import type { PositionPnl } from '../types.js';

/** Узкий порт: два метода из всего клиента. */
export type PositionsClient = Pick<
  ReturnType<typeof createPublicClient>,
  'listClosedPositions' | 'listPositions'
>;

/** Цена, выше которой исход считается выигравшим. */
const WINNING_PRICE = 0.99;

/** Параметры запроса позиций. */
export interface FetchPositionsParams {
  /** Адрес кошелька */
  wallet: string;
  /** Начало периода в секундах Unix */
  fromTs: number;
  /** Конец периода в секундах Unix */
  toTs: number;
  /** Включать ли ещё не закрытые позиции. По умолчанию `false`. */
  includeOpen?: boolean;
}

/**
 * Загружает позиции пользователя с их реализованным PnL.
 */
export class PositionsFetcher {
  /**
   * @param _client - Публичный клиент SDK (`createPublicClient()`)
   * @param _logger - Логгер
   */
  constructor(
    private readonly _client: PositionsClient,
    private readonly _logger: ILogger
  ) {}

  /**
   * Загружает закрытые (и опционально открытые) позиции за период.
   *
   * Алгоритм:
   * 1. Итерируем `listClosedPositions()` — курсор ведёт SDK.
   * 2. Отбираем по `timestamp` в границах периода (API периода не знает).
   * 3. Если запрошено — добавляем открытые позиции из `listPositions()`;
   *    у них нет момента закрытия, поэтому по периоду они не фильтруются.
   *
   * @param params - Кошелёк, границы периода и флаг открытых позиций
   * @returns Позиции, отсортированные по времени закрытия
   * @throws {Error} При сетевом сбое или отказе API
   *
   * @example
   * ```typescript
   * const closed = await fetcher.fetchAll({ wallet, fromTs, toTs });
   * const withOpen = await fetcher.fetchAll({ wallet, fromTs, toTs, includeOpen: true });
   * ```
   */
  async fetchAll(params: FetchPositionsParams): Promise<PositionPnl[]> {
    const fromMs = params.fromTs * 1000;
    const toMs = params.toTs * 1000;

    this._logger.info('Fetching closed positions', { wallet: params.wallet });

    const result: PositionPnl[] = [];
    let scanned = 0;

    for await (const page of this._client.listClosedPositions({ user: params.wallet })) {
      for (const p of page.items) {
        scanned += 1;
        const closedAtMs = Number(p.timestamp);
        if (closedAtMs < fromMs || closedAtMs > toMs) continue;
        result.push({
          conditionId: p.conditionId ?? '',
          title: p.title ?? '',
          outcome: p.outcome ?? '',
          outcomeIndex: p.outcomeIndex ?? 0,
          avgPrice: price(Number(p.avgPrice ?? 0)),
          totalBought: quantity(Number(p.totalBought ?? 0)),
          // Закрытая позиция несёт исход, а не цену: вендорские 1/0 —
          // это выплата, следствие резолюции.
          valuation: { state: 'SETTLED', won: Number(p.curPrice ?? 0) >= WINNING_PRICE },
          realizedPnl: money(Number(p.realizedPnl ?? 0)),
          closed: true,
          closedAt: timestamp(closedAtMs),
          endDate: p.endDate ?? undefined,
        });
      }
    }

    this._logger.info(`Closed positions: ${result.length} in period (${scanned} scanned)`);

    if (params.includeOpen === true) {
      let open = 0;
      for await (const page of this._client.listPositions({ user: params.wallet })) {
        for (const p of page.items) {
          open += 1;
          result.push({
            conditionId: p.conditionId ?? '',
            title: p.title ?? '',
            outcome: p.outcome ?? '',
            outcomeIndex: p.outcomeIndex ?? 0,
            avgPrice: price(Number(p.avgPrice ?? 0)),
            totalBought: quantity(Number(p.totalBought ?? 0)),
            // Открытая позиция ещё торгуется — здесь настоящая котировка.
            valuation: { state: 'OPEN', price: price(Number(p.curPrice ?? 0)) },
            realizedPnl: money(Number(p.realizedPnl ?? 0)),
            closed: false,
            endDate: p.endDate ?? undefined,
          });
        }
      }
      this._logger.info(`Open positions: ${open}`);
    }

      result.sort(
      (a, b) => (a.closedAt?.toNumber() ?? Infinity) - (b.closedAt?.toNumber() ?? Infinity)
    );
    return result;
  }
}

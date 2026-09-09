/**
 * Сборка отчёта PnL из позиций и ленты сделок.
 *
 * @remarks
 * ### Откуда берётся PnL
 * `netPnl` рынка — это `realizedPnl` позиции, как его посчитала площадка.
 * Мы его НЕ пересчитываем. Прежняя версия воспроизводила формулу
 * «выручка от выхода + redemption − стоимость входа» вместе с моделью
 * комиссий по `feeRateBps`; публичный контур ставку не отдаёт, а
 * подставлять предполагаемую — значит разойтись с реальностью незаметно
 * для читателя отчёта.
 *
 * Остальные величины — производные и служат объяснением числа, а не его
 * источником:
 *
 * ```text
 * entryCost    = avgPrice × totalBought        // из позиции
 * sellProceeds = Σ SELL.usdcSize               // из ленты сделок
 * netShares    = Σ BUY.size − Σ SELL.size      // из ленты сделок
 * redeemValue  = netShares × redemptionPrice   // 1/0 после резолюции, котировка до
 * netPnl       = realizedPnl                   // ← авторитет площадки
 * roi          = netPnl / entryCost
 * ```
 *
 * ### Комиссии — измерение, а не модель
 * На публичном пути комиссия берётся **точно**: лента отдаёт `amount` —
 * реально перемещённый USDC, уже за вычетом комиссии, и разница с
 * `size × price` и есть удержанное. Сверено с документированной формулой
 * `size × 0.07 × p × (1 − p)` — совпадение до пятого знака.
 *
 * На аутентифицированном пути `amount` не приходит, поэтому там работает
 * формула по роли: TAKER платит, MAKER не платит никогда.
 *
 * Ставку НЕЛЬЗЯ брать из ответа API: `feeRateBps` в записи сделки приходит
 * `"0"` (поле не заполняется), а `taker_base_fee` рынка равен `1000`, что
 * противоречит и замеру, и правилу «мейкер не платит».
 *
 * ### Сутки отчёта
 * Рынок относится к дню своего **закрытия** (`closedAtMs`), а не первого
 * входа: PnL реализуется в момент выхода или резолюции.
 *
 * @example
 * ```typescript
 * const calculator = new PnlCalculator(logger);
 * const report = calculator.compute({ positions, fills, fromDate, toDate });
 * console.log(report.netPnl);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { Money } from '@polymarket/value-objects';
import { money, ratio, signedQuantity, subMoney, sumMoney } from './vo.js';
import {
  POLYMARKET_CRYPTO_TAKER_FEE_RATE,
  calculatePolymarketTakerFeeNumber,
} from '@polymarket/fill/polymarket-fee';
import type {
  DailyPnl,
  FillRecord,
  MarketPnl,
  NormalizedFill,
  PnlReport,
  PositionPnl,
} from '../types.js';
import { redemptionPrice } from '../types.js';

/** Входные данные расчёта. */
export interface ComputeParams {
  /** Позиции с реализованным PnL */
  positions: PositionPnl[];
  /** Наши сделки за период */
  fills: NormalizedFill[];
  /** Начало периода (ISO-дата) */
  fromDate: string;
  /** Конец периода (ISO-дата) */
  toDate: string;
}

/**
 * Считает отчёт PnL.
 */
export class PnlCalculator {
  /**
   * @param _logger - Логгер
   */
  constructor(private readonly _logger: ILogger) {}

  /**
   * Собирает полный отчёт.
   *
   * @param params - Позиции, сделки и границы периода
   * @returns Отчёт с разбивкой по дням и по рынкам
   *
   * @example
   * ```typescript
   * const report = calculator.compute({ positions, fills, fromDate: '2026-03-01', toDate: '2026-03-31' });
   * ```
   */
  compute(params: ComputeParams): PnlReport {
    const fillsByMarket = new Map<string, NormalizedFill[]>();
    for (const f of params.fills) {
      const list = fillsByMarket.get(f.market);
      if (list === undefined) fillsByMarket.set(f.market, [f]);
      else list.push(f);
    }

    const markets = params.positions.map((position) =>
      this._buildMarketPnl(position, fillsByMarket.get(position.conditionId) ?? [])
    );

    const withoutFills = markets.filter((m) => m.fills.length === 0).length;
    if (withoutFills > 0) {
      // Не ошибка: вход мог случиться до начала запрошенного периода.
      this._logger.debug(`${withoutFills} markets have no fills inside the period`);
    }

    const dailyBreakdown = this._buildDailyBreakdown(markets);
    return this._buildReport(markets, dailyBreakdown, params);
  }

  /**
   * Строит PnL одного рынка.
   *
   * @param position - Позиция с реализованным PnL от площадки
   * @param fills - Наши сделки по этому рынку (могут отсутствовать)
   * @returns Запись рынка для отчёта
   */
  private _buildMarketPnl(position: PositionPnl, fills: NormalizedFill[]): MarketPnl {
    const records = fills
      .slice()
      .sort((a, b) => a.matchedAt.toNumber() - b.matchedAt.toNumber())
      .map((f) => this._toFillRecord(f, position.outcome));

    // Строго: комиссия рынка известна, только если известна у КАЖДОГО fill.
    // Иначе сумма выдавала бы частичное значение за полное.
    const allFeesKnown = records.length > 0 && records.every((r) => r.fee !== null);

    const shares = (side: FillRecord['side']): number =>
      records.reduce((acc, r) => (r.side === side ? acc + r.size.toNumber() : acc), 0);

    const sellProceeds = sumMoney(
      records.filter((r) => r.side === 'SELL').map((r) => r.notional)
    );
    const entryCost = money(position.avgPrice.toNumber() * position.totalBought.toNumber());
    const netShares = signedQuantity(shares('BUY') - shares('SELL'));
    // Отрицательный остаток к выплате не идёт: продали больше, чем держим
    // внутри окна отчёта — значит на резолюцию ничего не осталось.
    const redeemable = netShares.isPositive() ? netShares.toNumber() : 0;
    const redeemValue = money(redeemable * redemptionPrice(position.valuation));
    const netPnl = position.realizedPnl;

    return {
      conditionId: position.conditionId,
      question: position.title,
      outcomeName: position.outcome,
      valuation: position.valuation,
      profitable: netPnl.isPositive(),
      fills: records,
      entryCost,
      sellProceeds,
      netShares,
      redeemValue,
      fees: allFeesKnown
        ? sumMoney(records.map((r) => r.fee).filter((f): f is Money => f !== null))
        : null,
      netPnl,
      roi: ratio(
        entryCost.isPositive() ? netPnl.toNumber() / entryCost.toNumber() : 0
      ),
      // День закрытия, а не первого входа: PnL реализуется на выходе или
      // резолюции. Раньше приоритет был у первой сделки — это расходилось с
      // документированным правилом. У открытой позиции момента закрытия нет,
      // тогда берём последнюю активность; если нет и её — дня у рынка нет, и
      // выдумывать эпоху-0 (1970-01-01 отдельным днём в таблице) нельзя.
      entryDate: this._isoDateIfKnown(
        position.closedAt?.toNumber() ?? records.at(-1)?.matchedAt.toNumber()
      ),
    };
  }

  /**
   * Приводит fill к строке отчёта.
   *
   * @param fill - Сделка из ленты активности
   * @param fallbackOutcome - Имя исхода из позиции, если лента его не дала
   * @returns Строка fills в отчёте
   */
  private _toFillRecord(fill: NormalizedFill, fallbackOutcome: string): FillRecord {
    // Приоритет у измерения: публичная лента отдаёт фактически удержанное.
    // Формула — запасной путь для аутентифицированного пути, где `amount`
    // не приходит. Нет ни измерения, ни роли — величина отсутствует, а не
    // равна нулю.
    const fee = this._resolveFee(fill);
    const matchedAtMs = fill.matchedAt.toNumber();

    return {
      id: fill.transactionHash,
      side: fill.side,
      liquidityRole: fill.liquidityRole ?? 'TAKER',
      outcomeName: fill.outcome ?? fallbackOutcome,
      size: fill.size,
      price: fill.price,
      notional: fill.usdcSize,
      fee,
      cashFlow:
        fill.side === 'BUY' ? subMoney(money(0), fill.usdcSize) : fill.usdcSize,
      matchedAt: fill.matchedAt,
      matchDate: this._isoDate(matchedAtMs),
      matchTime: new Date(matchedAtMs).toISOString().slice(11, 19),
    };
  }

  /**
   * Определяет комиссию по одному fill.
   *
   * @param fill - Наш fill
   * @returns Комиссия, либо `null` если величина недоступна
   *
   * @remarks
   * Приоритет у измерения (`feeUsdc` из публичной ленты). Формула по
   * документированной ставке — запасной путь для аутентифицированного
   * пути, где `amount` не приходит. Мейкер не платит никогда.
   */
  private _resolveFee(fill: NormalizedFill): Money | null {
    if (fill.feeUsdc !== undefined) return fill.feeUsdc;
    if (fill.liquidityRole === undefined) return null;
    if (fill.liquidityRole === 'MAKER') return money(0);
    return money(
      calculatePolymarketTakerFeeNumber(
        fill.size.toNumber(),
        fill.price.toNumber(),
        POLYMARKET_CRYPTO_TAKER_FEE_RATE
      )
    );
  }

  /**
   * Группирует рынки по дню закрытия.
   *
   * @param markets - Все рынки отчёта
   * @returns Дневные срезы, отсортированные по дате
   */
  private _buildDailyBreakdown(markets: MarketPnl[]): DailyPnl[] {
    const byDate = new Map<string, MarketPnl[]>();
    for (const m of markets) {
      // Рынок без даты в дневную разбивку не попадает: отнести его к
      // какому-то дню значит исказить этот день. В итоговых суммах он
      // остаётся — они считаются по `markets`, а не по дням.
      if (m.entryDate === undefined) continue;
      const list = byDate.get(m.entryDate);
      if (list === undefined) byDate.set(m.entryDate, [m]);
      else list.push(m);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayMarkets]) => {
        const entryCost = sumMoney(dayMarkets.map((m) => m.entryCost));
        const netPnl = sumMoney(dayMarkets.map((m) => m.netPnl));
        return {
          date,
          markets: dayMarkets,
          wins: dayMarkets.filter((m) => m.profitable).length,
          losses: dayMarkets.filter((m) => !m.profitable).length,
          entryCost,
          totalReturn: sumMoney([entryCost, netPnl]),
          fees: sumOptionalMoney(dayMarkets.map((m) => m.fees)),
          netPnl,
          roi: ratio(
            entryCost.isPositive() ? netPnl.toNumber() / entryCost.toNumber() : 0
          ),
        };
      });
  }

  /**
   * Сводит дневные срезы в итоговый отчёт.
   *
   * @param markets - Все рынки
   * @param dailyBreakdown - Дневные срезы
   * @param params - Границы периода
   * @returns Готовый отчёт
   */
  private _buildReport(
    markets: MarketPnl[],
    dailyBreakdown: DailyPnl[],
    params: ComputeParams
  ): PnlReport {
    const entryCost = sumMoney(markets.map((m) => m.entryCost));
    const netPnl = sumMoney(markets.map((m) => m.netPnl));

    return {
      fromDate: params.fromDate,
      toDate: params.toDate,
      totalMarkets: markets.length,
      wins: markets.filter((m) => m.profitable).length,
      losses: markets.filter((m) => !m.profitable).length,
      entryCost,
      totalReturn: sumMoney([entryCost, netPnl]),
      fees: sumOptionalMoney(markets.map((m) => m.fees)),
      netPnl,
      roi: ratio(entryCost.isPositive() ? netPnl.toNumber() / entryCost.toNumber() : 0),
      bestDay: dailyBreakdown.reduce<DailyPnl | null>(
        (best, d) => (best === null || d.netPnl.toNumber() > best.netPnl.toNumber() ? d : best),
        null
      ),
      worstDay: dailyBreakdown.reduce<DailyPnl | null>(
        (worst, d) => (worst === null || d.netPnl.toNumber() < worst.netPnl.toNumber() ? d : worst),
        null
      ),
      dailyBreakdown,
      markets,
    };
  }

  /**
   * Форматирует epoch-миллисекунды как ISO-дату.
   *
   * @param ms - Момент времени в миллисекундах
   * @returns Дата вида `YYYY-MM-DD`
   */
  private _isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /**
   * Форматирует момент как ISO-дату, если он известен.
   *
   * @param ms - Момент времени в миллисекундах либо `undefined`
   * @returns Дата вида `YYYY-MM-DD` либо `undefined`
   *
   * @remarks
   * Отдельно от {@link _isoDate}: у fill момент есть всегда, у рынка —
   * не обязательно. Раньше отсутствие подменялось нулём, и рынок попадал в
   * таблицу отдельным днём 1970-01-01.
   *
   * @example
   * ```typescript
   * this._isoDateIfKnown(undefined);  // undefined
   * ```
   */
  private _isoDateIfKnown(ms: number | undefined): string | undefined {
    return ms === undefined ? undefined : this._isoDate(ms);
  }
}

/**
 * Суммирует величины, часть которых может отсутствовать.
 *
 * @param values - Значения, где `null` означает «источник её не даёт»
 * @returns Сумма — только если известны ВСЕ значения; иначе `null`
 *
 * @remarks
 * Отсутствие отличается от нуля: если ставок комиссии не было ни у одного
 * fill, итог — не «$0.00», а «величина недоступна».
 *
 * @example
 * ```typescript
 * sumOptionalMoney([m1, m2]);       // Money
 * sumOptionalMoney([m1, null, m2]); // null — часть неизвестна
 * ```
 */
function sumOptionalMoney(values: Array<Money | null>): Money | null {
  // Достаточно одного неизвестного слагаемого, чтобы итог перестал быть
  // суммой: частичное значение, выданное за полное, хуже честного прочерка.
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return sumMoney(values as Money[]);
}

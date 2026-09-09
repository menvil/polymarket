/**
 * Рендерер подробного отчёта PnL с разбивкой по рынкам и fills.
 *
 * @remarks
 * Для каждого торгового дня выводит блок с рынками.
 * Для каждого рынка — таблицу fills и итог.
 *
 * Пример вывода:
 * ```
 * ━━━━━━━━━━━━━━━━━━━━  2026-03-01  ━━━━━━━━━━━━━━━━━━━━
 *
 * [WIN]  Bitcoin Up or Down — Mar 1, 1:05–1:10 PM ET
 *        Token: UP  →  Resolved: UP ✓  won $1.00
 *   ┌─────────────────────────────────────────────────────┐
 *   │  #  TIME      SIDE   SIZE    PRICE   NOTIONAL   FEE │
 *   │  1  13:04:22  BUY   100.0   0.620    $62.00   $0.02 │
 *   └─────────────────────────────────────────────────────┘
 *   Entry:   100 shares × avg 0.620  = -$62.00
 *   Redeem:  100 shares × $1.00      = +$100.00
 *   Fees:                              -$0.02
 *   ─────────────────────────────────────────────────────
 *   Net PnL:  +$37.98   ROI: +61.3%
 * ```
 *
 * @example
 * ```typescript
 * const renderer = new DetailedRenderer();
 * renderer.render(report);
 * ```
 */

import type { PnlReport, MarketPnl, FillRecord } from '../types.js';
import { hasWon, redemptionPrice } from '../types.js';
import { divMoney, money } from '../core/vo.js';
import { fmtCost, fmtMoney, fmtPnl, fmtRoi, fmtNum, fmtOptional, hline, truncate } from './format.js';

// Ширина рассчитана точно: 2 (отступ) + 3+1+9+1+8+1+6+1+7+1+7+1+9+1+6 (колонки) + 4 (earlyTag)
const FILL_TABLE_WIDTH = 68;
const QUESTION_MAX_LEN = 68;

/**
 * Рендерер подробного отчёта PnL.
 */
export class DetailedRenderer {
  /**
   * Выводит подробный отчёт в stdout.
   *
   * @param report - Полный PnL-отчёт
   */
  render(report: PnlReport): void {
    const lines: string[] = [];

    lines.push('');
    lines.push(`=== Detailed PnL: ${report.fromDate} — ${report.toDate}  [resolved markets only] ===`);

    if (report.totalMarkets === 0) {
      lines.push('');
      lines.push('  No resolved markets found for the given period.');
      lines.push('');
      console.log(lines.join('\n'));
      return;
    }

    for (const day of report.dailyBreakdown) {
      lines.push('');
      lines.push(`${'━'.repeat(22)}  ${day.date}  ${'━'.repeat(22)}`);
      lines.push('');

      for (const market of day.markets) {
        lines.push(...this.renderMarket(market));
        lines.push('');
      }

      // Итог дня
      const winRate = day.markets.length > 0
        ? (day.wins / day.markets.length * 100).toFixed(0)
        : '0';
      lines.push(
        `  ${'─'.repeat(60)}`
      );
      lines.push(
        `  Day: ${day.markets.length} markets │ ${day.wins}W / ${day.losses}L (${winRate}%)` +
        ` │ Entry: ${fmtMoney(day.entryCost)} │ PnL: ${fmtPnl(day.netPnl)} (${fmtRoi(day.roi)})`
      );
    }

    // Итоговый блок
    lines.push('');
    lines.push(`${'━'.repeat(22)}  TOTAL  ${'━'.repeat(22)}`);
    lines.push('');

    const winRate = report.totalMarkets > 0
      ? (report.wins / report.totalMarkets * 100).toFixed(1)
      : '0.0';
    const avgPnl =
      report.totalMarkets > 0 ? divMoney(report.netPnl, report.totalMarkets) : money(0);

    lines.push(`  Markets:      ${report.totalMarkets}  │  Profitable: ${report.wins}  │  Losing: ${report.losses}  │  Win rate: ${winRate}%`);
    lines.push(`  Entry cost:   ${fmtMoney(report.entryCost)}`);
    lines.push(`  Return value: ${fmtMoney(report.totalReturn)}`);
    lines.push(`  Fees paid:    ${fmtOptional(report.fees, (v) => fmtCost(v))}`);
    lines.push(`  Net PnL:      ${fmtPnl(report.netPnl)}   ROI: ${fmtRoi(report.roi)}`);
    lines.push(`  Avg PnL:      ${fmtPnl(avgPnl)} per market`);

    if (report.bestDay) {
      const bd = report.bestDay;
      lines.push(`  Best day:     ${bd.date}  ${fmtPnl(bd.netPnl)}  (${bd.wins}W/${bd.losses}L)`);
    }
    if (report.worstDay && report.worstDay !== report.bestDay) {
      const wd = report.worstDay;
      lines.push(`  Worst day:    ${wd.date}  ${fmtPnl(wd.netPnl)}  (${wd.wins}W/${wd.losses}L)`);
    }

    lines.push('');
    console.log(lines.join('\n'));
  }

  /**
   * Рендерит блок одного рынка: заголовок, таблица fills, итог.
   *
   * @param market - MarketPnl
   * @returns Массив строк для вывода
   */
  private renderMarket(market: MarketPnl): string[] {
    const lines: string[] = [];
    const tag   = market.profitable ? '[WIN] ' : '[LOSS]';
    const settled = market.valuation.state === 'SETTLED';
    const won   = hasWon(market.valuation);
    const check = won ? '✓' : '✗';
    // У открытой позиции исхода ещё нет: показываем котировку, а не
    // выдуманную выплату.
    const outcomeLine = settled
      ? `Resolved: ${market.outcomeName} ${check}  (${won ? 'redeems $1.00' : 'redeems $0.00'})`
      : `Open: ${market.outcomeName}  (mark $${fmtNum(redemptionPrice(market.valuation), 2)})`;

    lines.push(`  ${tag}  ${truncate(market.question, QUESTION_MAX_LEN)}`);
    lines.push(`         Token: ${market.outcomeName}  →  ${outcomeLine}`);

    if (market.fills.length > 0) {
      lines.push(...this.renderFillTable(market.fills));
    }

    lines.push(...this.renderMarketSummary(market));

    return lines;
  }

  /**
   * Рендерит таблицу fills.
   *
   * @param fills - Массив FillRecord
   * @returns Массив строк таблицы
   */
  private renderFillTable(fills: FillRecord[]): string[] {
    const lines: string[] = [];
    const border  = `  ┌${hline(FILL_TABLE_WIDTH, '─')}┐`;
    // В заголовке 4 пробела в конце — заглушка для колонки earlyTag в строках данных
    const header  = `  │  ${'#'.padEnd(3)} ${'TIME'.padEnd(9)} ${'OUTCOME'.padEnd(8)} ${'SIDE'.padEnd(6)} ${'SIZE'.padEnd(7)} ${'PRICE'.padEnd(7)} ${'NOTIONAL'.padEnd(9)} ${'FEE'.padEnd(6)}    │`;
    const divider = `  ├${hline(FILL_TABLE_WIDTH, '─')}┤`;
    const footer  = `  └${hline(FILL_TABLE_WIDTH, '─')}┘`;

    lines.push(border);
    lines.push(header);
    lines.push(divider);

    fills.forEach((fill, idx) => {
      const num      = String(idx + 1).padEnd(3);
      const time     = fill.matchTime.padEnd(9);
      const outcome  = fill.outcomeName.padEnd(8);
      const side     = fill.side.padEnd(6);
      const size     = fmtNum(fill.size.toNumber(), 1).padEnd(7);
      const price    = fmtNum(fill.price.toNumber(), 3).padEnd(7);
      const notional = fmtMoney(fill.notional).padEnd(9);
      const fee      = fmtOptional(fill.fee, fmtMoney).padEnd(6);
      const earlyTag = fill.side === 'SELL' ? ' [!]' : '    ';

      lines.push(`  │  ${num} ${time} ${outcome} ${side} ${size} ${price} ${notional} ${fee}${earlyTag}│`);
    });

    lines.push(footer);
    return lines;
  }

  /**
   * Рендерит итоговый блок рынка: entry, sell proceeds (если есть), redeem, fees, net pnl.
   *
   * @param market - MarketPnl
   * @returns Массив строк итога
   */
  private renderMarketSummary(market: MarketPnl): string[] {
    const lines: string[] = [];

    const buyFills  = market.fills.filter(f => f.side === 'BUY');
    const avgEntry  = avgPrice(buyFills);
    const buyShares = sumShares(buyFills);

    lines.push(
      `  Entry:   ${fmtNum(buyShares, 1)} shares` +
      ` × avg ${fmtNum(avgEntry, 3)}  =  ${fmtCost(market.entryCost)}`
    );

    if (market.sellProceeds.isPositive()) {
      const sellFills = market.fills.filter(f => f.side === 'SELL');
      lines.push(
        `  Sold:    ${fmtNum(sumShares(sellFills), 1)} shares` +
        ` × avg ${fmtNum(avgPrice(sellFills), 3)}  =  ${fmtPnl(market.sellProceeds)}  (early exit)`
      );
    }

    const redeemLabel =
      market.valuation.state === 'SETTLED'
        ? hasWon(market.valuation)
          ? '(token won)'
          : '(token lost)'
        : '(open position)';
    lines.push(
      `  Redeem:  ${fmtNum(market.netShares.isPositive() ? market.netShares.toNumber() : 0, 1)} shares` +
      ` × $${fmtNum(redemptionPrice(market.valuation), 2)}      =  ${fmtPnl(market.redeemValue)}  ${redeemLabel}`
    );

    lines.push(`  Fees:    ${' '.repeat(37)}${fmtOptional(market.fees, (v) => fmtCost(v))}`);
    lines.push(`  ${hline(FILL_TABLE_WIDTH + 2)}`);
    lines.push(`  Net PnL:  ${fmtPnl(market.netPnl)}   ROI: ${fmtRoi(market.roi)}`);

    return lines;
  }
}

/**
 * Средняя цена по набору сделок.
 *
 * @param fills - Сделки одной стороны
 * @returns Средняя цена как число, либо 0 для пустого набора
 *
 * @example
 * ```typescript
 * avgPrice(buyFills);  // 0.635
 * ```
 */
function avgPrice(fills: FillRecord[]): number {
  if (fills.length === 0) return 0;
  return fills.reduce((s, f) => s + f.price.toNumber(), 0) / fills.length;
}

/**
 * Суммарный объём в токенах.
 *
 * @param fills - Сделки
 * @returns Сумма размеров
 *
 * @example
 * ```typescript
 * sumShares(sellFills);  // 5
 * ```
 */
function sumShares(fills: FillRecord[]): number {
  return fills.reduce((s, f) => s + f.size.toNumber(), 0);
}

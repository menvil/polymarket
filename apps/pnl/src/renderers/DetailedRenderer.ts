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
import { fmtMoney, fmtPnl, fmtRoi, fmtNum, hline, truncate } from './format.js';

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
    const avgPnl = report.totalMarkets > 0 ? report.netPnl / report.totalMarkets : 0;

    lines.push(`  Markets:      ${report.totalMarkets}  │  Won: ${report.wins}  │  Lost: ${report.losses}  │  Win rate: ${winRate}%`);
    lines.push(`  Entry cost:   ${fmtMoney(report.entryCost)}`);
    lines.push(`  Return value: ${fmtMoney(report.totalReturn)}`);
    lines.push(`  Fees paid:    ${fmtPnl(-report.fees)}`);
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
    const tag   = market.won ? '[WIN] ' : '[LOSS]';
    const check = market.won ? '✓' : '✗';

    lines.push(`  ${tag}  ${truncate(market.question, QUESTION_MAX_LEN)}`);
    lines.push(
      `         Token: ${market.outcomeName}  →  Resolved: ${market.outcomeName} ${check}` +
      `  (${market.won ? 'won $1.00' : 'lost $0.00'})`
    );

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
      const size     = fmtNum(fill.size, 1).padEnd(7);
      const price    = fmtNum(fill.price, 3).padEnd(7);
      const notional = fmtMoney(fill.notional).padEnd(9);
      const fee      = fmtMoney(fill.fee).padEnd(6);
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
    const avgEntry  = buyFills.length > 0
      ? buyFills.reduce((s, f) => s + f.price, 0) / buyFills.length
      : 0;

    lines.push(
      `  Entry:   ${fmtNum(market.fills.filter(f => f.side === 'BUY').reduce((s, f) => s + f.size, 0), 1)} shares` +
      ` × avg ${fmtNum(avgEntry, 3)}  =  ${fmtPnl(-market.entryCost)}`
    );

    if (market.sellProceeds > 0) {
      const sellFills = market.fills.filter(f => f.side === 'SELL');
      const avgSell   = sellFills.reduce((s, f) => s + f.price, 0) / sellFills.length;
      lines.push(
        `  Sold:    ${fmtNum(sellFills.reduce((s, f) => s + f.size, 0), 1)} shares` +
        ` × avg ${fmtNum(avgSell, 3)}  =  ${fmtPnl(market.sellProceeds)}  (early exit)`
      );
    }

    const redeemLabel = market.won ? '(winner)' : '(loser)';
    lines.push(
      `  Redeem:  ${fmtNum(Math.max(0, market.netShares), 1)} shares` +
      ` × $${fmtNum(market.resolvedPrice, 2)}      =  ${fmtPnl(market.redeemValue)}  ${redeemLabel}`
    );

    lines.push(`  Fees:    ${' '.repeat(37)}${fmtPnl(-market.fees)}`);
    lines.push(`  ${hline(FILL_TABLE_WIDTH + 2)}`);
    lines.push(`  Net PnL:  ${fmtPnl(market.netPnl)}   ROI: ${fmtRoi(market.roi)}`);

    return lines;
  }
}

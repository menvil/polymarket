/**
 * Рендерер краткого дневного отчёта PnL.
 *
 * @remarks
 * Выводит таблицу: по одной строке на каждый торговый день.
 *
 * Пример вывода:
 * ```
 * === PnL Report: 2026-03-01 — 2026-03-31  [resolved markets only] ===
 *
 *   DATE         MKTS   W    L   ENTRY COST    REDEEM     FEES    NET PNL    ROI
 *   ──────────────────────────────────────────────────────────────────────────────
 *   2026-03-01     4    3    1     $142.50    $161.00   -$0.43   +$18.07  +12.7%
 *   ...
 *   ──────────────────────────────────────────────────────────────────────────────
 *   TOTAL         87   67   20   $2,841.30  $3,046.20   -$8.52  +$196.38   +6.9%
 *
 *   Win rate:   77.0%  (67/87)
 *   Avg PnL:    +$2.26 per market
 *   Best day:   2026-03-07  +$34.90  (5W/0L)
 *   Worst day:  2026-03-10  -$47.67  (1W/2L)
 *   Total fees: $8.52
 * ```
 *
 * @example
 * ```typescript
 * const renderer = new DailyRenderer();
 * renderer.render(report);
 * ```
 */

import type { PnlReport, DailyPnl } from '../types.js';
import { fmtMoney, fmtPnl, fmtRoi, hline } from './format.js';

// Ширины колонок
const W = {
  date:      12,
  mkts:       5,
  w:          4,
  l:          4,
  entry:     11,
  redeem:    10,
  fees:       8,
  pnl:       10,
  roi:        8,
};

const ROW_WIDTH = Object.values(W).reduce((s, v) => s + v + 1, 0);

/**
 * Рендерер краткого отчёта по дням.
 */
export class DailyRenderer {
  /**
   * Выводит дневной отчёт в stdout.
   *
   * @param report - Полный PnL-отчёт
   */
  render(report: PnlReport): void {
    const lines: string[] = [];

    lines.push('');
    lines.push(`=== PnL Report: ${report.fromDate} — ${report.toDate}  [resolved markets only] ===`);
    lines.push('');

    if (report.totalMarkets === 0) {
      lines.push('  No resolved markets found for the given period.');
      lines.push('');
      console.log(lines.join('\n'));
      return;
    }

    // Заголовок таблицы
    lines.push(this.header());
    lines.push('  ' + hline(ROW_WIDTH));

    // Строки по дням
    for (const day of report.dailyBreakdown) {
      lines.push(this.dayRow(day));
    }

    // Итог
    lines.push('  ' + hline(ROW_WIDTH));
    lines.push(this.totalRow(report));
    lines.push('');

    // Статистика
    const winRate = report.totalMarkets > 0
      ? (report.wins / report.totalMarkets * 100).toFixed(1)
      : '0.0';
    const avgPnl = report.totalMarkets > 0
      ? report.netPnl / report.totalMarkets
      : 0;

    lines.push(`  Win rate:   ${winRate}%  (${report.wins}/${report.totalMarkets})`);
    lines.push(`  Avg PnL:    ${fmtPnl(avgPnl)} per market`);

    if (report.bestDay) {
      const bd = report.bestDay;
      lines.push(`  Best day:   ${bd.date}  ${fmtPnl(bd.netPnl)}  (${bd.wins}W/${bd.losses}L)`);
    }
    if (report.worstDay && report.worstDay !== report.bestDay) {
      const wd = report.worstDay;
      lines.push(`  Worst day:  ${wd.date}  ${fmtPnl(wd.netPnl)}  (${wd.wins}W/${wd.losses}L)`);
    }

    lines.push(`  Total fees: ${fmtMoney(report.fees)}`);
    lines.push('');

    console.log(lines.join('\n'));
  }

  /**
   * Строит строку заголовка таблицы.
   */
  private header(): string {
    return [
      '  ',
      'DATE'.padEnd(W.date),
      'MKTS'.padStart(W.mkts),
      'W'.padStart(W.w),
      'L'.padStart(W.l),
      'ENTRY COST'.padStart(W.entry),
      'REDEEM'.padStart(W.redeem),
      'FEES'.padStart(W.fees),
      'NET PNL'.padStart(W.pnl),
      'ROI'.padStart(W.roi),
    ].join(' ');
  }

  /**
   * Строит строку данных для одного дня.
   *
   * @param day - DailyPnl
   * @returns Форматированная строка
   */
  private dayRow(day: DailyPnl): string {
    return [
      '  ',
      day.date.padEnd(W.date),
      String(day.markets.length).padStart(W.mkts),
      String(day.wins).padStart(W.w),
      String(day.losses).padStart(W.l),
      fmtMoney(day.entryCost).padStart(W.entry),
      fmtMoney(day.totalReturn).padStart(W.redeem),
      fmtPnl(-day.fees).padStart(W.fees),
      fmtPnl(day.netPnl).padStart(W.pnl),
      fmtRoi(day.roi).padStart(W.roi),
    ].join(' ');
  }

  /**
   * Строит итоговую строку таблицы.
   *
   * @param report - PnlReport
   * @returns Форматированная строка
   */
  private totalRow(report: PnlReport): string {
    return [
      '  ',
      'TOTAL'.padEnd(W.date),
      String(report.totalMarkets).padStart(W.mkts),
      String(report.wins).padStart(W.w),
      String(report.losses).padStart(W.l),
      fmtMoney(report.entryCost).padStart(W.entry),
      fmtMoney(report.totalReturn).padStart(W.redeem),
      fmtPnl(-report.fees).padStart(W.fees),
      fmtPnl(report.netPnl).padStart(W.pnl),
      fmtRoi(report.roi).padStart(W.roi),
    ].join(' ');
  }
}

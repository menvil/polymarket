/**
 * Стратегия следования за моментумом.
 *
 * @remarks
 * ### Алгоритм (gather → decide → toIntents):
 *
 * **gather**: Считывает tradeTape, topOfBook, позицию и баланс.
 * Вычисляет buyRatio = buyVolume / totalVolume из последних N сделок.
 *
 * **decide**:
 * - buyRatio > entryThreshold И нет позиции → ENTER (BUY)
 * - buyRatio < exitThreshold И есть позиция → EXIT (SELL)
 * - Иначе → HOLD (нет действий)
 *
 * **toIntents**: Конвертирует MomentumAction в StrategyIntent[].
 *
 * @example
 * ```typescript
 * const momentum = new MomentumStrategy({
 *   entryThreshold: new Decimal('0.65'),
 *   exitThreshold: new Decimal('0.40'),
 *   orderSize: new Decimal('5'),
 * });
 * scheduler.register({ strategy: momentum, instrumentId, asset, accountId, market });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Конфигурация ─────────────────────────────────────────────────────────────

/**
 * Параметры MomentumStrategy.
 *
 * @param entryThreshold - Порог buyRatio для входа в позицию (0–1)
 * @param exitThreshold - Порог buyRatio для выхода из позиции (0–1)
 * @param orderSize - Размер ордера (в токенах)
 */
export interface MomentumStrategyConfig {
  readonly entryThreshold: Decimal;
  readonly exitThreshold: Decimal;
  readonly orderSize: Decimal;
}

// ── Типы gather/decide ──────────────────────────────────────────────────────

/** Данные, собранные из snapshot */
export interface MomentumData {
  readonly buyRatio: Decimal;
  readonly bestAsk: Decimal | undefined;
  readonly bestBid: Decimal | undefined;
  readonly positionQty: Decimal;
  readonly availableBalance: Decimal;
}

/** Действие стратегии */
export type MomentumAction =
  | { readonly type: 'ENTER'; readonly price: Decimal; readonly size: Decimal }
  | { readonly type: 'EXIT'; readonly price: Decimal; readonly size: Decimal };

// ── Реализация ──────────────────────────────────────────────────────────────

export class MomentumStrategy extends BaseStrategy<MomentumData, MomentumAction> {
  public readonly id: string;
  public readonly name = 'MomentumStrategy';

  private readonly _config: MomentumStrategyConfig;

  /**
   * @param config - Параметры стратегии
   * @param strategyId - Уникальный идентификатор экземпляра (по умолчанию 'momentum-1')
   */
  constructor(config: MomentumStrategyConfig, strategyId = 'momentum-1') {
    super();
    this._config = config;
    this.id = strategyId;
  }

  /**
   * Считывает данные из snapshot.
   *
   * @param snapshot - Readonly snapshot текущего состояния
   * @returns MomentumData или undefined если tradeTape пуст
   *
   * @remarks
   * Вычисляет buyRatio из TradeTape. Если сделок нет — возвращает undefined
   * (стратегия пропустит тик, так как нет данных для принятия решений).
   */
  protected gather(snapshot: StrategySnapshot): MomentumData | undefined {
    const tape = snapshot.tradeTape;
    if (!tape) return undefined;

    const trades = tape.getAll();
    if (trades.length === 0) return undefined;

    // Считаем buyRatio = сумма(buyVolume) / сумма(totalVolume)
    let buyVolume = new Decimal(0);
    let totalVolume = new Decimal(0);

    for (const trade of trades) {
      const size = trade.size.value();
      totalVolume = totalVolume.plus(size);
      if (String(trade.side) === 'BUY') {
        buyVolume = buyVolume.plus(size);
      }
    }

    const buyRatio = totalVolume.isZero() ? new Decimal('0.5') : buyVolume.div(totalVolume);

    const tob = snapshot.topOfBook;
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    return {
      buyRatio,
      bestAsk: tob?.bestAsk?.value(),
      bestBid: tob?.bestBid?.value(),
      positionQty,
      availableBalance,
    };
  }

  /**
   * Логика принятия решений на основе momentum-сигнала.
   *
   * @param data - Данные из gather
   * @param _reasons - Причины пересчёта (не используются)
   * @returns Массив действий
   *
   * @remarks
   * - ENTER: buyRatio > entryThreshold → покупаем (моментум вверх)
   * - EXIT: buyRatio < exitThreshold → продаём (моментум вниз)
   * - HOLD: между порогами → ничего не делаем
   */
  protected decide(data: MomentumData, _reasons: ReadonlySet<TriggerReason>): MomentumAction[] {
    const actions: MomentumAction[] = [];

    // ENTER: сильный buy-momentum и нет позиции
    if (data.buyRatio.gt(this._config.entryThreshold) && data.positionQty.isZero()) {
      if (data.bestAsk !== undefined) {
        actions.push({
          type: 'ENTER',
          price: data.bestAsk,
          size: this._config.orderSize,
        });
      }
      return actions;
    }

    // EXIT: слабый buy-momentum и есть позиция
    if (data.buyRatio.lt(this._config.exitThreshold) && data.positionQty.gt(0)) {
      if (data.bestBid !== undefined) {
        const exitSize = Decimal.min(data.positionQty, this._config.orderSize);
        actions.push({
          type: 'EXIT',
          price: data.bestBid,
          size: exitSize,
        });
      }
      return actions;
    }

    return actions;
  }

  /**
   * Преобразует доменные действия в StrategyIntent[].
   *
   * @param actions - Массив MomentumAction из decide()
   * @returns Массив StrategyIntent для ExecutionEngine
   */
  protected toIntents(actions: MomentumAction[]): StrategyIntent[] {
    return actions.map((action) => {
      switch (action.type) {
        case 'ENTER':
          return {
            type: 'PLACE' as const,
            side: 'BUY' as const,
            price: Price.of(action.price),
            size: Quantity.of(action.size),
          };
        case 'EXIT':
          return {
            type: 'PLACE' as const,
            side: 'SELL' as const,
            price: Price.of(action.price),
            size: Quantity.of(action.size),
          };
      }
    });
  }
}

/**
 * Простая стратегия маркет-мейкинга.
 *
 * @remarks
 * ### Алгоритм (gather → decide → toIntents):
 *
 * **gather**: Считывает topOfBook, открытые ордера, позицию и доступный баланс.
 *
 * **decide**:
 * 1. Если рынок близок к экспирации (`timeToExpiry < exitThresholdMs`)
 *    → CANCEL_ALL + SELL всю позицию.
 * 2. Если спред < minSpread → CANCEL_ALL (невыгодно котировать).
 * 3. Иначе → котировки bid/ask с offset от mid-price.
 *
 * **toIntents**: Конвертирует MakerAction в StrategyIntent[].
 *
 * @example
 * ```typescript
 * const mm = new SimpleMarketMaker({
 *   spreadOffset: new Decimal('0.02'),
 *   minSpread: new Decimal('0.01'),
 *   orderSize: new Decimal('10'),
 *   exitThresholdMs: 60_000,
 * });
 * scheduler.register({ strategy: mm, instrumentId, asset, accountId, market });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Конфигурация ─────────────────────────────────────────────────────────────

/**
 * Параметры SimpleMarketMaker.
 *
 * @param spreadOffset - Отступ от mid-price для bid/ask (в единицах цены)
 * @param minSpread - Минимальный спред для котирования (ниже — CANCEL_ALL)
 * @param orderSize - Размер каждого ордера (в токенах)
 * @param exitThresholdMs - Порог экспирации для выхода из позиции (ms)
 */
export interface SimpleMarketMakerConfig {
  readonly spreadOffset: Decimal;
  readonly minSpread: Decimal;
  readonly orderSize: Decimal;
  readonly exitThresholdMs: number;
}

// ── Типы gather/decide ──────────────────────────────────────────────────────

/** Данные, собранные из snapshot для принятия решений */
export interface MakerData {
  readonly bestBid: Decimal | undefined;
  readonly bestAsk: Decimal | undefined;
  readonly spread: Decimal | undefined;
  readonly positionQty: Decimal;
  readonly availableBalance: Decimal;
  readonly timeToExpiryMs: number;
  readonly openOrderCount: number;
}

/** Действие, которое стратегия хочет выполнить */
export type MakerAction =
  | { readonly type: 'CANCEL_ALL' }
  | { readonly type: 'SELL_EXIT'; readonly size: Decimal }
  | { readonly type: 'QUOTE'; readonly bidPrice: Decimal; readonly askPrice: Decimal; readonly size: Decimal };

// ── Реализация ──────────────────────────────────────────────────────────────

export class SimpleMarketMaker extends BaseStrategy<MakerData, MakerAction> {
  public readonly id: string;
  public readonly name = 'SimpleMarketMaker';

  private readonly _config: SimpleMarketMakerConfig;

  /**
   * @param config - Параметры маркет-мейкера
   * @param strategyId - Уникальный идентификатор экземпляра (по умолчанию 'smm-1')
   */
  constructor(config: SimpleMarketMakerConfig, strategyId = 'smm-1') {
    super();
    this._config = config;
    this.id = strategyId;
  }

  /**
   * Считывает из snapshot данные, необходимые для принятия решений.
   *
   * @param snapshot - Readonly snapshot текущего состояния
   * @returns MakerData или undefined если topOfBook отсутствует
   */
  protected gather(snapshot: StrategySnapshot): MakerData | undefined {
    const tob = snapshot.topOfBook;
    if (!tob) return undefined;

    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    const expirationMs = snapshot.market.expirationMs;
    const timeToExpiryMs = expirationMs - snapshot.nowMs;

    return {
      bestBid: tob.bestBid?.value(),
      bestAsk: tob.bestAsk?.value(),
      spread: tob.spread?.value(),
      positionQty,
      availableBalance,
      timeToExpiryMs,
      openOrderCount: snapshot.openOrders.length,
    };
  }

  /**
   * Логика принятия решений.
   *
   * @param data - Данные из gather
   * @param _reasons - Причины пересчёта (не используются в этой стратегии)
   * @returns Массив действий для исполнения
   *
   * @remarks
   * Приоритет решений:
   * 1. Близко к экспирации → выход из позиции
   * 2. Спред слишком узкий → отмена всех ордеров
   * 3. Нет bid/ask → нет действий (ждём данных)
   * 4. Нормальный режим → выставляем котировки
   */
  protected decide(data: MakerData, _reasons: ReadonlySet<TriggerReason>): MakerAction[] {
    const actions: MakerAction[] = [];

    // 1. Близко к экспирации → экстренный выход
    if (data.timeToExpiryMs < this._config.exitThresholdMs) {
      actions.push({ type: 'CANCEL_ALL' });
      if (data.positionQty.gt(0)) {
        actions.push({ type: 'SELL_EXIT', size: data.positionQty });
      }
      return actions;
    }

    // 2. Спред слишком узкий → невыгодно котировать
    if (data.spread !== undefined && data.spread.lt(this._config.minSpread)) {
      actions.push({ type: 'CANCEL_ALL' });
      return actions;
    }

    // 3. Нет данных о ценах → ничего не делаем
    if (data.bestBid === undefined || data.bestAsk === undefined) {
      return actions;
    }

    // 4. Нормальный режим: рассчитываем mid и котировки
    const mid = data.bestBid.plus(data.bestAsk).div(2);
    const bidPrice = mid.minus(this._config.spreadOffset);
    const askPrice = mid.plus(this._config.spreadOffset);

    // Не котируем если цена вне допустимых границ [0.01, 0.99]
    if (bidPrice.lt('0.01') || askPrice.gt('0.99')) {
      return actions;
    }

    // Отменяем старые ордера перед выставлением новых
    if (data.openOrderCount > 0) {
      actions.push({ type: 'CANCEL_ALL' });
    }

    actions.push({
      type: 'QUOTE',
      bidPrice,
      askPrice,
      size: this._config.orderSize,
    });

    return actions;
  }

  /**
   * Преобразует доменные действия в StrategyIntent[].
   *
   * @param actions - Массив MakerAction из decide()
   * @returns Массив StrategyIntent для ExecutionEngine
   */
  protected toIntents(actions: MakerAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'CANCEL_ALL':
          intents.push({ type: 'CANCEL_ALL' });
          break;

        case 'SELL_EXIT':
          intents.push({
            type: 'PLACE',
            side: 'SELL' as const,
            price: Price.of(new Decimal('0.01')),
            size: Quantity.of(action.size),
          });
          break;

        case 'QUOTE':
          intents.push({
            type: 'PLACE',
            side: 'BUY' as const,
            price: Price.of(action.bidPrice),
            size: Quantity.of(action.size),
          });
          intents.push({
            type: 'PLACE',
            side: 'SELL' as const,
            price: Price.of(action.askPrice),
            size: Quantity.of(action.size),
          });
          break;
      }
    }

    return intents;
  }
}

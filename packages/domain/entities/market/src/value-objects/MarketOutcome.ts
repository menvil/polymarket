/**
 * MarketOutcome — один исход наблюдаемого внешнего рынка
 *
 * @remarks
 * Исход описывается тремя вещами и только ими:
 * - позицией в наборе исходов ({@link OutcomeIndex});
 * - человекочитаемой меткой (`'Up'` / `'Down'`, `'Yes'` / `'No'`);
 * - **единственной** canonical identity инструмента ({@link InstrumentId}).
 *
 * ### Один outcome → одна canonical instrument identity
 * Раньше исход нёс `OutcomeToken` — on-chain identity (`conditionRef` +
 * `outcomeKey` → `AssetId`). Это делало Domain Market пригодным только для
 * on-chain площадок: `OutcomeToken` по контракту существует лишь для
 * tokenized positions (см. `@polymarket/value-objects/outcome-token`),
 * а Kalshi и любая off-chain площадка исходов-токенов не имеют.
 *
 * Весь новый market-data контур (`Orderbook`, `TradeTape`, semantic-адаптеры,
 * `StrategySnapshot`, `Portfolio.getPosition`) адресует исход по
 * `InstrumentId`. Держать рядом обязательные `token` и `instrumentId` означало
 * бы две параллельные canonical identity одной сущности — ровно то, что
 * запрещено доменной моделью. Поэтому canonical owner identity исхода —
 * `InstrumentId`, а `OutcomeToken` остаётся тем, чем он и является:
 * on-chain-специфичным VO расчётного контура (его продолжает использовать
 * `TokenBalance`).
 *
 * @example
 * ```typescript
 * import { unsafeInstrumentId } from '@polymarket/ids';
 *
 * const up: MarketOutcome = {
 *   index: 0,
 *   label: 'Up',
 *   instrumentId: unsafeInstrumentId('7147...'),
 * };
 * ```
 */

import type { InstrumentId } from '@polymarket/ids';
import type { OutcomeIndex } from './MarketState.js';

/**
 * MarketOutcome — исход бинарного рынка
 *
 * @remarks
 * Чистый data-объект без методов: сравнение исходов выполняется по
 * `instrumentId`, а вся доменная логика живёт в {@link Market}.
 */
export interface MarketOutcome {
  /** Позиция в наборе исходов рынка (0 — первый, 1 — второй) */
  readonly index: OutcomeIndex;
  /** Человекочитаемая метка исхода (`'Up'`, `'Down'`, `'Yes'`, `'No'`) */
  readonly label: string;
  /** Единственная canonical identity инструмента этого исхода */
  readonly instrumentId: InstrumentId;
}

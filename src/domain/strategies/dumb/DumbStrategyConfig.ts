/**
 * DumbStrategyConfig - конфигурация для DumbStrategy
 *
 * @remarks
 * Минимальная конфигурация для самой тупой стратегии.
 *
 * Стратегия:
 * 1. Размещает первый ордер (side = initialSide)
 * 2. Ждёт исполнения (OrderFilled)
 * 3. Размещает reverse order (противоположная сторона)
 * 4. Повторяет шаги 2-3
 *
 * Ограничения:
 * - Один активный ордер за раз
 * - Фиксированные цены (buyPrice, sellPrice)
 * - Фиксированный размер (size)
 * - NO risk management
 * - NO position tracking
 * - NO market signals
 *
 * @example
 * ```typescript
 * const config: DumbStrategyConfig = {
 *   id: 'dumb-btc-1',
 *   tokenId: '21742633143463906290569050155826241533067272736897614950488156847949938836455',
 *   initialSide: 'buy',
 *   buyPrice: 0.52,
 *   sellPrice: 0.53,
 *   size: 100,
 * };
 *
 * // Поведение:
 * // 1. StrategyStarted → place buy order @ 0.52
 * // 2. OrderFilled → place sell order @ 0.53
 * // 3. OrderFilled → place buy order @ 0.52
 * // ... цикл
 * ```
 */

/**
 * DumbStrategyConfig interface
 *
 * @property id - Unique strategy identifier
 * @property tokenId - Market token ID (Polymarket)
 * @property initialSide - Первая сторона ордера ('buy' или 'sell')
 * @property buyPrice - Цена для buy orders
 * @property sellPrice - Цена для sell orders
 * @property size - Размер ордера (количество)
 *
 * @remarks
 * Config = read-only (стратегия не модифицирует config).
 * Config используется FSM reducer для восстановления state из events.
 *
 * Валидация config (не входит в scope DumbStrategy v4):
 * - buyPrice < sellPrice (иначе арбитраж не имеет смысла)
 * - size > 0
 * - tokenId валиден для Polymarket
 *
 * @example
 * ```typescript
 * // Пример валидного config:
 * const config: DumbStrategyConfig = {
 *   id: 'dumb-btc-1',
 *   tokenId: '21742633143463906290569050155826241533067272736897614950488156847949938836455',
 *   initialSide: 'buy',
 *   buyPrice: 0.52, // ✅ buyPrice < sellPrice
 *   sellPrice: 0.53,
 *   size: 100, // ✅ size > 0
 * };
 *
 * // Пример невалидного config (но валидация НЕ в scope):
 * const invalidConfig: DumbStrategyConfig = {
 *   id: 'dumb-btc-2',
 *   tokenId: '...',
 *   initialSide: 'buy',
 *   buyPrice: 0.55, // ❌ buyPrice > sellPrice (убыточно)
 *   sellPrice: 0.53,
 *   size: -10, // ❌ size < 0 (невалидно)
 * };
 * ```
 */
export interface DumbStrategyConfig {
  /**
   * Strategy ID (unique identifier)
   *
   * @remarks
   * Используется для:
   * - Logging
   * - Telemetry
   * - Идентификация в EventBus
   *
   * Должен быть уникальным в рамках приложения.
   */
  readonly id: string;

  /**
   * Market token ID (Polymarket)
   *
   * @remarks
   * Polymarket token ID = 256-bit uint (в виде строки).
   * Идентифицирует рынок (market).
   *
   * Пример: '21742633143463906290569050155826241533067272736897614950488156847949938836455'
   */
  readonly tokenId: string;

  /**
   * Initial side ('buy' или 'sell')
   *
   * @remarks
   * Определяет первую сторону ордера.
   *
   * - 'buy': первый ордер = buy @ buyPrice
   * - 'sell': первый ордер = sell @ sellPrice
   *
   * После исполнения первого ордера стратегия размещает reverse order.
   */
  readonly initialSide: 'buy' | 'sell';

  /**
   * Buy price (лимитная цена для buy orders)
   *
   * @remarks
   * Цена в диапазоне [0, 1] (Polymarket normalized price).
   *
   * Обычно: buyPrice < sellPrice (иначе арбитраж убыточен).
   *
   * @example
   * buyPrice: 0.52 // купить по 0.52 или дешевле
   */
  readonly buyPrice: number;

  /**
   * Sell price (лимитная цена для sell orders)
   *
   * @remarks
   * Цена в диапазоне [0, 1] (Polymarket normalized price).
   *
   * Обычно: sellPrice > buyPrice (иначе арбитраж убыточен).
   *
   * @example
   * sellPrice: 0.53 // продать по 0.53 или дороже
   */
  readonly sellPrice: number;

  /**
   * Order size (количество)
   *
   * @remarks
   * Размер ордера в единицах токена.
   *
   * Должен быть > 0 и соответствовать минимальному размеру биржи.
   *
   * @example
   * size: 100 // разместить ордер на 100 единиц
   */
  readonly size: number;

  /**
   * Outcome name (e.g., "Up", "Down", "Yes", "No")
   *
   * @remarks
   * v5.5: Имя outcome для отображения в логах.
   * Используется в VIRTUAL FILL логах и fill history.
   *
   * @example
   * outcomeName: 'Up' // торгуем токен "Up"
   */
  readonly outcomeName?: string;
}

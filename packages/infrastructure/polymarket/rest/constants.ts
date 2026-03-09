/**
 * Константы для Polymarket REST слоя
 *
 * @remarks
 * Используются в OrderBuilder, BalanceMapper и политиках.
 * Centralizes magic numbers for USDC precision and price ticks.
 */

/**
 * USDC мультипликатор для перевода в минимальные единицы (10^6)
 *
 * @remarks
 * Polymarket API оперирует балансами и суммами в minimum units.
 * USDC имеет 6 знаков после запятой, поэтому:
 * 1 USDC = 1_000_000 minimum units
 */
export const USDC_MULTIPLIER = 1_000_000;

/**
 * Количество знаков после запятой USDC
 */
export const USDC_DECIMALS = 6;

/**
 * Дефолтный шаг цены (price tick) для большинства рынков Polymarket
 *
 * @remarks
 * Если market constraints не предоставлены явно, используется этот дефолт.
 * Наиболее распространённый tick на Polymarket.
 * Всегда используй явный priceTick из market constraints в production.
 */
export const DEFAULT_PRICE_TICK = 0.01;

/**
 * Максимальное количество знаков после запятой для SELL-ордеров
 *
 * @remarks
 * Polymarket API требует makerAmount для SELL-ордеров с максимум 2 знаками.
 */
export const MAX_SELL_SIZE_DECIMALS = 2;

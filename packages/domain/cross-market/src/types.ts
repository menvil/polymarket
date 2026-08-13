/**
 * Типы для кросс-маркетного арбитража
 *
 * @remarks
 * Определяет структуры данных для матчинга рынков, обнаружения расхождений
 * и генерации арбитражных сигналов между рынками разной длительности.
 *
 * ### Ключевые понятия:
 * - **Recurrence** — длительность рынка: `5m`, `15m`, `hourly`, `daily`
 * - **Easy leg** — рынок с lower strike (ниже priceToBeat, выше P(Up))
 * - **Hard leg** — рынок с higher strike (выше priceToBeat, ниже P(Up))
 * - **Divergence** — ситуация когда `hard_Up_bid > easy_Up_ask` (нарушение вероятностей)
 *
 * @packageDocumentation
 */

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { InstrumentId } from '@polymarket/ids';
import { Ratio } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';

// ── Recurrence (длительность рынка) ─────────────────────────────────────────

/**
 * Тип повторяемости (длительности) рынка.
 *
 * @remarks
 * Определяет временной интервал рынка на Polymarket.
 * Recurrence используется для матчинга рынков с пересекающимся expiry.
 * Safe easy/hard assignment перед торговлей определяется по strike.
 */
export type Recurrence = '5m' | '15m' | 'hourly' | 'daily';

/**
 * Ранг рекуррентности: чем меньше число, тем длиннее duration.
 *
 * @remarks
 * Используется для предварительного упорядочивания пары по duration.
 * Перед детекцией торговые legs нормализуются по strike.
 */
export const RECURRENCE_RANK: Record<Recurrence, number> = {
  daily: 0,
  hourly: 1,
  '15m': 2,
  '5m': 3,
} as const;

/**
 * Длительность overlap-окна в миллисекундах для каждого типа пары.
 *
 * @remarks
 * Overlap — время, в течение которого оба рынка одновременно активны
 * и имеют ликвидные ордербуки.
 */
export const OVERLAP_DURATION_MS: Record<string, number> = {
  '5m-15m': 5 * 60 * 1000,
  '5m-hourly': 5 * 60 * 1000,
  '15m-hourly': 15 * 60 * 1000,
  '5m-daily': 5 * 60 * 1000,
  '15m-daily': 15 * 60 * 1000,
  'hourly-daily': 60 * 60 * 1000,
} as const;

// ── Информация о рынке ─────────────────────────────────────────────────────

/**
 * Метаданные рынка, извлечённые из ticker и meta-строки снапшота.
 *
 * @remarks
 * Парсится из ticker формата `btc-updown-15m-1774231200`
 * и meta-строки NDJSON файла.
 *
 * @example
 * ```typescript
 * const info: MarketInfo = {
 *   asset: 'BTC',
 *   recurrence: '15m',
 *   endDate: '2026-03-23T02:15:00Z',
 *   endEpochMs: Timestamp.of(new Decimal(1774231200000)),
 *   instrumentId: asInstrumentId('108038...'),
 *   filePath: '/snapshots/2026-03-23/Bitcoin_Up_or_Down...jsonl.gz',
 * };
 * ```
 */
export interface MarketInfo {
  /** Актив: BTC, ETH, SOL, XRP */
  readonly asset: string;
  /** Длительность рынка */
  readonly recurrence: Recurrence;
  /**
   * ISO строка даты окончания.
   *
   * @remarks
   * Дуальное представление наравне с `endEpochMs` — используется как ключ группировки по
   * равенству (`` `${asset}:${endDate}` `` в `MarketPairMatcher.findPairs()`), не в
   * арифметике. Не выводится из `endEpochMs` заново, чтобы избежать расхождений
   * форматирования при round-trip через `Timestamp`.
   */
  readonly endDate: string;
  /** ISO строка даты старта, если известна (см. `endDate` про дуальное представление) */
  readonly startDate?: string;
  /** Timestamp даты старта, если известна */
  readonly startEpochMs?: Timestamp;
  /** Timestamp даты окончания */
  readonly endEpochMs: Timestamp;
  /** ID токена Up-outcome (tokenIds[0]) */
  readonly instrumentId: InstrumentId;
  /** ID токена Down-outcome (tokenIds[1]), если известен */
  readonly downInstrumentId?: InstrumentId;
  /** Путь к файлу снапшота */
  readonly filePath: string;
  /** Сырой ticker из Gamma API */
  readonly ticker?: string;
  /**
   * Strike-цена (priceToBeat) из eventMetadata.
   *
   * @remarks
   * Цена актива на момент старта рынка. Up-токен выигрывает если цена на endDate >= priceToBeat.
   * Два рынка одной пары (5m + 15m) имеют **разные** strike'ы из-за разного startTime.
   * Safe-комбинация: lowerStrike_Up + higherStrike_Down.
   *
   * Остаётся `number`, не `Price`: это спот-цена базового крипто-актива в долларах
   * (например ~78237 для BTC), а не вероятностная цена prediction market — `Price` VO
   * ограничен диапазоном `[0.0001, 0.9999]` и не подходит. Готового VO для произвольной
   * USD-цены крипто-актива в кодовой базе пока нет (тот же открытый вопрос — у аналогичных
   * полей `CryptoMarketDataStore`/`CryptoSignalRegistry`, форма решается согласованно там).
   */
  readonly priceToBeat?: number;
  /** Final settlement price из eventMetadata, если snapshot уже обогащён (см. `priceToBeat` про диапазон). */
  readonly finalPrice?: number;
}

// ── Пара рынков ─────────────────────────────────────────────────────────────

/**
 * Пара рынков для арбитража.
 *
 * @remarks
 * Два рынка с одинаковым `(asset, endDate)`, но разной `recurrence`.
 * Easy = lower strike (lower priceToBeat, higher P(Up)).
 * Hard = higher strike (higher priceToBeat, lower P(Up)).
 *
 * Математическое ограничение: `P(easy_Up) >= P(hard_Up)` (всегда).
 * Если рынок нарушает это — арбитражная возможность.
 */
export interface MarketPair {
  /** Рынок easy Up: lower strike после нормализации, либо longer duration до неё */
  readonly easy: MarketInfo;
  /** Рынок hard Up: higher strike после нормализации, либо shorter duration до неё */
  readonly hard: MarketInfo;
  /** Тип пары: '5m-15m', '5m-hourly', '15m-hourly' */
  readonly pairType: string;
  /** Длительность overlap-окна в мс */
  readonly overlapMs: number;
}

// ── Уровень стакана (упрощённый) ────────────────────────────────────────────

/**
 * Уровень стакана в числовом формате для вычислений.
 *
 * @remarks
 * Упрощённая версия PriceLevel из старого @polymarket/order-book (пакет физически
 * удалён в Этапе 10d плана миграции — здесь сохранена только концептуальная связь).
 * Используется внутри DivergenceDetector и DepthAnalyzer
 * для быстрых вычислений без overhead Value Objects.
 */
export interface NumericLevel {
  /** Цена уровня (0..1 для prediction markets) */
  readonly price: number;
  /** Размер (количество контрактов) */
  readonly size: number;
}

// ── Снапшот стакана (упрощённый) ────────────────────────────────────────────

/**
 * Упрощённый снапшот стакана для арбитражного анализа.
 *
 * @remarks
 * Bids отсортированы по убыванию (best bid = первый).
 * Asks отсортированы по возрастанию (best ask = первый).
 */
export interface SimpleBook {
  /** Уровни покупки, отсортированы по убыванию цены (best = [0]) */
  readonly bids: readonly NumericLevel[];
  /** Уровни продажи, отсортированы по возрастанию цены (best = [0]) */
  readonly asks: readonly NumericLevel[];
  /** Timestamp снапшота (epoch ms) */
  readonly timestampMs: number;
}

// ── Результат анализа глубины ───────────────────────────────────────────────

/**
 * Профиль исполнения на одном уровне глубины.
 *
 * @remarks
 * Содержит кумулятивные метрики при исполнении до данного уровня включительно.
 */
export interface DepthLevel {
  /** Номер уровня глубины (1-based) */
  readonly depth: number;
  /** VWAP hard_Up bid по уровням 1..depth */
  readonly hardUpVwap: number;
  /** VWAP easy_Up ask по уровням 1..depth */
  readonly easyUpVwap: number;
  /** Спред: hardUpVwap - easyUpVwap */
  readonly spread: number;
  /** Исполняемый размер: min(cumHardSize, cumEasySize) */
  readonly execSize: number;
  /** Стоимость одной пары (easyUpVwap + hardDownAsk) */
  readonly costPerUnit: number;
  /** Комиссия на одну пару */
  readonly feePerUnit: number;
  /** P&L на одну пару (1 - cost - fee) */
  readonly pnlPerUnit: number;
  /** Общий P&L (pnlPerUnit × execSize) */
  readonly totalPnl: number;
}

// ── Арбитражный сигнал ──────────────────────────────────────────────────────

/**
 * Арбитражный сигнал — обнаруженное расхождение с рекомендацией по исполнению.
 *
 * @remarks
 * Генерируется DivergenceDetector при обнаружении `hard_Up_bid > easy_Up_ask`.
 * Содержит оптимальную глубину исполнения и расчётный P&L.
 *
 * ### Стратегия исполнения:
 * 1. BUY easy_Up (taker fee by Polymarket crypto formula)
 * 2. BUY hard_Down ≡ SELL hard_Up (maker, 0% fee)
 * 3. При settlement один из двух токенов = $1, другой = $0
 * 4. Гарантированный доход: $1, стоимость: easy_Up_ask + (1 - hard_Up_bid) < $1
 *
 * @example
 * ```typescript
 * if (signal.optimalDepth.pnlPerUnit > 0.005) {
 *   await executor.execute(signal);
 * }
 * ```
 */
export interface ArbitrageSignal {
  /** Пара рынков */
  readonly pair: MarketPair;
  /**
   * Timestamp обнаружения.
   *
   * @remarks
   * Строится один раз на сигнал (редкое событие — только когда расхождение реально
   * прибыльно после комиссий), не на снапшот ордербука — в отличие от `depthLevels`/
   * `optimalDepth` ниже, которые остаются `number` как часть хот-путного per-snapshot
   * вычисления (см. `NumericLevel`/`DepthLevel`).
   */
  readonly detectedAtMs: Timestamp;
  /**
   * Профили по каждому уровню глубины.
   *
   * @remarks
   * Числовые поля `DepthLevel` намеренно остаются `number` — хот-путная VWAP-петля,
   * см. TSDoc `NumericLevel`.
   */
  readonly depthLevels: readonly DepthLevel[];
  /** Оптимальный уровень — максимальный totalPnl */
  readonly optimalDepth: DepthLevel;
  /** Best bid hard_Up (level 1) — `number`, та же хот-путная группа, что и `depthLevels` */
  readonly hardUpBestBid: number;
  /** Best ask easy_Up (level 1) — `number`, та же хот-путная группа, что и `depthLevels` */
  readonly easyUpBestAsk: number;
  /**
   * Направление арбитража.
   *
   * @remarks
   * - `'UP'`: hardUpBid > easyUpAsk → BUY easy_Up + BUY hard_Down
   *   Strike-safe когда easyStrike ≤ hardStrike.
   * - `'DOWN'`: easyUpBid > hardUpAsk → BUY easy_Down + BUY hard_Up
   *   Strike-safe когда easyStrike > hardStrike (hardStrike ≤ easyStrike).
   */
  readonly direction: 'UP' | 'DOWN';
}

// ── Конфигурация детектора ──────────────────────────────────────────────────

/**
 * Модель комиссий Polymarket.
 *
 * @remarks
 * Текущая формула: `fee = round5(size × feeRate × (price × (1 - price))^exponent)`.
 * Для crypto-рынков Polymarket: feeRate=0.072, exponent=1.
 */
export interface FeeModel {
  /**
   * Множитель в формуле комиссии (безразмерная доля).
   *
   * @remarks
   * `FeeCalculator` распаковывает `.toNumber()` один раз в конструкторе и хранит plain
   * `number` для хот-путной `takerFee()` (вызывается на каждый depth-level каждого
   * снапшота — см. `FeeCalculator.ts`), не на каждый вызов.
   */
  readonly feeRate: Ratio;
  /** Степень `(p × (1-p))` в формуле — показатель степени, не "величина", остаётся `number` */
  readonly exponent: number;
}

/** Текущая модель комиссий для crypto-рынков Polymarket. */
export const FEE_MODEL_CURRENT: FeeModel = { feeRate: Ratio.of(new Decimal('0.072')), exponent: 1 };

/** @deprecated Use FEE_MODEL_CURRENT. Kept for older configs/scripts. */
export const FEE_MODEL_MARCH30: FeeModel = FEE_MODEL_CURRENT;

/**
 * Конфигурация детектора расхождений.
 */
export interface DetectorConfig {
  /** Максимальная глубина ордербука для анализа (default: 5) */
  readonly maxDepth: number;
  /** Минимальный спред после комиссий для генерации сигнала (default: 0.005) */
  readonly minSpreadAfterFees: number;
  /** Модель комиссий */
  readonly feeModel: FeeModel;
  /** Easy leg — taker (default: true) */
  readonly easyIsTaker: boolean;
  /** Hard leg — maker (default: true, fee=0) */
  readonly hardIsMaker: boolean;
}

/** Конфигурация по умолчанию */
export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  maxDepth: 5,
  minSpreadAfterFees: 0.005,
  feeModel: FEE_MODEL_CURRENT,
  easyIsTaker: true,
  hardIsMaker: true,
};

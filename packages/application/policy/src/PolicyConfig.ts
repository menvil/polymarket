/**
 * Plain-контракты конфигурации policy: то, что реально лежит в JSON/YAML/env.
 *
 * @remarks
 * ### Зачем отдельный слой типов, если {@link Policy} уже есть
 *
 * `Policy` собрана из canonical-типов (`CryptoAssetId`, `MarketDuration`,
 * `Money`, `Ratio`, `Timestamp`) — и это правильно ДЛЯ ПРИМЕНЕНИЯ: сравнение
 * с рынком не должно каждый раз конвертировать миллисекунды в минуты и
 * строки в деньги. Но записать такую policy в конфигурационный файл нельзя:
 * в JSON нет ни `Money`, ни `Timestamp`, там есть `"1000"`, `"USDC"` и
 * `"2026-09-01T18:00:00Z"`.
 *
 * Без явного plain-контракта эту разницу закрывает каждый вызывающий сам:
 * runtime бота, коллектор, загрузчик стратегий и backtest напишут по
 * собственному парсеру `"5m"` → `MarketDuration`, и разойдутся они не в день
 * написания, а в день, когда один из них начнёт принимать `"5"`. Поэтому
 * граница «plain → canonical» объявлена типами и проходится ОДНОЙ функцией
 * ({@link parsePolicyConfig}).
 *
 * ### Что здесь допустимо
 *
 * ТОЛЬКО JSON-friendly значения: строки, числа, булевы, массивы и вложенные
 * объекты из них. Любой canonical-тип, попавший в эти интерфейсы, вернул бы
 * задачу конверсии вызывающему — то есть ровно то, ради устранения чего слой
 * и заведён.
 *
 * ### Почему форматы описаны здесь, а не «как получится»
 *
 * У каждого поля ОДИН документированный формат, а не набор синонимов.
 * `durations` — это `"5m"`, но не `"5"`, не `"300000"` и не
 * `"five-minutes"`: множество принимаемых написаний растёт быстрее, чем
 * множество осмысленных, и каждое лишнее написание — это ещё одна догадка
 * парсера о том, что имел в виду автор конфигурации.
 *
 * @example
 * ```typescript
 * const config: PolicyConfig = {
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: ['btc', 'eth'],
 *   durations: ['5m', '15m'],
 *   minLiquidity: { amount: '1000', currency: 'USDC' },
 *   minSpread: '0.02',
 *   effectiveFrom: '2026-09-01T18:00:00Z',
 * };
 * ```
 */

/**
 * Конфигурация owner policy площадки Polymarket.
 *
 * @remarks
 * Форматы полей (проверяются в {@link parsePolymarketPolicyConfig}):
 *
 * | Поле            | Формат                                        |
 * | --------------- | --------------------------------------------- |
 * | `family`        | значение `MarketFamily`, например `'CRYPTO_UP_DOWN'` |
 * | `assets`        | тикер базового актива, например `'btc'`       |
 * | `durations`     | `<число><m\|h>`, например `'5m'`, `'1h'`      |
 * | `minLiquidity`  | `{ amount, currency }`, валюта из `SUPPORTED_CURRENCIES` |
 * | `minSpread`     | десятичная ДРОБЬ, `'0.02'` = 2 %              |
 * | `effectiveFrom` | ISO-8601, например `'2026-09-01T18:00:00Z'`   |
 *
 * Семантика пустоты повторяет {@link PolymarketPolicy}: отсутствующий либо
 * пустой список означает «ограничения нет». Отдельного значения «не подходит
 * ничего» у конфигурации нет — в файлах пустой список пишут именно чтобы
 * выключить фильтр.
 *
 * @example
 * ```typescript
 * const btc5m: PolymarketPolicyConfig = {
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: ['btc'],
 *   durations: ['5m'],
 *   title: { excluded: ['testnet'] },
 * };
 * ```
 */
export interface PolymarketPolicyConfig {
  /** Дискриминант union-а {@link PolicyConfig}. */
  readonly kind: 'POLYMARKET';
  /** Семейство рынков; допустимые значения — `MARKET_FAMILY_VALUES`. */
  readonly family: string;
  /** Тикеры базовых активов (пусто/отсутствует — любой поддержанный). */
  readonly assets?: readonly string[];
  /** Номиналы серий в формате `<число><m|h>` (пусто/отсутствует — любой). */
  readonly durations?: readonly string[];
  /** Селекторы по тексту рынка; нормализует и проверяет фабрика policy. */
  readonly title?: {
    /** Все слова должны присутствовать. */
    readonly required?: readonly string[];
    /** Хотя бы одно слово должно присутствовать. */
    readonly anyOf?: readonly string[];
    /** Ни одно слово присутствовать не должно. */
    readonly excluded?: readonly string[];
  };
  /**
   * Минимальная ликвидность.
   *
   * @remarks
   * `amount` допускает и строку, и число СОЗНАТЕЛЬНО: в YAML сумму пишут
   * числом, в env — только строкой, а точность `1000.10` в JSON-числе
   * теряется. Строка — предпочтительная форма для денег; число принимается,
   * чтобы не заставлять переписывать существующие конфиги.
   */
  readonly minLiquidity?: { readonly amount: string | number; readonly currency: string };
  /**
   * Минимальный спред как десятичная ДРОБЬ: `'0.02'` — это 2 %.
   *
   * @remarks
   * Не проценты и не basis points: `Ratio` внутри — дробь, и принимать здесь
   * `2` со значением «2 %» означало бы, что одна и та же цифра в конфиге и в
   * коде значит разное.
   */
  readonly minSpread?: string | number;
  /** Момент, с которого policy действует (включительно), ISO-8601. */
  readonly effectiveFrom?: string;
  /** Момент, с которого policy НЕ действует (исключительно), ISO-8601. */
  readonly effectiveUntil?: string;
}

/**
 * Конфигурация owner policy централизованной биржи.
 *
 * @remarks
 * В отличие от Polymarket-конфигурации, списки здесь ОБЯЗАТЕЛЬНЫ и пустыми
 * быть не могут: подписаться «на всё» у биржи нельзя, поэтому `symbols: []`
 * не означает «все символы» — оно не означает ничего. Проверку выполняет
 * `createCexPolicy`, а не парсер: это правило policy, а не формата записи.
 *
 * `marketTypes` объявлены как `readonly string[]`, а не как union: конфиг —
 * недоверенный источник, и обещать в его типе принадлежность словарю значило
 * бы обещать то, чего файл не гарантирует. Сужение делает фабрика.
 *
 * @example
 * ```typescript
 * const binanceSwap: CexPolicyConfig = {
 *   kind: 'CEX',
 *   exchangeIds: ['binance'],
 *   marketTypes: ['swap'],
 *   symbols: ['BTC/USDT:USDT'],
 *   orderbook: true,
 *   trades: true,
 *   orderbookDepth: 10,
 * };
 * ```
 */
export interface CexPolicyConfig {
  /** Дискриминант union-а {@link PolicyConfig}. */
  readonly kind: 'CEX';
  /** Биржи, данные которых нужны consumer-у. */
  readonly exchangeIds: readonly string[];
  /** Виды рынков; допустимые значения — `CEX_POLICY_MARKET_TYPE_VALUES`. */
  readonly marketTypes: readonly string[];
  /** Символы инструментов в нотации биржи. */
  readonly symbols: readonly string[];
  /** Нужен ли стакан. */
  readonly orderbook: boolean;
  /** Нужны ли сделки. */
  readonly trades: boolean;
  /** Желаемая глубина стакана (положительное целое). */
  readonly orderbookDepth?: number;
  /** Момент, с которого policy действует (включительно), ISO-8601. */
  readonly effectiveFrom?: string;
  /** Момент, с которого policy НЕ действует (исключительно), ISO-8601. */
  readonly effectiveUntil?: string;
}

/**
 * Любая конфигурация owner policy.
 *
 * @remarks
 * Дискриминант — `kind`, ровно как у canonical-union-а `Policy`: конфигурация
 * и результат её разбора обязаны различаться по одному и тому же признаку,
 * иначе вызывающему пришлось бы помнить два способа сказать «это CEX».
 *
 * @example
 * ```typescript
 * const configs: readonly PolicyConfig[] = JSON.parse(raw) as PolicyConfig[];
 * const policies = configs.map(parsePolicyConfig);
 * ```
 */
export type PolicyConfig = PolymarketPolicyConfig | CexPolicyConfig;

/**
 * Вид конфигурации policy.
 *
 * @remarks
 * Выводится из union-а, а не объявляется рядом: собственный литеральный тип
 * разошёлся бы с {@link PolicyConfig} в тот же день, когда появится третий
 * вид policy.
 */
export type PolicyConfigKind = PolicyConfig['kind'];

/**
 * Единственный источник истины словаря {@link PolicyConfigKind}.
 *
 * @internal
 * @remarks
 * `satisfies Record<PolicyConfigKind, true>` делает пропуск вида ОШИБКОЙ
 * КОМПИЛЯЦИИ. Конвенция та же, что у `CEX_POLICY_MARKET_TYPES`: полноту в
 * TypeScript умеет требовать только тип-ключ, а не длина массива.
 */
const POLICY_CONFIG_KINDS = {
  POLYMARKET: true,
  CEX: true,
} satisfies Record<PolicyConfigKind, true>;

/**
 * Материализованный словарь допустимых значений `kind`.
 *
 * @remarks
 * Нужен не для типизированных вызывающих (им хватает union-а), а для
 * СООБЩЕНИЯ ОБ ОШИБКЕ: конфигурация приходит из JSON, где `kind` может
 * оказаться чем угодно, и ответ «допустимо вот это» дешевле любого разбора
 * логов. Выведен из {@link POLICY_CONFIG_KINDS}, поэтому разойтись с union-ом
 * не может.
 *
 * @example
 * ```typescript
 * POLICY_CONFIG_KIND_VALUES.includes('CEX' as PolicyConfigKind); // → true
 * ```
 */
export const POLICY_CONFIG_KIND_VALUES: readonly PolicyConfigKind[] = Object.freeze(
  Object.keys(POLICY_CONFIG_KINDS) as PolicyConfigKind[],
);

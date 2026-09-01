/**
 * Фабрики owner policy: нормализация и проверка при СОЗДАНИИ.
 *
 * @remarks
 * ### Почему проверка на входе, а не при применении
 *
 * Policy — программная конфигурация: её собирает разработчик или загрузчик
 * конфига, а не внешний недоверенный источник. Противоречивое окно
 * (`effectiveFrom >= effectiveUntil`) или пустой строковый селектор — это
 * дефект настройки, и обнаружить его нужно там, где его можно исправить:
 * при сборке policy. Отложить до применения значило бы получить не ошибку,
 * а тихо пустой результат фильтрации — симптом, по которому причину не
 * найти.
 *
 * ### Почему `throw`, а не `Result`
 *
 * Fail-fast: у вызывающего нет ветки «продолжить с испорченной policy» —
 * такая policy означает, что consumer получит не то, что просил. Заводить
 * ради этого отдельную иерархию ошибок не за что: подходит существующий
 * `ValidationError` контура.
 *
 * ### Что делает нормализация
 *
 * Снимает у селекторов различия, не несущие смысла: дубликаты в списках и
 * окружающие пробелы у ключевых слов. Пустые после обрезки строки
 * выбрасываются — селектор `''` совпал бы с любым текстом и незаметно
 * превратил бы «фильтр по слову» в «пропустить всё».
 *
 * Входные массивы не мутируются: policy собирают из общих констант, и
 * править их на месте значило бы менять чужую конфигурацию.
 */
import { ValidationError } from '@polymarket/errors';
import type { CryptoAssetId } from '@polymarket/ids';
import type { MarketDuration } from '@polymarket/market';
import type { PolicyWindow } from './PolicyWindow.js';
import type { CexPolicy, CexPolicyMarketType } from './CexPolicy.js';
import type { PolymarketPolicy, PolymarketPolicyTitleSelectors } from './PolymarketPolicy.js';

/**
 * Ошибка некорректной policy.
 *
 * @remarks
 * Отдельный класс, а не голый `Error`: по нему загрузчик конфигурации
 * отличает «policy собрана неверно» от любой другой ошибки запуска.
 */
export class PolicyValidationError extends ValidationError {}

/**
 * Проверяет согласованность окна применимости.
 *
 * @param window - Окно policy
 * @throws {PolicyValidationError} Если `effectiveFrom >= effectiveUntil`
 *
 * @internal
 * @remarks
 * Окно, у которого начало не раньше конца, не действует НИКОГДА: интервал
 * полуоткрыт, поэтому даже равные границы дают пустое множество моментов.
 * Это всегда опечатка, и молча принять её значило бы отдать policy,
 * которая не совпадёт ни с одним рынком без единого признака почему.
 */
function assertValidWindow(window: PolicyWindow): void {
  const { effectiveFrom, effectiveUntil } = window;
  if (effectiveFrom === undefined || effectiveUntil === undefined) {
    return;
  }
  if (!effectiveFrom.isBefore(effectiveUntil)) {
    throw new PolicyValidationError('Policy effectiveFrom must be before effectiveUntil', {
      context: {
        effectiveFrom: effectiveFrom.toISO(),
        effectiveUntil: effectiveUntil.toISO(),
      },
    });
  }
}

/**
 * Убирает дубликаты, сохраняя порядок первого появления.
 *
 * @param values - Исходный список
 * @returns Новый список без дубликатов
 *
 * @internal
 */
function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Нормализует список ключевых слов: обрезка, отсев пустых, дедупликация.
 *
 * @param keywords - Исходный список (может отсутствовать)
 * @returns Нормализованный список либо `undefined`, если селектора нет
 * @throws {PolicyValidationError} Если после обрезки список стал пустым,
 *   хотя во входе были строки
 *
 * @internal
 * @remarks
 * Разница между «селектора нет» и «селектор состоит из мусора» существенна:
 * первое — осознанное «фильтр выключен», второе — дефект конфигурации
 * (`excluded: ['   ']`), который без проверки превратился бы в тихо
 * выключенный фильтр.
 */
function normalizeKeywords(
  keywords: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (keywords === undefined || keywords.length === 0) {
    return undefined;
  }
  const trimmed = distinct(keywords.map((keyword) => keyword.trim()).filter((k) => k !== ''));
  if (trimmed.length === 0) {
    throw new PolicyValidationError('Policy keyword selector contains only blank keywords', {
      context: { field, keywords: [...keywords] },
    });
  }
  return Object.freeze(trimmed);
}

/**
 * Нормализует селекторы по тексту рынка.
 *
 * @param title - Исходные селекторы
 * @returns Нормализованные селекторы либо `undefined`, если ни один не задан
 * @throws {PolicyValidationError} Через {@link normalizeKeywords}
 *
 * @internal
 */
function normalizeTitle(
  title: PolymarketPolicyTitleSelectors | undefined,
): PolymarketPolicyTitleSelectors | undefined {
  if (title === undefined) {
    return undefined;
  }
  const required = normalizeKeywords(title.required, 'title.required');
  const anyOf = normalizeKeywords(title.anyOf, 'title.anyOf');
  const excluded = normalizeKeywords(title.excluded, 'title.excluded');
  if (required === undefined && anyOf === undefined && excluded === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(required !== undefined ? { required } : {}),
    ...(anyOf !== undefined ? { anyOf } : {}),
    ...(excluded !== undefined ? { excluded } : {}),
  });
}

/**
 * Собирает проверенную и нормализованную {@link PolymarketPolicy}.
 *
 * @param input - Желаемая policy (входные массивы не мутируются)
 * @returns Замороженная policy с нормализованными селекторами
 * @throws {PolicyValidationError} При противоречивом окне либо мусорных
 *   ключевых словах
 *
 * @remarks
 * Пустые списки `assets`/`durations` схлопываются в `undefined` — это одно и
 * то же утверждение «ограничения нет», и хранить два его представления
 * значило бы заставлять каждого потребителя проверять оба.
 *
 * @example
 * ```typescript
 * const policy = createPolymarketPolicy({
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: [btc, btc],                  // → [btc]
 *   title: { excluded: [' testnet ', ''] }, // → ['testnet']
 * });
 * ```
 */
export function createPolymarketPolicy(input: PolymarketPolicy): PolymarketPolicy {
  assertValidWindow(input);

  const assets: readonly CryptoAssetId[] | undefined =
    input.assets === undefined || input.assets.length === 0
      ? undefined
      : Object.freeze(distinct(input.assets));
  const durations: readonly MarketDuration[] | undefined =
    input.durations === undefined || input.durations.length === 0
      ? undefined
      : Object.freeze(distinct(input.durations));
  const title = normalizeTitle(input.title);

  return Object.freeze({
    kind: 'POLYMARKET' as const,
    family: input.family,
    ...(assets !== undefined ? { assets } : {}),
    ...(durations !== undefined ? { durations } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(input.minLiquidity !== undefined ? { minLiquidity: input.minLiquidity } : {}),
    ...(input.minSpread !== undefined ? { minSpread: input.minSpread } : {}),
    ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
  });
}

/**
 * Собирает проверенную и нормализованную {@link CexPolicy}.
 *
 * @param input - Желаемая policy (входные массивы не мутируются)
 * @returns Замороженная policy с дедуплицированными списками
 * @throws {PolicyValidationError} При пустом обязательном списке, отсутствии
 *   запрошенных данных, некорректной глубине либо противоречивом окне
 *
 * @remarks
 * В отличие от Polymarket-policy, здесь списки ОБЯЗАТЕЛЬНЫ и пустыми быть
 * не могут: `assets: []` у Polymarket означает «любой актив из технически
 * доступных», а `symbols: []` у биржи не означает «все символы» — оно не
 * означает ничего, потому что подписаться «на всё» у CEX нельзя. То же с
 * `orderbook`/`trades`: policy, не запросившая ни одного потока, описывает
 * подписку без данных.
 *
 * @example
 * ```typescript
 * const policy = createCexPolicy({
 *   kind: 'CEX',
 *   exchangeIds: ['binance'],
 *   marketTypes: ['swap'],
 *   symbols: ['BTC/USDT:USDT'],
 *   orderbook: true,
 *   trades: false,
 *   orderbookDepth: 10,
 * });
 * ```
 */
export function createCexPolicy(input: CexPolicy): CexPolicy {
  assertValidWindow(input);

  const exchangeIds = normalizeRequiredList(input.exchangeIds, 'exchangeIds');
  const marketTypes = normalizeRequiredList(input.marketTypes, 'marketTypes');
  const symbols = normalizeRequiredList(input.symbols, 'symbols');

  if (!input.orderbook && !input.trades) {
    throw new PolicyValidationError('CEX policy must request orderbook, trades, or both', {
      context: { orderbook: input.orderbook, trades: input.trades },
    });
  }

  if (input.orderbookDepth !== undefined) {
    const depth = input.orderbookDepth;
    if (!Number.isInteger(depth) || depth <= 0) {
      throw new PolicyValidationError('CEX policy orderbookDepth must be a positive integer', {
        context: { orderbookDepth: depth },
      });
    }
  }

  return Object.freeze({
    kind: 'CEX' as const,
    exchangeIds,
    marketTypes: marketTypes as readonly CexPolicyMarketType[],
    symbols,
    orderbook: input.orderbook,
    trades: input.trades,
    ...(input.orderbookDepth !== undefined ? { orderbookDepth: input.orderbookDepth } : {}),
    ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
  });
}

/**
 * Нормализует обязательный непустой список.
 *
 * @param values - Исходный список
 * @param field - Имя поля для сообщения об ошибке
 * @returns Замороженный список без дубликатов
 * @throws {PolicyValidationError} Если список пуст либо состоит из пустых строк
 *
 * @internal
 */
function normalizeRequiredList<T extends string>(values: readonly T[], field: string): readonly T[] {
  const normalized = distinct(values.map((v) => v.trim() as T).filter((v) => v !== ''));
  if (normalized.length === 0) {
    throw new PolicyValidationError('CEX policy list selector must not be empty', {
      context: { field, values: [...values] },
    });
  }
  return Object.freeze(normalized);
}

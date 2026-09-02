/**
 * Owner policy для централизованных бирж: что consumer хочет получать.
 *
 * @remarks
 * ### Это declaration, а не конфигурация транспорта
 *
 * `CexPolicy` выражает ПОТРЕБНОСТЬ: «Binance, swap, `BTC/USDT:USDT`, стакан
 * и сделки, глубина 10». Она сознательно ничего не знает про интервалы
 * перезапуска, таймауты устаревания, шаг опроса, backoff, способ получения
 * стакана и возможности конкретной библиотеки-коннектора: всё это —
 * свойства транспорта, они принадлежат Infrastructure и меняются по своим
 * причинам. Смешать их здесь означало бы, что смена таймаута требует правки
 * пользовательской политики.
 *
 * Превращение потребности в физическую конфигурацию источника — работа
 * будущего subscription controller-а на границе Infrastructure.
 *
 * ### Почему тип рынка — собственный строковый union
 *
 * `spot | future | swap` — словарь Application. Импортировать здесь
 * vendor-перечисление означало бы зависимость Application от
 * Infrastructure, то есть ровно ту стрелку, которую этот слой и разворачивает.
 * Сопоставление с vendor-типами выполнится на границе, где vendor уже
 * известен.
 *
 * ### Почему это здесь, если ничего не подключено
 *
 * Второй тип policy нужен уже сейчас, чтобы union {@link Policy} не оказался
 * union-ом из одного члена: такой «union» не заставляет ни один потребитель
 * различать виды policy, и первый же настоящий второй вид ломает всех сразу.
 */
import type { PolicyWindow } from './PolicyWindow.js';

/**
 * Вид рынка CEX в словаре Application.
 */
export type CexPolicyMarketType = 'spot' | 'future' | 'swap';

/**
 * Единственный источник истины словаря {@link CexPolicyMarketType}.
 *
 * @internal
 * @remarks
 * `satisfies Record<CexPolicyMarketType, true>` — не украшение: он делает
 * пропуск члена union-а ОШИБКОЙ КОМПИЛЯЦИИ. Прежний вариант
 * (`const VALUES: readonly CexPolicyMarketType[] = [...]`) обещал ровно это,
 * но не давал: массив из двух членов трёхчленного union-а — всё ещё
 * корректный `CexPolicyMarketType[]`, поэтому добавление `'option'` молча
 * оставило бы runtime-проверку отвергать законное значение.
 *
 * Ключи объекта, а не элементы массива, потому что полноту в TypeScript
 * умеет требовать только тип-ключ (`Record`), а не длина массива.
 */
const CEX_POLICY_MARKET_TYPES = {
  spot: true,
  future: true,
  swap: true,
} satisfies Record<CexPolicyMarketType, true>;

/**
 * Материализованный словарь допустимых видов рынка CEX.
 *
 * @remarks
 * Выведен из {@link CEX_POLICY_MARKET_TYPES}, поэтому разойтись с union-ом
 * не может. Служит и списком «допустимо вот это» в сообщении об ошибке
 * валидации: перечислять допустимые значения руками во втором месте значило
 * бы завести второй словарь, который отстанет от первого.
 *
 * Конвенция повторяет `MARKET_FAMILY_VALUES` из `@polymarket/market`: runtime
 * -словарь лежит там же, где тип.
 *
 * @example
 * ```typescript
 * CEX_POLICY_MARKET_TYPE_VALUES.includes('spot'); // → true
 * ```
 */
export const CEX_POLICY_MARKET_TYPE_VALUES: readonly CexPolicyMarketType[] = Object.freeze(
  Object.keys(CEX_POLICY_MARKET_TYPES) as CexPolicyMarketType[],
);

/**
 * Является ли произвольное значение допустимым видом рынка CEX.
 *
 * @param value - Значение из недоверенного источника (конфиг, env, JSON)
 * @returns `true` и сужение типа, если значение принадлежит словарю
 *
 * @remarks
 * Проверка ТОЧНАЯ: `'SPOT'` и `'futures'` отвергаются. Приводить регистр
 * здесь нельзя — обрезка пробелов ничего не теряет, а смена регистра
 * переписывает сам токен и решила бы за автора конфига, что он имел в виду,
 * тогда как это может быть опечатка или словарь чужого вендора.
 *
 * @example
 * ```typescript
 * isCexPolicyMarketType('swap');  // → true
 * isCexPolicyMarketType('SPOT');  // → false
 * ```
 */
export function isCexPolicyMarketType(value: unknown): value is CexPolicyMarketType {
  return typeof value === 'string' && Object.hasOwn(CEX_POLICY_MARKET_TYPES, value);
}

/**
 * Owner policy централизованной биржи.
 *
 * @example
 * ```typescript
 * const binanceSwap: CexPolicy = {
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
export interface CexPolicy extends PolicyWindow {
  /** Дискриминант union-а {@link Policy}. */
  readonly kind: 'CEX';
  /** Биржи, данные которых нужны consumer-у. */
  readonly exchangeIds: readonly string[];
  /** Виды рынков. */
  readonly marketTypes: readonly CexPolicyMarketType[];
  /** Символы инструментов в нотации биржи. */
  readonly symbols: readonly string[];
  /** Нужен ли стакан. */
  readonly orderbook: boolean;
  /** Нужны ли сделки. */
  readonly trades: boolean;
  /**
   * Желаемая глубина стакана.
   *
   * @remarks
   * Именно ЖЕЛАЕМАЯ: сколько уровней реально отдаст биржа — вопрос её
   * возможностей, и решается он на границе транспорта, а не здесь.
   */
  readonly orderbookDepth?: number;
}

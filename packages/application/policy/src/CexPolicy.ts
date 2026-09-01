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

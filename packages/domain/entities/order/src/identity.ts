/**
 * Сравнение заявок: неизменяемая идентичность отдельно от изменяемого состояния.
 *
 * @remarks
 * У заявки, в отличие от исполнения, изменяемая часть ЕСТЬ: `status`,
 * `filledSize`, `averagePrice`, `fillIds`, `reason` меняются по ходу её жизни.
 * Поэтому по одному и тому же `OrderId` различимы ТРИ случая, а не два:
 *
 * ```text
 * идентичность ==, состояние !=   та же заявка, продвинувшаяся дальше
 * идентичность ==, состояние ==   та же заявка в том же состоянии
 * идентичность !=                 ДРУГАЯ заявка под чужим идентификатором
 * ```
 *
 * Что делать с каждым исходом — решает потребитель. Приватное состояние,
 * например, применяет первый, считает второй дубликатом доставки, а третий
 * отвергает; но само это решение здесь не зашито.
 *
 * ### Почему это живёт в домене
 *
 * «Что делает две заявки одной и той же» — знание о заявке, а не о конкретном
 * потребителе. Сверка с площадкой, приватное состояние и восстановление после
 * разрыва задают один и тот же вопрос, и три независимых ответа на него
 * разошлись бы.
 *
 * ### Что считается неизменяемым
 *
 * ```text
 * id          заявка не меняет свой идентификатор
 * accountId   владелец не передаётся
 * asset       инструмент не подменяется
 * side        BUY не становится SELL
 * price       лимитная цена не переписывается
 * size        объём не переписывается
 * timestamp   момент создания не сдвигается
 * strategyId  автор не меняется
 * ```
 *
 * Изменение любого из них при том же `OrderId` означает, что перед нами
 * ДРУГАЯ заявка под чужим идентификатором, а не эволюция старой.
 *
 * ### Почему не `JSON.stringify`
 *
 * Value objects — не plain-объекты: `OutcomePrice`/`Quantity`/`Timestamp`
 * хранят `Decimal`, чья сериализация зависит от внутреннего представления, а
 * `AssetId` — размеченное объединение с вложенной ссылкой. Сравнение строк
 * дало бы и ложные расхождения (`0.65` против `0.650`), и ложные совпадения.
 * Каждое поле сравнивается своим canonical-равенством.
 */
import {
  AssetIdHelpers,
  accountIdEquals,
  accountIdToString,
  assetIdToString,
} from '@polymarket/ids';
import type { Order } from './Order.js';
import { SideService } from '@polymarket/value-objects';

/** Поле неизменяемой идентичности заявки, по которому нашлось расхождение. */
export type OrderIdentityField =
  | 'id'
  | 'accountId'
  | 'asset'
  | 'side'
  | 'price'
  | 'size'
  | 'timestamp'
  | 'strategyId';

/**
 * Первое найденное расхождение неизменяемой идентичности заявки.
 *
 * @remarks
 * Значения приводятся к строкам ДЛЯ ЛОГА — сравнение выполняется по value
 * objects, а не по этим строкам.
 *
 * Имена `left`/`right` нейтральны намеренно: домен не знает, какая из двух
 * заявок «сохранённая», а какая «пришедшая». Эту роль называет потребитель.
 */
export interface OrderIdentityDifference {
  /** Поле, по которому заявки разошлись */
  readonly field: OrderIdentityField;
  /** Значение в первом аргументе */
  readonly left: string;
  /** Значение во втором аргументе */
  readonly right: string;
}

/**
 * Читаемое представление возможно отсутствующего значения.
 *
 * @remarks
 * `accountIdToString` в этом модуле используется ТОЛЬКО для текста
 * расхождения. Сравнение аккаунтов делает `accountIdEquals` —
 * canonical-равенство, а не совпадение строк.
 */
function show(value: string | undefined): string {
  return value ?? '<none>';
}

/**
 * Ищет расхождение неизменяемой идентичности двух заявок.
 *
 * @param left - Первая заявка
 * @param right - Вторая заявка
 * @returns Первое расхождение либо `undefined`, если идентичность совпала
 *
 * @remarks
 * Возвращается ПЕРВОЕ расхождение, а не список: для отказа достаточно одного,
 * а перечислять все — значит выполнять лишнюю работу на горячем пути ради
 * сообщения, которое всё равно читают целиком.
 *
 * @example
 * ```typescript
 * const difference = findOrderIdentityDifference(stored, incoming);
 * if (difference !== undefined) {
 *   logger.warn(`order ${stored.id} differs on ${difference.field}`);
 * }
 * ```
 */
export function findOrderIdentityDifference(
  left: Order,
  right: Order,
): OrderIdentityDifference | undefined {
  if (left.id !== right.id) {
    return { field: 'id', left: left.id, right: right.id };
  }

  // accountId сравнивается canonical-равенством: два эквивалентных
  // accountId сравнивается canonical-равенством: два эквивалентных
  // AccountId — это разные JS-объекты, и `===` дал бы ложное расхождение.
  const leftAccount = left.accountId;
  const rightAccount = right.accountId;
  const sameAccount =
    leftAccount === undefined || rightAccount === undefined
      ? leftAccount === rightAccount
      : accountIdEquals(leftAccount, rightAccount);
  if (!sameAccount) {
    return {
      field: 'accountId',
      left: show(leftAccount && accountIdToString(leftAccount)),
      right: show(rightAccount && accountIdToString(rightAccount)),
    };
  }

  if (!AssetIdHelpers.equals(left.asset, right.asset)) {
    return {
      field: 'asset',
      left: assetIdToString(left.asset),
      right: assetIdToString(right.asset),
    };
  }

  if (!SideService.equals(left.side, right.side)) {
    return { field: 'side', left: left.side, right: right.side };
  }

  if (!left.price.equals(right.price)) {
    return {
      field: 'price',
      left: left.price.value().toString(),
      right: right.price.value().toString(),
    };
  }

  if (!left.size.equals(right.size)) {
    return {
      field: 'size',
      left: left.size.value().toString(),
      right: right.size.value().toString(),
    };
  }

  if (!left.timestamp.equals(right.timestamp)) {
    return {
      field: 'timestamp',
      left: left.timestamp.toISO(),
      right: right.timestamp.toISO(),
    };
  }

  if (left.strategyId !== right.strategyId) {
    return {
      field: 'strategyId',
      left: show(left.strategyId),
      right: show(right.strategyId),
    };
  }

  return undefined;
}

/**
 * Заявки описывают один и тот же торговый объект.
 *
 * @param a - Первая заявка
 * @param b - Вторая заявка
 * @returns `true`, если совпали все неизменяемые поля идентичности
 *
 * @remarks
 * Состояние (`status`, исполнения, `reason`) в сравнение НЕ входит: оно как
 * раз и обязано меняться от commit'а к commit'у.
 *
 * @example
 * ```typescript
 * sameOrderIdentity(openOrder, openOrder.cancel('user').value); // → true
 * ```
 */
export function sameOrderIdentity(a: Order, b: Order): boolean {
  return findOrderIdentityDifference(a, b) === undefined;
}

/**
 * Заявки полностью эквивалентны — включая изменяемое состояние.
 *
 * @param a - Первая заявка
 * @param b - Вторая заявка
 * @returns `true`, если совпала и идентичность, и всё изменяемое состояние
 *
 * @remarks
 * Полная эквивалентность означает, что вторая заявка ничего не добавляет к
 * первой. Потребитель, у которого первая уже сохранена, на этом основании
 * может ничего не делать.
 *
 * Сверх идентичности сравниваются `status`, `filledSize`, `averagePrice`,
 * `fillIds` и `reason`. `fillIds` сравнивается ПО ПОРЯДКУ: агрегат
 * дописывает их в конец, и другой порядок означал бы другую историю
 * исполнений, а не ту же в перестановке.
 *
 * @example
 * ```typescript
 * if (sameOrderState(stored, incoming)) return; // ничего нового
 * ```
 */
export function sameOrderState(a: Order, b: Order): boolean {
  if (!sameOrderIdentity(a, b)) return false;
  if (a.status !== b.status) return false;
  if (a.reason !== b.reason) return false;
  if (!a.filledSize.equals(b.filledSize)) return false;

  const aAverage = a.averagePrice;
  const bAverage = b.averagePrice;
  if (aAverage === undefined || bAverage === undefined) {
    if (aAverage !== bAverage) return false;
  } else if (!aAverage.equals(bAverage)) {
    return false;
  }

  if (a.fillIds.length !== b.fillIds.length) return false;
  return a.fillIds.every((fillId, index) => fillId === b.fillIds[index]);
}

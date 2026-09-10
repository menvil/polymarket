/**
 * Сравнение заявок: неизменяемая идентичность отдельно от изменяемого состояния.
 *
 * @remarks
 * `TRADING_ACCOUNT_ORDER_COMMITTED` доставляется по общей шине и может прийти
 * повторно. Поэтому по одному и тому же `OrderId` состояние обязано различать
 * ТРИ разных случая, и по-разному на них реагировать:
 *
 * ```text
 * та же идентичность, другое состояние   законное обновление  → применить
 * та же идентичность, то же состояние    дубликат             → no-op
 * другая идентичность                    конфликт             → Err
 * ```
 *
 * Без этого различия повторно доставленный старый event откатил бы состояние
 * назад: он несёт УСТАРЕВШИЙ портфель, и слепое применение вернуло бы уже
 * потраченные деньги в available.
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
import type { Order } from '@polymarket/order';
import { SideService } from '@polymarket/value-objects';

/** Поле неизменяемой идентичности заявки, по которому нашлось расхождение. */
export type AccountOrderIdentityField =
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
 */
export interface AccountOrderIdentityDifference {
  /** Поле, по которому заявки разошлись */
  readonly field: AccountOrderIdentityField;
  /** Значение в уже сохранённой заявке */
  readonly stored: string;
  /** Значение в пришедшей заявке */
  readonly incoming: string;
}

/**
 * Читаемое представление возможно отсутствующего значения.
 *
 * @remarks
 * `accountIdToString` в этом модуле используется ТОЛЬКО для текста ошибки.
 * Сравнение аккаунтов делает `accountIdEquals` — canonical-равенство, а не
 * совпадение строк.
 */
function show(value: string | undefined): string {
  return value ?? '<none>';
}

/**
 * Ищет расхождение неизменяемой идентичности двух заявок.
 *
 * @param stored - Заявка, уже сохранённая в состоянии
 * @param incoming - Заявка из пришедшего события
 * @returns Первое расхождение либо `undefined`, если идентичность совпала
 *
 * @remarks
 * Возвращается ПЕРВОЕ расхождение, а не список: для отказа достаточно одного,
 * а перечислять все — значит выполнять лишнюю работу на горячем пути ради
 * сообщения, которое всё равно читают целиком.
 *
 * @example
 * ```typescript
 * const difference = findOrderIdentityDifference(stored.order, incoming);
 * if (difference !== undefined) {
 *   return Err(new AccountOrderIdentityConflictError(venueId, accountId, id, difference));
 * }
 * ```
 */
export function findOrderIdentityDifference(
  stored: Order,
  incoming: Order,
): AccountOrderIdentityDifference | undefined {
  if (stored.id !== incoming.id) {
    return { field: 'id', stored: stored.id, incoming: incoming.id };
  }

  // accountId сравнивается canonical-равенством: два эквивалентных
  // AccountId — это разные JS-объекты, и `===` дал бы ложный конфликт.
  const storedAccount = stored.accountId;
  const incomingAccount = incoming.accountId;
  const sameAccount =
    storedAccount === undefined || incomingAccount === undefined
      ? storedAccount === incomingAccount
      : accountIdEquals(storedAccount, incomingAccount);
  if (!sameAccount) {
    return {
      field: 'accountId',
      stored: show(storedAccount && accountIdToString(storedAccount)),
      incoming: show(incomingAccount && accountIdToString(incomingAccount)),
    };
  }

  if (!AssetIdHelpers.equals(stored.asset, incoming.asset)) {
    return {
      field: 'asset',
      stored: assetIdToString(stored.asset),
      incoming: assetIdToString(incoming.asset),
    };
  }

  if (!SideService.equals(stored.side, incoming.side)) {
    return { field: 'side', stored: stored.side, incoming: incoming.side };
  }

  if (!stored.price.equals(incoming.price)) {
    return {
      field: 'price',
      stored: stored.price.value().toString(),
      incoming: incoming.price.value().toString(),
    };
  }

  if (!stored.size.equals(incoming.size)) {
    return {
      field: 'size',
      stored: stored.size.value().toString(),
      incoming: incoming.size.value().toString(),
    };
  }

  if (!stored.timestamp.equals(incoming.timestamp)) {
    return {
      field: 'timestamp',
      stored: stored.timestamp.toISO(),
      incoming: incoming.timestamp.toISO(),
    };
  }

  if (stored.strategyId !== incoming.strategyId) {
    return {
      field: 'strategyId',
      stored: show(stored.strategyId),
      incoming: show(incoming.strategyId),
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
 * Это и есть критерий ДУБЛИКАТА: событие с полностью эквивалентной заявкой
 * ничего не добавляет к состоянию, поэтому применять его нельзя — в нём
 * лежит устаревший портфель.
 *
 * Сверх идентичности сравниваются `status`, `filledSize`, `averagePrice`,
 * `fillIds` и `reason`. `fillIds` сравнивается ПО ПОРЯДКУ: агрегат
 * дописывает их в конец, и другой порядок означал бы другую историю
 * исполнений, а не ту же в перестановке.
 *
 * @example
 * ```typescript
 * if (sameOrderState(stored.order, incoming)) return Ok(undefined); // no-op
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

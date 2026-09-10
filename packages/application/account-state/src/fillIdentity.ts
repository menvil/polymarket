/**
 * Сравнение исполнений: `Fill` целиком неизменяем, поэтому меняться ему нечем.
 *
 * @remarks
 * В отличие от заявки, у исполнения нет «изменяемой части»: `Fill` — это
 * зафиксированный факт сделки, и ВСЕ его поля входят в идентичность. Отсюда
 * всего два случая по одному `FillId`:
 *
 * ```text
 * тот же факт      дубликат доставки  → no-op
 * другой факт      конфликт           → Err
 * ```
 *
 * Третьего («законное обновление») быть не может: цена, размер или сторона
 * исполнения не «уточняются» — если они другие, это другое исполнение под
 * чужим идентификатором.
 *
 * ### Почему не `JSON.stringify` и не сравнение по ссылке
 *
 * `Fill` пересобирается на каждом входе (из WS-наблюдения, из REST-сверки,
 * из архива), поэтому по ссылке равными два экземпляра одного факта не
 * бывают. `JSON.stringify` же зависит от внутреннего представления `Decimal`
 * внутри `OutcomePrice`/`Quantity`/`Fee` и от порядка полей `AssetId` — то
 * есть даёт и ложные расхождения, и ложные совпадения.
 */
import { AssetIdHelpers, accountIdEquals, accountIdToString, assetIdToString } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import { SideService } from '@polymarket/value-objects';

/** Поле факта исполнения, по которому нашлось расхождение. */
export type AccountFillFactField =
  | 'id'
  | 'orderId'
  | 'accountId'
  | 'venueId'
  | 'marketId'
  | 'tokenId'
  | 'settlementAssetId'
  | 'price'
  | 'size'
  | 'side'
  | 'timestamp'
  | 'fee';

/**
 * Первое найденное расхождение факта исполнения.
 *
 * @remarks
 * Значения приводятся к строкам ДЛЯ ЛОГА. Сравнение выполняется по value
 * objects и canonical-равенствам, а не по этим строкам.
 */
export interface AccountFillFactDifference {
  /** Поле, по которому исполнения разошлись */
  readonly field: AccountFillFactField;
  /** Значение в уже сохранённом исполнении */
  readonly stored: string;
  /** Значение в пришедшем исполнении */
  readonly incoming: string;
}

/**
 * Ищет расхождение неизменяемого факта двух исполнений.
 *
 * @param stored - Исполнение, уже сохранённое в состоянии
 * @param incoming - Исполнение из пришедшего события
 * @returns Первое расхождение либо `undefined`, если факты идентичны
 *
 * @remarks
 * Порядок проверок — от самых дешёвых (строковые идентификаторы) к более
 * дорогим (`Decimal`-сравнения внутри value objects): подавляющее
 * большинство расхождений ловится первыми же сравнениями.
 *
 * @example
 * ```typescript
 * const difference = findFillFactDifference(stored.fill, incoming);
 * if (difference !== undefined) {
 *   return Err(new AccountFillIdentityConflictError(venueId, accountId, id, 'APPLY', difference));
 * }
 * ```
 */
export function findFillFactDifference(
  stored: Fill,
  incoming: Fill,
): AccountFillFactDifference | undefined {
  if (stored.id !== incoming.id) {
    return { field: 'id', stored: stored.id, incoming: incoming.id };
  }

  if (stored.orderId !== incoming.orderId) {
    return { field: 'orderId', stored: stored.orderId, incoming: incoming.orderId };
  }

  // accountId — объект, а не строка: сравнивается canonical-равенством.
  if (!accountIdEquals(stored.accountId, incoming.accountId)) {
    return {
      field: 'accountId',
      stored: accountIdToString(stored.accountId),
      incoming: accountIdToString(incoming.accountId),
    };
  }

  if (stored.venueId !== incoming.venueId) {
    return { field: 'venueId', stored: stored.venueId, incoming: incoming.venueId };
  }

  if (stored.marketId !== incoming.marketId) {
    return { field: 'marketId', stored: stored.marketId, incoming: incoming.marketId };
  }

  if (!AssetIdHelpers.equals(stored.tokenId, incoming.tokenId)) {
    return {
      field: 'tokenId',
      stored: assetIdToString(stored.tokenId),
      incoming: assetIdToString(incoming.tokenId),
    };
  }

  if (!AssetIdHelpers.equals(stored.settlementAssetId, incoming.settlementAssetId)) {
    return {
      field: 'settlementAssetId',
      stored: assetIdToString(stored.settlementAssetId),
      incoming: assetIdToString(incoming.settlementAssetId),
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

  // Fee.equals сравнивает и актив комиссии, и её величину — комиссия «та же
  // сумма, но в другом активе» фактом того же исполнения не является.
  if (!stored.fee.equals(incoming.fee)) {
    return { field: 'fee', stored: stored.fee.toString(), incoming: incoming.fee.toString() };
  }

  return undefined;
}

/**
 * Исполнения описывают один и тот же факт сделки.
 *
 * @param a - Первое исполнение
 * @param b - Второе исполнение
 * @returns `true`, если совпали ВСЕ поля обоих `Fill`
 *
 * @remarks
 * Это критерий дубликата доставки: тот же `FillId` с тем же фактом означает,
 * что событие пришло повторно и применять его нельзя — в нём может лежать
 * устаревший портфель.
 *
 * @example
 * ```typescript
 * if (sameFillFact(stored.fill, incoming)) return Ok(undefined); // no-op
 * ```
 */
export function sameFillFact(a: Fill, b: Fill): boolean {
  return findFillFactDifference(a, b) === undefined;
}

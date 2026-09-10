/**
 * Записи приватного состояния вокруг canonical domain-сущностей.
 *
 * @remarks
 * Ни `Order`, ни `Fill` не копируются в собственные DTO: обе сущности уже
 * canonical, immutable и провалидированы при создании. Завести рядом
 * `AccountFillDto`/`AccountOrderDto` значило бы получить второе представление
 * того же факта и обязанность держать их согласованными — ровно ту проблему,
 * ради которой canonical-контракты и вводились.
 *
 * Запись добавляет к сущности только то, чего у неё быть не может:
 * ВРЕМЯ РАНТАЙМА и, для исполнения, его runtime-статус.
 */
import type { Fill, TradeStatus } from '@polymarket/fill';
import type { Order } from '@polymarket/order';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Runtime-статус исполнения в приватном состоянии.
 *
 * @remarks
 * Это НЕ статус площадки и не поле `Fill` — сам `Fill` неизменяем и статуса не
 * имеет. Статус описывает, что с этим фактом сделал НАШ рантайм:
 *
 * ```text
 * APPLIED    экономика исполнения применена к портфелю
 * CONFIRMED  площадка подтвердила финальность
 * REVERTED   применённая экономика откачена upstream-ом
 * ```
 *
 * Допустимые переходы (см. `AccountHotState`):
 *
 * ```text
 * APPLIED → CONFIRMED
 * APPLIED → REVERTED
 * ```
 *
 * `CONFIRMED → REVERTED` запрещён: финальность на то и финальность.
 * Подтверждено контрактом площадки — `TradeStatus.CONFIRMED` документирован
 * как «finality достигнута, транзакция успешна», то есть обратно площадка не
 * ходит. Коррекция после финальности, если она понадобится, будет отдельным
 * явным recovery-контрактом, а не тихим переходом.
 *
 * ### Это НЕ статус площадки
 *
 * Вторая ось — {@link AccountFillRecord.venueStatus} — живёт отдельно и
 * типизирована canonical `TradeStatus`. Совпадают оси не всегда: сверка (#98)
 * откатит исполнение, которого на площадке не оказалось вовсе, и никакого
 * `FAILED` за таким `REVERTED` не стоит.
 */
export type AccountFillStatus = 'APPLIED' | 'CONFIRMED' | 'REVERTED';

/**
 * Статусы нашей оси, из которых исполнение уже не выходит.
 *
 * @remarks
 * `APPLIED` — единственный незавершённый статус: исполнение учтено в деньгах,
 * но чем оно кончится, ещё не решено. Оба остальных финальны, и переход между
 * ними запрещён в обе стороны.
 */
export const TERMINAL_FILL_STATUSES: ReadonlySet<AccountFillStatus> =
  new Set<AccountFillStatus>(['CONFIRMED', 'REVERTED']);

/**
 * Достигло ли исполнение статуса, из которого уже не выйдет.
 *
 * @param status - Статус исполнения на НАШЕЙ оси
 * @returns `true`, если статус финальный
 *
 * @example
 * ```typescript
 * isTerminalFillStatus('APPLIED');   // false
 * isTerminalFillStatus('REVERTED');  // true
 * ```
 */
export function isTerminalFillStatus(status: AccountFillStatus): boolean {
  return TERMINAL_FILL_STATUSES.has(status);
}

/**
 * Как поступить с требуемым переходом.
 *
 * @remarks
 * Форма намеренно совпадает с `classifyTradeStatusObservation` из
 * `@polymarket/fill`: обе оси отвечают на один вопрос — «применить, промолчать
 * или отказать». Совпадает не всё: у venue-оси есть `STALE`, потому что там
 * наблюдения приходят по сети и переупорядочиваются. Здесь `STALE` не бывает —
 * переход инициируем МЫ, и «запоздавшего» перехода не существует.
 */
export type AccountFillTransition =
  /** Переход допустим — применить */
  | 'ACCEPT'
  /** Целевой статус уже стоит — ничего не делать */
  | 'DUPLICATE'
  /** Исполнение уже финализировано ИНАЧЕ — отказать */
  | 'CONFLICT';

/**
 * Классифицирует требуемый переход по нашей оси исполнения.
 *
 * @param current - Текущий статус записи
 * @param target - Куда переходим: `CONFIRMED` или `REVERTED`
 * @returns Что обязан сделать вызывающий
 *
 * @remarks
 * Правило целиком:
 *
 * ```text
 * current == target              DUPLICATE
 * current == APPLIED             ACCEPT
 * иначе (оба финальны, разные)   CONFLICT
 * ```
 *
 * Дубликат — нормальная доставка, а не ошибка: одно и то же событие
 * приходит повторно, и повторное подтверждение уже подтверждённого ничего не
 * меняет. А вот `CONFIRMED → REVERTED` и обратный ему — настоящий конфликт:
 * финальность на то и финальность.
 *
 * Функция ничего не решает за вызывающего — не бросает и не логирует.
 *
 * @example
 * ```typescript
 * switch (classifyFillTransition(record.status, 'CONFIRMED')) {
 *   case 'ACCEPT':    return commit();
 *   case 'DUPLICATE': return Ok(undefined);
 *   case 'CONFLICT':  return Err(new AccountFillTransitionError(...));
 * }
 * ```
 */
export function classifyFillTransition(
  current: AccountFillStatus,
  target: Extract<AccountFillStatus, 'CONFIRMED' | 'REVERTED'>,
): AccountFillTransition {
  if (current === target) return 'DUPLICATE';
  return current === 'APPLIED' ? 'ACCEPT' : 'CONFLICT';
}

/**
 * Исполнение в приватном состоянии: canonical факт + runtime-жизненный цикл.
 *
 * @remarks
 * Два вида времени в записи различаются и не взаимозаменяемы:
 *
 * ```text
 * fill.timestamp                   КОГДА исполнение произошло на площадке
 * appliedAt/confirmedAt/revertedAt КОГДА рантайм принял соответствующее событие
 * venueStatusAt                    КОГДА рантайм принял наблюдение площадки
 * ```
 *
 * Времена перехода берутся из `event.metadata.createdAt`, а не из часов: иначе
 * повтор той же ленты событий давал бы другое состояние, и replay перестал бы
 * совпадать с торговлей.
 *
 * @example
 * ```typescript
 * const record = view.getAccount(venueId, accountId)?.getFill(fillId);
 * record?.status;        // → 'APPLIED'
 * record?.fill.price;    // canonical OutcomePrice исполнения
 * record?.appliedAt;     // metadata.createdAt события APPLIED
 * ```
 */
export interface AccountFillRecord {
  /** Canonical immutable факт исполнения */
  readonly fill: Fill;
  /** Что с этим фактом сделал наш рантайм */
  readonly status: AccountFillStatus;
  /**
   * Последний статус, о котором сообщила ПЛОЩАДКА.
   *
   * @remarks
   * Вторая, независимая ось (`MATCHED → MINED → CONFIRMED`, плюс `RETRYING` и
   * `FAILED`). `MATCHED` — матчер Polymarket, `MINED` — блок Polygon: разные
   * системы, разный риск отката.
   *
   * `undefined` означает «площадка ничего не сообщала» — норма для площадки
   * без on-chain расчётов, а не пропуск.
   *
   * Меняется ТОЛЬКО событием `TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED`:
   * экономические события эту ось не трогают.
   */
  readonly venueStatus?: TradeStatus;
  /** `metadata.createdAt` принятого `TRADING_ACCOUNT_FILL_APPLIED` */
  readonly appliedAt: Timestamp;
  /** `metadata.createdAt` принятого `TRADING_ACCOUNT_FILL_CONFIRMED` */
  readonly confirmedAt?: Timestamp;
  /** `metadata.createdAt` принятого `TRADING_ACCOUNT_FILL_REVERTED` */
  readonly revertedAt?: Timestamp;
  /** `metadata.createdAt` наблюдения, установившего {@link venueStatus} */
  readonly venueStatusAt?: Timestamp;
  /**
   * Причина отката, как её передал producer.
   *
   * @remarks
   * Проставляется ПЕРВЫМ принятым откатом и больше не меняется: повторная
   * доставка того же события — no-op, а не переписывание причины.
   */
  readonly revertReason?: string;
}

/**
 * Заявка в приватном состоянии: canonical `Order` + время последнего обновления.
 *
 * @remarks
 * Хранится сам domain-агрегат, а не его снимок: `status`, `filledSize`,
 * `averagePrice` и `fillIds` уже живут внутри `Order` и связаны его
 * инвариантами. Дублировать их полями записи значило бы завести второй
 * источник истины по состоянию собственной заявки.
 *
 * `marketId` в записи намеренно НЕТ: `Order` его не содержит, а добавить
 * поле без canonical producer'а значило бы придумать источник истины.
 * Рынок заявки определяется позже, при сборке торгового контекста, — через
 * `venueId` + `assetIdToInstrumentId(order.asset)` + владение инструментом в
 * рыночном состоянии.
 *
 * @example
 * ```typescript
 * const record = view.getAccount(venueId, accountId)?.getOrder(orderId);
 * record?.order.status;   // → 'PARTIALLY_FILLED'
 * record?.updatedAt;      // metadata.createdAt последнего принятого commit'а
 * ```
 */
export interface AccountOrderRecord {
  /** Canonical заявка в её текущем состоянии */
  readonly order: Order;
  /**
   * `metadata.createdAt` последнего принятого события, изменившего заявку.
   *
   * @remarks
   * Это НЕ `order.timestamp` (момент создания заявки) и не показания часов.
   */
  readonly updatedAt: Timestamp;
}

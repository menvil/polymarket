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
import type { Fill } from '@polymarket/fill';
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
 * Коррекция после финальности, если она понадобится, будет отдельным явным
 * recovery-контрактом, а не тихим переходом.
 */
export type AccountFillStatus = 'APPLIED' | 'CONFIRMED' | 'REVERTED';

/**
 * Исполнение в приватном состоянии: canonical факт + runtime-жизненный цикл.
 *
 * @remarks
 * Два вида времени в записи различаются и не взаимозаменяемы:
 *
 * ```text
 * fill.timestamp                   КОГДА исполнение произошло на площадке
 * appliedAt/confirmedAt/revertedAt КОГДА рантайм принял соответствующее событие
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
  /** `metadata.createdAt` принятого `TRADING_ACCOUNT_FILL_APPLIED` */
  readonly appliedAt: Timestamp;
  /** `metadata.createdAt` принятого `TRADING_ACCOUNT_FILL_CONFIRMED` */
  readonly confirmedAt?: Timestamp;
  /** `metadata.createdAt` принятого `TRADING_ACCOUNT_FILL_REVERTED` */
  readonly revertedAt?: Timestamp;
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

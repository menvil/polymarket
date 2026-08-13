/**
 * ReconcileUnknownSubmissionsUseCase — DISCOVERY-ONLY обнаружение venue-кандидатов
 * для ambiguous submissions без venueOrderId.
 *
 * @remarks
 * ### Fail-closed политика (safety-first):
 * Эвристическое совпадение по instrument/side/price/size/time — это ПОДСКАЗКА
 * оператору, а НЕ доказательство. Пустой ответ `getOpenOrders()+getTrades()` —
 * НЕ доказательство отсутствия заявки (API может отставать/фильтровать).
 * Поэтому этот use case НИКОГДА автоматически не вызывает:
 * - `markVenueAccepted()` (bind);
 * - Portfolio release;
 * - journal release/settlement;
 * - `submissions.markFailed()`;
 * - `clearManualReconciliationBlock()`.
 *
 * Для КАЖДОЙ UNKNOWN-записи без venueOrderId reservation остаётся held,
 * manual block остаётся активным, авто-retry submit запрещён. Единственный
 * выход — явное операторское решение через `ResolveUnknownSubmissionUseCase`
 * (bind конкретного venueOrderId либо подтверждённое отсутствие).
 *
 * ### Что делает discovery:
 * UNKNOWN submissions → поиск возможных venue-кандидатов (open orders + trades)
 * → структурированные findings + идемпотентные issues для оператора:
 * - один кандидат → `HEURISTIC_CANDIDATE_FOUND`;
 * - несколько → `AMBIGUOUS_VENUE_MATCH`;
 * - ни одного (оба API доступны) → `NO_CANDIDATE_INCONCLUSIVE`;
 * - venue API недоступен → `VENUE_LOOKUP_INCOMPLETE`.
 * Во всех случаях состояние (reservation/journal/block) НЕ изменяется.
 *
 * Повторный запуск идемпотентен по issues: id детерминированы по clientOrderId
 * (без per-run компонентов), `add()` не создаёт дублей.
 *
 * @example
 * ```typescript
 * const discovery = new ReconcileUnknownSubmissionsUseCase({
 *   submissions, exchangeClient, clock, logger, reconciliationIssues,
 * });
 * const r = await discovery.execute({ accountId });
 * if (r.ok) {
 *   for (const f of r.value.findings) {
 *     // f.outcome + f.candidates → операторский тулинг / ResolveUnknownSubmissionUseCase
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, OrderId } from '@polymarket/ids';
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import type {
  IExchangeClient,
  IOrderSubmissionRepository,
  IReconciliationIssueRepository,
  OrderSubmissionRecord,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
} from '@polymarket/ports';

/** Входные данные ReconcileUnknownSubmissionsUseCase. */
export interface ReconcileUnknownSubmissionsInput {
  /** ID аккаунта, для которого выполняется discovery */
  readonly accountId: AccountId;
}

/**
 * Структурированный venue-кандидат для UNKNOWN submission.
 *
 * @remarks
 * `kind` позволяет оператору различать live order и уже исполненный trade —
 * их recovery-пути различаются (см. `ResolveUnknownSubmissionUseCase`).
 */
export type UnknownSubmissionCandidate =
  | {
      readonly kind: 'OPEN_ORDER';
      readonly venueOrderId: OrderId;
      readonly snapshot: OpenOrderSnapshot;
    }
  | {
      readonly kind: 'TRADE';
      readonly venueOrderId: OrderId;
      readonly trade: VenueTradeSnapshot;
    };

/** Исход discovery для одной UNKNOWN-записи. */
export type UnknownSubmissionDiscoveryOutcome =
  | 'HEURISTIC_CANDIDATE_FOUND'
  | 'AMBIGUOUS_VENUE_MATCH'
  | 'NO_CANDIDATE_INCONCLUSIVE'
  | 'VENUE_LOOKUP_INCOMPLETE';

/** Finding по одной UNKNOWN-записи (для операторского тулинга). */
export interface UnknownSubmissionFinding {
  readonly clientOrderId: OrderId;
  readonly outcome: UnknownSubmissionDiscoveryOutcome;
  readonly candidates: readonly UnknownSubmissionCandidate[];
}

/** Итог одного discovery-прогона (без каких-либо мутаций состояния). */
export interface ReconcileUnknownSubmissionsSummary {
  /** Сколько UNKNOWN-записей без venueOrderId рассмотрено */
  readonly scanned: number;
  /** У скольких найден ровно один эвристический кандидат */
  readonly candidatesFound: number;
  /** У скольких несколько кандидатов */
  readonly ambiguous: number;
  /** У скольких кандидатов нет (оба venue API доступны) */
  readonly noCandidates: number;
  /** У скольких lookup неполон (venue API недоступен) */
  readonly incomplete: number;
  /** Findings по каждой записи */
  readonly findings: readonly UnknownSubmissionFinding[];
}

/** Зависимости ReconcileUnknownSubmissionsUseCase. */
export interface ReconcileUnknownSubmissionsDeps {
  readonly submissions: IOrderSubmissionRepository;
  readonly exchangeClient: IExchangeClient;
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Допустимый clock-skew (мс) при сравнении времени venue-ордера/trade с
   * createdAt submission (default 120_000). Информационный фильтр кандидатов.
   */
  readonly matchTimeSkewMs?: number;
}

const DEFAULT_MATCH_TIME_SKEW_MS = 120_000;

/**
 * Use case discovery UNKNOWN submissions (без автоматических решений).
 *
 * @remarks
 * Вызывается периодически (reconciliation loop live-бота) и после WS reconnect.
 * Работает независимо от наличия локальных Order.
 */
export class ReconcileUnknownSubmissionsUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: ReconcileUnknownSubmissionsDeps) {
    this._logger = _deps.logger.child({ component: 'ReconcileUnknownSubmissionsUseCase' });
  }

  /**
   * Выполняет один discovery-прогон.
   *
   * @param input - `accountId`
   * @returns Ok(summary с findings); Err только при сбое чтения submissions
   *
   * @throws Не бросает — ошибки возвращаются через Result
   *
   * @remarks
   * НИКАКИХ мутаций состояния: reservation, journal, manual blocks и submission
   * статусы остаются как есть при любом исходе.
   */
  public async execute(
    input: ReconcileUnknownSubmissionsInput,
  ): Promise<Result<ReconcileUnknownSubmissionsSummary, TradingError>> {
    const accountKey = (id: AccountId): string => (typeof id === 'string' ? id : accountIdToString(id));

    let unknownRecords: readonly OrderSubmissionRecord[];
    try {
      unknownRecords = await this._deps.submissions.listByStatus('UNKNOWN');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(`Failed to list UNKNOWN submissions: ${message}`, {}));
    }
    // Только записи ЭТОГО аккаунта и БЕЗ venueOrderId (записи с venueOrderId
    // fill находит сам через findByVenueOrderId — discovery не нужен).
    const targets = unknownRecords.filter(
      (r) => r.venueOrderId === undefined && accountKey(r.accountId) === accountKey(input.accountId),
    );
    if (targets.length === 0) {
      return Ok({ scanned: 0, candidatesFound: 0, ambiguous: 0, noCandidates: 0, incomplete: 0, findings: [] });
    }

    // Снимок venue-состояния (best-effort; недоступность любого источника
    // делает вывод «кандидатов нет» неполным — VENUE_LOOKUP_INCOMPLETE).
    let openOrders: readonly OpenOrderSnapshot[] = [];
    let openOrdersAvailable = false;
    try {
      const openResult = await this._deps.exchangeClient.getOpenOrders(input.accountId);
      if (openResult.ok) {
        openOrders = openResult.value;
        openOrdersAvailable = true;
      } else {
        this._logger.warn('Open orders fetch failed during unknown-submission discovery', {
          error: openResult.error.message,
        });
      }
    } catch (err) {
      this._logger.warn('Open orders fetch threw during unknown-submission discovery', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    let trades: readonly VenueTradeSnapshot[] = [];
    let tradesAvailable = false;
    try {
      const tradesResult = await this._deps.exchangeClient.getTrades(input.accountId);
      if (tradesResult.ok) {
        trades = tradesResult.value;
        tradesAvailable = true;
      } else {
        this._logger.warn('Trades fetch failed during unknown-submission discovery', {
          error: tradesResult.error.message,
        });
      }
    } catch (err) {
      this._logger.warn('Trades fetch threw during unknown-submission discovery', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    const lookupComplete = openOrdersAvailable && tradesAvailable;
    const findings: UnknownSubmissionFinding[] = [];
    const summary = { scanned: 0, candidatesFound: 0, ambiguous: 0, noCandidates: 0, incomplete: 0 };

    for (const record of targets) {
      summary.scanned++;
      const candidates = await this._matchCandidates(record, openOrders, trades);

      let outcome: UnknownSubmissionDiscoveryOutcome;
      if (candidates.length === 1) {
        outcome = 'HEURISTIC_CANDIDATE_FOUND';
        summary.candidatesFound++;
      } else if (candidates.length > 1) {
        outcome = 'AMBIGUOUS_VENUE_MATCH';
        summary.ambiguous++;
      } else if (lookupComplete) {
        outcome = 'NO_CANDIDATE_INCONCLUSIVE';
        summary.noCandidates++;
      } else {
        outcome = 'VENUE_LOOKUP_INCOMPLETE';
        summary.incomplete++;
      }

      findings.push({ clientOrderId: record.clientOrderId, outcome, candidates });
      this._logger.warn('Unknown submission discovery finding (NO automatic action taken — operator resolution required)', {
        clientOrderId: String(record.clientOrderId),
        outcome,
        candidates: candidates.map((c) => `${c.kind}:${String(c.venueOrderId)}`),
        reservationStatus: record.reservation.status,
        reservationRemaining: record.reservation.remaining,
      });
      await this._addDiscoveryIssue(record, outcome, candidates);
    }

    this._logger.info('Unknown-submission discovery run completed (discovery-only, no state mutated)', { ...summary });
    return Ok({ ...summary, findings });
  }

  /**
   * Эвристическое сопоставление записи с venue open orders/trades.
   *
   * @param record - UNKNOWN-запись без venueOrderId
   * @param openOrders - Снимок open orders
   * @param trades - Снимок trades
   * @returns Структурированные кандидаты (после всех фильтров)
   *
   * @remarks
   * Критерии-ПОДСКАЗКИ (совпадение НЕ является доказательством):
   * - инструмент: `assetIdToInstrumentId(asset) === record.instrumentId`;
   * - сторона: `side === record.side`;
   * - цена: точное Decimal-равенство с `record.orderPrice`;
   * - размер (только open orders): полный `size` равен `requestedSize`
   *   (trades могут быть частичными — size не сверяется);
   * - время: `createdAt`/`executedAt >= record.createdAt − skew`;
   * - venueOrderId НЕ привязан к другой submission (`findByVenueOrderId`).
   */
  private async _matchCandidates(
    record: OrderSubmissionRecord,
    openOrders: readonly OpenOrderSnapshot[],
    trades: readonly VenueTradeSnapshot[],
  ): Promise<readonly UnknownSubmissionCandidate[]> {
    const skewMs = this._deps.matchTimeSkewMs ?? DEFAULT_MATCH_TIME_SKEW_MS;
    const notBeforeMs = record.createdAt.getTime() - skewMs;
    const price = new Decimal(record.orderPrice);
    const requestedSize = new Decimal(record.requestedSize);
    const instrumentKey = String(record.instrumentId);

    const seen = new Set<string>();
    const candidates: UnknownSubmissionCandidate[] = [];

    const isBindable = async (venueOrderId: OrderId): Promise<boolean> => {
      const key = String(venueOrderId);
      if (seen.has(key)) return false;
      // venueOrderId, уже привязанный к ЛЮБОЙ submission (включая чужую), — не кандидат.
      const bound = await this._deps.submissions.findByVenueOrderId(venueOrderId);
      if (bound) return false;
      seen.add(key);
      return true;
    };

    for (const order of openOrders) {
      const instrumentId = assetIdToInstrumentId(order.asset);
      if (!instrumentId || String(instrumentId) !== instrumentKey) continue;
      if (order.side !== record.side) continue;
      if (!order.price.value().equals(price)) continue;
      if (!order.size.value().equals(requestedSize)) continue;
      if (order.createdAt.toNumber() < notBeforeMs) continue;
      if (await isBindable(order.orderId)) {
        candidates.push({ kind: 'OPEN_ORDER', venueOrderId: order.orderId, snapshot: order });
      }
    }

    for (const trade of trades) {
      const instrumentId = assetIdToInstrumentId(trade.asset);
      if (!instrumentId || String(instrumentId) !== instrumentKey) continue;
      if (trade.side !== record.side) continue;
      if (!trade.price.value().equals(price)) continue;
      if (trade.executedAt.toNumber() < notBeforeMs) continue;
      if (await isBindable(trade.orderId)) {
        candidates.push({ kind: 'TRADE', venueOrderId: trade.orderId, trade });
      }
    }

    return candidates;
  }

  /**
   * Идемпотентная discovery-issue для оператора.
   *
   * @param record - UNKNOWN-запись
   * @param outcome - Исход discovery
   * @param candidates - Найденные кандидаты
   *
   * @remarks
   * Id детерминирован ТОЛЬКО по clientOrderId (`…:unknown-discovery`) — один
   * unresolved случай не создаёт новых issues при повторных прогонах;
   * актуальный outcome/кандидаты — в context (и в логах каждого прогона).
   */
  private async _addDiscoveryIssue(
    record: OrderSubmissionRecord,
    outcome: UnknownSubmissionDiscoveryOutcome,
    candidates: readonly UnknownSubmissionCandidate[],
  ): Promise<void> {
    if (!this._deps.reconciliationIssues) return;
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:submit-client:${String(record.clientOrderId)}:unknown-discovery`,
        type: 'SUBMIT_UNKNOWN_OUTCOME',
        status: 'OPEN',
        reason: `UNKNOWN_SUBMISSION_DISCOVERY: ${outcome} — operator resolution required (ResolveUnknownSubmissionUseCase)`,
        createdAt: this._deps.clock.now(),
        accountId: record.accountId,
        instrumentId: record.instrumentId,
        context: {
          clientOrderId: String(record.clientOrderId),
          outcome,
          candidates: candidates.map((c) => `${c.kind}:${String(c.venueOrderId)}`).join(',') || 'none',
          reservationStatus: record.reservation.status,
          reservationRemaining: record.reservation.remaining,
        },
      });
    } catch (err) {
      this._logger.error('Failed to add discovery issue for unknown submission', {
        clientOrderId: String(record.clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}

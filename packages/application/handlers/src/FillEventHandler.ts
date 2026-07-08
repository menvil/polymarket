/**
 * FillEventHandler — обрабатывает fill-события из Polymarket WS user-channel.
 *
 * @remarks
 * Получает raw fill-событие (WsUserFillDto или совместимый Record),
 * маршрутизирует по статусу WsFillStatus:
 *
 * - MATCHED   → парсит Fill(s), публикует FILL_RECEIVED немедленно.
 *   Portfolio обновляется сразу — стратегия может выставить SELL.
 *   Если CLOB отклонит SELL (cross-outcome mint, finality не достигнута),
 *   ExecutionEngine установит rejection cooldown, retry на следующем тике.
 *   Fills кэшируются в `_pendingFills` для потенциального отката при FAILED.
 *
 * - MINED     → логируем, ждём finality. Fills уже обработаны при MATCHED.
 *
 * - CONFIRMED → finality достигнута. Если fill уже опубликован при MATCHED —
 *   просто очищаем кэш (rollback больше не нужен). Если MATCHED был пропущен
 *   (рестарт бота) — fallback: парсим из raw и публикуем FILL_RECEIVED.
 *   ProcessFillUseCase idempotency guard обеспечивает «exactly once» обработку.
 *
 * - FAILED    → публикует FILL_FAILED с кэшированными fills для отката Portfolio.
 *   FillOrchestrator вызовет PortfolioService.reverseFill() для каждого fill.
 *
 * - остальные → логирует trace, игнорирует (RETRYING и т.д.)
 *
 * ### Multi-maker fills:
 * В cross-outcome trades один WS-event может содержать несколько наших maker_orders
 * (cancel-and-replace race, лестница ордеров). `FillMapper.allFromPolymarketTradeEvent()`
 * создаёт отдельный Fill для каждого нашего ордера. Все fills кэшируются и публикуются
 * независимо.
 *
 * ### Двухуровневая дедупликация fills:
 * Система защищена от двойной обработки на двух уровнях:
 *
 * **Уровень 1 — FillEventHandler (_publishedRawIds)**:
 * Предотвращает двойную публикацию FILL_RECEIVED в EventBus.
 * MATCHED публикует fill и добавляет rawId в `_publishedRawIds`.
 * CONFIRMED проверяет `_publishedRawIds` — если rawId уже там, публикует
 * только FILL_CONFIRMED (не повторяет FILL_RECEIVED).
 * Сброс при FAILED (fill откатывается, ID удаляется из set).
 *
 * **Уровень 2 — ProcessFillUseCase (IProcessedFillRepository.begin/markApplied/markFailed/markReconciliationRequired)**:
 * Idempotency guard на уровне обработки fill в use-case (state machine
 * PROCESSING/APPLIED/FAILED/REVERTED/RECONCILIATION_REQUIRED).
 * Даже если FILL_RECEIVED будет опубликован дважды (WS reconnect race, два FillEventHandler),
 * ProcessFillUseCase пропустит повторный fill через `begin()` (DUPLICATE/BUSY/RECONCILIATION_REQUIRED).
 * Атомарна — не нужна внешняя координация между экземплярами.
 *
 * Уровень 1 защищает от дублирования в нормальном flow (MATCHED→CONFIRMED).
 * Уровень 2 защищает от дублирования при аномальных сценариях (рестарт, race).
 *
 * ### Ответственность:
 * - НЕ обновляет Portfolio (это задача ProcessFillUseCase через FillOrchestrator)
 * - Кеш pending fills — in-memory, живёт до CONFIRMED/FAILED или рестарта бота
 * - Только маршрутизация по статусу и публикация событий
 *
 * @example
 * ```typescript
 * const handler = new FillEventHandler(eventBus, clock, logger);
 *
 * wsEmitter.onUserFill(async (dto) => {
 *   await handler.handle(dto as Record<string, unknown>, accountId);
 * });
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId } from '@polymarket/ids';
import { asFillId, asOrderId } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import { FillMapper } from '@polymarket/fill';
import { TimestampService } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';

/** Статусы, при которых парсим, кешируем и ПУБЛИКУЕМ Fill (Portfolio обновляется сразу) */
const FILL_PUBLISH_ON_MATCH_STATUSES = new Set(['MATCHED']);
/** Статус включения в блок — fill уже обработан при MATCHED, ждём finality */
const FILL_HOLD_STATUSES = new Set(['MINED']);
/** Статус finality — fallback-публикация если MATCHED был пропущен, иначе cleanup кеша */
const FILL_CONFIRM_STATUSES = new Set(['CONFIRMED']);
/** Статусы, сигнализирующие об ошибке исполнения */
const FILL_FAILED_STATUSES = new Set(['FAILED']);

export class FillEventHandler {
  /**
   * Кеш распарсенных fills, ожидающих on-chain подтверждения.
   * Ключ — rawId (UUID трейда из WS). Значение — массив fills (>1 при multi-maker).
   * Заполняется при MATCHED, очищается при CONFIRMED или FAILED.
   *
   * @remarks
   * При FAILED кэшированные fills передаются в FILL_FAILED событие
   * для отката Portfolio (PortfolioService.reverseFill).
   */
  private readonly _pendingFills = new Map<string, Fill[]>();

  /**
   * Множество уже опубликованных rawId.
   * Защита от дублирования: MATCHED публикует fill, CONFIRMED не должен повторять.
   * Без дедупликации двойная публикация вызывает двойную реакцию стратегии.
   */
  private readonly _publishedRawIds = new Set<string>();

  /**
   * Создаёт FillEventHandler.
   *
   * @param _eventBus - Event bus для публикации FILL_RECEIVED / FILL_FAILED
   * @param _clock - Источник времени (receivedAt)
   * @param _logger - Logger
   */
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _clock: IClock,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Обрабатывает raw fill-событие из Polymarket WS user-channel.
   *
   * @param raw - Raw fill-событие (Record<string, unknown>)
   * @param accountId - AccountId пользователя (из сессионного контекста)
   *
   * @remarks
   * Алгоритм:
   * 1. Извлекаем status из raw (WsFillStatus)
   * 2. MATCHED   → парсим Fill(s), кешируем, публикуем FILL_RECEIVED немедленно
   * 3. MINED     → логируем, ожидаем finality (fill уже обработан)
   * 4. CONFIRMED → fallback-публикация если MATCHED пропущен, иначе cleanup кеша
   * 5. FAILED    → публикуем FILL_FAILED с fills для отката Portfolio
   * 6. Остальные (RETRYING и т.д.) → trace-лог, игнорируем
   */
  public async handle(raw: Record<string, unknown>, accountId: AccountId): Promise<void> {
    const status = typeof raw['status'] === 'string' ? raw['status'] : 'UNKNOWN';
    const rawId = typeof raw['id'] === 'string' ? raw['id'] : 'unknown';

    if (FILL_FAILED_STATUSES.has(status)) {
      await this._handleFailedFill(raw, rawId);
      return;
    }

    if (FILL_PUBLISH_ON_MATCH_STATUSES.has(status)) {
      await this._handleMatchedFill(raw, accountId, rawId);
      return;
    }

    if (FILL_HOLD_STATUSES.has(status)) {
      // MINED: fill уже обработан при MATCHED, ожидаем finality.
      this._logger.debug('Fill MINED — already processed at MATCHED, waiting for CONFIRMED', { rawId });
      return;
    }

    if (FILL_CONFIRM_STATUSES.has(status)) {
      await this._handleConfirmedFill(raw, accountId, rawId);
      return;
    }

    // RETRYING и прочие неизвестные статусы — игнорируем
    this._logger.trace('Fill event ignored (non-primary status)', { status, rawId });
  }

  /**
   * Парсит, кеширует и публикует fill(s) при статусе MATCHED.
   *
   * @param raw - Raw fill-событие
   * @param accountId - AccountId пользователя
   * @param rawId - ID события для логирования
   *
   * @remarks
   * Публикует FILL_RECEIVED немедленно — стратегия может начать SELL.
   * Fills остаются в _pendingFills для потенциального отката при FAILED.
   * При multi-maker trade кэшируется и публикуется массив fills.
   */
  private async _handleMatchedFill(
    raw: Record<string, unknown>,
    accountId: AccountId,
    rawId: string,
  ): Promise<void> {
    const result = FillMapper.allFromPolymarketTradeEvent(raw, accountId);
    if (!result.ok) {
      this._logger.error('Failed to parse fill event', {
        error: result.error.message,
        rawId,
      });
      return;
    }

    const fills = result.value.map((r) => r.fill);

    // Кешируем для потенциального FAILED отката
    this._pendingFills.set(rawId, fills);

    if (fills.length > 1) {
      this._logger.info('Multi-maker fill matched — publishing all fills immediately', {
        rawId,
        fillCount: fills.length,
        orderIds: fills.map((f) => String(f.orderId)),
      });
    }

    // Публикуем FILL_RECEIVED немедленно — не ждём CONFIRMED
    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create receivedAt timestamp', {
        error: tsResult.error.message,
      });
      return;
    }

    for (const fill of fills) {
      await this._eventBus.publish({
        type: 'FILL_RECEIVED',
        fill,
        receivedAt: tsResult.value,
      });

      this._logger.info('Fill published on MATCHED (early processing)', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        side: fill.side,
        size: fill.size.toNumber(),
        price: fill.price.toNumber(),
      });
    }

    this._publishedRawIds.add(rawId);
  }

  /**
   * Обрабатывает fill при статусе CONFIRMED (finality достигнута).
   *
   * @param raw - Raw fill-событие
   * @param accountId - AccountId пользователя
   * @param rawId - ID fill-события
   *
   * @remarks
   * ### Нормальный flow (MATCHED → CONFIRMED):
   * Fill уже опубликован при MATCHED. Очищаем _pendingFills — откат больше не нужен.
   *
   * ### Fallback (MATCHED пропущен, например рестарт бота):
   * Парсим fill из raw и публикуем FILL_RECEIVED.
   * ProcessFillUseCase idempotency guard (`begin()`/`markApplied()`) предотвращает двойную обработку.
   */
  private async _handleConfirmedFill(
    raw: Record<string, unknown>,
    accountId: AccountId,
    rawId: string,
  ): Promise<void> {
    // Нормальный flow: fill уже опубликован при MATCHED
    if (this._publishedRawIds.has(rawId)) {
      // Finality достигнута — откат невозможен.
      // Публикуем FILL_CONFIRMED чтобы:
      // 1. Сбросить exchange rejection cooldown (токены теперь on-chain, SELL безопасен)
      // 2. Тригернуть стратегию на retry SELL (после cross-outcome mint rejection)
      const confirmedFills = this._pendingFills.get(rawId);
      this._pendingFills.delete(rawId);

      if (confirmedFills && confirmedFills.length > 0) {
        const tsResult = TimestampService.fromDate(this._clock.now());
        if (tsResult.ok) {
          await this._eventBus.publish({
            type: 'FILL_CONFIRMED',
            fills: confirmedFills,
            receivedAt: tsResult.value,
          });
        }
      }

      this._logger.debug('Fill CONFIRMED — on-chain finality, FILL_CONFIRMED published', { rawId });
      return;
    }

    // Fallback: MATCHED был пропущен (рестарт бота, WS reconnect).
    // Публикуем FILL_RECEIVED — ProcessFillUseCase idempotency guard обработает корректно.
    this._logger.info('Fill CONFIRMED without prior MATCHED — fallback publish', { rawId });

    let fills = this._pendingFills.get(rawId);

    if (fills) {
      this._pendingFills.delete(rawId);
    } else {
      const result = FillMapper.allFromPolymarketTradeEvent(raw, accountId);
      if (!result.ok) {
        this._logger.error('Failed to parse fill event', {
          error: result.error.message,
          rawId,
          status: 'CONFIRMED',
        });
        return;
      }
      fills = result.value.map((r) => r.fill);
    }

    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create receivedAt timestamp', {
        error: tsResult.error.message,
      });
      return;
    }

    for (const fill of fills) {
      await this._eventBus.publish({
        type: 'FILL_RECEIVED',
        fill,
        receivedAt: tsResult.value,
      });

      this._logger.info('Fill event published (CONFIRMED fallback)', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
      });
    }

    this._publishedRawIds.add(rawId);
  }

  /**
   * Обрабатывает fill со статусом FAILED — ошибка исполнения on-chain.
   *
   * @param raw - Raw fill-событие
   * @param rawId - ID события для логирования
   *
   * @remarks
   * Публикует FILL_FAILED для отката Portfolio.
   * Если fills закэшированы при MATCHED — передаёт их в событии для reversal.
   * Удаляет fills из кэша (_pendingFills).
   */
  private async _handleFailedFill(raw: Record<string, unknown>, rawId: string): Promise<void> {
    // Достаём кэшированные fills для отката Portfolio
    const cachedFills = this._pendingFills.get(rawId);
    if (cachedFills) {
      this._pendingFills.delete(rawId);
      this._logger.warn('Failed fill has cached fills for rollback', {
        rawId,
        fillCount: cachedFills.length,
      });
    }

    // Убираем из published — fill провалился
    this._publishedRawIds.delete(rawId);

    const fillId = asFillId(rawId);
    if (!fillId) {
      this._logger.warn('Failed fill has unparseable fillId, skipping FILL_FAILED event', { rawId });
      return;
    }

    // Для TAKER: orderId из taker_order_id
    // Для MAKER: может быть несколько ордеров — публикуем FILL_FAILED для каждого
    const traderSide = typeof raw['trader_side'] === 'string' ? raw['trader_side'] : '';
    const makerAddressRaw = raw['maker_address'];
    const ownerRaw = raw['owner'];

    if (traderSide === 'MAKER') {
      // Находим все наши maker_orders и публикуем FILL_FAILED для каждого
      const makerOrdersRaw = raw['maker_orders'];
      const makerOrders = Array.isArray(makerOrdersRaw) ? makerOrdersRaw : [];

      const tsResult = TimestampService.fromDate(this._clock.now());
      if (!tsResult.ok) {
        this._logger.error('Failed to create receivedAt timestamp for failed fill', {
          error: tsResult.error.message,
        });
        return;
      }

      let publishedCount = 0;
      for (const mo of makerOrders) {
        if (mo === null || typeof mo !== 'object') continue;
        const entry = mo as Record<string, unknown>;

        // Проверяем что это наш ордер (по owner UUID или maker_address)
        let isOurs = false;
        if (typeof ownerRaw === 'string' && ownerRaw.length > 0 && entry['owner'] === ownerRaw) {
          isOurs = true;
        }
        if (
          !isOurs &&
          typeof makerAddressRaw === 'string' &&
          makerAddressRaw.length > 0 &&
          typeof entry['maker_address'] === 'string' &&
          (entry['maker_address'] as string).toLowerCase() === makerAddressRaw.toLowerCase()
        ) {
          isOurs = true;
        }

        if (!isOurs) continue;

        const orderIdRaw = typeof entry['order_id'] === 'string' ? entry['order_id'] : '';
        const orderId = asOrderId(orderIdRaw);
        if (!orderId) continue;

        const effectiveFillId = asFillId(`${rawId}:${orderIdRaw}`) ?? fillId;

        await this._eventBus.publish({
          type: 'FILL_FAILED',
          fillId: effectiveFillId,
          orderId,
          receivedAt: tsResult.value,
          fills: cachedFills,
        });
        publishedCount++;
      }

      if (publishedCount > 0) {
        this._logger.warn('Fill failed events published (maker)', {
          rawId,
          count: publishedCount,
        });
      } else {
        this._logger.warn('Failed fill: no matching maker_orders found', { rawId });
      }
      return;
    }

    // TAKER path: один orderId
    const rawOrderId = typeof raw['taker_order_id'] === 'string' ? raw['taker_order_id'] : '';
    const orderId = asOrderId(rawOrderId);
    if (!orderId) {
      this._logger.warn('Failed fill has unparseable orderId, skipping FILL_FAILED event', { rawId, rawOrderId });
      return;
    }

    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create receivedAt timestamp for failed fill', {
        error: tsResult.error.message,
      });
      return;
    }

    await this._eventBus.publish({
      type: 'FILL_FAILED',
      fillId,
      orderId,
      receivedAt: tsResult.value,
      fills: cachedFills,
    });

    this._logger.warn('Fill failed event published', { fillId, orderId, hasFillsForRollback: !!cachedFills });
  }
}

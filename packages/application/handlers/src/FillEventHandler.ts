/**
 * FillEventHandler — обрабатывает fill-события из Polymarket WS user-channel.
 *
 * @remarks
 * Получает raw fill-событие (WsUserFillDto или совместимый Record),
 * маршрутизирует по статусу WsFillStatus:
 *
 * - MATCHED   → парсит Fill, кеширует в `_pendingFills`, НЕ публикует.
 *   Токены ещё не на блокчейне — стратегия не должна пытаться продавать.
 *
 * - MINED     → держим fill в кеше, НЕ публикуем, ждём CONFIRMED.
 *   Токены включены в блок, но finality не достигнута.
 *   Для cross-outcome mint-сделок (обе стороны BUY) CLOB отклоняет SELL
 *   до CONFIRMED — публикация при MINED вызывает спам rejection-ов.
 *   Для обычных (transfer) сделок CONFIRMED приходит через 2-5 секунд,
 *   потеря скорости незначительна по сравнению с 5-минутными маркетами.
 *
 * - CONFIRMED → достаёт Fill из кеша (или парсит из raw при отсутствии),
 *   публикует FILL_RECEIVED. Токены finalized on-chain — SELL безопасен.
 *
 * - FAILED    → публикует FILL_FAILED (требует reconciliation)
 * - остальные → логирует trace, игнорирует (RETRYING и т.д.)
 *
 * ### Ответственность:
 * - НЕ обновляет Portfolio (это задача ProcessFillUseCase через FillOrchestrator)
 * - Кеш pending fills — in-memory, живёт до CONFIRMED или рестарта бота
 * - Только маршрутизация по статусу и публикация событий
 *
 * ### Почему только CONFIRMED (не MINED):
 * На Polymarket cross-outcome BUY (обе стороны покупают) = минтинг новых токенов.
 * Свежеминченные токены доступны для торговли только после finality (CONFIRMED).
 * CLOB возвращает "not enough balance/allowance" при SELL пока статус MINED.
 * Обычные transfer-fills (REDEEM) также ждут CONFIRMED — задержка 2-5 секунд
 * при 5-минутных маркетах несущественна.
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

/** Статусы, при которых парсим и кешируем Fill (но НЕ публикуем) */
const FILL_PARSE_STATUSES = new Set(['MATCHED']);
/** Статус включения в блок — держим fill в кеше, НЕ публикуем, ждём CONFIRMED */
const FILL_HOLD_STATUSES = new Set(['MINED']);
/** Статусы finality: публикуем кешированный Fill */
const FILL_PUBLISH_STATUSES = new Set(['CONFIRMED']);
/** Статусы, сигнализирующие об ошибке исполнения */
const FILL_FAILED_STATUSES = new Set(['FAILED']);

export class FillEventHandler {
  /**
   * Кеш распарсенных fills, ожидающих on-chain подтверждения.
   * Ключ — строковый fillId. Заполняется при MATCHED, очищается при CONFIRMED.
   */
  private readonly _pendingFills = new Map<string, Fill>();

  /**
   * Множество уже опубликованных fillId.
   * Защита от дублирования: Polymarket может присылать CONFIRMED несколько раз.
   * Без дедупликации FillEventHandler публиковал бы FILL_RECEIVED повторно
   * (fallback-парсинг при отсутствии в кеше), что могло вызвать двойную реакцию стратегии:
   * «SELL подтверждён» → новый BUY → совместно с уже ожидающим BUY = две покупки, один SELL.
   */
  private readonly _publishedFillIds = new Set<string>();

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
   * 2. MATCHED  → парсим Fill, кешируем в _pendingFills (НЕ публикуем)
   * 3. MINED / CONFIRMED → достаём Fill из кеша, публикуем FILL_RECEIVED
   * 4. FAILED   → публикуем FILL_FAILED (без парсинга Fill — транзакция упала)
   * 5. Остальные (RETRYING и т.д.) → trace-лог, игнорируем
   */
  public async handle(raw: Record<string, unknown>, accountId: AccountId): Promise<void> {
    const status = typeof raw['status'] === 'string' ? raw['status'] : 'UNKNOWN';
    const rawId = typeof raw['id'] === 'string' ? raw['id'] : 'unknown';

    if (FILL_FAILED_STATUSES.has(status)) {
      await this._handleFailedFill(raw, rawId);
      return;
    }

    if (FILL_PARSE_STATUSES.has(status)) {
      this._cacheMatchedFill(raw, accountId, rawId);
      return;
    }

    if (FILL_HOLD_STATUSES.has(status)) {
      // MINED: токены в блоке, но finality ещё не достигнута.
      // Cross-outcome MINT fills (обе стороны BUY) — SELL отклоняется CLOB до CONFIRMED.
      // Держим fill в кеше (_pendingFills уже заполнен при MATCHED), ждём CONFIRMED.
      this._logger.debug('Fill MINED — holding for CONFIRMED', { rawId });
      return;
    }

    if (FILL_PUBLISH_STATUSES.has(status)) {
      await this._publishCachedOrParsedFill(raw, accountId, rawId, status);
      return;
    }

    // RETRYING и прочие неизвестные статусы — игнорируем
    this._logger.trace('Fill event ignored (non-primary status)', { status, rawId });
  }

  /**
   * Парсит и кеширует fill при статусе MATCHED.
   *
   * @param raw - Raw fill-событие
   * @param accountId - AccountId пользователя
   * @param rawId - ID события для логирования
   *
   * @remarks
   * НЕ публикует FILL_RECEIVED — токены ещё не on-chain.
   * Стратегия не должна получать сигнал до MINED/CONFIRMED.
   */
  private _cacheMatchedFill(
    raw: Record<string, unknown>,
    accountId: AccountId,
    rawId: string,
  ): void {
    const result = FillMapper.fromPolymarketTradeEvent(raw, accountId);
    if (!result.ok) {
      this._logger.error('Failed to parse fill event', {
        error: result.error.message,
        rawId,
      });
      return;
    }

    const { fill } = result.value;
    this._pendingFills.set(rawId, fill);
    this._logger.debug('Fill cached, waiting for on-chain confirmation', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
    });
  }

  /**
   * Публикует fill при статусе MINED или CONFIRMED.
   *
   * @param raw - Raw fill-событие
   * @param accountId - AccountId пользователя
   * @param rawId - ID fill-события (ключ в _pendingFills)
   * @param status - Текущий статус (MINED | CONFIRMED)
   *
   * @remarks
   * ### Алгоритм:
   * 1. Дедупликация: если fillId уже в `_publishedFillIds` → debug-лог, выход.
   *    Защита от дублирования: Polymarket присылает CONFIRMED несколько раз.
   * 2. Пробуем достать fill из `_pendingFills` (fast path — MATCHED был раньше).
   * 3. Если нет в кеше — парсим из raw напрямую (fallback).
   *    Это покрывает два случая:
   *    - CONFIRMED приходит без предшествующего MATCHED (биржа может пропустить шаг)
   *    - Бот перезапустился между MATCHED и CONFIRMED
   * 4. Публикуем FILL_RECEIVED, добавляем fillId в `_publishedFillIds`.
   */
  private async _publishCachedOrParsedFill(
    raw: Record<string, unknown>,
    accountId: AccountId,
    rawId: string,
    status: string,
  ): Promise<void> {
    // Дедупликация: Polymarket может слать CONFIRMED несколько раз.
    // Повторная публикация могла бы вызвать двойную реакцию стратегии на fill-событие.
    if (this._publishedFillIds.has(rawId)) {
      this._logger.debug('Fill already published, ignoring duplicate CONFIRMED', { rawId, status });
      return;
    }

    let fill = this._pendingFills.get(rawId);

    if (fill) {
      this._pendingFills.delete(rawId);
    } else {
      // Fallback: парсим из raw (MATCHED мог быть пропущен или бот перезапустился)
      this._logger.debug('Fill not in cache, parsing from on-chain event directly', {
        rawId,
        status,
      });
      const result = FillMapper.fromPolymarketTradeEvent(raw, accountId);
      if (!result.ok) {
        this._logger.error('Failed to parse fill event', {
          error: result.error.message,
          rawId,
          status,
        });
        return;
      }
      fill = result.value.fill;
    }

    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create receivedAt timestamp', {
        error: tsResult.error.message,
      });
      return;
    }

    await this._eventBus.publish({
      type: 'FILL_RECEIVED',
      fill,
      receivedAt: tsResult.value,
    });

    this._publishedFillIds.add(rawId);

    this._logger.info('Fill event published', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      status,
    });
  }

  /**
   * Обрабатывает fill со статусом FAILED — ошибка исполнения on-chain.
   *
   * @param raw - Raw fill-событие
   * @param rawId - ID события для логирования
   *
   * @remarks
   * Не парсит Fill — транзакция никогда не была исполнена.
   * Публикует FILL_FAILED для reconciliation.
   */
  private async _handleFailedFill(raw: Record<string, unknown>, rawId: string): Promise<void> {
    const fillId = asFillId(rawId);
    if (!fillId) {
      this._logger.warn('Failed fill has unparseable fillId, skipping FILL_FAILED event', { rawId });
      return;
    }

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
    });

    this._logger.warn('Fill failed event published', { fillId, orderId });
  }
}

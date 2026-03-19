/**
 * FillEventHandler — обрабатывает fill-события из Polymarket WS user-channel.
 *
 * @remarks
 * Получает raw fill-событие (WsUserFillDto или совместимый Record),
 * маршрутизирует по статусу WsFillStatus:
 *
 * - MATCHED  → парсит Fill, кеширует в `_pendingFills`, НЕ публикует.
 *   Токены ещё не на блокчейне — стратегия не должна пытаться продавать.
 *
 * - MINED / CONFIRMED → достаёт Fill из кеша, публикует FILL_RECEIVED.
 *   Токены подтверждены on-chain — позиция обновлена, можно продавать.
 *   Если fill нет в кеше (бот перезапустился) — warn, без публикации.
 *   Если оба события приходят (MINED + CONFIRMED) — второй игнорируется
 *   (fill удалён из кеша при первом; ProcessFillUseCase идемпотентен).
 *
 * - FAILED   → публикует FILL_FAILED (требует reconciliation)
 * - остальные → логирует trace, игнорирует (RETRYING и т.д.)
 *
 * ### Ответственность:
 * - НЕ обновляет Portfolio (это задача ProcessFillUseCase через FillOrchestrator)
 * - Кеш pending fills — in-memory, живёт до MINED/CONFIRMED или рестарта бота
 * - Только маршрутизация по статусу и публикация событий
 *
 * ### Почему не публикуем при MATCHED:
 * При MATCHED fill токены находятся на бирже (CLOB), но ещё не заминированы
 * в блокчейн. Polymarket возвращает "not enough balance/allowance" при попытке
 * разместить SELL-ордер до MINED. Откладывая публикацию до MINED, мы исключаем
 * спам из 10+ неудачных попыток продажи (2-3 секунды).
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
/** Статусы on-chain подтверждения: публикуем кешированный Fill */
const FILL_PUBLISH_STATUSES = new Set(['MINED', 'CONFIRMED']);
/** Статусы, сигнализирующие об ошибке исполнения */
const FILL_FAILED_STATUSES = new Set(['FAILED']);

export class FillEventHandler {
  /**
   * Кеш распарсенных fills, ожидающих on-chain подтверждения.
   * Ключ — строковый fillId. Заполняется при MATCHED, очищается при MINED/CONFIRMED.
   */
  private readonly _pendingFills = new Map<string, Fill>();

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
   * 1. Пробуем достать fill из `_pendingFills` (fast path — MATCHED был раньше).
   * 2. Если нет в кеше — парсим из raw напрямую (fallback).
   *    Это покрывает два случая:
   *    - CONFIRMED приходит без предшествующего MATCHED (биржа может пропустить шаг)
   *    - Бот перезапустился между MATCHED и MINED/CONFIRMED
   * 3. Идемпотентность: ProcessFillUseCase игнорирует повторный fillId через markIfNotExists.
   */
  private async _publishCachedOrParsedFill(
    raw: Record<string, unknown>,
    accountId: AccountId,
    rawId: string,
    status: string,
  ): Promise<void> {
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

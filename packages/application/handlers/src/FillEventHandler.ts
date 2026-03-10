/**
 * FillEventHandler — обрабатывает fill-события из Polymarket WS user-channel.
 *
 * @remarks
 * Получает raw fill-событие (WsUserFillDto или совместимый Record),
 * маршрутизирует по статусу WsFillStatus:
 * - MATCHED  → парсит Fill, публикует FILL_RECEIVED (запускает ProcessFillUseCase)
 * - FAILED   → публикует FILL_FAILED (требует reconciliation)
 * - остальные → логирует trace, игнорирует (MINED/CONFIRMED/RETRYING — on-chain статусы)
 *
 * ### Ответственность:
 * - НЕ обновляет Portfolio (это задача ProcessFillUseCase через FillOrchestrator)
 * - НЕ хранит состояние — stateless handler
 * - Только маршрутизация по статусу и публикация событий
 *
 * ### Почему фильтруем по статусу:
 * User channel присылает несколько событий на один fill (MATCHED → MINED → CONFIRMED).
 * Создавать Fill в Ledger нужно только один раз — при MATCHED.
 * MINED/CONFIRMED — on-chain подтверждения, не новые fill-записи.
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
import { FillMapper } from '@polymarket/fill';
import { TimestampService } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';

/** Статусы, требующие создания Fill в Ledger */
const FILL_CREATE_STATUSES = new Set(['MATCHED']);
/** Статусы, сигнализирующие об ошибке исполнения */
const FILL_FAILED_STATUSES = new Set(['FAILED']);

export class FillEventHandler {
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
   * 2. MATCHED → парсим Fill через FillMapper, публикуем FILL_RECEIVED
   * 3. FAILED  → публикуем FILL_FAILED (без парсинга Fill — транзакция упала)
   * 4. Остальные (MINED/CONFIRMED/RETRYING) → trace-лог, игнорируем
   */
  public async handle(raw: Record<string, unknown>, accountId: AccountId): Promise<void> {
    const status = typeof raw['status'] === 'string' ? raw['status'] : 'UNKNOWN';
    const rawId = typeof raw['id'] === 'string' ? raw['id'] : 'unknown';

    if (FILL_FAILED_STATUSES.has(status)) {
      await this._handleFailedFill(raw, rawId);
      return;
    }

    if (!FILL_CREATE_STATUSES.has(status)) {
      // MINED, CONFIRMED, RETRYING — on-chain статусы, не новые fill-записи
      this._logger.trace('Fill event ignored (non-primary status)', { status, rawId });
      return;
    }

    await this._handleMatchedFill(raw, accountId, rawId);
  }

  /**
   * Обрабатывает fill со статусом MATCHED — первичная запись.
   *
   * @param raw - Raw fill-событие
   * @param accountId - AccountId пользователя
   * @param rawId - ID события для логирования
   */
  private async _handleMatchedFill(
    raw: Record<string, unknown>,
    accountId: AccountId,
    rawId: string,
  ): Promise<void> {
    const result = FillMapper.fromPolymarketTradeEvent(raw, accountId);
    if (!result.ok) {
      this._logger.error('Failed to parse fill event', {
        error: result.error.message,
        rawId,
      });
      return;
    }

    const { fill } = result.value;
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
    const orderId = typeof raw['taker_order_id'] === 'string' ? raw['taker_order_id'] : 'unknown';
    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create receivedAt timestamp for failed fill', {
        error: tsResult.error.message,
      });
      return;
    }

    await this._eventBus.publish({
      type: 'FILL_FAILED',
      fillId: rawId,
      orderId,
      receivedAt: tsResult.value,
    });

    this._logger.warn('Fill failed event published', { fillId: rawId, orderId });
  }
}

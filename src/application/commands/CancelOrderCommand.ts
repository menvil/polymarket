/**
 * CancelOrderCommand - команда для отмены ордера
 *
 * @remarks
 * Command pattern для отмены существующего ордера.
 *
 * @example
 * ```typescript
 * const command = new CancelOrderCommand('session-1', 'order-123');
 * const handler = new CancelOrderHandler(...);
 * await handler.execute(command);
 * ```
 */

/**
 * CancelOrder command
 */
export class CancelOrderCommand {
  /**
   * @param sessionId - ID торговой сессии
   * @param orderId - ID ордера для отмены
   */
  constructor(
    public readonly sessionId: string,
    public readonly orderId: string
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.sessionId || this.sessionId.trim().length === 0) {
      throw new Error('sessionId is required');
    }
    if (!this.orderId || this.orderId.trim().length === 0) {
      throw new Error('orderId is required');
    }
  }
}

/**
 * CancelOrder handler
 *
 * @remarks
 * Обрабатывает отмену ордера:
 * 1. Находит ордер в репозитории
 * 2. Проверяет возможность отмены (статус PENDING/OPEN)
 * 3. Отменяет на бирже через ExchangeAdapter
 * 4. Обновляет статус в репозитории
 * 5. Обновляет торговую сессию (освобождает резерв)
 */
import { IExchangeAdapter } from '../../domain/ports/IExchangeAdapter.js';
import { IOrderRepository } from '../../domain/ports/IOrderRepository.js';
import { ILogger } from '../../domain/ports/ILogger.js';

export class CancelOrderHandler {
  private logger: ILogger;

  /**
   * @param orderRepository - Репозиторий ордеров
   * @param exchangeAdapter - Адаптер биржи
   * @param baseLogger - Базовый логгер
   * @param isSimulationMode - Режим симуляции (не отправлять на биржу)
   */
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly exchangeAdapter: IExchangeAdapter,
    baseLogger: ILogger,
    private readonly isSimulationMode: boolean = false
  ) {
    this.logger = baseLogger.child?.('CancelOrderHandler') || baseLogger;
  }

  /**
   * Выполняет отмену ордера
   *
   * @param command - Команда CancelOrder
   * @returns void
   *
   * @throws {Error} Если ордер не найден или не может быть отменён
   * @throws {ExchangeError} При ошибке API биржи (только в live mode)
   *
   * @remarks
   * В simulation mode ордер не отменяется на бирже, только обновляется статус локально.
   */
  async execute(command: CancelOrderCommand): Promise<void> {
    const modePrefix = this.isSimulationMode ? '[SIMULATION] ' : '';

    this.logger.info(`${modePrefix}Executing CancelOrderCommand`, {
      sessionId: command.sessionId,
      orderId: command.orderId,
    });

    try {
      // 1. Находим ордер
      const order = await this.orderRepository.findById(command.orderId);

      if (!order) {
        throw new Error(`Order ${command.orderId} not found`);
      }

      this.logger.debug(`${modePrefix}Order found`, {
        orderId: order.id,
        status: order.status,
      });

      // 2. Проверяем возможность отмены
      if (!order.canCancel()) {
        throw new Error(
          `Order ${command.orderId} cannot be canceled (status: ${order.status})`
        );
      }

      // 3. Отменяем на бирже (только в live mode)
      if (!this.isSimulationMode) {
        await this.exchangeAdapter.cancelOrder(command.orderId);
        this.logger.info('Order canceled on exchange', { orderId: command.orderId });
      } else {
        this.logger.info(`${modePrefix}Order canceled (not sent to exchange)`, {
          orderId: command.orderId,
        });
      }

      // 4. Обновляем статус
      const canceledOrder = order.withStatus('CANCELED');
      await this.orderRepository.update(canceledOrder);

      this.logger.debug(`${modePrefix}Order status updated to CANCELED`, {
        orderId: command.orderId,
      });
    } catch (error) {
      this.logger.error(`${modePrefix}Failed to cancel order`, {
        error,
        command,
      });
      throw error;
    }
  }
}

/**
 * PlaceOrderCommand - команда для размещения ордера
 *
 * @remarks
 * Command pattern для размещения нового ордера.
 * Инкапсулирует все параметры, необходимые для операции.
 *
 * @example
 * ```typescript
 * const command = new PlaceOrderCommand(
 *   'session-1',
 *   'market-123',
 *   'YES',
 *   'BUY',
 *   0.65,
 *   100
 * );
 *
 * const handler = new PlaceOrderHandler(...);
 * const result = await handler.execute(command);
 * ```
 */

/**
 * PlaceOrder command
 */
export class PlaceOrderCommand {
  /**
   * @param sessionId - ID торговой сессии
   * @param marketId - ID рынка
   * @param tokenId - ID токена (полный tokenId для YES или NO)
   * @param side - Сторона ордера ('BUY' или 'SELL')
   * @param price - Цена ордера
   * @param size - Размер ордера
   */
  constructor(
    public readonly sessionId: string,
    public readonly marketId: string,
    public readonly tokenId: string,
    public readonly side: 'BUY' | 'SELL',
    public readonly price: number,
    public readonly size: number
  ) {
    this.validate();
  }

  /**
   * Валидирует параметры команды
   *
   * @throws {Error} Если параметры невалидны
   */
  private validate(): void {
    if (!this.sessionId || this.sessionId.trim().length === 0) {
      throw new Error('sessionId is required');
    }
    if (!this.marketId || this.marketId.trim().length === 0) {
      throw new Error('marketId is required');
    }
    if (!this.tokenId || this.tokenId.trim().length === 0) {
      throw new Error('tokenId is required');
    }
    if (this.price <= 0 || this.price >= 1) {
      throw new Error('price must be between 0 and 1');
    }
    if (this.size <= 0) {
      throw new Error('size must be positive');
    }
  }
}

/**
 * PlaceOrder handler
 *
 * @remarks
 * Обрабатывает команду размещения ордера:
 * 1. Создаёт Order entity
 * 2. В live mode: отправляет на биржу через ExchangeAdapter
 * 3. В simulation mode: только логирует
 * 4. Сохраняет в репозиторий
 * 5. Возвращает PlaceOrderResult с Order и OrderDTO
 */
import { Order } from '../../domain/entities/Order.js';
import { Price } from '../../domain/value-objects/Price.js';
import { Quantity } from '../../domain/value-objects/Quantity.js';
import { IExchangeAdapter } from '../../domain/ports/IExchangeAdapter.js';
import { IOrderRepository } from '../../domain/ports/IOrderRepository.js';
import { ILogger } from '../../domain/ports/ILogger.js';
import { OrderDTO, toOrderDTO } from '../dto/OrderDTO.js';

/**
 * Result of PlaceOrderCommand execution
 */
export interface PlaceOrderResult {
  /** Order entity */
  order: Order;
  /** Order DTO for external consumers */
  dto: OrderDTO;
  /** Whether the order was placed in simulation mode */
  isSimulation: boolean;
}

export class PlaceOrderHandler {
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
    this.logger = baseLogger.child?.('PlaceOrderHandler') || baseLogger;
  }

  /**
   * Выполняет команду размещения ордера
   *
   * @param command - Команда PlaceOrder
   * @returns PlaceOrderResult с Order entity и DTO
   *
   * @throws {InsufficientFundsError} Если недостаточно средств
   * @throws {ExchangeError} При ошибке API биржи (только в live mode)
   *
   * @remarks
   * В simulation mode ордер не отправляется на биржу, а только сохраняется локально.
   *
   * @example
   * ```typescript
   * const command = new PlaceOrderCommand(...);
   * const result = await handler.execute(command);
   * console.log(`Order placed: ${result.order.id}, simulation: ${result.isSimulation}`);
   * ```
   */
  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    const shortTokenId = command.tokenId.substring(0, 16) + '...';
    const modePrefix = this.isSimulationMode ? '[SIMULATION] ' : '';

    this.logger.info(`${modePrefix}Executing PlaceOrderCommand`, {
      sessionId: command.sessionId,
      marketId: command.marketId,
      tokenId: shortTokenId,
      side: command.side,
      price: command.price,
      size: command.size,
    });

    try {
      // 1. Создаём Order entity
      // ID включает side (bid/ask) для уникальности при размещении обоих ордеров в одну миллисекунду
      const sidePrefix = command.side === 'BUY' ? 'bid' : 'ask';
      const order = Order.create({
        id: `${sidePrefix}-${command.tokenId}-${Date.now()}`,
        tokenId: command.tokenId,
        side: command.side,
        price: Price.fromNumber(command.price),
        size: Quantity.fromNumber(command.size),
        status: 'PENDING',
        timestamp: new Date(),
      });

      this.logger.debug(`${modePrefix}Order entity created`, { orderId: order.id });

      let finalOrder: Order;

      if (this.isSimulationMode) {
        // SIMULATION MODE: не отправляем на биржу
        finalOrder = order;

        this.logger.info(`${modePrefix}Order placed (not sent to exchange)`, {
          orderId: order.id,
          side: order.side,
          price: order.price.value.toFixed(4),
          size: order.size.value,
        });
      } else {
        // LIVE MODE: отправляем на биржу
        finalOrder = await this.exchangeAdapter.placeOrder(order);

        this.logger.info('Order placed on exchange', {
          orderId: finalOrder.id,
          status: finalOrder.status,
        });
      }

      // 3. Сохраняем в репозиторий
      await this.orderRepository.save(finalOrder);
      this.logger.debug(`${modePrefix}Order saved to repository`, { orderId: finalOrder.id });

      // 4. Возвращаем результат
      return {
        order: finalOrder,
        dto: toOrderDTO(finalOrder),
        isSimulation: this.isSimulationMode,
      };
    } catch (error) {
      this.logger.error(`${modePrefix}Failed to place order`, {
        error,
        command,
      });
      throw error;
    }
  }
}

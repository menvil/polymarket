/**
 * Generic-обработчик сообщения.
 *
 * @remarks
 * Разрешены и sync- (`void`), и async- (`Promise<void>`) обработчики; для обеих форм
 * действует одинаковая семантика ошибок: синхронный throw нормализуется движком в
 * rejection и участвует в fan-out наравне с async-rejection (не роняет siblings и не
 * меняет классификацию critical/non-critical).
 *
 * Обработчик обязан завершаться самостоятельно: MessageBus не управляет timeout и не
 * умеет отменять handlers — зависший обработчик блокирует drain.
 *
 * @typeParam TMessage - Тип сообщения (при typed-подписке — уже суженный член union)
 *
 * @example
 * ```typescript
 * const onPrice: MessageHandler<PriceMessage> = async (message) => {
 *   await store.update(message.price);
 * };
 * ```
 */
export type MessageHandler<TMessage> = (message: TMessage) => void | Promise<void>;

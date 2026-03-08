/**
 * Balance Adapters - сериализация и форматирование Balance
 *
 * @remarks
 * Этот модуль содержит адаптеры для работы с внешними представлениями Balance:
 * - BalanceSerializer - JSON сериализация/десериализация
 * - BalanceFormatter - форматирование для UI и логирования
 *
 * **BalanceSerializer:**
 *
 * JSON формат:
 * ```json
 * {
 *   "available": { "amount": "10000", "currency": "USDC" },
 *   "reserved": { "amount": "2000", "currency": "USDC" }
 * }
 * ```
 *
 * Методы:
 * - fromJSON(json: unknown) - десериализация из JSON с валидацией
 * - toJSON(balance: Balance) - сериализация в JSON (использует string для точности)
 *
 * **BalanceFormatter:**
 *
 * Форматы вывода:
 * - toSummary() - "Available: $X, Reserved: $Y, Total: $Z (P% reserved)"
 * - toCompact() - "Avail: $X | Res: $Y | Total: $Z" (с K, M, B суффиксами)
 * - toDebugString() - "Balance(available: X USDC, reserved: Y USDC, total: Z USDC)"
 * - toAvailableString() - "$X USDC"
 * - toReservedString() - "$Y USDC"
 * - toTotalString() - "$Z USDC"
 * - toPercentageString() - "P%"
 *
 * @example
 * ```typescript
 * import { BalanceSerializer, BalanceFormatter } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Десериализация
 * const json = {
 *   available: { amount: "10000", currency: "USDC" },
 *   reserved: { amount: "2000", currency: "USDC" }
 * };
 * const result = BalanceSerializer.fromJSON(json);
 * if (!result.ok) {
 *   console.error(result.error.context.reason);
 *   return;
 * }
 * const balance = result.value;
 *
 * // Форматирование (все форматтеры возвращают Result)
 * const summaryResult = BalanceFormatter.toSummary(balance);
 * if (summaryResult.ok) {
 *   console.log(summaryResult.value);
 *   // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
 * }
 *
 * const compactResult = BalanceFormatter.toCompact(balance);
 * if (compactResult.ok) {
 *   console.log(compactResult.value);
 *   // "Avail: $10.0K | Res: $2.0K | Total: $12.0K"
 * }
 *
 * console.log(BalanceFormatter.toDebugString(balance));
 * // "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC)"
 *
 * // Сериализация
 * const serialized = BalanceSerializer.toJSON(balance);
 * console.log(JSON.stringify(serialized, null, 2));
 * // {
 * //   "available": { "amount": "10000", "currency": "USDC" },
 * //   "reserved": { "amount": "2000", "currency": "USDC" }
 * // }
 * ```
 *
 * @packageDocumentation
 */

export * from './BalanceSerializer.js';
export * from './BalanceFormatter.js';

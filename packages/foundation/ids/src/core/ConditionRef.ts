import type { ProtocolId } from './ProtocolId.js';
import type { ChainId } from './ChainId.js';
import type { ConditionId } from './ConditionId.js';

/**
 * ConditionRef - полная ссылка на condition
 *
 * @remarks
 * ВСЕГДА используй ConditionRef, НИКОГДА не используй голый ConditionId!
 *
 * ConditionId без контекста бесполезен:
 * - Может быть collision между chains
 * - Может быть collision между protocols
 * - Не понятно где искать данные
 *
 * ConditionRef содержит ВСЁ необходимое:
 * - protocolId: какой протокол (POLYMARKET_CTF, KALSHI, etc)
 * - chainId: какой blockchain (137 = Polygon, etc)
 * - conditionId: хеш condition
 *
 * @example
 * ```typescript
 * const conditionRef: ConditionRef = {
 *   protocolId: 'POLYMARKET_CTF',
 *   chainId: 137 as ChainId,
 *   conditionId: '0xabc123...' as ConditionId
 * };
 *
 * // ❌ ПЛОХО: голый conditionId
 * const bad = '0xabc123...';
 *
 * // ✅ ХОРОШО: полная ссылка
 * const good: ConditionRef = {
 *   protocolId: 'POLYMARKET_CTF',
 *   chainId: 137 as ChainId,
 *   conditionId: '0xabc123...' as ConditionId
 * };
 * ```
 */
export type ConditionRef = Readonly<{
  /**
   * Протокол prediction market
   */
  protocolId: ProtocolId;

  /**
   * Blockchain network
   */
  chainId: ChainId;

  /**
   * Уникальный ID condition (обычно hash)
   */
  conditionId: ConditionId;
}>;

/**
 * Сравнение двух ConditionRef на равенство
 */
export function conditionRefEquals(a: ConditionRef, b: ConditionRef): boolean {
  return (
    a.protocolId === b.protocolId &&
    a.chainId === b.chainId &&
    a.conditionId === b.conditionId
  );
}

/**
 * Преобразование ConditionRef в строку для логирования
 */
export function conditionRefToString(ref: ConditionRef): string {
  return `${ref.protocolId}:${ref.chainId}:${ref.conditionId}`;
}

/**
 * Парсинг ConditionRef из строки
 *
 * @param str - Строка в формате "protocol:chainId:conditionId"
 * @returns ConditionRef или undefined если формат неверный
 */
export function parseConditionRef(str: string): ConditionRef | undefined {
  const parts = str.split(':');
  if (parts.length !== 3) {
    return undefined;
  }

  const [protocolId, chainIdStr, conditionId] = parts;
  const chainId = parseInt(chainIdStr, 10);

  if (isNaN(chainId)) {
    return undefined;
  }

  return {
    protocolId: protocolId as ProtocolId,
    chainId: chainId as ChainId,
    conditionId: conditionId as ConditionId,
  };
}

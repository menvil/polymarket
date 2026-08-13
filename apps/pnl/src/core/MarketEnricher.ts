/**
 * Обогащение сделок метаданными рынков через CLOB API.
 *
 * @remarks
 * Использует CLOB API (публичный, без аутентификации):
 * `GET https://clob.polymarket.com/markets/{conditionId}`
 *
 * Это единственный надёжный способ определить resolved-статус конкретного рынка.
 * Gamma API не поддерживает lookup по conditionId.
 *
 * Ответ CLOB API:
 * ```json
 * {
 *   "condition_id": "0x2f...",
 *   "question": "Bitcoin Up or Down - April 7, 7:40PM-7:45PM ET",
 *   "closed": true,
 *   "tokens": [
 *     { "token_id": "86748...", "outcome": "Up",   "price": 0, "winner": false },
 *     { "token_id": "47458...", "outcome": "Down",  "price": 1, "winner": true  }
 *   ]
 * }
 * ```
 *
 * Рынок считается resolved если `closed=true` И хотя бы один token имеет `winner=true`.
 *
 * @example
 * ```typescript
 * const enricher = new MarketEnricher(logger);
 * const metas = await enricher.fetchMetas(['0xabc...', '0xdef...']);
 * const meta = metas.get('0xabc...');
 * if (meta?.resolved) {
 *   console.log(meta.question, meta.outcomePrices);
 * }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { MarketMeta } from '../types.js';

const CLOB_API_BASE = 'https://clob.polymarket.com';

const FEE_RATES_BY_CATEGORY: Record<string, number> = {
  crypto: 0.072,
  sports: 0.03,
  finance: 0.04,
  politics: 0.04,
  mentions: 0.04,
  tech: 0.04,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  other: 0.05,
  general: 0.05,
  geopolitics: 0,
};

/**
 * Ответ CLOB API для одного рынка.
 */
interface ClobMarketResponse {
  condition_id: string;
  question?: string;
  closed?: boolean;
  taker_base_fee?: number;
  tags?: string[];
  tokens?: Array<{
    token_id: string;
    outcome?: string;
    price?: number;
    winner?: boolean;
  }>;
}

/**
 * Обогащает сделки метаданными рынков из CLOB API.
 *
 * @remarks
 * Выполняет последовательные запросы к публичному CLOB API с кешированием в памяти.
 */
export class MarketEnricher {
  private readonly cache = new Map<string, MarketMeta | null>();

  constructor(private readonly logger: ILogger) {}

  /**
   * Загружает метаданные для списка condition ID.
   *
   * @param conditionIds - Список condition ID рынков (0x...)
   * @returns Map conditionId → MarketMeta (только resolved рынки имеют resolved=true)
   *
   * @example
   * ```typescript
   * const metas = await enricher.fetchMetas(['0xabc...', '0xdef...']);
   * for (const [id, meta] of metas) {
   *   if (meta?.resolved) {
   *     console.log(meta.question, '→', meta.outcomePrices);
   *   }
   * }
   * ```
   */
  async fetchMetas(conditionIds: string[]): Promise<Map<string, MarketMeta | null>> {
    const unique = [...new Set(conditionIds)];
    this.logger.info(`Enriching ${unique.length} unique markets from CLOB API`);

    let resolved = 0;
    let skipped  = 0;

    for (const conditionId of unique) {
      if (this.cache.has(conditionId)) continue;

      const meta = await this.fetchOne(conditionId);
      this.cache.set(conditionId, meta);

      if (meta?.resolved) resolved++;
      else skipped++;
    }

    this.logger.info(`Market enrichment done: ${resolved} resolved, ${skipped} skipped`);
    return this.cache;
  }

  /**
   * Загружает метаданные одного рынка из CLOB API.
   *
   * @param conditionId - Condition ID (0x...)
   * @returns MarketMeta если resolved, иначе null или MarketMeta с resolved=false
   */
  private async fetchOne(conditionId: string): Promise<MarketMeta | null> {
    const url = `${CLOB_API_BASE}/markets/${encodeURIComponent(conditionId)}`;

    this.logger.debug(`GET ${url}`);

    let data: ClobMarketResponse | undefined;
    try {
      const resp = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!resp.ok) {
        this.logger.debug(`CLOB API ${resp.status} for ${conditionId}`);
        return null;
      }

      data = await resp.json() as ClobMarketResponse;
    } catch (err) {
      this.logger.warn(`Failed to fetch market ${conditionId}`, { err });
      return null;
    }

    if (!data?.condition_id) {
      this.logger.debug(`Market not found: ${conditionId}`);
      return null;
    }

    const tokens = data.tokens ?? [];
    if (tokens.length === 0) {
      return null;
    }

    const isClosed   = data.closed === true;
    const hasWinner  = tokens.some(t => t.winner === true);
    const resolved   = isClosed && hasWinner;

    // Строим параллельные массивы: outcomes[], clobTokenIds[], outcomePrices[]
    const outcomes:      string[] = tokens.map(t => t.outcome ?? 'UNKNOWN');
    const clobTokenIds:  string[] = tokens.map(t => t.token_id);
    const outcomePrices: number[] = tokens.map(t => (t.winner === true ? 1 : 0));

    const question = data.question ?? conditionId;
    const tags = data.tags ?? [];
    const feeCategory = this.detectFeeCategory(question, tags);
    const takerFeeRate = FEE_RATES_BY_CATEGORY[feeCategory] ?? 0;

    if (resolved) {
      this.logger.debug(`Market resolved: "${question}"`, {
        conditionId,
        feeCategory,
        takerFeeRate,
        outcomes,
        outcomePrices,
      });
    }

    return {
      conditionId,
      question,
      tags,
      outcomes,
      clobTokenIds,
      feeCategory,
      takerFeeRate,
      takerBaseFeeBps: data.taker_base_fee ?? 0,
      outcomePrices: resolved ? outcomePrices : [],
      resolved,
    };
  }

  private detectFeeCategory(question: string, tags: string[]): string {
    const normalizedTags = tags.map(tag => tag.trim().toLowerCase());

    for (const tag of normalizedTags) {
      if (tag in FEE_RATES_BY_CATEGORY) {
        return tag;
      }
      if (tag.includes('general')) return 'general';
      if (tag.includes('other')) return 'other';
    }

    if (question.toLowerCase().includes(' up or down ')) {
      return 'crypto';
    }

    return 'general';
  }
}

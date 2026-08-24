/**
 * DEVELOPMENT-ONLY live-характеризация финализационных данных Gamma
 * (N-004 PART 62).
 *
 * @remarks
 * Для недавно завершившихся 5m BTC-серий печатает фактические runtime-формы
 * официального SDK: `Market.state`/`resolution`/`outcomes.*.price` и
 * `Event.metadata` (typeof `priceToBeat`/`finalPrice`) + результат нашего
 * boundary-извлечения. Live evidence — источник истины для
 * `extractCryptoFinalization`/`deriveWinningOutcome`.
 *
 * Запуск из корня repo:
 *
 * ```bash
 * npx tsx packages/infrastructure/market-finalizer/scripts/characterize.ts
 * ```
 */
import { createPublicClient } from '@polymarket/client';
import {
  deriveWinningOutcome,
  extractCryptoFinalization,
  mapFinalOutcomes,
} from '@polymarket/polymarket-v2';

function fiveMinBoundary(offsetPeriods: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return (Math.floor(nowSec / 300) + offsetPeriods) * 300;
}

async function main(): Promise<void> {
  const client = createPublicClient();
  for (const offset of [-2, -3]) {
    const slug = `btc-updown-5m-${fiveMinBoundary(offset)}`;
    try {
      const market = await client.fetchMarket({ slug });
      console.log('=== MARKET', slug);
      console.log('state =', JSON.stringify(market.state));
      console.log('resolution.umaResolutionStatus =', JSON.stringify(market.resolution.umaResolutionStatus));
      console.log(
        'outcome prices =',
        JSON.stringify(market.outcomes.yes.price),
        JSON.stringify(market.outcomes.no.price),
        '| typeof',
        typeof market.outcomes.yes.price,
      );

      const eventRef = market.events[0];
      if (eventRef !== undefined) {
        const event = await client.fetchEvent({ id: String(eventRef.id) });
        console.log('event.metadata =', JSON.stringify(event.metadata));
        const meta = event.metadata;
        if (meta !== null && meta !== undefined) {
          for (const key of ['priceToBeat', 'finalPrice']) {
            console.log(`  metadata['${key}'] typeof =`, typeof meta[key], '=', JSON.stringify(meta[key]));
          }
        }
        console.log('extractCryptoFinalization =', JSON.stringify(extractCryptoFinalization(meta)));
      }
      const outcomes = mapFinalOutcomes(market);
      console.log('mapFinalOutcomes =', JSON.stringify(outcomes.map((o) => ({ label: o.label, price: o.price }))));
      const winner = deriveWinningOutcome(outcomes, market.resolution.umaResolutionStatus ?? undefined);
      console.log('deriveWinningOutcome =', winner === undefined ? 'undefined' : winner.label);
      console.log('');
    } catch (error) {
      console.log('=== MARKET', slug, 'FETCH FAILED:', error instanceof Error ? error.message : error);
    }
  }
}

void main();

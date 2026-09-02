/**
 * @polymarket/market-discovery — universe обнаруженных рынков.
 *
 * @remarks
 * Пакет владеет ОДНОЙ вещью: `MarketUniverse` — in-memory source of truth
 * текущего canonical universe. Он принимает `MarketDiscoverySnapshot` от
 * Infrastructure Discovery и отвечает на вопросы «есть ли такой рынок» и
 * «какие рынки сейчас известны».
 *
 * ### Что отсюда ушло и почему
 *
 * Здесь жили `MarketFilter` и `MarketScorer` на LEGACY-контракте
 * `DiscoveredMarket`. Они отвечали на вопрос ВКУСА — какие рынки интересны
 * потребителю, — то есть были owner policy, а не частью обнаружения.
 * Обнаружение и отбор меняются по разным причинам, и держать их в одном
 * пакете значило бы, что смена предпочтений потребителя трогает пакет про
 * universe.
 *
 * Оба переехали в `@polymarket/policy` и работают там с canonical
 * `MarketDiscoveryEntry` и `Policy`. Здесь их больше нет — ни как
 * реализации, ни как deprecated-обёртки: два рабочих отбора одновременно
 * означали бы два ответа на один вопрос.
 *
 * @example
 * ```typescript
 * import { MarketUniverse } from '@polymarket/market-discovery';
 *
 * const universe = new MarketUniverse(clock);
 * await discovery.refresh();
 * universe.replace(discovery.getSnapshot());
 *
 * const entry = universe.get(KnownVenues.POLYMARKET, marketId);
 * ```
 *
 * @packageDocumentation
 */
export { MarketUniverse } from './MarketUniverse.js';

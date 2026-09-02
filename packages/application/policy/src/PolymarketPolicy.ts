/**
 * Owner policy для рынков Polymarket: какие из технически доступных рынков
 * хочет конкретный consumer.
 *
 * @remarks
 * ### Где проходит граница
 *
 * Infrastructure Discovery отвечает на технический вопрос — «какие рынки
 * контур вообще способен вести». Policy отвечает на вопрос вкуса — «какие
 * из них нужны ЭТОМУ потребителю». Поэтому здесь живут BTC против XRP,
 * 5m против 15m, ключевые слова и пороги ликвидности, и ничего из этого
 * не должно возвращаться в драйвер площадки.
 *
 * ### Policy — значение, а не сервис
 *
 * Это иммутабельная конфигурация без поведения. Ни реестра, ни владельцев,
 * ни ref-count здесь нет: они появятся там, где впервые возникнет
 * физический ресурс (подписка), а у значения владеть нечем.
 *
 * ### Только canonical-типы
 *
 * `CryptoAssetId`, `MarketDuration`, `Money`, `Ratio`, `Timestamp` — не
 * `string`/`number`. Policy сравнивается с canonical `Market`, и любой
 * примитив здесь означал бы конверсию на каждом сравнении плюс молчаливую
 * возможность сопоставить миллисекунды с минутами.
 */
import type { CryptoAssetId } from '@polymarket/ids';
import type { MarketDuration, MarketFamily } from '@polymarket/market';
import type { Money, Ratio } from '@polymarket/value-objects';
import type { PolicyWindow } from './PolicyWindow.js';

/**
 * Селекторы по тексту рынка (вопрос/заголовок).
 *
 * @remarks
 * Семантика пустоты единообразна во всех трёх полях: отсутствующий либо
 * ПУСТОЙ массив означает «ограничения нет». Пустой список сознательно НЕ
 * трактуется как «не подходит ничего»: конфигурация естественно приходит из
 * файлов и переменных окружения, где пустой список — обычный способ сказать
 * «фильтр выключен», и противоположное прочтение молча обнулило бы весь
 * universe.
 */
export interface PolymarketPolicyTitleSelectors {
  /** Все слова должны присутствовать. */
  readonly required?: readonly string[];
  /** Хотя бы одно слово должно присутствовать. */
  readonly anyOf?: readonly string[];
  /** Ни одно слово присутствовать не должно. */
  readonly excluded?: readonly string[];
}

/**
 * Owner policy площадки Polymarket.
 *
 * @example
 * ```typescript
 * const btc5m: PolymarketPolicy = {
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: [unsafeCryptoAssetId('btc')],
 *   durations: [asMarketDuration(5 * 60_000)!],
 *   minLiquidity: Money.of(new Decimal(1000), 'USDC'),
 * };
 * ```
 */
export interface PolymarketPolicy extends PolicyWindow {
  /** Дискриминант union-а {@link Policy}. */
  readonly kind: 'POLYMARKET';
  /**
   * Семейство рынков, которое ведёт эта policy.
   *
   * @remarks
   * Обязательное, а не необязательное поле: селекторы ниже осмысленны
   * только внутри семейства (`assets`/`durations` существуют лишь у
   * `CRYPTO_UP_DOWN`). Policy без семейства пришлось бы применять к рынку,
   * структуры которого она не знает.
   */
  readonly family: MarketFamily;
  /**
   * Базовые криптоактивы (пусто/отсутствует — любой поддержанный).
   */
  readonly assets?: readonly CryptoAssetId[];
  /**
   * НОМИНАЛЫ серий (пусто/отсутствует — любой).
   *
   * @remarks
   * Сравнивается с `market.crypto.duration` — номиналом серии, а НЕ с
   * `market.duration()`. Это разные величины: номинал говорит «рынок
   * 5-минутной серии», фактическое окно — сколько эта конкретная штука
   * реально длится, и площадка вправе его сдвинуть. Селектор серии обязан
   * опираться на классификацию, иначе сдвинутый на минуту рынок выпадет из
   * своей же серии.
   */
  readonly durations?: readonly MarketDuration[];
  /** Селекторы по тексту рынка. */
  readonly title?: PolymarketPolicyTitleSelectors;
  /**
   * Минимальная ликвидность (отсутствует — ограничения нет).
   *
   * @remarks
   * Сравнивается с `entry.metrics.liquidity`, то есть с НАБЛЮДЕНИЕМ рядом с
   * рынком, а не с полем самого рынка: ликвидность меняется каждую минуту и
   * в identity рынка не входит.
   */
  readonly minLiquidity?: Money;
  /** Минимальный спред (отсутствует — ограничения нет). */
  readonly minSpread?: Ratio;
}

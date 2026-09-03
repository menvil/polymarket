/**
 * Политика допуска Polymarket-рынка к записи по первому наблюдению.
 *
 * @remarks
 * ### Роль в контуре сбора после cutover
 *
 * ```text
 * shared control-plane (collector:raw)      MarketDiscovery → MarketUniverse
 *        открывает физические подписки              ↑ canonical рынки
 *                    ↓                              │
 *          PolymarketSource → ExternalMessageBus    │
 *                    ↓ POLYMARKET_MARKET            │
 *          ExternalMessageRecorder ── нет сессии ──► PolymarketCollectionGate.admit()
 *                    ↑ registration                        universe.get + policy
 *                    записать ЭТО ЖЕ первое сообщение
 * ```
 *
 * Gate — это ПОЛИТИКА коллектора «начинать ли собирать этот рынок», а не
 * компонент, который сам подписывается на bus или пишет на диск. Он отвечает
 * ровно на один вопрос recorder-а: рынок с таким source id — интересен ли
 * коллектору, и если да, с какой recording-регистрацией начать. Всё остальное
 * (подписка на bus, запись, RTDS fan-out, seal/finalize) делает recorder.
 *
 * ### Почему решение принимается по canonical `MarketUniverse`
 *
 * Единственное представление рынка, которым коллектор владеет после cutover, —
 * canonical `Market` из общего `MarketUniverse`. Vendor-подготовку рынка
 * (`prepareMarket`) коллектор трогать не имеет права: она принадлежит
 * subscription-controller. Поэтому и registration (header, tokenIds, RTDS-фиды)
 * строится из canonical `Market`, а не из SDK-модели.
 *
 * ### Policy оценивается на `market.startsAt`, а не на `now`
 *
 * Тот же момент, что использует планировщик подписок при ПРИОБРЕТЕНИИ рынка.
 * Так решение «записывать ли» согласовано с решением «подписываться ли»:
 * рынок, который control-plane приобрёл под `collector:raw` (policy подошла на
 * `startsAt`), будет и допущен к записи, когда придёт его первое наблюдение —
 * независимо от того, сместилось ли к этому моменту окно policy. Оценка на
 * `now` рвала бы это согласование: первое наблюдение приходит уже ПОСЛЕ старта
 * торгов, и рынок с полуоткрытым окном policy мог бы «внезапно» перестать
 * подходить ровно в момент, когда он начал присылать данные.
 *
 * ### Что gate НЕ делает
 *
 * Не хранит сессий (их держит recorder), не пересчитывает policy для уже
 * пишущегося рынка (recorder спрашивает gate только при отсутствии сессии),
 * не знает про release/expiry/finalization (отдельный этап lifecycle) и не
 * трогает CEX (у биржевых потоков нет marketId и нет сессий — их пишет
 * оконная политика recorder-а).
 *
 * ### Почему в этой фазе НЕ регистрируются RTDS-фиды
 *
 * Registration намеренно НЕ объявляет `rtdsFeeds`: без lifecycle истечения
 * (expiry → seal) сессия рынка живёт до остановки процесса, а RTDS-фиды
 * (`btcusdt`, `btc/usd`) РАЗДЕЛЯЕМЫ между всеми рынками актива. Записывать их
 * в никогда не закрывающуюся сессию значило бы бесконечно дописывать цены
 * актива в датасет давно истёкшего рынка. Поэтому в этой узкой фазе
 * записываются только CLOB-события самого рынка (они прекращаются с его
 * истечением сами), а RTDS-цены и settlement-поток TWAP — часть следующего
 * этапа, который вводит expiry/seal и вместе с ними безопасную регистрацию
 * фидов.
 */
import type { ILogger } from '@polymarket/logger';
import { asMarketId, KnownVenues } from '@polymarket/ids';
import type { MarketDiscoveryEntry, MarketMeta } from '@polymarket/ports';
import type { MarketUniverse } from '@polymarket/market-discovery';
import { MarketFilter } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import type { PolymarketRecordingRegistration } from '@polymarket/external-message-recorder';

/**
 * Зависимости {@link PolymarketCollectionGate}.
 */
export interface PolymarketCollectionGateDependencies {
  /**
   * Canonical source of truth текущего universe рынков.
   *
   * @remarks
   * Тот же экземпляр, что обновляет control-plane коллектора: gate и
   * подписки видят один и тот же снимок рынков.
   */
  readonly universe: MarketUniverse;
  /**
   * Owner policy коллектора: какие рынки он собирает.
   *
   * @remarks
   * ДОЛЖНА совпадать с policy спроса `collector:raw`, которым control-plane
   * приобретает подписки. Иначе коллектор подписался бы на одно, а записывал
   * другое.
   */
  readonly policy: PolymarketPolicy;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/**
 * Диагностические счётчики допуска (loss visibility, симметрично recorder-у).
 */
export interface PolymarketCollectionGateStats {
  /**
   * Решений о допуске рынка к записи (policy подошла, регистрация построена).
   *
   * @remarks
   * Это РЕШЕНИЯ политики, а не подтверждённые сессии: успешность самой
   * регистрации отражает `recorder.getStats().marketSessionsAdmitted`.
   * Обычно они совпадают; расходятся, если storage отклонил регистрацию и
   * следующее наблюдение снова прошло допуск.
   */
  readonly admitted: number;
  /** Наблюдений по рынку, которого нет в текущем universe. */
  readonly ignoredUnknownMarket: number;
  /** Наблюдений по рынку, не подошедшему под owner policy. */
  readonly ignoredByPolicy: number;
  /** Наблюдений с непарсируемым source market id (защитный контур). */
  readonly invalidMarketId: number;
}

/**
 * Допуск Polymarket-рынка к записи по canonical universe + owner policy.
 *
 * @example
 * ```typescript
 * const gate = new PolymarketCollectionGate({ universe, policy, logger });
 * const recorder = new ExternalMessageRecorder({
 *   bus, storage, logger,
 *   sessionProvider: gate.sessionProvider(),
 * });
 * ```
 */
export class PolymarketCollectionGate {
  private readonly _universe: MarketUniverse;
  private readonly _policy: PolymarketPolicy;
  private readonly _logger: ILogger;
  private readonly _filter = new MarketFilter();

  private _admitted = 0;
  private _ignoredUnknownMarket = 0;
  private _ignoredByPolicy = 0;
  private _invalidMarketId = 0;

  /**
   * Создаёт gate поверх canonical universe и owner policy.
   *
   * @param deps - Зависимости (см. {@link PolymarketCollectionGateDependencies})
   */
  constructor(deps: PolymarketCollectionGateDependencies) {
    this._universe = deps.universe;
    this._policy = deps.policy;
    this._logger = deps.logger.child({ component: 'PolymarketCollectionGate' });
  }

  /**
   * Возвращает функцию-провайдер для recorder-а.
   *
   * @returns Провайдер `(sourceMarketId) => registration | undefined`,
   *   пригодный как `sessionProvider` в `ExternalMessageRecorderDependencies`
   *
   * @remarks
   * Тонкая привязка к {@link PolymarketCollectionGate.admit}: recorder не
   * знает про universe/policy — он получает чистую функцию и вызывает её при
   * отсутствии активной сессии.
   */
  public sessionProvider(): (sourceMarketId: string) => PolymarketRecordingRegistration | undefined {
    return (sourceMarketId) => this.admit(sourceMarketId);
  }

  /**
   * Решает, начинать ли запись рынка по его первому наблюдению.
   *
   * @param sourceMarketId - `payload.market` входящего события (conditionId)
   * @returns Recording-регистрация — рынок интересен, начать запись; либо
   *   `undefined` — рынок неизвестен, не подошёл под policy или id невалиден
   * @throws Ничего не бросает: любая несогласованность входа — это `undefined`
   *
   * @remarks
   * Алгоритм:
   * 1. Парсим source id в canonical `MarketId`; невалидный — игнор.
   * 2. Ищем рынок в universe по паре `(POLYMARKET, marketId)`; нет — игнор
   *    (рынок неизвестен коллектору).
   * 3. Проверяем owner policy на `market.startsAt`; не подошёл — игнор.
   * 4. Строим registration из canonical `Market` (header/tokenIds/spot RTDS).
   *
   * @example
   * ```typescript
   * const registration = gate.admit('0xabc...'); // conditionId рынка
   * if (registration) recorder.registerMarket(registration);
   * ```
   */
  public admit(sourceMarketId: string): PolymarketRecordingRegistration | undefined {
    const marketId = asMarketId(sourceMarketId);
    if (marketId === undefined) {
      this._invalidMarketId++;
      this._logger.debug('Collection admission skipped: unparseable market id', { sourceMarketId });
      return undefined;
    }

    const entry = this._universe.get(KnownVenues.POLYMARKET, marketId);
    if (entry === undefined) {
      this._ignoredUnknownMarket++;
      this._logger.debug('Collection admission skipped: market not in universe', { sourceMarketId });
      return undefined;
    }

    // Policy — на `startsAt`, тот же момент, что у планировщика подписок:
    // «записывать ли» согласовано с «подписываться ли».
    if (!this._filter.matches(entry, this._policy, entry.market.startsAt)) {
      this._ignoredByPolicy++;
      this._logger.debug('Collection admission skipped: market does not match policy', {
        sourceMarketId,
        question: entry.market.question,
      });
      return undefined;
    }

    const registration = this._buildRegistration(entry);
    this._admitted++;
    this._logger.info('Market admitted to collection', {
      marketId: sourceMarketId,
      question: entry.market.question,
    });
    return registration;
  }

  /**
   * Возвращает снимок диагностических счётчиков допуска.
   *
   * @returns Текущие значения {@link PolymarketCollectionGateStats}
   */
  public getStats(): PolymarketCollectionGateStats {
    return {
      admitted: this._admitted,
      ignoredUnknownMarket: this._ignoredUnknownMarket,
      ignoredByPolicy: this._ignoredByPolicy,
      invalidMarketId: this._invalidMarketId,
    };
  }

  /**
   * Строит recording-регистрацию из canonical рынка universe.
   *
   * @param entry - Запись universe: canonical `Market` + метрики
   * @returns Регистрация с canonical header и tokenIds исходов
   *
   * @remarks
   * ### Header — canonical, версия 2
   *
   * `headerVersion: 2` СОЗНАТЕЛЬНО отличается от legacy `headerVersion: 1`,
   * который писал координатор (vendor Gamma-поля: `gammaMarketId`, `crypto
   * {source, binanceSymbol, settlement}`, `recordingStartsAt`). Здесь header
   * canonical (identity/timing/outcomes/крипто-номинал из `Market`), поэтому
   * дискриминатор версии обязан отличаться — иначе читатель, диспетчеризующий
   * по `headerVersion`, получил бы два несовместимых shape под одним номером.
   *
   * ### Без `startsAt`: запись с первого наблюдения
   *
   * `marketMeta.startsAt` НЕ задаётся — storage активирует запись немедленно.
   * Это прямое следствие инварианта «первое наблюдение не теряется»: первое
   * событие приобретённого рынка — это `book`-снапшот при подписке (до старта
   * торгов), и он нужен как ОПОРА для реконструкции стакана (последующие
   * `price_change` — дельты). Активация по `startsAt` отбросила бы этот
   * снапшот как `inactive`, оставив датасет без опорного состояния. Ставить
   * `startsAt` начнёт следующий этап lifecycle, когда появится осмысленная
   * граница «до старта торгов не пишем».
   *
   * ### Без `rtdsFeeds`
   *
   * Фиды не регистрируются в этой фазе (см. TSDoc класса): RTDS-цены и
   * settlement-поток — следующий этап вместе с expiry/seal.
   */
  private _buildRegistration(entry: MarketDiscoveryEntry): PolymarketRecordingRegistration {
    const { market } = entry;
    const tokenIds = market.outcomes.map((outcome) => String(outcome.instrumentId));

    const header: Record<string, unknown> = {
      headerVersion: 2,
      // Идентичность ИСТОЧНИКА (venue), а не имя пакета.
      source: 'polymarket',
      // Canonical MarketId ЕСТЬ conditionId (routing identity vendor-событий).
      conditionId: String(market.id),
      ...(market.slug !== undefined ? { slug: String(market.slug) } : {}),
      question: market.question,
      outcomes: market.outcomes.map((outcome) => ({
        index: outcome.index,
        label: outcome.label,
        instrumentId: String(outcome.instrumentId),
      })),
      family: market.family,
      timing: {
        startsAt: market.startsAt.toNumber(),
        expiresAt: market.expiresAt.toNumber(),
      },
      ...(market.crypto !== undefined
        ? {
            crypto: {
              asset: String(market.crypto.asset),
              duration: Number(market.crypto.duration),
            },
          }
        : {}),
    };

    // startsAt НЕ задаётся: запись активируется немедленно (см. TSDoc).
    const marketMeta: MarketMeta = {
      marketId: market.id,
      question: market.question,
      tokenIds,
      expiresAt: market.expiresAt,
      rawMarket: header,
    };

    return { marketMeta };
  }
}

/**
 * Исполнение достигло финальности на площадке.
 *
 * @remarks
 * Переход `APPLIED → CONFIRMED` — это ТОЛЬКО про уверенность в факте, а не
 * про деньги. Экономика уже применена событием
 * `TRADING_ACCOUNT_FILL_APPLIED`, поэтому подтверждение НЕ меняет ни
 * портфель, ни заявку — и payload их не несёт вовсе. Поле, которое некому
 * читать, рано или поздно кто-нибудь применил бы.
 *
 * ### Почему payload несёт весь `Fill`, а не только `FillId`
 *
 * Чтобы подтверждение можно было соотнести именно с тем фактом исполнения,
 * который был применён. `FillId` в одиночку позволяет подтвердить запись,
 * которая на самом деле относится к другой цене или другому размеру, — и
 * расхождение вскрылось бы уже при сверке с площадкой.
 *
 * ### Подтверждение неизвестного исполнения
 *
 * Не является командой «создай запись»: потребитель обязан отвергнуть такое
 * событие. Пропущенное исполнение сначала материализуется через
 * `TRADING_ACCOUNT_FILL_APPLIED` — вместе с посчитанной экономикой, — и
 * только потом подтверждается. Угадывать экономический эффект по одному
 * подтверждению нельзя.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_ACCOUNT_FILL_CONFIRMED',
 *   payload: { fill },
 *   metadata: metadataGenerator.nextChild(parentMetadata),
 * } satisfies TradingAccountFillConfirmedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill } from '@polymarket/fill';

export type TradingAccountFillConfirmedEvent = MessageEnvelope<
  'TRADING_ACCOUNT_FILL_CONFIRMED',
  {
    /**
     * Тот же immutable факт исполнения, что был применён.
     *
     * @remarks
     * Расхождение по любому полю при совпавшем `FillId` означает не
     * подтверждение, а конфликт идентичности.
     */
    readonly fill: Fill;
  }
>;

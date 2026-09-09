/**
 * Адаптер `Signer` официального SDK поверх ethers v6.
 *
 * @remarks
 * SDK поставляет готовые адаптеры для ethers **v5** (`@polymarket/client/ethers-v5`)
 * и viem; в проекте стоит ethers **6.16**, поэтому четыре метода `Signer`
 * реализованы здесь напрямую.
 *
 * Зачем он вообще нужен read-only отчёту: комиссии (`feeRateBps`) и роль
 * MAKER/TAKER живут только на аутентифицированном `listAccountTrades`, а
 * `createSecureClient` требует настоящий signer **даже когда готовые
 * `credentials` переданы** — он всё равно зовёт `getAddress` +
 * `signTypedData` и идёт в `/auth/api-key`. Это замерено, не предположено.
 *
 * `sendTransaction` намеренно бросает: PnL ничего не отправляет в блокчейн,
 * и если этот путь когда-нибудь позовут — это ошибка вызывающего, о которой
 * надо узнать сразу, а не после подписанной транзакции.
 */
import { Wallet } from 'ethers';
import type { createSecureClient } from '@polymarket/client';

/**
 * Тип signer'а берём из самого SDK, а не описываем свой.
 *
 * @remarks
 * `EvmAddress` и `EvmSignature` — branded-типы: обычная строка `0x…` в них
 * не подходит по построению. Выводя тип из параметра `createSecureClient`,
 * мы получаем ровно тот контракт, который SDK и ожидает, а брендирование
 * остаётся его заботой.
 */
type Signer = Parameters<typeof createSecureClient>[0]['signer'];

/** Брендированный адрес, как его требует SDK. */
type EvmAddress = Awaited<ReturnType<Signer['getAddress']>>;

/** Брендированная подпись, как её требует SDK. */
type EvmSignature = Awaited<ReturnType<Signer['signMessage']>>;

/**
 * Создаёт `Signer` для `createSecureClient()` из приватного ключа.
 *
 * @param privateKey - Приватный ключ EOA (префикс `0x` необязателен)
 * @returns Signer, у которого запрещена отправка транзакций
 * @throws {Error} Если ключ невалиден — бросает ethers при создании `Wallet`
 *
 * @example
 * ```typescript
 * const client = await createSecureClient({
 *   signer: createEthersSigner(process.env.PRIVATE_KEY!),
 *   wallet: funderAddress,
 *   credentials: { key, secret, passphrase },
 * });
 * ```
 */
export function createEthersSigner(privateKey: string): Signer {
  const wallet = new Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);

  return {
    getAddress: async () => wallet.address as EvmAddress,

    signTypedData: async (payload) => {
      // ethers добавляет EIP712Domain сам — переданный экземпляр надо убрать,
      // иначе подпись считается по другому набору типов и не сойдётся.
      const { EIP712Domain: _domain, ...types } = payload.types as Record<
        string,
        Array<{ name: string; type: string }>
      >;
      const signature = await wallet.signTypedData(
        payload.domain as Record<string, unknown>,
        types,
        payload.message as Record<string, unknown>
      );
      return signature as EvmSignature;
    },

    signMessage: async (message) =>
      (await wallet.signMessage(message)) as EvmSignature,

    sendTransaction: () =>
      Promise.reject(new Error('PnL is read-only: sendTransaction is not supported')),
  };
}

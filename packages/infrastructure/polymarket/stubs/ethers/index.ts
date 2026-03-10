/**
 * Stub для ethers.js.
 *
 * @remarks
 * INTERNAL STUB — используется до установки ethers через npm install.
 * Заглушка с минимальными типами для компиляции.
 */

/** Minimal Wallet stub */
export class Wallet {
  readonly address: string = '';
  constructor(_privateKey: string) {}
  getAddress(): string { return ''; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTypedData(_domain: any, _types: any, _value: any): Promise<string> {
    return Promise.resolve('');
  }
  signMessage(_message: string): Promise<string> {
    return Promise.resolve('');
  }
}

/** ethers namespace — объект и пространство имён для поддержки `ethers.Wallet` как типа */
export const ethers = {
  Wallet,
};

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace ethers {
  export type Wallet = InstanceType<typeof import('./index.js').Wallet>;
}

export default ethers;

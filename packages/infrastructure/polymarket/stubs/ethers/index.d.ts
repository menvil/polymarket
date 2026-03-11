/**
 * Stub для ethers.js.
 *
 * @remarks
 * INTERNAL STUB — используется до установки ethers через npm install.
 * Заглушка с минимальными типами для компиляции.
 */
/** Минимальная заглушка Wallet */
export declare class Wallet {
    readonly address: string;
    constructor(_privateKey: string);
    getAddress(): string;
    signTypedData(_domain: any, _types: any, _value: any): Promise<string>;
    signMessage(_message: string): Promise<string>;
}
/** ethers namespace — объект и пространство имён для поддержки `ethers.Wallet` как типа */
export declare const ethers: {
    Wallet: typeof Wallet;
};
export declare namespace ethers {
    type Wallet = InstanceType<typeof import('./index.js').Wallet>;
}
export default ethers;
//# sourceMappingURL=index.d.ts.map
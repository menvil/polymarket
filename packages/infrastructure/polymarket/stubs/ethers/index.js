/**
 * Stub для ethers.js.
 *
 * @remarks
 * INTERNAL STUB — используется до установки ethers через npm install.
 * Заглушка с минимальными типами для компиляции.
 */
/** Минимальная заглушка Wallet */
export class Wallet {
    address = '';
    constructor(_privateKey) { }
    getAddress() { return ''; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData(_domain, _types, _value) {
        return Promise.resolve('');
    }
    signMessage(_message) {
        return Promise.resolve('');
    }
}
/** ethers namespace — объект и пространство имён для поддержки `ethers.Wallet` как типа */
export const ethers = {
    Wallet,
};
export default ethers;
//# sourceMappingURL=index.js.map
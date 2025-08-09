import { CHAIN_ID_SUI, ChainId, hexToUint8Array, tryHexToNativeString, tryNativeToHexString, tryNativeToUint8Array, tryUint8ArrayToNative } from "@certusone/wormhole-sdk";


export function tryHexToNativeStringGeneral(addrHex: string, destChain: ChainId): string {
    if (destChain === CHAIN_ID_SUI) {
        return addrHex;
    } else {
        return tryHexToNativeString(addrHex, destChain);
    }
}

export function tryNativeToUint8ArrayGeneral(addr: string, destChain: ChainId) {
    if (destChain === CHAIN_ID_SUI) {
        return hexToUint8Array(addr);
    } else {
        return tryNativeToUint8Array(addr, destChain);
    }
}

export function tryNativeToHexStringGeneral(addr: string, destChain: ChainId) {
    if (destChain === CHAIN_ID_SUI) {
        return addr;
    } else {
        return tryNativeToHexString(addr, destChain);
    }
}

export function tryUint8ArrayToNativeGeneral(addrBytes: Uint8Array, destChain: number) {
    if (destChain === CHAIN_ID_SUI) {
        return `0x${Buffer.from(addrBytes).toString('hex')}`;
    } else {
        return tryUint8ArrayToNative(addrBytes, destChain as ChainId);
    }
}
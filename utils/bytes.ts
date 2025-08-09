import {
	ChainId,
	tryHexToNativeString as tryHexToNativeStringWh,
	tryNativeToHexString as tryNativeToHexStringWh,
	tryNativeToUint8Array as tryNativeToUint8ArrayWh,
	tryUint8ArrayToNative as tryUint8ArrayToNativeWh,
} from '@certusone/wormhole-sdk';
import { ethers } from 'ethers';
import { CHAIN_ID_HYPERCORE, CHAIN_ID_SUI, CHAIN_ID_UNICHAIN, isEVMChainId } from './chain-map';

export const hexToUint8Array = (h: string): Uint8Array => {
	if (h.startsWith('0x')) h = h.slice(2);
	return new Uint8Array(Buffer.from(h, 'hex'));
};

export const uint8ArrayToHex = (a: Uint8Array): string => Buffer.from(a).toString('hex');

export function tryNativeToUint8ArrayGeneral(address: string, chainId: number): Uint8Array {
	chainId = +chainId;
	if (chainId === CHAIN_ID_SUI) {
		return hexToUint8Array(address);
	} else if (chainId === CHAIN_ID_UNICHAIN) {
		return tryNativeToUint8Array(address, chainId);
	} else {
		return tryNativeToUint8ArrayWh(address, chainId as ChainId);
	}
}

export function tryHexToNativeString(addrHex: string, chainId: number): string {
	chainId = +chainId;
	if (chainId === CHAIN_ID_SUI || chainId === CHAIN_ID_UNICHAIN) {
		return tryUint8ArrayToNative(hexToUint8Array(addrHex), chainId);
	} else {
		return tryHexToNativeStringWh(addrHex, chainId as ChainId);
	}
}

/**
 *
 * Convert an address in a chain's native representation into a 32-byte hex string
 * understood by wormhole.
 *
 * @throws if address is a malformed string for the given chain id
 */
export const tryNativeToHexString = (address: string, chainId: number): string => {
	chainId = +chainId;
	if (chainId === CHAIN_ID_UNICHAIN) {
		return Buffer.from(ethers.utils.zeroPad(address, 32)).toString('hex');
	} else if (chainId === CHAIN_ID_SUI) {
		return address.startsWith('0x') ? address.substring(2) : address;
	} else {
		return tryNativeToHexStringWh(address, chainId as ChainId);
	}
};

/**
 *
 * Convert an address in a chain's native representation into a 32-byte array
 * understood by wormhole.
 *
 * @throws if address is a malformed string for the given chain id
 */
export function tryNativeToUint8Array(address: string, chainId: number): Uint8Array {
	chainId = +chainId;
	if (chainId === CHAIN_ID_SUI || chainId === CHAIN_ID_UNICHAIN) {
		return hexToUint8Array(tryNativeToHexString(address, chainId));
	} else {
		return tryNativeToUint8ArrayWh(address, chainId as ChainId);
	}
}

export const tryUint8ArrayToNative = (a: Uint8Array, chainId: number): string => {
	chainId = +chainId;

	if (a.length === 32 && isEVMChainId(chainId)) {
		if (Buffer.from(a.slice(0, 12)).toString('hex') !== '000000000000000000000000') {
			throw new Error('Invalid address pad for evm chain');
		}
	}

	if (chainId === CHAIN_ID_UNICHAIN) {
		if (a.length === 32) {
			return '0x' + Buffer.from(a).toString('hex').substring(24); // first 12 bytes is zero evm addr only 20 bytes
		} else if (a.length === 20) {
			return '0x' + Buffer.from(a).toString('hex');
		} else {
			throw new Error(`Invalid address length for chain ${chainId}`);
		}
	} else if (chainId === CHAIN_ID_SUI) {
		return '0x' + Buffer.from(a).toString('hex');
	} else if (chainId === CHAIN_ID_HYPERCORE) {
		return '0x' + Buffer.from(a).toString('hex');
	} else {
		return tryUint8ArrayToNativeWh(a, chainId as ChainId);
	}
};

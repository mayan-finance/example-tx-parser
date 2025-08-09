import { ChainId } from '@certusone/wormhole-sdk';
import { ethers } from 'ethers';

export function parseTransferPayload(arr: Buffer): ParsedTransferPayload {
	return {
		amount: ethers.BigNumber.from(arr.slice(1, 1 + 32)).toBigInt(),
		tokenAddress: arr.slice(33, 33 + 32), //128,160
		tokenChain: arr.readUInt16BE(65) as ChainId,
		targetAddress: arr.slice(67, 67 + 32),
		targetChain: arr.readUInt16BE(99) as ChainId,
		fee: ethers.BigNumber.from(arr.slice(101, 101 + 32)).toBigInt(),
	};
}

export function parseSwapPayload(arr: Buffer): ParsedSwapPayload {
	return {
		payloadId: arr.readUInt8(0),
		tokenAddress: arr.slice(1, 1 + 32), //128,160
		tokenChain: arr.readUInt16BE(33) as ChainId,
		targetAddress: arr.slice(35, 35 + 32),
		targetChain: arr.readUInt16BE(67) as ChainId,
		sourceAddress: arr.slice(69, 69 + 32),
		sourceChain: arr.readUInt16BE(101) as ChainId,
		transferSequence: arr.readBigInt64BE(103),
		amountMin: ethers.BigNumber.from(arr.slice(111, 111 + 8)).toBigInt(),
		deadline: ethers.BigNumber.from(arr.slice(119, 119 + 8)).toBigInt(),
		swapFee: ethers.BigNumber.from(arr.slice(127, 127 + 8)).toBigInt(),
		redeemFee: ethers.BigNumber.from(arr.slice(135, 135 + 8)).toBigInt(),
		refundFee: ethers.BigNumber.from(arr.slice(143, 143 + 8)).toBigInt(),
		auctionAddress: arr.slice(151, 151 + 32),
		unwrapRedeem: arr.readUInt8(183) !== 0,
		unwrapRefund: arr.readUInt8(184) !== 0,
		referrer: arr.slice(185, 185 + 32),
		gasDrop: ethers.BigNumber.from(arr.slice(217, 217 + 8)).toBigInt(),
	};
}

type ParsedTransferPayload = {
	amount: bigint;
	tokenAddress: Buffer;
	tokenChain: ChainId;
	targetAddress: Buffer;
	targetChain: ChainId;
	fee: bigint;
};

type ParsedSwapPayload = {
	payloadId: number;
	tokenAddress: Buffer;
	tokenChain: ChainId;
	targetAddress: Buffer;
	targetChain: ChainId;
	sourceAddress: Buffer;
	sourceChain: ChainId;
	transferSequence: bigint;
	amountMin: bigint;
	deadline: bigint;
	swapFee: bigint;
	redeemFee: bigint;
	refundFee: bigint;
	auctionAddress: Buffer;
	unwrapRedeem: boolean;
	unwrapRefund: boolean;
	referrer: Buffer;
	gasDrop: bigint;
};

import {
	getEmitterAddressEth as getEmitterAddressEthWh,
	getEmitterAddressSolana as getEmitterAddressSolanaWh,
	getSignedVAAWithRetry as getSignedVAAWithRetryWh,
} from '@certusone/wormhole-sdk';

import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import axios from 'axios';
import { CHAIN_ID_SONIC, CHAIN_ID_UNICHAIN } from './chain-map';


const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


export function getWormholeSequenceFromPostedMessage(messageData: Buffer): bigint {
	return messageData.readBigUInt64LE(49);
}

export async function getWormholePostedSequenceWithRetry(
	solanaConnection: Connection,
    messageAcc: PublicKey,
    retries: number=20
): Promise<bigint> {
	let whMessageInfo = await solanaConnection.getAccountInfo(messageAcc);

    let retryCount = retries;
	while (retryCount-- > 0 && (!whMessageInfo || !whMessageInfo.data)) {
		await delay(1500);
		whMessageInfo = await solanaConnection.getAccountInfo(messageAcc);
	}

    if (!whMessageInfo || !whMessageInfo.data) {
        throw new Error(`Could not get wormhole message info after ${retries} retries`);
    }

	return getWormholeSequenceFromPostedMessage(whMessageInfo.data);
}

export const getEmitterAddressEth = getEmitterAddressEthWh;
export const getEmitterAddressSolana = getEmitterAddressSolanaWh;

export async function getSignedVAAWithRetry(
	hosts: string[], emitterChain: number,
	emitterAddress: string, sequence: string,
	extraGrpcOpts?: {}, retryTimeout?: number, retryAttempts?: number,
): Promise<{
	vaaBytes: Uint8Array;
}> {
	if ([CHAIN_ID_UNICHAIN, CHAIN_ID_SONIC].includes(emitterChain)) {
		return {vaaBytes: await getSignedVaaFromWormholeScan(emitterChain, emitterAddress, sequence)};
	}
	return await getSignedVAAWithRetryWh(hosts, emitterChain as ChainId, emitterAddress, sequence, extraGrpcOpts, retryTimeout, retryAttempts);
}

async function getSignedVaaFromWormholeScan(
	emitterChain: number,
	emitterAddress: string,
	sequence: string,
): Promise<Uint8Array> {
	const {data} = await axios.get(
		`https://api.wormholescan.io/v1/signed_vaa/${emitterChain}/${emitterAddress}/${sequence}`,
	);

	if (data && data.vaaBytes) {
		return new Uint8Array(Buffer.from(data.vaaBytes, 'base64'));
	}

	throw new Error(`Signed vaa not found for ${emitterChain}/${emitterAddress}/${sequence}`);
}


export async function getSequenceFromWormholeScan(txHash: string): Promise<string> {
	let maxRetries = 20;
	let retries = 0;
	while (retries < maxRetries) {
		try {
			const { data } = await axios.get(`https://api.wormholescan.io/api/v1/operations?txHash=${txHash}`);

			// {"operations":[{"id":"30/000000000000000000000000875d6d37ec55c8cf220b9e5080717549d8aa8eca/11207","emitterChain":30,"emitterAddress":{"hex":"000000000000000000000000875d6d37ec55c8cf220b9e5080717549d8aa8eca","native":"0x875d6d37ec55c8cf220b9e5080717549d8aa8eca"},"sequence":"11207","content":{"standarizedProperties":{"appIds":null,"fromChain":0,"fromAddress":"","toChain":0,"toAddress":"","tokenChain":0,"tokenAddress":"","amount":"","feeAddress":"","feeChain":0,"fee":"","normalizedDecimals":null}},"sourceChain":{"chainId":30,"timestamp":"2025-04-27T16:07:07Z","transaction":{"txHash":"0x4433652a68b62c1a045812bb2e8404eef229abf9fd2ccff0401f9c78eb49e02a"},"from":"0x13e71631684a90df4c2310f1ec78c3eda037b2eb","status":"confirmed"}}]}%
			if (data && data.operations && data.operations.length > 0) {
				return data.operations[0].sequence;
			}
		} catch (err) {
			console.info(`Unable to fetch sequence from wormhole scan ${err}. Retrying... ${txHash}`);
		} finally {
			retries++;
			await delay(1000 * retries);
		}
	}

	throw new Error(`Sequence not found for ${txHash}`);
}

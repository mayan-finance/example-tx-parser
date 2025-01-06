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

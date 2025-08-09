import { keccak256 } from "@certusone/wormhole-sdk";
import { hexToUint8Array, tryNativeToUint8Array } from "./bytes";

export function reconstructOrderHash(
	trader: string,
	srcChainId: number,
	tokenIn: string,
	destChainId: number,
	tokenOut: string,
	minAmountOut64: bigint,
	gasDrop64: bigint,
	refundFeeDest64: bigint,
	refundFeeSrc64: bigint,
	deadline: number,
	destAddr: string,
	referrerAddr: string,
	referrerBps: number,
	mayanBps: number,
	auctionMode: number,
	random: string,
	tokenOut32?: Uint8Array,
): Buffer {
	const writeBuffer = Buffer.alloc(239);
	let offset = 0;

	const trader32 = Buffer.from(tryNativeToUint8Array(trader, srcChainId));
	writeBuffer.set(trader32, offset);
	offset += 32;

	writeBuffer.writeUInt16BE(srcChainId, offset);
	offset += 2;

	const tokenIn32 = Buffer.from(tryNativeToUint8Array(tokenIn, srcChainId));
	writeBuffer.set(tokenIn32, offset);
	offset += 32;

	const destinationAddress32 = Buffer.from(tryNativeToUint8Array(destAddr, destChainId));
	writeBuffer.set(destinationAddress32, offset);
	offset += 32;

	writeBuffer.writeUInt16BE(destChainId, offset);
	offset += 2;

	if (!tokenOut32) {
		tokenOut32 = Buffer.from(tryNativeToUint8Array(tokenOut, destChainId));
	}
	writeBuffer.set(tokenOut32, offset);
	offset += 32;

	writeBuffer.writeBigUInt64BE(minAmountOut64, offset);
	offset += 8;

	writeBuffer.writeBigUInt64BE(gasDrop64, offset);
	offset += 8;

	writeBuffer.writeBigUInt64BE(refundFeeDest64, offset);
	offset += 8;

	writeBuffer.writeBigUInt64BE(refundFeeSrc64, offset);
	offset += 8;

	const deadline64 = BigInt(deadline);
	writeBuffer.writeBigUInt64BE(deadline64, offset);
	offset += 8;

	const referrerAddress32 = Buffer.from(tryNativeToUint8Array(referrerAddr, destChainId));
	writeBuffer.set(referrerAddress32, offset);
	offset += 32;

	writeBuffer.writeUInt8(referrerBps, offset);
	offset += 1;

	writeBuffer.writeUInt8(mayanBps, offset);
	offset += 1;

	writeBuffer.writeUInt8(auctionMode, offset);
	offset += 1;

	const randomKey32 = Buffer.from(hexToUint8Array(random));
	writeBuffer.set(randomKey32, offset);
	offset += 32;

	if (offset !== 239) {
		throw new Error('Invalid offset');
	}

	const orderHash = keccak256(writeBuffer);
	return orderHash;
}
export function calculateOrderHash(
	trader32: Buffer,
	srcChainId: number,
	tokenIn32: Buffer,
	amountIn64: bigint,
	destinationAddress32: Buffer,
	destChainId: number,
	tokenOut32: Buffer,
	minAmountOut64: bigint,
	gasDrop64: bigint,
	feeRedeem64: bigint,
	deadline: bigint,
	referrerAddress32: Buffer,
	referrerBps: number,
	mayanBps: number,
	cctpNonce: bigint,
	cctpDomain: number,
): Buffer {
	let result = Buffer.alloc(218);
	let offset = 0;

	result.set(trader32, offset);
	offset += 32;

	result.writeUint16BE(srcChainId, offset);
	offset += 2;

	result.set(tokenIn32, offset);
	offset += 32;

	result.writeBigUInt64BE(amountIn64, offset);
	offset += 8;

	result.set(destinationAddress32, offset);
	offset += 32;

	result.writeUint16BE(destChainId, offset);
	offset += 2;

	result.set(tokenOut32, offset);
	offset += 32;

	result.writeBigUInt64BE(minAmountOut64, offset);
	offset += 8;

	result.writeBigUInt64BE(gasDrop64, offset);
	offset += 8;

	result.writeBigUInt64BE(feeRedeem64, offset);
	offset += 8;

	result.writeBigUInt64BE(deadline, offset);
	offset += 8;

	result.set(referrerAddress32, offset);
	offset += 32;

	result.writeUint8(referrerBps, offset);
	offset += 1;

	result.writeUint8(mayanBps, offset);
	offset += 1;

	result.writeBigUInt64BE(cctpNonce, offset);
	offset += 8;

	result.writeUint32BE(cctpDomain, offset);
	offset += 4;

	if (offset !== 218) {
		throw new Error(`Unexpected offset: ${offset}`);
	}

	return result;
}

export function calculateOrderHashV2(
	payload_type: number,
	trader32: Buffer,
	srcChainId: number,
	tokenIn32: Buffer,
	amountIn64: bigint,
	destinationAddress32: Buffer,
	destChainId: number,
	tokenOut32: Buffer,
	minAmountOut64: bigint,
	gasDrop64: bigint,
	feeRedeem64: bigint,
	deadline: bigint,
	referrerAddress32: Buffer,
	referrerBps: number,
	mayanBps: number,
	cctpNonce: bigint,
	cctpDomain: number,
): Buffer {
	const actionOrderCreate = 1;

	let result = Buffer.alloc(220);
	let offset = 0;

	result.writeUint8(actionOrderCreate, offset);
	offset += 1;

	result.writeUint8(payload_type, offset);
	offset += 1;

	result.set(trader32, offset);
	offset += 32;

	result.writeUint16BE(srcChainId, offset);
	offset += 2;

	result.set(tokenIn32, offset);
	offset += 32;

	result.writeBigUInt64BE(amountIn64, offset);
	offset += 8;

	result.set(destinationAddress32, offset);
	offset += 32;

	result.writeUint16BE(destChainId, offset);
	offset += 2;

	result.set(tokenOut32, offset);
	offset += 32;

	result.writeBigUInt64BE(minAmountOut64, offset);
	offset += 8;

	result.writeBigUInt64BE(gasDrop64, offset);
	offset += 8;

	result.writeBigUInt64BE(feeRedeem64, offset);
	offset += 8;

	result.writeBigUInt64BE(deadline, offset);
	offset += 8;

	result.set(referrerAddress32, offset);
	offset += 32;

	result.writeUint8(referrerBps, offset);
	offset += 1;

	result.writeUint8(mayanBps, offset);
	offset += 1;

	result.writeBigUInt64BE(cctpNonce, offset);
	offset += 8;

	result.writeUint32BE(cctpDomain, offset);
	offset += 4;

	if (offset !== 220) {
		throw new Error(`Unexpected offset: ${offset}`);
	}

	return result;
}

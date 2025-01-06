export function parseCircleMessage(msg: Buffer): ParsedCircleMessage {
	return {
		version: msg.readUInt8(0),
		domainSource: msg.readUInt32BE(4),
		domainDest: msg.readUInt32BE(8),
		nonce: msg.readBigUInt64BE(12),
		senderMsg: msg.slice(20, 52),
		recipientMsg: msg.slice(52, 84),
		caller: msg.slice(84, 116),
		versionBody: msg.readUint32BE(116),
		tokenBurn: msg.slice(120, 152),
		recipientToken: msg.slice(152, 184),
		amount: msg.readBigUInt64BE(208),
		emitterSource: msg.slice(216, 248),
	};
}

export function parseCctpSwapPayload(payload: Buffer): ParsedCctpSwapMessagePayload {
	return {
		action: payload.readUInt8(0),
		payloadId: payload.readUInt8(1),
		orderHash: payload.slice(2, 34).toString('hex'),
	};
}


export type ParsedCctpSwapMessagePayload = {
	action: number,
	payloadId: number,
	orderHash: string,
};

export type ParsedCircleMessage = {
	version: number,
	domainSource: number,
	domainDest: number,
	nonce: bigint,
	senderMsg: Buffer,
	recipientMsg: Buffer,
	caller: Buffer,
	versionBody: number,
	tokenBurn: Buffer,
	recipientToken: Buffer,
	amount: bigint,
	emitterSource: Buffer,
};

export function calcProtocolBps(
    amountIn: BigInt,
    tokenIn: string,
    tokenOut: string,
    destChain: number,
    referrerBps: number,
): number {
    if (referrerBps > 0) {
        return referrerBps;
    }

    return 0;
}

export function calcProtocolBpsV2(
    amountIn: BigInt,
    tokenIn: string,
    tokenOut: string,
    destChain: number,
    referrerBps: number,
): number {
    return Math.max(3, referrerBps);
}

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


export function parseFastCircleMessage(msg: Buffer) {
	return {
		version: msg.readUint8(0),
		domainSource: msg.readUInt32BE(4),
		domainDest: msg.readUInt32BE(8),
		nonce: msg.subarray(12, 44), // new nonce is 32 byte
		senderMsg: msg.subarray(44, 76),
		recipientMsg: msg.subarray(76, 108),
		destinationCaller: msg.subarray(108, 140),
		minFinalityThreshold: msg.readUInt32BE(140),
		finalityThresholdExecuted: msg.readUInt32BE(144),
		versioBody: msg.readUInt32BE(148),
		tokenBurn: msg.subarray(152, 184),
		recipientToken: msg.subarray(184, 216),
		amount: msg.readBigUInt64BE(240),
		messageSender: msg.subarray(248, 280),
		maxFee: msg.readBigUInt64BE(304),
		feeExecuted: msg.readBigUInt64BE(336),
		expirationBlock: msg.readBigUInt64BE(368),
		hookData: msg.subarray(376),

	}
}

export function parseFastMctpMayanHook(hookData: Buffer) {
	if (hookData.length === 114) {
		return {
			type: 'bridge',
			payloadType: hookData.readUint8(0),
			destAddr: hookData.subarray(1, 33),
			gasDrop: hookData.readBigUInt64BE(33),
			redeemFee: hookData.readBigUInt64BE(41),
			referrerAddr: hookData.subarray(49, 81),
			referrerBps: hookData.readUint8(81),
			customPayload: hookData.subarray(82, 114),
		};
	} else if (hookData.length === 138) {
		return {
			type: 'order',
			payloadType: hookData.readUint8(0),
			destAddr: hookData.subarray(1, 33),
			tokenOut: hookData.subarray(33, 65),
			amountOutMin: hookData.readBigUInt64BE(65),
			gasDrop: hookData.readBigUInt64BE(73),
			redeemFee: hookData.readBigUInt64BE(81),
			refundFee: hookData.readBigUInt64BE(89),
			deadline: hookData.readBigUInt64BE(97),
			referrerAddr: hookData.subarray(105, 137),
			referrerBps: hookData.readUint8(137),
		}
	} else {
		throw new Error(`Unknown hook data. not mayan`)
	}
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

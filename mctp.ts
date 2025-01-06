import {
	CHAIN_ID_SOLANA,
	ChainId,
	hexToUint8Array,
	tryUint8ArrayToNative,
} from '@certusone/wormhole-sdk';

import { ethers } from 'ethers';
import { abi as circleMessageTransmitter } from './abis/circle-message-transmitter';
import { abi as mctpAbi } from './abis/mctp';
import { abi as wormholeAbi } from './abis/wormhole';

import { PublicKey } from '@solana/web3.js';
import { TransactionDescription } from 'ethers/lib/utils';
import { abi as MctpV2Abi } from './abis/mctp-v2';
import { tryUint8ArrayToNativeGeneral } from './utils/address';
import { CircleDomainToWhChainId } from './utils/chain-map';
import {
	calcProtocolBps,
	calcProtocolBpsV2,
	parseCctpSwapPayload,
	parseCircleMessage,
} from './utils/circle';
import {
	MCTP_EVM,
	MCTP_SOLANA,
	MCTP_V2_EVM,
	MCTP_V2_SOLANA,
} from './utils/const';
import { SERVICE_TYPE, Swap, SWAP_STATUS } from './utils/swap.dto';
import {
	getNativeUsdc,
	getTokenData,
	realUint8ArrayToNative,
	uint8ArrayToTokenGeneral,
} from './utils/token.util';
import { NativeTokens } from './utils/tokens';

const LogMessagePublishedWhSig =
	'LogMessagePublished(address,uint64,uint32,bytes,uint8)';
const LogMessageSentCircleSig = 'MessageSent(bytes)';

const LogMessageReceivedCircleSig =
	'MessageReceived(address,uint32,uint64,bytes32 sender,bytes messageBody)';
const LogSwappedSig = 'OrderFulfilled(uint32,uint64,uint256)';
const LogRefundedSig = 'OrderRefunded(uint32,uint64,uint256)';

const CircleDecimals = 6;
const WormholeDecimals = 8;

export class MctpEvmRegistry {
	private readonly circleMessageTransmitterInterface =
		new ethers.utils.Interface(circleMessageTransmitter);
	private readonly mctpInterface = new ethers.utils.Interface(mctpAbi);
	private readonly mctpV2Interface = new ethers.utils.Interface(MctpV2Abi);
	private readonly wormholeInterface = new ethers.utils.Interface(
		wormholeAbi,
	);
	private readonly mctpEvmContractSet: Set<string> = new Set([MCTP_EVM, MCTP_EVM.toLowerCase()]);
	private readonly mctpV2EvmContractSet: Set<string> = new Set([MCTP_V2_EVM, MCTP_V2_EVM.toLowerCase()]);

	private readonly mctpProgram: PublicKey = new PublicKey(MCTP_SOLANA);
	private readonly mctpV2Program: PublicKey = new PublicKey(MCTP_V2_SOLANA);

	private wormholeDecimals = 8;

	private decodeWhEventLog(
		eventLog: ethers.providers.Log,
	): DecodedLogMessagePublishedEvent {
		const eventData = this.wormholeInterface.decodeEventLog(
			LogMessagePublishedWhSig,
			eventLog.data,
			eventLog.topics,
		);

		return {
			sender: eventData.sender,
			sequence: eventData.sequence,
			nonce: eventData.nonce,
			payload: eventData.payload,
			consistencyLevel: eventData.consistencyLevel,
		};
	}

	private decodeCircleEventLog(eventLog: ethers.providers.Log): {
		message: string;
	} {
		const eventdata = this.circleMessageTransmitterInterface.decodeEventLog(
			LogMessageSentCircleSig,
			eventLog.data,
			eventLog.topics,
		);
		return {
			message: eventdata.message,
		};
	}

	async processSwapTx(
		txReceipt: ethers.providers.TransactionReceipt,
		chainId: ChainId,
		decodedData: TransactionDescription,
		blockNumber: any,
		circleLog: ethers.providers.Log,
		wormholeLog: ethers.providers.Log,
		overriddenMiddleAmount64: bigint | null = null,
	): Promise<Swap | null> {
		const decodedCircleLog = this.decodeCircleEventLog(circleLog);
		const parsedCircleLog = parseCircleMessage(
			Buffer.from(hexToUint8Array(decodedCircleLog.message.slice(2))),
		);
		const circleMessageHash = ethers.utils
			.keccak256(decodedCircleLog.message)
			.slice(2);
		const fromChain = CircleDomainToWhChainId[parsedCircleLog.domainSource];
		const toChain = CircleDomainToWhChainId[parsedCircleLog.domainDest];

		const args = decodedData.args;

		const amountInRaw = overriddenMiddleAmount64
			? overriddenMiddleAmount64
			: args.params.amountIn;
		const deadlineRaw = args.params.deadline;
		const destAddrRaw = args.params.destAddr;
		const destChain = args.params.destChain;
		const gasDropRaw = args.params.gasDrop;
		const minAmountOutRaw = args.params.minAmountOut;
		const redeemFeeRaw = args.params.redeemFee;
		const referrerAddressRaw = args.params.referrerAddr;
		const referrerBps = args.params.referrerBps;
		// const tokenInAddress = args.params.tokenIn;
		const tokenOutAddress = args.params.tokenOut;

		const deadline = new Date(1000 * deadlineRaw.toNumber());

		const destAddr = tryUint8ArrayToNativeGeneral(
			hexToUint8Array(destAddrRaw),
			destChain,
		);
		const fromToken = getTokenData(
			fromChain,
			tryUint8ArrayToNativeGeneral(parsedCircleLog.tokenBurn, fromChain),
		);
		if (fromToken === null) {
			console.warn(
				`FromToken Address in payload "${parsedCircleLog.tokenBurn}" is not supported.`,
			);
			return null;
		}

		const toToken = await uint8ArrayToTokenGeneral(
			toChain,
			hexToUint8Array(tokenOutAddress),
		);
		const gasToken = NativeTokens[toChain];
		const gasDrop = ethers.utils.formatUnits(
			gasDropRaw,
			Math.min(this.wormholeDecimals, gasToken.decimals),
		);
		let redeemRelayerFee = ethers.utils.formatUnits(
			redeemFeeRaw,
			CircleDecimals,
		);

		const decodedWhLog = this.decodeWhEventLog(wormholeLog);

		let mctpVersion = 1;

		const payloadArray = Buffer.from(
			hexToUint8Array(decodedWhLog.payload.slice(2)),
		);
		if (payloadArray.length === 32) {
			mctpVersion = 2;
		}

		const swapSequence = decodedWhLog.sequence.toString();
		let orderHash: string;
		if (mctpVersion === 1) {
			const parsedSwapPayload = parseCctpSwapPayload(payloadArray);
			orderHash = parsedSwapPayload.orderHash;
		} else {
			orderHash = payloadArray.toString('hex');
		}

		const serviceType = SERVICE_TYPE.MCTP_SWAP;

		let mayanBps: number | null = null;
		let stateAddr: PublicKey;

		if (mctpVersion === 1) {
			[stateAddr] = PublicKey.findProgramAddressSync(
				[Buffer.from('SWAP'), hexToUint8Array(orderHash)],
				this.mctpProgram,
			);
			mayanBps = calcProtocolBps(
				amountInRaw,
				args.params.tokenIn,
				args.params.tokenOut,
				args.params.destChain,
				args.params.referrerBps,
			);
		} else {
			[stateAddr] = PublicKey.findProgramAddressSync(
				[Buffer.from('ORDER_SOLANA_DEST'), hexToUint8Array(orderHash)],
				this.mctpV2Program,
			);
			mayanBps = calcProtocolBpsV2(
				amountInRaw,
				args.params.tokenIn,
				args.params.tokenOut,
				args.params.destChain,
				args.params.referrerBps,
			);
		}

		const trader = ethers.utils.getAddress(txReceipt.from);

		const swapData: Swap = {
			payloadId: 1,
			trader: trader,
			sourceTxBlockNo: parseInt(txReceipt.blockNumber as any),
			sourceTxHash: txReceipt.transactionHash,
			status: SWAP_STATUS.INITIATED_ON_EVM_MCTP,
			swapSequence: swapSequence,
			deadline: deadline,
			sourceChain: chainId,
			fromToken: fromToken,
			fromTokenAddress: fromToken.contract,
			fromTokenSymbol: fromToken.symbol,
			fromAmount: ethers.utils.formatUnits(
				amountInRaw,
				Math.min(fromToken.decimals, WormholeDecimals),
			),
			fromAmount64: amountInRaw.toString(),
			toToken: toToken,
			toTokenAddress: toToken.contract,
			minAmountOut: ethers.utils.formatUnits(
				minAmountOutRaw,
				Math.min(toToken.decimals, WormholeDecimals),
			),
			minAmountOut64: minAmountOutRaw.toString(),
			destChain: toChain,
			destAddress: destAddr,
			toTokenSymbol: toToken.symbol,
			swapRelayerFee: ethers.utils.formatUnits(0, CircleDecimals),
			redeemRelayerFee: redeemRelayerFee,

			orderHash: orderHash,

			cctpMessageHash: circleMessageHash,
			cctpNonce: parsedCircleLog.nonce,
			cctpMessage: decodedCircleLog.message.slice(2),

			refundRelayerFee: '0',

			gasDrop: gasDrop,
			gasDrop64: gasDropRaw.toString(),

			service: serviceType,

			referrerBps: referrerBps,
			referrerAddress: tryUint8ArrayToNativeGeneral(
				hexToUint8Array(referrerAddressRaw),
				destChain,
			),
		};

		return swapData;
	}

	async processEventLog(
		chainId: ChainId,
		txReceipt: ethers.providers.TransactionReceipt,
		rawTx: any,
		overriddenMiddleAmount64: bigint | null = null,
	): Promise<Swap | null> {
		const wormholeLog = txReceipt.logs.find((log) =>
			log.topics.includes(ethers.utils.id(LogMessagePublishedWhSig)),
		);
		const circleLog = txReceipt.logs.find((log) =>
			log.topics.includes(ethers.utils.id(LogMessageSentCircleSig)),
		);
		if (!circleLog) {
			throw new Error('no circle log found');
		}

		const decodedCircleLog = this.decodeCircleEventLog(circleLog);
		const parsedCircleLog = parseCircleMessage(
			Buffer.from(hexToUint8Array(decodedCircleLog.message.slice(2))),
		);

		let mctpVersion = 1;
		if (
			this.mctpEvmContractSet.has(
				tryUint8ArrayToNative(parsedCircleLog.emitterSource, chainId),
			)
		) {
			mctpVersion = 1;
		} else if (
			this.mctpV2EvmContractSet.has(
				tryUint8ArrayToNative(parsedCircleLog.emitterSource, chainId),
			)
		) {
			mctpVersion = 2;
		} else {
			// not our log
			return null;
		}

		let decodeInterface =
			mctpVersion === 1 ? this.mctpInterface : this.mctpV2Interface;

		let decodedData: TransactionDescription =
			decodeInterface.parseTransaction(rawTx);

		if (decodedData.name === 'createOrder') {
			return this.processSwapTx(
				txReceipt,
				chainId,
				decodedData,
				txReceipt.blockNumber,
				circleLog,
				wormholeLog!,
				overriddenMiddleAmount64,
			);
		}

		const args = decodedData.args;

		const deadline = new Date(
			new Date().getTime() + 1000 * 60 * 60 * 24 * 7,
		);

		const amountInRaw = overriddenMiddleAmount64
			? overriddenMiddleAmount64
			: args.amountIn;

		if (!wormholeLog && !circleLog) {
			throw new Error('neither wormhole or circle log found');
		}

		const circleMessageHash = ethers.utils
			.keccak256(decodedCircleLog.message)
			.slice(2);

		const fromChain = CircleDomainToWhChainId[parsedCircleLog.domainSource];
		const toChain = CircleDomainToWhChainId[parsedCircleLog.domainDest];

		const fromNativeUsdc = getNativeUsdc(fromChain);
		const toNativeUsdc = getNativeUsdc(toChain);

		if (!fromNativeUsdc || !toNativeUsdc) {
			console.warn('native usdc not found for source or dest chain');
			return null;
		}

		const destAddrArgName =
			decodedData.name === 'bridgeWithFee'
				? args.destAddr
				: args.destAddr || args.recipient.mintRecipient;
		const destAddress = tryUint8ArrayToNativeGeneral(
			hexToUint8Array(destAddrArgName),
			toChain,
		);

		const fromToken = getTokenData(
			fromChain,
			realUint8ArrayToNative(parsedCircleLog.tokenBurn, fromChain),
		);

		if (fromToken === null) {
			console.warn(
				`FromToken Address in payload "${parsedCircleLog.tokenBurn}" is not supported.`,
			);
			return null;
		}

		if (fromToken.contract !== fromNativeUsdc.contract) {
			console.warn('from token is not usdc wtf');
			return null;
		}

		const toToken = toNativeUsdc;

		if (toToken === null) {
			console.warn(
				`ToToken Address in payload "${parsedCircleLog.recipientToken}" is not supported.`,
			);
			return null;
		}

		const gasToken = NativeTokens[toChain];

		let gasDrop = ethers.utils.formatUnits(
			args.gasDrop,
			Math.min(this.wormholeDecimals, gasToken.decimals),
		);
		let redeemRelayerFee = ethers.utils.formatUnits(
			args.redeemFee,
			CircleDecimals,
		);

		let swapSequence: string | null = null;
		if (!!wormholeLog) {
			const decodedWhLog = this.decodeWhEventLog(wormholeLog);

			swapSequence = decodedWhLog.sequence.toString();

			gasDrop = ethers.utils.formatUnits(
				decodedData.args.gasDrop,
				Math.min(this.wormholeDecimals, gasToken.decimals),
			);

			redeemRelayerFee = ethers.utils.formatUnits(
				decodedData.args.redeemFee,
				CircleDecimals,
			);
		}

		let serviceType;
		if (
			fromToken.contract === fromNativeUsdc.contract &&
			fromToken.wChainId === fromNativeUsdc.wChainId &&
			toToken.contract === toNativeUsdc.contract &&
			toToken.wChainId === toNativeUsdc.wChainId
		) {
			if (!!wormholeLog) {
				serviceType = SERVICE_TYPE.MCTP_BRIDGE;
			} else {
				serviceType = SERVICE_TYPE.MCTP_BRIDGE_WITH_UNLOCK;
			}
		} else if (
			fromToken.contract === fromNativeUsdc.contract &&
			fromToken.wChainId === fromNativeUsdc.wChainId &&
			toChain === CHAIN_ID_SOLANA &&
			fromChain !== CHAIN_ID_SOLANA
		) {
			if (!!wormholeLog) {
				serviceType = SERVICE_TYPE.MCTP_SWAP;
			} else {
				serviceType = SERVICE_TYPE.MCTP_SWAP_WITH_UNLOCK;
			}
		} else {
			throw new Error(
				`Do not know how to handle swaps that are not from native usdc to solana`,
			);
		}

		const trader = ethers.utils.getAddress(txReceipt.from);

		let customPayload = '0x' + Buffer.alloc(32).toString('hex');
		let payloadType = 1;
		if (args.payloadType === 2) {
			payloadType = 2;
			try {
				customPayload = args.customPayload.startsWith('0x')
					? args.customPayload
					: '0x' + args.customPayload;
			} catch (err) {
				console.error('failed to decode custom payload', err);
			}
		}

		const swapData: Swap = {
			payloadId: payloadType,
			customPayload: customPayload,
			trader: trader,
			sourceTxBlockNo: parseInt(txReceipt.blockNumber as any),
			sourceTxHash: txReceipt.transactionHash,
			status: SWAP_STATUS.INITIATED_ON_EVM_MCTP,
			transferSequence: '-1',
			swapSequence: swapSequence!,
			deadline: deadline,
			sourceChain: chainId,
			fromTokenAddress: realUint8ArrayToNative(
				parsedCircleLog.tokenBurn,
				fromChain,
			),
			fromTokenSymbol: fromToken.symbol,
			fromAmount: ethers.utils.formatUnits(amountInRaw, CircleDecimals),
			fromAmount64: amountInRaw.toString(),
			toToken: toToken,
			fromToken: fromToken,

			toTokenAddress: toToken.contract,
			destChain: toChain,
			destAddress: destAddress,
			toTokenSymbol: toToken.symbol,
			swapRelayerFee: ethers.utils.formatUnits(0, CircleDecimals),
			redeemRelayerFee: redeemRelayerFee,

			minAmountOut: '0',
			minAmountOut64: 0n,

			referrerAddress: '',
			refundRelayerFee: '0',

			toAmount: ethers.utils.formatUnits(
				amountInRaw - args.redeemFee,
				toToken.decimals,
			),

			cctpMessageHash: circleMessageHash,
			cctpNonce: parsedCircleLog.nonce,
			cctpMessage: decodedCircleLog.message.slice(2),

			gasDrop: gasDrop,
			gasDrop64: args.gasDrop.toString(),

			service: serviceType,
		};

		return swapData;
	}
}

type DecodedLogMessagePublishedEvent = {
	sender: string;
	sequence: ethers.BigNumber;
	nonce: number;
	payload: string;
	consistencyLevel: number;
};

import { ethers } from 'ethers';

import { hexToUint8Array } from '@certusone/wormhole-sdk';
import { parseSwapPayload, parseTransferPayload } from './utils/wh';

import { abi as wormholeAbi } from './abis/wormhole';
import { WH_EVM, WORMHOLE_TOKEN_BRIDGSE } from './utils/const';
import { SERVICE_TYPE, Swap, SWAP_STATUS } from './utils/swap.dto';
import { getTokenData, realUint8ArrayToNative } from './utils/token.util';

const LogMessagePublishedSig =
	'LogMessagePublished(address,uint64,uint32,bytes,uint8)';

export class WhEvmRegistery {
	private readonly wormholeInterface = new ethers.utils.Interface(
		wormholeAbi,
	);

	private wormholeDecimals = 8;

	constructor() {}

	public async processTxFromChain(
		txReceipt: ethers.providers.TransactionReceipt,
		chainId: number,
	): Promise<Swap | null> {
		const decodedEvents = await this.processEventLog(+chainId, txReceipt);
		if (!decodedEvents) {
			return null;
		}
		const swap = await this.registerSwap(
			+chainId,
			txReceipt,
			decodedEvents.decodedTransfer,
			decodedEvents.decodedSwap,
		);
		return swap;
	}

	private async processEventLog(
		chainId: number,
		txReceipt: ethers.providers.TransactionReceipt,
	): Promise<{
		decodedTransfer: DecodedLogMessagePublishedEvent;
		decodedSwap: DecodedLogMessagePublishedEvent;
	} | null> {
		const wormholeLogs = txReceipt.logs.filter((log) =>
			log.topics.includes(ethers.utils.id(LogMessagePublishedSig)),
		);
		const decodedLogs = wormholeLogs.map((log) =>
			this.decodeWhEventLog(log),
		);
		const mayanEvmAddresses = WH_EVM.map((a) => a.toLowerCase());
		const decodedSwap = decodedLogs.find((log) =>
			mayanEvmAddresses.includes(log.sender.toLowerCase()),
		);
		if (!decodedSwap) {
			// We're only interested in our own logs
			return null;
		}

		const transferEventLog = wormholeLogs.find(
			(log) =>
				this.decodeWhEventLog(log).sender.toLowerCase() ===
				WORMHOLE_TOKEN_BRIDGSE[chainId].toLowerCase(),
		);
		if (!transferEventLog) {
			// this is strange!
			console.log(`transferEventLog not found: ${decodedSwap}`);
			return null;
		}
		const decodedTransfer = this.decodeWhEventLog(transferEventLog);

		return { decodedTransfer, decodedSwap };
	}

	private async registerSwap(
		chainId: number,
		txRecipt: ethers.providers.TransactionReceipt,
		decodedTransaferLog: DecodedLogMessagePublishedEvent,
		decodedSwapLog: DecodedLogMessagePublishedEvent,
	): Promise<Swap | null> {
		console.log(
			`Processing new Mayan swap transaction. Mayan sequence=${decodedSwapLog.sequence}`,
		);

		const transferPayloadBuffer = Buffer.from(
			hexToUint8Array(decodedTransaferLog.payload.slice(2)),
		);
		const parsedTransferPayload = parseTransferPayload(
			transferPayloadBuffer,
		);

		const swapPayloadBuffer = Buffer.from(
			hexToUint8Array(decodedSwapLog.payload.slice(2)),
		);
		const parsedSwapPayload = parseSwapPayload(swapPayloadBuffer);

		const fromToken = getTokenData(
			parsedTransferPayload.tokenChain,
			realUint8ArrayToNative(
				parsedTransferPayload.tokenAddress,
				parsedTransferPayload.tokenChain,
			),
		);

		if (fromToken === null) {
			console.warn(
				`FromToken Address in payload "${parsedTransferPayload.tokenAddress}" is not supported. Sequence=${parsedSwapPayload.transferSequence}`,
			);
			return null;
		}

		const toToken = getTokenData(
			parsedSwapPayload.tokenChain,
			realUint8ArrayToNative(
				parsedSwapPayload.tokenAddress,
				parsedSwapPayload.tokenChain,
			),
		);

		if (toToken === null) {
			console.warn(
				`ToToken Address in payload "${parsedSwapPayload.tokenAddress}" is not supported. Sequence=${parsedSwapPayload.transferSequence}`,
			);
			return null;
		}

		const gasToken = getTokenData(
			parsedSwapPayload.targetChain,
			ethers.constants.AddressZero,
		);

		/////////////////////////////////////

		const swap: Swap = {

			trader: txRecipt.from,
			sourceTxBlockNo: txRecipt.blockNumber,
			sourceTxHash: txRecipt.transactionHash,
			status: SWAP_STATUS.INITIATED_ON_EVM,
			transferSequence: decodedTransaferLog.sequence.toString(),
			swapSequence: decodedSwapLog.sequence.toString(),
			deadline: new Date(+parsedSwapPayload.deadline.toString() * 1000),
			sourceChain: chainId,
			fromTokenAddress: realUint8ArrayToNative(
				parsedTransferPayload.tokenAddress,
				parsedTransferPayload.tokenChain,
			),
			fromTokenSymbol: fromToken.symbol,
			fromAmount: ethers.utils.formatUnits(
				parsedTransferPayload.amount,
				Math.min(this.wormholeDecimals, fromToken.decimals),
			),

            fromAmount64: parsedTransferPayload.amount,
            fromToken: fromToken,
			toTokenAddress: realUint8ArrayToNative(
				parsedSwapPayload.tokenAddress,
				parsedSwapPayload.tokenChain,
			),
            toToken: toToken,
			destChain: parsedSwapPayload.targetChain,
			destAddress: realUint8ArrayToNative(
				parsedSwapPayload.targetAddress,
				parsedSwapPayload.targetChain,
			),
			toTokenSymbol: toToken.symbol,
			swapRelayerFee: ethers.utils.formatUnits(
				parsedSwapPayload.swapFee,
				Math.min(this.wormholeDecimals, fromToken.decimals),
			),
			redeemRelayerFee: ethers.utils.formatUnits(
				parsedSwapPayload.redeemFee,
				Math.min(this.wormholeDecimals, toToken.decimals),
			),
			refundRelayerFee: ethers.utils.formatUnits(
				parsedSwapPayload.refundFee.toString(),
				Math.min(this.wormholeDecimals, fromToken.decimals),
			),
			referrerAddress: realUint8ArrayToNative(
				parsedSwapPayload.referrer,
				parsedTransferPayload.targetChain,
			),
            minAmountOut: ethers.utils.formatUnits(
                parsedSwapPayload.amountMin,
                Math.min(this.wormholeDecimals, toToken.decimals),
            ),
            minAmountOut64: parsedSwapPayload.amountMin,

			gasDrop: ethers.utils.formatUnits(
				parsedSwapPayload.gasDrop,
				Math.min(this.wormholeDecimals, gasToken!.decimals),
			),
            gasDrop64: parsedSwapPayload.gasDrop,
            
            

			service:
				fromToken.mint === toToken.mint
					? SERVICE_TYPE.WH_BRIDGE
					: SERVICE_TYPE.WH_SWAP,
		};

		return swap;
	}

	private decodeWhEventLog(
		eventLog: ethers.providers.Log,
	): DecodedLogMessagePublishedEvent {
		const eventData = this.wormholeInterface.decodeEventLog(
			LogMessagePublishedSig,
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
}

type DecodedLogMessagePublishedEvent = {
	sender: string;
	sequence: ethers.BigNumber;
	nonce: number;
	payload: string;
	consistencyLevel: number;
};

import { ChainId, tryHexToNativeString } from "@certusone/wormhole-sdk";

import { NativeTokens } from "./utils/tokens";

import { ethers } from "ethers";
import { TransactionDescription } from "ethers/lib/utils";
import { abi as swiftAbi } from "./abis/swift";
import { SWIFT_EVM } from "./utils/const";
import { SERVICE_TYPE, Swap, SWAP_STATUS } from "./utils/swap.dto";
import { getTokenDataGeneral, realUint8ArrayToNative } from "./utils/token.util";

export class SwiftEvmRegistry {
	private readonly evmProviders: {
		[chainId: number]: ethers.providers.JsonRpcProvider;
	} = {};
	private readonly swiftInterface = new ethers.utils.Interface(swiftAbi);
	private readonly swiftEvmContracts: { [chainId: number]: ethers.Contract } = {};

	private wormholeDecimals = 8;

	constructor(
		preparedEvmProviders: { [chainId: number]: ethers.providers.JsonRpcProvider },
	) {
		this.evmProviders = preparedEvmProviders

		for (const chainId of Object.keys(this.evmProviders)) {
			this.swiftEvmContracts[+chainId] = new ethers.Contract(
				SWIFT_EVM,
				swiftAbi,
				this.evmProviders[+chainId],
			);
		}
	}


	async processEventLog(chainId: ChainId, txReceipt: ethers.providers.TransactionReceipt, rawTx: any, overriddenMiddleAmount64: bigint | null = null): Promise<Swap | null | undefined> {
		let decodedData: TransactionDescription=  this.swiftInterface.parseTransaction(rawTx);

		const swiftEventSigs = swiftAbi
			.filter(item => item.type === 'event')
			.map(event => {
				const inputs = event.inputs!.map(input => input.type).join(',');
				const signature = `${event.name}(${inputs})`;
				return ethers.utils.id(signature);
			});

		const swiftLog = txReceipt.logs.find(log => {
			for (let topic of log.topics) {
				if (swiftEventSigs.includes(topic)) {
					return true;
				}
			}
		});
		if (!swiftLog) {
			throw new Error('no swift log found');
		}
		const decodedLog = this.swiftInterface.parseLog(swiftLog);

		switch (decodedLog.name) {
			case 'OrderCreated': return await this.handleCreated(txReceipt, chainId, swiftLog.data, decodedData.args, overriddenMiddleAmount64); break;
		}

	}

	private async handleCreated(txReceipt: ethers.providers.TransactionReceipt, chainId: ChainId, orderHash: string, args: any, overriddenMiddleAmount64: bigint | null = null): Promise<Swap | null> {
		const params = args.params;
		console.log('OrderCreated', chainId, orderHash, params);
        const txHash = txReceipt.transactionHash;
		const tx = await this.evmProviders[chainId].getTransaction(txHash);

		const tokenIn = args.tokenIn ? args.tokenIn : ethers.constants.AddressZero;

		let txValue = tx.value;
		if (
			!args.amountIn && !txValue
		) {
			const normalizedValue = (await this.swiftEvmContracts[chainId].orders(orderHash)).amountIn;
			if (!normalizedValue || normalizedValue == 0) {
				throw new Error(`value not found for eth tx ${txHash}`);
			} else {
				txValue = ethers.BigNumber.from(BigInt(normalizedValue) * BigInt(10 ** 10)); // was normalied from 18 to 8 decimals
			}
		}

		const amountIn = args.amountIn ? args.amountIn : txValue;

		const fromTokenData = await getTokenDataGeneral(
			chainId,
			tryHexToNativeString(tokenIn, chainId),
		);

		const amountInRaw = overriddenMiddleAmount64 ? overriddenMiddleAmount64: amountIn;

		const referrerBps = params.referrerBps;
		const auctionMode = params.auctionMode;

		let toTokenData;
		if (auctionMode == 1 && params.minAmountOut == 1) {
			// nft
			return null; // not implemented yet
		} else {
			console.log('not nft mintAmountOut= ' + params.minAmountOut)
			toTokenData = await getTokenDataGeneral(
				params.destChainId,
				tryHexToNativeString(params.tokenOut, params.destChainId),
			);
		}

		const gasToken = NativeTokens[params.destChainId];

		const minAmountOut64 = ethers.BigNumber.from(params.minAmountOut);
		const gasDrop64 = ethers.BigNumber.from(params.gasDrop);

		const deadline = new Date(1000 * params.deadline.toNumber());
		const destRefundFee64 = ethers.BigNumber.from(params.cancelFee);
		const srcRefundFee64 = ethers.BigNumber.from(params.refundFee);


		let trader = realUint8ArrayToNative(params.trader, chainId);
		trader = ethers.utils.getAddress(trader);

		let swapData: Swap = {
			trader: trader,
			sourceTxBlockNo: txReceipt.blockNumber,
			sourceTxHash: txReceipt.transactionHash,
			status: SWAP_STATUS.ORDER_CREATED,
			orderHash: orderHash,
			deadline: deadline,
			sourceChain: chainId,
            fromToken: fromTokenData,
			fromTokenAddress: tryHexToNativeString(tokenIn, chainId),
			fromTokenSymbol: fromTokenData.symbol,

			fromAmount: ethers.utils.formatUnits(
				amountInRaw.toString(),
				fromTokenData.decimals,
			),
			fromAmount64: amountInRaw.toString(),

            toToken: toTokenData,
			toTokenAddress: tryHexToNativeString(params.tokenOut, params.destChainId),
			destChain: params.destChainId.toString(),
			destAddress: tryHexToNativeString(params.destAddr, params.destChainId),
			toTokenSymbol: toTokenData.symbol,
			redeemRelayerFee: ethers.utils.formatUnits(
				destRefundFee64,
				Math.min(this.wormholeDecimals, fromTokenData.decimals),
			), // redeem relayer fee stores dest refund fee for swifts
			refundRelayerFee: ethers.utils.formatUnits(
				srcRefundFee64,
				Math.min(this.wormholeDecimals, fromTokenData.decimals),
			),

			referrerAddress: tryHexToNativeString(params.referrerAddr, params.destChainId),
			referrerBps: referrerBps,

			minAmountOut: ethers.utils.formatUnits(
				params.minAmountOut,
				Math.min(this.wormholeDecimals, toTokenData.decimals),
			),
			minAmountOut64: minAmountOut64.toBigInt(),

			gasDrop: ethers.utils.formatUnits(
				params.gasDrop,
				Math.min(this.wormholeDecimals, gasToken.decimals),
			),
			gasDrop64: gasDrop64.toBigInt(),

			service: params.minAmountOut == 1 ? SERVICE_TYPE.SWIFT_NFT : SERVICE_TYPE.SWIFT_SWAP,
            swapRelayerFee: '0',
		};

        return swapData;
	}
}

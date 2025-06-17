import {
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_AVAX,
	CHAIN_ID_BASE,
	CHAIN_ID_BSC,
	CHAIN_ID_ETH,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_POLYGON,
	ChainId,
} from '@certusone/wormhole-sdk';
import { ethers } from 'ethers';
import { forwarderAbi } from './abis/forwarder';
import { MctpEvmRegistry } from './mctp';
import { SwiftEvmRegistry } from './swift';
import { FAST_MCTP_EVM, MCTP_EVM, MCTP_V2_EVM, SWIFT_EVM, WH_EVM } from './utils/const';
import { makeEvmProviders } from './utils/evm-providers';
import { Swap } from './utils/swap.dto';
import { getTokenDataGeneral } from './utils/token.util';
import { WhEvmRegistery } from './wh';

const LogForwardedEthSig = 'ForwardedEth(address,bytes)';
const LogForwardedERC20Sig = 'ForwardedERC20(address,uint256,address,bytes)';
const LogSwapAndForwardedEthSig =
	'SwapAndForwardedEth(uint256,address,address,uint256,address,bytes)';
const LogSwapAndForwardedERC20Sig =
	'SwapAndForwardedERC20(address,uint256,address,address,uint256,address,bytes)';

const evmProviders = makeEvmProviders([
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_BASE,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ETH,
	CHAIN_ID_POLYGON,
	CHAIN_ID_BSC,
]);

export class Parser {
	private readonly mayanForwarderInterface = new ethers.utils.Interface(
		forwarderAbi,
	);
	private readonly mctpEvmRegistry = new MctpEvmRegistry();
	private readonly swiftEvmRegistry = new SwiftEvmRegistry(evmProviders);
	private readonly whEvmRegistery = new WhEvmRegistery();

	private acceptedForwarderAddresses: Set<string> = new Set([
		'0x0654874eb7F59C6f5b39931FC45dC45337c967c3',
		'0x337685fdaB40D39bd02028545a4FfA7D287cC3E2',
	]);

	private allAvailableWhProtocols: Set<string> = new Set([
		...WH_EVM,
		...WH_EVM.map((a) => a.toLowerCase()),
	]);

	private allAvailableMctpProtocols: Set<string> = new Set([
		MCTP_EVM,
		MCTP_EVM.toLowerCase(),
		MCTP_V2_EVM,
		MCTP_V2_EVM.toLowerCase(),
	]);
	private allAvailableSwiftProtocols: Set<string> = new Set([
		SWIFT_EVM,
		SWIFT_EVM.toLowerCase(),
	]);

	private allAvailableFastMctpProtocols: Set<string> = new Set([
		FAST_MCTP_EVM,
		FAST_MCTP_EVM.toLowerCase(),
	]);

	async processEventLog(
		chainId: ChainId,
		txReceipt: ethers.providers.TransactionReceipt,
	) {
		const forwarderV2log = txReceipt.logs.find((log) =>
			this.acceptedForwarderAddresses.has(log.address),
		);

		if (!forwarderV2log) {
			return null; // not a forwarder transaction
		}

		const receiptStatus = txReceipt.status as any;
		if (receiptStatus !== 1 && receiptStatus !== '0x1') {
			console.error(
				`failed transaction: ${txReceipt.transactionHash} for forwarder parse`,
			);
			return null; // failed transaction
		}

		const innerParams = this.getInnerParamsFromEventLog(
			chainId,
			forwarderV2log,
		);

		let extractedType: 'MCTP' | 'SWIFT' | 'WH' | 'FAST_MCTP';
		if (this.allAvailableMctpProtocols.has(innerParams.mayanProtocol)) {
			extractedType = 'MCTP';
		} else if (
			this.allAvailableSwiftProtocols.has(innerParams.mayanProtocol)
		) {
			extractedType = 'SWIFT';
		} else if (
			this.allAvailableWhProtocols.has(innerParams.mayanProtocol)
		) {
			extractedType = 'WH';
		} else if (
			this.allAvailableFastMctpProtocols.has(innerParams.mayanProtocol)
		) {
			extractedType = 'FAST_MCTP';
		} else {
			return null; // did not forward mctp/swift/wh related stuff (should not happen)
		}

		let baseSwapData: Swap | null | undefined;
		switch (extractedType) {
			case 'MCTP':
				baseSwapData = await this.mctpEvmRegistry.processEventLog(
					chainId,
					txReceipt,
					{ data: innerParams.mayanCallData },
					innerParams.swappedAmount,
				);
				break;
			case 'SWIFT':
				baseSwapData = await this.swiftEvmRegistry.processEventLog(
					chainId,
					txReceipt,
					{ data: innerParams.mayanCallData },
					innerParams.swappedAmount,
				);
				break;
			case 'WH':
				baseSwapData = await this.whEvmRegistery.processTxFromChain(
					txReceipt,
					+chainId,
				);
				break;
			case 'FAST_MCTP':
				// TODO: add fast mctp
				break;
		}

		if (!baseSwapData) {
			return null;
		}

		if (innerParams.realTokenInAddr) {
			let realTokenIn = await getTokenDataGeneral(
				chainId,
				innerParams.realTokenInAddr,
			);
			baseSwapData!.forwardedTokenSymbol = realTokenIn.symbol;
			baseSwapData!.forwardedTokenAddress = innerParams.realTokenInAddr;
			baseSwapData!.forwardedFromAmount = ethers.utils.formatUnits(
				innerParams.realAmountIn,
				realTokenIn.decimals,
			) as any;
		}

		return baseSwapData
	}

	private getInnerParamsFromEventLog(
		chainId: ChainId,
		log: ethers.providers.Log,
	): innerParams {
		let realTokenInAddr: string = '';
		let realAmountIn;
		let mayanProtocol;
		let mayanCallData;
		let swappedAmount;

		if (log.topics.includes(ethers.utils.id(LogSwapAndForwardedERC20Sig))) {
			const forwardEventData =
				this.mayanForwarderInterface.decodeEventLog(
					LogSwapAndForwardedERC20Sig,
					log.data,
					log.topics,
				);

			mayanCallData = forwardEventData.mayanData;
			mayanProtocol = forwardEventData.mayanProtocol;
			realTokenInAddr = forwardEventData.tokenIn;
			realAmountIn = forwardEventData.amountIn;
			swappedAmount = forwardEventData.middleAmount;
		} else if (
			log.topics.includes(ethers.utils.id(LogSwapAndForwardedEthSig))
		) {
			const forwardEventData =
				this.mayanForwarderInterface.decodeEventLog(
					LogSwapAndForwardedEthSig,
					log.data,
					log.topics,
				);
			mayanCallData = forwardEventData.mayanData;
			mayanProtocol = forwardEventData.mayanProtocol;
			realTokenInAddr = '0x0000000000000000000000000000000000000000';
			realAmountIn = forwardEventData.amountIn;
			swappedAmount = forwardEventData.middleAmount;
		} else if (log.topics.includes(ethers.utils.id(LogForwardedERC20Sig))) {
			const forwardEventData =
				this.mayanForwarderInterface.decodeEventLog(
					LogForwardedERC20Sig,
					log.data,
					log.topics,
				);
			mayanCallData = forwardEventData.protocolData;
			mayanProtocol = forwardEventData.mayanProtocol;
		} else if (log.topics.includes(ethers.utils.id(LogForwardedEthSig))) {
			const forwardEventData =
				this.mayanForwarderInterface.decodeEventLog(
					LogForwardedEthSig,
					log.data,
					log.topics,
				);
			mayanCallData = forwardEventData.protocolData;
			mayanProtocol = forwardEventData.mayanProtocol;
		} else {
			throw new Error(`can not decode this log for forwarder`);
		}

		return {
			mayanProtocol: mayanProtocol,
			mayanCallData: mayanCallData,
			realAmountIn: realAmountIn,
			realTokenInAddr: realTokenInAddr,
			posAddress: ethers.utils.getAddress(log.address),
			swappedAmount: swappedAmount,
		};
	}
}

type innerParams = {
	realTokenInAddr: string;
	realAmountIn: ethers.BigNumber;
	mayanProtocol: string;
	mayanCallData: Buffer;
	posAddress: string;
	swappedAmount: bigint;
};


(async () => {
	const p = new Parser();

	const chainId = CHAIN_ID_ETH; // ethereum
	const rct = await evmProviders[chainId].getTransactionReceipt('0x96777a8044f05ea7262c6cce45505be5e7699593df8cad0362482455adbf2b61');
	console.log(await p.processEventLog(chainId, rct));
})();
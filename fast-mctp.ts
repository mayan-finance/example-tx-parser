import { ethers } from "ethers";
import { abi as circleMessageTransmitter } from './abis/circle-message-transmitter';
import { abi as FastMctpAbi } from './abis/fast-mctp.abi';
import { Swap } from "./utils/swap.dto";
import { parseFastCircleMessage, parseFastMctpMayanHook } from "./utils/circle";
import { hexToUint8Array, tryUint8ArrayToNative } from "./utils/bytes";
import { CircleDomainToWhChainId } from "./utils/chain-map";
import { getNativeUsdc, getTokenData, getTokenDataGeneral } from "./utils/token.util";
import { tryUint8ArrayToNativeGeneral } from "./utils/address";
import { NativeTokens } from "./utils/tokens";
import { HYPERCORE_DEPOSIT_PROCESSOR_ARB_CONTRACT } from "./utils/const";
import { getHypercoreData } from "./examples/mctp/mctp-solana-registry";

const LogMessageSentCircleSig = 'MessageSent(bytes)';


export class FastMctpEvmRegistry {
	private readonly circleMessageTransmitterInterface = new ethers.utils.Interface(circleMessageTransmitter);
    private readonly fastMctpInterface = new ethers.utils.Interface(FastMctpAbi);

	private wormholeDecimals = 8;

	constructor(
        private readonly evmProviders: {
            [chainId: number]: ethers.providers.JsonRpcProvider;
        }
	) {
	}

    async processEventLog(
        chainId: number,
        txReceipt: ethers.providers.TransactionReceipt,
        rawTx: {
            data: string;
            value?: ethers.BigNumberish;
        },
        overriddenMiddleAmount64: bigint | null,
        previousForwarderLogIdx: number,
        forwarderLogIdx: number,
        mctpTxIndex: number,
    ): Promise<Swap> {
        const decodedData = this.fastMctpInterface.parseTransaction(rawTx);
        const circleLog = txReceipt.logs.find(
            log => log.topics.includes(ethers.utils.id(LogMessageSentCircleSig)) && log.logIndex >= previousForwarderLogIdx && log.logIndex <= forwarderLogIdx
        );
        const decodedCircleLog = this.decodeCircleEventLog(circleLog!);
        const parsedCircleLog = parseFastCircleMessage(Buffer.from(hexToUint8Array(decodedCircleLog.message.slice(2))));
        const mayanHookData = parsedCircleLog.hookData;
        const parsedHookData = parseFastMctpMayanHook(mayanHookData);

        let deadline = new Date();
        const amountInRaw = overriddenMiddleAmount64 ? BigInt(overriddenMiddleAmount64.toString()): parsedCircleLog.amount;;
        const circleMessageHash = ethers.utils.keccak256(decodedCircleLog.message).slice(2); // not much usefull in cctp v2 need to reattest

        const fromChain = CircleDomainToWhChainId[parsedCircleLog.domainSource];
        const toChain = CircleDomainToWhChainId[parsedCircleLog.domainDest];

        const fromNativeUsdc = getNativeUsdc(fromChain);
        const toNativeUsdc = getNativeUsdc(toChain);

        if (!fromNativeUsdc || !toNativeUsdc) {
            throw new Error('native usdc not found for source or dest chain wt?!');
        }

        const destAddress = tryUint8ArrayToNativeGeneral(new Uint8Array(parsedHookData.destAddr), toChain);

        const fromToken = getTokenData(
            fromChain,
            tryUint8ArrayToNative(parsedCircleLog.tokenBurn, fromChain),
        );

        if (fromToken === null) {
            throw new Error(
                `FromToken Address in fast mctp payload "${parsedCircleLog.tokenBurn}" is not supported.`,
            );
        }

        if (fromToken.contract !== fromNativeUsdc.contract) {
            throw new Error('from token is not usdc');
        }

        let toToken = toNativeUsdc;
        if (parsedHookData.type === 'order') {
            toToken = await getTokenDataGeneral(toChain, tryUint8ArrayToNativeGeneral(new Uint8Array(parsedHookData.tokenOut!), toChain));
            deadline = new Date(Math.floor(Number(parsedHookData.deadline) * 1000));
        }

        if (toToken === null) {
            throw new Error(
                `ToToken Address in fast mctp payload "${parsedCircleLog.recipientToken}" is not supported.`,
            );
        }

        const gasToken = NativeTokens[toChain];
        const block = await this.evmProviders[chainId].getBlock(txReceipt.blockNumber);

        let gasDrop = ethers.utils.formatUnits(
            parsedHookData.gasDrop,
            Math.min(this.wormholeDecimals, gasToken.decimals),
        );
        let redeemRelayerFee = ethers.utils.formatUnits(
            parsedHookData.redeemFee,
            6,
        );
        let refundRelayerFee = redeemRelayerFee;
        if (parsedHookData.type === 'order') {
            refundRelayerFee = ethers.utils.formatUnits(
                parsedHookData.refundFee!,
                6,
            );
        }

        let serviceType = parsedHookData.type === 'bridge' ? 'MCTP_FAST_BRIDGE' : 'MCTP_FAST_SWAP';
        const trader = ethers.utils.getAddress(txReceipt.from);

        let customPayload = '0x' + Buffer.alloc(32).toString('hex');
        let payloadType = 1;
        if (parsedHookData.payloadType === 2) {
            payloadType = 2;
            const customPayloadRaw = Buffer.from(hexToUint8Array(decodedData.args.customPayload));
            const custompayloadstring = '0x' + customPayloadRaw.toString('hex');
            customPayload = custompayloadstring;
        }

        let referrerBps = parsedHookData.referrerBps;
        let referrerAddr = tryUint8ArrayToNativeGeneral(new Uint8Array(parsedHookData.referrerAddr), toChain)

        const swapData = {
            meta: {},
            payloadId: payloadType,
            customPayload: customPayload,
            trader: trader,
            sourceTxBlockNo: parseInt(txReceipt.blockNumber as any),
            sourceTxHash: txReceipt.transactionHash,
            createTxHash: txReceipt.transactionHash,
            status: 'INITIATED_ON_EVM_MCTP',
            statusUpdatedAt: new Date(),
            transferSequence: '-1',
            swapSequence: '-1',
            deadline: deadline,
            sourceChain: chainId.toString(),
            swapChain: toChain.toString(),
            fromTokenAddress: tryUint8ArrayToNative(parsedCircleLog.tokenBurn, fromChain),
            fromTokenChain: fromChain.toString(),
            fromTokenSymbol: fromToken.symbol,
            fromAmount: ethers.utils.formatUnits(
                amountInRaw,
                6,
            ),
            fromAmount64: amountInRaw.toString(),
            toTokenChain: toChain.toString(),
            toTokenAddress: toToken.contract,
            destChain: toChain.toString(),
            destAddress: destAddress,
            toTokenSymbol: toToken.symbol,
            bridgeFee: 0,
            swapRelayerFee: '0',
            redeemRelayerFee: redeemRelayerFee,
            refundRelayerFee: refundRelayerFee,

            minAmountOut: ethers.utils.formatUnits(
                parsedHookData.type === 'order' ? parsedHookData.amountOutMin! : 0,
                Math.min(toToken.decimals, 8),
            ),
            minAmountOut64: parsedHookData.type === 'order' ? parsedHookData.amountOutMin!.toString() : '0',

            toAmount: parsedHookData.type === 'bridge' ? ethers.utils.formatUnits(
                amountInRaw - parsedHookData.redeemFee,
                toToken.decimals,
            ) : null,

            referrerBps: referrerBps,
			referrerAddress: referrerAddr,
			mayanBps: 3,

            mayanAddress: tryUint8ArrayToNative(parsedCircleLog.messageSender, fromChain),
            posAddress: tryUint8ArrayToNative(parsedCircleLog.messageSender, fromChain),

            gasDrop: gasDrop,
            gasDrop64: parsedHookData.gasDrop.toString(),

            service: serviceType,

            savedAt: new Date(),
            initiatedAt: new Date(block.timestamp * 1000),
        };

        const isMctpWithHypercore = payloadType === 2 && destAddress.toLowerCase() === HYPERCORE_DEPOSIT_PROCESSOR_ARB_CONTRACT.toLowerCase();
		if (isMctpWithHypercore) {
			swapData['meta'] = {
				hypercoreData: getHypercoreData(customPayload),
			}
		}

        return swapData as any;
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
        }
    }
}

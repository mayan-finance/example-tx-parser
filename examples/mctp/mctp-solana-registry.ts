
import {
	Connection,
	Keypair,
	ParsedTransactionWithMeta,
	PartiallyDecodedInstruction,
	PublicKey,
	SystemProgram
} from '@solana/web3.js';
import { base58_to_binary } from 'base58-js';
import { ethers } from 'ethers';


import { MctpV2, MctpV2IDL } from '../../abis/mctp.idl';
import { AnchorProvider, BorshInstructionCoder, EventParser, Program, Wallet } from 'anchor30';
import {MctpPayloadWriterIdl} from '../../abis/payload-writer.idl';
import { hexToUint8Array, tryNativeToUint8Array, tryNativeToUint8ArrayGeneral } from '../../utils/bytes';
import { CHAIN_ID_HYPERCORE, CHAIN_ID_SOLANA, CHAIN_ID_SUI, CIRCLE_DOMAIN_SOLANA, CircleDomainToWhChainId, isEVMChainId, WhChainIdToCircle } from '../../utils/chain-map';
import { getNativeUsdc, getTokenDataGeneral, tryTokenToUint8ArrayGeneral, tryUint8ArrayToTokenGeneral } from '../../utils/token.util';
import { tryUint8ArrayToNativeGeneral } from '../../utils/address';
import { JupiterIxParser } from '../../utils/jup-parser';
import { HYPERCORE_DEPOSIT_PROCESSOR_ARB_CONTRACT, MCTP_AUCTION, MCTP_SOLANA, MCTP_V2_AUCTION, MCTP_V2_SOLANA } from '../../utils/const';
import tokens from '../../utils/tokens';
import { Swap } from '../../utils/swap.dto';
import { parseCircleMessage } from '../../utils/circle';
import { calculateOrderHashV2 } from './utils';

const CIRCLE_TOKEN_DECIMALS = 6;
const DEPOSIT_MODE_WITH_FEE = 1;
const DEPOSIT_MODE_WITH_LOCK = 2;
const DEPOSIT_MODE_SWAP = 3;


export class MctpSolanaRegistry {
	private readonly auctionV2: PublicKey;
	private readonly mctpV2: PublicKey;
	private readonly mctpV2Program: Program<MctpV2>;
	private mctpV2eventParser: EventParser;
	private mctpV2instructionCoder: BorshInstructionCoder;
	private payloadWriterIxCoder: BorshInstructionCoder;


	constructor(
		private readonly jupParser: JupiterIxParser,
        private readonly connection: Connection,
	) {

		this.auctionV2 = new PublicKey(MCTP_V2_AUCTION);
		this.mctpV2 = new PublicKey(MCTP_V2_SOLANA);

		this.mctpV2Program = new Program(
			MctpV2IDL,
			new AnchorProvider(this.connection, new Wallet(Keypair.generate()), {
				commitment: 'confirmed',
			}),
		);

		this.payloadWriterIxCoder = new BorshInstructionCoder(MctpPayloadWriterIdl);
		this.mctpV2instructionCoder = new BorshInstructionCoder(MctpV2IDL);
		this.mctpV2eventParser = new EventParser(this.mctpV2Program.programId, this.mctpV2Program.coder);
	}

	private async createSwap(signature: string, trx: ParsedTransactionWithMeta, txDate: Date, instructionData: CommonParsedInstructionData, payloadBuffers: {[payloadAccount: string]: Buffer}): Promise<Swap | null | undefined> {
		const {forwardedTokenAddress, forwardedFromAmount, forwardedFromSymbol} = await this.jupParser.extractJupSwapFromTrxOrBundle(signature, trx);

		const fromChain = CHAIN_ID_SOLANA;
		const toChain = CircleDomainToWhChainId[instructionData.destinationDomain!];

		if (!toChain) {
			console.warn(`Destination domain ${instructionData.destinationDomain} is not supported. ${signature}`);
			return null;
		}

		let rawDestAddress = tryUint8ArrayToNativeGeneral(instructionData.destAddress!, toChain);

		let destAddress = rawDestAddress;
		if (isEVMChainId(toChain)) {
			destAddress = ethers.utils.getAddress(rawDestAddress);
		}

		const fromToken = tokens[CHAIN_ID_SOLANA].find(
			t => t.mint === instructionData.circleMintInSolana!.toString() && t.wChainId === t.realOriginChainId,
		);

		if (fromToken === null) {
			console.warn(
				`FromToken Address with mint "${instructionData.circleMintInSolana!.toString()}" is not supported.`,
			);
			return null;
		}

		const fromNativeUsdc = getNativeUsdc(fromChain);
		const toNativeUsdc = getNativeUsdc(toChain);

		let toToken;
		if (instructionData.tokenOut) {
			toToken = await tryUint8ArrayToTokenGeneral(toChain, instructionData.tokenOut!);
		} else if (fromToken!.contract === fromNativeUsdc.contract) {
			toToken = toNativeUsdc;
		}

		if (toToken === null) {
			console.warn(
				`ToToken Address in payload "${instructionData.tokenOut}" is not supported.`,
			);
			return null;
		}

		let wormholeDecimals = 8;

		let serviceType;
		if (instructionData.depositMode === DEPOSIT_MODE_WITH_FEE) {
			serviceType = 'MCTP_BRIDGE';
		} else if (instructionData.depositMode === DEPOSIT_MODE_WITH_LOCK) {
			serviceType = 'MCTP_BRIDGE_WITH_UNLOCK';
		} else if (instructionData.depositMode === DEPOSIT_MODE_SWAP) {
			serviceType = 'MCTP_SWAP';
		} else {
			throw new Error(`Unknown deposit mode ${instructionData.depositMode}`);
		}

		let deadline: Date;
		let minAmountOut: string, minAmountOut64: string;
		let referrerBps: number = 0, mayanBps: number = 0;
		let referrerAddr: string | null = null;
		if (instructionData.type === 'INIT_SWAP_LEDGER') {

			deadline = new Date(1000 * Number(instructionData.deadline));
			minAmountOut = ethers.utils.formatUnits(
				instructionData.minAmountOut!,
				Math.min(wormholeDecimals, toToken!.decimals),
			)
			minAmountOut64 = instructionData.minAmountOut!.toString();
			referrerBps = instructionData.referrerBps!;
			mayanBps = instructionData.isV2 ? 3 : Math.max(10, referrerBps);
			referrerAddr = tryUint8ArrayToNativeGeneral(instructionData.referrerAddr!, toChain);
		} else {
			deadline = new Date(new Date().getTime() +  60 * 60 * 24 * 365 * 10);
		}

		if (instructionData.type === 'INIT_BRIDGE_LEDGER') {
			if (instructionData.possibleReferrer && instructionData.possibleReferrer?.toString() !== SystemProgram.programId.toString()) {
				try {
					referrerAddr = tryUint8ArrayToNativeGeneral(instructionData.possibleReferrer.toBytes(), toChain);
				} catch (errr) {
					console.warn(`Unable to parse referrer address ${signature} ${errr}`);
				}
			}
		}

		let payloadId = 1;
		let customPayload: string;
		if (instructionData.customPayloadStore && payloadBuffers[instructionData.customPayloadStore.toString()]) {
			payloadId = 2;
			customPayload = '0x' + payloadBuffers[instructionData.customPayloadStore.toString()].toString('hex');
		}

		let meta: any;
		const isMctpWithHypercore = payloadId === 2 && destAddress.toLowerCase() === HYPERCORE_DEPOSIT_PROCESSOR_ARB_CONTRACT.toLowerCase();
		if (isMctpWithHypercore) {
			meta = {
				hypercoreData: getHypercoreData(customPayload!),
			}
		}

		try {
            // TODO save db or sth
			const swap = {
				payloadId: payloadId,
				customPayload: customPayload!,
				forwardedFromAmount: forwardedFromAmount,
				forwardedTokenAddress: forwardedTokenAddress,
				forwardedTokenSymbol: forwardedFromSymbol,
				trader: instructionData.userWallet!.toString(),
				traderLedger: instructionData.userLedger!.toString(),
				sourceTxHash: signature,
				createTxHash: signature,
				sourceTxBlockNo: trx.slot,
				status: 'INITIATED_ON_SOLANA_MCTP',
				swapSequence: null,
				sourceChain: fromChain.toString(),
				swapChain: CHAIN_ID_SOLANA.toString(),
				destChain: toChain.toString(),
				destAddress: destAddress,
				fromTokenAddress: fromToken!.contract,
				fromTokenChain: fromToken!.wChainId!.toString(),
				fromTokenSymbol: fromToken!.symbol,

				deadline: deadline,
				mayanBps: mayanBps,
				referrerBps: referrerBps,
				minAmountOut: minAmountOut!,
				minAmountOut64: minAmountOut64!,
				referrerAddress: referrerAddr,

				auctionMode: 0,

				fromAmount: 0,
				fromAmount64: null,

				toAmount: null,

				redeemRelayerFee: ethers.utils.formatUnits(instructionData.feeRedeem!, fromToken!.decimals),
				swapRelayerFee: ethers.utils.formatUnits(instructionData.feeSolana!, fromToken!.decimals),

				toTokenAddress: toToken!.contract,
				toTokenChain: toToken!.wChainId!.toString(),
				toTokenSymbol: toToken!.symbol,
				stateAddr: instructionData.feeState ? instructionData.feeState.toString() : instructionData.swapState ? instructionData.swapState.toString() : null,
				stateNonce: null,

				savedAt: new Date(),
				initiatedAt: txDate,
				bridgeFee: 0,

				posAddress: instructionData.isV2 ? MCTP_V2_SOLANA : MCTP_SOLANA,

				gasDrop: ethers.utils.formatUnits(instructionData.gasDrop!, wormholeDecimals),
				gasDrop64: instructionData.gasDrop!.toString(),

				service: serviceType,


				meta,
			};
		} catch (err) {
			console.error('error in process solana transaction');
			throw err;
		}
	}

	private async updateSwapOnCCTPBridge(trx: any, instructionData: CommonParsedInstructionData): Promise<Swap | null> {
		const circleMessageAcc = await this.connection.getAccountInfo(instructionData.circleMsgAcc!);
		const circleMesssageData = circleMessageAcc!.data.slice(44, 44 + 248);
		const parsedCircleMessage = parseCircleMessage(circleMesssageData);
		const circleMessageHash = ethers.utils.keccak256(circleMessageAcc!.data.slice(44, 44 + 248)).slice(2);
        // TODO: fetch swap with user ledger
        
        let swap: Swap = null as any;
		// const swap = findSwap({
		// 	traderLedger: instructionData.userLedger.toString(),
		// });

        let lastSwapStatus = swap.status;

		if (!swap) {
			throw new Error('swap not found wher processing cctp bridge!');
		}

		let swapSequence: string = swap.swapSequence!;
		if (!!instructionData.wormholeMessageAcc) {
			const wormholeMessage = await this.connection.getAccountInfo(instructionData.wormholeMessageAcc);
			swapSequence = wormholeMessage!.data.readUInt32LE(49).toString();
		}

		let amountIn: bigint;
		let toAmount: bigint;
		if (instructionData.type === 'BRIDGE_WITH_FEE') {
			amountIn = parsedCircleMessage.amount;
			toAmount = amountIn - BigInt(ethers.utils.parseUnits(swap.redeemRelayerFee.toString(), CIRCLE_TOKEN_DECIMALS).toString());
		} else if (instructionData.type === 'BRIDGE_WITH_LOCKED_FEE') {
			amountIn = parsedCircleMessage.amount + BigInt(ethers.utils.parseUnits(swap.redeemRelayerFee.toString(), CIRCLE_TOKEN_DECIMALS).toString());
			toAmount = parsedCircleMessage.amount;
		} else {
			amountIn = parsedCircleMessage.amount + BigInt(ethers.utils.parseUnits(swap.swapRelayerFee.toString(), CIRCLE_TOKEN_DECIMALS).toString());
		}

		const fromToken = await getTokenDataGeneral(
			CHAIN_ID_SOLANA,
			swap.fromTokenAddress,
		);
		const toToken = await getTokenDataGeneral(
			+swap.destChain,
			swap.toTokenAddress,
		);

		let orderHash: string | null = null;
		if (instructionData.type === 'INIT_SWAP' && instructionData.isV2) {

			const eventParser: EventParser = new EventParser(this.mctpV2Program.programId, this.mctpV2Program.coder);

			let d, foundOrderHash;
			for (let log of eventParser.parseLogs(trx.meta.logMessages, false)) {
				if (log.name === 'orderCreated') {
					d = log;
				}
			}

			if (!!d) {
				foundOrderHash = '0x' + Buffer.from(new Uint8Array(d.data.hash)).toString('hex');
			}

			const trader32 = Buffer.from(tryNativeToUint8Array(swap.trader, CHAIN_ID_SOLANA));
			const fromToken32 = Buffer.from(tryNativeToUint8Array(fromToken.contract, CHAIN_ID_SOLANA));
			const destAddr32 = Buffer.from(tryNativeToUint8ArrayGeneral(swap.destAddress, +swap.destChain));
			const toToken32 = Buffer.from(tryTokenToUint8ArrayGeneral(toToken, +swap.destChain));
			const refAddr32 = Buffer.from(tryNativeToUint8ArrayGeneral(swap.referrerAddress, +swap.destChain));
			const burnAmount =  parsedCircleMessage.amount;

			let orderHashv2 = calculateOrderHashV2(
				1,
				trader32,
				CHAIN_ID_SOLANA,
				fromToken32,
				burnAmount,
				destAddr32,
				+swap.destChain,
				toToken32,
				BigInt(swap.minAmountOut64),
				BigInt(swap.gasDrop64),
				BigInt(ethers.utils.parseUnits(swap.redeemRelayerFee.toString(), CIRCLE_TOKEN_DECIMALS).toString()),
				BigInt(swap.deadline.getTime() / 1000),
				refAddr32,
				swap.referrerBps!,
				swap.mayanBps!,
				parsedCircleMessage.nonce,
				WhChainIdToCircle[CHAIN_ID_SOLANA],
			);

			orderHash = ethers.utils.keccak256(orderHashv2);

			if (foundOrderHash && foundOrderHash !== orderHash) {
				console.error(`order hash mismatch ${foundOrderHash} ${orderHash}`);
				throw new Error(`order hash mismatch ${foundOrderHash} ${orderHash}`)
			}

			orderHash = orderHash.replace('0x', '');
		}

		// TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id },
		// 	data: { 
		// 		status: lastSwapStatus === SWAP_STATUS.INITIATED_ON_SOLANA_MCTP ? SWAP_STATUS.SUBMITTED_ON_SOLANA_MCTP : lastSwapStatus,
		// 		swapSequence: swapSequence,

		// 		fromAmount: ethers.utils.formatUnits(
		// 			amountIn,
		// 			fromToken.decimals,
		// 		),
		// 		fromAmount64: amountIn.toString(),

		// 		toAmount: toAmount ? ethers.utils.formatUnits(
		// 			toAmount,
		// 			toToken.decimals,
		// 		) : swap.toAmount,

		// 		cctpMessageHash: circleMessageHash,
		// 		cctpNonce: parsedCircleMessage.nonce,
		// 		cctpMessage: circleMesssageData.toString('hex'),
		// 		cctpSolMessageAccount: instructionData.circleMsgAcc.toString(),

		// 		orderHash: orderHash,
		// 	}
		// })

        return swap;
	}

	private parseInitBridgeLedger(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		const accounts = instruction.accounts;

		const userWallet = accounts[0];
		const userLedger = accounts[1];
		const usdcMint = accounts[3];
		const possibleReferrer = accounts[7];

		const destAddress = data.slice(1, 33);
		// const minAmountIn = data.readBigUint64LE(33);
		const gasDrop = data.readBigUInt64LE(41);
		const feeRedeem = data.readBigUInt64LE(49);
		const feeSolana = data.readBigUInt64LE(57);
		const domainDest = data.readUInt32LE(65);
		const chainDest = data.readUInt16LE(69);
		const mode = data.readUInt8(71);

		return {
			type: 'INIT_BRIDGE_LEDGER',
			userWallet: userWallet,
			userLedger: userLedger,
			circleMintInSolana: usdcMint,
			gasDrop: gasDrop,
			feeRedeem: feeRedeem,
			feeSolana: feeSolana,
			destAddress: destAddress,
			destinationDomain: domainDest,
			destinationChain: chainDest,
			depositMode: mode,
			possibleReferrer,
		};
	}

	private parseInitSwapLedger(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		const accounts = instruction.accounts;

		const userWallet = accounts[0];
		const userLedger = accounts[1];
		const circleMintInSolana = accounts[3];

		const destAddr = data.slice(1, 33);
		// const minMiddleAmount = data.readBigUInt64LE(33);

		const gasDrop = data.readBigUInt64LE(41);

		const feeRedeem = data.readBigUInt64LE(49);

		const feeSolana = data.readBigUInt64LE(57);

		const domainDest = data.readUInt32LE(65);

		const chainDest = data.readUInt16LE(69);

		const depositMode = data.readUInt8(71);

		const tokenOut = data.slice(72, 104);

		const referrerAddr = data.slice(104, 136);

		const minAmountOut = data.readBigUInt64LE(136);

		const deadline = data.readBigUInt64LE(144);

		const referrerBps = data.readUInt8(152);

		return {
			type: 'INIT_SWAP_LEDGER',
			userWallet: userWallet,
			userLedger: userLedger,
			circleMintInSolana: circleMintInSolana,
			destAddress: destAddr,
			gasDrop: gasDrop,
			feeRedeem: feeRedeem,
			feeSolana: feeSolana,
			depositMode: depositMode,
			tokenOut: tokenOut,
			referrerAddr: referrerAddr,
			minAmountOut: minAmountOut,
			destinationDomain: domainDest,
			deadline: deadline,
			referrerBps: referrerBps,
			destinationChain: chainDest,
		};
	}

	private parseBridgeWithLockedFee(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		const accounts = instruction.accounts;

		const owner = accounts[0];

		// circle
		const msg = accounts[9];

		const feeState = accounts[11];

		const destimationDomain = data.readUInt32LE(1);

		return {
			userLedger: owner,
			circleMsgAcc: msg,
			destinationDomain: destimationDomain,
			sourceDomain: CIRCLE_DOMAIN_SOLANA,
			feeState: feeState,
			type: 'BRIDGE_WITH_LOCKED_FEE'
		};
	}

	private parseBridgeWithFee(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		const accounts = instruction.accounts;

		const owner = accounts[0];

		// circle
		const msg = accounts[9];
		// const msgAccountData = await this.connection.getAccountInfo(msg);
		// const circleMessage = '0x' + msgAccountData.data.slice(44).toString('hex');

		// const parsedCircleMessage = parseCircleMessage(msgAccountData.data.slice(44));


		// wormhole
		const messageKey = accounts[13];
		// const wormholeMessage = await this.connection.getAccountInfo(messageKey);
		// const wormholeSequence = wormholeMessage.data.readUInt32LE(49);

		const destimationDomain = data.readUInt32LE(1);

		let result: CommonParsedInstructionData = {
			userLedger: owner,
			destinationDomain: destimationDomain,
			sourceDomain: CIRCLE_DOMAIN_SOLANA,
			wormholeMessageAcc: messageKey,
			circleMsgAcc: msg,
			type: 'BRIDGE_WITH_FEE',
		};

		return result;
	}

	private parseInitSwap(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		const accounts = instruction.accounts;

		const swapState = accounts[0];

		const owner = accounts[4];

		const msg = accounts[13];

		const destinationDomain = data.readUInt32LE(1);

		return {
			type: 'INIT_SWAP',
			userLedger: owner,
			circleMsgAcc: msg,
			swapState: swapState,
		}
	}

	private parseFlashSwapFinish(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		return {
			swapState: instruction.accounts[0],
			type: 'SWAP',
		};
	}

	private parseRefund(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		return {
			swapState: instruction.accounts[0],
			type: 'REFUND',
		};
	}

	private parseSettle(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		return {
			swapState: instruction.accounts[0],
			type: 'SETTLE',
		};
	}

	private parseRedeemWithFee(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		return {
			type: 'REDEEM_WITH_FEE',
			circleMessage: data.slice(33, 33 + 248)
		};
	}

	private parseUnlockFee(instruction: PartiallyDecodedInstruction, data: Buffer): CommonParsedInstructionData {
		return {
			type: 'UNLOCK_FEE',
		};
	}

	parsePayloadWriterPayloads(ixs: PartiallyDecodedInstruction[]): {[payloadAccount: string]: Buffer} {
		let result: {[payloadAccount: string]: Buffer} = {};
		for (let ix of ixs) {
			let parsed;
			try {
				parsed = this.payloadWriterIxCoder.decode(ix.data, 'base58');
			} catch (err) {
				console.error(`failed to parse anchor instruction data for payload writer mctp anchor: ${err}`);
				continue;
			}
			let parsedData = parsed!.data as any;

			if (parsed?.name === 'createSimple') {
				const payloadAccount = ix.accounts[1].toString();
				result[payloadAccount] = Buffer.from(Uint8Array.from(parsedData.data));
			}

		}

		return result;
	}

	parseMctpV2Instruction(instruction: PartiallyDecodedInstruction): CommonParsedInstructionData | null {
		let parsed;
		try {
			parsed = this.mctpV2instructionCoder.decode(instruction.data, 'base58');
		} catch (err) {
			console.error(`failed to parse anchor instruction data for swift anchor: ${err}`);
			return null;
		}
		if (!parsed) {
			console.warn(`parsed anchor instruction data is empty for swift anchor`);
			return null;
		}
		let parsedData = parsed.data as any;

		switch (parsed.name) {
			case `initBridgeLedger`:
				return {
					type: 'INIT_BRIDGE_LEDGER',
					userWallet: instruction.accounts[0],
					userLedger: instruction.accounts[1],
					customPayloadStore: instruction.accounts[3],
					circleMintInSolana: instruction.accounts[4],
					gasDrop: BigInt(parsedData.params.gasDrop.toString()),
					feeRedeem: BigInt(parsedData.params.feeRedeem.toString()),
					feeSolana: BigInt(parsedData.params.feeSolana.toString()),
					destAddress: Buffer.from(Uint8Array.from(parsedData.params.addrDest)),
					destinationDomain: Number(WhChainIdToCircle[parsedData.params.chainDest]),
					destinationChain: Number(parsedData.params.chainDest),
					depositMode: Number(parsedData.params.mode),
					possibleReferrer: instruction.accounts[6],
					isV2: true,
				}
			case `initOrderLedger`:
				return {
					type: 'INIT_SWAP_LEDGER',
					userWallet: instruction.accounts[0],
					userLedger: instruction.accounts[1],
					circleMintInSolana: instruction.accounts[3],
					destAddress: Buffer.from(Uint8Array.from(parsedData.params.addrDest)),
					gasDrop: BigInt(parsedData.params.gasDrop.toString()),
					feeRedeem: BigInt(parsedData.params.feeRedeem.toString()),
					feeSolana: BigInt(parsedData.params.feeSolana.toString()),
					depositMode: Number(parsedData.params.mode),
					tokenOut: Buffer.from(Uint8Array.from(parsedData.params.tokenOut)),
					referrerAddr: Buffer.from(Uint8Array.from(parsedData.params.addrRef)),
					minAmountOut: BigInt(parsedData.params.amountOutMin.toString()),
					destinationDomain: Number(WhChainIdToCircle[parsedData.params.chainDest]),
					deadline: BigInt(parsedData.params.deadline.toString()),
					referrerBps: Number(parsedData.params.feeRateRef),
					destinationChain: Number(parsedData.params.chainDest),
					swapState: PublicKey.findProgramAddressSync(
						[
							Buffer.from(`ORDER_SOLANA_SOURCE`),
							instruction.accounts[1].toBuffer(),
						],
						this.mctpV2,
					)[0],
					isV2: true,
				};
			case `createOrder`:
				return {
					type: 'INIT_SWAP',
					userLedger: instruction.accounts[0],
					circleMsgAcc: instruction.accounts[13],
					swapState: instruction.accounts[5],
					isV2: true,
				};
			case `bridgeLockedFee`:
				return {
					userLedger: instruction.accounts[0],
					circleMsgAcc: instruction.accounts[14],
					sourceDomain: CIRCLE_DOMAIN_SOLANA,
					feeState: instruction.accounts[4],
					type: 'BRIDGE_WITH_LOCKED_FEE',
					isV2: true,
				};
			case `bridgeWithFee`:
				return {
					userLedger: instruction.accounts[0],
					sourceDomain: CIRCLE_DOMAIN_SOLANA,
					wormholeMessageAcc: instruction.accounts[19],
					circleMsgAcc: instruction.accounts[12],
					type: 'BRIDGE_WITH_FEE',
					isV2: true,
				};
			case `settleOrder`:
				return {
					type: 'SETTLE',
					swapState: instruction.accounts[0],
				};
			case `refundOrder`:
				return {
					type: 'REFUND',
					swapState: instruction.accounts[0],
				};
			case `unlockFee`:
				return {
					type: 'UNLOCK_FEE',
				};
			case `redeemWithFeeShim`:
			case `redeemWithFee`:
			case `redeemWithFeeCustomPayload`:
				return {
					type: 'REDEEM_WITH_FEE',
					circleMessage:  Buffer.from(new Uint8Array(parsedData.params.cctpMessage)),
				};
			case `flashSwapFinish`:
				return {
					type: 'SWAP',
					swapState: instruction.accounts[0],
				};

		}

		return null;
	}

	parseMctpInstruction(instruction: PartiallyDecodedInstruction): CommonParsedInstructionData | null {
		try {
			const data = base58_to_binary(instruction.data);
			const instructionNumber = data[0];


			switch (instructionNumber) {
				case 40:
					return this.parseInitBridgeLedger(instruction, Buffer.from(data));
				case 41:
					return this.parseInitSwapLedger(instruction, Buffer.from(data));
				case 42:
					return this.parseInitSwap(instruction, Buffer.from(data));
				case 12:
					return this.parseBridgeWithLockedFee(instruction, Buffer.from(data));
				case 11:
					return this.parseBridgeWithFee(instruction, Buffer.from(data));
				case 10:
					return this.parseRedeemWithFee(instruction, Buffer.from(data));
				case 13:
					return this.parseUnlockFee(instruction, Buffer.from(data));
				case 24:
					return this.parseFlashSwapFinish(instruction, Buffer.from(data));
				case 25:
					return this.parseSettle(instruction, Buffer.from(data));
				case 26:
					return this.parseRefund(instruction, Buffer.from(data));
				default:
					return null;
			}
		} catch (error) {
			console.error(`parse mctp solana instruction failed for program ${instruction.programId} err: ${error}`);
			throw error;
		}
	}

	async checkTx(signature: string, mctpVersion: number): Promise<Swap[]> {
        let result = [];
		console.log(`processing signature ${signature}`);
		let trx: ParsedTransactionWithMeta | null = null;
		try {
			trx = await this.connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
		} catch (err) {
			console.log('mctp solana check tx error', err);
			throw err;
		}
		if (!trx) {
			// await this.connection.getTransaction(signature, {commitment: 'confirmed'});
			console.log(`trx ${signature} is null (not ready for parse)`);
			throw new Error('parse trx failed');
		}
		if (trx.meta!.err) {
			return [];
		}

		let programFilter = mctpVersion === 1 ? new PublicKey(MCTP_SOLANA) : this.mctpV2;

		const mayanInstructions = trx.transaction.message.instructions.filter(ins => ins.programId.equals(programFilter));
		for (let innerIx of trx.meta!.innerInstructions || []) {
			mayanInstructions.push(...innerIx.instructions.filter(ins => ins.programId.equals(programFilter)));
		}


		const payloadWriterInstructions = trx.transaction.message.instructions.filter(ins => ins.programId.equals(new PublicKey(MctpPayloadWriterIdl.address)));
		for (let innerIx of trx.meta!.innerInstructions || []) {
			payloadWriterInstructions.push(...innerIx.instructions.filter(ins => ins.programId.equals(new PublicKey(MctpPayloadWriterIdl.address))));
		}
		const payloadBuffers = this.parsePayloadWriterPayloads(payloadWriterInstructions as PartiallyDecodedInstruction[]);

		const mctpFilteredInstructions: CommonParsedInstructionData[] = [];
		for (let j = 0; j < mayanInstructions.length; j++) {
			let ins: CommonParsedInstructionData | null = null;
			if (mctpVersion === 1) {
				ins = this.parseMctpInstruction(mayanInstructions[j] as PartiallyDecodedInstruction);
			} else if (mctpVersion === 2) {
				ins = this.parseMctpV2Instruction(mayanInstructions[j] as PartiallyDecodedInstruction);
			}
			if (ins) {
				mctpFilteredInstructions.push(ins);
			}
		}

		if (mctpFilteredInstructions.length === 0) {
			return [];
		}

		const txDate = trx.blockTime ? new Date(trx.blockTime * 1000) : new Date();

		let swaps = [];
		let ss;
		for (let instructionData of mctpFilteredInstructions) {
			switch (instructionData.type) {
				case 'INIT_BRIDGE_LEDGER':
				case 'INIT_SWAP_LEDGER':
					ss = await this.createSwap(signature, trx, txDate, instructionData, payloadBuffers);
					if (ss) {
						swaps.unshift(ss)
					}
					break;
				case 'BRIDGE_WITH_FEE':
				case 'BRIDGE_WITH_LOCKED_FEE':
				case 'INIT_SWAP':
					ss = await this.updateSwapOnCCTPBridge(trx, instructionData);
					if (ss) {
						swaps.unshift(ss)
					}
					break;
				case 'REDEEM_WITH_FEE':
					const cctpHash = ethers.utils.keccak256(instructionData.circleMessage!).slice(2);
                    // TODO: find and update swap with cctp hash
					// await updateSwaps({
					// 	where: { cctpMessageHash: cctpHash },
					// 	data: {
					// 		redeemTxHash: signature,
					// 		fulfillTxHash: signature,
					// 		completedAt: new Date(trx.blockTime * 1000),
					// 	},
					// });
					break;
				case 'SETTLE':
                    // TODO: find and update swap with state addr
					// await updateSwaps({
					// 	where: { stateAddr: instructionData.swapState.toString() },
					// 	data: {
					// 		redeemTxHash: signature,
					// 		fulfillTxHash: signature,
					// 		completedAt: new Date(trx.blockTime * 1000),
					// 	},
					// });
					break;
				case 'REFUND':
                    // TODO: find and update swap with state addr
					// await updateSwaps({
					// 	where: { stateAddr: instructionData.swapState.toString() },
					// 	data: {
					// 		refundTxHash: signature,
					// 		completedAt: new Date(trx.blockTime * 1000),
					// 	},
					// });
					break;
			}
		}

		return swaps;
	}

	async tryExtractBridgeTransactionFromInitLedgerTx(swap: Swap, initTxSignature: string, userLedger: PublicKey) {
		try {
			const relatedSignatures  = await this.connection.getSignaturesForAddress(
				userLedger,
				{
					until: initTxSignature,
					limit: 30,
				},
				'confirmed',
			);
			const successFullSignatures = relatedSignatures.filter((s) => !s.err);

			let mctpVersion: number = getMctpContractSetVersion(swap);

			for (let sigInfo of successFullSignatures.slice(0, 3)) { // check at most 3 txs
				await this.checkTx(sigInfo.signature, mctpVersion);
			}
		} catch (err) {
			console.warn(`Unable to fallbackly extract transaction from init ledger info... ${err}`)
		}
	}
}


type CommonParsedInstructionData = {
	customPayloadStore?: PublicKey,
	userWallet?: PublicKey,
	userLedger?: PublicKey,
	circleMintInSolana?: PublicKey,
	swapState?: PublicKey,
	circleMsgAcc?: PublicKey,
	sourceDomain?: number,
	destinationDomain?: number,
	destinationChain?: number,
	tokenOut?: Buffer,
	referrerAddr?: Buffer,
	minAmountOut?: bigint,
	deadline?: bigint,
	referrerBps?: number,
	wormholeMessageAcc?: PublicKey,
	destAddress?: Buffer,
	gasDrop?: bigint,
	feeRedeem?: bigint,
	feeSolana?: bigint,
	amountBridged?: bigint,
	feeState?: PublicKey,
	circleMessage?: Buffer,
	possibleReferrer?: PublicKey,
	type: 'BRIDGE_WITH_FEE' | 'BRIDGE_WITH_LOCKED_FEE' | 'REDEEM_WITH_FEE' | 'UNLOCK_FEE' | 'SETTLE' | 'REFUND' | 'SWAP' | 'INIT_BRIDGE_LEDGER' | 'INIT_SWAP_LEDGER' | 'INIT_SWAP',
	depositMode?: number,
	isV2?: boolean,
};

type MctpInstruction = {
	programId: string,
	goal: InstructionGoal,
	stateAddr: string,
	stateNonce: number,
};

export type InstructionGoal = 'CREATE' | 'FULFILL' | 'CANCEL' | 'UNLOCK' | 'REFUND' | 'SETTLE' | 'REGISTER' | 'BRIDGE';


export function getHypercoreData(customPayload: string) {
	const payload = hexToUint8Array(customPayload);
	return {
		toChain: CHAIN_ID_HYPERCORE.toString(),
		toToken: getNativeUsdc(CHAIN_ID_HYPERCORE),
		destAddress: tryUint8ArrayToNativeGeneral(payload.slice(8, 28), CHAIN_ID_HYPERCORE),
		depositAmount64: Buffer.from(payload.slice(28, 36)).readBigUInt64BE(0).toString(),
	};
}

export function getMctpContractSetVersion(swap: Swap) {
    // mctp v1 is not available in the latest sdks
	return 2;
}
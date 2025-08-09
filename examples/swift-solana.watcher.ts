import { AnchorProvider, BorshInstructionCoder, EventParser, Instruction, Program, Wallet } from '@coral-xyz/anchor';
import { BorshAccountsCoder } from "@coral-xyz/anchor";

import { IDL as SwiftIdl } from '../abis/swift.idl';
import { getSequenceFromWormholeScan, getWormholePostedSequenceWithRetry } from '../utils/wh';
import {
	ConfirmedSignatureInfo,
	Connection,
	Keypair,
	ParsedMessageAccount,
	ParsedTransactionWithMeta,
	PartiallyDecodedInstruction,
	PublicKey,
} from '@solana/web3.js';
import { ethers } from 'ethers';
import { tryUint8ArrayToNative } from '../utils/bytes';


import { JupiterIxParser } from '../utils/jup-parser';
import { SWIFT_AUCTION, SWIFT_SOLANA } from '../utils/const';
import { CHAIN_ID_SOLANA } from '../utils/chain-map';
import { reconstructOrderHash } from '../utils/hash';
import { NativeTokens } from '../utils/tokens';
import { getTokenDataGeneral } from '../utils/token.util';

const WORMHOLE_DECIMALS = 8;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


export class SwiftSolanaWatcher {
	private program: Program;
	private eventParser: EventParser;
	private instructionCoder: BorshInstructionCoder;
	private auction: PublicKey;

	constructor(
		private readonly jupParser: JupiterIxParser,
        private readonly connection: Connection,
	) {
		this.auction = new PublicKey(SWIFT_AUCTION);
		this.program = new Program(
			SwiftIdl as any,
			SWIFT_SOLANA,
			new AnchorProvider(this.connection, new Wallet(Keypair.generate()), {
				commitment: 'confirmed',
			}),
		)
		this.instructionCoder = new BorshInstructionCoder(SwiftIdl);
		this.eventParser = new EventParser(this.program.programId, this.program.coder);
	}

	async parseAndCreateInitOrder(sig: string, trx: ParsedTransactionWithMeta, parsedData: Instruction, instruction: PartiallyDecodedInstruction): Promise<any> {
		if (parsedData.name !== 'initOrder') {
			throw new Error('parsedData.name must be initOrder');
		}

		let {forwardedTokenAddress, forwardedFromAmount, forwardedFromSymbol} = await this.jupParser.extractJupSwapFromTrxOrBundle(sig, trx);

		const {
			amountInMin, // BN
			nativeInput, // boolean
			feeSubmit, // BN
			addrDest, // bytes32. js array of number
			chainDest, // u8 js number
			tokenOut, // bytes32. js array of number
			amountOutMin, // BN
			gasDrop, // BN
			feeCancel, // BN
			feeRefund, // BN
			deadline, // BN
			addrRef, // bytes32. js array of number
			feeRateRef, // u8 js number
			feeRateMayan, // u8 js number
			auctionMode, // u8 js number
			keyRnd, // bytes32. js array of number
		} = (parsedData.data as any).params;

		const trader = instruction.accounts[0].toString();
		const stateAddr = instruction.accounts[2].toString();
		const stateFromAcc = instruction.accounts[3];
		const stateFromAccIdx = trx.transaction.message.accountKeys.findIndex(acc => acc.pubkey.equals(stateFromAcc));
		const mintFrom = instruction.accounts[5].toString();

		let fromAmount: bigint | null = null;
		try {
			for (let log of this.eventParser.parseLogs(trx.meta!.logMessages!, false)) {
				if (log.name === 'OrderInitialized') {
					fromAmount = BigInt(log.data.amountIn as any);
				}
			}
		} catch (innerErr) {
			console.error(`failed to parse OrderInitialized swift event for sig ${sig} ${innerErr}`);
		}

		if (!fromAmount) {
			const statePostBalance = trx.meta!.postTokenBalances!.find((tok) => tok.accountIndex === stateFromAccIdx);
			const statePreBalance = trx.meta!.preTokenBalances!.find((tok) => tok.accountIndex === stateFromAccIdx);

			if (!statePostBalance) {
				throw new Error(`fromAmount not found for sig ${sig}`);
			}
			const postAmount64  = BigInt(statePostBalance.uiTokenAmount.amount);
			const preAmount64 = BigInt(statePreBalance?.uiTokenAmount?.amount || '0');
			fromAmount = postAmount64 - preAmount64;
		}


		const randomKey = '0x' + Buffer.from(keyRnd).toString('hex');

		const fromToken = nativeInput ? NativeTokens[CHAIN_ID_SOLANA] : (await getTokenDataGeneral(CHAIN_ID_SOLANA, mintFrom));
		const destTokenAddress = tryUint8ArrayToNative(Uint8Array.from(tokenOut), chainDest);
		const toToken = (await getTokenDataGeneral(chainDest, destTokenAddress));

		const referrerAddress = tryUint8ArrayToNative(Uint8Array.from(addrRef), chainDest);
		const destAddress = tryUint8ArrayToNative(Uint8Array.from(addrDest), chainDest);

		const orderHash = reconstructOrderHash(
			trader,
			CHAIN_ID_SOLANA,
			nativeInput ? '11111111111111111111111111111111' : fromToken.contract, // hack for native sol locking
			chainDest,
			toToken.contract,
			BigInt(amountOutMin),
			BigInt(gasDrop),
			BigInt(feeCancel),
			BigInt(feeRefund),
			deadline,
			destAddress,
			referrerAddress,
			feeRateRef,
			feeRateMayan,
			auctionMode,
			randomKey,
		);

		const calculatedState = getSwiftStateAddrSrc(instruction.programId, orderHash);

		if (calculatedState.toString() !== stateAddr) {
			throw new Error(`calculated state ${calculatedState.toString()} not equal to stateAddr ${stateAddr} for sig ${sig}`);
		}

		const orderHashStr = '0x' + orderHash.toString('hex');

		const swap = {
			trader: trader,
			sourceTxBlockNo: trx.slot,
			sourceTxHash: sig,
			createTxHash: sig,
			orderId: `SWIFT_${orderHashStr}`,
			status: `ORDER_CREATED`,
			orderHash: orderHashStr,
			randomKey: randomKey,
			payloadId: null,
			statusUpdatedAt: new Date(trx.blockTime! * 1000),
			deadline: new Date(Number(deadline) * 1000),
			sourceChain: CHAIN_ID_SOLANA.toString(),
			swapChain: chainDest.toString(),
			fromTokenAddress: fromToken.contract,

			auctionMode: auctionMode,

			fromAmount: ethers.utils.formatUnits(fromAmount.toString(), fromToken.decimals),
			fromAmount64: fromAmount.toString(),
			forwardedFromAmount: forwardedFromAmount,
			forwardedTokenAddress: forwardedTokenAddress,
			forwardedTokenSymbol: forwardedFromSymbol,

			toTokenAddress: toToken.contract,

			destChain: chainDest.toString(),
			destAddress: destAddress,

			referrerBps: feeRateRef,
			mayanBps: feeRateMayan,
			referrerAddress: referrerAddress,

			stateAddr: stateAddr,
			auctionStateAddr: PublicKey.findProgramAddressSync(
				[Buffer.from('AUCTION'), orderHash],
				this.auction,
			)[0].toString(),

			minAmountOut: ethers.utils.formatUnits(
				amountOutMin.toString(),
				Math.min(WORMHOLE_DECIMALS, toToken.decimals),
			),
			minAmountOut64: amountOutMin.toString(),

			gasDrop: ethers.utils.formatUnits(
				gasDrop.toString(),
				Math.min(WORMHOLE_DECIMALS, toToken.decimals),
			),
			gasDrop64: gasDrop.toString(),

			savedAt: new Date(),
			initiatedAt: new Date(trx.blockTime! * 1000),
		};

		// TODO: save somewhere?
	}

	async updateInitOrderForGasless(swapId: string, sig: string, trx: ParsedTransactionWithMeta, parsedData: Instruction, instruction: PartiallyDecodedInstruction) {
		let fromAmount: bigint | null = null;
		try {
			for (let log of this.eventParser.parseLogs(trx.meta!.logMessages!, false)) {
				if (log.name === 'OrderInitialized') {
					fromAmount = BigInt(log.data.amountIn as any);
				}
			}
		} catch (innerErr) {
			console.error(`failed to parse OrderInitialized updateInitOrderForGasless swift event for sig ${sig} ${innerErr}`);
		}


		if (!fromAmount) {
			const stateFromAcc = instruction.accounts[3];
			const stateFromAccIdx = trx.transaction.message.accountKeys.findIndex(acc => acc.pubkey.equals(stateFromAcc));

			const statePostBalance = trx.meta!.postTokenBalances!.find((tok) => tok.accountIndex === stateFromAccIdx);
			const statePreBalance = trx.meta!.preTokenBalances!.find((tok) => tok.accountIndex === stateFromAccIdx);

			if (!statePostBalance) {
				throw new Error(`fromAmount not found for sig ${sig}`);
			}
			const postAmount64  = BigInt(statePostBalance.uiTokenAmount.amount);
			const preAmount64 = BigInt(statePreBalance?.uiTokenAmount?.amount || '0');
			fromAmount = postAmount64 - preAmount64;
		}

		const mintFrom = instruction.accounts[5].toString();
		const fromToken = (parsedData.data as any).nativeInput ? NativeTokens[CHAIN_ID_SOLANA] : (await getTokenDataGeneral(CHAIN_ID_SOLANA, mintFrom));
		let {forwardedTokenAddress, forwardedFromAmount, forwardedFromSymbol} = await this.jupParser.extractJupSwapFromTrxOrBundle(sig, trx);


		// TODO: update swap?
		// updateSwap({
		// 	where: { id: swapId },
		// 	data: {
		// 		statusUpdatedAt: new Date(trx.blockTime! * 1000),
		// 		createTxHash: sig,
		// 		fromAmount: ethers.utils.formatUnits(fromAmount.toString(), fromToken.decimals),
		// 		fromAmount64: fromAmount.toString(),
		// 		forwardedFromAmount: forwardedFromAmount,
		// 		forwardedTokenAddress: forwardedTokenAddress,
		// 		forwardedTokenSymbol: forwardedFromSymbol,
		// 	},
		// });

	}

	parseSwiftInstruction(instruction: PartiallyDecodedInstruction): SwiftInstruction | null {
		try {
			const parsed = this.instructionCoder.decode(instruction.data, 'base58');
			if (!parsed) {
				console.warn(`parsed anchor instruction data is empty for swift anchor`);
				return null;
			}

			let relayer: PublicKey;
			let winner: string;
			let whMessageAcc: PublicKey;
			let destAddress: PublicKey;
			let destAddressAss: PublicKey;
			let stateAddress;
			let stateNonce = 0;
			let instructionGoal: InstructionGoal | null = null;
			switch (parsed.name) {
				case 'initOrder':
					instructionGoal = 'REGISTER';
					stateAddress = instruction.accounts[2];
					break;
				case 'registerOrder':
					instructionGoal = 'REGISTER_ORDER';
					stateAddress = instruction.accounts[1];
					relayer = instruction.accounts[0];
					break;
				case 'fulfill':
					instructionGoal = 'FULFILL';
					stateAddress = instruction.accounts[0];
					winner = instruction.accounts[1].toString();
					break;
				case 'settle':
					instructionGoal = 'SETTLE';
					stateAddress = instruction.accounts[0];
					destAddress = instruction.accounts[4];
					destAddressAss = instruction.accounts[9];
					break;
				case 'cancel':
					instructionGoal = 'CANCEL';
					stateAddress = instruction.accounts[0];
					whMessageAcc = instruction.accounts[6];
					break;
				case 'close':
					instructionGoal = 'CLOSE';
					stateAddress = instruction.accounts[0];
					break;
				case 'refund':
					instructionGoal = 'REFUND';
					stateAddress = instruction.accounts[1];
					break;
				case 'unlock':
					instructionGoal = 'UNLOCK';
					stateAddress = instruction.accounts[1];
					break;
				case 'unlockBatch':
					instructionGoal = 'UNLOCK_BATCH';
					stateAddress = instruction.accounts[1];
					break;
				case 'postUnlock':
					instructionGoal = 'POST_UNLOCK';
				case 'postUnlockShim':
					instructionGoal = 'POST_UNLOCK_SHIM';
					break;
			}

			return {
				programId: instruction.programId.toString(),
				stateAddr: stateAddress?.toString(),
				stateNonce,
				goal: instructionGoal!,
				winner: winner!,
				relayer: relayer!,
				whMessageAcc: whMessageAcc!,
				destAddress: destAddress!,
				destAddressAss: destAddressAss!,
				rawInstruction: instruction,
				parsedData: parsed,
			}
		} catch (error) {
			console.error(`parse swift solana instruction failed for program ${instruction.programId} err: ${error}`);
			throw error;
		}
	}

	lock = false;
	async watchSolana(): Promise<void> {
		if (this.lock) {
			return;
		}
		this.lock = true;
		let lastCompletedPointInfo: {
			sig: string;
			updated: Date;
		}
		try {
			let swiftSolanaProgram = SWIFT_SOLANA;

			// TODO: add some db?
			// lastCompletedPointInfo = getLastSigCheckedInfo(swiftSolanaProgram);

			let lastCompletedPoint = ''
			let currentSignatureInfos: ConfirmedSignatureInfo[] = [];
			let firstSignature: string = '';
			let tempLastSignature: string = '';
			let tempLastSlot: number = 0;
			do {
				currentSignatureInfos = await this.connection.getSignaturesForAddress(
					new PublicKey(swiftSolanaProgram),
					{
						before: tempLastSignature,
						until: lastCompletedPoint,
						limit: 100,
					},
					'finalized',
				);
				if (tempLastSlot) {
					currentSignatureInfos = currentSignatureInfos.filter(cs => cs.slot !== tempLastSlot);
				}
				if (currentSignatureInfos.length > 0) {
					if (!firstSignature) {
						firstSignature = currentSignatureInfos[0].signature;
					}
					tempLastSignature = currentSignatureInfos[currentSignatureInfos.length - 1].signature;
					tempLastSlot = currentSignatureInfos[currentSignatureInfos.length - 1].slot;
				}

				await Promise.all(currentSignatureInfos.map(s => this.checkTx(s.signature)));
			} while (currentSignatureInfos.length !== 0)

			// TODO: update last checkpoint?
			//await setLastSigChecked(swiftSolanaProgram, firstSignature);
			this.lock = false;
		} catch (err: any) {
			console.error(`error in watchSolana ${err} ${err.stack}`);
			this.lock = false;
		}
	}

	calculateAmountOut(trx: ParsedTransactionWithMeta, destAss: PublicKey, destAddr: PublicKey): {
		amount: bigint,
		decimals: number,
	} {
		const swapAccs = trx.transaction.message.accountKeys.map(acc => acc.pubkey.toString());
		const destAssIndex = swapAccs.indexOf(destAss.toString());

		const afterMeta = trx.meta!.postTokenBalances!.find((tok) => tok.accountIndex === destAssIndex);
		const after = afterMeta?.uiTokenAmount?.amount || '0';
		const before = (trx.meta!.preTokenBalances!.find((tok) => tok.accountIndex === destAssIndex))?.uiTokenAmount.amount || '0';

		if (BigInt(after) - BigInt(before) === 0n) { // Native Sol because wrapped sol is closed
			const destIndex = swapAccs.indexOf(destAddr.toString());
			const after = trx.meta!.postBalances![destIndex];
			const before = trx.meta!.preBalances![destIndex];
			return {
				amount: BigInt(after) - BigInt(before),
				decimals: 9, // sol
			};
		}
		return {
			amount: BigInt(after) - BigInt(before),
			decimals: afterMeta!.uiTokenAmount.decimals,
		};
	}

	private async writePostUnlockShimSequences(signature: string, instruction: PartiallyDecodedInstruction) {
		const statesAccs = instruction.accounts.slice(11);

		const sequence = await getSequenceFromWormholeScan(signature);

		// TODO: update swap?
		// await updateSwaps({
		// 	where: { stateAddr: { in: statesAccs.map(acc => acc.toString()) } },
		// 	data: {
		// 		redeemSequence: sequence.toString(),
		// 	},
		// })
	}

	private async writePostUnlockSequences(instruction: PartiallyDecodedInstruction) {
		const whMessageAcc = instruction.accounts[5];
		const statesAccs = instruction.accounts.slice(10);

		const sequence = await getWormholePostedSequenceWithRetry(
			this.connection,
			whMessageAcc,
		);

		// TODO: update swap?
		// await updateSwaps({
		// 	where: { stateAddr: { in: statesAccs.map(acc => acc.toString()) } },
		// 	data: {
		// 		redeemSequence: sequence.toString(),
		// 	},
		// })
	}

	async checkTx(signature: string, retries = 2): Promise<void> {
		let trx: ParsedTransactionWithMeta | null = null;
		try {
			trx = await this.connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
		} catch (err) {
			if (retries > 0) {
				return await this.checkTx(signature, retries - 1);
			}
			console.error(` swift tx not available ${err}`);
			throw err;
		}
		if (!trx) {
			console.log(`trx ${signature} is null (not ready for parse)`);
			throw new Error('parse trx failed');
		}
		if (trx.meta!.err) {
			return;
		}

		const mayanInstructions = trx.transaction.message.instructions.filter(ins => ins.programId.equals(new PublicKey(SWIFT_SOLANA)));
		for (let innerIx of trx.meta!.innerInstructions || []) {
			mayanInstructions.push(...innerIx.instructions.filter(ins => ins.programId.equals(new PublicKey(SWIFT_SOLANA))));
		}

		const swiftFilteredInstructions: SwiftInstruction[] = [];
		for (let j = 0; j < mayanInstructions.length; j++) {
			const ins = this.parseSwiftInstruction(mayanInstructions[j] as PartiallyDecodedInstruction);
			if (ins) {
				swiftFilteredInstructions.push(ins);
			}
		}

		if (swiftFilteredInstructions.length === 0) {
			return;
		}

		const txDate = trx.blockTime ? new Date(trx.blockTime * 1000) : new Date();

		let hasCreateOrder = false;
		let swapId: string | null = null;
		for (let ins of swiftFilteredInstructions) {
			if (!ins.goal) {
				continue;
			}
			// TODO: find existingswap?
			// let swap = await this.swapService.findSwap({ stateAddr: ins.stateAddr });
			let swap: any = null;
			if (ins.goal === 'REGISTER') {
				if (!swap) {
					const newSwap = await this.parseAndCreateInitOrder(signature, trx, ins.parsedData!, ins.rawInstruction!);
					if (newSwap) {
						swapId = newSwap.id;
					}
				} else {
					await this.updateInitOrderForGasless(swap.id, signature, trx, ins.parsedData!, ins.rawInstruction!);
					swapId = swap.id;
				}
				if (swapId) {
					hasCreateOrder = true;
				}
			} else if (ins.goal === 'POST_UNLOCK') {
				await this.writePostUnlockSequences(ins.rawInstruction!);
			} else if (ins.goal === 'POST_UNLOCK_SHIM') {
				await this.writePostUnlockShimSequences(signature, ins.rawInstruction!);
			} else {
				if (!swap) {
					throw new Error(`swap not found for instruction that requires swap to exist ${signature} ${ins.goal} ${ins.stateAddr}`);
				}
				let updatedData: any = {};

				switch (ins.goal) {
					case 'REGISTER_ORDER':
						if (this.isFirstRegisterOrder(
							ins.stateAddr!,
							trx.transaction.message.accountKeys,
							trx.meta!.postBalances,
							trx.meta!.preBalances,
						)) {
							updatedData.relayerAddress = ins.relayer.toString();
						}
						break;
					case 'FULFILL':
						updatedData.driverAddress = ins.winner;
						break;
					case 'UNLOCK_BATCH':
					case 'UNLOCK':
						updatedData.redeemTxHash = signature;
						updatedData.status = `ORDER_UNLOCKED`;
						break;
					case 'SETTLE':
						updatedData.fulfillTxHash = signature;
						updatedData.completedAt = new Date(trx.blockTime! * 1000);
						updatedData.batchFulfilled = true;
						if (
							swap.status === `ORDER_CREATED` ||
							swap.status === `ORDER_FULFILLED`
						) {
							updatedData.status = `ORDER_SETTLED`;
						}
						const rawToAmountData = this.calculateAmountOut(trx, ins.destAddressAss!, ins.destAddress!);
						updatedData.toAmount = ethers.utils.formatUnits(
							rawToAmountData.amount.toString(),
							rawToAmountData.decimals,
						);
						break;
					case 'REFUND':
						const traderAcc = ins.rawInstruction!.accounts[4];
						const postTokenBalance = trx.meta!.postTokenBalances!.find(
							(tok) => tok.accountIndex === trx.transaction.message.accountKeys.findIndex(acc => acc.pubkey.equals(traderAcc)),
						);
						const preTokenBalance = trx.meta!.preTokenBalances!.find(
							(tok) => tok.accountIndex === trx.transaction.message.accountKeys.findIndex(acc => acc.pubkey.equals(traderAcc)),
						);

						if (postTokenBalance) {
							const diffAmount = BigInt(postTokenBalance?.uiTokenAmount?.amount || 0n) - BigInt(preTokenBalance?.uiTokenAmount?.amount || 0n);
							updatedData.toAmount = ethers.utils.formatUnits(diffAmount.toString(), postTokenBalance?.uiTokenAmount?.decimals || 8);
						}

						updatedData.refundTxHash = signature;
						break;
					case 'CLOSE':
						updatedData.stateOpen = false;
						break;
					case 'CANCEL':
						updatedData.refundSequence = (await getWormholePostedSequenceWithRetry(
							this.connection,
							ins.whMessageAcc!,
						)).toString();
						break;
				}

				// TODO: update swap?
				// await updateSwap({
				// 	where: { id: swap.id },
				// 	data: updatedData,
				// });
			}3
		}
	}

	private isFirstRegisterOrder(
		state: string,
		txAcocunts: ParsedMessageAccount[],
		postBalances: number[],
		preBalances: number[],
	): Boolean {
		const stateIdx = txAcocunts.findIndex((acc) => acc.pubkey.toString() === state);
		const balanceDiff = postBalances[stateIdx] - preBalances[stateIdx];
		return balanceDiff > 0;
	}
}

type SwiftInstruction = {
	programId: string,
	goal: InstructionGoal,
	stateAddr?: string,
	stateNonce: number,
	winner?: string,
	relayer: PublicKey,
	whMessageAcc?: PublicKey,
	destAddress?: PublicKey,
	destAddressAss?: PublicKey,
	rawInstruction?: PartiallyDecodedInstruction,
	parsedData?: Instruction,
};

export type InstructionGoal = 'REGISTER_ORDER' | 'FULFILL' | 'CANCEL' | 'UNLOCK' | 'REFUND' | 'SETTLE' | 'REGISTER' | 'CLOSE' | 'UNLOCK_BATCH' | 'POST_UNLOCK' | 'POST_UNLOCK_SHIM';




const SWIFT_SOLANA_SOURCE_STATE_SEED = Buffer.from("STATE_SOURCE");
const SWIFT_SOLANA_DEST_STATE_SEED = Buffer.from("STATE_DEST");
const accCoder = new BorshAccountsCoder(SwiftIdl);

export function getSwiftStateAddrSrc(programId: PublicKey, orderHash: Buffer): PublicKey {
	return PublicKey.findProgramAddressSync([
		SWIFT_SOLANA_SOURCE_STATE_SEED,
		orderHash,
	], programId)[0];
}

export function getSwiftStateAddrDest(programId: PublicKey, orderHash: Buffer): PublicKey {
	return PublicKey.findProgramAddressSync([
		SWIFT_SOLANA_DEST_STATE_SEED,
		orderHash,
	], programId)[0];
}

export async function getSwiftStateDest(connection: Connection, stateAddr: PublicKey): Promise<SwiftDestState | null> {
    const stateAccount = await connection.getAccountInfo(stateAddr);

    if (!stateAccount || !stateAccount.data) {
        return null;
    }

    if (stateAccount.data.length === 9) {
        return {
            status: SwiftDestStatuses.CLOSED,
        }
    }

    const data = accCoder.decode('swiftDestSolanaState', stateAccount.data);

    if (data.status.created) {
        return {
            status: SwiftDestStatuses.CREATED,
        }
    } else if (data.status.fulfilled) {
        return {
            status: SwiftDestStatuses.FULFILLED,
        }
    } else if (data.status.settled) {
        return {
            status: SwiftDestStatuses.SETTLED,
        }
    } else if (data.status.posted) {
        return {
            status: SwiftDestStatuses.POSTED,
        }
    } else if (data.status.cancelled) {
        return {
            status: SwiftDestStatuses.CANCELLED,
        }
    } else if (data.status.closed) {
        return {
            status: SwiftDestStatuses.CLOSED,
        }
    } else {
        throw new Error('Invalid status for dest');
    }
}

export async function getSwiftStateSrc(connection: Connection, stateAddr: PublicKey): Promise<SwiftSourceState | null> {
    const stateAccount = await connection.getAccountInfo(stateAddr);

    if (!stateAccount || !stateAccount.data) {
        return null;
    }

    const data = accCoder.decode('swiftSourceSolanaState', stateAccount.data);

    if (data.status.locked) {
        return {
            status: SWIFT_SRC_STATUSES.LOCKED,
        }
    } else if (data.status.unlocked) {
        return {
            status: SWIFT_SRC_STATUSES.UNLOCKED,
        }
    } else if (data.status.refunded) {
        return {
            status: SWIFT_SRC_STATUSES.REFUNDED,
        }
    } else {
        throw new Error('Invalid status for source');
    }
}

export type SwiftDestState = {
    status: string;
}

export type SwiftSourceState = {
    status: string;
}

export const SwiftDestStatuses = {
    CREATED: 'CREATED',
    FULFILLED: 'FULFILLED',
    SETTLED: 'SETTLED',
    POSTED: 'POSTED',
    CANCELLED: 'CANCELLED',
    CLOSED: 'CLOSED',
}

export const POST_CREATE_STATUSES = [
    SwiftDestStatuses.FULFILLED,
    SwiftDestStatuses.SETTLED,
    SwiftDestStatuses.POSTED,
    SwiftDestStatuses.CANCELLED,
    SwiftDestStatuses.CLOSED,
];

export const POST_FULFILL_STATUSES = [
    SwiftDestStatuses.SETTLED,
    SwiftDestStatuses.POSTED,
    SwiftDestStatuses.CLOSED,
];

export const SWIFT_SRC_STATUSES ={
    LOCKED: 'LOCKED',
    UNLOCKED: 'UNLOCKED',
    REFUNDED: 'REFUNDED',
}

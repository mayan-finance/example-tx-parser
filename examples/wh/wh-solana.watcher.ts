import { MayanState } from './state';

import {
	ConfirmedSignatureInfo,
	Connection,
	ParsedTransactionWithMeta,
	PartiallyDecodedInstruction,
	PublicKey,
} from '@solana/web3.js';
import { ethers } from 'ethers';
import { InstructionParserService, MayanInstruction } from './instruction-parser.service';
import { CHAIN_ID_SOLANA } from '../../utils/chain-map';

export class WhSolanaWatcher {
	mayanState: MayanState;
	taskLock: {[key: string]: boolean};
	mayanProgramPubKey: PublicKey;

	constructor(
        private readonly connection: Connection,
		private readonly instructionParserService: InstructionParserService,
	) {
		this.mayanState = new MayanState(this.connection);

		this.mayanProgramPubKey = new PublicKey('FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf');

		this.taskLock = {};
	}

    // TODO: add interval?
	async watchSolanaForProgram(programId: string): Promise<void> {
		if (this.taskLock[programId]) {
			return;
		}
		this.taskLock[programId] = true;
		let lastCompletedPointInfo: {
			key: string;
			sig: string;
			updated: Date;
		};
		try {
            // TODO: load checkpoint from db or sth
			const lastCompletedPoint = ''
			let currentSignatureInfos: ConfirmedSignatureInfo[] = [];
			let firstSignature: string | undefined;
			let tempLastSignature: string | undefined;
			let tempLastSlot: number | undefined;
			do {
				currentSignatureInfos = await this.connection.getSignaturesForAddress(
					new PublicKey(programId),
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

            // TODO: update checkpoint
			// await setLastSigChecked(programId, firstSignature);
			this.taskLock[programId] = false;
		} catch (err) {
			console.error(`error in watchSolana for prog: ${programId}, ${err}`);
			this.taskLock[programId] = false;
		}
	}

	async checkTx(signature: string) {
		let trx: ParsedTransactionWithMeta | null = null;
		try {
			trx = await this.connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
		} catch(err) {
			console.log('transaction not found tx=', signature, err);
			throw err;
		}
		if (!trx) {
			// await this.connection.getTransaction(signature, {commitment: 'confirmed'});
			console.error(`trx ${signature} is null (not ready for parse)`);
			throw new Error('parse trx failed');
		}
		if (trx.meta!.err) {
			return;
		}
		const mayanInstructions = trx.transaction.message.instructions.filter(
			ins => ins.programId.equals(this.mayanProgramPubKey),
		);
		for (let innerIx of trx.meta!.innerInstructions || []) {
			mayanInstructions.push(...innerIx.instructions.filter(ins => ins.programId.equals(this.mayanProgramPubKey)));
		}

		const mayanFilteredInstructions: MayanInstruction[] = [];
		for (let j = 0; j < mayanInstructions.length; j++) {
			const ins = this.instructionParserService.parseMayanInstruction(mayanInstructions[j] as PartiallyDecodedInstruction);
			if (ins) {
				mayanFilteredInstructions.push(ins);
			}
		}

		if (mayanFilteredInstructions.length === 0) {
			return;
		}

		const txDate = trx.blockTime ? new Date(trx.blockTime * 1000) : new Date();

		const followPromises = [];
		for (let ins of mayanFilteredInstructions) {
			console.log(`ins.stateAddr ${ins.stateAddr}`);
			const { data: stateData } = (await this.connection.getAccountInfo(new PublicKey(ins.stateAddr), 'confirmed'))!;
			const traderAddr = this.mayanState.parseStateSourceAddress(stateData);
			const sourceChain = this.mayanState.parseSourceChain(stateData);
			const destChain = this.mayanState.parseDestinationChain(stateData);


			const fromToken = await this.mayanState.parseStateFromToken(stateData);
			const toToken = await this.mayanState.parseStateToToken(stateData);
			const toTokenInSolana = this.mayanState.findTokenInSolana(toToken);

			const redeemSequence = this.mayanState.parseStateRedeemSequences(stateData);
			let amountOut = this.mayanState.parseStateAmountOut(stateData);
			const fees = this.mayanState.parseStateFees(stateData);
			const gasDrop = this.mayanState.parseGasDrop(stateData);

			let gasTokenDecimals = destChain === CHAIN_ID_SOLANA ? 9 : 8;

			if (amountOut && destChain !== CHAIN_ID_SOLANA) {
				amountOut -= fees.redeemFee;
			}

			console.log(`ins: ${ins.goal} ${ins.stateAddr} ${ins.stateNonce} ${ins.meta} ${fees} ${ins.programId}`);
			if (sourceChain === CHAIN_ID_SOLANA && ins.goal === 'REGISTER') {
				console.log(`creating swap in db in checkTx for sig: ${signature}`);
				let status = this.computeStatus(stateData, sourceChain, destChain);
				let completedAt;
				if (status === `SETTLED_ON_SOLANA`) {
					completedAt = new Date();
				}
				try {
					const swap = {
						payloadId: this.mayanState.parsePayloadId(stateData),
						trader: traderAddr,
						driverAddress: ins.agent,
						sourceTxHash: signature,
						createTxHash: signature,
						sourceTxBlockNo: trx.slot,
						status: status,
						redeemSequence: redeemSequence ? redeemSequence.toString() : null,
						deadline: new Date(Number(this.mayanState.parseStateDeadline(stateData))),
						sourceChain: CHAIN_ID_SOLANA.toString(),
						swapChain: CHAIN_ID_SOLANA.toString(),
						destChain: destChain.toString(),
						destAddress: this.mayanState.parseStateDestAddress(stateData),
						fromTokenAddress: fromToken.contract,
						fromTokenChain: fromToken.wChainId!.toString(),
						fromTokenSymbol: fromToken.symbol,
						fromAmount: ethers.utils.formatUnits(
							ins?.meta?.amountIn,
							fromToken.decimals,
						),
						toTokenAddress: toToken.contract,
						toTokenChain: toToken.wChainId!.toString(),
						toTokenSymbol: toToken.symbol,
						stateAddr: ins.stateAddr,
						stateNonce: ins.stateNonce.toString(),
						toAmount: amountOut ? ethers.utils.formatUnits(
							amountOut,
							toTokenInSolana.decimals,
						): null,
						savedAt: new Date(),
						initiatedAt: txDate,
						bridgeFee: 0,
						swapRelayerFee: ethers.utils.formatUnits(fees.swapFee, fromToken.decimals),
						redeemRelayerFee: ethers.utils.formatUnits(fees.redeemFee, toTokenInSolana.decimals),
						refundRelayerFee: ethers.utils.formatUnits(fees.refundFee, fromToken.decimals),

						auctionAddress: this.mayanState.parseAuctionAddress(stateData),
						unwrapRedeem: this.mayanState.parseUnwrapRedeem(stateData),
						unwrapRefund: this.mayanState.parseUnwrapRefund(stateData),

						posAddress: ins.programId,
						mayanAddress: ins.programId,
						referrerAddress: this.mayanState.parseReferrer(stateData),

						gasDrop: ethers.utils.formatUnits(gasDrop, gasTokenDecimals),
						service: fromToken.mint === toToken.mint ? `WH_BRIDGE` : `WH_SWAP`,

						completedAt: completedAt,
					};
				} catch(err) {
					console.error('error in process solana transaction');
					throw err;
				}
			} else if (ins.goal === 'SETTLE') {
                // TODO: update swap in db
				// await updateSwaps({
				// 	where: { stateAddr: ins.stateAddr?.toString() },
				// 	data: {
				// 		fulfillTxHash: signature,
				// 		refundTxHash: signature,
				// 	},
				// });
			}

		}

	}

	computeStatus(stateData: Buffer, sourceChainId: number, destChainId: number): string {
		const stateStatus = this.mayanState.parseStateStatus(stateData);
		switch(stateStatus) {
			case 'CLAIMED': return `CLAIMED_ON_SOLANA`;
			case 'SWAP_DONE': return `SWAPPED_ON_SOLANA`;
			case 'DONE_SWAPPED': {
				if (destChainId === CHAIN_ID_SOLANA) {
					return `SETTLED_ON_SOLANA`;
				} else {
					return `REDEEM_SEQUENCE_RECEIVED`;
				}
			}
			case 'DONE_NOT_SWAPPED': {
				if (sourceChainId === CHAIN_ID_SOLANA) {
					return 'REFUNDED_ON_SOLANA';
				} else {
					return 'REFUND_SEQUENCE_RECEIVED';
				}
			}

		}
	}
}

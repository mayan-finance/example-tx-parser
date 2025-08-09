import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';

import { findVaaAddress } from './state';

import { getIsTransferCompletedEth, parseVaa } from '@certusone/wormhole-sdk';
import { grpc } from "@improbable-eng/grpc-web";

import {
	getAuctionInfo,
	getCurrentSolanaTime,
	isAlreadySubmittedOnSolana,
} from './state';
import { abi as wormholeAbi } from '../../abis/wormhole';

import { AuctionState } from './auction-state';
import { MayanState } from './state';
import {
	getEmitterAddressEth,
	getEmitterAddressSolana,
	getSignedVAAWithRetry,
    parseTransferPayload,
} from '../../utils/wh';
import { AptosClient } from 'aptos';
import { hexToUint8Array, tryUint8ArrayToNative } from '../../utils/bytes';
import { Swap } from '../../utils/swap.dto';
import { CHAIN_ID_ARBITRUM, CHAIN_ID_AVAX, CHAIN_ID_BASE, CHAIN_ID_BSC, CHAIN_ID_ETH, CHAIN_ID_OPTIMISM, CHAIN_ID_POLYGON, CHAIN_ID_SOLANA, CHAIN_ID_UNICHAIN } from '../../utils/chain-map';
import { WH_SOLANA, WORMHOLE_GUARDIAN_RPCS } from '../../utils/const';
import { NodeHttpTransportWithDefaultTimeout } from './grpc-http-transport';
import { getTokenData, getTokenDataGeneral } from '../../utils/token.util';
import { WhEvmRegistery } from '../../wh';

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export class WhFollowerService {
	private readonly mayanState: MayanState;
	private readonly auctionState: AuctionState;

	constructor(
        private readonly whEvmRegistery: WhEvmRegistery,
		private readonly solanaConnection: Connection,
		private readonly evmProviders: {
			[chainId: number]: ethers.providers.JsonRpcProvider;
		},
	) {
		this.mayanState = new MayanState(this.solanaConnection);
		this.auctionState = new AuctionState();
	}

	async follow(swap: Swap) {
		while (![
            'SETTLED_ON_SOLANA',
            'REDEEMED_ON_EVM',
            'REFUNDED_ON_EVM',
            'REFUNDED_ON_SOLANA',
        ].includes(swap.status)) {
			try {
				console.log(
					`in the while-switch with status: ${swap.status} tx: ${swap.sourceTxHash}`,
				);
				switch (swap.status) {
					case 'INITIATED_ON_EVM':
						await this.registerWormholeVaa(swap);
						break;
					case 'TRANSFER_VAA_SIGNED':
						await this.registerMayanVaa(swap);
						break;
					case 'SWAP_VAA_SIGNED':
						await this.watchSubmitToSolana(swap);
						break;
					case 'SUBMITTED_ON_SOLANA':
						await this.watchClaimOnSolana(swap);
						break;
					case 'CLAIMED_ON_SOLANA':
					case 'SWAPPED_ON_SOLANA': {
						await this.watchSwapOnSolana(swap);
						await this.watchTransferBack(swap);
						break;
					}
					case 'REDEEM_SEQUENCE_RECEIVED':
					case 'REFUND_SEQUENCE_RECEIVED': {
						await this.registerThirdVaa(swap);
						break;
					}
					case 'REDEEM_VAA_SIGNED':
					case 'REFUND_VAA_SIGNED': {
                        await this.watchRedeemOnEvm(swap);
						break;
					}
				}
			} catch (err) {
				console.error(`error in follow while tx: ${swap.sourceTxHash} ${err}`);
			} finally {
                // TODO: refresh swap
				// swap = getSwap({ id: swap.id });
			}
		}
	}

	private async registerWormholeVaa(swap: Swap) {
		console.log(
			`Getting Wormhole signed VAA. Mayan sequence=${swap.swapSequence} tx=${swap.sourceTxHash}`,
		);

		let wormholeSignedVaa = await this.getSignedVaa(
			+swap.sourceChain,
			WhConfig.contracts[swap.sourceChain].tokenBridge,
			swap.transferSequence!,
		);

		console.log(
			`Got Wormhole signed VAA. Mayan sequence=${swap.swapSequence} tx=${swap.sourceTxHash}`,
		);

		// check for re-orgs
		const txReceipt = await this.evmProviders[
			+swap.sourceChain
		].getTransactionReceipt(swap.sourceTxHash);
		const freshSwap: Swap | null = await this.whEvmRegistery.processTxFromChain(
			txReceipt,
			+swap.sourceChain,
		);
		let swapIdx = getWormholeSwapIdxInTx(swap.sourceTxHash);
		const freshSequence = freshSwap!.transferSequence;
		if (freshSequence !== swap.transferSequence) {
			console.log(
				`re-org detected ${swap.transferSequence} vs ${freshSequence}, updating signedvaa`,
			);

			wormholeSignedVaa = await this.getSignedVaa(
				+swap.sourceChain,
				WhConfig.contracts[swap.sourceChain].tokenBridge,
				freshSequence!,
			);
		}

        // TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id, status: INITIATED_ON_EVM },
		// 	data: {
		// 		status: TRANSFER_VAA_SIGNED,
		// 		statusUpdatedAt: new Date(),
		// 		transferSignedVaa:
		// 			Buffer.from(wormholeSignedVaa).toString('hex'),
		// 	},
		// });

		console.log(
			`Wormhole signed VAA received and stored in database. Wormhole sequence=${freshSwap!.transferSequence} tx: ${swap.sourceTxHash}`,
		);
	}

	private async registerMayanVaa(swap: Swap) {
		console.log(
			`Getting Mayan signed VAA. Mayan sequence=${swap.swapSequence} tx=${swap.sourceTxHash}`,
		);

		const mayanSignedVaa = await this.getSignedVaa(
			+swap.sourceChain,
			swap.posAddress!,
			swap.swapSequence!,
		);

        // TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id, status: TRANSFER_VAA_SIGNED },
		// 	data: {
		// 		status: SWAP_VAA_SIGNED,
		// 		statusUpdatedAt: new Date(),
		// 		swapSignedVaa: Buffer.from(mayanSignedVaa).toString('hex'),
		// 	},
		// });

		console.log(
			`Mayan signed VAA received and stored in database. Mayan sequence=${swap.swapSequence} tx: ${swap.sourceTxHash}`,
		);
	}

	private async watchSubmitToSolana(swap: Swap) {
		const vaa1 = hexToUint8Array(swap.transferSignedVaa!);

		const tokenBridge =
			WhConfig.contracts[swap.sourceChain].tokenBridge;

		let submitted = false;
		let currentTry = 1;
		do {
			try {
				submitted = await isAlreadySubmittedOnSolana(
					this.solanaConnection,
					vaa1,
					tokenBridge,
					+swap.sourceChain,
					'confirmed',
				);
			} catch (err) {
				console.warn(
					`failing watchSubmitToSolana.isAlreadySubmittedOnSolana with err: ${err} on try ${currentTry}`,
				);
			} finally {
				currentTry++;
				await delay(1000);
			}
		} while (!submitted && currentTry < 1000);

		if (!submitted) {
			throw new Error(
				`Tired of watchSubmitToSolana after ${currentTry} tries.`,
			);
		}

		const [stateAddr, stateNonce] = await this.findSwapState(
			swap,
			WH_SOLANA,
		);

        // TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id, status: SWAP_VAA_SIGNED },
		// 	data: {
		// 		status: SUBMITTED_ON_SOLANA,
		// 		stateAddr: stateAddr.toString(),
		// 		stateNonce: stateNonce.toString(),
		// 		statusUpdatedAt: new Date(),
		// 	},
		// });

		console.log(
			`watchSubmitToSolana (try #${currentTry}): Submitted. Wormhole Sequence=${swap.transferSequence} tx: ${swap.sourceTxHash}`,
		);
	}

	private async watchClaimOnSolana(swap: Swap) {
		const [stateAddr] = await this.findSwapState(swap);
		let claimed: AccountInfo<Buffer> | null;
		let currentTry = 1;
		do {
			try {
				claimed = await this.solanaConnection.getAccountInfo(
					stateAddr,
					'confirmed',
				);
			} catch (err) {
				console.warn(
					`watchClaimOnSolana tx: ${swap.sourceTxHash} with err: ${err} on try ${currentTry}`,
				);
			} finally {
				currentTry++;
				await delay(1000);
			}
		} while (!claimed! && currentTry < 1000);

		if (!claimed!) {
			throw new Error(
				`Tired of watchClaimOnSolana after ${currentTry} tries.`,
			);
		}

		const amountOutMin = this.mayanState.parseStateAmountOutMin(
			claimed.data,
		);

        // TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id, status: SUBMITTED_ON_SOLANA },
		// 	data: {
		// 		status: CLAIMED_ON_SOLANA,
		// 		minAmountOut64: amountOutMin.toString(),
		// 		minAmountOut: ethers.utils.formatUnits(BigInt(amountOutMin), 8),
		// 		statusUpdatedAt: new Date(),
		// 	},
		// });

		console.log(
			`watchClaimOnSolana (try #${currentTry}): Claimed. Wormhole Sequence=${swap.transferSequence} tx: ${swap.sourceTxHash}`,
		);
	}

	private async watchSwapOnSolana(swap: Swap) {
		const [stateAddr] = await this.findSwapState(swap);

		let solanaTime = await getCurrentSolanaTime(this.solanaConnection);
		let amountOut;
		let currentTry = 1;
		console.log(
			`SWAP DEADLINE ${swap.deadline.getTime()} ${solanaTime} for tx: ${
				swap.sourceTxHash
			}`,
		);
		do {
			try {
				const stateAccount = await this.solanaConnection.getAccountInfo(
					stateAddr,
					'confirmed',
				);
				const stateData = stateAccount!.data;
				amountOut = this.mayanState.parseStateAmountOut(stateData);
				const fees = this.mayanState.parseStateFees(stateData);
				const rates = this.mayanState.parseMayanAndRefRate(stateData);
				if (amountOut) {
					amountOut =
						(amountOut *
							(10000n -
								BigInt(rates.mayanBps + rates.referrerBps))) /
						10000n;
					if (+swap.destChain !== CHAIN_ID_SOLANA) {
						amountOut -= fees.redeemFee;
					}
					break;
				}

				if (
					(await getCurrentSolanaTime(this.solanaConnection)) >
					swap.deadline.getTime() + 32_000
				) {
					return;
				}
			} catch (err) {
				console.warn(
					`watchSwapOnSolana in while tx: ${swap.sourceTxHash} err: ${err} on try ${currentTry}`,
				);
			} finally {
				solanaTime = await getCurrentSolanaTime(this.solanaConnection);
				currentTry++;
				await delay(1000);
			}
		} while (true);

		if (!amountOut) {
			throw new Error(
				`Tired of watchSwapOnSolana after ${currentTry} tries.`,
			);
		}

		const fromToken = await getTokenDataGeneral(
			+swap.fromTokenChain!,
			swap.fromTokenAddress,
		);
		const toToken = await getTokenDataGeneral(
			+swap.toTokenChain!,
			swap.toTokenAddress,
		);
		let winner = null;

		if (fromToken.mint !== toToken.mint) {
			const auctionInfo = await getAuctionInfo(
				this.solanaConnection,
				stateAddr,
				new PublicKey(swap.auctionAddress!),
			);
			if (!auctionInfo) {
				console.error(
					`auction account not found ${swap.auctionAddress} tx: ${swap.sourceTxHash}`,
				);
				throw new Error('auction account not found');
			}

			const winner = this.auctionState.parseWinner(auctionInfo.data);
			if (!winner) {
				console.log(
					`no winner! for stateAddr: ${stateAddr} tx: ${swap.sourceTxHash}`,
				);
				throw new Error(`Winner not found`);
			}
		}

		const solanaToken = await getTokenDataGeneral(
			CHAIN_ID_SOLANA,
			toToken.mint,
		);
		
        // TODO: update swap
        // updateSwap({
		// 	where: { id: swap.id, status: CLAIMED_ON_SOLANA },
		// 	data: {
		// 		status: SWAPPED_ON_SOLANA,
		// 		statusUpdatedAt: new Date(),
		// 		toAmount: ethers.utils.formatUnits(
		// 			BigInt(amountOut),
		// 			solanaToken.decimals,
		// 		),
		// 		driverAddress: winner,
		// 	},
		// });

		console.log(
			`watchSwapOnSolana (try #${currentTry}): Swapped. Wormhole Sequence=${swap.transferSequence} tx: ${swap.sourceTxHash}`,
		);
	}

	private async watchTransferBack(swap: Swap) {
		const [stateAddr] = await this.findSwapState(swap);

		let stateData, stateStatus;
		let currentTry = 1;
		do {
			try {
				const stateAccount = await this.solanaConnection.getAccountInfo(
					stateAddr,
					'confirmed',
				);
				stateData = stateAccount!.data;
				stateStatus = this.mayanState.parseStateStatus(stateData);
			} catch (error) {
				console.warn(
					`Error while transfering back on solana for Wormhole Sequence=${swap.transferSequence} tx: ${swap.sourceTxHash} err: ${error}`,
				);
			} finally {
				currentTry++;
				await delay(1000);
			}
		} while (
			stateStatus !== 'DONE_SWAPPED' &&
			stateStatus !== 'DONE_NOT_SWAPPED' &&
			currentTry < 1000
		);

		if (
			stateStatus !== 'DONE_SWAPPED' &&
			stateStatus !== 'DONE_NOT_SWAPPED'
		) {
			throw new Error(
				`Tired watchTransferBack for seq = ${swap.swapSequence}, after ${currentTry} tries.`,
			);
		}

		const reverted = stateStatus === 'DONE_NOT_SWAPPED';

		const entityUpdate: any = {
			status: null,
			redeemSequence: null,
			refundSequence: null,
			completedAt: null,
			statusUpdatedAt: new Date(),
		};

		let previousStatus: string;
		if (reverted && +swap.sourceChain === CHAIN_ID_SOLANA) {
			previousStatus = 'CLAIMED_ON_SOLANA';
			entityUpdate.status = 'REFUNDED_ON_SOLANA';
			entityUpdate.completedAt = new Date();
		} else if (!reverted && +swap.destChain === CHAIN_ID_SOLANA) {
			previousStatus = 'SWAPPED_ON_SOLANA';
			entityUpdate.status = 'SETTLED_ON_SOLANA';
			entityUpdate.completedAt = new Date();
		} else if (!reverted && +swap.destChain !== CHAIN_ID_SOLANA) {
			previousStatus = 'SWAPPED_ON_SOLANA';
			entityUpdate.status = 'REDEEM_SEQUENCE_RECEIVED';
			entityUpdate.redeemSequence = this.mayanState
				.parseStateRedeemSequences(stateData!)!
				.toString();
		} else {
			previousStatus = 'CLAIMED_ON_SOLANA';
			entityUpdate.status = 'REFUND_SEQUENCE_RECEIVED';
			entityUpdate.refundSequence = this.mayanState
				.parseStateRedeemSequences(stateData!)!
				.toString();
		}

        // TODO: update swap data
		// await this.swapService.updateSwap({
		// 	where: { id: swap.id, status: previousStatus },
		// 	data: entityUpdate,
		// });


		console.log(
			`watchTransferBack (try #${currentTry}) done. Wormhole Sequence=${
				swap.transferSequence || swap.redeemSequence
			} tx: ${swap.sourceTxHash}`,
		);
	}

	private async registerThirdVaa(swap: Swap) {
		console.log(
			`in registerThirdVaa tx: ${swap.sourceTxHash} ${swap.redeemSequence} ${swap.refundSequence} ${WhConfig.contracts[CHAIN_ID_SOLANA].tokenBridge}`,
		);

		const thirdSignedVaa = await this.getSignedVaa(
			CHAIN_ID_SOLANA,
			WhConfig.contracts[CHAIN_ID_SOLANA].tokenBridge,
			swap.redeemSequence || swap.refundSequence!,
		);

		console.log(
			`3rd SignedVAA Received=${
				swap.redeemSequence || swap.refundSequence
			} Mayan sequence=${swap.swapSequence} tx: ${swap.sourceTxHash}`,
		);

		console.log(
			`3rd SignedVAA Parsed. Mayan sequence=${swap.swapSequence} tx: ${swap.sourceTxHash}`,
		);

		const toTokenData = getTokenData(
			+swap.toTokenChain!,
			swap.toTokenAddress,
		);

		console.debug(`registerThirdVaa.toTokenData ${toTokenData}`);

		let previousStatus;
		let status;
		let signedVaaField;
		if (swap.status === 'REDEEM_SEQUENCE_RECEIVED') {
			previousStatus = 'REDEEM_SEQUENCE_RECEIVED';
			status = 'REDEEM_VAA_SIGNED';
			signedVaaField = 'redeemSignedVaa';
		} else if (swap.status === 'REFUND_SEQUENCE_RECEIVED') {
			previousStatus = 'REFUND_SEQUENCE_RECEIVED';
			status = 'REFUND_VAA_SIGNED';
			signedVaaField = 'refundSignedVaa';
		} else {
			return swap;
		}

        // TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id, status: previousStatus },
		// 	data: {
		// 		status: status,
		// 		statusUpdatedAt: new Date(),
		// 		[signedVaaField]: Buffer.from(thirdSignedVaa).toString('hex'),
		// 	},
		// });
	}

	private async watchRedeemOnEvm(swap: Swap): Promise<any> {
		const thirdSignedVaa = hexToUint8Array(
			swap.redeemSignedVaa || swap.refundSignedVaa!,
		);

		const parsedThirdVaa = parseVaa(thirdSignedVaa);

		const thirdVaaPayload = parseTransferPayload(
			Buffer.from(parsedThirdVaa.payload),
		);
		const targetChain = thirdVaaPayload.targetChain;

		console.log(
			`3rd SignedVAA payload Parsed. Mayan sequence=${swap.swapSequence} tx: ${swap.sourceTxHash}`,
		);

		let previousStatus;
		let finalStatus;
		let txHashKey;
		if (swap.status === 'REDEEM_VAA_SIGNED') {
			previousStatus = 'REDEEM_VAA_SIGNED';
			finalStatus = 'REDEEMED_ON_EVM';
			txHashKey = 'redeemTxHash';
		} else if (swap.status === 'REFUND_VAA_SIGNED') {
			previousStatus = 'REFUND_VAA_SIGNED';
			finalStatus = 'REFUNDED_ON_EVM';
			txHashKey = 'refundTxHash';
		} else {
			return swap;
		}

		let redeemed = false;
		let currentTry = 1;
		let txHash;
		do {
			try {
				redeemed = await getIsTransferCompletedEth(
					WhConfig.contracts[targetChain].tokenBridge,
					this.evmProviders[targetChain],
					thirdSignedVaa,
				);

				if (redeemed) {
                    // TODO: extract tx hash by looking up the sequence on the graph or equivalent
					// txHash = await extractRedeemTxHash(
					// 	targetChain,
					// 	Number(swap.redeemSequence || swap.refundSequence),
					// );
					if (!txHash) {
						console.warn(
							`No redeem tx hash found for seq=${swap.swapSequence} tx: ${swap.sourceTxHash} yet`,
						);
						redeemed = false;
						throw new Error('No redeem tx hash found');
					}
					break;
				}
			} catch (err) {
				console.warn(
					`watchRedeemOnEvm error sourceTx = ${swap.sourceTxHash} err: ${err} on try ${currentTry}`,
				);
			} finally {
				currentTry++;
				await delay(10_000);
			}
		} while (currentTry < 1000);

		if (!redeemed) {
			throw new Error(
				`Tired watchTransferBack for sourceTx = ${swap.sourceTxHash}`,
			);
		}
		console.log(
			`Swap redeemed, seq=${swap.swapSequence} tx: ${swap.sourceTxHash}`,
		);

        // TODO: update swap
		// await updateSwap({
		// 	where: { id: swap.id, status: previousStatus },
		// 	data: {
		// 		status: finalStatus,
		// 		statusUpdatedAt: new Date(),
		// 		completedAt: new Date(),
		// 		[txHashKey]: txHash,
		// 		fulfillTxHash: txHash,
		// 	},
		// });
	}

	private async watchRedeemOnAptos(swap: Swap) {
		const thirdSignedVaa = hexToUint8Array(swap.redeemSignedVaa!);

		let redeemed = false;
		let currentTry = 0;
		do {
			try {
				redeemed = false;
				// redeemed = await getIsTransferCompletedAptos(this.aptosClient, this.wormholeConfig.contracts[CHAIN_ID_APTOS].tokenBridge, thirdSignedVaa);
			} catch (err) {
				console.warn(
					`watchRedeemOnAptos error seq = ${swap.swapSequence}, ${err}`,
				);
			} finally {
				currentTry++;
				await delay(1000);
			}
		} while (!redeemed && currentTry < 1000);

		if (!redeemed) {
			throw new Error(
				`Tired watchRedeemOnAptos for sourceTx=${swap.sourceTxHash},`,
			);
		}

        // TODO: update swap
		// await this.swapService.updateSwap({
		// 	where: { id: swap.id, status: REDEEM_VAA_SIGNED },
		// 	data: {
		// 		status: REDEEMED_ON_APTOS,
		// 		statusUpdatedAt: new Date(),
		// 		completedAt: new Date(),
		// 	},
		// });


		console.log(`Swap redeemed on aptos, sourceTx=${swap.sourceTxHash}`);
	}

	private async getSignedVaa(
		chainId: number,
		contractAddress: string,
		sequence: string,
	): Promise<Uint8Array> {
		let mayanBridgeEmitterAddress;
		if (ethers.utils.isAddress(contractAddress)) {
			mayanBridgeEmitterAddress = getEmitterAddressEth(contractAddress);
		} else if (chainId === CHAIN_ID_SOLANA) {
			mayanBridgeEmitterAddress = await getEmitterAddressSolana(
				contractAddress,
			);
		} else {
			throw new Error(
				'Cannot get emitter address for chainId=' + chainId,
			);
		}

		// poll until the guardian(s) witness and sign the vaa
		while (true) {
			try {
				const { vaaBytes: signedVAA } = await getSignedVAAWithRetry(
					WORMHOLE_GUARDIAN_RPCS,
					chainId,
					mayanBridgeEmitterAddress,
					sequence,
					{
						transport: NodeHttpTransportWithDefaultTimeout(
							10_000,
						),
					},
					10_000,
					6,
				);
				return signedVAA;
			} catch (err) {
				console.log(
					`Unable to fetch signed VAA ${err}. Retrying... ${chainId}, ${contractAddress}, ${sequence}`,
				);
				await delay(1000);
			}
		}
	}

	private findProgramId(ethEmitterAddr: string): string {
		return WH_SOLANA;
	}

	private async findSwapState(
		swap: Swap,
		mayanProgramAddr: string = '',
	): Promise<[PublicKey, number]> {
		let stateAddr: PublicKey;
		let stateNonce: number;

		console.log(
			`in findSwapState - tx: ${swap.sourceTxHash} ${swap.stateAddr} ${swap.stateNonce}`,
		);
		if (swap.stateAddr && swap.stateNonce) {
			stateAddr = new PublicKey(swap.stateAddr);
			stateNonce = +swap.stateNonce;
		} else {
			const vaa1 = hexToUint8Array(swap.transferSignedVaa!);
			const vaa2 = hexToUint8Array(swap.swapSignedVaa!);

			const parsedTransferVaa = await parseVaa(vaa1);
			const vaa1Addr = await findVaaAddress(parsedTransferVaa);

			const parsedSwapVaa = await parseVaa(vaa2);
			const vaa2Addr = await findVaaAddress(parsedSwapVaa);

			[stateAddr, stateNonce] = PublicKey.findProgramAddressSync(
				[
					Buffer.from('V2STATE'),
					Buffer.from(vaa1Addr.toBytes()),
					Buffer.from(vaa2Addr.toBytes()),
				],
				new PublicKey(mayanProgramAddr),
			);

			console.log(
				`in find swap (explorer) ${vaa1Addr.toString()} ${vaa2Addr.toString()} ${mayanProgramAddr} ${stateAddr.toString()} tx: ${
					swap.sourceTxHash
				}`,
			);
		}

		console.log(
			`in find swap (explorer) ${stateAddr} ${stateNonce} tx: ${swap.sourceTxHash}`,
		);
		return [stateAddr, stateNonce];
	}
}

export function getWormholeSwapIdxInTx(orderId: string) {
	if (!orderId) {
		return 0;
	}
	return parseInt(orderId.split('__')[1]);
}

export const WhConfig: {
    contracts: {
        [key: number]: {
            tokenBridge: string;
            coreBridge: string;
        };
    };
} = {
    contracts: {
        [CHAIN_ID_SOLANA]: {
            tokenBridge: 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb',
            coreBridge: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
        },
        [CHAIN_ID_ETH]: {
            tokenBridge: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
            coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
        },
        [CHAIN_ID_BSC]: {
            tokenBridge: '0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7',
            coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
        },
        [CHAIN_ID_POLYGON]: {
            tokenBridge: '0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE',
            coreBridge: '0x7A4B5a56256163F07b2C80A7cA55aBE66c4ec4d7',
        },
        [CHAIN_ID_AVAX]: {
            tokenBridge: '0x0e082F06FF657D94310cB8cE8B0D9a04541d8052',
            coreBridge: '0x54a8e5f9c4CbA08F9943965859F6c34eAF03E26c',
        },
        [CHAIN_ID_ARBITRUM]: {
            tokenBridge: '0x0b2402144Bb366A632D14B83F244D2e0e21bD39c',
            coreBridge: '0xa5f208e072434bC67592E4C49C1B991BA79BCA46',
        },
        [CHAIN_ID_OPTIMISM]: {
            tokenBridge: '0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b',
            coreBridge: '0xEe91C335eab126dF5fDB3797EA9d6aD93aeC9722',
        },
        [CHAIN_ID_UNICHAIN]: {
            tokenBridge: '0x3Ff72741fd67D6AD0668d93B41a09248F4700560',
            coreBridge: '0xCa1D5a146B03f6303baF59e5AD5615ae0b9d146D',
        },
        [CHAIN_ID_BASE]: {
            tokenBridge: '0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627',
            coreBridge: '0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6',
        },


        // TODO: fill the rest
    },
}
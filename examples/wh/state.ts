import { Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { CHAIN_ID_SOLANA } from "../../utils/chain-map";
import { tryUint8ArrayToNative } from "../../utils/bytes";

export class MayanState {
	constructor(private readonly connection: Connection) {}

	parseRegisteredWinner(stateData: Buffer): PublicKey {
		return new PublicKey(stateData.slice(331, 331 + 32));
	}

	parseStateStatus(stateData: Buffer): StateStatus {
		switch (stateData[0]) {
			case 1:
				return 'CLAIMED';
			case 2:
				return 'SWAP_DONE';
			case 4:
				return 'DONE_SWAPPED';
			case 5:
				return 'DONE_NOT_SWAPPED';
			default:
				throw new Error('bad status');
		}
	}

	async parseStateTransferSequences(stateData: Buffer): Promise<bigint | null> {
		const msg1 = new PublicKey(stateData.slice(1, 33));
		const { data } = (await this.connection.getAccountInfo(msg1, 'confirmed'))!;
		if (!data) {
			return null
		}
		return data.readBigInt64LE(49);
	}

	async parseStateSwapSequence(stateData: Buffer): Promise<bigint | null> {
		const msg2 = new PublicKey(stateData.slice(33, 65));
		const { data } = (await this.connection.getAccountInfo(msg2, 'confirmed'))!;
		if (!data) {
			return null
		}
		return data.readBigInt64LE(49);
	}

	parseStateRedeemSequences(stateData: Buffer): bigint | null {
		const status = this.parseStateStatus(stateData);
		if (status === 'CLAIMED' || status === 'SWAP_DONE') {
			return null;
		}
		const sourceChain = this.parseSourceChain(stateData);
		const destChain = this.parseDestinationChain(stateData);
		if (
			(status === 'DONE_SWAPPED' && destChain === 1) ||
			(status === 'DONE_NOT_SWAPPED' && sourceChain === 1)
		) { //SEATTLE
			return null;
		}
		return stateData.readBigInt64LE(73) - 1n;
	}

	parseStateDeadline(stateData: Buffer): bigint {
	   return stateData.readBigInt64LE(237) * 1000n;
   }

   parseStateAmountIn(stateData: Buffer): bigint | null {
	   const status = this.parseStateStatus(stateData);
	   if (status === 'DONE_SWAPPED' || status === 'SWAP_DONE') {
	      return null;
      }
      return stateData.readBigInt64LE(65);
   }

   parseStateAmountOut(stateData: Buffer): bigint | null {
      const status = this.parseStateStatus(stateData);
      if (status === 'DONE_SWAPPED' || status === 'SWAP_DONE') {
         return stateData.readBigInt64LE(65);
      }
      return null;
   }

	parseMayanAndRefRate(stateData: Buffer) {
		return {
			mayanBps: stateData.readUInt8(329),
			referrerBps: stateData.readUInt8(330),
		}
	}

   parseStateAmountOutMin(stateData: Buffer): bigint {
      return stateData.readBigInt64LE(245);
   }

   parseStateFees(stateData: Buffer): { swapFee: bigint, redeemFee: bigint, refundFee: bigint } {
      return {
         redeemFee: stateData.readBigInt64LE(229),
         swapFee: stateData.readBigInt64LE(213),
         refundFee: stateData.readBigInt64LE(221),
      }
   }
 
   parseStateSourceAddress(stateData: Buffer): string {
      const sourceChain = this.parseSourceChain(stateData);
      const sourceAddress = new PublicKey(stateData.slice(179, 179 + 32)).toBytes();
      return tryUint8ArrayToNative(sourceAddress, sourceChain);
   }

   parseStateDestAddress(stateData: Buffer): string {
      const destinationChain = this.parseDestinationChain(stateData);
      const destAddress = new PublicKey(stateData.slice(145, 145 + 32)).toBytes();
      const rawAddr =  tryUint8ArrayToNative(destAddress, destinationChain);
	  let addr = rawAddr;
	  if (destinationChain !== CHAIN_ID_SOLANA) {
		addr = ethers.utils.getAddress(rawAddr);
	  }
	  return addr;
   }

   async parseStateFromToken(stateData: Buffer): Promise<Token> {
	   const sourceChain = this.parseSourceChain(stateData);
	   const mintFrom = new PublicKey(stateData.slice(81, 81 + 32)).toString();
       // TODO: find token based on mint
	   let token = this.findTokenByMint(mintFrom, sourceChain);
	   if (!token && sourceChain === CHAIN_ID_SOLANA) {
		token = await getTokenDataGeneral(sourceChain, mintFrom);
	   }
	   return token;
   }

   async parseStateToToken(stateData: Buffer): Promise<Token> {
      const destinationChain = this.parseDestinationChain(stateData);
      const mintTo = new PublicKey(stateData.slice(113, 113 + 32)).toString();
      let token = this.findTokenByMint(mintTo, destinationChain);
	  if (!token && destinationChain === CHAIN_ID_SOLANA) {
		token = await getTokenDataGeneral(destinationChain, mintTo);
	  }
	  return token;
   }

	parseSourceChain(stateData: Buffer): number {
		return stateData.readUInt16LE(211);
	}

	parseDestinationChain(stateData: Buffer): number {
		return stateData.readUInt16LE(177);
	}

	parseAuctionAddress(stateData: Buffer): string {
		return tryUint8ArrayToNative(stateData.slice(254, 254 + 32), CHAIN_ID_SOLANA);
	}

	parseUnwrapRedeem(stateData: Buffer): boolean {
		return stateData.readUInt8(286) !== 0;
	}

	parseUnwrapRefund(stateData: Buffer): boolean {
		return stateData.readUInt8(287) !== 0;
	}

	parseReferrer(stateData: Buffer): string {
		const referrerAddress = new PublicKey(stateData.slice(288, 288 + 32)).toBytes();
		return tryUint8ArrayToNative(referrerAddress, CHAIN_ID_SOLANA);
	}

	parseGasDrop(stateData: Buffer): bigint {
		return stateData.readBigInt64LE(320);
	}

	parsePayloadId(stateDate: Buffer): number {
		return stateDate.readUInt8(328);
	}

	findTokenByMint(mint: string, chainId: number): Token {
		if (!tokens[chainId]) {
			console.log('chaaaaaainId', chainId, mint);
		}
		
		return tokens[chainId].find(t => t.mint === mint)!;
	}

	findTokenInSolana(token: Token): Token {
		if (token.wChainId === CHAIN_ID_SOLANA) {
			return token;
		}
		return tokens[CHAIN_ID_SOLANA].find(t => t.mint === token.mint)!;
	}
}


export type StateStatus = 'CLAIMED' | 'SWAP_DONE' | 'DONE_SWAPPED' | 'DONE_NOT_SWAPPED';


import { AccountInfo, Commitment, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import {
	ChainId,
	getForeignAssetSolana,
	keccak256,
	ParsedVaa,
	parseVaa,
} from '@certusone/wormhole-sdk';
import { getMint } from '@solana/spl-token';
import { parseSwapPayload, parseTransferPayload } from '../../utils/wh';
import axios from 'axios';
import { hexToUint8Array, tryNativeToHexString } from '../../utils/bytes';
import { getTokenDataGeneral } from "../../utils/token.util";
import tokens, { Token } from "../../utils/tokens";

export function wait(time: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve();
		}, time);
	});
}

export function serializePayload(parsedVaa: any) {
	const x = Buffer.alloc(51 + parsedVaa.payload.length);
	x.writeUint32BE(parsedVaa.timestamp);
	x.writeUint32BE(parsedVaa.nonce, 4);
	x.writeUint16BE(parsedVaa.emitterChain, 8);
	const e = Buffer.from(parsedVaa.emitterAddress);
	e.copy(x, 10);
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	x.writeBigInt64BE(BigInt(parsedVaa.sequence), 42);
	x.writeUInt8(parsedVaa.consistencyLevel, 50);
	const v = Buffer.from(parsedVaa.payload);
	v.copy(x, 51);
	return x;
}

export async function getTokenMintAuthorityKey(
	tokenAddress: Buffer,
	tokenChain: ChainId,
	connection: Connection,
): Promise<PublicKey> {
	const foreignAssetOnSolana = (await getForeignAssetSolana(
		connection,
		'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb',
		tokenChain,
		Uint8Array.from(tokenAddress),
	))!;
	const info = await getMint(connection, new PublicKey(foreignAssetOnSolana));
	return info.mintAuthority!;
}

export function get_wormhole_core_accounts( 
	emitterAddr: PublicKey,
): {
	coreBridge: PublicKey;
	bridge_config: PublicKey;
	fee_collector: PublicKey;
	sequence_key: PublicKey;
} {
	const coreBridge = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth');
	const [bridge_config] = PublicKey.findProgramAddressSync([Buffer.from('Bridge')], coreBridge);
	const [fee_collector] = PublicKey.findProgramAddressSync(
		[Buffer.from('fee_collector')],
		coreBridge,
	);
	const [sequence_key] = PublicKey.findProgramAddressSync(
		[Buffer.from('Sequence'), Buffer.from(emitterAddr.toBytes())],
		coreBridge,
	);
	return {
		coreBridge,
		bridge_config,
		fee_collector,
		sequence_key,
	};
}

export async function get_wormhole_accounts(mintKey: PublicKey): Promise<{
	config_key: PublicKey;
	custody_acc: PublicKey;
	auth_signer: PublicKey;
	custody_signer: PublicKey;
	emitter_acc: PublicKey;
	bridge_config: PublicKey;
	fee_collector: PublicKey;
	sequence_key: PublicKey;
}> {
	const coreBridge = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth');
	const tokenBridge = new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb');
	const [config_key] = PublicKey.findProgramAddressSync([Buffer.from('config')], tokenBridge);
	const [custody_acc] = PublicKey.findProgramAddressSync(
		[Buffer.from(mintKey.toBytes())],
		tokenBridge,
	);
	const [auth_signer] = PublicKey.findProgramAddressSync(
		[Buffer.from('authority_signer')],
		tokenBridge,
	);
	const [custody_signer] = PublicKey.findProgramAddressSync(
		[Buffer.from('custody_signer')],
		tokenBridge,
	);
	const [emitter_acc] = PublicKey.findProgramAddressSync([Buffer.from('emitter')], tokenBridge);
	const [bridge_config] = PublicKey.findProgramAddressSync([Buffer.from('Bridge')], coreBridge);
	const [fee_collector] = PublicKey.findProgramAddressSync(
		[Buffer.from('fee_collector')],
		coreBridge,
	);
	const [sequence_key] = PublicKey.findProgramAddressSync(
		[Buffer.from('Sequence'), Buffer.from(emitter_acc.toBytes())],
		coreBridge,
	);
	return {
		config_key,
		custody_acc,
		auth_signer,
		custody_signer,
		emitter_acc,
		bridge_config,
		fee_collector,
		sequence_key,
	};
}

export type TokenKeys = {
	isWrapped: boolean,
	mintKey: PublicKey;
	nonceMintKey: number;
	metaKey?: PublicKey;
	nonceMetaKey?: number;
}

export type TransferMetaAccounts = {
	transferVaaAddr: PublicKey;
	swapVaaAddr: PublicKey;
	fromTokenKeys: TokenKeys;
	toTokenKeys: TokenKeys;
};

export async function findVaaAddress(
	vaa: ParsedVaa | Uint8Array,
): Promise<PublicKey> {
	let parsedVaa: ParsedVaa;
	if (vaa instanceof Uint8Array) {
		parsedVaa = await parseVaa(vaa);
	} else {
		parsedVaa = vaa;
	}
	const serializedVaa = serializePayload(parsedVaa);
	const vaaHash = keccak256(serializedVaa);
	const [vaaAddr] = PublicKey.findProgramAddressSync(
		[Buffer.from('PostedVAA'), vaaHash],
		new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'),
	);

	return vaaAddr;
}


export async function getTransferInstructionMetaAccounts(
	parsedVaa1: ParsedVaa,
	parsedVaa2: ParsedVaa,
): Promise<TransferMetaAccounts> {
	const transferVaaAddr = await findVaaAddress(parsedVaa1);
	const swapVaaAddr = await findVaaAddress(parsedVaa2);

	const parsed_payload_1 = parseTransferPayload(Buffer.from(parsedVaa1.payload));
	const fromTokenChain = Buffer.alloc(2);
	fromTokenChain.writeUint16BE(parsed_payload_1.tokenChain);
	const fromTokenAddress = Buffer.from(parsed_payload_1.tokenAddress);

	const parsed_payload_2 = parseSwapPayload(Buffer.from(parsedVaa2.payload));
	const toTokenChain = Buffer.alloc(2);
	toTokenChain.writeUint16BE(parsed_payload_2.tokenChain);
	const toTokenAddress = Buffer.from(parsed_payload_2.tokenAddress);

	return {
		transferVaaAddr,
		swapVaaAddr,
		fromTokenKeys: await getTokenKeys(fromTokenChain, fromTokenAddress),
		toTokenKeys: await getTokenKeys(toTokenChain, toTokenAddress),
	};
}

async function getTokenKeys(tokenChain: Buffer, tokenAddress: Buffer) {
	const isTransferWrapped = tokenChain.readUInt16BE() as ChainId !== CHAIN_ID_SOLANA;

	let mintKey: PublicKey;
	let nonceMintKey: number;
	if (isTransferWrapped) {
		[mintKey, nonceMintKey] = PublicKey.findProgramAddressSync(
			[Buffer.from('wrapped'), tokenChain, tokenAddress],
			new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb'),
		);
	} else {
		mintKey = new PublicKey(Uint8Array.from(tokenAddress));
		nonceMintKey = 0;
	}
	let metaKey: PublicKey;
	let nonceMetaKey: number;
	if (isTransferWrapped) {
		[metaKey, nonceMetaKey] = PublicKey.findProgramAddressSync(
			[Buffer.from('meta'), Buffer.from(mintKey.toBytes())],
			new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb'),
		);
	}
	return { isWrapped: isTransferWrapped, mintKey, nonceMintKey, metaKey: metaKey!, nonceMetaKey: nonceMetaKey! };
}

export function createNonce() {
	const nonceConst = Math.random() * 100000;
	const nonceBuffer = Buffer.alloc(4);
	nonceBuffer.writeUInt32LE(nonceConst, 0);
	return nonceBuffer;
}

export async function getWormholeClaimAccount(
	vaa1: Uint8Array,
	ethTokenBridgeAddress: string,
	ethChainId: number,
): Promise<PublicKey> {
	const emitter = hexToUint8Array(tryNativeToHexString(ethTokenBridgeAddress, ethChainId));
	const parsed_vaa = await parseVaa(vaa1);
	const sequence = parsed_vaa.sequence;
	const chain = Buffer.alloc(2);
	chain.writeUint16BE(ethChainId);
	const seq = Buffer.alloc(8);
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	seq.writeBigInt64BE(BigInt(sequence));
	const [claim] = PublicKey.findProgramAddressSync(
		[Buffer.from(emitter), chain, seq],
		new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb'),
	);
	return claim;
}

export async function getMintKey(originAddress: Buffer, originChain: ChainId) {
	const tokenChain = Buffer.alloc(2);
	tokenChain.writeUint16BE(originChain);
	const tokenAddress = Buffer.from(originAddress);

	const isCompleteWrapped = originChain !== CHAIN_ID_SOLANA;

	let mintKey: PublicKey;
	if (isCompleteWrapped) {
		[mintKey] = PublicKey.findProgramAddressSync(
			[Buffer.from('wrapped'), tokenChain, tokenAddress],
			new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb')
		);
	} else {
		mintKey = new PublicKey(Uint8Array.from(originAddress));
	}
	return mintKey;
}

export async function isAlreadySubmittedOnSolana(
	connection: Connection,
	vaa1: Uint8Array,
	ethTokenBridgeAddress: string,
	ethChainId: number,
	commitment: Commitment = 'confirmed',
): Promise<boolean> {
	const claim_acc = await getWormholeClaimAccount(vaa1, ethTokenBridgeAddress, ethChainId);
	const info = await connection.getAccountInfo(claim_acc, commitment);
	return !!info;
}

export async function getCurrentSolanaTime(connection: Connection, retry: number = 15): Promise<number> {

	try {
		const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
		if (!info) {
			console.log('could not get solana time', SYSVAR_CLOCK_PUBKEY);
		}
		const x = info!.data.slice(32, 40).reverse();
		const y = Buffer.from(x).toString('hex');
		return Number(`0x${y}`) * 1000;
	} catch (err) {
		if (retry > 0) {
			const result = await getCurrentSolanaTime(connection, retry - 1);
			return result;
		}
		throw err;
	}
}

export async function getWormholeBridgeFee(
	connection: Connection,
	coreBridgePubKey: PublicKey,
): Promise<bigint> {
	const [bridgeConf] = PublicKey.findProgramAddressSync([
		Buffer.from('Bridge'),
	], coreBridgePubKey);
	const bd = await connection.getAccountInfo(bridgeConf);
	return bd!.data.readBigUInt64LE(16);
}

export async function getAuctionInfo(connection: Connection, swapState: PublicKey, auctionProgramId: PublicKey): Promise<AccountInfo<Buffer>> {
	const [auctionAcc] = PublicKey.findProgramAddressSync(
		[
			Buffer.from('AUCTION'),
			Buffer.from(swapState.toBytes()),
		],
		auctionProgramId,
	);
	return (await connection.getAccountInfo(auctionAcc, 'processed'))!;
}

export async function getBidInfo(connection: Connection, auctionState: PublicKey, driverPubKey: PublicKey, auctionProgramId: PublicKey): Promise<AccountInfo<Buffer>> {
	const [auctionAcc] = PublicKey.findProgramAddressSync(
		[
			Buffer.from('BID'),
			Buffer.from(auctionState.toBytes()),
			Buffer.from(driverPubKey.toBytes()),
		],
		auctionProgramId,
	);
	return (await connection.getAccountInfo(auctionAcc, 'processed'))!;
}

const MAX_U64 = BigInt(2) ** BigInt(64) - BigInt(1);
export function getSafeU64Blob(value: bigint): Buffer {
    if (value < BigInt(0) || value > MAX_U64) {
        throw new Error(`Invalid u64: ${value}`);
    }
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
}

export type SwapStep = {
	fromToken: string;
	fromSymbol: string;
	toToken: string;
	toSymbol: string;
	protocol: string;
	address: string;
}
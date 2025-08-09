import { Connection, ParsedTransactionWithMeta, PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';

import { base58_to_binary } from 'base58-js';
import { getTokenDataGeneral } from './token.util';
import { CHAIN_ID_SOLANA } from './chain-map';
import { ethers } from 'ethers';

const JUP_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const routeDiscriminator = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]).toString('hex');
const sharedAccRouteDiscriminator = Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]).toString('hex');


export class JupiterIxParser {

	async extractJupSwapFromTrxOrBundle(sigHash: string, trx: ParsedTransactionWithMeta): Promise<JupiterSwapAttrs> {
		let result = await this.extractJupSwapFromTrx(sigHash, trx);

		if (result?.forwardedTokenAddress && !result.forwardedFromSymbol) {
			const forwardedToken = await getTokenDataGeneral(CHAIN_ID_SOLANA, result.forwardedTokenAddress);
			result.forwardedFromSymbol = forwardedToken.symbol;
		}

		return result;
	}

	async extractJupSwapFromTrx(sigHash: string, trx: ParsedTransactionWithMeta): Promise<JupiterSwapAttrs> {
		let forwardedTokenAddress: string | null = null;
		let forwardedFromAmount: string | null = null;
		let forwardedFromSymbol: string | null = null;

		const parsedJupAmount = await this.extractJupSwapOriginalInput(trx, sigHash);
		if (parsedJupAmount) {
			forwardedTokenAddress = parsedJupAmount.inMint;
			let token = await getTokenDataGeneral(
				CHAIN_ID_SOLANA,
				forwardedTokenAddress,
			);
			if (!token) {
				forwardedTokenAddress = null;
			} else {
				forwardedFromAmount = ethers.utils.formatUnits(
					parsedJupAmount.inAmount,
					token.decimals,
				);
			}
		}

		return {
			forwardedTokenAddress: forwardedTokenAddress!,
			forwardedFromAmount: forwardedFromAmount!,
			forwardedFromSymbol: forwardedFromSymbol!,
		}
	}

	async extractJupSwapOriginalInput(trx: ParsedTransactionWithMeta, signature: string): Promise<{
		inAmount: bigint,
		inMint: string,
	}> {
		try {
			const result = await parseJupCpiEvents(JUP_IDL, trx);
			const swapAttrs = result.events;

			if (!swapAttrs[0].args.input_mint) {
				return {
					inAmount: 0n,
					inMint: '',
				};
			}

			return {
				inAmount: result.amountIn,
				inMint: swapAttrs[0].args.input_mint.toString(),
			};
		} catch (err: any) {
			console.error(`WHEN PARSING JUPITER SWAP ON SOURCE GOT ERROR ${err} ${signature} ${err.stack}`);
			return {
				inAmount: 0n,
				inMint: '',
			};
		}
	}
}

/**
 * Simplified IDL interfaces
 */
export interface Idl {
	address: string;
	metadata: {
		name: string;
		version: string;
		spec: string;
		description?: string;
	};
	instructions: IdlInstruction[];
	accounts?: { name: string; discriminator: number[] }[];
	events?: { name: string; discriminator: number[] }[];
	// errors?: IdlError[];
	types?: IdlTypeDef[];
}

/** Instruction definition */
export interface IdlInstruction {
	name: string;
	discriminator: number[];
	docs?: string[];
	accounts: IdlAccount[];
	args?: IdlField[];
	/** e.g. 'u64' */
	returns?: PrimitiveType;
}

/** Program account (for CPI, PDAs, etc.) */
export interface IdlAccount {
	name: string;
	/** writable? signer? optional? */
	writable?: boolean;
	signer?: boolean;
	optional?: boolean;
	/** literal address (if set) */
	address?: string;
	/** PDA generation info */
	pda?: {
		seeds: Seed[];
		program: { kind: 'const'; value: number[] };
	};
}

/** A PDA seed (either a constant byte array, or another account’s field) */
export type Seed = { kind: 'const'; value: number[] } | { kind: 'account'; path: string };

/** Primitive and composite field types */
export type PrimitiveType = 'u8' | 'u16' | 'u32' | 'u64' | 'bool' | 'pubkey';
export type IdlFieldType =
	| PrimitiveType
	| { array: [IdlFieldType, number] }
	| { vec: IdlFieldType }
	| { option: IdlFieldType }
	| { defined: { name: string } };

/** Argument definition */
export interface IdlField {
	name: string;
	type: IdlFieldType;
}

/** Custom types: structs and enums */
export interface IdlTypeDef {
	name: string;
	type:
		| {
				kind: 'struct';
				fields: IdlField[];
		  }
		| {
				kind: 'enum';
				variants: Array<{
					name: string;
					/** optional payload fields */
					fields?: IdlField[];
				}>;
		  };
}

export interface IdlTypeDef {
	name: string;
	type:
		| { kind: 'struct'; fields: IdlField[] }
		| { kind: 'enum'; variants: { name: string; fields?: IdlField[] }[] };
}

export interface IdlField {
	name: string;
	type: IdlFieldType;
}

/**
 * Parses Anchor CPI events emitted by your program in a transaction.
 * Uses getParsedTransaction to access parsed account keys and inner instructions.
 */
export async function parseJupCpiEvents(
	idl: Idl,
	parsedTx: ParsedTransactionWithMeta,
): Promise<{
	events: Array<{
		name: string;
		args: Record<'amm' | 'input_mint' | 'input_amount' | 'output_mint' | 'output_amount', any>; // mints are publickey not string
	}>,
	amountIn: bigint,
}

> {
	if (!parsedTx?.meta || !parsedTx.transaction.message) {
		throw new Error(`Transaction ${parsedTx} not found or missing metadata`);
	}

	const results: Array<{ name: string; args: Record<string, any> }> = [];

	// Recursive decoder for primitive and composite types
	function decodeType(type: IdlFieldType, buf: Buffer, offset: number): [any, number] {
		if (typeof type === 'string') {
			switch (type) {
				case 'u8':
					return [buf.readUInt8(offset), offset + 1];
				case 'u16':
					return [buf.readUInt16LE(offset), offset + 2];
				case 'u32':
					return [buf.readUInt32LE(offset), offset + 4];
				case 'u64': {
					const v = buf.readBigUInt64LE(offset);
					return [v, offset + 8];
				}
				case 'bool':
					return [buf.readUInt8(offset) !== 0, offset + 1];
				case 'pubkey': {
					const slice = buf.subarray(offset, offset + 32);
					return [new PublicKey(slice), offset + 32];
				}
			}
		}
		if ('array' in type) {
			const [inner, len] = type.array;
			const arr: any[] = [];
			let cur = offset;
			for (let i = 0; i < len; i++) {
				const [v, next] = decodeType(inner, buf, cur);
				arr.push(v);
				cur = next;
			}
			return [arr, cur];
		}
		if ('vec' in type) {
			const len = buf.readUInt32LE(offset);
			let cur = offset + 4;
			const arr: any[] = [];
			for (let i = 0; i < len; i++) {
				const [v, next] = decodeType(type.vec, buf, cur);
				arr.push(v);
				cur = next;
			}
			return [arr, cur];
		}
		if ('option' in type) {
			const flag = buf.readUInt8(offset);
			if (flag === 0) return [null, offset + 1];
			return decodeType(type.option, buf, offset + 1);
		}
		if ('defined' in type) {
			const def = idl.types?.find((t) => t.name === type.defined.name);
			if (!def || def.type.kind !== 'struct') {
				throw new Error(`Type ${type.defined} not found or not a struct`);
			}
			const obj: Record<string, any> = {};
			let cur = offset;
			for (const f of def.type.fields) {
				const [v, next] = decodeType(f.type, buf, cur);
				obj[f.name] = v;
				cur = next;
			}
			return [obj, cur];
		}
		throw new Error(`Unsupported type: ${JSON.stringify(type)}`);
	}

	// 2) Iterate over innerInstructions for your program
	for (const inner of parsedTx.meta.innerInstructions ?? []) {
		for (const ix of inner.instructions) {
			// Only handle PartiallyDecodedInstruction

			if (!('programId' in ix && 'data' in ix)) {
				continue;
			}
			const { programId, data } = ix;

			if (!programId.equals(new PublicKey(idl.address))) {
				continue;
			}

			// Decode base58 data
			const buf = Buffer.from(bs58.decode(data));
			// Match discriminator
			const cpiEventDiscriminator = buf.subarray(0, 8).toString('hex');
			if (cpiEventDiscriminator !== 'e445a52e51cb9a1d') {
				console.log(`Skipping instruction with unknown discriminator ${cpiEventDiscriminator}`);
				continue;
			}
			const disc = buf.subarray(8, 16).toString('hex');
			const evDef = idl.events?.find(
				(e) => Buffer.from(e.discriminator).toString('hex') === disc,
			);
			if (!evDef) {
				console.log(`Skipping instruction with unknown discriminator ${disc}`);
				continue;
			}

			// Find struct type definition
			const typeDef = idl.types?.find((t) => t.name === evDef.name);
			if (!typeDef || typeDef.type.kind !== 'struct') {
				throw new Error(`Struct for event ${evDef.name} not found`);
			}

			// Decode fields
			let cur = 16;
			const args: Record<string, any> = {};
			for (const field of typeDef.type.fields) {
				const [v, next] = decodeType(field.type, buf, cur);
				args[field.name] = v;
				cur = next;
			}

			results.push({ name: evDef.name, args });
		}
	}

	let amountIn = 0n;
	let allIxs = parsedTx.transaction.message.instructions;
	for (let innerIx of parsedTx.meta.innerInstructions || []) {
		allIxs.push(...innerIx.instructions);
	}
	for (let ix of allIxs) {
		if (ix.programId?.toString() === JUP_V6_PROGRAM_ID) {
			ix = ix as PartiallyDecodedInstruction;
			let swapType: 'ROUTE' | 'SHARED_ACC_ROUTE';
			const decodedData = base58_to_binary(ix.data);
			const decodedDataBuffer = Buffer.from(decodedData);
			const discriminator = decodedDataBuffer.subarray(0, 8);
	
			if (discriminator.toString('hex') === routeDiscriminator) {
				amountIn = decodedDataBuffer.readBigUInt64LE(decodedDataBuffer.length - 19);
			} else if (discriminator.toString('hex') === sharedAccRouteDiscriminator) {
				amountIn = decodedDataBuffer.readBigUInt64LE(decodedDataBuffer.length - 19);
			} else {
				continue;
			}
		}
	}

	return {
		events: results,
		amountIn,
	};
}

export const JUP_IDL: Idl = {
	address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
	metadata: {
		name: 'jupiter',
		version: '0.1.0',
		spec: '0.1.0',
		description: 'Jupiter aggregator program',
	},
	instructions: [
		{
			name: 'claim',
			discriminator: [62, 198, 214, 193, 213, 159, 108, 210],
			accounts: [
				{
					name: 'wallet',
					writable: true,
					address: 'J434EKW6KDmnJHxVty1axHT6kjszKKFEyesKqxdQ7y64',
				},
				{
					name: 'program_authority',
					writable: true,
				},
				{
					name: 'system_program',
					address: '11111111111111111111111111111111',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'claim_token',
			discriminator: [116, 206, 27, 191, 166, 19, 0, 73],
			accounts: [
				{
					name: 'payer',
					writable: true,
					signer: true,
				},
				{
					name: 'wallet',
					address: 'J434EKW6KDmnJHxVty1axHT6kjszKKFEyesKqxdQ7y64',
				},
				{
					name: 'program_authority',
				},
				{
					name: 'program_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
					pda: {
						seeds: [
							{
								kind: 'account',
								path: 'wallet',
							},
							{
								kind: 'account',
								path: 'token_program',
							},
							{
								kind: 'account',
								path: 'mint',
							},
						],
						program: {
							kind: 'const',
							value: [
								140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11,
								90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
							],
						},
					},
				},
				{
					name: 'mint',
				},
				{
					name: 'token_program',
				},
				{
					name: 'associated_token_program',
					address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
				},
				{
					name: 'system_program',
					address: '11111111111111111111111111111111',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'close_token',
			discriminator: [26, 74, 236, 151, 104, 64, 183, 249],
			accounts: [
				{
					name: 'operator',
					signer: true,
				},
				{
					name: 'wallet',
					writable: true,
					address: 'J434EKW6KDmnJHxVty1axHT6kjszKKFEyesKqxdQ7y64',
				},
				{
					name: 'program_authority',
				},
				{
					name: 'program_token_account',
					writable: true,
				},
				{
					name: 'mint',
					writable: true,
				},
				{
					name: 'token_program',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
				{
					name: 'burn_all',
					type: 'bool',
				},
			],
		},
		{
			name: 'create_open_orders',
			discriminator: [229, 194, 212, 172, 8, 10, 134, 147],
			accounts: [
				{
					name: 'open_orders',
					writable: true,
				},
				{
					name: 'payer',
					writable: true,
					signer: true,
				},
				{
					name: 'dex_program',
				},
				{
					name: 'system_program',
					address: '11111111111111111111111111111111',
				},
				{
					name: 'rent',
					address: 'SysvarRent111111111111111111111111111111111',
				},
				{
					name: 'market',
				},
			],
			args: [],
		},
		{
			name: 'create_program_open_orders',
			discriminator: [28, 226, 32, 148, 188, 136, 113, 171],
			accounts: [
				{
					name: 'open_orders',
					writable: true,
				},
				{
					name: 'payer',
					writable: true,
					signer: true,
				},
				{
					name: 'program_authority',
				},
				{
					name: 'dex_program',
				},
				{
					name: 'system_program',
					address: '11111111111111111111111111111111',
				},
				{
					name: 'rent',
					address: 'SysvarRent111111111111111111111111111111111',
				},
				{
					name: 'market',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
			],
		},
		{
			name: 'create_token_ledger',
			discriminator: [232, 242, 197, 253, 240, 143, 129, 52],
			accounts: [
				{
					name: 'token_ledger',
					writable: true,
					signer: true,
				},
				{
					name: 'payer',
					writable: true,
					signer: true,
				},
				{
					name: 'system_program',
					address: '11111111111111111111111111111111',
				},
			],
			args: [],
		},
		{
			name: 'create_token_account',
			discriminator: [147, 241, 123, 100, 244, 132, 174, 118],
			accounts: [
				{
					name: 'token_account',
					writable: true,
				},
				{
					name: 'user',
					writable: true,
					signer: true,
				},
				{
					name: 'mint',
				},
				{
					name: 'token_program',
				},
				{
					name: 'system_program',
					address: '11111111111111111111111111111111',
				},
			],
			args: [
				{
					name: 'bump',
					type: 'u8',
				},
			],
		},
		{
			name: 'exact_out_route',
			discriminator: [208, 51, 239, 151, 123, 43, 237, 92],
			accounts: [
				{
					name: 'token_program',
				},
				{
					name: 'user_transfer_authority',
					signer: true,
				},
				{
					name: 'user_source_token_account',
					writable: true,
				},
				{
					name: 'user_destination_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
					optional: true,
				},
				{
					name: 'source_mint',
				},
				{
					name: 'destination_mint',
				},
				{
					name: 'platform_fee_account',
					writable: true,
					optional: true,
				},
				{
					name: 'token_2022_program',
					optional: true,
				},
				{
					name: 'event_authority',
					address: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
				},
				{
					name: 'program',
				},
			],
			args: [
				{
					name: 'route_plan',
					type: {
						vec: {
							defined: {
								name: 'RoutePlanStep',
							},
						},
					},
				},
				{
					name: 'out_amount',
					type: 'u64',
				},
				{
					name: 'quoted_in_amount',
					type: 'u64',
				},
				{
					name: 'slippage_bps',
					type: 'u16',
				},
				{
					name: 'platform_fee_bps',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'route',
			docs: ['route_plan Topologically sorted trade DAG'],
			discriminator: [229, 23, 203, 151, 122, 227, 173, 42],
			accounts: [
				{
					name: 'token_program',
				},
				{
					name: 'user_transfer_authority',
					signer: true,
				},
				{
					name: 'user_source_token_account',
					writable: true,
				},
				{
					name: 'user_destination_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
					optional: true,
				},
				{
					name: 'destination_mint',
				},
				{
					name: 'platform_fee_account',
					writable: true,
					optional: true,
				},
				{
					name: 'event_authority',
					address: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
				},
				{
					name: 'program',
				},
			],
			args: [
				{
					name: 'route_plan',
					type: {
						vec: {
							defined: {
								name: 'RoutePlanStep',
							},
						},
					},
				},
				{
					name: 'in_amount',
					type: 'u64',
				},
				{
					name: 'quoted_out_amount',
					type: 'u64',
				},
				{
					name: 'slippage_bps',
					type: 'u16',
				},
				{
					name: 'platform_fee_bps',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'route_with_token_ledger',
			discriminator: [150, 86, 71, 116, 167, 93, 14, 104],
			accounts: [
				{
					name: 'token_program',
				},
				{
					name: 'user_transfer_authority',
					signer: true,
				},
				{
					name: 'user_source_token_account',
					writable: true,
				},
				{
					name: 'user_destination_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
					optional: true,
				},
				{
					name: 'destination_mint',
				},
				{
					name: 'platform_fee_account',
					writable: true,
					optional: true,
				},
				{
					name: 'token_ledger',
				},
				{
					name: 'event_authority',
					address: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
				},
				{
					name: 'program',
				},
			],
			args: [
				{
					name: 'route_plan',
					type: {
						vec: {
							defined: {
								name: 'RoutePlanStep',
							},
						},
					},
				},
				{
					name: 'quoted_out_amount',
					type: 'u64',
				},
				{
					name: 'slippage_bps',
					type: 'u16',
				},
				{
					name: 'platform_fee_bps',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'set_token_ledger',
			discriminator: [228, 85, 185, 112, 78, 79, 77, 2],
			accounts: [
				{
					name: 'token_ledger',
					writable: true,
				},
				{
					name: 'token_account',
				},
			],
			args: [],
		},
		{
			name: 'shared_accounts_exact_out_route',
			docs: ['Route by using program owned token accounts and open orders accounts.'],
			discriminator: [176, 209, 105, 168, 154, 125, 69, 62],
			accounts: [
				{
					name: 'token_program',
				},
				{
					name: 'program_authority',
				},
				{
					name: 'user_transfer_authority',
					signer: true,
				},
				{
					name: 'source_token_account',
					writable: true,
				},
				{
					name: 'program_source_token_account',
					writable: true,
				},
				{
					name: 'program_destination_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
				},
				{
					name: 'source_mint',
				},
				{
					name: 'destination_mint',
				},
				{
					name: 'platform_fee_account',
					writable: true,
					optional: true,
				},
				{
					name: 'token_2022_program',
					optional: true,
				},
				{
					name: 'event_authority',
					address: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
				},
				{
					name: 'program',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
				{
					name: 'route_plan',
					type: {
						vec: {
							defined: {
								name: 'RoutePlanStep',
							},
						},
					},
				},
				{
					name: 'out_amount',
					type: 'u64',
				},
				{
					name: 'quoted_in_amount',
					type: 'u64',
				},
				{
					name: 'slippage_bps',
					type: 'u16',
				},
				{
					name: 'platform_fee_bps',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'shared_accounts_route',
			docs: ['Route by using program owned token accounts and open orders accounts.'],
			discriminator: [193, 32, 155, 51, 65, 214, 156, 129],
			accounts: [
				{
					name: 'token_program',
				},
				{
					name: 'program_authority',
				},
				{
					name: 'user_transfer_authority',
					signer: true,
				},
				{
					name: 'source_token_account',
					writable: true,
				},
				{
					name: 'program_source_token_account',
					writable: true,
				},
				{
					name: 'program_destination_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
				},
				{
					name: 'source_mint',
				},
				{
					name: 'destination_mint',
				},
				{
					name: 'platform_fee_account',
					writable: true,
					optional: true,
				},
				{
					name: 'token_2022_program',
					optional: true,
				},
				{
					name: 'event_authority',
					address: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
				},
				{
					name: 'program',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
				{
					name: 'route_plan',
					type: {
						vec: {
							defined: {
								name: 'RoutePlanStep',
							},
						},
					},
				},
				{
					name: 'in_amount',
					type: 'u64',
				},
				{
					name: 'quoted_out_amount',
					type: 'u64',
				},
				{
					name: 'slippage_bps',
					type: 'u16',
				},
				{
					name: 'platform_fee_bps',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
		{
			name: 'shared_accounts_route_with_token_ledger',
			discriminator: [230, 121, 143, 80, 119, 159, 106, 170],
			accounts: [
				{
					name: 'token_program',
				},
				{
					name: 'program_authority',
				},
				{
					name: 'user_transfer_authority',
					signer: true,
				},
				{
					name: 'source_token_account',
					writable: true,
				},
				{
					name: 'program_source_token_account',
					writable: true,
				},
				{
					name: 'program_destination_token_account',
					writable: true,
				},
				{
					name: 'destination_token_account',
					writable: true,
				},
				{
					name: 'source_mint',
				},
				{
					name: 'destination_mint',
				},
				{
					name: 'platform_fee_account',
					writable: true,
					optional: true,
				},
				{
					name: 'token_2022_program',
					optional: true,
				},
				{
					name: 'token_ledger',
				},
				{
					name: 'event_authority',
					address: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
				},
				{
					name: 'program',
				},
			],
			args: [
				{
					name: 'id',
					type: 'u8',
				},
				{
					name: 'route_plan',
					type: {
						vec: {
							defined: {
								name: 'RoutePlanStep',
							},
						},
					},
				},
				{
					name: 'quoted_out_amount',
					type: 'u64',
				},
				{
					name: 'slippage_bps',
					type: 'u16',
				},
				{
					name: 'platform_fee_bps',
					type: 'u8',
				},
			],
			returns: 'u64',
		},
	],
	accounts: [
		{
			name: 'TokenLedger',
			discriminator: [156, 247, 9, 188, 54, 108, 85, 77],
		},
	],
	events: [
		{
			name: 'FeeEvent',
			discriminator: [73, 79, 78, 127, 184, 213, 13, 220],
		},
		{
			name: 'SwapEvent',
			discriminator: [64, 198, 205, 232, 38, 8, 113, 226],
		},
	],
	types: [
		{
			name: 'AccountsType',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'TransferHookA',
					},
					{
						name: 'TransferHookB',
					},
					{
						name: 'TransferHookReward',
					},
					{
						name: 'TransferHookInput',
					},
					{
						name: 'TransferHookIntermediate',
					},
					{
						name: 'TransferHookOutput',
					},
					{
						name: 'SupplementalTickArrays',
					},
					{
						name: 'SupplementalTickArraysOne',
					},
					{
						name: 'SupplementalTickArraysTwo',
					},
				],
			},
		},
		{
			name: 'FeeEvent',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'account',
						type: 'pubkey',
					},
					{
						name: 'mint',
						type: 'pubkey',
					},
					{
						name: 'amount',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'RemainingAccountsInfo',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'slices',
						type: {
							vec: {
								defined: {
									name: 'RemainingAccountsSlice',
								},
							},
						},
					},
				],
			},
		},
		{
			name: 'RemainingAccountsSlice',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'accounts_type',
						type: {
							defined: {
								name: 'AccountsType',
							},
						},
					},
					{
						name: 'length',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'RoutePlanStep',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'swap',
						type: {
							defined: {
								name: 'Swap',
							},
						},
					},
					{
						name: 'percent',
						type: 'u8',
					},
					{
						name: 'input_index',
						type: 'u8',
					},
					{
						name: 'output_index',
						type: 'u8',
					},
				],
			},
		},
		{
			name: 'Side',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Bid',
					},
					{
						name: 'Ask',
					},
				],
			},
		},
		{
			name: 'Swap',
			type: {
				kind: 'enum',
				variants: [
					{
						name: 'Saber',
					},
					{
						name: 'SaberAddDecimalsDeposit',
					},
					{
						name: 'SaberAddDecimalsWithdraw',
					},
					{
						name: 'TokenSwap',
					},
					{
						name: 'Sencha',
					},
					{
						name: 'Step',
					},
					{
						name: 'Cropper',
					},
					{
						name: 'Raydium',
					},
					{
						name: 'Crema',
						fields: [
							{
								name: 'a_to_b',
								type: 'bool',
							},
						],
					},
					{
						name: 'Lifinity',
					},
					{
						name: 'Mercurial',
					},
					{
						name: 'Cykura',
					},
					{
						name: 'Serum',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'MarinadeDeposit',
					},
					{
						name: 'MarinadeUnstake',
					},
					{
						name: 'Aldrin',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'AldrinV2',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'Whirlpool',
						fields: [
							{
								name: 'a_to_b',
								type: 'bool',
							},
						],
					},
					{
						name: 'Invariant',
						fields: [
							{
								name: 'x_to_y',
								type: 'bool',
							},
						],
					},
					{
						name: 'Meteora',
					},
					{
						name: 'GooseFX',
					},
					{
						name: 'DeltaFi',
						fields: [
							{
								name: 'stable',
								type: 'bool',
							},
						],
					},
					{
						name: 'Balansol',
					},
					{
						name: 'MarcoPolo',
						fields: [
							{
								name: 'x_to_y',
								type: 'bool',
							},
						],
					},
					{
						name: 'Dradex',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'LifinityV2',
					},
					{
						name: 'RaydiumClmm',
					},
					{
						name: 'Openbook',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'Phoenix',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'Symmetry',
						fields: [
							{
								name: 'from_token_id',
								type: 'u64',
							},
							{
								name: 'to_token_id',
								type: 'u64',
							},
						],
					},
					{
						name: 'TokenSwapV2',
					},
					{
						name: 'HeliumTreasuryManagementRedeemV0',
					},
					{
						name: 'StakeDexStakeWrappedSol',
					},
					{
						name: 'StakeDexSwapViaStake',
						fields: [
							{
								name: 'bridge_stake_seed',
								type: 'u32',
							},
						],
					},
					{
						name: 'GooseFXV2',
					},
					{
						name: 'Perps',
					},
					{
						name: 'PerpsAddLiquidity',
					},
					{
						name: 'PerpsRemoveLiquidity',
					},
					{
						name: 'MeteoraDlmm',
					},
					{
						name: 'OpenBookV2',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'RaydiumClmmV2',
					},
					{
						name: 'StakeDexPrefundWithdrawStakeAndDepositStake',
						fields: [
							{
								name: 'bridge_stake_seed',
								type: 'u32',
							},
						],
					},
					{
						name: 'Clone',
						fields: [
							{
								name: 'pool_index',
								type: 'u8',
							},
							{
								name: 'quantity_is_input',
								type: 'bool',
							},
							{
								name: 'quantity_is_collateral',
								type: 'bool',
							},
						],
					},
					{
						name: 'SanctumS',
						fields: [
							{
								name: 'src_lst_value_calc_accs',
								type: 'u8',
							},
							{
								name: 'dst_lst_value_calc_accs',
								type: 'u8',
							},
							{
								name: 'src_lst_index',
								type: 'u32',
							},
							{
								name: 'dst_lst_index',
								type: 'u32',
							},
						],
					},
					{
						name: 'SanctumSAddLiquidity',
						fields: [
							{
								name: 'lst_value_calc_accs',
								type: 'u8',
							},
							{
								name: 'lst_index',
								type: 'u32',
							},
						],
					},
					{
						name: 'SanctumSRemoveLiquidity',
						fields: [
							{
								name: 'lst_value_calc_accs',
								type: 'u8',
							},
							{
								name: 'lst_index',
								type: 'u32',
							},
						],
					},
					{
						name: 'RaydiumCP',
					},
					{
						name: 'WhirlpoolSwapV2',
						fields: [
							{
								name: 'a_to_b',
								type: 'bool',
							},
							{
								name: 'remaining_accounts_info',
								type: {
									option: {
										defined: {
											name: 'RemainingAccountsInfo',
										},
									},
								},
							},
						],
					},
					{
						name: 'OneIntro',
					},
					{
						name: 'PumpdotfunWrappedBuy',
					},
					{
						name: 'PumpdotfunWrappedSell',
					},
					{
						name: 'PerpsV2',
					},
					{
						name: 'PerpsV2AddLiquidity',
					},
					{
						name: 'PerpsV2RemoveLiquidity',
					},
					{
						name: 'MoonshotWrappedBuy',
					},
					{
						name: 'MoonshotWrappedSell',
					},
					{
						name: 'StabbleStableSwap',
					},
					{
						name: 'StabbleWeightedSwap',
					},
					{
						name: 'Obric',
						fields: [
							{
								name: 'x_to_y',
								type: 'bool',
							},
						],
					},
					{
						name: 'FoxBuyFromEstimatedCost',
					},
					{
						name: 'FoxClaimPartial',
						fields: [
							{
								name: 'is_y',
								type: 'bool',
							},
						],
					},
					{
						name: 'SolFi',
						fields: [
							{
								name: 'is_quote_to_base',
								type: 'bool',
							},
						],
					},
					{
						name: 'SolayerDelegateNoInit',
					},
					{
						name: 'SolayerUndelegateNoInit',
					},
					{
						name: 'TokenMill',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'DaosFunBuy',
					},
					{
						name: 'DaosFunSell',
					},
					{
						name: 'ZeroFi',
					},
					{
						name: 'StakeDexWithdrawWrappedSol',
					},
					{
						name: 'VirtualsBuy',
					},
					{
						name: 'VirtualsSell',
					},
					{
						name: 'Perena',
						fields: [
							{
								name: 'in_index',
								type: 'u8',
							},
							{
								name: 'out_index',
								type: 'u8',
							},
						],
					},
					{
						name: 'PumpdotfunAmmBuy',
					},
					{
						name: 'PumpdotfunAmmSell',
					},
					{
						name: 'Gamma',
					},
					{
						name: 'MeteoraDlmmSwapV2',
						fields: [
							{
								name: 'remaining_accounts_info',
								type: {
									defined: {
										name: 'RemainingAccountsInfo',
									},
								},
							},
						],
					},
					{
						name: 'Woofi',
					},
					{
						name: 'MeteoraDammV2',
					},
					{
						name: 'MeteoraDynamicBondingCurveSwap',
					},
					{
						name: 'StabbleStableSwapV2',
					},
					{
						name: 'StabbleWeightedSwapV2',
					},
					{
						name: 'RaydiumLaunchlabBuy',
						fields: [
							{
								name: 'share_fee_rate',
								type: 'u64',
							},
						],
					},
					{
						name: 'RaydiumLaunchlabSell',
						fields: [
							{
								name: 'share_fee_rate',
								type: 'u64',
							},
						],
					},
					{
						name: 'BoopdotfunWrappedBuy',
					},
					{
						name: 'BoopdotfunWrappedSell',
					},
					{
						name: 'Plasma',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'GoonFi',
						fields: [
							{
								name: 'is_bid',
								type: 'bool',
							},
							{
								name: 'blacklist_bump',
								type: 'u8',
							},
						],
					},
					{
						name: 'HumidiFi',
						fields: [
							{
								name: 'swap_id',
								type: 'u64',
							},
							{
								name: 'is_base_to_quote',
								type: 'bool',
							},
						],
					},
					{
						name: 'MeteoraDynamicBondingCurveSwapWithRemainingAccounts',
					},
					{
						name: 'TesseraV',
						fields: [
							{
								name: 'side',
								type: {
									defined: {
										name: 'Side',
									},
								},
							},
						],
					},
					{
						name: 'RaydiumStable',
					},
				],
			},
		},
		{
			name: 'SwapEvent',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'amm',
						type: 'pubkey',
					},
					{
						name: 'input_mint',
						type: 'pubkey',
					},
					{
						name: 'input_amount',
						type: 'u64',
					},
					{
						name: 'output_mint',
						type: 'pubkey',
					},
					{
						name: 'output_amount',
						type: 'u64',
					},
				],
			},
		},
		{
			name: 'TokenLedger',
			type: {
				kind: 'struct',
				fields: [
					{
						name: 'token_account',
						type: 'pubkey',
					},
					{
						name: 'amount',
						type: 'u64',
					},
				],
			},
		},
	],
};

export type JupiterSwapAttrs = {
	forwardedTokenAddress: string,
	forwardedFromAmount: string,
	forwardedFromSymbol: string,
	// toTokenAddress: string,
	// toTokenSymbol: string,
	// toAmount: string,
}
import {
	CHAIN_ID_APTOS,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_AVAX,
	CHAIN_ID_BASE,
	CHAIN_ID_BSC,
	CHAIN_ID_ETH,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_SOLANA,
	CHAIN_ID_SUI,
	ChainId,
	hexToUint8Array,
	tryNativeToHexString,
	tryNativeToUint8Array,
	tryUint8ArrayToNative,
	uint8ArrayToHex,
} from '@certusone/wormhole-sdk';
import { Metadata } from '@metaplex-foundation/mpl-token-metadata';
import { SuiClient } from '@mysten/sui/client';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { ethers } from 'ethers';
import { sha3_256 } from 'js-sha3';
import { EvmChainIds, isEVMChainId, WhChainIdToEvm } from './chain-map';
import { getDecimals, getSymbol, hasPermit } from './erc20';
import { makeEvmProviders } from './evm-providers';
import { getSuiClient } from './sui';
import tokens, { NativeTokens, Token } from './tokens';

let solanaConnection: Connection | null = null;
let suiClient: SuiClient | null = null;
let evmProviders: { [chainId: number]: ethers.providers.JsonRpcProvider } | null = null;

export async function getTokenDataGeneral(
	tokenChain: number,
	tokenAddress: string,
): Promise<Token> {
	const predefinedToken = getTokenData(tokenChain, tokenAddress);
	if (predefinedToken) {
		return predefinedToken;
	}

	if (tokenChain === CHAIN_ID_SOLANA) {
		return await fetchSolanaTokenData(tokenAddress);
	} else if (tokenChain === CHAIN_ID_SUI) {
		// tokenAddress might be verified address (metadata id) or coin type. for now only cointype implemented
		return await fetchSuiTokenData(tokenAddress);
	} else if (isEVMChainId(tokenChain)) {
		return await fetchErc20TokenData(tokenChain, tokenAddress);
	} else {
		throw new Error(`unsupported chain for token ${tokenChain}`);
	}
}

export function normalizeTokenAddress(addr: string): string {
	if (addr === '11111111111111111111111111111111') {
		return '0x0000000000000000000000000000000000000000';
	}

	return addr;
}

export function getTokenData(tokenChain: number, tokenAddress: string): Token | null {
	if (!tokens[tokenChain]) {
		console.log('token chain not found', tokenChain);
		return null;
	}

	const token = tokens[tokenChain].find((t) => {
		switch (tokenChain) {
			case CHAIN_ID_SOLANA:
				tokenAddress = normalizeTokenAddress(tokenAddress);
				return t.contract === tokenAddress;
			case CHAIN_ID_APTOS:
				return (
					(t.contract === ethers.constants.AddressZero
						? t.realOriginContractAddress
						: t.contract) === tokenAddress
				);
			case CHAIN_ID_SUI:
				return t.contract === tokenAddress || t.verifiedAddress === tokenAddress;
			default:
				return t.contract.toLowerCase() === tokenAddress.toLowerCase();
		}
	});

	if (!token) {
		return null;
	}

	return token;
}

export async function uint8ArrayToTokenGeneral(chainId: number, token32: Uint8Array): Promise<Token> {
	if (chainId === CHAIN_ID_SUI) {
		return getTokenDataGeneral(chainId, '0x' + uint8ArrayToHex(token32));
	} else {
		const x = tryUint8ArrayToNative(token32, chainId as ChainId);
		return getTokenDataGeneral(chainId as ChainId, x);
	}
}

export async function tryUint8ArrayToTokenGeneral(chainId: number, token32: Uint8Array): Promise<Token> {
	if (chainId === CHAIN_ID_SUI) {
		return getTokenDataGeneral(chainId, '0x' + uint8ArrayToHex(token32));
	} else {
		const x = tryUint8ArrayToNative(token32, chainId as ChainId);
		return getTokenDataGeneral(chainId as ChainId, x);
	}
}

async function fetchSuiTokenData(tokenTypeOrCoinId: string): Promise<Token> {
	const coinType = tokenTypeOrCoinId;
	if (!suiClient) {
		suiClient = getSuiClient();
	}

	const coinMeta = await suiClient.getCoinMetadata({
		coinType: coinType,
	});
	if (!coinMeta || !coinMeta.id) {
		throw new Error(`Coin ${coinType} not found on Sui chain`);
	}

	return {
		chainId: 101,
		coingeckoId: '',
		contract: coinType,
		decimals: coinMeta.decimals,
		logoURI: coinMeta.iconUrl!,
		mint: '',
		name: coinMeta.name,
		standard: 'suicoin',
		realOriginChainId: CHAIN_ID_SUI,
		realOriginContractAddress: coinType,
		symbol: coinMeta.symbol,
		wChainId: CHAIN_ID_SUI,
		verifiedAddress: coinMeta.id,
		verified: true,
	};
}

async function fetchSolanaTokenData(tokenContract: string): Promise<Token> {
	if (!solanaConnection) {
		solanaConnection = new Connection(
			process.env.SOLANA_RPC ||
				process.env.SOLANA_FAST_RPC ||
				'https://api.mainnet-beta.solana.com',
			'confirmed',
		);
	}
	const mintAccountInfo = await solanaConnection.getParsedAccountInfo(
		new PublicKey(tokenContract),
	);
	if (!mintAccountInfo.value) {
		throw new Error(`Token account not found on solana chain for ${tokenContract}`);
	}
	const mintData = mintAccountInfo.value.data as ParsedAccountData;
	const decimals = Number(mintData.parsed.info.decimals);
	let isToken2022 = false;
	if (mintAccountInfo && mintAccountInfo.value) {
		const ownerProgramId = (mintAccountInfo.value as any).owner;
		isToken2022 = ownerProgramId.equals(TOKEN_2022_PROGRAM_ID);
	}
	let transferFeeExtension = mintData.parsed.info.extensions?.find(
		(e: any) => e.extension === 'transferFeeConfig',
	);
	let tokenMetadataExtension = mintData.parsed.info.extensions?.find(
		(e: any) => e.extension === 'tokenMetadata',
	);

	let hasTransferFee = false;
	if (transferFeeExtension) {
		if (Number(transferFeeExtension.withheldAmount)) {
			hasTransferFee = true;
		}

		if (Number(transferFeeExtension.state?.newerTransferFee?.transferFeeBasisPoints)) {
			hasTransferFee = true;
		}
	}

	let {
		symbol,
		name,
		logoUri: logo,
	} = await fetchSolanaFromMetaplex(solanaConnection, tokenContract);

	if (!!tokenMetadataExtension && (!name || !symbol)) {
		name = tokenMetadataExtension.state?.name;
		symbol = tokenMetadataExtension.state?.symbol;
		logo = tokenMetadataExtension.state?.uri || '';
	}
	if (!name || !symbol) {
		const { data } = await axios.get(`https://tokens.jup.ag/token/${tokenContract}`);
		if (!data.name || !data.symbol) {
			throw new Error(`Token not found from jup on solana chain for ${tokenContract}`);
		}

		logo = data.logoURI || '';
		name = data.name;
		symbol = data.symbol;
	}

	return {
		chainId: 0,
		wChainId: CHAIN_ID_SOLANA,
		coingeckoId: tokenContract,
		contract: tokenContract,
		mint: tokenContract,
		decimals: Number(decimals),
		logoURI: logo,
		name: name,
		realOriginChainId: CHAIN_ID_SOLANA,
		realOriginContractAddress: tokenContract,
		symbol: symbol,
		verified: false,
		nonMayanDefined: true,
		supportsPermit: false,
		standard: isToken2022 ? 'spl2022' : 'spl',
		hasTransferFee: hasTransferFee,
	};
}

async function fetchSolanaFromMetaplex(
	connection: Connection,
	tokenContract: string,
): Promise<{
	symbol: string;
	name: string;
	logoUri: string;
}> {
	try {
		const metadataPDA = PublicKey.findProgramAddressSync(
			[
				Buffer.from('metadata'),
				new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
				new PublicKey(tokenContract).toBuffer(),
			],
			new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
		)[0];

		const accountInfo = await connection.getAccountInfo(metadataPDA);
		if (accountInfo === null) {
			throw new Error('Token metadata account not found');
		}

		// Decode the metadata
		const metadata = Metadata.deserialize(accountInfo.data);
		let symbol = metadata[0].data.symbol.replace(/\x00/g, '');
		let name = (metadata[0].data.name || symbol || '').replace(/\x00/g, '');
		const uri = (metadata[0].data.uri || '').replace(/\x00/g, '');
		let logo = '';
		if (uri) {
			try {
				const { data } = await axios.get(uri);
				if (data.image) {
					logo = data.image;
				}
			} catch (e) {
				console.error(`failed to fetch metadata from ${uri}`);
			}
		}
		return {
			symbol,
			name,
			logoUri: logo,
		};
	} catch (err) {
		console.warn(`failed to fetch metadata for ${tokenContract}`, err);
		return {
			symbol: '',
			name: '',
			logoUri: '',
		};
	}
}

export function getToken32bytesHexAddress(token: Token): string {
	if (token.wChainId === CHAIN_ID_SUI) {
		return token.verifiedAddress!;
	}

	return tryNativeToHexString(token.contract, token.wChainId as ChainId);
}

export async function fetchErc20TokenData(chainId: number, tokenContract: string): Promise<Token> {
	if (!evmProviders) {
		evmProviders = makeEvmProviders(EvmChainIds);
	}

	const [symbol, decimals, permit] = await Promise.all([
		getSymbol(evmProviders[chainId], tokenContract),
		getDecimals(evmProviders[chainId], tokenContract),
		hasPermit(evmProviders[chainId], tokenContract),
	]);

	return {
		chainId: WhChainIdToEvm[chainId],
		wChainId: chainId,
		coingeckoId: tokenContract,
		contract: tokenContract,
		mint: tokenContract,
		decimals: Number(decimals),
		logoURI: '',
		name: symbol,
		realOriginChainId: chainId,
		realOriginContractAddress: tokenContract,
		symbol: symbol,
		verified: false,
		nonMayanDefined: true,
		supportsPermit: permit,
		standard: 'erc20',
	};
}

export function realUint8ArrayToNative(address: Uint8Array, chainId: ChainId) {
	if (chainId === CHAIN_ID_APTOS) {
		const token = tokens[chainId].find(
			(t) => Buffer.from(address).toString('hex') === sha3_256(t.contract),
		);

		if (token) {
			return token.contract;
		} else {
			return `0x${uint8ArrayToHex(address)}`;
		}
	}
	return tryUint8ArrayToNative(address, chainId);
}

export function getScannerUrlOfToken(contractAddr: string, chainId: ChainId): string {
	switch (chainId) {
		case CHAIN_ID_SOLANA:
			return `https://solscan.io/token/${contractAddr}`;
		case CHAIN_ID_ETH:
			return `https://etherscan.io/token/${contractAddr}`;
		case CHAIN_ID_BSC:
			return `https://bscscan.com/token/${contractAddr}`;
		case CHAIN_ID_POLYGON:
			return `https://polygonscan.com/token/${contractAddr}`;
		case CHAIN_ID_AVAX:
			return `https://snowtrace.io/token/${contractAddr}`;
		case CHAIN_ID_ARBITRUM:
			return `https://arbiscan.io/token/${contractAddr}`;
		case CHAIN_ID_APTOS:
			return `https://tracemove.io/coin/${contractAddr}`;
		case CHAIN_ID_OPTIMISM:
			return `https://optimistic.etherscan.io/token/${contractAddr}`;
		case CHAIN_ID_BASE:
			return `https://basescan.org/token/${contractAddr}`;
		case CHAIN_ID_SUI:
			return `https://suiscan.xyz/mainnet/coin/${contractAddr}/txs`;
		default:
			throw new Error(`invalid token chain ${chainId} for ${contractAddr}`);
	}
}

export function getScannerUrlOfTx(txHash: string, chainId: ChainId): string {
	switch (chainId) {
		case CHAIN_ID_SOLANA:
			return `https://solscan.io/tx/${txHash}`;
		case CHAIN_ID_ETH:
			return `https://etherscan.io/tx/${txHash}`;
		case CHAIN_ID_BSC:
			return `https://bscscan.com/tx/${txHash}`;
		case CHAIN_ID_POLYGON:
			return `https://polygonscan.com/tx/${txHash}`;
		case CHAIN_ID_AVAX:
			return `https://snowtrace.io/tx/${txHash}`;
		case CHAIN_ID_ARBITRUM:
			return `https://arbiscan.io/tx/${txHash}`;
		case CHAIN_ID_APTOS:
			return `https://explorer.aptoslabs.com/txn/${txHash}`;
		case CHAIN_ID_OPTIMISM:
			return `https://optimistic.etherscan.io/tx/${txHash}`;
		case CHAIN_ID_BASE:
			return `https://basescan.org/tx/${txHash}`;
		case CHAIN_ID_SUI:
			return `https://suiscan.xyz/mainnet/tx/${txHash}`;
		default:
			throw new Error(`invalid tx chain ${chainId} for ${txHash}`);
	}
}

export const coingeckoIds = [...new Set([...tokens['1'], ...tokens['21']].map((i) => i.coingeckoId.trim()))];

const UsdcContracts: any = {
	[CHAIN_ID_SOLANA]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	[CHAIN_ID_ETH]: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
	[CHAIN_ID_POLYGON]: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
	[CHAIN_ID_AVAX]: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
	[CHAIN_ID_ARBITRUM]: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
	[CHAIN_ID_OPTIMISM]: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
	[CHAIN_ID_BASE]: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
	[CHAIN_ID_SUI]: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
};

export function getNativeUsdc(chainId: ChainId): Token {
	return tokens[chainId].find((tk) => tk.contract === UsdcContracts[chainId])!;
}

const UsdtContracts: any = {
	[CHAIN_ID_SOLANA]: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
	[CHAIN_ID_BSC]: '0x55d398326f99059ff775485246999027b3197955',
	[CHAIN_ID_ETH]: '0xdac17f958d2ee523a2206206994597c13d831ec7',
	[CHAIN_ID_POLYGON]: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
	[CHAIN_ID_AVAX]: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
	[CHAIN_ID_ARBITRUM]: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
	[CHAIN_ID_OPTIMISM]: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
};

export function getNativeUsdt(chainId: ChainId): Token {
	return tokens[chainId].find((tk) => tk.contract === UsdtContracts[chainId])!;
}


export function getSolWeth(chainId: ChainId): Token | null {
	if (chainId !== CHAIN_ID_SOLANA) {
		return null;
	}
	return tokens[CHAIN_ID_SOLANA].find(
		(tk) => tk.contract === '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
	)!; // weth ethereum on solana
}


export function getWeth(chainId: ChainId): Token | null {
	if (chainId === CHAIN_ID_SOLANA) {
		return tokens[CHAIN_ID_SOLANA].find(
			(tk) => tk.contract === '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
		)!; // weth ethereum on solana
	}
	const eth = getEth(chainId);
	if (eth && eth.wrappedAddress) {
		return tokens[chainId].find((tk) => tk.contract === eth.wrappedAddress)!;
	}

	return null;
}

export function getEth(chainId: ChainId): Token | null {
	if (
		[CHAIN_ID_ETH, CHAIN_ID_ARBITRUM, CHAIN_ID_OPTIMISM, CHAIN_ID_BASE].includes(chainId as any)
	) {
		return NativeTokens[chainId];
	}
	return null;
}

export const PeggedStableDollarsPerChain: { [chainId: number]: Set<string> } = {
	[CHAIN_ID_ETH]: new Set([UsdcContracts[CHAIN_ID_ETH], UsdtContracts[CHAIN_ID_ETH]]),
	[CHAIN_ID_SOLANA]: new Set([UsdcContracts[CHAIN_ID_SOLANA], UsdtContracts[CHAIN_ID_SOLANA]]),
	[CHAIN_ID_BSC]: new Set([
		UsdtContracts[CHAIN_ID_BSC],
		'0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
		'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // bianance pegged usd
	]),
	[CHAIN_ID_POLYGON]: new Set([UsdcContracts[CHAIN_ID_POLYGON], UsdtContracts[CHAIN_ID_POLYGON]]),
	[CHAIN_ID_AVAX]: new Set([UsdcContracts[CHAIN_ID_AVAX], UsdtContracts[CHAIN_ID_AVAX]]),
	[CHAIN_ID_ARBITRUM]: new Set([
		UsdcContracts[CHAIN_ID_ARBITRUM],
		UsdtContracts[CHAIN_ID_ARBITRUM],
	]),
	[CHAIN_ID_OPTIMISM]: new Set([
		UsdcContracts[CHAIN_ID_OPTIMISM],
		UsdtContracts[CHAIN_ID_OPTIMISM],
	]),
	[CHAIN_ID_BASE]: new Set([UsdcContracts[CHAIN_ID_BASE]]),
	[CHAIN_ID_SUI]: new Set([UsdcContracts[CHAIN_ID_SUI]]),
};

export function tryTokenToUint8ArrayGeneral(token: Token, chainId: number): Uint8Array {
	if (chainId === CHAIN_ID_SUI) {
		return hexToUint8Array(token.verifiedAddress!);
	} else {
		return tryNativeToUint8Array(token.contract, chainId as ChainId);
	}
}




export function isSpl2022(t: Token) {
	return t.standard === 'spl2022';
}
export const WELL_KNOWN_TOKENS = new Set([
	'0x0000000000000000000000000000000000000000', // native
	getNativeUsdc(CHAIN_ID_ETH).contract,
	getNativeUsdc(CHAIN_ID_ARBITRUM).contract,
	getNativeUsdc(CHAIN_ID_BASE).contract,
	getNativeUsdc(CHAIN_ID_OPTIMISM).contract,
	getNativeUsdc(CHAIN_ID_AVAX).contract,
	getNativeUsdc(CHAIN_ID_POLYGON).contract,
	getNativeUsdc(CHAIN_ID_SOLANA).contract,
	getNativeUsdt(CHAIN_ID_ETH).contract,
	getNativeUsdt(CHAIN_ID_ARBITRUM).contract,
	getNativeUsdt(CHAIN_ID_BSC).contract,
	getNativeUsdt(CHAIN_ID_OPTIMISM).contract,
	getNativeUsdt(CHAIN_ID_AVAX).contract,
	getNativeUsdt(CHAIN_ID_POLYGON).contract,
	getNativeUsdt(CHAIN_ID_SOLANA).contract,
	'0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e polygon
	'0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e arbitrum
	'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC on solana
]); // these tokens always have a route and do not require 1inch/0x/jup routing when fetching quote api

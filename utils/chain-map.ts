import {
    CHAIN_ID_APTOS,
    CHAIN_ID_ARBITRUM,
    CHAIN_ID_AVAX,
    CHAIN_ID_BASE,
    CHAIN_ID_BSC, CHAIN_ID_ETH,
    CHAIN_ID_OPTIMISM,
    CHAIN_ID_POLYGON,
    CHAIN_ID_SOLANA,
    CHAIN_ID_SUI,
    ChainId
} from "@certusone/wormhole-sdk";

export function mapNameToWormholeChainId(name: string): ChainId {

	if (!(name in chainMap)) {
		throw new Error('Invalid Network Name!');
	}

	return (chainMap as any)[name];
}

export function mapChainIdToName(chainId: ChainId): string {
	for (let name in chainMap) {
		if ((chainMap as any)[name] === chainId) {
			return name;
		}
	}
	throw new Error('Invalid chain id!');
}

export const chainMap = {
	solana: CHAIN_ID_SOLANA,
	ethereum: CHAIN_ID_ETH,
	bsc: CHAIN_ID_BSC,
	polygon: CHAIN_ID_POLYGON,
	avalanche: CHAIN_ID_AVAX,
	arbitrum: CHAIN_ID_ARBITRUM,
	aptos: CHAIN_ID_APTOS,
	optimism: CHAIN_ID_OPTIMISM,
	base: CHAIN_ID_BASE,
	sui: CHAIN_ID_SUI,
};


export const CIRCLE_DOMAIN_ETH = 0;
export const CIRCLE_DOMAIN_AVAX = 1;
export const CIRCLE_DOMAIN_OPTIMISM = 2;
export const CIRCLE_DOMAIN_ARBITRUM = 3;
export const CIRCLE_DOMAIN_SOLANA = 5;
export const CIRCLE_DOMAIN_BASE = 6;
export const CIRCLE_DOMAIN_POLYGON = 7;
export const CIRCLE_DOMAIN_SUI = 8;

export const WH_SWAP_EVM_CHAINS: ChainId[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_BSC,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
];

export const SWIFT_EVM_CHAINS: ChainId[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_BSC,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_BASE,
];

export const CCTP_EVM_CHAINS: ChainId[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_BASE,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
];

export const CircleDomainToWhChainId: { [domain: number]: ChainId } = {
	0: CHAIN_ID_ETH,
	1: CHAIN_ID_AVAX,
	2: CHAIN_ID_OPTIMISM,
	3: CHAIN_ID_ARBITRUM,
	5: CHAIN_ID_SOLANA,
	6: CHAIN_ID_BASE,
	7: CHAIN_ID_POLYGON,
	8: CHAIN_ID_SUI,
};

export const WhChainIdToCircle: { [chainId: number]: number } = {
	[CHAIN_ID_ETH]: 0,
	[CHAIN_ID_AVAX]: 1,
	[CHAIN_ID_OPTIMISM]: 2,
	[CHAIN_ID_ARBITRUM]: 3,
	[CHAIN_ID_SOLANA]: 5,
	[CHAIN_ID_BASE]: 6,
	[CHAIN_ID_POLYGON]: 7,
	[CHAIN_ID_SUI]: 8,
};

export const WhChainIdToEvm: { [chainId: number]: number } = {
	[CHAIN_ID_ETH]: 1,
	[CHAIN_ID_BSC]: 56,
	[CHAIN_ID_BASE]: 8453,
	[CHAIN_ID_AVAX]: 43114,
	[CHAIN_ID_OPTIMISM]: 10,
	[CHAIN_ID_ARBITRUM]: 42161,
	[CHAIN_ID_POLYGON]: 137,
};

export const EvmChainIds = [
	CHAIN_ID_ETH,
	CHAIN_ID_BSC,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_BASE,
];

export function isEVMChainId(chainId: number): boolean {
	return EvmChainIds.includes(chainId as any);
}
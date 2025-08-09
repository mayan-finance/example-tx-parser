export const CHAIN_ID_SOLANA = 1;
export const CHAIN_ID_ETH = 2;
export const CHAIN_ID_BSC = 4;
export const CHAIN_ID_POLYGON = 5;
export const CHAIN_ID_AVAX = 6;
export const CHAIN_ID_SUI = 21;
export const CHAIN_ID_APTOS = 22;
export const CHAIN_ID_ARBITRUM = 23;
export const CHAIN_ID_OPTIMISM = 24;
export const CHAIN_ID_BASE = 30;
export const CHAIN_ID_UNICHAIN = 44;
export const CHAIN_ID_LINEA = 38;
export const CHAIN_ID_HYPERCORE = 65_000;
export const CHAIN_ID_SONIC = 52;

export function mapNameToWormholeChainId(name: string): number {
	if (!(name in chainMap)) {
		throw new Error('Invalid Network Name!');
	}

	return chainMap[name];
}

export function mapChainIdToName(chainId: number): string {
	for (let name in chainMap) {
		if (chainMap[name] === chainId) {
			return name;
		}
	}
	throw new Error('Invalid chain id!');
}

export const chainMap: { [key: string]: number } = {
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
	unichain: CHAIN_ID_UNICHAIN,
	linea: CHAIN_ID_LINEA,
	hypercore: CHAIN_ID_HYPERCORE,
	sonic: CHAIN_ID_SONIC,
};

export const CIRCLE_DOMAIN_ETH = 0;
export const CIRCLE_DOMAIN_AVAX = 1;
export const CIRCLE_DOMAIN_OPTIMISM = 2;
export const CIRCLE_DOMAIN_ARBITRUM = 3;
export const CIRCLE_DOMAIN_SOLANA = 5;
export const CIRCLE_DOMAIN_BASE = 6;
export const CIRCLE_DOMAIN_POLYGON = 7;
export const CIRCLE_DOMAIN_SUI = 8;
export const CIRCLE_DOMAIN_UNICHAIN = 10;
export const CIRCLE_DOMAIN_LINEA = 11;
export const CIRCLE_DOMAIN_SONIC = 13;

export const WH_SWAP_EVM_CHAINS: number[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_BSC,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
];

export const SWIFT_EVM_CHAINS: number[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_BSC,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_BASE,
	CHAIN_ID_UNICHAIN,
];

export const CCTP_V2_EVM_CHAINS: number[] = [
	CHAIN_ID_LINEA,
	CHAIN_ID_ETH,
	CHAIN_ID_AVAX,
	CHAIN_ID_BASE,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_SONIC,
];

export const CCTP_V1_EVM_CHAINS: number[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_BASE,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_UNICHAIN,
];

export const CCTP_EVM_CHAINS: number[] = [
	CHAIN_ID_ETH,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_BASE,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_UNICHAIN,
	CHAIN_ID_LINEA,
];


export const CircleDomainToWhChainId: { [domain: number]: number } = {
	0: CHAIN_ID_ETH,
	1: CHAIN_ID_AVAX,
	2: CHAIN_ID_OPTIMISM,
	3: CHAIN_ID_ARBITRUM,
	5: CHAIN_ID_SOLANA,
	6: CHAIN_ID_BASE,
	7: CHAIN_ID_POLYGON,
	8: CHAIN_ID_SUI,
	10: CHAIN_ID_UNICHAIN,
	11: CHAIN_ID_LINEA,
	13: CHAIN_ID_SONIC,
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
	[CHAIN_ID_UNICHAIN]: 10,
	[CHAIN_ID_LINEA]: 11,
	[CHAIN_ID_SONIC]: 13,
};

export const WhChainIdToEvm: { [chainId: number]: number } = {
	[CHAIN_ID_ETH]: 1,
	[CHAIN_ID_BSC]: 56,
	[CHAIN_ID_BASE]: 8453,
	[CHAIN_ID_AVAX]: 43114,
	[CHAIN_ID_OPTIMISM]: 10,
	[CHAIN_ID_ARBITRUM]: 42161,
	[CHAIN_ID_POLYGON]: 137,
	[CHAIN_ID_UNICHAIN]: 130,
	[CHAIN_ID_LINEA]: 59144,
	[CHAIN_ID_SONIC]: 146,
};

export const EvmChainIds = [
	CHAIN_ID_ETH,
	CHAIN_ID_BSC,
	CHAIN_ID_AVAX,
	CHAIN_ID_OPTIMISM,
	CHAIN_ID_ARBITRUM,
	CHAIN_ID_POLYGON,
	CHAIN_ID_BASE,
	CHAIN_ID_UNICHAIN,
	CHAIN_ID_LINEA,
	CHAIN_ID_SONIC,
];

export const EvmToWhChainId: { [id: number]: number } = {
	[1]: CHAIN_ID_ETH,
	[56]: CHAIN_ID_BSC,
	[8453]: CHAIN_ID_BASE,
	[43114]: CHAIN_ID_AVAX,
	[10]: CHAIN_ID_OPTIMISM,
	[42161]: CHAIN_ID_ARBITRUM,
	[137]: CHAIN_ID_POLYGON,
	[130]: CHAIN_ID_UNICHAIN,
	[59144]: CHAIN_ID_LINEA,
	[146]: CHAIN_ID_SONIC,
};

export function isEVMChainId(chainId: number): boolean {
	return EvmChainIds.includes(chainId as any);
}

export const chainIDNameMap = {
	1: 'ethereum',
	10: 'optimism',
	56: 'bsc',
	130: 'unichain',
	137: 'polygon',
	42161: 'arbitrum',
	43114: 'avalanche',
	8453: 'base',
	59144: 'linea',
	146: 'sonic',
};

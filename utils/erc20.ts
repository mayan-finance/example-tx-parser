import { ethers } from 'ethers';

const erc20permitAbi = [
	{
		inputs: [
			{
				name: 'owner',
				type: 'address',
			},
		],
		name: 'nonces',
		outputs: [{ name: 'chert', type: 'uint256' }],
		payable: false,
		stateMutability: 'view',
		type: 'function',
	},
];

const erc20NameSymbolAbi = [
	{
		constant: true,
		inputs: [],
		name: 'decimals',
		outputs: [
			{
				name: '',
				type: 'uint8',
			},
		],
		payable: false,
		stateMutability: 'view',
		type: 'function',
	},
	{
		constant: true,
		inputs: [],
		name: 'name',
		outputs: [
			{
				name: '',
				type: 'string',
			},
		],
		payable: false,
		stateMutability: 'view',
		type: 'function',
	},
	{
		constant: true,
		inputs: [],
		name: 'symbol',
		outputs: [
			{
				name: '',
				type: 'string',
			},
		],
		payable: false,
		stateMutability: 'view',
		type: 'function',
	},
];

const erc20BalanceOfAbi = [
	{
		constant: true,
		inputs: [
			{
				name: '_owner',
				type: 'address',
			},
		],
		name: 'balanceOf',
		outputs: [
			{
				name: 'balance',
				type: 'uint256',
			},
		],
		payable: false,
		stateMutability: 'view',
		type: 'function',
	},
];

const erc20AllowanceAbi = [
	{
		constant: true,
		inputs: [
			{
				name: '_owner',
				type: 'address',
			},
			{
				name: '_spender',
				type: 'address',
			},
		],
		name: 'allowance',
		outputs: [
			{
				name: '',
				type: 'uint256',
			},
		],
		payable: false,
		stateMutability: 'view',
		type: 'function',
	},
];

const erc20ApproveAbi = [
	{
		constant: false,
		inputs: [
			{
				name: '_spender',
				type: 'address',
			},
			{
				name: '_value',
				type: 'uint256',
			},
		],
		name: 'approve',
		outputs: [
			{
				name: '',
				type: 'bool',
			},
		],
		payable: false,
		stateMutability: 'nonpayable',
		type: 'function',
	},
];

export async function getErc20Balance(
	evmProvider: ethers.providers.JsonRpcProvider,
	tokenContract: string,
	owner: string,
): Promise<bigint> {
	const contract = new ethers.Contract(tokenContract, erc20BalanceOfAbi, evmProvider);
	const balance: ethers.BigNumber = await contract.balanceOf(owner);

	return balance.toBigInt();
}

export async function getErc20Allowance(
	wallet: ethers.Wallet,
	tokenContract: string,
	owner: string,
	spender: string,
): Promise<bigint> {
	const contract = new ethers.Contract(tokenContract, erc20AllowanceAbi, wallet);
	const balance: ethers.BigNumber = await contract.allowance(owner, spender);
	return balance.toBigInt();
}


export async function getEthBalance(
	evmProvider: ethers.providers.JsonRpcProvider,
	address: string,
): Promise<bigint> {
	const balance: ethers.BigNumber = await evmProvider.getBalance(address);
	return balance.toBigInt();
}

export async function getSymbol(
	evmProvider: ethers.providers.JsonRpcProvider,
	address: string,
): Promise<string> {
	const contract = new ethers.Contract(address, erc20NameSymbolAbi, evmProvider);
	return await contract.symbol();
}

export async function getDecimals(
	evmProvider: ethers.providers.JsonRpcProvider,
	address: string,
): Promise<number> {
	const contract = new ethers.Contract(address, erc20NameSymbolAbi, evmProvider);
	return await contract.decimals();
}

export async function hasPermit(
    evmProvider: ethers.providers.JsonRpcProvider,
    address: string,
): Promise<boolean> {
    const contract = new ethers.Contract(address, erc20permitAbi, evmProvider);
    try {
        await contract.nonces('0x28A328C327307ab1b180327234fDD2a290EFC6DE');
        return true;
    } catch (err) {
        return false;
    }
}
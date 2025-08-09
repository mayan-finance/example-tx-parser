import { Token } from './tokens';

export type Swap = {
	sourceTxBlockNo: number;
	trader: string;
	sourceTxHash: string;
	status: string;
	service: string;
	deadline: Date;
	sourceChain: number;
	destChain: number;
	destAddress: string;
	fromToken: Token;
	fromTokenAddress: string;
	fromTokenSymbol: string;
	fromAmount: string;
	fromAmount64: bigint;
	toToken: Token;
	toTokenAddress: string;
	toTokenSymbol: string;
	toAmount?: string;
	swapRelayerFee: string;
	redeemRelayerFee: string;
	refundRelayerFee: string;
	referrerAddress: string;
	minAmountOut: string;
	minAmountOut64: bigint;
	gasDrop: string;
	gasDrop64: bigint;
	orderHash?: string;
	referrerBps?: number;
	mayanBps?: number;
	transferSequence?: string;
	swapSequence?: string;
	redeemSequence?: string;
	refundSequence?: string;

	fromTokenChain?: number;
	toTokenChain?: number;
	posAddress?: string;

	stateAddr?: string;
	stateNonce?: string;
	auctionAddress?: string;

	transferSignedVaa?: string;
	swapSignedVaa?: string;
	redeemSignedVaa?: string;
	refundSignedVaa?: string;

	payloadId?: number;
	customPayload?: string;

	cctpMessage?: string;
	cctpNonce?: bigint;
	cctpMessageHash?: string;

	forwardedTokenSymbol?: string;
	forwardedTokenAddress?: string;
	forwardedFromAmount?: string;
};

export const SWAP_STATUS = {
	// WH statuses
	INITIATED_ON_EVM: 'INITIATED_ON_EVM',
	TRANSFER_VAA_SIGNED: 'TRANSFER_VAA_SIGNED',
	SWAP_VAA_SIGNED: 'SWAP_VAA_SIGNED',
	SUBMITTED_ON_SOLANA: 'SUBMITTED_ON_SOLANA',
	CLAIMED_ON_SOLANA: 'CLAIMED_ON_SOLANA',
	SWAPPED_ON_SOLANA: 'SWAPPED_ON_SOLANA',
	SETTLED_ON_SOLANA: 'SETTLED_ON_SOLANA',
	REDEEMED_ON_EVM: 'REDEEMED_ON_EVM',
	REFUNDED_ON_EVM: 'REFUNDED_ON_EVM',
	REFUNDED_ON_SOLANA: 'REFUNDED_ON_SOLANA',
	REDEEMED_ON_APTOS: 'REDEEMED_ON_APTOS',

	// MCTP STATUSES
	INITIATED_ON_SUI_MCTP: 'INITIATED_ON_SUI_MCTP',
	INITIATED_ON_EVM_MCTP: 'INITIATED_ON_EVM_MCTP',
	INITIATED_ON_SOLANA_MCTP: 'INITIATED_ON_SOLANA_MCTP',
	SUBMITTED_ON_SOLANA_MCTP: 'SUBMITTED_ON_SOLANA_MCTP',
	CIRCLE_ATTESTATION_ACQUIRED: 'CIRCLE_ATTESTATION_ACQUIRED',

	CLAIMED_ON_SOLANA_MCTP: 'CLAIMED_ON_SOLANA_MCTP',
	SWAPPED_ON_SOLANA_MCTP: 'SWAPPED_ON_SOLANA_MCTP',
	SWAPPED_ON_EVM_MCTP: 'SWAPPED_ON_EVM_MCTP',
	SWAPPED_ON_SUI_MCTP: 'SWAPPED_ON_SUI_MCTP',
	SETTLED_ON_SOLANA_MCTP: 'SETTLED_ON_SOLANA_MCTP',
	REFUNDED_ON_SOLANA_MCTP: 'REFUNDED_ON_SOLANA_MCTP',
	REFUNDED_ON_EVM_MCTP: 'REFUNDED_ON_EVM_MCTP',
	REFUNDED_ON_SUI_MCTP: 'REFUNDED_ON_SUI_MCTP',

	REDEEMED_ON_SUI_WITH_FEE: 'REDEEMED_ON_SUI_WITH_FEE',
	REDEEMED_ON_EVM_WITH_FEE: 'REDEEMED_ON_EVM_WITH_FEE',
	REDEEMED_ON_SOL_WITH_FEE: 'REDEEMED_ON_SOL_WITH_FEE',

	REDEEMED_ON_SUI_WITH_LOCKED_FEE: 'REDEEMED_ON_SUI_WITH_LOCKED_FEE',
	REDEEMED_ON_EVM_WITH_LOCKED_FEE: 'REDEEMED_ON_EVM_WITH_LOCKED_FEE',
	REDEEMED_ON_SOL_WITH_LOCKED_FEE: 'REDEEMED_ON_SOL_WITH_LOCKED_FEE',
	MCTP_FEE_UNLOCKED: 'MCTP_FEE_UNLOCKED',

	// SWIFT statuses
	ORDER_SUBMITTED: 'ORDER_SUBMITTED',
	ORDER_EXPIRED: 'ORDER_EXPIRED',
	ORDER_CREATED: 'ORDER_CREATED',
	ORDER_FULFILLED: 'ORDER_FULFILLED',
	ORDER_SETTLED: 'ORDER_SETTLED',
	ORDER_UNLOCKED: 'ORDER_UNLOCKED',
	ORDER_CANCELED: 'ORDER_CANCELED',
	ORDER_REFUNDED: 'ORDER_REFUNDED',

	// SWAP_LAYER
	SWAP_LAYER_ORDER_CREATED: 'SWAP_LAYER_ORDER_CREATED',
	SWAP_LAYER_ORDER_SETTLED: 'SWAP_LAYER_ORDER_SETTLED',

	// COMMON statuses
	REDEEM_SEQUENCE_RECEIVED: 'REDEEM_SEQUENCE_RECEIVED',
	REFUND_SEQUENCE_RECEIVED: 'REFUND_SEQUENCE_RECEIVED',
	REDEEM_VAA_SIGNED: 'REDEEM_VAA_SIGNED',
	REFUND_VAA_SIGNED: 'REFUND_VAA_SIGNED',
};

export const SERVICE_TYPE = {
	WH_BRIDGE: 'WH_BRIDGE',
	WH_SWAP: 'WH_SWAP',
	SWIFT_NFT: 'SWIFT_NFT',
	SWIFT_SWAP: 'SWIFT_SWAP',
	MCTP_BRIDGE: 'MCTP_BRIDGE',
	MCTP_BRIDGE_WITH_UNLOCK: 'MCTP_BRIDGE_WITH_UNLOCK',
	MCTP_SWAP: 'MCTP_SWAP',
	MCTP_SWAP_WITH_UNLOCK: 'MCTP_SWAP_WITH_UNLOCK',
	WH_LL_SWAP: 'WH_LL_SWAP',
};

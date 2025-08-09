import { PublicKey } from "@solana/web3.js";

export class AuctionState {
	parseWinner(auctionData: Buffer): string {
		return new PublicKey(auctionData.slice(32, 32 + 32)).toString();
	}

	parseAmount(auctionData: Buffer): Number {
		return Number(auctionData.readBigInt64LE(64));
	}

	parseValidFrom(auctionData: Buffer): Date {
		return new Date(Number(auctionData.readBigInt64LE(72)) * 1000);
	}

	parseValidUntil(auctionData: Buffer): Date {
		return new Date(Number(auctionData.readBigInt64LE(80)) * 1000);
	}
}
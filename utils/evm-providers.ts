import { CHAIN_ID_ARBITRUM, CHAIN_ID_AVAX, CHAIN_ID_BASE, CHAIN_ID_BSC, CHAIN_ID_ETH, CHAIN_ID_OPTIMISM, CHAIN_ID_POLYGON, ChainId } from '@certusone/wormhole-sdk';
import { ethers } from 'ethers';



/**
 *
 * @param networkIds[]
 * @param options
 */
export function makeEvmProviders(
   chainIds: ChainId[],
): { [evmNetworkId: number | string]: ethers.providers.JsonRpcProvider } {
   const result: any = {};

   for (const chainId of chainIds) {
      if (chainId === CHAIN_ID_BSC) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.BSC_RPC,
            56,
         );
      } else if (chainId === CHAIN_ID_POLYGON) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.POLYGON_RPC,
            137,
         );
      } else if (chainId === CHAIN_ID_ETH) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.ETHEREUM_RPC,
            1,
         );
      } else if (chainId === CHAIN_ID_AVAX) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.AVALANCHE_RPC,
            43114,
         )
      } else if (chainId === CHAIN_ID_ARBITRUM) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.ARBITRUM_RPC,
            42161,
         )
      } else if (chainId === CHAIN_ID_OPTIMISM) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.OPTIMISM_RPC,
            10,
         )
      } else if (chainId === CHAIN_ID_BASE) {
         result[chainId] = new ethers.providers.StaticJsonRpcProvider(
            process.env.BASE_RPC,
            8453,
         )
      }
   }

   return result;
}
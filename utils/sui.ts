import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';

let suiClient: SuiClient | null = null;

export const getSuiClient = () => {
	if (!suiClient) {
		let endpoint: string = getFullnodeUrl('mainnet');
		if (process.env.SUI_FULLNODE_ENDPOINT) {
			endpoint = process.env.SUI_FULLNODE_ENDPOINT;
		}
		suiClient = new SuiClient({
            url: endpoint,
        });
	}
	return suiClient;
};

export async function readTableRowDynamicField(client: SuiClient, parentId: string, typeName: string, valueName: string): Promise<{
	type: string;
	fields: any;
} | null> {
	const dynamicField = await client.getDynamicFieldObject({
		parentId: parentId,
		name: {
			value: valueName,
			type: typeName,
		},
	});
	if (!dynamicField || !dynamicField.data) {
		return null;
	}

	return (dynamicField.data.content as any).fields.value;
};
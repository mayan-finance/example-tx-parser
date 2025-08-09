import { PartiallyDecodedInstruction } from '@solana/web3.js';
import { base58_to_binary } from 'base58-js';

export class InstructionParserService {
    private readonly programConf: ProgramConf;
    private readonly indexedInstructionNumbers: Set<number>;

    constructor() {
        this.programConf = getProgramConf();
        this.indexedInstructionNumbers = new Set([
            100, 101, 108, 110, 111,
            112, 113, 114, 115, 116,
            120, 121, 122, 123,
        ]);

        // ensure that every instruction number has a default program conf else raise error:
        for (const instructionNumber of this.indexedInstructionNumbers) {
            if (!this.programConf['default'][instructionNumber]) {
                throw new Error(`No default program conf for instruction ${instructionNumber}`);
            }
        }
    }

	parseMayanInstruction(instruction: PartiallyDecodedInstruction): MayanInstruction | null {
		try {
            const programId = instruction.programId.toString();
			const data = base58_to_binary(instruction.data);
			const instructionNumber = data[0];
            if (!this.indexedInstructionNumbers.has(instructionNumber)) {
                return null;
            }

            let instructionConf: InstructionConf;

            if (this.programConf[programId] && this.programConf[programId][instructionNumber]) {
                instructionConf = this.programConf[programId][instructionNumber];
            } else {
                console.warn(`Unknown program instruction. falling back to default instruction parser ${programId} ${instructionNumber}`);
                instructionConf = this.programConf['default'][instructionNumber];
            }

			let agent;
			let stateAddress;
			let stateNonce;
			let meta: any = {};
			let instructionGoal: InstructionGoal;

            if (instructionConf.agentAccountIndex !== -1) {
                agent = instruction.accounts[instructionConf.agentAccountIndex];
            }
            if (instructionConf.stateAccountIndex !== -1) {
                stateAddress = instruction.accounts[instructionConf.stateAccountIndex];
            }
            if (instructionConf.stateNonceIndex !== -1) {
                stateNonce = data[instructionConf.stateNonceIndex];
            }

            if (instructionConf.meta.amountInIndex) {
                meta.amountIn = Buffer.from(data).readBigInt64LE(instructionConf.meta.amountInIndex);
            }

            instructionGoal = instructionConf.goal;                

			return {
				programId: programId,
				stateAddr: stateAddress!.toString(),
				stateNonce,
				agent: agent ? agent.toString() : undefined,
				goal: instructionGoal,
				meta,
			}
		} catch(err) {
			console.error(`parse wh solana instruction failed ${instruction.programId}`);
			throw err;
		}
	}

}

export type MayanInstruction = {
	programId: string,
	agent?: string,
	goal: InstructionGoal,
	stateAddr: string,
	stateNonce: number,
   	meta?: any,
};

export type InstructionGoal = 'REGISTER' | 'SWAP' | 'BRIDGE' | 'SETTLE';

type InstructionConf = {
    agentAccountIndex: number,
    stateAccountIndex: number,
    stateNonceIndex: number,
    meta: {
        amountInIndex?: number,
    },
    goal: InstructionGoal,
};
type ProgramConf = { 
    [programId: string]: {
        [instruction: number]: InstructionConf,
    }
};


function getProgramConf(): ProgramConf {
    return {
        'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf': {
            100: {
                agentAccountIndex: 0,
                stateAccountIndex: 3,
                stateNonceIndex: 1,
                meta: {},
                goal: 'REGISTER',
            },
            101: {
                agentAccountIndex: 14,
                stateAccountIndex: 3,
                stateNonceIndex: 1,
                meta: {
                    amountInIndex: 2,
                },
                goal: 'REGISTER',
            },
            108: {
                agentAccountIndex: 1,
                stateAccountIndex: 0,
                stateNonceIndex: 1,
                meta: {},
                goal: 'SWAP',
            },
            120: {
                agentAccountIndex: 0,
                stateAccountIndex: 1,
                stateNonceIndex: 1,
                meta: {},
                goal: 'BRIDGE',
            },
            121: {
                agentAccountIndex: 0,
                stateAccountIndex: 1,
                stateNonceIndex: 1,
                meta: {},
                goal: 'BRIDGE',
            },
            122: {
                agentAccountIndex: 11,
                stateAccountIndex: 0,
                stateNonceIndex: 1,
                meta: {},
                goal: 'SETTLE',
            },
            123: {
                agentAccountIndex: 11,
                stateAccountIndex: 0,
                stateNonceIndex: 1,
                meta: {},
                goal: 'SETTLE',
            },
        },
        '8LPjGDbxhW4G2Q8S6FvdvUdfGWssgtqmvsc63bwNFA7E': {
            100: {
                agentAccountIndex: 0,
                stateAccountIndex: 3,
                stateNonceIndex: 1,
                meta: {},
                goal: 'REGISTER',
            },
            101: {
                agentAccountIndex: 6,
                stateAccountIndex: 4,
                stateNonceIndex: 2,
                meta: {
                    amountInIndex: 3,
                },
                goal: 'REGISTER',
            },
            108: {
                agentAccountIndex: 2,
                stateAccountIndex: 1,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            120: {
                agentAccountIndex: 0,
                stateAccountIndex: 1,
                stateNonceIndex: 1,
                meta: {},
                goal: 'BRIDGE',
            },
            121: {
                agentAccountIndex: 0,
                stateAccountIndex: 1,
                stateNonceIndex: 1,
                meta: {},
                goal: 'BRIDGE',
            },
            122: {
                agentAccountIndex: 2,
                stateAccountIndex: 1,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SETTLE',
            },
            123: {
                agentAccountIndex: 2,
                stateAccountIndex: 1,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SETTLE',
            },
        },
        'default': {
            100: {
                agentAccountIndex: 0,
                stateAccountIndex: 3,
                stateNonceIndex: 1,
                meta: {},
                goal: 'REGISTER',
            },
            101: {
                agentAccountIndex: 6,
                stateAccountIndex: 4,
                stateNonceIndex: 2,
                meta: {
                    amountInIndex: 3,
                },
                goal: 'REGISTER',
            },
            108: {
                agentAccountIndex: 2,
                stateAccountIndex: 1,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            110: {
                agentAccountIndex: -1,
                stateAccountIndex: 0,
                stateNonceIndex: 1,
                meta: {},
                goal: 'SWAP',
            },
            111: {
                agentAccountIndex: -1,
                stateAccountIndex: 0,
                stateNonceIndex: 1,
                meta: {},
                goal: 'SWAP',
            },
            112: {
                agentAccountIndex: 0,
                stateAccountIndex: 2,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            113: {
                agentAccountIndex: 0,
                stateAccountIndex: 2,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            114: {
                agentAccountIndex: 0,
                stateAccountIndex: 2,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            115: {
                agentAccountIndex: 0,
                stateAccountIndex: 2,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            116: {
                agentAccountIndex: 0,
                stateAccountIndex: 2,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SWAP',
            },
            120: {
                agentAccountIndex: 0,
                stateAccountIndex: 1,
                stateNonceIndex: 1,
                meta: {},
                goal: 'BRIDGE',
            },
            121: {
                agentAccountIndex: 0,
                stateAccountIndex: 1,
                stateNonceIndex: 1,
                meta: {},
                goal: 'BRIDGE',
            },
            122: {
                agentAccountIndex: 2,
                stateAccountIndex: 1,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SETTLE',
            },
            123: {
                agentAccountIndex: 2,
                stateAccountIndex: 1,
                stateNonceIndex: 2,
                meta: {},
                goal: 'SETTLE',
            },
        }
    }
}
import { Blockchain, SandboxContract, TreasuryContract, internal, BlockchainSnapshot, SendMessageResult, defaultConfigSeqno, BlockchainTransaction, printTransactionFees } from '@ton/sandbox';
import { Cell, toNano, beginCell, Address, Transaction, TransactionComputeVm, TransactionStoragePhase, storeAccountStorage, Sender, Dictionary, storeMessage, fromNano, DictionaryValue, storeStateInit } from '@ton/core';
import { jettonContentToCell, JettonMinter, jettonMinterConfigToCell, JettonMinterContent } from '../wrappers/JettonMinter';
import { JettonWallet } from '../wrappers/JettonWallet';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Op, Errors } from '../wrappers/JettonConstants';

let blockchain: Blockchain;
let deployer: SandboxContract<TreasuryContract>;
let user: SandboxContract<TreasuryContract>;
let jettonMinter:SandboxContract<JettonMinter>;
let minter_code: Cell;
let jwallet_code_raw: Cell;
let jwallet_code: Cell;
let userWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;

const capped_supply = 1000n;
const price = toNano('0.01'); // 0.01 TON per a minted token

describe('State init tests', () => {
    beforeAll(async () => {
        blockchain = await Blockchain.create();
        deployer   = await blockchain.treasury('deployer');
        user   = await blockchain.treasury('user');
        jwallet_code_raw = await compile('JettonWallet');
        minter_code    = await compile('JettonMinter');

        //jwallet_code is library
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${jwallet_code_raw.hash().toString('hex')}`), jwallet_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;

        let lib_prep = beginCell().storeUint(2,8).storeBuffer(jwallet_code_raw.hash()).endCell();
        jwallet_code = new Cell({ exotic:true, bits: lib_prep.bits, refs:lib_prep.refs});

        console.log('jetton minter code hash = ', minter_code.hash().toString('hex'));
        console.log('jetton wallet code hash = ', jwallet_code.hash().toString('hex'));

        jettonMinter   = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: deployer.address,
                    wallet_code: jwallet_code,
                    jetton_content: jettonContentToCell({
                        uri: "https://ton.org/"
                    }),
                    capped_supply: capped_supply,
                    price: price
                },
                minter_code));

        userWallet = async (address:Address) => blockchain.openContract(
            JettonWallet.createFromAddress(
                await jettonMinter.getWalletAddress(address)
            )
        );
    });

    it('should deploy', async () => {
        const deployResult = await jettonMinter.sendDeploy(
            deployer.getSender(),
            toNano('10')
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            deploy: true,
        });

        expect(deployResult.transactions).not.toHaveTransaction({
            on: deployer.address,
            from: jettonMinter.address,
            inMessageBounced: true
        });
    });

    it('should mint max jetton walue', async () => {
        const maxValue = (await jettonMinter.getJettonData()).cappedSupply;
        const nonDeployerWallet = await userWallet(user.address);

        const res = await jettonMinter.sendMint(
            user.getSender(),
            user.address,
            maxValue,
            toNano('0.05'),
            toNano('1')
        );

        expect(res.transactions).toHaveTransaction({
            on: nonDeployerWallet.address,
            op: Op.internal_transfer,
            success: true,
            deploy: true
        });

        printTransactionFees(res.transactions);
    });

    it('should not mint more than capped supply', async () => {
        const moreThenMaxValue = (await jettonMinter.getJettonData()).cappedSupply + 1n;

        const res = await jettonMinter.sendMint(
            user.getSender(),
            user.address,
            moreThenMaxValue,
            toNano('0.05'),
            toNano('100')
        );

        expect(res.transactions).toHaveTransaction({
            from: user.address,
            to: jettonMinter.address,
            aborted: true, // High exit codes are considered to be fatal
            exitCode: 256,
        });
    });

    it('should get valid price', async () => {
        const minterPrice = await jettonMinter.getTokenPrice();
        expect(minterPrice).toEqual(price);
    });
});

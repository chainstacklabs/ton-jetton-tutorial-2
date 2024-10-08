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

    it.skip('should mint max supply', async () => {
        // Calculate costs of minting
        const jettonsToPurchase = (await jettonMinter.getSupplyPrice()).cappedSupply;
        const jettonsCost = jettonsToPurchase * price;
        const amountToSend = jettonsCost + toNano('1');  // Assuming 1 TON for storage fees
        const forwardFee = toNano('0.01');
        const expectedMintedJettons = jettonsCost / price;

        // Retrieve initial balance and supply
        const userJettonWallet = await userWallet(user.address);
        const initUserJettonBalance = await userJettonWallet.getJettonBalance();
        const initJettonSupply = (await jettonMinter.getJettonData()).totalSupply;

        // Send the minting message
        const res = await jettonMinter.sendMint(
            user.getSender(),
            user.address,
            forwardFee,
            amountToSend
        );

        // Verify the transaction
        expect(res.transactions).toHaveTransaction({
            on: userJettonWallet.address,
            op: Op.internal_transfer,
            success: true,
            deploy: true
        });

        // Verify that the user's minted jettons match the expected amount
        const currentUserJettonBalance = await userJettonWallet.getJettonBalance();
        const mintedUserJettons = currentUserJettonBalance - initUserJettonBalance;
        expect(mintedUserJettons).toEqual(expectedMintedJettons);

        // Verify that the total supply matches the expected amount of minted jettons
        const updatedTotalSupply = (await jettonMinter.getJettonData()).totalSupply;
        const mintedTotalSupply = updatedTotalSupply - initJettonSupply;
        expect(mintedTotalSupply).toEqual(expectedMintedJettons);
    });

    it('should not mint more than capped supply', async () => {
        // Calculate costs of minting
        const jettonsToPurchase = (await jettonMinter.getSupplyPrice()).cappedSupply + 1n;
        const jettonsCost = jettonsToPurchase * price;
        const amountToSend = jettonsCost + toNano('1');  // Assuming 1 TON for storage fees
        const forwardFee = toNano('0.01');

        // Send the minting message
        const res = await jettonMinter.sendMint(
            user.getSender(),
            user.address,
            forwardFee,
            amountToSend
        );

        // Verify the transaction
        expect(res.transactions).toHaveTransaction({
            from: user.address,
            to: jettonMinter.address,
            aborted: true, // High exit codes are considered to be fatal
            exitCode: 256,
        });
    });

    it('should get valid price', async () => {
        const minterPrice = (await jettonMinter.getSupplyPrice()).price;
        expect(minterPrice).toEqual(price);
    });

    it('should mint correct amount of jettons based on the sent TON amount', async () => {
        // Calculate costs of minting
        const jettonsToPurchase = (await jettonMinter.getSupplyPrice()).cappedSupply;
        const jettonsCost = jettonsToPurchase * price;
        const amountToSend = jettonsCost + toNano('1');  // Assuming 1 TON for storage fees
        const forwardFee = toNano('0.01');
        const expectedMintedJettons = jettonsCost / price;

        // Retrieve initial balance and supply
        const userJettonWallet = await userWallet(user.address);
        const initUserJettonBalance = await userJettonWallet.getJettonBalance();
        const initJettonSupply = (await jettonMinter.getJettonData()).totalSupply;

        // Send the minting message
        const res = await jettonMinter.sendMint(
            user.getSender(),
            user.address,
            forwardFee,
            amountToSend
        );

        // Verify the transaction
        expect(res.transactions).toHaveTransaction({
            on: userJettonWallet.address,
            op: Op.internal_transfer,
            success: true,
            deploy: true
        });

        // Verify that the user's minted jettons match the expected amount
        const currentUserJettonBalance = await userJettonWallet.getJettonBalance();
        const mintedUserJettons = currentUserJettonBalance - initUserJettonBalance;
        expect(mintedUserJettons).toEqual(expectedMintedJettons);

        // Verify that the total supply matches the expected amount of minted jettons
        const updatedTotalSupply = (await jettonMinter.getJettonData()).totalSupply;
        const mintedTotalSupply = updatedTotalSupply - initJettonSupply;
        expect(mintedTotalSupply).toEqual(expectedMintedJettons);

        printTransactionFees(res.transactions);
    });
});

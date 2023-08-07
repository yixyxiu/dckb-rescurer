import { Account, randomSecp256k1Account } from "./account";
import { parseUnit, BI } from "@ckb-lumos/bi"
import { TransactionBuilder } from "./domain_logic";
import { defaultScript, getIndexer, getLiveCell, getNodeUrl, initConfig, initNodeUrl, transferFrom } from "./utils";
import { CellCollector } from "@ckb-lumos/ckb-indexer";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";


async function main() {
    initNodeUrl("http://127.0.0.1:8114/");

    console.log("Initializing Config");
    initConfig();
    console.log("✓");

    // Genesis account of testnet.
    let genesisAccount = randomSecp256k1Account("0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc");

    console.log("Creating new test account:");
    // const account = randomSecp256k1Account();
    const account = randomSecp256k1Account("0x3507a3957681f16395b25a379bf87321c62691b9fe8ede8906ab906a86bb2520");
    console.log(account)
    console.log("✓");

    console.log("Funding test account");
    const fundAccountTxHash = await transferFrom(genesisAccount, account, parseUnit("20000", "ckb"));
    console.log(fundAccountTxHash + " ✓");

    console.log("Creating a deposit");
    const d1TxHash = await deposit(account, parseUnit("10000", "ckb"));
    console.log(d1TxHash + " ✓");


    // console.log("Waiting 120 seconds...");
    // await new Promise(r => setTimeout(r, 120000));
    // console.log("✓");

    console.log("Creating a withdrawal phase one");
    const w1TxHash = await withdraw1(account);
    console.log(w1TxHash + " ✓");

    console.log("Creating a withdrawal phase two");
    const w2TxHash = await withdraw2(account);
    console.log(w2TxHash + " ✓");
}

async function deposit(account: Account, depositAmount: BI) {
    const { txHash } = await (await (await new TransactionBuilder(account).fund()).deposit(depositAmount)).buildAndSend();
    return txHash;
}

async function withdraw1(account: Account) {
    const indexer = getIndexer();
    await indexer.waitForSync();

    const receiptLocks = [account.lockScript, { ...defaultScript("INFO_DAO_LOCK_V2"), args: computeScriptHash(account.lockScript) }]
    for (const lock of receiptLocks) {
        const collector = new CellCollector(indexer, {
            scriptSearchMode: "exact",
            withData: true,
            lock,
            type: defaultScript("DAO_INFO"),
        }, {
            withBlockHash: true,
            ckbRpcUrl: getNodeUrl()
        });

        for await (const receipt of collector.collect()) {
            const deposit = await getLiveCell({ ...receipt.outPoint!, index: "0x0" })
            deposit.blockHash = receipt.blockHash;
            deposit.blockNumber = receipt.blockNumber;

            const { txHash } = await (await new TransactionBuilder(account).fund()).withdrawFrom(deposit, receipt).buildAndSend();
            return txHash
        }
    }

    throw Error("Deposit not found");
}

async function withdraw2(account: Account) {
    const buildWithdrawal2 = async () => await new TransactionBuilder(account).fund();

    let transactionBuilder = await buildWithdrawal2();

    while (!transactionBuilder.hasWithdrawalPhase2()) {
        console.log("Waiting 60 seconds...")
        await new Promise(r => setTimeout(r, 60000));
        transactionBuilder = await buildWithdrawal2();
    }

    const { txHash } = await transactionBuilder.buildAndSend();
    return txHash;
}

main();

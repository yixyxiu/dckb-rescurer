import { Account, randomSecp256k1Account } from "./account";
import { parseUnit, BI } from "@ckb-lumos/bi"
import { TransactionBuilder, ckbSoftCapPerDeposit } from "./domain_logic";
import { createDepGroup, defaultScript, deployCode, getIndexer, getNodeUrl, getRPC, initNodeUrl, setConfig, transferFrom } from "./utils";
import { Cell } from "@ckb-lumos/base";
import { CellCollector } from "@ckb-lumos/ckb-indexer";


async function main() {
    initNodeUrl("http://127.0.0.1:8114/");
    const rpc = getRPC();

    console.log("Initializing Config with devnet data");
    await setConfig();
    console.log("✓");

    // Genesis account.
    let genesisAccount = randomSecp256k1Account("0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc");

    console.log("Creating new test account:");
    const account = randomSecp256k1Account();
    console.log(account)
    console.log("✓");

    console.log("Funding test account");
    const fundAccountTxHash = await transferFrom(genesisAccount, account, parseUnit("10000000", "ckb"));
    console.log(fundAccountTxHash + " ✓");

    console.log("Deploying iCKB code and updating Config");
    const deployCodeTxHash = await deployCode(account);
    console.log(deployCodeTxHash + " ✓");

    console.log("Creating iCKB DepGroup and updating Config");
    const depGroupTxHash = await createDepGroup(account);
    console.log(depGroupTxHash + " ✓");

    console.log("Creating a deposit phase one");
    const header = await rpc.getTipHeader();
    const d1TxHash = await deposit1(account, BI.from(61), ckbSoftCapPerDeposit(header));
    console.log(d1TxHash + " ✓");

    console.log("Creating a deposit phase two");
    const d2TxHash = await deposit2(account);
    console.log(d2TxHash + " ✓");

    console.log("Creating a withdrawal phase one");
    const w1TxHash = await withdraw1(account);
    console.log(w1TxHash + " ✓");

    console.log("Creating a withdrawal phase two");
    const w2TxHash = await withdraw2(account);
    console.log(w2TxHash + " ✓");
}

async function deposit1(account: Account, depositQuantity: BI, depositAmount: BI) {
    const { txHash } = await (await new TransactionBuilder(account).fund()).deposit(depositQuantity, depositAmount).buildAndSend();
    return txHash;
}

async function deposit2(account: Account) {
    let { txHash } = await (await new TransactionBuilder(account).fund()).buildAndSend();
    return txHash;
}

async function withdraw1(account: Account) {
    //Withdraw from all deposit just for demonstration purposes
    const indexer = getIndexer();
    await indexer.waitForSync();
    let deposits: Cell[] = [];
    const collector = new CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        lock: defaultScript("DOMAIN_LOGIC"),
        type: defaultScript("DAO"),
    }, {
        withBlockHash: true,
        ckbRpcUrl: getNodeUrl()
    });
    for await (const cell of collector.collect()) {
        if (cell.data === "0x0000000000000000") {
            deposits.push(cell);
        }
    }

    if (deposits.length == 0) {
        throw Error("Deposits not found");
    }

    const { txHash } = await (await new TransactionBuilder(account).fund()).withdrawFrom(...deposits).buildAndSend();
    return txHash;
}

async function withdraw2(account: Account) {
    const buildWithdrawal2 = async () => await new TransactionBuilder(account).fund();

    let transactionBuilder = await buildWithdrawal2();

    while (!transactionBuilder.hasWithdrawalPhase2()) {
        console.log("Waiting...")
        await new Promise(r => setTimeout(r, 10000));
        transactionBuilder = await buildWithdrawal2();
    }

    const { txHash } = await transactionBuilder.buildAndSend();
    return txHash;
}

async function fundAccount(fromAccount: Account, toAccount: Account) {
    let cell = {
        cellOutput: {
            capacity: parseUnit("10000000", "ckb").toHexString(),
            lock: toAccount.lockScript,
            type: undefined
        },
        data: "0x"
    }
    const { txHash } = await (await new TransactionBuilder(fromAccount).fund()).add("output", "start", cell).buildAndSend();
    return txHash;
}

main();

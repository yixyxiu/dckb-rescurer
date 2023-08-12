import { parseUnit } from "@ckb-lumos/bi"
import { TransactionBuilder } from "./domain_logic";
import { defaultScript, getIndexer, getLiveCell, getNodeUrl } from "./utils";
import { CellCollector } from "@ckb-lumos/ckb-indexer";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { signTransaction } from "./pw_lock_signer";

export async function deposit() {
    const accountLock = defaultScript("PW_LOCK")
    const depositAmount = parseUnit("10000", "ckb");
    const { txHash } = await (await (await new TransactionBuilder(accountLock, signTransaction).fund()).deposit(depositAmount)).buildAndSend();
    return txHash;
}

export async function withdraw1() {
    const accountLock = defaultScript("PW_LOCK");

    const indexer = getIndexer();
    await indexer.waitForSync();

    const receiptLocks = [accountLock, { ...defaultScript("INFO_DAO_LOCK_V2"), args: computeScriptHash(accountLock) }]
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

            const { txHash } = await (await new TransactionBuilder(accountLock, signTransaction).fund()).withdrawFrom(deposit, receipt).buildAndSend();
            return txHash
        }
    }

    throw Error("Deposit not found");
}

export async function withdraw2() {
    const accountLock = defaultScript("PW_LOCK");

    const transactionBuilder = await new TransactionBuilder(accountLock, signTransaction).fund();

    if (!transactionBuilder.hasWithdrawalPhase2()) {
        throw Error("No mature withdrawal request")
    }

    const { txHash } = await transactionBuilder.buildAndSend();
    return txHash;
}

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
    console.log("Deposit TxHash:", txHash);
}

export async function withdrawalRequest() {
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

            if (deposit.data !== "0x0000000000000000") {
                continue;
            }

            const { txHash } = await (await new TransactionBuilder(accountLock, signTransaction).fund())
                .withdrawFrom(deposit, receipt).buildAndSend();

            console.log("Withdrawal Request TxHash:", txHash);
            return;
        }
    }

    throw Error("Deposit not found");
}

export async function withdraw() {
    const accountLock = defaultScript("PW_LOCK");

    const indexer = getIndexer();
    await indexer.waitForSync();

    const collector = new CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        lock: accountLock,
        type: defaultScript("DAO"),
    }, {
        withBlockHash: true,
        ckbRpcUrl: getNodeUrl()
    });

    for await (const withdrawalRequest of collector.collect()) {
        if (withdrawalRequest.data === "0x0000000000000000") {
            continue;
        }

        const { txHash } = await new TransactionBuilder(accountLock, signTransaction)
            .add("input", "start", withdrawalRequest).buildAndSend();

        console.log("Withdrawal TxHash:", txHash);
        return;
    }


    throw Error("Withdrawal request not found");
}

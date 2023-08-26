import React from "react";
import { SWRConfig } from "swr";
import { Cell, Header, Hexadecimal, Script } from "@ckb-lumos/base";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number/uint";
import { BI } from "@ckb-lumos/bi";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { processRPCRequests } from "./rpc_request_batcher";
import { defaultScript } from "./utils";
import { fetcher, mutatorAccumulator, useCollector, useRPC, useRPCImmutable } from "./fetcher";
import { TransactionBuilder } from "./domain_logic";
import { signTransaction } from "./pw_lock_signer";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { encodeToAddress } from "@ckb-lumos/helpers";

export function Body(props: { ethereumAddress: Hexadecimal }) {
    const { ethereumAddress } = props;
    const accountLock = { ...defaultScript("PW_LOCK"), args: ethereumAddress };
    const address = encodeToAddress(accountLock);

    const mutator = mutatorAccumulator();

    const capacityCells = useCollector(mutator, { type: undefined, lock: accountLock, withData: true });
    const sudtCells = useCollector(mutator, { type: defaultScript("SUDT"), lock: accountLock });

    const receiptCells = [
        ...useCollector(mutator, { type: defaultScript("DAO_INFO"), lock: accountLock }),
        ...useCollector(mutator, {
            type: defaultScript("DAO_INFO"),
            lock: { ...defaultScript("INFO_DAO_LOCK_V2"), args: computeScriptHash(accountLock) }
        })
    ];
    const depositCells = receiptCells.map(receipt2Deposit);

    const withdrawalRequestCells = useCollector(mutator, { type: defaultScript("DAO"), lock: accountLock });

    const daoCells = [...depositCells, ...withdrawalRequestCells];
    const headers = useRPCImmutable<Header>("getHeaderByNumber", [...new Set([
        ...daoCells.map(c => c.blockNumber!),
        ...daoCells.map(c => Uint64LE.unpack(c.data).toHexString())
    ])]);
    // const tipHeader = useRPC<Header>(mutator, "getTipHeader");

    const daoCell2Builder = new Map<Cell, TransactionBuilder>();

    for (const i of depositCells.keys()) {
        const deposit = depositCells[i];
        const receipt = receiptCells[i];
        const withdrawal = {
            cellOutput: {
                capacity: deposit.cellOutput.capacity,
                lock: accountLock,
                type: defaultScript("DAO")
            },
            data: hexify(Uint64LE.pack(BI.from(deposit.blockNumber)))
        };
        const builder = new TransactionBuilder(accountLock, signTransaction, headers)
            .add("input", "end", deposit, receipt, ...sudtCells)
            .add("output", "end", withdrawal);

        daoCell2Builder.set(deposit, builder);
    }

    for (const withdrawalRequest of withdrawalRequestCells) {
        const builder = new TransactionBuilder(accountLock, signTransaction, headers)
            .add("input", "end", withdrawalRequest);

        daoCell2Builder.set(withdrawalRequest, builder);
    }

    // TODO: Order Actions by readiness/convenience ///////////////////////////////////////////////////////

    try {
        return (
            <SWRConfig value={{ fetcher }} >
                <h1>dCKB Rescuer</h1>
                <h2>Account information</h2>
                <ul>
                    <li>Ethereum Address: <a href={`https://etherscan.io/address/${ethereumAddress}`}>{ethereumAddress}</a></li>
                    <li>Nervos Address(PW): <a href={`https://explorer.nervos.org/address/${address}`}>{midElide(address, ethereumAddress.length)}</a></li>
                    <li>Available Balance: {ckbBalance(capacityCells)} CKB & {sudtBalance(sudtCells)} dCKB</li>
                    <li>{depositCells.length} Deposits with {ckbBalance([...depositCells, ...receiptCells])}+ CKB locked</li>
                    <li>Amount required to unlock all deposits: {ckbBalance(depositCells)} dCKB</li>
                    <li>{withdrawalRequestCells.length} Pending Withdrawals with {ckbBalance(withdrawalRequestCells)}+ CKB locked</li>
                </ul>
                <h2>Actions</h2>
                <ul>
                    {[...daoCell2Builder.entries()].map(
                        ([c, b]) =>
                            <li key={c.blockNumber!}>
                                <button onClick={async () => { await b.buildAndSend(); mutator() }} >
                                    {c.data === "0x0000000000000000" ?
                                        `Request Withdrawal of ${ckbBalance([c])} CKB Deposit` :
                                        `Complete Withdrawal of ${ckbBalance([c])} CKB Deposit`}
                                </button>
                            </li>
                    )}
                </ul>
            </SWRConfig >
        );
    } finally {
        processRPCRequests();
    }
}

function receipt2Deposit(r: Cell): Cell {
    return {
        blockNumber: r.blockNumber,
        cellOutput: {
            capacity: Uint128LE.unpack(r.data).toHexString(),
            lock: defaultScript("TYPE_LOCK"),
            type: defaultScript("DAO"),
        },
        data: "0x0000000000000000",
        outPoint: {
            index: BI.from(0).toHexString(),
            txHash: r.outPoint!.txHash!,
        },
    };
}

function sudtBalance(cells: Cell[]) {
    let balance = BI.from(0);
    for (const cell of cells) {
        balance = balance.add(Uint128LE.unpack(cell.data));
    }
    return balance.div(10 ** 8).toString();
}

function ckbBalance(cells: Cell[]) {
    let balance = BI.from(0);
    for (const cell of cells) {
        balance = balance.add(cell.cellOutput.capacity);
    }
    return balance.div(10 ** 8).toString();
}

function midElide(s: string, maxLen: number) {
    const hl = Math.floor((maxLen - 3) / 2);
    return `${s.slice(0, hl)}...${s.slice(s.length - hl)}`;
}
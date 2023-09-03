import React from "react";
import useSWRImmutable from 'swr/immutable'
import { Cell, Header, Hexadecimal, Script } from "@ckb-lumos/base";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number/uint";
import { BI, BIish } from "@ckb-lumos/bi";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { encodeToAddress } from "@ckb-lumos/helpers";
import { calculateDaoEarliestSinceCompatible, calculateMaximumWithdrawCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { processRPCRequests } from "./rpc_request_batcher";
import { Epoch, defaultScript, epochCompare, parseEpoch } from "./utils";
import { mutatorAccumulator, useCollector, useRPC } from "./fetcher";
import { TransactionBuilder } from "./domain_logic";
import { signer } from "./pw_lock_signer";

export function Body(props: { ethereumAddress: Hexadecimal }) {
    const { ethereumAddress } = props;
    const accountLock = { ...defaultScript("PW_LOCK"), args: ethereumAddress };
    const address = encodeToAddress(accountLock);

    const mutator = mutatorAccumulator();

    const tipHeader = useRPC<Header>(mutator, "getTipHeader");

    const capacities = useCollector(mutator, { type: undefined, lock: accountLock, withData: true });

    const sudts = useCollector(mutator, { type: defaultScript("SUDT"), lock: accountLock });

    const receipts = [
        ...useCollector(mutator, { type: defaultScript("DAO_INFO"), lock: accountLock }),
        ...useCollector(mutator, {
            type: defaultScript("DAO_INFO"),
            lock: { ...defaultScript("INFO_DAO_LOCK_V2"), args: computeScriptHash(accountLock) }
        })
    ];
    const deposits = receipts.map(receipt2Deposit);

    const withdrawalRequests = useCollector(mutator, { type: defaultScript("DAO"), lock: accountLock });

    const daos = [...deposits, ...withdrawalRequests];

    const actionInfos = [] as {
        type: "request" | "withdrawal";
        value: BI;
        since: Epoch;
        action: () => Promise<void>;
        key: Hexadecimal;
    }[];
    for (const i of Array.from({ length: 1000 }).keys()) {
        const [h1, h2] = (
            i < daos.length ? [
                daos[i].blockNumber!,
                Uint64LE.unpack(daos[i].data).toHexString()
            ].map(b => `rpc/getHeaderByNumber/${b}`) :
                [null, null]
        ).map(
            // eslint-disable-next-line react-hooks/rules-of-hooks
            rpcCalls => useSWRImmutable<Header>(rpcCalls).data
        );

        if (!h1 || !h2) {
            continue;
        }

        if (i < deposits.length) {// Handle withdrawal request action
            const deposit = deposits[i];
            const receipt = receipts[i];
            const withdrawal = {
                cellOutput: {
                    capacity: deposit.cellOutput.capacity,
                    lock: accountLock,
                    type: defaultScript("DAO")
                },
                data: hexify(Uint64LE.pack(BI.from(deposit.blockNumber)))
            };
            const builder = new TransactionBuilder(accountLock, signer, [h1])
                .add("input", "end", deposit, receipt, ...sudts)
                .add("output", "end", withdrawal);

            const value = (
                tipHeader ?
                    calculateMaximumWithdrawCompatible(deposit, h1.dao, tipHeader.dao) :
                    BI.from(deposit.cellOutput.capacity)
            ).add(receipt.cellOutput.capacity);

            const since = parseEpoch(
                tipHeader ?
                    calculateDaoEarliestSinceCompatible(h1.dao, tipHeader.dao) :
                    h2.epoch
            )

            actionInfos.push({
                type: "request",
                value,
                since,
                action: async () => { await builder.buildAndSend(); mutator() },
                key: deposit.outPoint!.txHash,
            });
        } else {// Handle withdrawal action
            const withdrawalRequest = daos[i];
            const builder = new TransactionBuilder(accountLock, signer, [h1, h2])
                .add("input", "end", withdrawalRequest);

            actionInfos.push({
                type: "withdrawal",
                value: calculateMaximumWithdrawCompatible(withdrawalRequest, h2.dao, h1.dao),
                since: parseEpoch(calculateDaoEarliestSinceCompatible(h2.dao, h1.dao)),
                action: async () => { await builder.buildAndSend(); mutator() },
                key: withdrawalRequest.outPoint!.txHash,
            });
        }
    }

    actionInfos.sort((a, b) => epochCompare(a.since, b.since));

    const totalDepositedValue = sum(actionInfos.filter(i => i.type === "request").map(i => i.value));
    const totalWithdrawableValue = sum(actionInfos.filter(i => i.type === "withdrawal").map(i => i.value));

    try {
        return (
            <>
                <h1>dCKB Rescuer</h1>
                <h2>Account information</h2>
                <ul>
                    <li>Ethereum Address: <a href={`https://etherscan.io/address/${ethereumAddress}`}>{ethereumAddress}</a></li>
                    <li>Nervos Address(PW): <a href={`https://explorer.nervos.org/address/${address}`}>{midElide(address, ethereumAddress.length)}</a></li>
                    <li>Available Balance: {display(sum(capacities.map(c => c.cellOutput.capacity)))} CKB
                        & {display(sum(sudts.map(c => Uint128LE.unpack(c.data))))} dCKB</li>
                    <li>{deposits.length} Deposits with {display(totalDepositedValue)} CKB locked</li>
                    <li>Amount required to unlock all deposits: {display(sum(deposits.map(c => c.cellOutput.capacity)))} dCKB</li>
                    <li>{withdrawalRequests.length} Pending Withdrawals with {display(totalWithdrawableValue)} CKB locked</li>
                </ul >
                <h2>Actions</h2>
                <ul>
                    {actionInfos.map(
                        ({ type, value, action, key }) =>
                            <li key={key}>
                                <button onClick={action} >
                                    {type === "request" ?
                                        `Request Withdrawal of ${display(value)} CKB Deposit` :
                                        `Complete Withdrawal of ${display(value)} CKB Deposit`}
                                </button>
                            </li>
                    )}
                </ul>
            </>
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

function midElide(s: string, maxLen: number) {
    const hl = Math.floor((maxLen - 3) / 2);
    return `${s.slice(0, hl)}...${s.slice(s.length - hl)}`;
}

function display(ckbQuantity: BI) {
    return ckbQuantity.div(10 ** 8).toString();
}

function sum(nn: BIish[]) {
    let accumulator = BI.from(0);
    for (const n of nn) {
        accumulator = accumulator.add(n);
    }
    return accumulator;
}
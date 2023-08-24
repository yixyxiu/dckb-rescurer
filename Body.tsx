import React from "react";
import useSWR, { SWRConfig } from "swr";
import useSWRInfinite from 'swr/infinite'
import { Cell, Header, Script } from "@ckb-lumos/base";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number/uint";
import { BI } from "@ckb-lumos/bi";
import { CKBIndexerQueryOptions } from "@ckb-lumos/ckb-indexer/lib/type";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { CellCollector } from "@ckb-lumos/ckb-indexer";
import { processRPCRequests, pushRPCRequest } from "./rpc_request_batcher";
import { defaultScript, getSyncedIndexer } from "./utils";
import { Actions } from "./Actions";

export function Body(props: { accountLock: Script }) {
    const { accountLock } = props;
    const receiptV2Lock = { ...defaultScript("INFO_DAO_LOCK_V2"), args: computeScriptHash(accountLock) };

    const sudtCells = useCollector({ type: defaultScript("SUDT"), lock: accountLock });

    const receiptCells = [
        ...useCollector({ type: defaultScript("DAO_INFO"), lock: accountLock }),
        ...useCollector({ type: defaultScript("DAO_INFO"), lock: receiptV2Lock })
    ];
    const depositCells = receiptCells.map(receipt2Deposit);

    const withdrawalRequestCells = useCollector({ type: defaultScript("DAO"), lock: accountLock });

    const daoCells = [...depositCells, ...withdrawalRequestCells];
    const blockNumbers = [...new Set([
        ...daoCells.map(c => c.blockNumber!),
        ...daoCells.map(c => Uint64LE.unpack(c.data).toHexString())
    ])];
    const headers = useFetchImmutable("rpc", "getHeaderByNumber", blockNumbers) as Header[];

    try {
        return (
            <SWRConfig value={{ fetcher }} >
                <h2>dCKB Status:</h2>
                <ul>
                    <li>Balance: {sudtBalance(sudtCells)} dCKB</li>
                    <li>Deposits: {depositCells.length}</li>
                    <li>Pending Withdrawals: {withdrawalRequestCells.length}</li>
                </ul>
                <Actions
                    accountLock={accountLock}
                    sudtCells={sudtCells}
                    receiptCells={receiptCells}
                    depositCells={depositCells}
                    withdrawalRequestCells={withdrawalRequestCells}
                    headers={headers}
                />
            </SWRConfig >
        );
    } finally {
        processRPCRequests();
    }
}

function useFetchImmutable(source: string, method: string, keys: string[]) {
    const getKey = (i: number) => i < keys.length ? [source, method, keys[i]].join("/") : null;

    const { data, isLoading, error } = useSWRInfinite(getKey, fetcher, {
        initialSize: keys.length,
        revalidateFirstPage: false,
        revalidateIfStale: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        parallel: true
    });

    if (isLoading || error || !Array.isArray(data)) return [];

    return data;
}

function useCollector(query: CKBIndexerQueryOptions): Cell[] {
    const { data, isLoading, error } = useSWR(["collector", JSON.stringify(query)].join("/"), fetcher);

    if (isLoading || error || !Array.isArray(data)) return [];

    return data as Cell[];
}

async function fetcher(key: string) {

    await new Promise(r => setTimeout(r, 1000));

    const [source, ...rest] = key.split('/');
    const data = rest.join('/');
    switch (source) {
        case "rpc":
            return pushRPCRequest(data);
        case "collector":
            return collect(JSON.parse(data));
        default:
            return Error(`Source ${source} not found`);
    }
}

async function collect(query: CKBIndexerQueryOptions) {
    const indexer = await getSyncedIndexer();

    const collector = new CellCollector(indexer, {
        scriptSearchMode: "exact",
        withData: true,
        ...query
    });

    let result: Cell[] = [];
    for await (const cell of collector.collect()) {
        result.push(cell);
    }

    return result;
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
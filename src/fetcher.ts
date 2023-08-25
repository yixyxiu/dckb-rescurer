import useSWR from "swr";
import useSWRInfinite from 'swr/infinite'
import { Cell } from "@ckb-lumos/base";
import { CKBIndexerQueryOptions } from "@ckb-lumos/ckb-indexer/lib/type";
import { CellCollector } from "@ckb-lumos/ckb-indexer";
import { pushRPCRequest } from "./rpc_request_batcher";
import { getSyncedIndexer } from "./utils";

export function mutatorAccumulator() {
    const mutators: (() => void)[] = [];

    return (mutator?: (() => void)) => {
        if (mutator === undefined) {
            mutators.forEach(m => m());
        } else {
            mutators.push(mutator);
        }
    }
}

export function useCollector(mutatorAccumulator: (_: any) => void, query: CKBIndexerQueryOptions) {
    const { data, isLoading, error, mutate } = useSWR(["collector", JSON.stringify(query)].join("/"), fetcher);

    if (isLoading || error || !Array.isArray(data)) {
        return [] as Cell[];
    }

    mutatorAccumulator(mutate);

    return data as Cell[];
}

export function useRPC<T>(mutatorAccumulator: (_: any) => void, ...params: string[]) {
    const { data, isLoading, error, mutate } = useSWR(["rpc", ...params].join("/"), fetcher);

    if (isLoading || error) {
        return undefined;
    }

    mutatorAccumulator(mutate);

    return data as T;
}

export function useRPCImmutable<T>(method: string, keys: string[]) {
    const getKey = (i: number) => i < keys.length ? ["rpc", method, keys[i]].join("/") : null;

    const { data, isLoading, error } = useSWRInfinite(getKey, fetcher, {
        initialSize: keys.length,
        revalidateFirstPage: false,
        revalidateIfStale: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        parallel: true
    });

    if (isLoading || error || !Array.isArray(data)) return <T[]>[];

    return <T[]>data;
}

// Example of use
// <SWRConfig value={{ fetcher }} >
//    ...
// </SWRConfig>
export async function fetcher(key: string) {
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
import React from "react";
import useSWR, { SWRConfig } from "swr";
import { ethereum } from "./pw_lock_signer";
import { Body } from "./Body";
import { fetcher } from "./fetcher";

export function App() {
    const { data: ethereumAddress, error, isLoading, mutate } = useSWR(
        "ethereum/selectedAddress", async () => ethereum.enable().then(() => ethereum.selectedAddress)
    );

    if (!ethereum) return <div>MetaMask doesn't seem to be installed</div>;

    if (isLoading || error || ethereumAddress === undefined) return (
        <button onClick={mutate} disabled={error ? true : false}>
            Connect to MetaMask
        </button>
    );

    return (
        <SWRConfig value={{ fetcher }} >
            <Body ethereumAddress={ethereumAddress} />
        </SWRConfig>
    );
}
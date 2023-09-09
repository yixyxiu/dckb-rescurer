import React from "react";
import useSWR, { SWRConfig } from "swr";
import { ethereum } from "./pw_lock_signer";
import { Body } from "./Body";
import { fetcher } from "./fetcher";

export function App() {
    const { data: ethereumAddress, error, isLoading, mutate } = useSWR(
        "ethereum/selectedAddress", async () => ethereum.enable().then(() => ethereum.selectedAddress)
    );

    if (!ethereum) return (
        <>
            <h1>dCKB Rescuer</h1>
            <p>MetaMask doesn't seem to be installed</p>
        </>
    );

    if (isLoading || error || ethereumAddress === undefined) return (
        <>
            <h1>dCKB Rescuer</h1>
            <p>You want to retrieve your dCKB funds, make Metamask understand that!! 💪</p>
            <button className="fit" onClick={mutate} disabled={error ? true : false}>
                Connect MetaMask to dCKB Rescuer
            </button>
        </>

    );

    return (
        <SWRConfig value={{ fetcher }} >
            <Body ethereumAddress={ethereumAddress} />
        </SWRConfig>
    );
}
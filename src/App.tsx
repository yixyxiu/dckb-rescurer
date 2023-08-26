import React from "react";
import { ethereum } from "./pw_lock_signer";
import useSWR from "swr";
import { Body } from "./Body";

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

    return (<Body ethereumAddress={ethereumAddress} />);
}
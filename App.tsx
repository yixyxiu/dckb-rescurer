import React from "react";
import { ethereum } from "./pw_lock_signer";
import useSWR from "swr";
import { defaultScript } from "./utils";
import { encodeToAddress } from "@ckb-lumos/helpers";
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

    const accountLock = { ...defaultScript("PW_LOCK"), args: ethereumAddress };

    return (
        <>
            <h1>dCKB Rescuer</h1>
            <h2>Account information</h2>
            <ul>
                <li>Ethereum Address: {ethereumAddress}</li>
                <li>Nervos Address(PW): {encodeToAddress(accountLock)}</li>
                <li>
                    Pw lock script:
                    <pre>{JSON.stringify(accountLock, null, 2)}</pre>
                </li>
            </ul>
            <Body accountLock={accountLock} />
        </>
    );
}
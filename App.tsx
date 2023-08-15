import React from "react";
import useSWR from "swr";
import { ethereum } from "./pw_lock_signer";
import { defaultScript } from "./utils";
import { encodeToAddress } from "@ckb-lumos/helpers";
import { deposit, withdrawalRequest, withdraw } from "./high_level";

export function App() {
    const { data: lock, error, isLoading, mutate } = useSWR(
        '/accountLock', async () => ethereum.enable().then(() => defaultScript("PW_LOCK"))
    );

    if (!ethereum) return <div>MetaMask doesn't seem to be installed</div>;

    if (isLoading || error || lock === undefined) return (
        <button onClick={mutate} disabled={error ? true : false}>
            Connect to MetaMask
        </button>
    );

    const address = encodeToAddress(lock);

    return (
        <>
            <h1>dCKB Rescuer</h1>
            <h2>Account information</h2>
            <ul>
                <li>Nervos Address(PW): {address}</li>
                <li>
                    Current Pw lock script:
                    <pre>{JSON.stringify(lock, null, 2)}</pre>
                </li>
            </ul>
            <h2>Actions</h2>
            <ul>
                <li><button onClick={deposit}>Deposit</button></li>
                <li><button onClick={withdrawalRequest}>Request Withdrawal</button></li>
                <li><button onClick={withdraw}>Withdraw</button></li>
            </ul>
        </>
    );
}
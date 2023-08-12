import { default as createKeccak } from "keccak";
import { bytes } from "@ckb-lumos/codec";
import { blockchain } from "@ckb-lumos/base";
import { TransactionSkeletonType, createTransactionFromSkeleton } from "@ckb-lumos/helpers";
import { createP2PKHMessageGroup } from "@ckb-lumos/common-scripts";
import { defaultScript, scriptEq } from "./utils";

interface EthereumRpc {
    (payload: { method: 'personal_sign'; params: [string /*from*/, string /*message*/] }): Promise<string>;
}

export interface EthereumProvider {
    selectedAddress: string;
    isMetaMask?: boolean;
    enable: () => Promise<string[]>;
    addListener: (event: 'accountsChanged', listener: (addresses: string[]) => void) => void;
    removeEventListener: (event: 'accountsChanged', listener: (addresses: string[]) => void) => void;
    request: EthereumRpc;
}

// @ts-ignore
export const ethereum = window.ethereum as EthereumProvider;

export async function signTransaction(transaction: TransactionSkeletonType) {
    const accountLock = defaultScript("PW_LOCK");

    // just like P2PKH: https://github.com/nervosnetwork/ckb-system-scripts/wiki/How-to-sign-transaction
    const keccak = createKeccak("keccak256");

    const messageForSigning = createP2PKHMessageGroup(transaction, [accountLock], {
        hasher: {
            update: (message) => keccak.update(Buffer.from(new Uint8Array(message))),
            digest: () => keccak.digest(),
        },
    })[0];

    let signedMessage = await ethereum.request({
        method: "personal_sign",
        params: [ethereum.selectedAddress, messageForSigning.message],
    });

    let v = Number.parseInt(signedMessage.slice(-2), 16);
    if (v >= 27) v -= 27;
    signedMessage = "0x" + signedMessage.slice(2, -2) + v.toString(16).padStart(2, "0");

    const signedWitness = bytes.hexify(
        blockchain.WitnessArgs.pack({
            lock: signedMessage,
        })
    );

    const index = transaction.inputs.findIndex((c) => scriptEq(c.cellOutput.lock, accountLock))
    transaction = transaction.update("witnesses", (witnesses) => witnesses.set(index, signedWitness));

    return createTransactionFromSkeleton(transaction);
}
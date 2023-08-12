import { RPC } from "@ckb-lumos/rpc";
import { BI, BIish } from "@ckb-lumos/bi"
import { getConfig, initializeConfig } from "@ckb-lumos/config-manager/lib";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { Cell, CellDep, OutPoint, Script, Transaction, blockchain } from "@ckb-lumos/base";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { ethereum } from "./pw_lock_signer";

initializeConfig({
    PREFIX: "ckt",
    SCRIPTS: {
        DAO: {
            CODE_HASH: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
            HASH_TYPE: "type",
            TX_HASH: "0xe2fb199810d49a4d8beec56718ba2593b665db9d52299a0f9e6e75416d73ff5c",
            INDEX: "0x2",
            DEP_TYPE: "code"
        },
        SECP256K1_BLAKE160: {
            CODE_HASH: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
            HASH_TYPE: "type",
            TX_HASH: "0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c",
            INDEX: "0x0",
            DEP_TYPE: "depGroup"
        },
        PW_LOCK: {
            CODE_HASH: "0xbf43c3602455798c1a61a596e0d95278864c552fafe231c063b3fabf97a8febc",
            HASH_TYPE: "type",
            TX_HASH: "0x1d60cb8f4666e039f418ea94730b1a8c5aa0bf2f7781474406387462924d15d4",
            INDEX: "0x0",
            DEP_TYPE: "code"
        },
        SUDT: {
            CODE_HASH: "0x5e7a36a77e68eecc013dfa2fe6a23f3b6c344b04005808694ae6dd45eea4cfd5",
            HASH_TYPE: "type",
            TX_HASH: "0xc7813f6a415144643970c2e88e0bb6ca6a8edc5dd7c1022746f628284a9936d5",
            INDEX: "0x0",
            DEP_TYPE: "code"
        },
        TYPE_LOCK: {
            CODE_HASH: "0x8baa01f58baab0cb58fc319136ea4f6866ed59c323fa94bf7d6b72bea21c74de",
            HASH_TYPE: "data",
            TX_HASH: "0x584ddf4379ae4fc87a435162c77faf9bbd55e5704f7ffbdcfa5052ed81f6770f",
            INDEX: "0x4",
            DEP_TYPE: "code"
        },
        UDT_OWNER: {
            CODE_HASH: "0x29a81473e24924e394a9148ab357c2492fedf65241848b7a87539a7db9c3d43f",
            HASH_TYPE: "data",
            TX_HASH: "0x584ddf4379ae4fc87a435162c77faf9bbd55e5704f7ffbdcfa5052ed81f6770f",
            INDEX: "0x6",
            DEP_TYPE: "code"
        },
        DAO_INFO: {
            CODE_HASH: "0x6fb198a4ef2cc0fa63c2ef7596c169452323d8ce678bdb3f75c77dc1eac2f47f",
            HASH_TYPE: "data",
            TX_HASH: "0x584ddf4379ae4fc87a435162c77faf9bbd55e5704f7ffbdcfa5052ed81f6770f",
            INDEX: "0x9",
            DEP_TYPE: "code"
        },
        INFO_DAO_LOCK_V2: {
            CODE_HASH: "0xe21a856d64d311b2df0a4ecb7dcc66ebebccf5bb623a3031d26bb2455a30a72e",
            HASH_TYPE: "data",
            TX_HASH: "0x91de2edac573fe2b87c4cf081125466e81702c609c5400f3274cba68dda7a58f",
            INDEX: "0x0",
            DEP_TYPE: "code"
        },
    }
});

export function defaultScript(name: string): Script {
    let configData = getConfig().SCRIPTS[name];
    if (!configData) {
        throw Error(name + " not found");
    }

    const s: Script = {
        codeHash: configData.CODE_HASH,
        hashType: configData.HASH_TYPE,
        args: "0x"
    };

    switch (name) {
        case "TYPE_LOCK":
            return { ...s, args: "0x010044adfd493be5af2f53688e814c52595f8675097251d3843ef41ecfcab0000c" };
        case "DAO_INFO":
            return { ...s, args: "0xe3e93d10fd0bf4bcf8da9dec59a51f083521b3e11a10077614b3b53b933792d6" };
        case "UDT_OWNER":
            return { ...s, args: "0xe3e93d10fd0bf4bcf8da9dec59a51f083521b3e11a10077614b3b53b933792d60f000000" };
        case "SUDT":
            return { ...s, args: computeScriptHash(defaultScript("UDT_OWNER")) };
        case "PW_LOCK":
            return { ...s, args: ethereum.selectedAddress };
        default:
            return s;
    }
}

export function getNodeUrl() {
    return "http://127.0.0.1:8114/";
}

export function getRPC() {
    return new RPC(getNodeUrl(), { timeout: 10000 });
}

export function getIndexer() {
    return new Indexer(getNodeUrl());
}

export async function getLiveCell(outPoint: OutPoint) {
    const rpc = getRPC();
    const res = await rpc.getLiveCell(outPoint, true);

    if (res.status !== "live")
        throw new Error(`Live cell not found at out point: ${outPoint.txHash}-${outPoint.index}`);

    return <Cell>{
        cellOutput: res.cell.output,
        outPoint,
        data: res.cell.data.content,
    }
}

export function scriptEq(s0: Script | undefined, s1: Script | undefined) {
    if (!s0 && !s1) {
        throw Error("Comparing two undefined Scripts")
    }
    if (!s0 || !s1) {
        return false;
    }
    return s0.codeHash === s1.codeHash &&
        s0.hashType === s1.hashType &&
        s0.args === s1.args;
}

export function parseEpoch(epoch: BIish) {
    const _epoch = BI.from(epoch);
    return {
        length: _epoch.shr(40).and(0xfff),
        index: _epoch.shr(24).and(0xfff),
        number: _epoch.and(0xffffff),
    };
}

export function calculateFee(transaction: Transaction, feeRate: BIish): BI {
    const serializedTx = blockchain.Transaction.pack(transaction);
    // 4 is serialized offset bytesize;
    const size = serializedTx.byteLength + 4;

    const ratio = BI.from(1000);
    const base = BI.from(size).mul(feeRate);
    const fee = base.div(ratio);
    if (fee.mul(ratio).lt(base)) {
        return fee.add(1);
    }
    return fee;
}

export function defaultCellDeps(name: string): CellDep {
    let configData = getConfig().SCRIPTS[name];
    if (!configData) {
        throw Error(name + " not found");
    }

    return {
        outPoint: {
            txHash: configData.TX_HASH,
            index: configData.INDEX,
        },
        depType: configData.DEP_TYPE,
    };
}
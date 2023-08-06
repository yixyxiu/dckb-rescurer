import { Account } from "./account";
import { TransactionBuilder } from "./domain_logic";

import { RPC } from "@ckb-lumos/rpc";
import { BI, BIish, parseUnit } from "@ckb-lumos/bi"
import { ScriptConfigs, getConfig, initializeConfig, } from "@ckb-lumos/config-manager/lib";
import { ckbHash, computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { Cell, Hexadecimal, OutPoint, Script, Transaction, blockchain } from "@ckb-lumos/base";
import { readFile, readdir } from "fs/promises";
import { PathLike } from "fs";
import { Indexer } from "@ckb-lumos/ckb-indexer";
import { vector } from "@ckb-lumos/codec/lib/molecule";


let _nodeUrl: string | undefined;

export function initNodeUrl(nodeUrl: string) {
    if (_nodeUrl) {
        throw Error("Node URL already initialized");
    }
    _nodeUrl = nodeUrl;
}

export function getNodeUrl() {
    if (!_nodeUrl) {
        throw Error("Node URL yet to be initialized");
    }
    return _nodeUrl;
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
    const blockHash = (await rpc.getTransactionProof([outPoint.txHash])).blockHash;
    const blockNumber = (await rpc.getBlock(blockHash)).header.number

    if (res.status !== "live")
        throw new Error(`Live cell not found at out point: ${outPoint.txHash}-${outPoint.index}`);

    return <Cell>{
        cellOutput: res.cell.output,
        outPoint,
        data: res.cell.data.content,
        blockHash,
        blockNumber
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

export async function readFileToHexString(filename: PathLike) {
    const data = await readFile(filename);
    const dataSize = data.length;
    const hexString = "0x" + data.toString("hex");

    return { hexString, dataSize };
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

export function defaultScript(name: string): Script {
    let scriptConfigData = getConfig().SCRIPTS[name];
    if (!scriptConfigData) {
        throw Error(name + " not found");
    }

    return {
        codeHash: scriptConfigData.CODE_HASH,
        hashType: scriptConfigData.HASH_TYPE,
        args: "0x"
    };
}

export function ickbSudtScript(): Script {
    let SUDT = getConfig().SCRIPTS.SUDT!;
    let ickbDomainLogic = getConfig().SCRIPTS.DOMAIN_LOGIC;
    if (!ickbDomainLogic) {
        throw Error(name + " not found");
    }
    return {
        codeHash: SUDT.CODE_HASH,
        hashType: SUDT.HASH_TYPE,
        args: computeScriptHash(
            {
                codeHash: ickbDomainLogic.CODE_HASH,
                hashType: ickbDomainLogic.HASH_TYPE,
                args: "0x"
            }
        )
    }
}

export async function transferFrom(from: Account, to: Account, amount: BI) {
    let cell = {
        cellOutput: {
            capacity: amount.toHexString(),
            lock: to.lockScript,
            type: undefined
        },
        data: "0x"
    }
    const { txHash } = await (await new TransactionBuilder(from).fund()).add("output", "start", cell).buildAndSend();
    return txHash;
}

const BINARIES_FILEPATH = "./files/";

async function getLocalScriptNames() {
    return (await readdir(BINARIES_FILEPATH)).sort();
}

async function getGenesisBlock() {
    return getRPC().getBlockByNumber("0x0");
}

export async function deployCode(account: Account) {
    const cells: Cell[] = [];
    for (const scriptName of await getLocalScriptNames()) {
        const { hexString: hexString1, dataSize: dataSize1 } = await readFileToHexString(BINARIES_FILEPATH + scriptName);
        const output1: Cell = {
            cellOutput: {
                capacity: parseUnit((41 + dataSize1).toString(), "ckb").toHexString(),
                lock: defaultScript("SECP256K1_BLAKE160"),///////////////////////////////////////////////
                type: undefined
            },
            data: hexString1
        };
        cells.push(output1);
    }

    const { txHash } = await (await new TransactionBuilder(account).fund()).add("output", "start", ...cells).buildAndSend();

    const name2PartialScriptConfig: { [id: string]: PartialScriptConfig | undefined } = {};
    for (const scriptName of await getLocalScriptNames()) {
        name2PartialScriptConfig[scriptName.toUpperCase()] = {
            TX_HASH: txHash,
            INDEX: BI.from(Object.getOwnPropertyNames(name2PartialScriptConfig).length).toHexString(),
            DEP_TYPE: "code",
        };
    }
    await setConfig(name2PartialScriptConfig);

    return txHash;
}

export async function createDepGroup(account: Account) {
    const genesisBlock = await getGenesisBlock();
    const localScriptNames = await getLocalScriptNames();
    const config = getConfig();
    const outPoints: OutPoint[] = [
        ...Array.from(
            { length: 3 },//SECP256K1_BLAKE160_SIGHASH_ALL, DAO, SECP256K1_DATA
            (_, i) => {
                return {
                    txHash: genesisBlock.transactions[0].hash!,
                    index: BI.from(i + 1).toHexString(),
                }
            },
        ),
        ...Array.from(
            { length: localScriptNames.length },
            (_, i) => {
                const scriptConfig = config.SCRIPTS[localScriptNames[i].toUpperCase()]!;
                return {
                    txHash: scriptConfig.TX_HASH,
                    index: scriptConfig.INDEX
                }
            },
        ),
    ];

    let packedOutPoints = vector(blockchain.OutPoint).pack(outPoints);
    let hexOutPoints = "0x" + Buffer.from(packedOutPoints).toString('hex');
    const cell: Cell = {
        cellOutput: {
            capacity: parseUnit((41 + hexOutPoints.length / 2 - 1).toString(), "ckb").toHexString(),
            lock: defaultScript("SECP256K1_BLAKE160"),
            type: undefined
        },
        data: hexOutPoints
    };

    const { txHash } = await (await new TransactionBuilder(account).fund()).add("output", "start", cell).buildAndSend();

    const name2PartialScriptConfig: { [id: string]: PartialScriptConfig | undefined } = {};
    for (const scriptName of Object.getOwnPropertyNames(config.SCRIPTS)) {
        name2PartialScriptConfig[scriptName] = {
            TX_HASH: txHash,
            INDEX: BI.from(0).toHexString(),
            DEP_TYPE: "depGroup",
        };
    }
    await setConfig(name2PartialScriptConfig);

    return txHash;
}

interface PartialScriptConfig {
    TX_HASH: Hexadecimal
    INDEX: Hexadecimal
    DEP_TYPE: "depGroup" | "code"
};

export async function setConfig(name2PartialScriptConfig: {
    [id: string]: PartialScriptConfig | undefined
} = {}) {
    const genesisBlock = await getGenesisBlock();

    const scriptConfigs: ScriptConfigs = {
        SECP256K1_BLAKE160: {
            CODE_HASH: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
            HASH_TYPE: "type",
            TX_HASH: genesisBlock.transactions[1].hash!,
            INDEX: "0x0",
            DEP_TYPE: "depGroup",
            ...name2PartialScriptConfig["SECP256K1_BLAKE160"],
        },
        DAO: {
            CODE_HASH: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
            HASH_TYPE: "type",
            TX_HASH: genesisBlock.transactions[0].hash!,
            INDEX: "0x2",
            DEP_TYPE: "code",
            ...name2PartialScriptConfig["DAO"],
        }
    }

    for (const scriptName of await getLocalScriptNames()) {
        scriptConfigs[scriptName.toUpperCase()] = {
            CODE_HASH: ckbHash(await readFile(BINARIES_FILEPATH + scriptName)),
            HASH_TYPE: scriptName == "sudt" ? "data" : "data1",
            TX_HASH: genesisBlock.transactions[0].hash!,//Dummy value
            INDEX: "0x42",//Dummy value
            DEP_TYPE: "code",
            ...name2PartialScriptConfig[scriptName.toUpperCase()],
        };
    }

    initializeConfig({
        PREFIX: "ckt",
        SCRIPTS: scriptConfigs
    });

    // console.log("Config initialized to:");
    // console.log(getConfig());
}
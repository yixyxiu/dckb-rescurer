
import { Account } from "./account";
import { calculateFee, defaultScript, getIndexer, getNodeUrl, getRPC, ickbSudtScript, parseEpoch, scriptEq } from "./utils";
import { secp256k1Blake160 } from "@ckb-lumos/common-scripts";
import { RPC } from "@ckb-lumos/rpc";
import { BI, parseUnit } from "@ckb-lumos/bi"
import { TransactionSkeleton, TransactionSkeletonType, minimalCellCapacityCompatible, sealTransaction } from "@ckb-lumos/helpers";
import { key } from "@ckb-lumos/hd";
import { getConfig } from "@ckb-lumos/config-manager/lib";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { bytes } from "@ckb-lumos/codec";
import { Cell, Header, Hexadecimal, Transaction, WitnessArgs, blockchain } from "@ckb-lumos/base";
import { CellCollector, Indexer } from "@ckb-lumos/ckb-indexer";
import { CKBIndexerQueryOptions } from "@ckb-lumos/ckb-indexer/lib/type";
import { calculateDaoEarliestSinceCompatible, calculateMaximumWithdrawCompatible, extractDaoDataCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { Uint128LE, Uint32LE, Uint64LE } from "@ckb-lumos/codec/lib/number/uint";
import { hexify } from "@ckb-lumos/codec/lib/bytes";
import { createUintBICodec } from "./uint";
import { struct } from "@ckb-lumos/codec/lib/molecule";

export class TransactionBuilder {
    #account: Account;

    #indexer: Indexer;
    #rpc: RPC;
    #blockNumber2BlockHash: { [id: Hexadecimal]: Hexadecimal; };
    #blockHash2Header: { [id: Hexadecimal]: Header; };

    #inputs: Cell[];
    #outputs: Cell[];

    constructor(account: Account) {
        this.#account = account;

        this.#indexer = getIndexer();
        this.#rpc = getRPC();

        this.#blockNumber2BlockHash = {};
        this.#blockHash2Header = {};

        this.#inputs = [];
        this.#outputs = [];
    }

    async fund() {
        const capacityCells = await this.#collect({ type: "empty", withData: false });
        const sudtCells = await this.#collect({ type: ickbSudtScript() });
        this.add("input", "end", ...capacityCells, ...sudtCells);

        const ickbDomainLogicScript = defaultScript("DOMAIN_LOGIC")

        const receiptCells = await this.#collect({ type: ickbDomainLogicScript });
        const ownerLockCells = await this.#collect({ lock: ickbDomainLogicScript, type: "empty", withData: false });//////////////////
        if (receiptCells.length > 0 && ownerLockCells.length > 0) {
            this.add("input", "end", ...receiptCells, ...ownerLockCells);
        }
        if (ownerLockCells.length == 0 || receiptCells.length > 0) {
            this.add("output", "end", {
                cellOutput: {
                    capacity: parseUnit("41", "ckb").toHexString(),
                    lock: ickbDomainLogicScript,
                    type: undefined//use SECP256K1_BLAKE160?/////////////////////////////////////////////////////////
                },
                data: "0x"
            });
        }

        const unlockableWithdrawedDaoCells: Cell[] = [];
        const currentEpoch = parseEpoch((await this.#rpc.getTipHeader()).epoch);
        const ownerOwnedScript = defaultScript("OWNER_OWNED");
        for (const ownerOwnedCell of await this.#collect({ type: ownerOwnedScript })) {
            let withdrawalRequests: Cell[] = [];
            for (const c of await this.#collect({
                lock: ownerOwnedScript,
                type: defaultScript("DAO"),
                fromBlock: ownerOwnedCell.blockNumber,
                toBlock: ownerOwnedCell.blockNumber,
            })) {
                if (c.data === "0x0000000000000000") {
                    continue;
                }

                if (c.outPoint!.txHash != ownerOwnedCell.outPoint!.txHash) {
                    continue;
                }

                const unlockEpoch = parseEpoch(await this.#withdrawedDaoSince(c));

                if (currentEpoch.number.lt(unlockEpoch.number) || currentEpoch.index.mul(unlockEpoch.length).lt(unlockEpoch.index.mul(currentEpoch.length))) {
                    //Due to owner owned script either all or none can be unlocked
                    withdrawalRequests = [];
                    break
                }

                withdrawalRequests.push(c);
            }
            unlockableWithdrawedDaoCells.push(ownerOwnedCell, ...withdrawalRequests);
        }
        this.add("input", "end", ...unlockableWithdrawedDaoCells);

        return this;
    }
    async #collect(query: CKBIndexerQueryOptions) {
        await this.#indexer.waitForSync();
        let result: Cell[] = [];
        const collector = new CellCollector(this.#indexer, {
            scriptSearchMode: "exact",
            withData: true,
            lock: this.#account.lockScript,
            ...query
        }, {
            withBlockHash: true,
            ckbRpcUrl: getNodeUrl()
        });
        for await (const cell of collector.collect()) {
            result.push(cell);
        }

        return result;
    }

    add(source: "input" | "output", position: "start" | "end", ...cells: Cell[]) {
        if (source === "input") {
            if (position === "start") {
                this.#inputs.unshift(...cells);
            } else {
                this.#inputs.push(...cells);
            }

            if (this.#inputs.some((c) => !c.blockHash || !c.blockNumber)) {
                throw Error("All input cells must have both blockHash and blockNumber populated");
            }
        } else {
            if (position === "start") {
                this.#outputs.unshift(...cells);
            } else {
                this.#outputs.push(...cells);
            }
        }

        return this;
    }


    deposit(depositQuantity: BI, depositAmount: BI) {
        if (depositQuantity.gt(61)) {
            throw Error(`depositQuantity is ${depositQuantity}, but should be less than 62`);
        }

        // Create depositQuantity deposits of occupied capacity + depositAmount.
        const deposit = {
            cellOutput: {
                capacity: parseUnit("82", "ckb").add(depositAmount).toHexString(),
                lock: defaultScript("DOMAIN_LOGIC"),
                type: defaultScript("DAO"),
            },
            data: hexify(Uint64LE.pack(0))
        };

        // Create a receipt cell for depositQuantity deposits of depositAmount + occupied capacity.
        const receipt = {
            cellOutput: {
                capacity: parseUnit("102", "ckb").toHexString(),
                lock: this.#account.lockScript,
                type: defaultScript("DOMAIN_LOGIC")
            },

            data: hexify(ReceiptCodec.pack({ depositQuantity, depositAmount }))
        };

        return this.add("output", "end", ...Array.from({ length: depositQuantity.toNumber() }, () => deposit), receipt);
    }

    withdrawFrom(...deposits: Cell[]) {
        const dao = defaultScript("DAO");
        const ownerOwnedScript = defaultScript("OWNER_OWNED");
        const withdrawals: Cell[] = [];
        for (const deposit of deposits) {
            const withdrawal = {
                cellOutput: {
                    capacity: deposit.cellOutput.capacity,
                    lock: ownerOwnedScript,
                    type: dao
                },
                data: hexify(Uint64LE.pack(BI.from(deposit.blockNumber)))
            };
            withdrawals.push(withdrawal);
        }

        const ownerOwnedCell = {
            cellOutput: {
                capacity: parseUnit("98", "ckb").toHexString(),
                lock: this.#account.lockScript,
                type: ownerOwnedScript,
            },
            data: hexify(Uint32LE.pack(BI.from(deposits.length)))
        };

        return this.add("input", "start", ...deposits)
            .add("output", "start", ...withdrawals)
            .add("output", "end", ownerOwnedCell);
    }

    hasWithdrawalPhase2() {
        const daoType = defaultScript("DAO");

        for (const c of this.#inputs) {
            //Second Withdrawal step from NervosDAO
            if (scriptEq(c.cellOutput.type, daoType) && c.data !== "0x0000000000000000") {
                return true;
            }
        }

        return false
    }

    async buildAndSend(feeRate: BI = BI.from(1000)) {
        const ckbDelta = await this.getCkbDelta();
        const fee = calculateFee((await this.#buildWithChange(ckbDelta)).signedTransaction, feeRate);

        const { transaction, signedTransaction } = await this.#buildWithChange(ckbDelta.sub(fee));

        const txHash = await sendTransaction(signedTransaction, this.#rpc);

        return { transaction, fee, signedTransaction, txHash }
    }

    async #buildWithChange(ckbDelta: BI) {
        const ickbDelta = await this.getIckbDelta();

        const changeCells: Cell[] = [];
        if (ckbDelta.eq(0) && ickbDelta.eq(0)) {
            //Do nothing
        } else if (ckbDelta.gte(parseUnit("62", "ckb")) && ickbDelta.eq(0)) {
            changeCells.push({
                cellOutput: {
                    capacity: ckbDelta.toHexString(),
                    lock: this.#account.lockScript,
                    type: undefined,
                },
                data: "0x"
            });
        } else if (ckbDelta.gte(parseUnit("142", "ckb")) && ickbDelta.gt(0)) {
            changeCells.push({
                cellOutput: {
                    capacity: ckbDelta.toHexString(),
                    lock: this.#account.lockScript,
                    type: ickbSudtScript()
                },
                data: hexify(Uint128LE.pack(ickbDelta))
            });
        } else {
            throw Error("Not enough funds to execute the transaction");
        }

        let transaction = TransactionSkeleton();
        transaction = transaction.update("inputs", (i) => i.push(...this.#inputs));
        transaction = transaction.update("outputs", (o) => o.push(...this.#outputs, ...changeCells));

        transaction = addCellDeps(transaction);

        transaction = await addHeaderDeps(transaction, async (blockNumber: string) => this.#getBlockHash(blockNumber));

        transaction = await addInputSinces(transaction, async (c: Cell) => this.#withdrawedDaoSince(c));

        transaction = await addWitnessPlaceholders(transaction, async (blockNumber: string) => this.#getBlockHash(blockNumber));

        const signedTransaction = signTransaction(transaction, this.#account.privKey);

        return { transaction, signedTransaction };
    }

    async getCkbDelta() {
        const daoType = defaultScript("DAO");

        let ckbDelta = BI.from(0);
        for (const c of this.#inputs) {
            //Second Withdrawal step from NervosDAO
            if (scriptEq(c.cellOutput.type, daoType) && c.data !== "0x0000000000000000") {
                const depositHeader = await this.#getHeaderByNumber(Uint64LE.unpack(c.data).toHexString());
                const withdrawalHeader = await this.#getHeader(c);
                const maxWithdrawable = calculateMaximumWithdrawCompatible(c, depositHeader.dao, withdrawalHeader.dao)
                ckbDelta = ckbDelta.add(maxWithdrawable);
            } else {
                ckbDelta = ckbDelta.add(c.cellOutput.capacity);
            }
        }

        this.#outputs.forEach((c) => ckbDelta = ckbDelta.sub(c.cellOutput.capacity));

        return ckbDelta;
    }

    async getIckbDelta() {
        const daoType = defaultScript("DAO");
        const ickbDomainLogicType = defaultScript("DOMAIN_LOGIC");
        const ickbSudtType = ickbSudtScript();

        let ickbDelta = BI.from(0);
        for (const c of this.#inputs) {
            //iCKB token
            if (scriptEq(c.cellOutput.type, ickbSudtType)) {
                ickbDelta = ickbDelta.add(Uint128LE.unpack(c.data));
                continue;
            }

            //Withdrawal from iCKB pool of NervosDAO deposits
            if (scriptEq(c.cellOutput.type, daoType) &&
                scriptEq(c.cellOutput.lock, ickbDomainLogicType) &&
                c.data === "0x0000000000000000") {
                const header = await this.#getHeader(c);
                const ckbUnoccupiedCapacity = BI.from(c.cellOutput.capacity).sub(minimalCellCapacityCompatible(c));
                ickbDelta = ickbDelta.sub(ickbValue(ckbUnoccupiedCapacity, header));
                continue;
            }

            //iCKB Receipt
            if (scriptEq(c.cellOutput.type, ickbDomainLogicType)) {
                const header = await this.#getHeader(c);
                const { depositQuantity, depositAmount } = ReceiptCodec.unpack(c.data);
                ickbDelta = ickbDelta.add(receiptIckbValue(depositQuantity, depositAmount, header));
            }
        }

        for (const c of this.#outputs) {
            //iCKB token
            if (scriptEq(c.cellOutput.type, ickbSudtType)) {
                ickbDelta = ickbDelta.sub(Uint128LE.unpack(c.data));
            }
        }

        return ickbDelta;
    }

    async #withdrawedDaoSince(c: Cell) {
        if (!scriptEq(c.cellOutput.type, defaultScript("DAO")) || c.data === "0x0000000000000000") {
            throw Error("Not a withdrawed dao cell")
        }

        const withdrawalHeader = await this.#getHeader(c);
        const depositHeader = await this.#getHeaderByNumber(Uint64LE.unpack(c.data).toHexString());

        return calculateDaoEarliestSinceCompatible(depositHeader.epoch, withdrawalHeader.epoch);
    }

    async #getHeader(c: Cell) {
        if (!c.blockHash || !c.blockNumber) {
            throw Error("Cell must have both blockHash and blockNumber populated");
        }

        this.#blockNumber2BlockHash[c.blockNumber] = c.blockHash;

        return this.#getHeaderByNumber(c.blockNumber);
    }

    async #getHeaderByNumber(blockNumber: Hexadecimal) {
        const blockHash = await this.#getBlockHash(blockNumber);

        let header = this.#blockHash2Header[blockHash];

        if (!header) {
            header = await this.#rpc.getHeader(blockHash);
            this.#blockHash2Header[blockHash] = header;
            if (!header) {
                throw Error("Header not found from blockHash " + blockHash);
            }
        }

        return header;
    }

    async #getBlockHash(blockNumber: Hexadecimal) {
        let blockHash = this.#blockNumber2BlockHash[blockNumber];
        if (!blockHash) {
            blockHash = await this.#rpc.getBlockHash(blockNumber);
            this.#blockNumber2BlockHash[blockNumber] = blockHash;
            if (!blockHash) {
                throw Error("Block hash not found from blockNumber " + blockNumber);
            }
        }

        return blockHash;
    }
}

const ReceiptCodec = struct(
    {
        depositQuantity: createUintBICodec(2, true),
        depositAmount: createUintBICodec(6, true),
    },
    ["depositQuantity", "depositAmount"]
);


export const AR_0 = BI.from("10000000000000000");
export const ICKB_SOFT_CAP_PER_DEPOSIT = parseUnit("100000", "ckb");

export function ickbValue(ckbUnoccupiedCapacity: BI, header: Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    let ickbAmount = ckbUnoccupiedCapacity.mul(AR_0).div(AR_m);
    if (ICKB_SOFT_CAP_PER_DEPOSIT.lt(ickbAmount)) {
        // Apply a 10% discount for the amount exceeding the soft iCKB cap per deposit.
        ickbAmount = ickbAmount.sub(ickbAmount.sub(ICKB_SOFT_CAP_PER_DEPOSIT).div(10));
    }

    return ickbAmount;
}

export function receiptIckbValue(receiptCount: BI, receiptAmount: BI, header: Header) {
    return receiptCount.mul(ickbValue(receiptAmount, header));
}

export function ckbSoftCapPerDeposit(header: Header) {
    const daoData = extractDaoDataCompatible(header.dao);
    const AR_m = daoData["ar"];

    return ICKB_SOFT_CAP_PER_DEPOSIT.mul(AR_m).div(AR_0).add(1);
}

function addCellDeps(transaction: TransactionSkeletonType) {
    if (transaction.cellDeps.size !== 0) {
        throw new Error("This function can only be used on an empty cell deps structure.");
    }

    let secp256k1_blake160 = getConfig().SCRIPTS.SECP256K1_BLAKE160!;
    if (!secp256k1_blake160) {
        throw Error("SECP256K1_BLAKE160 not found")
    }

    return transaction.update("cellDeps", (cellDeps) =>
        cellDeps.push({
            outPoint: {
                txHash: secp256k1_blake160.TX_HASH,
                index: secp256k1_blake160.INDEX,
            },
            depType: secp256k1_blake160.DEP_TYPE,
        })
    );
}

async function addHeaderDeps(transaction: TransactionSkeletonType, blockNumber2BlockHash: (h: Hexadecimal) => Promise<Hexadecimal>) {
    if (transaction.headerDeps.size !== 0) {
        throw new Error("This function can only be used on an empty header deps structure.");
    }

    const daoType = defaultScript("DAO");
    const ickbDomainLogicType = defaultScript("DOMAIN_LOGIC");
    const uniqueBlockHashes: Set<string> = new Set();
    for (const c of transaction.inputs) {
        if (!c.blockHash || !c.blockNumber) {
            throw Error("Cell must have both blockHash and blockNumber populated");
        }

        if (scriptEq(c.cellOutput.type, daoType)) {
            uniqueBlockHashes.add(c.blockHash);
            if (c.data !== "0x0000000000000000") {
                uniqueBlockHashes.add(await blockNumber2BlockHash(Uint64LE.unpack(c.data).toHexString()));
            }
            continue;
        }

        if (scriptEq(c.cellOutput.type, ickbDomainLogicType)) {
            uniqueBlockHashes.add(c.blockHash);
        }
    }

    transaction = transaction.update("headerDeps", (h) => h.push(...uniqueBlockHashes.keys()));

    return transaction;
}

async function addInputSinces(transaction: TransactionSkeletonType, withdrawedDaoSince: (c: Cell) => Promise<BI>) {
    if (transaction.inputSinces.size !== 0) {
        throw new Error("This function can only be used on an empty input sinces structure.");
    }

    const daoType = defaultScript("DAO");
    for (const [index, c] of transaction.inputs.entries()) {
        if (scriptEq(c.cellOutput.type, daoType) && c.data !== "0x0000000000000000") {
            const since = await withdrawedDaoSince(c);
            transaction = transaction.update("inputSinces", (inputSinces) => {
                return inputSinces.set(index, since.toHexString());
            });
        }
    }

    return transaction;
}

async function addWitnessPlaceholders(transaction: TransactionSkeletonType, blockNumber2BlockHash: (h: Hexadecimal) => Promise<Hexadecimal>) {
    if (transaction.witnesses.size !== 0) {
        throw new Error("This function can only be used on an empty witnesses structure.");
    }

    const daoType = defaultScript("DAO");
    const secp256k1Blake160Lock = defaultScript("SECP256K1_BLAKE160");
    const uniqueLocks: Set<string> = new Set();
    for (const c of transaction.inputs) {
        const witnessArgs: WitnessArgs = { lock: "0x" };

        const lockHash = computeScriptHash(c.cellOutput.lock);
        if (!uniqueLocks.has(lockHash)) {
            uniqueLocks.add(lockHash);

            if (c.cellOutput.lock.codeHash == secp256k1Blake160Lock.codeHash &&
                c.cellOutput.lock.hashType == secp256k1Blake160Lock.hashType) {
                witnessArgs.lock = "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
            }
        }

        if (scriptEq(c.cellOutput.type, daoType) && c.data !== "0x0000000000000000") {
            const blockHash = await blockNumber2BlockHash(Uint64LE.unpack(c.data).toHexString());
            const headerDepIndex = transaction.headerDeps.findIndex((v) => v == blockHash);
            if (headerDepIndex === -1) {
                throw Error("Block hash not found in Header Dependencies")
            }
            witnessArgs.inputType = bytes.hexify(Uint64LE.pack(headerDepIndex));
        }

        const packedWitness = bytes.hexify(blockchain.WitnessArgs.pack(witnessArgs));
        transaction = transaction.update("witnesses", (w) => w.push(packedWitness));
    }

    return transaction;
}

function signTransaction(transaction: TransactionSkeletonType, PRIVATE_KEY: string) {
    transaction = secp256k1Blake160.prepareSigningEntries(transaction);
    const message = transaction.get("signingEntries").get(0)?.message;
    const Sig = key.signRecoverable(message!, PRIVATE_KEY);
    const tx = sealTransaction(transaction, [Sig]);

    return tx;
}

async function sendTransaction(signedTransaction: Transaction, rpc: RPC) {
    //Send the transaction
    const txHash = await rpc.sendTransaction(signedTransaction);

    //Wait until the transaction is committed
    for (let i = 0; i < 120; i++) {
        let transactionData = await rpc.getTransaction(txHash);
        switch (transactionData.txStatus.status) {
            case "committed":
                return txHash;
            case "pending":
            case "proposed":
                await new Promise(r => setTimeout(r, 1000));
                break;
            default:
                throw new Error("Unexpected transaction state: " + transactionData.txStatus.status);
        }
    }

    throw new Error("Transaction timed out.");
}
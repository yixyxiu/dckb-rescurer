
import { Account } from "./account";
import { calculateFee, defaultCellDeps, defaultScript, getIndexer, getNodeUrl, getRPC, parseEpoch, scriptEq } from "./utils";
import { secp256k1Blake160 } from "@ckb-lumos/common-scripts";
import { RPC } from "@ckb-lumos/rpc";
import { BI, parseUnit } from "@ckb-lumos/bi"
import { TransactionSkeleton, TransactionSkeletonType, minimalCellCapacityCompatible, sealTransaction } from "@ckb-lumos/helpers";
import { key } from "@ckb-lumos/hd";
import { computeScriptHash } from "@ckb-lumos/base/lib/utils";
import { bytes } from "@ckb-lumos/codec";
import { Cell, Header, Hexadecimal, Transaction, WitnessArgs, blockchain } from "@ckb-lumos/base";
import { CellCollector, Indexer } from "@ckb-lumos/ckb-indexer";
import { CKBIndexerQueryOptions } from "@ckb-lumos/ckb-indexer/lib/type";
import { calculateDaoEarliestSinceCompatible, calculateMaximumWithdrawCompatible } from "@ckb-lumos/common-scripts/lib/dao";
import { Uint128LE, Uint64LE } from "@ckb-lumos/codec/lib/number/uint";
import { hexify } from "@ckb-lumos/codec/lib/bytes";

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
        const sudtCells = await this.#collect({ type: defaultScript("SUDT") });
        this.add("input", "end", ...capacityCells, ...sudtCells);

        const unlockableWithdrawedDaoCells: Cell[] = [];
        const currentEpoch = parseEpoch((await this.#rpc.getTipHeader()).epoch);
        for (const c of await this.#collect({ type: defaultScript("DAO") })) {
            if (c.data === "0x0000000000000000") {
                continue;
            }

            const unlockEpoch = parseEpoch(await this.#withdrawedDaoSince(c));

            // console.log(
            //     "Epoch diff:", (unlockEpoch.number).sub(currentEpoch.number).toString(),
            //     "Fract diff:", (currentEpoch.index.mul(unlockEpoch.length).sub(currentEpoch.index.mul(unlockEpoch.length))).toString()
            // );

            if (currentEpoch.number.lt(unlockEpoch.number)) {
                continue;
            }

            if (currentEpoch.index.mul(unlockEpoch.length).lt(currentEpoch.index.mul(unlockEpoch.length))) {
                continue;
            }

            unlockableWithdrawedDaoCells.push(c);
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

    async deposit(depositAmount: BI) {
        const deposit = {
            cellOutput: {
                capacity: depositAmount.toHexString(),
                lock: defaultScript("TYPE_LOCK"),
                type: defaultScript("DAO"),
            },
            data: hexify(Uint64LE.pack(0))
        };

        if (depositAmount.lt(minimalCellCapacityCompatible(deposit))) {
            throw Error(`depositAmount is ${depositAmount}, but should be more than ${minimalCellCapacityCompatible(deposit)}`);
        }

        const receipt = {
            cellOutput: {
                capacity: "0x42",
                // lock: this.#account.lockScript,
                lock: { ...defaultScript("INFO_DAO_LOCK_V2"), args: computeScriptHash(this.#account.lockScript) },
                type: defaultScript("DAO_INFO")
            },

            data: hexify(Uint128LE.pack(depositAmount))
        };

        receipt.cellOutput.capacity = minimalCellCapacityCompatible(receipt).toHexString();

        const publicOwnerLockCell = (await this.#collect({ lock: defaultScript("UDT_OWNER"), type: "empty", withData: false }))[0];
        const clonedPublicOwnerLockCell: Cell = JSON.parse(JSON.stringify(publicOwnerLockCell));

        return this.add("output", "start", receipt)
            .add("output", "start", deposit)
            .add("input", "end", publicOwnerLockCell)
            .add("output", "end", clonedPublicOwnerLockCell);
    }

    withdrawFrom(deposit: Cell, receipt: Cell) {
        const withdrawal = {
            cellOutput: {
                capacity: deposit.cellOutput.capacity,
                lock: this.#account.lockScript,
                type: defaultScript("DAO")
            },
            data: hexify(Uint64LE.pack(BI.from(deposit.blockNumber)))
        };


        return this.add("input", "start", receipt)
            .add("input", "start", deposit)
            .add("output", "start", withdrawal);
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
        const dckbDelta = await this.getDckbDelta();

        const changeCells: Cell[] = [];
        if (ckbDelta.eq(0) && dckbDelta.eq(0)) {
            //Do nothing
        } else if (ckbDelta.gte(parseUnit("62", "ckb")) && dckbDelta.eq(0)) {
            changeCells.push({
                cellOutput: {
                    capacity: ckbDelta.toHexString(),
                    lock: this.#account.lockScript,
                    type: undefined,
                },
                data: "0x"
            });
        } else if (ckbDelta.gte(parseUnit("142", "ckb")) && dckbDelta.gt(0)) {
            changeCells.push({
                cellOutput: {
                    capacity: ckbDelta.toHexString(),
                    lock: this.#account.lockScript,
                    type: defaultScript("SUDT")
                },
                data: hexify(Uint128LE.pack(dckbDelta))
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

    async getDckbDelta() {
        const daoType = defaultScript("DAO");
        const dckbSudtType = defaultScript("SUDT");

        let dckbDelta = BI.from(0);
        for (const c of this.#inputs) {
            //dCKB token
            if (scriptEq(c.cellOutput.type, dckbSudtType)) {
                dckbDelta = dckbDelta.add(Uint128LE.unpack(c.data));
                continue;
            }

            //Withdrawal from dCKB NervosDAO deposit
            if (scriptEq(c.cellOutput.type, daoType) &&
                c.data === "0x0000000000000000") {
                dckbDelta = dckbDelta.sub(c.cellOutput.capacity);
            }
        }

        for (const c of this.#outputs) {
            //dCKB token
            if (scriptEq(c.cellOutput.type, dckbSudtType)) {
                dckbDelta = dckbDelta.sub(Uint128LE.unpack(c.data));
                continue;
            }

            //Withdrawal from dCKB NervosDAO deposit
            if (scriptEq(c.cellOutput.type, daoType) &&
                c.data === "0x0000000000000000") {
                dckbDelta = dckbDelta.add(c.cellOutput.capacity);
            }
        }

        return dckbDelta;
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

function addCellDeps(transaction: TransactionSkeletonType) {
    if (transaction.cellDeps.size !== 0) {
        throw new Error("This function can only be used on an empty cell deps structure.");
    }

    return transaction.update("cellDeps", (cellDeps) =>
        cellDeps.push(
            defaultCellDeps("DAO"),
            defaultCellDeps("SECP256K1_BLAKE160"),
            defaultCellDeps("PWLOCK_K1_ACPL"),
            defaultCellDeps("SUDT"),
            defaultCellDeps("TYPE_LOCK"),
            defaultCellDeps("UDT_OWNER"),
            defaultCellDeps("DAO_INFO"),
            defaultCellDeps("INFO_DAO_LOCK_V2"),
            // Maybe understand how to handle better cellDeps instead of just copy-pasting from old transactions
            {
                outPoint: {
                    txHash: "0xe36d354a032cdef4545ed36ca169ef08486c1c33e22b1e44f7fc973652c3903b",
                    index: "0x0"
                },
                depType: "code"
            },
            {
                outPoint: {
                    txHash: "0x04ff66eba4cfdae192899b19dec38ef3d89528e180c76c7d74bbb06266d53fc1",
                    index: "0x0"
                },
                depType: "code"
            },
            {
                outPoint: {
                    txHash: "0x5f17a2cab83d4a4cef08818e7592598de9b937829dcb0fd209af908093b523a0",
                    index: "0x0"
                },
                depType: "code"
            },
            {
                outPoint: {
                    txHash: "0xd51bcd4d170a9c2ea20d38fdd65994ae5cef7cb928aadacc6beafccc336bf7c4",
                    index: "0x0"
                },
                depType: "code"
            },
        )
    );
}

async function addHeaderDeps(transaction: TransactionSkeletonType, blockNumber2BlockHash: (h: Hexadecimal) => Promise<Hexadecimal>) {
    if (transaction.headerDeps.size !== 0) {
        throw new Error("This function can only be used on an empty header deps structure.");
    }

    const daoType = defaultScript("DAO");
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
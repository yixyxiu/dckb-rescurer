import React from "react";
import { Cell, Header, Script } from "@ckb-lumos/base";

export function Actions(props: {
    accountLock: Script,
    sudtCells: Cell[],
    receiptCells: Cell[],
    depositCells: Cell[],
    withdrawalRequestCells: Cell[],
    headers: Header[],
}) {
    const { accountLock, sudtCells, receiptCells, depositCells, withdrawalRequestCells, headers } = props;

    return (
        <>
            <h2>Deposit Cells</h2>
            <ul>{depositCells.map((d) => <li key={d.blockNumber}> {JSON.stringify(d, null, 2)} </li>)}</ul >
            <h2>Pending Withdrawals Cells</h2>
            <ul>{withdrawalRequestCells.map((w) => <li key={w.blockNumber}> {JSON.stringify(w, null, 2)} </li>)}</ul >
            <h2>Headers</h2>
            <ul>{headers.map((h) => <li key={h.hash}> {JSON.stringify(h, null, 2)} </li>)}</ul >
        </>
    );
}



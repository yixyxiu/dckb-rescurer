import { getRPC } from "./utils";
import { Mutex } from "./mutex";

export async function pushRPCRequest(key: string) {
    return new Promise((resolve, reject) =>
        fetcherGlobalState.update(async (requests) => {
            //Set delayed executor for new batch request
            if (requests.size == 0) {
                setTimeout(processRPCRequests, 50);
            }

            let callbacks = requests.get(key) || [];
            callbacks = [...callbacks, { resolve, reject }];
            return requests.set(key, callbacks);
        })
    );
}

type Callback = {
    resolve: (x: unknown) => void;
    reject: (x: unknown) => void;
}

const fetcherGlobalState = new Mutex(new Map<string, Callback[]>());

// try {
//     ...
// } finally {
//     processRPCRequests();
// }

export function processRPCRequests() {
    fetcherGlobalState.update(async (_requests) => {
        if (_requests.size > 0) {
            _processRPCRequests(_requests);
        }
        return new Map();
    });
}

async function _processRPCRequests(requests: Map<string, Callback[]>) {
    const batch = getRPC().createBatchRequest();
    for (const k of requests.keys()) {
        batch.add(...k.split('/'));
    }

    try {
        const results = await (batch.exec() as Promise<any[]>);
        const allCallbacks = [...requests.values()];
        for (const i of results.keys()) {
            const res = results[i];
            for (const callback of allCallbacks[i]) {
                callback.resolve(res);
            }
        }
    } catch (error) {
        for (const callbacks of requests.values()) {
            for (const callback of callbacks) {
                callback.reject(error);
            }
        }
    }
}
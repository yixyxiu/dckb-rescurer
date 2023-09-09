/* Hacked together based on:
 * https://spin.atomicobject.com/2018/09/10/javascript-concurrency/
 */


export class Mutex<D> {
    #mutex: Promise<void>;
    #data: D;

    constructor(data: D) {
        this.#mutex = Promise.resolve();
        this.#data = data;
    }

    #lock(): PromiseLike<() => void> {
        let begin: (unlock: () => void) => void = unlock => { };

        this.#mutex = this.#mutex.then(() => {
            return new Promise(begin);
        });

        return new Promise(res => {
            begin = res;
        });
    }

    async update(fn: (data: D) => PromiseLike<D>) {
        const unlock = await this.#lock();
        try {
            this.#data = await fn(this.#data);
        } finally {
            unlock();
        }
    }
}

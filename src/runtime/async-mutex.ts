export class AsyncMutex {
    private tail: Promise<void> = Promise.resolve();
    async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
        let release!: () => void;
        const prev = this.tail;
        this.tail = new Promise<void>((r) => (release = r));
        await prev;
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
}

/**
 * Async mutex for serializing store operations.
 * Prevents race conditions when timer tick and API calls
 * attempt to read/write the store concurrently.
 */
export class AsyncLock {
  private queue: Array<() => void> = [];
  private locked = false;

  public async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  public release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  public async run<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

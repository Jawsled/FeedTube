import { sleep } from '../utils';

export class RateLimiter {
  private queue: Array<() => void> = [];
  private active = 0;
  private lastStart = 0;

  constructor(
    public concurrency: number,
    public minDelayMs: number,
    public jitterMs: number,
    private signal?: AbortSignal,
  ) {}

  async run<T>(fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await this.acquire();
    try {
      const wait =
        Math.max(0, this.lastStart + this.minDelayMs - Date.now()) + Math.random() * this.jitterMs;
      if (wait > 0) {
        await sleep(wait, this.signal);
      }
      this.lastStart = Date.now();
      return await fn(this.signal);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const entry = () => {
        this.signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

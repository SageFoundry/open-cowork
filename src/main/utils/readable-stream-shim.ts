import { Readable } from 'stream';
import { log } from './logger';

type WebReaderResult = { done: boolean; value?: Uint8Array };

type MinimalWebReader = {
  read: () => Promise<WebReaderResult>;
  releaseLock: () => void;
  cancel: () => Promise<void>;
};

type ReadableWithOptionalGetReader = Readable & {
  getReader?: () => MinimalWebReader;
};

let installed = false;

export function installNodeReadableGetReaderShim(): void {
  if (installed) {
    return;
  }
  installed = true;

  const prototype = Readable.prototype as ReadableWithOptionalGetReader;
  if (typeof prototype.getReader === 'function') {
    return;
  }

  prototype.getReader = function getReader(this: Readable): MinimalWebReader {
    const stream = this;
    const iterator = this[Symbol.asyncIterator]();
    return {
      async read(): Promise<WebReaderResult> {
        const next = await iterator.next();
        if (next.done) {
          return { done: true };
        }
        const value = next.value;
        if (value instanceof Uint8Array) {
          return { done: false, value };
        }
        if (typeof value === 'string') {
          return { done: false, value: Buffer.from(value) };
        }
        return { done: false, value: Buffer.from(value) };
      },
      releaseLock(): void {
        // Node streams do not have lock ownership. This exists for Web Stream compatibility.
      },
      async cancel(): Promise<void> {
        if (typeof iterator.return === 'function') {
          await iterator.return();
        }
        stream.destroy();
      },
    };
  };

  log('[ReadableStreamShim] Installed Node Readable.getReader compatibility shim');
}

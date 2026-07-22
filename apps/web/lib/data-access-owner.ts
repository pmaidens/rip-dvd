export type DataAccessShutdownSignal = "SIGINT" | "SIGTERM";

export interface DataAccessLifecycleHost {
  once(signal: DataAccessShutdownSignal, listener: () => void): void;
  off(signal: DataAccessShutdownSignal, listener: () => void): void;
  terminate(signal: DataAccessShutdownSignal): void;
}

export interface DataAccessOwner<T> {
  get(): T;
  dispose(): void;
}

export function createDataAccessOwner<T extends { close(): void }>(
  open: () => T,
  host: DataAccessLifecycleHost,
): DataAccessOwner<T> {
  let access: T | undefined;
  let disposed = false;
  const signals: DataAccessShutdownSignal[] = ["SIGINT", "SIGTERM"];
  const shutdownListeners = new Map<DataAccessShutdownSignal, () => void>();

  const owner: DataAccessOwner<T> = {
    get() {
      if (disposed) {
        throw new Error("Data access owner is disposed");
      }
      access ??= open();
      return access;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const signal of signals) {
        const listener = shutdownListeners.get(signal);
        if (listener) {
          host.off(signal, listener);
        }
      }
      access?.close();
      access = undefined;
    },
  };

  for (const signal of signals) {
    const listener = () => {
      owner.dispose();
      host.terminate(signal);
    };
    shutdownListeners.set(signal, listener);
    host.once(signal, listener);
  }

  return owner;
}

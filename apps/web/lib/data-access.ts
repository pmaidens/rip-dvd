import { loadConfig } from "@rip-dvd/config";
import { createDataAccess, type DataAccess } from "@rip-dvd/data-access";

import {
  createDataAccessOwner,
  type DataAccessOwner,
} from "./data-access-owner";

interface HotModule {
  hot?: {
    dispose(listener: () => void): void;
  };
}

declare const module: HotModule | undefined;

const dataAccessOwnerKey = Symbol.for("rip-dvd.web.data-access-owner");
const ownerRegistry = globalThis as unknown as {
  [key: symbol]: DataAccessOwner<DataAccess> | undefined;
};

const owner =
  ownerRegistry[dataAccessOwnerKey] ??
  createDataAccessOwner(
    () =>
      createDataAccess({
        databasePath: loadConfig().databasePath,
      }),
    {
      once: (signal, listener) => process.once(signal, listener),
      off: (signal, listener) => process.off(signal, listener),
      terminate: (signal) => process.kill(process.pid, signal),
    },
  );

ownerRegistry[dataAccessOwnerKey] = owner;

if (typeof module !== "undefined" && module.hot) {
  module.hot.dispose(() => {
    owner.dispose();
    if (ownerRegistry[dataAccessOwnerKey] === owner) {
      delete ownerRegistry[dataAccessOwnerKey];
    }
  });
}

export function getDataAccess(): DataAccess {
  return owner.get();
}

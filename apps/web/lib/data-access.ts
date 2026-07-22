import { loadConfig } from "@rip-dvd/config";
import { createDataAccess, type DataAccess } from "@rip-dvd/data-access";

let sharedDataAccess: DataAccess | undefined;

export function getDataAccess(): DataAccess {
  sharedDataAccess ??= createDataAccess({
    databasePath: loadConfig().databasePath,
  });
  return sharedDataAccess;
}

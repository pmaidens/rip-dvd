import { parentPort, workerData } from "node:worker_threads";

import { createDataAccess } from "../dist/index.js";

const access = createDataAccess({ databasePath: workerData.databasePath });
const claim = access.archiveJobs.claimNext(workerData.workerId);
parentPort.postMessage(
  claim === null
    ? null
    : { id: claim.id, claimToken: claim.claimToken },
);
// Deliberately omit access.close(): the worker disappears while it owns the
// running claim, matching an archive process lost between polls.
parentPort.close();

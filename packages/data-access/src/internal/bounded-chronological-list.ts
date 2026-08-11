import { DomainInvariantError } from "../errors.js";
import type {
  ChronologicalListOptions,
  JobStatus,
} from "../types.js";
import { requirePositiveSafeInteger } from "./validation.js";

interface ChronologicalRecord {
  id: string;
}

export function createBoundedChronologicalList<
  RecordType extends ChronologicalRecord,
  Status extends string,
  Options extends ChronologicalListOptions,
>({
  activeStatuses,
  historyStatuses,
  chronologicalAt,
  readAll,
  readNewest,
}: {
  activeStatuses: Status[];
  historyStatuses: Status[];
  chronologicalAt(record: RecordType): Date;
  readAll(
    statuses: Status[] | undefined,
    options: Options | undefined,
  ): RecordType[];
  readNewest(
    statuses: Status[] | undefined,
    limit: number,
    options: Options | undefined,
  ): RecordType[];
}) {
  const chronological = (rows: RecordType[]) =>
    rows.sort(
      (left, right) =>
        chronologicalAt(left).getTime() - chronologicalAt(right).getTime() ||
        left.id.localeCompare(right.id),
    );

  return (statuses?: Status[], options?: Options): RecordType[] => {
    const policy = options?.policy;
    if (policy?.mode === "active-and-history") {
      if (statuses !== undefined) {
        throw new DomainInvariantError(
          "active-and-history list policy cannot be combined with explicit statuses",
        );
      }
      const active = readNewest(
        activeStatuses,
        requirePositiveSafeInteger(policy.activeLimit, "activeLimit"),
        options,
      );
      const history = readNewest(
        historyStatuses,
        requirePositiveSafeInteger(policy.historyLimit, "historyLimit"),
        options,
      );
      return chronological([...active, ...history]);
    }
    if (policy?.mode === "newest") {
      return chronological(
        readNewest(
          statuses,
          requirePositiveSafeInteger(policy.limit, "limit"),
          options,
        ),
      );
    }
    return readAll(statuses, options);
  };
}

export function createJobList<
  Job extends ChronologicalRecord & { updatedAt: Date },
>({
  readQueue,
  readNewest,
}: {
  readQueue(statuses?: JobStatus[]): Job[];
  readNewest(statuses: JobStatus[] | undefined, limit: number): Job[];
}) {
  return createBoundedChronologicalList<
    Job,
    JobStatus,
    ChronologicalListOptions
  >({
    activeStatuses: ["queued", "running"],
    historyStatuses: ["completed", "failed"],
    chronologicalAt: (job) => job.updatedAt,
    readAll: (statuses) => readQueue(statuses),
    readNewest: (statuses, limit) => readNewest(statuses, limit),
  });
}

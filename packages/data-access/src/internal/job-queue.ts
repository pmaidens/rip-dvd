import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  StaleJobAttemptError,
} from "../errors.js";
import type { ChronologicalListOptions, JobStatus } from "../types.js";
import { requireNonEmpty } from "./validation.js";

const PROGRESS_WRITE_INTERVAL_MS = 1_000;
const PROGRESS_WRITE_DELTA = 5;

export interface JobRecord<Id extends string, Token extends string> {
  id: Id;
  status: JobStatus;
  progressPercent: number;
  claimToken: Token | null;
  updatedAt: Date;
}

export type RunningJob<
  Job extends JobRecord<Id, Token>,
  Id extends string,
  Token extends string,
> = Job & { status: "running"; claimToken: Token };

export interface AttemptUpdate {
  status?: "running" | "completed" | "failed";
  progressPercent?: number;
  completedAt?: Date | null;
  errorMessage?: string | null;
  updatedAt: Date;
}

export interface RequeueUpdate {
  status: "queued";
  progressPercent: 0;
  claimToken: null;
  claimedBy: null;
  claimedAt: null;
  startedAt: null;
  completedAt: null;
  errorMessage: null;
  updatedAt: Date;
}

export interface JobQueueAdapter<
  Job extends JobRecord<Id, Token>,
  Running extends RunningJob<Job, Id, Token>,
  Id extends string,
  Token extends string,
  Completion,
  RequeueOptions,
  ClaimOptions,
  ProgressDetails = never,
  FailureOptions = never,
> {
  readonly recordType: string;
  find(id: Id): Job | undefined;
  list(statuses?: Job["status"][], options?: ChronologicalListOptions): Job[];
  claim(
    workerId: string,
    token: Token,
    timestamp: Date,
    options?: ClaimOptions,
  ): Running | undefined;
  updateAttempt(
    claim: Running,
    update: AttemptUpdate,
    completion?: Completion,
    failureOptions?: FailureOptions,
  ): Job | undefined;
  updateProgressAttempt?(
    claim: Running,
    update: AttemptUpdate,
    details: ProgressDetails,
    failureOptions?: FailureOptions,
  ): Job | undefined;
  progressDetailsChanged?(
    current: ProgressDetails | undefined,
    previous: ProgressDetails | undefined,
  ): boolean;
  isAttemptCurrent?(current: Job, claim: Running, timestamp: Date): boolean;
  requeue(
    id: Id,
    expectedStatus: Job["status"],
    current: Job,
    update: RequeueUpdate,
    options?: RequeueOptions,
  ): Job | undefined;
}

export interface JobQueueController<
  Job extends JobRecord<Id, Token>,
  Running extends RunningJob<Job, Id, Token>,
  Id extends string,
  Token extends string,
  Completion,
  RequeueOptions,
  ClaimOptions,
  ProgressDetails = never,
  FailureOptions = never,
> {
  claimNext(workerId: string, options?: ClaimOptions): Running | null;
  list(statuses?: Job["status"][], options?: ChronologicalListOptions): Job[];
  updateProgress(
    claim: Running,
    progressPercent: number,
    details?: ProgressDetails,
  ): Job;
  complete(claim: Running, completion: Completion): Job;
  fail(claim: Running, errorMessage: string, options?: FailureOptions): Job;
  requeue(id: Id, options?: RequeueOptions): Job;
}

function requireProgress(progressPercent: number): number {
  if (
    !Number.isInteger(progressPercent) ||
    progressPercent < 0 ||
    progressPercent > 100
  ) {
    throw new DomainInvariantError(
      "progressPercent must be an integer between 0 and 100",
    );
  }
  return progressPercent;
}

export function createJobQueueController<
  Job extends JobRecord<Id, Token>,
  Running extends RunningJob<Job, Id, Token>,
  Id extends string,
  Token extends string,
  Completion,
  RequeueOptions,
  ClaimOptions,
  ProgressDetails = never,
  FailureOptions = never,
>({
  adapter,
  createToken,
  now,
  requeueFrom,
}: {
  adapter: JobQueueAdapter<
    Job,
    Running,
    Id,
    Token,
    Completion,
    RequeueOptions,
    ClaimOptions,
    ProgressDetails,
    FailureOptions
  >;
  createToken(): Token;
  now(): Date;
  requeueFrom: readonly Job["status"][];
}): JobQueueController<
  Job,
  Running,
  Id,
  Token,
  Completion,
  RequeueOptions,
  ClaimOptions,
  ProgressDetails,
  FailureOptions
> {
  const progress = new Map<
    Id,
    {
      token: Token;
      latest: number;
      lastPersisted: number;
      lastPersistedAt: number;
      latestDetails: ProgressDetails | undefined;
      lastPersistedDetails: ProgressDetails | undefined;
    }
  >();

  function requireRecord(id: Id): Job {
    const job = adapter.find(id);
    if (!job) {
      throw new RecordNotFoundError(adapter.recordType, id);
    }
    return job;
  }

  function requireActiveAttempt(claim: Running): Job {
    const current = requireRecord(claim.id);
    const timestamp = now();
    if (
      current.status !== "running" ||
      current.claimToken !== claim.claimToken ||
      (adapter.isAttemptCurrent?.(current, claim, timestamp) ?? true) === false
    ) {
      throw new StaleJobAttemptError(adapter.recordType, claim.id);
    }
    return current;
  }

  function requireAttemptUpdate(
    claim: Running,
    update: AttemptUpdate,
    completion?: Completion,
    progressDetails?: ProgressDetails,
    failureOptions?: FailureOptions,
  ): Job {
    const updated =
      progressDetails !== undefined && adapter.updateProgressAttempt
        ? adapter.updateProgressAttempt(
            claim,
            update,
            progressDetails,
            failureOptions,
          )
        : adapter.updateAttempt(claim, update, completion, failureOptions);
    if (!updated) {
      throw new StaleJobAttemptError(adapter.recordType, claim.id);
    }
    return updated;
  }

  return {
    claimNext(workerId, options) {
      const claim = adapter.claim(
        requireNonEmpty(workerId, "workerId"),
        createToken(),
        now(),
        options,
      );
      if (!claim) {
        return null;
      }
      progress.delete(claim.id);
      return claim;
    },

    list: adapter.list,

    updateProgress(claim, progressPercent, details) {
      const requestedProgress = requireProgress(progressPercent);
      const current = requireActiveAttempt(claim);
      const timestamp = now();
      const state = progress.get(claim.id);
      if (!state || state.token !== claim.claimToken) {
        const updated = requireAttemptUpdate(
          claim,
          {
            progressPercent: requestedProgress,
            updatedAt: timestamp,
          },
          undefined,
          details,
        );
        progress.set(claim.id, {
          token: claim.claimToken,
          latest: requestedProgress,
          lastPersisted: requestedProgress,
          lastPersistedAt: timestamp.getTime(),
          latestDetails: details,
          lastPersistedDetails: details,
        });
        return updated;
      }

      state.latest = requestedProgress;
      state.latestDetails = details;
      if (
        Math.abs(requestedProgress - state.lastPersisted) >=
          PROGRESS_WRITE_DELTA ||
        timestamp.getTime() - state.lastPersistedAt >=
          PROGRESS_WRITE_INTERVAL_MS ||
        (adapter.progressDetailsChanged?.(
          details,
          state.lastPersistedDetails,
        ) ?? false)
      ) {
        const updated = requireAttemptUpdate(
          claim,
          {
            progressPercent: requestedProgress,
            updatedAt: timestamp,
          },
          undefined,
          details,
        );
        state.lastPersisted = requestedProgress;
        state.lastPersistedAt = timestamp.getTime();
        state.lastPersistedDetails = details;
        return updated;
      }

      return current;
    },

    complete(claim, completion) {
      requireActiveAttempt(claim);
      const timestamp = now();
      const completed = requireAttemptUpdate(
        claim,
        {
          status: "completed",
          progressPercent: 100,
          completedAt: timestamp,
          errorMessage: null,
          updatedAt: timestamp,
        },
        completion,
      );
      progress.delete(claim.id);
      return completed;
    },

    fail(claim, errorMessage, options) {
      const current = requireActiveAttempt(claim);
      const pendingProgress = progress.get(claim.id);
      const failed = requireAttemptUpdate(
        claim,
        {
          status: "failed",
          progressPercent: pendingProgress?.latest ?? current.progressPercent,
          errorMessage: requireNonEmpty(errorMessage, "errorMessage"),
          updatedAt: now(),
        },
        undefined,
        pendingProgress?.latestDetails,
        options,
      );
      progress.delete(claim.id);
      return failed;
    },

    requeue(id, options) {
      const current = requireRecord(id);
      if (!requeueFrom.includes(current.status)) {
        throw new InvalidStatusTransitionError(
          adapter.recordType,
          current.status,
          "queued",
        );
      }
      const requeued = adapter.requeue(
        id,
        current.status,
        current,
        {
          status: "queued",
          progressPercent: 0,
          claimToken: null,
          claimedBy: null,
          claimedAt: null,
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          updatedAt: now(),
        },
        options,
      );
      if (!requeued) {
        throw new InvalidStatusTransitionError(
          adapter.recordType,
          current.status,
          "queued",
        );
      }
      progress.delete(id);
      return requeued;
    },
  };
}

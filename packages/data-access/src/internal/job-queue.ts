import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  StaleJobAttemptError,
} from "../errors.js";
import type { JobStatus } from "../types.js";
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
> {
  readonly recordType: string;
  find(id: Id): Job | undefined;
  list(statuses?: JobStatus[]): Job[];
  claim(workerId: string, token: Token, timestamp: Date): Running | undefined;
  updateAttempt(
    claim: Running,
    update: AttemptUpdate,
    completion?: Completion,
  ): Job | undefined;
  requeue(
    id: Id,
    expectedStatus: "failed" | "completed",
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
> {
  claimNext(workerId: string): Running | null;
  list(statuses?: JobStatus[]): Job[];
  updateProgress(claim: Running, progressPercent: number): Job;
  complete(claim: Running, completion: Completion): Job;
  fail(claim: Running, errorMessage: string): Job;
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
    RequeueOptions
  >;
  createToken(): Token;
  now(): Date;
  requeueFrom: readonly ("failed" | "completed")[];
}): JobQueueController<
  Job,
  Running,
  Id,
  Token,
  Completion,
  RequeueOptions
> {
  const progress = new Map<
    Id,
    {
      token: Token;
      latest: number;
      lastPersisted: number;
      lastPersistedAt: number;
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
    if (
      current.status !== "running" ||
      current.claimToken !== claim.claimToken
    ) {
      throw new StaleJobAttemptError(adapter.recordType, claim.id);
    }
    return current;
  }

  function requireAttemptUpdate(
    claim: Running,
    update: AttemptUpdate,
    completion?: Completion,
  ): Job {
    const updated = adapter.updateAttempt(claim, update, completion);
    if (!updated) {
      throw new StaleJobAttemptError(adapter.recordType, claim.id);
    }
    return updated;
  }

  return {
    claimNext(workerId) {
      const claim = adapter.claim(
        requireNonEmpty(workerId, "workerId"),
        createToken(),
        now(),
      );
      if (!claim) {
        return null;
      }
      progress.delete(claim.id);
      return claim;
    },

    list: adapter.list,

    updateProgress(claim, progressPercent) {
      const requestedProgress = requireProgress(progressPercent);
      const current = requireActiveAttempt(claim);
      const timestamp = now();
      const state = progress.get(claim.id);
      if (!state || state.token !== claim.claimToken) {
        const updated = requireAttemptUpdate(claim, {
          progressPercent: requestedProgress,
          updatedAt: timestamp,
        });
        progress.set(claim.id, {
          token: claim.claimToken,
          latest: requestedProgress,
          lastPersisted: requestedProgress,
          lastPersistedAt: timestamp.getTime(),
        });
        return updated;
      }

      state.latest = requestedProgress;
      if (
        Math.abs(requestedProgress - state.lastPersisted) >=
          PROGRESS_WRITE_DELTA ||
        timestamp.getTime() - state.lastPersistedAt >=
          PROGRESS_WRITE_INTERVAL_MS
      ) {
        const updated = requireAttemptUpdate(claim, {
          progressPercent: requestedProgress,
          updatedAt: timestamp,
        });
        state.lastPersisted = requestedProgress;
        state.lastPersistedAt = timestamp.getTime();
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

    fail(claim, errorMessage) {
      const current = requireActiveAttempt(claim);
      const pendingProgress = progress.get(claim.id);
      const failed = requireAttemptUpdate(claim, {
        status: "failed",
        progressPercent: pendingProgress?.latest ?? current.progressPercent,
        errorMessage: requireNonEmpty(errorMessage, "errorMessage"),
        updatedAt: now(),
      });
      progress.delete(claim.id);
      return failed;
    },

    requeue(id, options) {
      const current = requireRecord(id);
      if (current.status !== "failed" && current.status !== "completed") {
        throw new InvalidStatusTransitionError(
          adapter.recordType,
          current.status,
          "queued",
        );
      }
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

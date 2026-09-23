import {
  InvalidMutationKeyError,
  parseCatalogReviewCommand,
  type CatalogReviewCommand,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleCatalogRevisionError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

export interface PreviewAcknowledgedCatalogCommandIO
  extends StructuredInputIO {
  openAccess(): DataAccess;
}

type CatalogCommandAction = CatalogReviewCommand["action"];
type CommandFor<TAction extends CatalogCommandAction> = Extract<
  CatalogReviewCommand,
  { action: TAction }
>;

interface PreviewAcknowledgedCatalogCommandWorkflow<
  TAction extends CatalogCommandAction,
  TContext,
  TIO extends PreviewAcknowledgedCatalogCommandIO,
> {
  action: TAction;
  workflowName: string;
  previewVerb: string;
  applyVerb: string;
  allowedOptions: readonly string[];
  previewForbiddenOptions: readonly string[];
  missingInputMessage: string;
  invalidCommandCode: string;
  expectedCommandMessage: string;
  previewAcknowledgementMessage: string;
  prepareContext(io: TIO): TContext;
  preview(input: {
    access: DataAccess;
    archiveId: OriginalDiscArchiveId;
    command: CommandFor<TAction>;
    options: Map<string, string>;
    context: TContext;
  }): unknown;
  apply(input: {
    access: DataAccess;
    archiveId: OriginalDiscArchiveId;
    command: CommandFor<TAction>;
    options: Map<string, string>;
    context: TContext;
  }): unknown;
  domainFailure(error: DomainInvariantError): CommandFailure;
  unavailableFailure(): CommandFailure;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseOptions(
  args: readonly string[],
  workflow: Pick<
    PreviewAcknowledgedCatalogCommandWorkflow<never, unknown, never>,
    "allowedOptions" | "workflowName"
  >,
): Map<string, string> {
  const allowed = new Set(workflow.allowedOptions);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!allowed.has(name) || options.has(name)) {
      invalid(`Invalid or repeated ${workflow.workflowName} option.`);
    }
    if (name === "--acknowledge" || name === "--stdin") {
      options.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      invalid(`${workflow.workflowName} option ${name} requires a value.`);
    }
    options.set(name, value);
  }
  return options;
}

function archiveId(value: string | undefined): OriginalDiscArchiveId {
  if (!value || value.trim() !== value || value.length > 256 ||
      value.startsWith("--")) {
    invalid("A valid Original Disc Archive ID is required.");
  }
  return value as OriginalDiscArchiveId;
}

function structuredCommand<TAction extends CatalogCommandAction>(
  options: Map<string, string>,
  io: StructuredInputIO,
  workflow: Pick<
    PreviewAcknowledgedCatalogCommandWorkflow<TAction, unknown, never>,
    | "action"
    | "missingInputMessage"
    | "invalidCommandCode"
    | "expectedCommandMessage"
  >,
): CommandFor<TAction> {
  let value: unknown;
  try {
    value = readStructuredObject(options, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (value === undefined) invalid(workflow.missingInputMessage);
  const parsed = parseCatalogReviewCommand(value, {
    mediaItemKinds: MEDIA_ITEM_KINDS,
  });
  if (!parsed.ok || parsed.command.action !== workflow.action) {
    throw new CommandFailure(
      workflow.invalidCommandCode,
      parsed.ok ? workflow.expectedCommandMessage : parsed.error,
      2,
    );
  }
  return parsed.command as CommandFor<TAction>;
}

export function runPreviewAcknowledgedCatalogCommand<
  TAction extends CatalogCommandAction,
  TContext,
  TIO extends PreviewAcknowledgedCatalogCommandIO,
>(
  rest: readonly string[],
  io: TIO,
  workflow: PreviewAcknowledgedCatalogCommandWorkflow<
    TAction,
    TContext,
    TIO
  >,
): unknown {
  const [verb, rawArchiveId, ...tail] = rest;
  if (verb !== workflow.previewVerb && verb !== workflow.applyVerb) {
    invalid(`Expected ${workflow.previewVerb} or ${workflow.applyVerb}.`);
  }
  const targetArchiveId = archiveId(rawArchiveId);
  const options = parseOptions(tail, workflow);
  const command = structuredCommand(options, io, workflow);
  if (verb === workflow.previewVerb) {
    if (workflow.previewForbiddenOptions.some((name) => options.has(name))) {
      invalid(
        `${workflow.workflowName} preview does not take a key or acknowledgement.`,
      );
    }
  } else if (!options.has("--acknowledge")) {
    invalid(workflow.previewAcknowledgementMessage);
  }

  let access: DataAccess | undefined;
  try {
    const context = workflow.prepareContext(io);
    access = io.openAccess();
    const input = {
      access,
      archiveId: targetArchiveId,
      command,
      options,
      context,
    };
    return verb === workflow.previewVerb
      ? workflow.preview(input)
      : workflow.apply(input);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    if (error instanceof StaleCatalogRevisionError) {
      throw new CommandFailure("STALE_CATALOG_REVISION", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      throw workflow.domainFailure(error);
    }
    throw workflow.unavailableFailure();
  } finally {
    access?.close();
  }
}

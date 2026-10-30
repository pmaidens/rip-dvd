import { runBrowserRendition } from "./encode-output-rendition.js";
import type { EncodeOutputMediaProbe } from "@rip-dvd/application";
import { createApplicationOperations, DamagePreviewRejectedError, InvalidDamagePreviewInputError, InvalidMutationKeyError } from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { CommandFailure } from "./command.js";
import { readStructuredObject, type StructuredInputIO } from "./structured-input.js";

export async function runDamagePreview(args: readonly string[], io: StructuredInputIO & { openAccess(): DataAccess; encodeOutputMediaProbe?: EncodeOutputMediaProbe; browserRenditionsEnabled?: boolean }): Promise<unknown> {
  const [action, id, ...tail] = args;
  if (["rendition-availability", "request-rendition", "inspect-rendition"].includes(action ?? "")) return runBrowserRendition(args, io, "damage_preview");
  const allowed: Record<string, string[]> = {
    availability: ["--json", "--stdin", "--file"], request: ["--json", "--stdin", "--file", "--key"],
    recreate: ["--json", "--stdin", "--file", "--key"],
    inspect: [], wait: ["--timeout-ms", "--poll-ms"], cancel: ["--key"], export: ["--destination"],
    delete: ["--json", "--stdin", "--file", "--key"], cleanup: ["--json", "--stdin", "--file", "--key"],
  };
  if (!action || !id || !Object.hasOwn(allowed, action)) throw new CommandFailure("INVALID_ARGUMENTS", "Expected damage-preview availability|request|inspect|wait|cancel|export|delete|cleanup|recreate <identity> with the action's inputs.", 2);
  const options = new Map<string, string>();
  for (let index = 0; index < tail.length; index++) {
    const key = tail[index]!;
    if (!allowed[action]!.includes(key) || options.has(key)) throw new CommandFailure("INVALID_ARGUMENTS", "Invalid or repeated Damage Preview option.", 2);
    const value = key === "--stdin" ? "true" : tail[++index];
    if (value === undefined || value.startsWith("--")) throw new CommandFailure("INVALID_ARGUMENTS", "Damage Preview option requires a value.", 2);
    options.set(key, value);
  }
  const input = readStructuredObject(options, io);
  const access = io.openAccess();
  try {
    const operations = createApplicationOperations(access);
    switch (action) {
      case "availability": return await operations.inspectDamagePreviewAvailability(id, input);
      case "recreate": {
        if (options.has("--key")) return await operations.recreateDamagePreview(id, { ...(input as Record<string, unknown> | undefined), mutationKey: options.get("--key") });
        if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some((key) => key !== "selection"))) throw new InvalidDamagePreviewInputError("Recreation inspection accepts only a proposed selection. Submit reviewed work with --key.");
        return await operations.inspectDamagePreviewRecreation(id, (input as { selection?: unknown } | undefined)?.selection);
      }
      case "request": return await operations.requestDamagePreview(id, { ...(input as Record<string, unknown> | undefined), mutationKey: options.get("--key") });
      case "inspect": return await operations.inspectDamagePreview(id);
      case "wait": return await operations.waitDamagePreview(id, { timeoutMs: Number(options.get("--timeout-ms")), ...(options.has("--poll-ms") ? { pollMs: Number(options.get("--poll-ms")) } : {}) });
      case "cancel": return operations.cancelDamagePreview(id, options.get("--key"));
      case "delete": return operations.deleteDamagePreviewMedia(id, { ...(input as Record<string, unknown> | undefined), mutationKey: options.get("--key") });
      case "cleanup": return operations.cleanupDamagePreviewMedia(id, { ...(input as Record<string, unknown> | undefined), mutationKey: options.get("--key") });
      case "export": {
        const destination = options.get("--destination");
        if (!destination) throw new InvalidDamagePreviewInputError("An export destination is required.");
        const exported = await operations.exportDamagePreview(id, destination);
        return { ...exported, path: process.env.RIP_DVD_EXPORT_CALLER_PATH ?? exported.path };
      }
    }
  } catch (error) {
    if (error instanceof InvalidDamagePreviewInputError || error instanceof InvalidMutationKeyError) throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    if (error instanceof RecordNotFoundError) throw new CommandFailure("NOT_FOUND", error.message, 2);
    if (error instanceof MutationKeyConflictError) throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    if (error instanceof DamagePreviewRejectedError) throw new CommandFailure(error.code, error.message, 2, undefined, { reasons: error.reasons, current: error.current });
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("DAMAGE_PREVIEW_UNAVAILABLE", "Damage Preview operation is unavailable.", 1);
  } finally { access.close(); }
}

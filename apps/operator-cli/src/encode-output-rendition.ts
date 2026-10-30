import { BrowserRenditionRejectedError, createApplicationOperations, InvalidBrowserRenditionInputError, InvalidEncodeOutputArtifactIdentityError, InvalidMutationKeyError, type EncodeOutputMediaProbe } from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { CommandFailure } from "./command.js";
import { readStructuredObject, StructuredInputError, type StructuredInputIO } from "./structured-input.js";

export async function runBrowserRendition(args: readonly string[], io: StructuredInputIO & { openAccess(): DataAccess; encodeOutputMediaProbe?: EncodeOutputMediaProbe; browserRenditionsEnabled?: boolean }, sourceKind: "encode_output" | "damage_preview" = "encode_output") {
  const [action, identity, ...tail] = args;
  if (!identity || identity.length > 256 || !["rendition-availability", "request-rendition", "inspect-rendition"].includes(action ?? "")) throw new CommandFailure("INVALID_ARGUMENTS", "Expected a rendition action and identity.", 2);
  const options = new Map<string, string>();
  for (let index = 0; index < tail.length; index++) {
    const key = tail[index]!;
    if (action === "inspect-rendition" || !["--json", "--file", "--stdin", ...(action === "request-rendition" ? ["--key"] : [])].includes(key) || options.has(key)) throw new CommandFailure("INVALID_ARGUMENTS", "Invalid rendition option.", 2);
    const value = key === "--stdin" ? "true" : tail[++index];
    if (!value || value.startsWith("--")) throw new CommandFailure("INVALID_ARGUMENTS", "Rendition option requires a value.", 2);
    options.set(key, value);
  }
  let access: DataAccess | undefined;
  try {
    const input = readStructuredObject(options, io);
    if (action === "request-rendition" && (typeof input !== "object" || input === null || Array.isArray(input) || "mutationKey" in input || !options.has("--key"))) throw new InvalidBrowserRenditionInputError();
    access = io.openAccess();
    const operations = createApplicationOperations(access, { encodeOutputMediaProbe: io.encodeOutputMediaProbe, browserRenditionsEnabled: io.browserRenditionsEnabled });
    if (action === "rendition-availability") return await (sourceKind === "damage_preview" ? operations.inspectDamagePreviewRenditionAvailability(identity, input ?? {}) : operations.inspectEncodeOutputRenditionAvailability(identity, input ?? {}));
    if (action === "request-rendition") return await (sourceKind === "damage_preview" ? operations.requestDamagePreviewRendition : operations.requestEncodeOutputRendition)(identity, { ...(input as Record<string, unknown>), mutationKey: options.get("--key") });
    return operations.inspectBrowserRendition(identity);
  } catch (error) {
    if (error instanceof StructuredInputError) throw new CommandFailure(error.code, error.message, 2);
    if (error instanceof InvalidBrowserRenditionInputError || error instanceof InvalidMutationKeyError || error instanceof InvalidEncodeOutputArtifactIdentityError) throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    if (error instanceof MutationKeyConflictError) throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    if (error instanceof BrowserRenditionRejectedError) throw new CommandFailure(error.code, error.message, 2, undefined, { current: error.current });
    if (error instanceof RecordNotFoundError) throw new CommandFailure("NOT_FOUND", "Canonical media or Browser Viewing Rendition not found.", 2);
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("BROWSER_RENDITION_UNAVAILABLE", "Browser Viewing Rendition operation is unavailable.", 1);
  } finally { access?.close(); }
}

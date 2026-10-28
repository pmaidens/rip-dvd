import { createApplicationOperations, InvalidDamagePreviewInputError } from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { CommandFailure } from "./command.js";
import { readStructuredObject, type StructuredInputIO } from "./structured-input.js";

export async function runDamagePreview(
  args: readonly string[],
  io: StructuredInputIO & { openAccess(): DataAccess },
): Promise<unknown> {
  const [action, id, ...tail] = args;
  if (action !== "availability" || !id) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Expected damage-preview availability <archive-id> [--json <selection>|--stdin|--file <path>].", 2);
  }
  const options = new Map<string, string>();
  for (let index = 0; index < tail.length; index++) {
    const key = tail[index]!;
    if (!["--json", "--stdin", "--file"].includes(key) || options.has(key)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid or repeated Damage Preview option.", 2);
    }
    const value = key === "--stdin" ? "true" : tail[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Damage Preview option requires a value.", 2);
    }
    options.set(key, value);
  }
  const input = readStructuredObject(options, io);
  const access = io.openAccess();
  try {
    return await createApplicationOperations(access).inspectDamagePreviewAvailability(id, input);
  } catch (error) {
    if (error instanceof InvalidDamagePreviewInputError) throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    if (error instanceof RecordNotFoundError) throw new CommandFailure("NOT_FOUND", "Original Disc Archive was not found.", 2);
    throw new CommandFailure("INSPECTION_UNAVAILABLE", "Damage Preview inspection is unavailable.", 1);
  } finally {
    access.close();
  }
}

import { createArchiveImageOwnership } from "../../dist/archive-image-ownership.js";

const [mode, originalsLibraryPath, archiveId] = process.argv.slice(2);
const ownership = createArchiveImageOwnership({
  inspectStorage: () => ({
    filesystemType: "synthetic-local",
    storageClass: "local",
  }),
});

try {
  await ownership[mode]({
    archiveId,
    originalsLibraryPath,
    signal: new AbortController().signal,
    async task() {},
  });
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: error instanceof Error && "code" in error ? error.code : null,
  })}\n`);
}

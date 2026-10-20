import { createArchiveImageOwnership } from "../../dist/archive-image-ownership.js";

const [
  mode,
  originalsLibraryPath,
  imagePath,
  archiveId,
  authorityRootPath,
] = process.argv.slice(2);
const ownership = createArchiveImageOwnership({
  ...(authorityRootPath ? { authorityRootPath } : {}),
});

try {
  await ownership[mode]({
    archiveId,
    imagePath,
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

import { Readable } from "node:stream";
import { inspectDamagePreview, openDamagePreviewArtifact, InvalidDamagePreviewInputError, DamagePreviewRejectedError } from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Access uses the same deployment authentication boundary as the operator APIs.
// Canonical MKV is a download. Browser Viewing Renditions are a later capability.
export async function createDamagePreviewMediaRoute(request: Request, identity: string, getAccess: () => DataAccess = getDataAccess) {
  if (request.method !== "GET" || new URL(request.url).search !== "") return Response.json({ error: { code: "INVALID_ARGUMENTS" } }, { status: 400 });
  try {
    const access = getAccess();
    const { file, artifact, record } = await openDamagePreviewArtifact(access, identity);
    let inspection;
    try { inspection = await inspectDamagePreview(access, record.id); }
    catch (error) { await file.close(); throw error; }
    const stream = file.createReadStream({ start: 0, autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
      "Content-Type": artifact.mediaType, "Content-Length": String(artifact.sizeBytes),
      "Content-Disposition": `attachment; filename="damage-preview-${record.id}.mkv"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "X-Damage-Preview-Status": inspection.status,
      "X-Damage-Preview-Generation-Status": inspection.generationStatus,
    } });
  } catch (error) {
    const status = error instanceof InvalidDamagePreviewInputError ? 400 : error instanceof RecordNotFoundError || error instanceof DamagePreviewRejectedError ? 404 : 503;
    return Response.json({ error: { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE" } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
export async function GET(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) { return createDamagePreviewMediaRoute(request, (await context.params).artifactIdentity); }

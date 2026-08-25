import type { ArchiveBoundaryEvidence } from "@rip-dvd/data-access";

export function ArchiveBoundaryDescription({
  boundaryEvidence,
}: {
  boundaryEvidence?: ArchiveBoundaryEvidence | null;
}) {
  if (
    boundaryEvidence === null ||
    boundaryEvidence === undefined ||
    boundaryEvidence.excludedSectorCount === 0
  ) {
    return null;
  }
  return (
    <div className="archive-boundary-description">
      <p><strong>Capacity correction</strong></p>
      <p>
        Reported size: {boundaryEvidence.reportedSizeBytes.toLocaleString(
          "en-US",
        )} bytes
      </p>
      <p>
        Archived size: {boundaryEvidence.publishedSizeBytes.toLocaleString(
          "en-US",
        )} bytes
      </p>
      <p>
        Excluded trailing sectors: {
          boundaryEvidence.excludedSectorCount.toLocaleString("en-US")
        }
      </p>
      <p>The excluded suffix was proven unaddressable and unreferenced.</p>
    </div>
  );
}

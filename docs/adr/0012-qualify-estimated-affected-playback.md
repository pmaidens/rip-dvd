# Qualify estimated affected playback by occurrence and coverage

Unrecovered Source identifies physical gaps, but a DVD can reference the same
source more than once and can provide timing evidence at different levels of
detail. A source intersection alone cannot support an exact seconds-lost claim.

For `dvd-recovery-evidence-v1`, each current Title Damage Assessment snapshots
versioned timing evidence for every known playback occurrence. A source-span
mapping is preferred when trustworthy evidence places the affected source
directly. If that evidence is unavailable, a whole-cell span is the coarse
fallback. Missing source that neither method can place stays explicit as
occurrence-specific unknown coverage with a machine-readable reason.

Repeated playback occurrences remain separate even when they reference the
same source. Overlapping intervals within one occurrence merge so operators do
not see duplicate locations. Every interval records its timing method and
coverage. The interval locates source associated with a gap; it does not state
how much playback is lost or how far decoder effects extend.

The assessment identity includes normalized timing evidence and derived
intervals. Reordered or duplicate evidence reuses the identity. A changed
method, occurrence, coverage, interval, or unknown reason creates a different
identity. Assessments written before timing tracking remain readable as
outdated evidence, but they cannot become current until reassessment records
the timing snapshot.

Catalog Review exposes the same qualified intervals and unknown coverage
through the web and public JSON CLI. New-format Archive Job admission remains
closed.

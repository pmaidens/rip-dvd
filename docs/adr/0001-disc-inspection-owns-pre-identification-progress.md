# Disc Inspection owns pre-identification progress

> Superseded in part by [ADR 0003](0003-archive-copy-is-the-only-full-disc-read.md):
> Disc Inspection still owns pre-identification work, but no longer performs a
> full-content hash.

Disc Inspection is a first-class, insertion-scoped process associated with an Optical Drive until the inserted disc's content identity is established. Metadata reading, content hashing, retry state, progress, findings, and terminal inspection failure belong to the Disc Inspection rather than the Optical Drive or an Archive Job; only after successful identification can the result be matched to a Detected Disc and its Archive Request. Its lifecycle status is `running`, `completed`, `failed`, or `aborted`, while its phase describes the current work. Progress, findings, timing, and terminal reasons are persisted as structured data rather than display strings, so presentation remains a web concern and operational statistics never depend on parsing text. This avoids attributing an unreadable or changed physical disc to the wrong Archive Job, keeps removal and replacement out of failure-rate statistics, and treats hashing as one phase of the broader inspection instead of introducing a narrower Hash Job.

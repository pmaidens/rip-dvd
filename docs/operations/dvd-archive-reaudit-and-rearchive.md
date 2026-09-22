# DVD archive audit and physical rearchiving

This procedure covers DVD Original Disc Archives flagged by the read-only archive audit. An audit finding does not change an archive or prove that a physical DVD has been rearchived. Keep the old archive and its history while checking a replacement.

## Rerun the audit

Run this on the Compose host after the audit service has been deployed. The audit service opens SQLite read-only with `query_only`, mounts the originals library read-only, has no network, and emits path-free JSON. Keep the output in an ignored private directory or a restricted operator workspace because it contains archive and Detected Disc identifiers. Never commit the report or its installation-specific summary.

```sh
cd /path/to/rip-dvd
umask 077
report="$HOME/dvd-archive-audit-$(date -u +%Y%m%dT%H%M%SZ).json"
docker compose --profile maintenance run --rm archive-audit \
  --limit 1000 --concurrency 2 \
  --file-timeout-ms 5000 --runtime-timeout-ms 600000 \
  > "$report"
```

Record the deployed commit, `commandVersion`, `startedAt`, `completedAt`, `scope`, and `counts` with any report. Check `scope.truncated`: if it is `true`, the command examined only the oldest 1,000 matching archives. It has no paging option, so do not call that a complete inventory. Check the command's exit status before using its output.

`definite_truncation` means supported ISO 9660 or UDF geometry extends beyond the file. `suspicious_capacity_reuse` and `capacityReuse` identify exact capacity reuse across distinct media generations on one Optical Drive; neither proves truncation. Review `size_mismatch`, `malformed_metadata`, `unsupported_layout`, `missing_file`, and read or containment errors separately. A missing or unsupported file needs investigation before any conclusion about its physical boundary. Compare each candidate's archive ID and Detected Disc ID with the dashboard and physical media inventory; never rely on matching byte sizes alone.

## Recreate an affected archive

1. Confirm the deployed Archive Worker includes the DVD geometry gate, direct Disc Inspection capacity settlement, and physical endpoint proof from issues #320, #321, and #323. The source commits are `c324250`, `6bb5e01`, and `003604d`; the running image must have been built from a commit containing all three. Do not start physical rearchiving against the older worker.
2. Locate the physical DVD for the affected Detected Disc. Check its case, printed disc number, volume label, and expected title map against the catalog. Record the old Original Disc Archive ID and audit classification. An exact size match with another disc is only a lead, not an identity check.
3. Insert that DVD into the intended Optical Drive. In the dashboard, wait for a completed Disc Inspection. Confirm the Optical Drive, label, and title map. Check the matching Disc Inspection's media generation and settled capacity through a bounded read-only catalog query; the dashboard does not display those two fields. For a truncated archive, compare the new capacity with the old file size and the audit geometry. If the dashboard still says **Already archived**, or the identity or capacity is unexpected, stop and investigate. Do not reuse an old Detected Disc or Archive Request merely to force a copy.
4. On the newly scanned Detected Disc, select **Request archive**. Record the new Archive Request ID. Watch its Archive Job attempts until one completes and the request is fulfilled. If the request enters `needs_attention`, use **Investigate** and resolve the cause before choosing **Retry archive**. Record the successful Archive Job ID and its associated new Original Disc Archive ID. A pending request, retry, or partial file is not a rearchive.
5. Select **Verify archive file** for the new Original Disc Archive. Inspect its read-only catalog detail at `GET /api/catalog-reviews/<new-archive-id>`. For a normal clean DVD copy, `archive.boundaryEvidence` must have `policyVersion: "dvd-archive-boundary-v2"`, equal reported and published sizes, zero excluded sectors, and `endpointProof` with `proofVersion: "dvd-normal-endpoint-proof-v1"`, `confirmationCount: 2`, and `firstExcludedLba` equal to the published byte count divided by 2,048. The endpoint evidence must be the normalized logical-block-address-out-of-range result. If a corrected-boundary rescue was used, examine its separate boundary and retained-sector evidence before accepting it. `clean_read` describes reads inside the retained range and does not by itself prove the physical end. Match the completed Archive Job, Detected Disc, file verification, new archive size, and boundary evidence before recording success.
6. Only after that verification, review the old Original Disc Archive in **Catalog Review**. Remove any job-free Disc Selections that should no longer be used, then complete its review as **Archive only** where the catalog allows it. Cancel queued work sourced from the old archive where supported. Ordinary Disc Selections with Encode Job history cannot be removed, and correction cannot move a selection to a different Original Disc Archive. Preserve those records and completed outputs as history; record the old and new archive IDs for operators and avoid starting new Encode Jobs from the old selection. The application has no supported operation to replace or delete the old Original Disc Archive. Do not delete its file or edit SQLite to simulate replacement.

For step 3, take the new Detected Disc ID from the read-only dashboard response and replace `DETECTED_DISC_ID` below. The maintenance image includes SQLite. Match the one returned Optical Drive and Detected Disc to the visible insertion before trusting its capacity.

```sh
docker compose --profile maintenance run --rm --no-deps \
  --entrypoint sqlite3 backup -readonly /data/rip-dvd.sqlite \
  "PRAGMA query_only=ON; SELECT id, detected_disc_id, optical_drive_id, media_generation, media_capacity_bytes, status FROM disc_inspections WHERE detected_disc_id = 'DETECTED_DISC_ID' AND is_current = 1 AND status = 'completed' LIMIT 1;"
```

The operator must physically find and insert each DVD, request preservation, inspect the resulting Archive Job and boundary evidence, and decide how to handle old catalog selections. Record which of these actions actually occurred. A report or runbook alone is no evidence of rearchiving.

import { sanitizeText, tailBytes } from "./deploy-support.mjs";

const MAX_REVIEW_DIFF_BYTES = 65_536;
const MAX_REVIEW_BUNDLE_BYTES = 48 * 1024;
const MAX_FILES = 300;
const MAX_COMMITS = 100;

export function parseNameStatus(output) {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const files = [];
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index];
    if (/^[RC]/u.test(status)) {
      files.push({ status, oldPath: parts[index + 1], path: parts[index + 2] });
      index += 2;
    } else {
      files.push({ status, path: parts[index + 1] });
      index += 1;
    }
  }
  return files;
}

export function classifyReview(files, diff) {
  const paths = files.flatMap((file) => [file.path, file.oldPath].filter(Boolean));
  const reasons = new Set();
  const hasMigration = paths.some((path) => /(?:^|\/)(?:drizzle|migrations?)(?:\/|$)|\.sql$/u.test(path));
  const hasSchema = paths.some((path) => /packages\/data-access\/(?:src\/)?(?:schema|tables)|schema\.ts$/u.test(path));
  if (hasMigration) reasons.add("migration");
  if (hasSchema && !hasMigration) reasons.add("schema_without_migration");
  if (paths.some((path) => /(^|\/)compose(?:\.[^/]*)?\.ya?ml$/u.test(path))) {
    reasons.add("compose_change");
    if (/^[+-].*\b(?:volumes|devices)\s*:/gmu.test(diff)) reasons.add("compose_volumes_or_devices");
  }
  if (paths.some((path) => /(?:^|\/)(?:Dockerfile(?:\.[^/]*)?|[^/]+\.Dockerfile)$/u.test(path))) reasons.add("dockerfile");
  if (paths.some((path) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/u.test(path))) reasons.add("dependency_lockfile");
  if (paths.some((path) => /^(?:scripts\/(?:update|deploy|compose-|.*recover)|docker\/backup-sqlite|README\.md$)/u.test(path))) reasons.add("deployment_or_recovery");
  if (paths.some((path) => /optical-drive|optical_drives|compose.*hardware/iu.test(path)) || /^[+-].*\bdevices\s*:/gmu.test(diff)) reasons.add("optical_drive_identity_policy");
  if (
    paths.some((path) => /^(?:\.env(?:\.|$)|packages\/config\/)/u.test(path))
    || /^[+].*\$\{[A-Z0-9_]+(?::?\?)/gmu.test(diff)
  ) reasons.add("required_environment");
  if (paths.some((path) => /^(?:\.github\/|docker\/|scripts\/)/u.test(path)) && reasons.size === 0) reasons.add("unclassified_operational_change");
  return [...reasons].sort();
}

export function buildReviewBundle(oldCommit, targetCommit, commits, files, diff) {
  const reasons = classifyReview(files, diff);
  const exceeded = {
    commits: commits.length > MAX_COMMITS,
    files: files.length > MAX_FILES,
    diffBytes: Buffer.byteLength(diff) > MAX_REVIEW_DIFF_BYTES,
  };
  if (Object.values(exceeded).some(Boolean)) reasons.push("review_bundle_limit_exceeded");
  reasons.sort();
  const bundle = {
    schemaVersion: 1,
    oldCommit,
    targetCommit,
    reviewRequired: reasons.length > 0,
    reasons,
    limits: {
      commits: MAX_COMMITS,
      files: MAX_FILES,
      diffBytes: MAX_REVIEW_DIFF_BYTES,
      exceeded,
      totals: {
        commits: commits.length,
        files: files.length,
        diffBytes: Buffer.byteLength(diff),
      },
    },
    caveat: "The classifier identifies risky change classes. It does not prove SQL, configuration, or recovery changes are semantically safe.",
    commits: commits.slice(0, MAX_COMMITS),
    files: files.slice(0, MAX_FILES),
    relevantDiff: sanitizeText(diff, MAX_REVIEW_DIFF_BYTES),
  };
  while (Buffer.byteLength(JSON.stringify(bundle)) > MAX_REVIEW_BUNDLE_BYTES) {
    if (Buffer.byteLength(bundle.relevantDiff) > 4096) {
      bundle.relevantDiff = tailBytes(
        bundle.relevantDiff,
        Math.max(4096, Math.floor(Buffer.byteLength(bundle.relevantDiff) / 2)),
      );
    } else if (bundle.files.length > 50) {
      bundle.files = bundle.files.slice(0, Math.ceil(bundle.files.length / 2));
    } else if (bundle.commits.length > 20) {
      bundle.commits = bundle.commits.slice(0, Math.ceil(bundle.commits.length / 2));
    } else {
      bundle.relevantDiff = "[diff omitted to preserve the bounded review contract]";
      break;
    }
  }
  return bundle;
}

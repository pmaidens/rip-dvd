import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { DeploymentError } from "./deploy-state.mjs";
import { REPOSITORY_ROOT, runCheckedSync, sanitizeText } from "./deploy-support.mjs";

const RUNTIME_SERVICES = ["web", "archive-worker", "encode-worker"];

export function loadConfig(path) {
  let source;
  if (path === "-") {
    source = readFileSync(0, "utf8");
  } else if (typeof path === "string") {
    source = readFileSync(resolve(path), "utf8");
  } else {
    throw new DeploymentError("validation_failure", "plan requires --config PATH or --config -");
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new DeploymentError("validation_failure", "Deployment configuration is not valid JSON");
  }
  for (const key of ["expectedHostname", "expectedRepositoryRoot", "expectedRemoteUrl"]) {
    if (typeof raw[key] !== "string" || raw[key].length === 0) {
      throw new DeploymentError("validation_failure", `Deployment configuration requires ${key}`);
    }
  }
  if (!Array.isArray(raw.expectedDrives) || raw.expectedDrives.length === 0) {
    throw new DeploymentError("validation_failure", "expectedDrives must be a nonempty array");
  }
  const serialNumbers = new Set();
  const applicationIds = new Set();
  const expectedDrives = [];
  for (const drive of raw.expectedDrives) {
    if (
      !drive
      || typeof drive.serialNumber !== "string"
      || drive.serialNumber.trim().length === 0
      || typeof drive.applicationId !== "string"
      || drive.applicationId.trim().length === 0
    ) {
      throw new DeploymentError(
        "validation_failure",
        "Each expected drive requires nonempty serialNumber and applicationId",
      );
    }
    const serialNumber = drive.serialNumber.trim();
    const applicationId = drive.applicationId.trim();
    if (serialNumbers.has(serialNumber) || applicationIds.has(applicationId)) {
      throw new DeploymentError(
        "validation_failure",
        "Expected drive serialNumber and applicationId values must be unique",
      );
    }
    serialNumbers.add(serialNumber);
    applicationIds.add(applicationId);
    expectedDrives.push({ serialNumber, applicationId });
  }
  const configuredStoragePaths = raw.storagePaths ?? ["/", "/mnt/sandisk"];
  if (
    !Array.isArray(configuredStoragePaths)
    || configuredStoragePaths.length === 0
    || !configuredStoragePaths.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    )
    || !configuredStoragePaths.includes("/")
  ) {
    throw new DeploymentError(
      "validation_failure",
      "storagePaths must be a nonempty string array containing the root filesystem",
    );
  }
  const storagePaths = [...new Set(
    configuredStoragePaths.map((entry) => entry.trim()),
  )];
  const minimumRootFreeBytes = raw.minimumRootFreeBytes ?? 4 * 1024 ** 3;
  const minimumMemoryAvailableBytes =
    raw.minimumMemoryAvailableBytes ?? 512 * 1024 ** 2;
  for (const [key, value] of Object.entries({
    minimumRootFreeBytes,
    minimumMemoryAvailableBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DeploymentError(
        "validation_failure",
        `${key} must be a nonnegative safe integer`,
      );
    }
  }
  return {
    expectedHostname: raw.expectedHostname,
    expectedRepositoryRoot: resolve(raw.expectedRepositoryRoot),
    expectedRemoteUrl: raw.expectedRemoteUrl,
    branch: raw.branch ?? "main",
    upstream: raw.upstream ?? "origin/main",
    remote: raw.remote ?? "origin",
    targetRef: raw.targetRef ?? "origin/main",
    healthUrl: raw.healthUrl ?? "http://127.0.0.1:3000/api/health",
    readinessUrl:
      raw.readinessUrl
      ?? "http://127.0.0.1:3000/api/deployment-readiness",
    storagePaths,
    minimumRootFreeBytes,
    minimumMemoryAvailableBytes,
    expectedDrives,
  };
}

function normalizedRemote(value) {
  return value.trim().replace(/^git@github\.com:/u, "https://github.com/").replace(/\.git$/u, "");
}

export function assertIdentity(config) {
  const actualHost = process.env.RIP_DVD_DEPLOY_HOSTNAME_OVERRIDE ?? hostname();
  if (actualHost !== config.expectedHostname) {
    throw new DeploymentError("validation_failure", "Deployment host identity does not match", {
      expected: config.expectedHostname,
      actual: actualHost,
    });
  }
  const actualRoot = resolve(runCheckedSync("git", ["rev-parse", "--show-toplevel"]).stdout.trim());
  if (actualRoot !== config.expectedRepositoryRoot || actualRoot !== REPOSITORY_ROOT) {
    throw new DeploymentError("validation_failure", "Repository root identity does not match", {
      expected: config.expectedRepositoryRoot,
      actual: actualRoot,
    });
  }
  const remote = runCheckedSync("git", ["remote", "get-url", config.remote]).stdout.trim();
  if (normalizedRemote(remote) !== normalizedRemote(config.expectedRemoteUrl)) {
    throw new DeploymentError("validation_failure", "Repository remote identity does not match", {
      expected: normalizedRemote(config.expectedRemoteUrl),
      actual: normalizedRemote(remote),
    });
  }
  const branch = runCheckedSync("git", ["branch", "--show-current"]).stdout.trim();
  const upstream = runCheckedSync(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  ).stdout.trim();
  if (branch !== config.branch || upstream !== config.upstream) {
    throw new DeploymentError("validation_failure", "Branch or upstream does not match", {
      expectedBranch: config.branch,
      actualBranch: branch,
      expectedUpstream: config.upstream,
      actualUpstream: upstream,
    });
  }
  const dirty = runCheckedSync("git", ["status", "--porcelain", "--untracked-files=normal"]).stdout;
  if (dirty.length > 0) {
    throw new DeploymentError("validation_failure", "Checkout has local changes", {
      paths: sanitizeText(dirty, 32_768).trim().split(/\r?\n/u),
    });
  }
  runCheckedSync("docker", ["compose", "config", "--quiet"]);
}

function parseMemoryAvailable(output) {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.trimStart().startsWith("Mem:"));
  const fields = line?.trim().split(/\s+/u) ?? [];
  const available = Number(fields[6]);
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new Error("free did not report valid available memory");
  }
  return available;
}

function parseDiskRows(output) {
  const lines = output.trim().split(/\r?\n/u);
  if (lines.length < 2) throw new Error("df did not report filesystem capacity");
  return lines.slice(1).map((line) => {
    const fields = line.trim().split(/\s+/u);
    const availableKilobytes = Number(fields[3]);
    const path = fields.at(-1);
    if (
      fields.length < 6
      || !Number.isSafeInteger(availableKilobytes)
      || availableKilobytes < 0
      || typeof path !== "string"
      || path.length === 0
    ) {
      throw new Error("df reported invalid filesystem capacity");
    }
    const availableBytes = availableKilobytes * 1024;
    if (!Number.isSafeInteger(availableBytes)) {
      throw new Error("df reported filesystem capacity beyond the safe integer range");
    }
    return {
      filesystem: fields[0],
      availableBytes,
      usedPercent: fields[4],
      path,
    };
  });
}

export function checkResources(config) {
  const memoryAvailableBytes = parseMemoryAvailable(runCheckedSync("free", ["--bytes"]).stdout);
  const disks = parseDiskRows(runCheckedSync("df", ["-Pk", ...config.storagePaths]).stdout);
  const root = disks.find((disk) => disk.path === "/");
  if (!root || root.availableBytes < config.minimumRootFreeBytes) {
    throw new DeploymentError("validation_failure", "Root filesystem lacks deployment build space", {
      requiredBytes: config.minimumRootFreeBytes,
      availableBytes: root?.availableBytes ?? null,
    });
  }
  if (memoryAvailableBytes < config.minimumMemoryAvailableBytes) {
    throw new DeploymentError("validation_failure", "Host lacks available memory for a deployment build", {
      requiredBytes: config.minimumMemoryAvailableBytes,
      availableBytes: memoryAvailableBytes,
    });
  }
  return { memoryAvailableBytes, disks };
}

function parseReadiness(output) {
  let readiness;
  try {
    readiness = JSON.parse(output);
  } catch {
    throw new Error("Deployment readiness endpoint returned malformed JSON");
  }
  if (
    readiness?.schemaVersion !== 1
    || !Array.isArray(readiness.activeWork)
    || !Array.isArray(readiness.opticalDrives)
    || !readiness.activeWork.every((item) =>
      item
      && typeof item.kind === "string"
      && typeof item.id === "string"
      && item.id.length > 0
      && typeof item.status === "string"
      && item.status.length > 0
    )
    || !readiness.opticalDrives.every((drive) =>
      drive
      && typeof drive.id === "string"
      && drive.id.length > 0
      && typeof drive.devicePath === "string"
      && drive.devicePath.length > 0
      && (drive.serialNumber === null || typeof drive.serialNumber === "string")
      && typeof drive.isEnabled === "boolean"
      && typeof drive.isPresent === "boolean"
    )
  ) {
    throw new Error("Deployment readiness endpoint returned an invalid contract");
  }
  return readiness;
}

function verifyDrives(config, readiness) {
  const output = runCheckedSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "archive-worker",
      "lsblk",
      "--json",
      "--output",
      "PATH,TYPE,MODEL,SERIAL",
    ],
  ).stdout;
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("archive-worker lsblk returned malformed JSON");
  }
  const physical = (parsed.blockdevices ?? []).filter((device) => device.type === "rom");
  const checks = config.expectedDrives.map((expected) => {
    const hardware = physical.filter(
      (device) => String(device.serial ?? "").trim() === expected.serialNumber,
    );
    const application = readiness.opticalDrives.filter((drive) =>
      drive.id === expected.applicationId
      && drive.serialNumber?.trim() === expected.serialNumber
    );
    return {
      serialNumber: expected.serialNumber,
      applicationId: expected.applicationId,
      hardwareMatches: hardware.length,
      applicationMatches: application.length,
      devicePathMatches: hardware.length === 1
        && application.length === 1
        && hardware[0].path === application[0].devicePath,
      applicationEnabled: application[0]?.isEnabled ?? false,
      applicationPresent: application[0]?.isPresent ?? false,
    };
  });
  const mismatch = checks.find((check) =>
    check.hardwareMatches !== 1
    || check.applicationMatches !== 1
    || !check.devicePathMatches
    || !check.applicationEnabled
    || !check.applicationPresent
  );
  if (mismatch) {
    throw new Error(
      `Physical optical-drive identity check failed for ${mismatch.serialNumber}`,
    );
  }
  return checks;
}

function failedSystemdUnits() {
  return runCheckedSync("systemctl", ["--failed", "--no-legend", "--plain"]).stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => sanitizeText(line, 1000));
}

export function runtimeSnapshot(config) {
  const curlArguments = ["--fail", "--silent", "--show-error", "--max-time", "10"];
  const health = runCheckedSync("curl", [...curlArguments, config.healthUrl]);
  const readiness = parseReadiness(
    runCheckedSync("curl", [...curlArguments, config.readinessUrl]).stdout,
  );
  const driveChecks = verifyDrives(config, readiness);
  const failedUnits = failedSystemdUnits();
  return {
    health: sanitizeText(health.stdout, 2000).trim(),
    readiness,
    driveChecks,
    activeWork: readiness.activeWork,
    compose: sanitizeText(runCheckedSync("docker", ["compose", "ps"]).stdout, 16_384),
    dockerDiskUsage: sanitizeText(runCheckedSync("docker", ["system", "df"]).stdout, 16_384),
    failedUnits,
  };
}

export function independentVerify(plan, expectedCommit) {
  const head = runCheckedSync("git", ["rev-parse", "HEAD"]).stdout.trim();
  const dirty = runCheckedSync("git", ["status", "--porcelain", "--untracked-files=normal"]).stdout;
  if (head !== expectedCommit || dirty.length > 0) {
    throw new Error("Checkout verification failed after deployment");
  }
  runCheckedSync("docker", ["compose", "config", "--quiet"]);
  const web = runCheckedSync("docker", ["compose", "ps", "--quiet", "web"]).stdout.trim();
  if (!web) throw new Error("Web service container is unavailable");
  const webStatus = runCheckedSync(
    "docker",
    [
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      web,
    ],
  ).stdout.trim();
  if (webStatus !== "healthy") throw new Error(`Web service is ${webStatus || "unknown"}`);
  const services = new Set(
    runCheckedSync(
      "docker",
      ["compose", "ps", "--status", "running", "--services"],
    ).stdout.trim().split(/\r?\n/u),
  );
  for (const service of RUNTIME_SERVICES) {
    if (!services.has(service)) throw new Error(`Runtime service is not running: ${service}`);
  }
  const curlArguments = ["--fail", "--silent", "--show-error", "--max-time", "10"];
  runCheckedSync("curl", [...curlArguments, plan.config.healthUrl]);
  const readiness = parseReadiness(
    runCheckedSync("curl", [...curlArguments, plan.config.readinessUrl]).stdout,
  );
  const drives = verifyDrives(plan.config, readiness);
  const failedUnitsAfter = failedSystemdUnits();
  const newFailedUnits = failedUnitsAfter.filter((line) => !plan.failedUnitsBefore.includes(line));
  if (newFailedUnits.length > 0) {
    throw new Error(`New failed systemd units: ${newFailedUnits.join(", ")}`);
  }
  const logs = runCheckedSync("docker", ["compose", "logs", "--since", "10m", "--no-color", ...RUNTIME_SERVICES]).stdout
    .split(/\r?\n/u)
    .filter((line) => /error|fail|fatal|panic|unhandled|exception|unhealthy/iu.test(line))
    .map((line) => sanitizeText(line, 4000, plan.config.storagePaths))
    .slice(-200);
  if (logs.length > 0) {
    throw new Error("Recent runtime logs contain error indicators; inspect the sanitized diagnostics");
  }
  return { head, webStatus, services: [...services], drives, failedUnitsAfter, suspiciousLogs: logs };
}

export function stopAndVerifyRuntime() {
  runCheckedSync("sh", [resolve(REPOSITORY_ROOT, "scripts/compose-stop.sh")]);
  const running = new Set(
    runCheckedSync("docker", ["compose", "ps", "--status", "running", "--services"])
      .stdout.trim().split(/\r?\n/u).filter(Boolean),
  );
  const remaining = RUNTIME_SERVICES.filter((service) => running.has(service));
  if (remaining.length > 0) {
    throw new Error(`Runtime services remain running after containment: ${remaining.join(", ")}`);
  }
  return { stoppedServices: RUNTIME_SERVICES };
}

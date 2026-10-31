import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
export const MAX_COMMAND_BYTES = 1_048_576;
export const MAX_LOG_BYTES = 1_048_576;

export function tailBytes(value, maximum = MAX_COMMAND_BYTES) {
  const buffer = Buffer.from(String(value ?? ""));
  if (buffer.length <= maximum) return buffer.toString("utf8");
  return `[earlier output omitted]\n${buffer.subarray(buffer.length - maximum).toString("utf8")}`;
}

export function sanitizeText(value, maximum = MAX_COMMAND_BYTES, privatePaths = []) {
  const withoutPrivateKeys = String(value ?? "")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .split(/\r?\n/u)
    .map((line) =>
      /\/(?:media\/(?:movies|originals)|mnt\/sandisk)(?:\/|\b)/iu.test(line)
        ? "[REDACTED_MEDIA_PATH]"
        : line,
    )
    .join("\n");
  const withoutConfiguredPaths = privatePaths
    .filter((path) => typeof path === "string" && path !== "/" && path.length > 1)
    .reduce((text, path) => text.replaceAll(path, "[REDACTED_MEDIA_PATH]"), withoutPrivateKeys);
  const redacted = withoutConfiguredPaths
    .replace(/\b([A-Z][A-Z0-9_]*)\s*=\s*[^\r\n]*/giu, "$1=[REDACTED]")
    .replace(/(["'][^"']*(?:private[_-]?key|password|secret|token|api[_-]?key)[^"']*["']\s*:\s*)(["'])[^"'\r\n]*\2/giu, "$1$2[REDACTED]$2")
    .replace(/(\bAuthorization\s*:\s*(?:Basic|Bearer)\s+)[^\r\n]*/giu, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[A-Z0-9._~+/-]+=*/giu, "$1[REDACTED]")
    .replace(/(\b(?:private[_-]?key|password|secret|token|api[_-]?key)\b\s*:\s*)[^\r\n]*/giu, "$1[REDACTED]")
    .replace(/(--?(?:private-key|password|secret|token|key)\s+)(["'])[^"'\r\n]*\2/giu, "$1$2[REDACTED]$2")
    .replace(/(--?(?:private-key|password|secret|token|key)\s+)[^\r\n]*?(?=\s+--?[A-Z][A-Z0-9-]*(?:\s|=)|$)/gimu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/[\t ]+$/gmu, "");
  return tailBytes(redacted, maximum);
}

export function createStreamSanitizer(write, privatePaths = []) {
  let pending = "";
  let insidePrivateKey = false;

  const emitLine = (line) => {
    if (insidePrivateKey) {
      if (/-----END [^-]+ PRIVATE KEY-----/iu.test(line)) insidePrivateKey = false;
      return;
    }
    if (/-----BEGIN [^-]+ PRIVATE KEY-----/iu.test(line)) {
      insidePrivateKey = true;
      write("[REDACTED PRIVATE KEY]\n");
      return;
    }
    write(sanitizeText(line, MAX_COMMAND_BYTES, privatePaths));
  };

  return {
    write(chunk) {
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        emitLine(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
      }
    },
    flush() {
      if (pending.length > 0) emitLine(pending);
      pending = "";
    },
  };
}

export function runCheckedSync(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAX_COMMAND_BYTES * 2,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const rawStdout = String(result.stdout ?? "");
  const rawStderr = String(result.stderr ?? "");
  const stdoutTruncated = Buffer.byteLength(rawStdout) > MAX_COMMAND_BYTES;
  const stderrTruncated = Buffer.byteLength(rawStderr) > MAX_COMMAND_BYTES;
  const stdout = tailBytes(rawStdout);
  const stderr = sanitizeText(rawStderr);
  if (result.error || result.status !== 0) {
    if (options.allowFailure) {
      return {
        status: result.status ?? 1,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      };
    }
    const reason = result.error?.message ?? stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`${executable} failed: ${reason}`);
  }
  return { status: 0, stdout, stderr, stdoutTruncated, stderrTruncated };
}

export async function runChecked(executable, arguments_, options = {}) {
  const child = spawn(executable, arguments_, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain both streams to completion, retaining only their leading bytes.
  // Exceeding the review budget must require review, not kill Git.
  const capture = (stream) => {
    const buffer = Buffer.alloc(MAX_COMMAND_BYTES);
    let length = 0;
    let truncated = false;
    stream.on("data", (chunk) => {
      const retained = Math.min(chunk.length, buffer.length - length);
      chunk.copy(buffer, length, 0, retained);
      length += retained;
      if (retained < chunk.length) truncated = true;
    });
    return {
      text: () => buffer.subarray(0, length).toString("utf8"),
      truncated: () => truncated,
    };
  };
  const stdoutCapture = capture(child.stdout);
  const stderrCapture = capture(child.stderr);
  let failure;
  child.on("error", (error) => { failure = error; });
  const status = await new Promise((resolveStatus) => child.on("close", resolveStatus));
  const stdoutTruncated = stdoutCapture.truncated();
  const stderrTruncated = stderrCapture.truncated();
  const stdout = stdoutCapture.text();
  // A cut-off credential or private-key block cannot be safely sanitized.
  const stderr = stderrTruncated
    ? "[stderr exceeded capture limit; output omitted]"
    : sanitizeText(stderrCapture.text());
  if (failure || status !== 0) {
    if (!options.allowFailure) {
      const reason = failure?.message ?? (stderr.trim() || `exit ${status}`);
      throw new Error(`${executable} failed: ${reason}`);
    }
  }
  return { status: status ?? 1, stdout, stderr, stdoutTruncated, stderrTruncated };
}

export function runStreaming(executable, arguments_, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      detached: options.killProcessGroup === true,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aborted = false;
    let killTimer;
    const signalChild = (signal) => {
      if (options.killProcessGroup === true && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      } else if (child.exitCode === null) {
        child.kill(signal);
      }
    };
    const abort = () => {
      aborted = true;
      signalChild("SIGTERM");
      killTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
    };
    const waitForProcessGroupExit = async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") return;
          throw error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      signalChild("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let stdout = "";
    let stderr = "";
    let log = "";
    try {
      log = readFileSync(options.logPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let flushTimer;
    const flushLog = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      writeFileSync(options.logPath, tailBytes(log, MAX_LOG_BYTES), {
        encoding: "utf8",
        mode: 0o600,
      });
    };
    const record = (channel, text) => {
      if (channel === "stdout") {
        stdout = tailBytes(`${stdout}${text}`);
        process.stdout.write(text);
      } else {
        stderr = tailBytes(`${stderr}${text}`);
        process.stderr.write(text);
      }
      log = tailBytes(`${log}${text}`, MAX_LOG_BYTES);
      if (!flushTimer) flushTimer = setTimeout(flushLog, 250);
    };
    const stdoutSanitizer = createStreamSanitizer(
      (text) => record("stdout", text),
      options.privatePaths,
    );
    const stderrSanitizer = createStreamSanitizer(
      (text) => record("stderr", text),
      options.privatePaths,
    );
    child.stdout.on("data", (chunk) => stdoutSanitizer.write(chunk));
    child.stderr.on("data", (chunk) => stderrSanitizer.write(chunk));
    child.on("error", (error) => {
      stdoutSanitizer.flush();
      stderrSanitizer.flush();
      record("stderr", sanitizeText(error.message, 2000, options.privatePaths));
      flushLog();
      resolvePromise({ status: 1, stdout, stderr });
    });
    child.on("close", async (status) => {
      options.signal?.removeEventListener("abort", abort);
      if (aborted && options.killProcessGroup === true) {
        signalChild("SIGKILL");
        await waitForProcessGroupExit();
      }
      if (killTimer) clearTimeout(killTimer);
      stdoutSanitizer.flush();
      stderrSanitizer.flush();
      flushLog();
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
  });
}

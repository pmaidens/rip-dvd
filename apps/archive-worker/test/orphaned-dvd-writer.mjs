import { spawn } from "node:child_process";

const [lockPath, partialPath, readyPath] = process.argv.slice(2);
if (lockPath === undefined || partialPath === undefined || readyPath === undefined) {
  process.stderr.write("orphaned writer fixture arguments are invalid\n");
  process.exit(2);
}

const writerSource = String.raw`
  import {
    closeSync,
    fsyncSync,
    openSync,
    writeFileSync,
    writeSync,
  } from "node:fs";

  const [partialPath, readyPath] = process.argv.slice(1);
  const descriptor = openSync(partialPath, "w", 0o600);
  writeSync(descriptor, Buffer.from("live partial"));
  fsyncSync(descriptor);
  writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
  process.on("SIGTERM", () => {});
  process.on("exit", () => closeSync(descriptor));
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
`;

const writerCommand = [
  process.execPath,
  "--input-type=module",
  "--eval",
  writerSource,
  partialPath,
  readyPath,
];
const writer = spawn(
  lockPath === "-" ? writerCommand[0] : "flock",
  lockPath === "-"
    ? writerCommand.slice(1)
    : [
        "--exclusive",
        "--nonblock",
        "--no-fork",
        lockPath,
        ...writerCommand,
      ],
  { detached: true, stdio: "ignore" },
);
if (writer.pid === undefined) {
  process.stderr.write("orphaned writer fixture did not start\n");
  process.exit(1);
}
process.stdout.write(String(writer.pid));
writer.unref();

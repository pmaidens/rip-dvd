import { appendFileSync, writeFileSync } from "node:fs";

const [readyPath, writePath] = process.argv.slice(2);
writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
appendFileSync(writePath, "started\n", { mode: 0o600 });
setInterval(() => appendFileSync(writePath, "write\n"), 25);

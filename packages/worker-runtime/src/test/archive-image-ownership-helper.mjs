import { writeFileSync } from "node:fs";

const [readyPath] = process.argv.slice(2);
writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
setInterval(() => undefined, 60_000);

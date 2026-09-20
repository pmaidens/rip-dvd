import { runArchiveAuditCli } from "./archive-audit-cli.js";

process.exitCode = await runArchiveAuditCli(process.argv.slice(2));

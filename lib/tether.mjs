import { stopTree } from "./proc.mjs";

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 1) process.exit(2);
process.stdin.once("close", () => { stopTree(pid).finally(() => process.exit(0)); });
process.stdin.resume();

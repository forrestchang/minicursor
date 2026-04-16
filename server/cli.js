#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootArg = process.argv[2];
const env = { ...process.env };
if (rootArg) {
  env.MINICURSOR_ROOT = path.resolve(process.cwd(), rootArg);
}

const child = spawn("node", [path.join(__dirname, "index.js")], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));

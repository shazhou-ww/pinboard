#!/usr/bin/env node
import { run } from "./cli.js";
import { CliError } from "./errors.js";

const controller = new AbortController();
const interrupt = () => {
  controller.abort(new CliError("INTERRUPTED", "Interrupted.", 130));
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    input: process.stdin,
    out: process.stdout,
    err: process.stderr,
    signal: controller.signal,
  });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}

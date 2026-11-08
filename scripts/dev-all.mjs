// Starts the API (port 3000) and the web app (port 5173) together, and stops both when either ends or on Ctrl+C.
// Plain node processes, no wrapper: on Windows a wrapper's child can be left running after the wrapper is stopped.
import { spawn } from "node:child_process";

const children = [
  { name: "api", args: ["node_modules/tsx/dist/cli.mjs", "watch", "server/dev.ts"] },
  { name: "web", args: ["node_modules/vite/bin/vite.js", "--host", "0.0.0.0"] },
].map(({ name, args }) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const tag = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`).join("\n") + "\n";
  child.stdout.on("data", (chunk) => process.stdout.write(tag(chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(tag(chunk)));
  child.on("exit", (code) => {
    console.log(`[${name}] stopped (${code ?? "signal"})`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

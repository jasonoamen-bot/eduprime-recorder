// Prepares everything the Docker image copies in, WITHOUT downloading inside Docker:
//   dist/            compiled TypeScript
//   .stage/node_modules   production-only dependencies (from the local npm cache when possible)
//
//   npm run image:prepare && docker build -t eduprime-recorder:dev .
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

console.log("compiling…");
run("node", ["node_modules/typescript/lib/tsc.js", "-p", "tsconfig.build.json"]);

console.log("staging production dependencies…");
rmSync(".stage", { recursive: true, force: true });
mkdirSync(".stage");
copyFileSync("package.json", ".stage/package.json");
copyFileSync("package-lock.json", ".stage/package-lock.json");
run("npm", ["ci", "--omit=dev", "--prefer-offline", "--no-audit", "--no-fund"], ".stage");

console.log("ready: docker build -t eduprime-recorder:dev .");

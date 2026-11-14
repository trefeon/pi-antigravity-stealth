import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import * as path from "node:path";

const require = createRequire(import.meta.url);
function resolveNpmProfile() {
  try {
    return require("npm-profile");
  } catch {}
  const appdata = process.env.APPDATA || "";
  if (appdata) {
    try {
      return require(path.join(appdata, "npm/node_modules/npm/node_modules/npm-profile"));
    } catch {}
  }
  throw new Error("Could not locate bundled npm-profile module.");
}
const profile = resolveNpmProfile();

console.log("Step 1: Running npm publish --json to acquire fresh 2FA challenge...");
const pubInit = spawnSync("npm.cmd", ["publish", "--access", "public", "--json"], {
  encoding: "utf8",
  shell: true,
});

let parsed = null;
const output = (pubInit.stdout || "") + "\n" + (pubInit.stderr || "");
try {
  parsed = JSON.parse(pubInit.stdout);
} catch {
  const match = output.match(/\{\s*"error"[\s\S]*"authUrl"[\s\S]*\}/);
  if (match) {
    parsed = JSON.parse(match[0]);
  }
}

if (!parsed?.error?.authUrl || !parsed?.error?.doneUrl) {
  console.error("Could not obtain authUrl/doneUrl from npm publish output:\n", output);
  process.exit(1);
}

const authUrl = parsed.error.authUrl;
const doneUrl = parsed.error.doneUrl;

console.log("\n========================================================");
console.log("Step 2: Browser authentication required by npm:");
console.log("Auth URL:", authUrl);
console.log("========================================================\n");
console.log("Opening browser to authenticate...");

const opener = (url) =>
  new Promise((resolve, reject) => {
    execFile("cmd", ["/c", "start", "", url], (error) => (error ? reject(error) : resolve()));
  });

console.log("Waiting for browser 2FA authorization (polling doneUrl)...");
try {
  const { token } = await profile.webAuthOpener(opener, authUrl, doneUrl, {
    registry: "https://registry.npmjs.org/",
    cache: false,
  });

  console.log("2FA verification received! Publishing to npm...");
  const pubResult = spawnSync("npm.cmd", ["publish", "--access", "public", "--otp", token], {
    encoding: "utf8",
    shell: true,
  });

  if (pubResult.stdout) console.log(pubResult.stdout);
  if (pubResult.stderr) console.error(pubResult.stderr);

  if (pubResult.status === 0) {
    console.log("✅ Successfully published pi-antigravity-stealth@1.2.5 to npm!");
  } else {
    console.error("Publish failed with exit code:", pubResult.status);
    process.exit(pubResult.status ?? 1);
  }
} catch (err) {
  console.error("Web auth flow error:", err);
  process.exit(1);
}

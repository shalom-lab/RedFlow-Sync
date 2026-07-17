#!/usr/bin/env node
/**
 * Zip Vite/CRX dist/ into release/redflow-sync-<version>.zip
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const outDir = resolve(root, "release");

if (!existsSync(distDir)) {
  console.error("dist/ not found. Run npm run build first.");
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(resolve(distDir, "manifest.json"), "utf8"),
);
const version = manifest.version || "0.0.0";
mkdirSync(outDir, { recursive: true });

const zipName = `redflow-sync-${version}.zip`;
const zipPath = resolve(outDir, zipName);
const latestPath = resolve(outDir, "redflow-sync-chrome.zip");

try {
  execFileSync("zip", ["-r", "-q", zipPath, "."], {
    cwd: distDir,
    stdio: "inherit",
  });
} catch {
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path (Join-Path '${distDir}' '*') -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    console.error("Failed to create zip:", err);
    process.exit(1);
  }
}

copyFileSync(zipPath, latestPath);

console.log(`Packaged ${zipName}`);
console.log("Also wrote release/redflow-sync-chrome.zip");

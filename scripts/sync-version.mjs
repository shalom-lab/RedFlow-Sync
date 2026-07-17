#!/usr/bin/env node
/**
 * Sync extension version into package.json + manifest.config.ts
 * Usage: node scripts/sync-version.mjs 1.2.3
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/sync-version.mjs <semver>");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const manifestPath = resolve(root, "manifest.config.ts");
const manifestSrc = readFileSync(manifestPath, "utf8");
const versionRe = /version:\s*["'][^"']+["']/;
if (!versionRe.test(manifestSrc)) {
  console.error("Failed to find version field in manifest.config.ts");
  process.exit(1);
}
writeFileSync(
  manifestPath,
  manifestSrc.replace(versionRe, `version: "${version}"`),
);

console.log(`Synced version → ${version}`);

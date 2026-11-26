#!/usr/bin/env node
/**
 * Release script for Distill v3.
 *
 * 1. Bumps the version — package.json and manifest.json are kept in sync
 *    (the manifest is the authoritative current version).
 * 2. Runs the quality gate (typecheck + full test suite) BEFORE touching
 *    version files, per CLAUDE.md rules.
 * 3. Runs the production build (vite reads manifest.json, so the bump
 *    happens first).
 * 4. Packages dist/ into web-ext-artifacts/distill-<version>.xpi.
 * 5. Promotes CHANGELOG.md's "Unreleased" entries under the new version and
 *    writes web-ext-artifacts/release-notes-<version>.md (the entries, install
 *    steps and a link to the full changelog) for `gh release create --notes-file`.
 *    A release with no Unreleased entries is refused up front.
 *
 * Usage:
 *   npm run release -- patch            # 3.0.0 → 3.0.1
 *   npm run release -- minor            # 3.0.0 → 3.1.0
 *   npm run release -- major            # 3.0.0 → 4.0.0
 *   npm run release -- 3.2.0            # explicit version
 *   npm run release -- patch --skip-checks   # skip typecheck + tests (not for real releases)
 *   npm run release -- patch --skip-changelog # release without changelog entries (not recommended)
 *
 * On build/packaging failure the version files are restored, so a failed
 * release never leaves a half-bumped tree.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { extractUnreleased, hasEntries, promoteUnreleased, buildReleaseNotes } from "./changelog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "manifest.json");
const packagePath = path.join(root, "package.json");
const changelogPath = path.join(root, "CHANGELOG.md");
const distDir = path.join(root, "dist");
const artifactsDir = path.join(root, "web-ext-artifacts");

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const skipChecks = args.includes("--skip-checks");
const skipChangelog = args.includes("--skip-changelog");
const bumpArg = args.find((a) => !a.startsWith("--")) ?? "patch";

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

function computeNewVersion(current, bump) {
  const explicit = /^\d+\.\d+\.\d+$/;
  if (explicit.test(bump)) {
    return bump;
  }
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    fail(`current manifest version "${current}" is not x.y.z`);
  }
  const [major, minor, patch] = parts;
  switch (bump) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default:
      fail(`unknown increment "${bump}" — use patch, minor, major, or an explicit x.y.z`);
  }
}

// ─── Version bump (manifest is authoritative; package.json follows) ─────────

const manifestRaw = readFileSync(manifestPath, "utf8");
const packageRaw = readFileSync(packagePath, "utf8");
const manifest = JSON.parse(manifestRaw);
const pkg = JSON.parse(packageRaw);

const currentVersion = manifest.version;
const newVersion = computeNewVersion(currentVersion, bumpArg);

console.log(`release: ${currentVersion} → ${newVersion} (${bumpArg})`);
if (pkg.version !== currentVersion) {
  console.log(`release: note — package.json was at ${pkg.version}; syncing to manifest`);
}

// ─── Changelog check (before any file is modified) ──────────────────────────

let changelogRaw = null;
let unreleasedBody = "";
if (skipChangelog) {
  console.log("release: --skip-changelog: NOT checking or updating CHANGELOG.md");
} else {
  try {
    changelogRaw = readFileSync(changelogPath, "utf8");
  } catch {
    fail("CHANGELOG.md not found — add one, or pass --skip-changelog");
  }
  const body = extractUnreleased(changelogRaw);
  if (body === null) fail("CHANGELOG.md has no '## [Unreleased]' section");
  if (!hasEntries(body)) {
    fail("CHANGELOG.md has no entries under '## [Unreleased]' — describe this release there first (or pass --skip-changelog)");
  }
  unreleasedBody = body;
}

// ─── Quality gate (before any file is modified) ──────────────────────────────

function run(command) {
  console.log(`\nrelease: ${command}`);
  execSync(command, { cwd: root, stdio: "inherit", shell: true });
}

if (skipChecks) {
  console.log("release: --skip-checks: SKIPPING typecheck and tests");
} else {
  run("npm run typecheck");
  run("npm test");
}

// ─── Write versions, build, package — restore on failure ────────────────────

manifest.version = newVersion;
pkg.version = newVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");

function restoreVersions() {
  writeFileSync(manifestPath, manifestRaw);
  writeFileSync(packagePath, packageRaw);
  console.error("release: version files restored to their previous state");
}

try {
  run("npm run build");

  // Collect dist/ files with forward-slash zip paths (required for Firefox)
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  })(distDir);

  if (!files.some((f) => path.basename(f) === "manifest.json")) {
    throw new Error("dist/ contains no manifest.json — build output looks wrong");
  }

  const zip = new JSZip();
  for (const file of files) {
    const zipPath = path.relative(distDir, file).split(path.sep).join("/");
    zip.file(zipPath, readFileSync(file));
  }

  mkdirSync(artifactsDir, { recursive: true });
  const xpiPath = path.join(artifactsDir, `distill-${newVersion}.xpi`);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  writeFileSync(xpiPath, buffer);

  // Changelog: move the Unreleased entries under this version and write the release notes
  let notesPath = null;
  if (changelogRaw !== null) {
    const today = new Date().toISOString().slice(0, 10);
    const promoted = promoteUnreleased(changelogRaw, newVersion, today); // throws before anything is written
    notesPath = path.join(artifactsDir, `release-notes-${newVersion}.md`);
    writeFileSync(notesPath, buildReleaseNotes({ version: newVersion, body: unreleasedBody }));
    writeFileSync(changelogPath, promoted); // last, so a failure above never leaves it half-promoted
  }

  const sizeKb = (buffer.length / 1024).toFixed(1);
  console.log(`\nrelease: OK`);
  console.log(`release: version   ${newVersion} (package.json + manifest.json in sync)`);
  console.log(`release: package   ${path.relative(root, xpiPath)} (${sizeKb} kB, ${files.length} files)`);
  if (notesPath) {
    console.log(`release: changelog CHANGELOG.md updated for ${newVersion}`);
    console.log(`release: notes     ${path.relative(root, notesPath)}`);
    console.log(`release: publish   gh release create v${newVersion} ${path.relative(root, xpiPath)} --title "Page Distill ${newVersion}" --notes-file ${path.relative(root, notesPath)}`);
  }
  console.log(`release: install via about:debugging (temporary) or sign via AMO/web-ext for permanent installs`);
} catch (err) {
  console.error(`\nrelease: FAILED — ${err instanceof Error ? err.message : err}`);
  restoreVersions();
  process.exit(1);
}

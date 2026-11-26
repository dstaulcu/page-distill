/**
 * CHANGELOG.md helpers for the release script (Keep a Changelog format).
 *
 *   ## [Unreleased]      <- work in progress, edited by hand
 *   ## [4.1.1] - 2026-…  <- released versions, newest first
 *
 * `npm run release` refuses to release with an empty Unreleased section, moves
 * its entries under the new version, and uses them as the GitHub release notes
 * (which link back to the full changelog).
 */

const UNRELEASED_HEADING = "## [Unreleased]";
const REPO_URL = "https://github.com/dstaulcu/page-distill";

/** The text between the Unreleased heading and the next version heading, trimmed. */
export function extractUnreleased(changelog) {
  const text = changelog.replace(/\r\n/g, "\n");
  const start = text.indexOf(UNRELEASED_HEADING);
  if (start === -1) return null;
  const afterHeading = start + UNRELEASED_HEADING.length;
  const next = text.slice(afterHeading).search(/^## \[/m);
  const end = next === -1 ? text.length : afterHeading + next;
  // Stop before the link-reference block at the very end, if there is no next version
  const body = text.slice(afterHeading, end).replace(/\n\[[^\]]+\]: .*$/gm, "");
  return body.trim();
}

/** True when the section contains at least one bullet entry. */
export function hasEntries(body) {
  return typeof body === "string" && /^\s*[-*] \S/m.test(body);
}

/**
 * Moves the Unreleased entries under a new `## [version] - date` heading, leaves a fresh
 * empty Unreleased section, and keeps the compare / release link references current.
 */
export function promoteUnreleased(changelog, version, date) {
  const crlf = changelog.includes("\r\n");
  let text = changelog.replace(/\r\n/g, "\n");
  if (!text.includes(UNRELEASED_HEADING)) throw new Error("CHANGELOG.md has no '## [Unreleased]' section");
  if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(text)) {
    throw new Error(`CHANGELOG.md already has an entry for ${version}`);
  }

  text = text.replace(UNRELEASED_HEADING, `${UNRELEASED_HEADING}\n\n## [${version}] - ${date}`);

  const unreleasedLink = text.match(/^\[Unreleased\]: (.*)\/compare\/v[^.]+\.[^.]+\.[^.]+\.\.\.HEAD$/m);
  if (unreleasedLink) {
    const base = unreleasedLink[1];
    text = text.replace(
      unreleasedLink[0],
      `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/releases/tag/v${version}`,
    );
  }
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

/** GitHub release notes: the version's changelog entries, install steps, and a link to the full history. */
export function buildReleaseNotes({ version, body, repoUrl = REPO_URL }) {
  return [
    `## Page Distill ${version}`,
    "",
    body.trim(),
    "",
    "### Install",
    "",
    `The attached \`distill-${version}.xpi\` is **unsigned**, so regular Firefox only loads it temporarily:`,
    "",
    `1. Download \`distill-${version}.xpi\` from the assets below.`,
    "2. In Firefox, open `about:debugging#/runtime/this-firefox`.",
    "3. Click **Load Temporary Add-on...** and choose the downloaded `.xpi` file.",
    "4. Open the sidebar from the toolbar or the View > Sidebar menu.",
    "",
    "It is removed when Firefox restarts, so repeat the steps then. For a permanent install, use Firefox Developer Edition, Nightly or ESR with `xpinstall.signatures.required` set to `false` in `about:config`, or sign the file through addons.mozilla.org.",
    "",
    `**Full changelog:** [CHANGELOG.md](${repoUrl}/blob/v${version}/CHANGELOG.md)`,
    "",
  ].join("\n");
}

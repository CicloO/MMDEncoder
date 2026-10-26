"use strict";
// Checks the project's GitHub Releases for a newer version and finds the
// portable/app ZIP and checksum for the in-place update (selfupdate.cjs).
const REPO = "CicloO/MMDEncoder";
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const DOWNLOAD_PREFIX = RELEASES_URL + "/download/";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const { appError } = require("./errors.cjs");
function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  return m ? m.slice(1, 4).map(Number) : null;
}
function newer(latest, current) {
  const a = parse(latest),
    b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
// Release assets for a version; only downloads from this repository count.
function assetsFor(release, version, { manifest, electronVersion } = {}) {
  const name = `MMDEncoder-${version}-win-x64.zip`;
  const find = (n) =>
    (release.assets || []).find(
      (a) =>
        a.name === n &&
        String(a.browser_download_url || "").startsWith(DOWNLOAD_PREFIX),
    );
  const zip = find(name),
    sha = find(name + ".sha256");
  if (!zip || !sha) return null;
  const full = {
    kind: "full",
    zipUrl: zip.browser_download_url,
    shaUrl: sha.browser_download_url,
    size: Number(zip.size) || 0,
    zipName: name,
  };
  // A complete application tree can skip versions, but may only reuse the
  // installed runtime when both the manifest and release assets agree.
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.version !== version ||
    !electronVersion ||
    manifest.electronVersion !== electronVersion
  )
    return full;
  const valid = (pkg, expectedName) => {
    const asset = find(expectedName);
    return (
      pkg?.name === expectedName &&
      asset &&
      find(expectedName + ".sha256") &&
      Number.isSafeInteger(pkg.size) &&
      pkg.size > 0 &&
      pkg.size === asset.size &&
      /^[a-f0-9]{64}$/i.test(pkg.sha256)
    );
  };
  const appName = `MMDEncoder-${version}-app.zip`;
  if (
    !valid(manifest.packages?.full, name) ||
    !valid(manifest.packages?.app, appName)
  )
    return full;
  return {
    kind: "app",
    zipUrl: find(appName).browser_download_url,
    shaUrl: find(appName + ".sha256").browser_download_url,
    size: manifest.packages.app.size,
    zipName: appName,
    sha256: manifest.packages.app.sha256,
    electronVersion,
    fallback: { ...full, sha256: manifest.packages.full.sha256 },
  };
}

async function checkForUpdate(
  current,
  fetchImpl = fetch,
  electronVersion = process.versions.electron,
) {
  const response = await fetchImpl(API_URL, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "MMDEncoder/" + current,
    },
  });
  if (response.status === 404)
    return { current, latest: "", newer: false, url: RELEASES_URL };
  if (!response.ok)
    throw appError("UPDATE_HTTP_STATUS", { status: response.status });
  const release = await response.json();
  const latest = String(release.tag_name || "").replace(/^v/i, "");
  if (!parse(latest))
    throw appError("UPDATE_VERSION_INVALID", {
      version: String(release.tag_name || ""),
    });
  let manifest;
  const manifestName = `MMDEncoder-${latest}-update.json`;
  const manifestAsset = (release.assets || []).find(
    (a) =>
      a.name === manifestName &&
      String(a.browser_download_url || "").startsWith(DOWNLOAD_PREFIX),
  );
  if (newer(latest, current) && manifestAsset) {
    try {
      const response = await fetchImpl(manifestAsset.browser_download_url, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "MMDEncoder/" + current },
      });
      if (response.ok) manifest = await response.json();
    } catch {
      // Older releases and an unavailable manifest keep the full-package path.
    }
  }
  const url = String(release.html_url || "");
  return {
    current,
    latest,
    newer: newer(latest, current),
    url: url.startsWith(RELEASES_URL + "/") ? url : RELEASES_URL,
    name: release.name || "",
    publishedAt: release.published_at || "",
    assets: assetsFor(release, latest, { manifest, electronVersion }),
  };
}
// Project pages the app may open (fixed, never from page content).
const PROJECT_PAGES = {
  home: `https://github.com/${REPO}`,
  releases: RELEASES_URL,
  issues: `https://github.com/${REPO}/issues`,
  license: `https://github.com/${REPO}/blob/main/LICENSE`,
  notices: `https://github.com/${REPO}/blob/main/docs/THIRD-PARTY-NOTICES.md`,
};
module.exports = {
  RELEASES_URL,
  PROJECT_PAGES,
  newer,
  checkForUpdate,
  assetsFor,
};

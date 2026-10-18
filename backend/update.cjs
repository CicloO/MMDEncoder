"use strict";
// Checks the project's GitHub Releases for a newer version and finds the
// portable ZIP and its .sha256 file for the in-place update (selfupdate.cjs).
const REPO = "CicloO/MMDEncoder";
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const DOWNLOAD_PREFIX = RELEASES_URL + "/download/";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
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
function assetsFor(release, version) {
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
  return {
    zipUrl: zip.browser_download_url,
    shaUrl: sha.browser_download_url,
    size: Number(zip.size) || 0,
    zipName: name,
  };
}

async function checkForUpdate(current, fetchImpl = fetch) {
  const response = await fetchImpl(API_URL, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "MMDEncoder/" + current,
    },
  });
  if (response.status === 404)
    return { current, latest: "", newer: false, url: RELEASES_URL };
  if (!response.ok) throw Error("GitHub 返回 " + response.status);
  const release = await response.json();
  const latest = String(release.tag_name || "").replace(/^v/i, "");
  if (!parse(latest)) throw Error("无法识别的发行版本号：" + release.tag_name);
  const url = String(release.html_url || "");
  return {
    current,
    latest,
    newer: newer(latest, current),
    url: url.startsWith(RELEASES_URL + "/") ? url : RELEASES_URL,
    name: release.name || "",
    publishedAt: release.published_at || "",
    assets: assetsFor(release, latest),
  };
}
module.exports = { RELEASES_URL, newer, checkForUpdate, assetsFor };

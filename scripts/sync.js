#!/usr/bin/env node
/**
 * Reads your udrop.com account, resolves a real direct-download link for
 * every file, builds a .zip for every folder (recursively), uploads the
 * zips as assets on a fixed GitHub Release, and writes files.json for the
 * static site to read. Everything happens here in Actions — the browser
 * never talks to udrop and never sees your API keys.
 *
 * Env (all provided automatically except the UDROP_ ones):
 *   GITHUB_TOKEN             auto-provided by Actions
 *   GITHUB_REPOSITORY        auto-provided by Actions ("owner/repo")
 *
 * Single account (unchanged from before):
 *   UDROP_KEY1, UDROP_KEY2   required — repo Actions secrets
 *   ROOT_FOLDER_ID           optional, only publish this folder + children
 *
 * Multiple accounts: set UDROP_ACCOUNT_NAMES to a comma-separated list of
 * display names, one per account, e.g.:
 *   UDROP_ACCOUNT_NAMES = School Drive, Personal Archive
 * Then for each position i (1-based), add secrets:
 *   UDROP_KEY1_i, UDROP_KEY2_i         required
 *   UDROP_ROOT_i                        optional (scope to one folder)
 * Each account shows up as its own top-level folder on the site, named
 * exactly as given in UDROP_ACCOUNT_NAMES. When UDROP_ACCOUNT_NAMES is set,
 * the single-account UDROP_KEY1/UDROP_KEY2/ROOT_FOLDER_ID vars are ignored.
 *
 * Costs of this approach vs. a live backend: every run that finds changes
 * re-downloads every file and rebuilds every zip from scratch. Fine for a
 * modest drive of scripts/PDFs; would get slow on a very large one.
 *
 * ---------------------------------------------------------------------
 * uploadg.com accounts (read-only — lists files and links to uploadg's own
 * share page; never fetches file bytes, so its ad-gated download page is
 * never bypassed and zips are never built for it):
 *
 *   UPLOADG_ACCOUNT_NAMES   comma-separated display names, one per account
 *   UPLOADG_TOKEN_i          required per position i (1-based) — API token
 *   UPLOADG_ROOT_i           optional, scope to one folder id
 *   UPLOADG_SHARE_URL_TEMPLATE   optional, default below. Must contain
 *                                 "{hash}" — set this to match a real share
 *                                 link you copy from your own uploadg
 *                                 dashboard if the default doesn't match.
 *
 * Each uploadg account becomes its own top-level folder, same as a udrop
 * account. Both provider types can be used together in the same site.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import archiver from 'archiver';

const API = 'https://www.udrop.com/api/v2';
const UPLOADG_API = 'https://uploadg.com/api/v1';
const UPLOADG_SHARE_URL_TEMPLATE = process.env.UPLOADG_SHARE_URL_TEMPLATE || 'https://uploadg.com/drive/s/{hash}';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO_NAME] = (process.env.GITHUB_REPOSITORY || '').split('/');
const RELEASE_TAG = 'file-zips';
const OUT = 'files.json';
const CACHE = '.udrop-cache';

if (!GITHUB_TOKEN || !OWNER || !REPO_NAME) {
  console.error('GITHUB_TOKEN / GITHUB_REPOSITORY not available (are you running this outside Actions?).');
  process.exit(1);
}

/** One account per entry, either provider: 'udrop' (key1/key2 pair) or
 *  'uploadg' (single bearer token). `name: null` on a udrop entry means
 *  "merge at the root" (legacy single-account behavior); every other
 *  account — udrop or uploadg — gets its own top-level folder named after
 *  it. */
function getAccounts() {
  const accounts = [];

  const udropNames = (process.env.UDROP_ACCOUNT_NAMES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (!udropNames.length) {
    const key1 = process.env.UDROP_KEY1;
    const key2 = process.env.UDROP_KEY2;
    if (key1 && key2) {
      accounts.push({ provider: 'udrop', name: null, key1, key2, rootFolderId: process.env.ROOT_FOLDER_ID || null });
    }
  } else {
    udropNames.forEach((name, i) => {
      const idx = i + 1;
      const key1 = process.env[`UDROP_KEY1_${idx}`];
      const key2 = process.env[`UDROP_KEY2_${idx}`];
      if (!key1 || !key2) {
        console.error(`Missing UDROP_KEY1_${idx} / UDROP_KEY2_${idx} for account "${name}".`);
        process.exit(1);
      }
      accounts.push({ provider: 'udrop', name, key1, key2, rootFolderId: process.env[`UDROP_ROOT_${idx}`] || null });
    });
  }

  const uploadgNames = (process.env.UPLOADG_ACCOUNT_NAMES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  uploadgNames.forEach((name, i) => {
    const idx = i + 1;
    const token = process.env[`UPLOADG_TOKEN_${idx}`];
    if (!token) {
      console.error(`Missing UPLOADG_TOKEN_${idx} for account "${name}".`);
      process.exit(1);
    }
    accounts.push({ provider: 'uploadg', name, token, rootFolderId: process.env[`UPLOADG_ROOT_${idx}`] || null });
  });

  if (!accounts.length) {
    console.error('No accounts configured: set UDROP_KEY1/UDROP_KEY2, UDROP_ACCOUNT_NAMES, or UPLOADG_ACCOUNT_NAMES.');
    process.exit(1);
  }
  return accounts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitize = (s) => (s || 'root').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80) || 'root';

// ---- udrop API -------------------------------------------------------

async function api(path, params = {}, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (res.status === 429 && attempt < 3) {
    const wait = 5 * (attempt + 1);
    console.warn(`Rate limited on ${path}; waiting ${wait}s`);
    await sleep(wait * 1000);
    return api(path, params, attempt + 1);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json._status === 'error') {
    throw new Error(`${path} -> ${json?.response || `HTTP ${res.status}`}`);
  }
  return json;
}

const authorize = async (key1, key2) => (await api('/authorize', { key1, key2 })).data;

const listFolder = async (auth, folderId) =>
  (await api('/folder/listing', {
    access_token: auth.access_token,
    account_id: auth.account_id,
    ...(folderId ? { parent_folder_id: folderId } : {}),
  })).data;

const fileDownloadUrl = async (auth, fileId) =>
  (await api('/file/download', {
    access_token: auth.access_token,
    account_id: auth.account_id,
    file_id: fileId,
  })).data.download_url;

/** Walk the whole tree, building both the flat list (for files.json) and a
 *  nested tree (for zipping), in one pass. */
async function walk(auth, folderId, trail, treeNode, flatOut) {
  const { folders = [], files = [] } = await listFolder(auth, folderId);

  for (const folder of folders) {
    const childTree = { id: folder.id, name: folder.folderName, children: [] };
    treeNode.children.push(childTree);
    flatOut.push({
      id: folder.id,
      name: folder.folderName,
      folder: true,
      path: trail,
      size: null,
      extension: null,
      modified: folder.date_updated || folder.date_added || null,
      description: null,
    });
    await walk(auth, folder.id, [...trail, folder.folderName], childTree, flatOut);
  }

  for (const file of files) {
    const downloadUrl = await fileDownloadUrl(auth, file.id);
    treeNode.children.push({ id: file.id, name: file.filename, isFile: true, downloadUrl });
    flatOut.push({
      id: file.id,
      name: file.filename,
      folder: false,
      path: trail,
      size: Number(file.fileSize) || 0,
      extension: file.extension || null,
      modified: null,
      description: file.keywords || null,
      downloadUrl,
    });
  }
}

// ---- uploadg API (read-only: list + share-link lookup only) -----------

async function uploadgApi(token, path, opts = {}, attempt = 0) {
  const res = await fetch(`${UPLOADG_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 5 * (attempt + 1);
    console.warn(`Rate limited on ${path}; waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return uploadgApi(token, path, opts, attempt + 1);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new Error(`${path} -> ${json?.message || `HTTP ${res.status}`}`);
  }
  return json;
}

/** List every entry in one folder (paginated). `folderId` null = account root. */
async function uploadgListFolder(token, folderId) {
  const entries = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      section: folderId ? 'folder' : 'home',
      perPage: '100',
      page: String(page),
      ...(folderId ? { folderId: String(folderId) } : {}),
    });
    const json = await uploadgApi(token, `/drive/file-entries?${qs}`);
    entries.push(...(json.data || []));
    if (page >= (json.last_page || 1)) break;
    page += 1;
  }
  return entries;
}

/** Get (or create) an entry's shareable link and return the public URL
 *  built from its hash. Never touches file bytes. */
async function uploadgShareUrl(token, entryId) {
  let json = await uploadgApi(token, `/file-entries/${entryId}/shareable-link`);
  if (!json.link) {
    json = await uploadgApi(token, `/file-entries/${entryId}/shareable-link`, {
      method: 'POST',
      body: JSON.stringify({ allowDownload: true }),
    });
  }
  return UPLOADG_SHARE_URL_TEMPLATE.replace('{hash}', json.link.hash);
}

/** Walk an uploadg account. Every node gets noZip:true so our OWN zip
 *  pipeline (buildZip/archiver/GitHub Releases) always skips it — see
 *  collectFiles() and zipAndPublishAll() below. Folders still get a
 *  "zipAsset": that's uploadg's own folder share page, which has its own
 *  native (ad-gated) "download whole folder" option — we're linking to
 *  uploadg's feature, not building a zip ourselves. */
async function walkUploadg(token, folderId, trail, treeNode, flatOut) {
  const entries = await uploadgListFolder(token, folderId);

  for (const entry of entries) {
    const isFolder = entry.type === 'folder';

    if (isFolder) {
      const childTree = { id: entry.id, name: entry.name, children: [], noZip: true };
      treeNode.children.push(childTree);
      const zipAsset = await uploadgShareUrl(token, entry.id);
      flatOut.push({
        id: entry.id,
        name: entry.name,
        folder: true,
        path: trail,
        size: null,
        extension: null,
        modified: entry.updated_at || entry.created_at || null,
        description: entry.description || null,
        zipAsset, // uploadg's own folder share page (has its own zip download)
      });
      await walkUploadg(token, entry.id, [...trail, entry.name], childTree, flatOut);
    } else {
      const downloadUrl = await uploadgShareUrl(token, entry.id);
      treeNode.children.push({ id: entry.id, name: entry.name, isFile: true, downloadUrl, noZip: true });
      flatOut.push({
        id: entry.id,
        name: entry.name,
        folder: false,
        path: trail,
        size: Number(entry.file_size) || 0,
        extension: entry.extension || null,
        modified: entry.updated_at || entry.created_at || null,
        description: entry.description || null,
        downloadUrl,
      });
    }
  }
}

// ---- local caching + zipping ------------------------------------------

async function downloadToCache(node) {
  const cachePath = join(CACHE, String(node.id));
  if (existsSync(cachePath)) return cachePath;
  const res = await fetch(node.downloadUrl);
  if (!res.ok) throw new Error(`download failed for ${node.name}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(cachePath));
  return cachePath;
}

/** Every file under `node`, recursively, with a path relative to `node`.
 *  Skips any subtree flagged noZip (uploadg entries — never fetched as
 *  bytes, so they never go in a zip, including the global root zip). */
function collectFiles(node, prefix, out) {
  for (const c of node.children) {
    if (c.noZip) continue;
    if (c.isFile) out.push({ ...c, zipPath: prefix + c.name });
    else collectFiles(c, prefix + c.name + '/', out);
  }
  return out;
}

async function buildZip(node, key) {
  const files = collectFiles(node, '', []);
  if (!files.length) return null;

  const zipPath = join(CACHE, `${sanitize(key)}.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const finished = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);

  for (const f of files) {
    const cached = await downloadToCache(f);
    archive.file(cached, { name: f.zipPath });
  }
  await archive.finalize();
  await finished;
  return zipPath;
}

// ---- GitHub Releases (used as static file hosting for the zips) -------

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json();
}

async function getOrCreateRelease() {
  try {
    return await gh(`/repos/${OWNER}/${REPO_NAME}/releases/tags/${RELEASE_TAG}`);
  } catch {
    return gh(`/repos/${OWNER}/${REPO_NAME}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        name: 'File zips (auto-generated)',
        body: 'Generated by sync.js. Do not edit or delete manually — it will be recreated on the next run.',
        prerelease: true,
      }),
    });
  }
}

async function uploadAsset(release, name, filePath) {
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) await gh(`/repos/${OWNER}/${REPO_NAME}/releases/assets/${existing.id}`, { method: 'DELETE' });

  const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(name)}`);
  const body = await readFile(filePath);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/zip' },
    body,
  });
  if (!res.ok) throw new Error(`asset upload failed for ${name}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()).browser_download_url;
}

/** Recursively zip + upload every folder in the tree, attaching zipAsset
 *  onto each matching entry in the flat list. */
async function zipAndPublishAll(tree, flatByKey, release) {
  async function visit(node, key) {
    if (node.noZip) return; // uploadg folder — never zipped
    const zipPath = await buildZip(node, key || 'root');
    if (zipPath) {
      const assetName = `${sanitize(key || 'root')}.zip`;
      const url = await uploadAsset(release, assetName, zipPath);
      const entry = flatByKey.get(key);
      if (entry) entry.zipAsset = url;
      else flatByKey.set('', { zipAsset: url }); // root
    }
    for (const c of node.children) {
      if (!c.isFile) await visit(c, key ? `${key}/${c.name}` : c.name);
    }
  }
  await visit(tree, '');
}

// ---- main ---------------------------------------------------------------

const accounts = getAccounts();
const flat = [];
const tree = { id: 'root', name: 'root', children: [] };

for (const acct of accounts) {
  if (acct.provider === 'uploadg') {
    // uploadg is always its own top-level folder (no legacy merge-at-root mode).
    const acctId = `acct:${acct.name}`;
    const acctTree = { id: acctId, name: acct.name, children: [], noZip: true };
    tree.children.push(acctTree);
    flat.push({
      id: acctId, name: acct.name, folder: true, path: [],
      size: null, extension: null, modified: null, description: null,
    });
    await walkUploadg(acct.token, acct.rootFolderId, [acct.name], acctTree, flat);
    continue;
  }

  // provider === 'udrop'
  const auth = await authorize(acct.key1, acct.key2);

  if (acct.name) {
    // Multi-account mode: this account gets its own top-level folder.
    const acctId = `acct:${acct.name}`;
    const acctTree = { id: acctId, name: acct.name, children: [] };
    tree.children.push(acctTree);
    flat.push({
      id: acctId,
      name: acct.name,
      folder: true,
      path: [],
      size: null,
      extension: null,
      modified: null,
      description: null,
    });
    await walk(auth, acct.rootFolderId, [acct.name], acctTree, flat);
  } else {
    // Single-account (legacy) mode: merge straight into the root.
    await walk(auth, acct.rootFolderId, [], tree, flat);
  }
}

flat.sort((a, b) => {
  if (a.folder !== b.folder) return a.folder ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
});

// download_url tokens are per-run and may expire, so files.json (and its
// links) get rewritten on EVERY run, even when nothing else changed. Only
// the expensive part — downloading every file's bytes and rebuilding zips —
// is skipped when the folder structure itself hasn't changed.
const prevRaw = await readFile(OUT, 'utf8').catch(() => '');
let prevParsed = null;
try { prevParsed = JSON.parse(prevRaw); } catch { /* no previous file, or unreadable */ }

const comparable = (list) =>
  JSON.stringify((list || []).map(({ id, name, folder, path, size }) => ({ id, name, folder, path, size })));
const structureChanged = comparable(prevParsed?.files) !== comparable(flat);

// Folders flagged noZip (uploadg) already have their zipAsset set by
// walkUploadg (uploadg's own folder share page) — never let the logic
// below, which only knows about zips *we* build, touch those.
function collectNoZipFolderKeys(node, key, out) {
  for (const c of node.children) {
    if (c.isFile) continue;
    const childKey = key ? `${key}/${c.name}` : c.name;
    if (c.noZip) out.add(childKey);
    collectNoZipFolderKeys(c, childKey, out);
  }
  return out;
}
const noZipFolderKeys = collectNoZipFolderKeys(tree, '', new Set());

let rootZip = prevParsed?.rootZip || null;
const prevZipByKey = new Map(
  (prevParsed?.files || [])
    .filter((f) => f.folder)
    .map((f) => [[...(f.path || []), f.name].join('/'), f.zipAsset || null])
);

if (structureChanged || !prevParsed) {
  await rm(CACHE, { recursive: true, force: true });
  await mkdir(CACHE, { recursive: true });

  const release = await getOrCreateRelease();
  const flatByKey = new Map();
  for (const f of flat) {
    if (f.folder) flatByKey.set([...(f.path || []), f.name].join('/'), f);
  }
  await zipAndPublishAll(tree, flatByKey, release);

  for (const f of flat) {
    if (!f.folder) continue;
    const key = [...(f.path || []), f.name].join('/');
    if (noZipFolderKeys.has(key)) continue; // leave uploadg's own share link alone
    f.zipAsset = flatByKey.get(key)?.zipAsset || null;
  }
  rootZip = flatByKey.get('')?.zipAsset || rootZip;

  await rm(CACHE, { recursive: true, force: true });
  console.log('Folder contents changed — rebuilt zips.');
} else {
  // Structure unchanged: carry forward the existing zip asset URLs untouched
  // (they're still correct — zips don't depend on udrop tokens) and only
  // refresh each file's download link.
  for (const f of flat) {
    if (!f.folder) continue;
    const key = [...(f.path || []), f.name].join('/');
    if (noZipFolderKeys.has(key)) continue; // already fresh from walkUploadg this run
    f.zipAsset = prevZipByKey.get(key) || null;
  }
  console.log('Folder contents unchanged — reused existing zips, refreshed file links only.');
}

await writeFile(OUT, JSON.stringify({
  files: flat,
  rootZip,
  generated: new Date().toISOString(),
}, null, 2) + '\n');

console.log(`Wrote ${flat.length} entries to ${OUT}.`);

// 通过 GitHub Git Data API 推送(绕开被阻断的 git-over-https 通道,走稳定的 api.github.com)。
// 递归同步:对本地与远端有差异的子树,自底向上上传缺失 blob 并重建 tree。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'studyguy/studyguy.github.io';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const message = process.argv[2] || 'sync via API';

const token = execSync('gh auth token').toString().trim();
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(p, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${p}`, { headers: H, ...opts });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
function lsTree(sha, prefix = '') {
  return execSync(`git ls-tree ${sha}`, { cwd: ROOT }).toString().trim().split('\n').filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{6})\s+(blob|tree)\s+([0-9a-f]{40})\t(.+)$/);
      return m && { mode: m[1], type: m[2], sha: m[3], path: prefix + m[4] };
    }).filter(Boolean);
}
async function blobExists(sha) {
  try { await api(`git/blobs/${sha}`); return true; } catch { return false; }
}
async function ensureBlob(sha, filePath) {
  if (await blobExists(sha)) return sha;
  const content = fs.readFileSync(path.join(ROOT, filePath));
  const b = await api('git/blobs', { method: 'POST', body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }) });
  return b.sha;
}
// 把本地树对象同步到远端,返回远端可用的树 sha;若与远端一致则原样返回。
async function syncTree(localSha, basePath, remoteBaseTree) {
  const entries = lsTree(localSha, basePath ? basePath + '/' : '');
  if (basePath) {
    const remoteSame = remoteBaseTree.find((t) => t.path === basePath);
    if (remoteSame && remoteSame.sha === localSha) return localSha; // 与远端一致
  }
  const tree = [];
  for (const e of entries) {
    if (e.type === 'blob') {
      tree.push({ path: e.path, mode: e.mode, type: 'blob', sha: await ensureBlob(e.sha, e.path) });
    } else {
      tree.push({ path: e.path, mode: e.mode, type: 'tree', sha: await syncTree(e.sha, e.path, remoteBaseTree) });
    }
  }
  const t = await api('git/trees', { method: 'POST', body: JSON.stringify({ tree }) });
  return t.sha;
}

const headSha = (await api('git/ref/heads/main')).object.sha;
const baseTreeSha = (await api(`git/commits/${headSha}`)).tree.sha;
const remoteBaseTree = (await api(`git/trees/${baseTreeSha}`)).tree;

// 顶层条目:全部走 syncTree(blob 直接确保,blob 存在则引用原 sha)
const topEntries = lsTree('HEAD');
const treeItems = [];
for (const e of topEntries) {
  if (e.type === 'blob') {
    treeItems.push({ path: e.path, mode: e.mode, type: 'blob', sha: await ensureBlob(e.sha, e.path) });
  } else {
    treeItems.push({ path: e.path, mode: e.mode, type: 'tree', sha: await syncTree(e.sha, e.path, remoteBaseTree) });
  }
}
// 远端根存在但本地已不存在的路径(如 site/)= 删除
for (const t of remoteBaseTree) {
  if (!topEntries.some((i) => i.path === t.path)) {
    treeItems.push({ path: t.path, mode: t.mode, type: t.type, sha: null });
  }
}

const newTree = await api('git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }) });
const newCommit = await api('git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }) });
await api('git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
console.log(`API push OK: ${newCommit.sha}`);
execSync('git fetch origin', { cwd: ROOT, stdio: 'ignore' });
execSync('git reset --soft origin/main', { cwd: ROOT });
console.log('local aligned with origin/main');

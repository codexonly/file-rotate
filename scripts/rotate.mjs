// file.kiwi 链接轮替 —— 自链（self-chaining）版
//
// 每次运行：
//   1. 读 README 里的当前链接 / 上一轮链接 / 轮替时间
//   2. 太新就跳过（避免一个下载窗口内重复搬 6GB）
//   3. 用 filekiwi-dlp 从「当前链接」下载源文件，失败则退到「上一轮链接」，
//      再失败才退到 SOURCE_URL（外部兜底，可选）
//   4. 校验 SHA-256（配置值 > README 里记录的值）
//   5. 新建 WebFolder + 端到端加密上传，得到新链接
//   6. 用 filekiwi probe 验证新链接确实能列出、能解密首块
//   7. 只有全部成功才改写 README —— 失败的运行不会破坏现有链接
//
// 关于取源：file.kiwi 官方 API 没有下载接口，但 Web 端接口（files/list +
// getdlurl）可以下载，filekiwi-dlp 就是走这条路。所以链条可以自持，
// 不需要外部对象存储；SOURCE_URL 只是链断了的救援手段。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createWebFolder, startUpload } from '@file-kiwi/node';

const README = process.env.README_PATH || 'README.md';
const START = '<!-- filekiwi:start -->';
const END = '<!-- filekiwi:end -->';

const SOURCE_URL = (process.env.SOURCE_URL || '').trim();
const SOURCE_SHA256 = (process.env.SOURCE_SHA256 || '').trim().toLowerCase();
const TITLE = (process.env.TITLE || '').trim() || '轮替文件';
const MIN_AGE_HOURS = Number(process.env.MIN_AGE_HOURS || 12);
const FORCE = /^(1|true|yes)$/i.test(process.env.FORCE || '');
const PLAN_ONLY = /^(1|true|yes)$/i.test(process.env.PLAN_ONLY || '');
const BIN = process.env.FILEKIWI_BIN || 'filekiwi';
const ENGINE = process.env.DOWNLOAD_ENGINE || 'aria2';
const ARIA2C = process.env.ARIA2C || '';
const WORK = path.resolve(process.env.WORK_DIR || 'work');

const SHARE_RE = /https:\/\/file\.kiwi\/[A-Za-z0-9]+#[A-Za-z0-9_-]+/g;
const STAMP_RE = /轮替时间\s*[：:]\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
const SHA_RE = /SHA-?256\s*[：:]\s*([0-9a-fA-F]{64})/i;

function log(msg) {
  console.log(msg);
}

function notice(msg) {
  console.log(`::notice::${msg}`);
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- README 读写 ------------------------------------------------------------

function readBlock(md) {
  const i = md.indexOf(START);
  const j = md.indexOf(END);
  if (i === -1 || j === -1 || j < i) return null;
  return md.slice(i + START.length, j);
}

function parseState(md) {
  const block = readBlock(md) ?? '';
  const urls = [...new Set(block.match(SHARE_RE) ?? [])];
  const stamp = block.match(STAMP_RE)?.[1] ?? null;
  return {
    block,
    current: urls[0] ?? null,
    previous: urls[1] ?? null,
    rotatedAt: stamp ? new Date(stamp) : null,
    sha256: block.match(SHA_RE)?.[1]?.toLowerCase() ?? null,
  };
}

function ageHours(state) {
  if (!state.rotatedAt || Number.isNaN(state.rotatedAt.getTime())) return Infinity;
  return (Date.now() - state.rotatedAt.getTime()) / 36e5;
}

function renderBlock({ url, stamp, expiresAt, file, sha256, previous, previousAt }) {
  const lines = [
    START,
    `**当前链接**：${url}`,
    '',
    `- 轮替时间：${stamp}`,
    `- 有效期至：${expiresAt}（免费下载窗口 ${Math.round((new Date(expiresAt) - new Date(stamp)) / 36e5)} 小时）`,
    `- 文件：${file.name}（${human(file.size)}）`,
    `- SHA-256：${sha256}`,
  ];
  if (previous) {
    lines.push(`- 上一轮链接（${previousAt ?? '时间未知'}，可能已失效）：${previous}`);
  }
  lines.push(END);
  return lines.join('\n');
}

function replaceBlock(md, block) {
  const i = md.indexOf(START);
  const j = md.indexOf(END);
  if (i === -1 || j === -1 || j < i) return `${md.trimEnd()}\n\n${block}\n`;
  return md.slice(0, i) + block + md.slice(j + END.length);
}

function human(n) {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// --- 子进程 -----------------------------------------------------------------

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let out = '';
    let err = '';
    if (capture) {
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// --- 下载 -------------------------------------------------------------------

async function downloadViaHttp(url, dir) {
  log(`\n[下载] 外部地址（HTTP）：${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'source.bin');
  const dest = path.join(dir, name);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  const { size } = await fsp.stat(dest);
  return { path: dest, name, size };
}

async function download(url, dir) {
  await fsp.mkdir(dir, { recursive: true });
  if (/^https:\/\/file\.kiwi\//.test(url)) {
    const args = ['get', url, '-o', dir, '--engine', ENGINE, '--conn', '16'];
    if (ARIA2C) args.push('--aria2c', ARIA2C);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      log(`\n[下载] 第 ${attempt}/3 次尝试（${ENGINE}）：${url}`);
      const code = await run(BIN, args)
        .then((r) => r.code)
        .catch(() => 1);
      if (code === 0) return pickFile(dir);
      log(`[下载] 失败（退出码 ${code}）`);
      if (attempt < 3) await sleep(5000 * attempt);
    }
    throw new Error(`下载失败，已重试 3 次：${url}`);
  }
  return downloadViaHttp(url, dir);
}

async function pickFile(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.endsWith('.part.json') || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    const st = await fsp.stat(p);
    files.push({ path: p, name: e.name, size: st.size });
  }
  if (!files.length) throw new Error(`下载目录里没有文件：${dir}`);
  files.sort((a, b) => b.size - a.size);
  return files[0];
}

async function sha256(file) {
  const hash = createHash('sha256');
  log(`[校验] 计算 SHA-256：${path.basename(file)}（${human(fs.statSync(file).size)}）`);
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// --- 上传 -------------------------------------------------------------------

async function upload(file) {
  log('\n[上传] 创建 WebFolder...');
  const webfolder = await createWebFolder({ title: TITLE, files: [{ filepath: file.path }] });
  log(`[上传] WebFolder：${webfolder.webfolderId}`);

  let lastPct = -1;
  await startUpload(webfolder, {
    resume: false,
    onProgress: (f, uploaded, total) => {
      const pct = total ? Math.floor((uploaded / total) * 100) : 0;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        process.stdout.write(`\r  已上传 ${uploaded}/${total} 个分片（${pct}%）`);
      }
    },
    onFileComplete: () => process.stdout.write('\n  上传完成\n'),
  });
  return webfolder;
}

async function verify(url) {
  log(`\n[校验] 验证新链接可下载：${url}`);
  const { code, out, err } = await run(BIN, ['probe', url], { capture: true });
  if (code !== 0) throw new Error(`新链接验证失败（退出码 ${code}）：${err.trim() || out.trim()}`);
  log(out.trim());
}

// --- 主流程 -----------------------------------------------------------------

async function main() {
  const md = fs.existsSync(README) ? await fsp.readFile(README, 'utf8') : '';
  const state = parseState(md);
  const age = ageHours(state);

  log(`[状态] 当前链接：${state.current ?? '（无）'}`);
  log(`[状态] 轮替时间：${state.rotatedAt?.toISOString() ?? '（无）'}（${Number.isFinite(age) ? age.toFixed(1) + ' 小时前' : '未知'}）`);

  if (state.current && age < MIN_AGE_HOURS && !FORCE) {
    notice(`链接仍新鲜（${age.toFixed(1)}h < ${MIN_AGE_HOURS}h），跳过本次轮替。`);
    return { skipped: true, url: state.current };
  }

  const candidates = [...new Set([state.current, state.previous, SOURCE_URL].filter(Boolean))];
  if (!candidates.length) {
    fail('没有可用的源：README 里没有链接，SOURCE_URL 也未设置。请手动运行并提供一个源地址。');
  }

  if (PLAN_ONLY) {
    notice(`[计划] 将按顺序尝试：${candidates.join(' → ')}`);
    return { skipped: true, url: state.current };
  }

  const dir = path.join(WORK, `src-${Date.now()}`);
  let file = null;
  const tried = [];
  for (const [i, url] of candidates.entries()) {
    try {
      file = await download(url, path.join(dir, `cand-${i}`));
      log(`[下载] 完成：${file.name}（${human(file.size)}）`);
      break;
    } catch (e) {
      tried.push(`${url} -> ${e.message}`);
      log(`[下载] 放弃该源：${e.message}`);
    }
  }
  if (!file) throw new Error(`所有源都下载失败：\n${tried.join('\n')}`);

  const actual = await sha256(file.path);
  const expected = SOURCE_SHA256 || state.sha256;
  if (expected && actual !== expected) {
    throw new Error(`SHA-256 不匹配：实际 ${actual}，期望 ${expected}`);
  }
  if (expected) log('[校验] SHA-256 一致');

  const webfolder = await upload(file);
  const url = webfolder.webfolderUrl;
  await verify(url);

  const hours = webfolder.files?.[0]?.freeDownloadHours ?? webfolder.retentionHours ?? 24;
  const stamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + hours * 36e5).toISOString();
  const block = renderBlock({
    url,
    stamp,
    expiresAt,
    file,
    sha256: actual,
    previous: state.current,
    previousAt: state.rotatedAt?.toISOString().slice(0, 16).replace('T', ' '),
  });

  await fsp.writeFile(README, replaceBlock(md, block));
  log(`\n[完成] README 已更新：${url}`);

  const summary = [
    '### 轮替完成',
    '',
    `- 新链接：${url}`,
    `- 有效期至：${expiresAt}（${hours}h）`,
    `- 文件：${file.name}（${human(file.size)}）`,
    `- SHA-256：\`${actual}\``,
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
  if (process.env.GITHUB_OUTPUT) {
    await fsp.appendFile(process.env.GITHUB_OUTPUT, `url=${url}\nrotated=true\n`);
  }
  return { skipped: false, url };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main()
    .then((r) => {
      if (r?.skipped && process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, 'rotated=false\n');
      }
    })
    .catch((e) => fail(e?.stack || String(e)));
}

export { parseState, renderBlock, replaceBlock, readBlock };

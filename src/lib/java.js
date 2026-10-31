'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getJson, download } = require('./net');
const { extractAll } = require('./zip');

const isWin = process.platform === 'win32';
const EXE = isWin ? 'java.exe' : 'java';

function probe(javaPath) {
  try {
    if (!fs.existsSync(javaPath)) return null;
    // java -version 把信息打到 stderr，需要同时读取两个流
    const r = spawnSync(javaPath, ['-version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const m = /version\s+"([^"]+)"/i.exec(text);
    if (!m) return null;
    const version = m[1];
    const parts = version.split(/[._+-]/);
    let major = parseInt(parts[0], 10) || 0;
    if (major === 1) major = parseInt(parts[1], 10) || 0;
    return { path: javaPath, version, major };
  } catch {
    return null;
  }
}

function* candidates(extraDirs) {
  if (process.env.JAVA_HOME) yield path.join(process.env.JAVA_HOME, 'bin', EXE);
  // 本启动器自带的运行时
  for (const d of extraDirs || []) {
    const found = findJavaIn(d);
    if (found) yield found;
  }
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files (x86)\\Minecraft Launcher\\runtime',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const full = path.join(root, d);
      const j = path.join(full, 'bin', EXE);
      if (fs.existsSync(j)) yield j;
      const nested = findJavaIn(full, 3);
      if (nested) yield nested;
    }
  }
  // PATH
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const p of paths) {
    const j = path.join(p, EXE);
    if (fs.existsSync(j)) yield j;
  }
}

function findJavaIn(dir, depth = 2) {
  if (!dir || depth < 0) return null;
  const direct = path.join(dir, 'bin', EXE);
  if (fs.existsSync(direct)) return direct;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const d of list) {
    if (!d.isDirectory()) continue;
    const found = findJavaIn(path.join(dir, d.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** 扫描系统中所有可用 Java，按大版本降序返回 */
function detectAll(extraDirs) {
  const seen = new Set();
  const result = [];
  for (const c of candidates(extraDirs)) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = probe(c);
    if (info && info.major >= 8) result.push(info);
  }
  result.sort((a, b) => b.major - a.major);
  return result;
}

/** 选择可用的 Java：优先用户指定，其次 >= minMajor 中版本最低的（更省内存） */
function pick(list, { preferred, minMajor = 17 }) {
  if (preferred) {
    const hit = list.find((j) => path.resolve(j.path).toLowerCase() === path.resolve(preferred).toLowerCase());
    if (hit) return hit;
    const p = probe(preferred);
    if (p) return p;
  }
  const ok = list.filter((j) => j.major >= minMajor);
  if (ok.length) return ok[ok.length - 1]; // 满足条件里版本最低的
  return list[0] || null;
}

async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'YaoshiLauncher/1.0.0' } });
    const n = Number(res.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 收集 Java 17 的下载源（国内镜像优先） */
async function javaSources(source, log) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const list = [];
  if (source !== 'official') {
    try {
      const listUrl = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jre/${arch}/windows/`;
      const res = await fetch(listUrl, { headers: { 'User-Agent': 'YaoshiLauncher/1.0.0' } });
      const html = await res.text();
      const re = new RegExp(`href="([^"]*OpenJDK17U-jre_${arch}_windows_hotspot_[^"]*\\.zip)"`, 'g');
      const names = [...html.matchAll(re)].map((m) => m[1]).sort();
      if (names.length) {
        const url = new URL(names[names.length - 1], listUrl).toString();
        list.push({ url, size: await headSize(url), label: '清华镜像' });
      }
    } catch {
      log('国内镜像不可用，改用官方源…');
    }
  }
  if (source !== 'mirror') {
    try {
      const api = `https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=${arch}&image_type=jre&os=windows&vendor=eclipse`;
      const assets = await getJson(api);
      const pkg = assets[0].binary.package;
      list.push({ url: pkg.link, size: pkg.size, label: 'Adoptium 官方' });
    } catch {
      log('官方 Java 源不可用');
    }
  }
  return list;
}

/** 下载 Temurin JRE 17 并解压，返回 java 信息 */
async function installJre17(runtimeDir, { log = () => {}, onProgress = () => {}, source = 'auto' } = {}) {
  log('正在获取 Java 17 运行时下载地址…');
  const sources = await javaSources(source, log);
  if (!sources.length) throw new Error('无法获取 Java 17 运行时（镜像与官方源均不可用）');

  fs.mkdirSync(runtimeDir, { recursive: true });
  const zipPath = path.join(runtimeDir, 'temurin-jre17.zip');
  let ok = false;
  let lastErr = null;

  for (const src of sources) {
    const mb = src.size ? `，${(src.size / 1048576).toFixed(1)} MB` : '';
    log(`从${src.label}下载 Java 17 运行时${mb}…`);
    let done = 0;
    let lastTick = 0;
    try {
      await download(src.url, zipPath, {
        retries: 1,
        onBytes: (n) => {
          done += n;
          const now = Date.now();
          if (now - lastTick > 120) {
            lastTick = now;
            onProgress({ bytes: done, total: src.size || 0, label: '下载 Java 17 运行时' });
          }
        },
      });
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      log(`该源下载失败（${e.message}），尝试下一个源…`);
    }
  }
  if (!ok) throw new Error(`Java 运行时下载失败：${lastErr && lastErr.message}`);
  onProgress({ bytes: 1, total: 1, label: '下载 Java 17 运行时' });

  log('下载完成，正在解压运行时…');
  const target = path.join(runtimeDir, 'jre17');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  extractAll(zipPath, target);
  fs.rmSync(zipPath, { force: true });

  const javaPath = findJavaIn(target, 4);
  if (!javaPath) throw new Error('解压完成但未找到 java 可执行文件');
  const info = probe(javaPath);
  if (!info) throw new Error('运行时校验失败');
  log(`Java 已就绪：${info.version}（${javaPath}）`);
  return info;
}

module.exports = { detectAll, pick, probe, installJre17, findJavaIn };

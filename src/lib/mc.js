'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getJson, downloadAny, pool } = require('./net');
const { extractAll } = require('./zip');

const VERSION_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const MIRROR_MANIFEST = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json';
const RESOURCE_BASE = 'https://resources.download.minecraft.net';
const LAUNCHER_NAME = 'YaoshiLauncher';
const LAUNCHER_VERSION = '1.0.0';

// 国内镜像（BMCLAPI）前缀映射
const MIRROR_RULES = [
  ['https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://launcher.mojang.com', 'https://bmclapi2.bangbang93.com'],
  ['https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/assets'],
  ['https://libraries.minecraft.net', 'https://bmclapi2.bangbang93.com/maven'],
];

function mirrorOf(url) {
  if (!url) return null;
  for (const [from, to] of MIRROR_RULES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return null;
}

/** 根据下载源设置返回候选 URL 列表 */
function urlSet(url, source = 'auto') {
  if (!url) return [];
  if (source === 'official') return [url];
  const m = mirrorOf(url);
  if (source === 'mirror') return [m || url];
  if (m && m !== url) return [m, url];
  return [url];
}

function mojangOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}
function mojangArch() {
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function ruleAllows(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== mojangOs()) match = false;
      if (rule.os.arch && rule.os.arch !== mojangArch()) match = false;
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) match = false;
        } catch { /* 忽略非法正则 */ }
      }
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== Boolean(v)) match = false;
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 现代版本中 natives 以独立依赖条目出现，形如 org.lwjgl:lwjgl:3.3.1:natives-windows */
function isNativesEntry(name) {
  return typeof name === 'string' && /:natives-[\w]+$/.test(name);
}

/** 当前平台应有的 natives 后缀，例如 natives-windows / natives-windows-x86 */
function desiredNativesSuffix() {
  const base = `natives-${mojangOs()}`;
  if (process.arch === 'ia32') return `${base}-x86`;
  if (process.arch === 'arm64') return `${base}-arm64`;
  return base;
}

function resolveLibraries(version) {
  const libs = [];
  const nativePool = []; // { group, suffix, path, url, size, name }

  for (const lib of version.libraries || []) {
    if (lib.rules && !ruleAllows(lib.rules)) continue;
    const dl = lib.downloads || {};

    // 1) 独立 natives 条目（1.19+ 写法）：group:artifact:version:natives-xxx
    if (isNativesEntry(lib.name)) {
      if (dl.artifact && dl.artifact.path) {
        const parts = lib.name.split(':');
        const suffix = parts.pop();
        nativePool.push({
          group: parts.join(':'),
          suffix,
          path: dl.artifact.path,
          url: dl.artifact.url,
          size: dl.artifact.size,
          name: lib.name,
        });
      }
      continue;
    }

    if (dl.artifact && dl.artifact.path) {
      libs.push({ path: dl.artifact.path, url: dl.artifact.url, size: dl.artifact.size });
    }

    // 2) 旧写法：classifiers 里的 natives-xxx
    if (dl.classifiers) {
      for (const [key, c] of Object.entries(dl.classifiers)) {
        if (!key.startsWith(`natives-${mojangOs()}`)) continue;
        if (!c || !c.path) continue;
        nativePool.push({ group: lib.name, suffix: key, path: c.path, url: c.url, size: c.size, name: `${lib.name}:${key}` });
      }
    }
  }

  // 3) 每个模块只保留与当前架构匹配的那一个，避免 x86 / x64 / arm64 的 DLL 互相覆盖
  const want = desiredNativesSuffix();
  const groups = new Map();
  for (const n of nativePool) {
    if (!groups.has(n.group)) groups.set(n.group, []);
    groups.get(n.group).push(n);
  }
  const natives = [];
  for (const list of groups.values()) {
    const exact = list.find((n) => n.suffix === want);
    if (exact) { natives.push(exact); continue; }
    const base = list.find((n) => n.suffix === `natives-${mojangOs()}`);
    if (base) natives.push(base);
  }

  return { libs, natives };
}

async function resolveVersionJson(versionId, log, source = 'auto') {
  log('正在读取版本清单…');
  const manifestUrls = source === 'official' ? [VERSION_MANIFEST] : [MIRROR_MANIFEST, VERSION_MANIFEST];
  let manifest = null;
  for (const u of manifestUrls) {
    try {
      manifest = await getJson(u);
      break;
    } catch (e) {
      log(`清单源不可用（${u.includes('bmclapi') ? '国内镜像' : '官方'}），尝试下一个…`);
    }
  }
  if (!manifest) throw new Error('无法获取版本清单，请检查网络连接');
  const entry = (manifest.versions || []).find((v) => v.id === versionId);
  if (!entry) throw new Error(`版本清单中不存在 ${versionId}`);
  log(`找到版本 ${versionId}（${entry.type}，发布于 ${String(entry.releaseTime).slice(0, 10)}）`);

  const jsonUrls = urlSet(entry.url, source);
  let lastErr;
  for (const u of jsonUrls) {
    try {
      return await getJson(u);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`获取版本详情失败：${lastErr && lastErr.message}`);
}

/** 把 natives 目录里的本地库文件再平铺一份到根目录，兼容按名直接加载的情况 */
function flattenNatives(nativesDir) {
  const exts = ['.dll', '.so', '.dylib'];
  const walk = (dir) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (!exts.some((e) => d.name.toLowerCase().endsWith(e))) continue;
      const target = path.join(nativesDir, d.name);
      if (fs.existsSync(target)) continue;
      try { fs.copyFileSync(full, target); } catch { /* 忽略 */ }
    }
  };
  walk(nativesDir);
}

/**
 * 安装（下载）指定版本的全部依赖
 * hooks: { log(msg), report({phase,label,bytes,total,filesDone,filesTotal}) }
 */
async function install(versionId, mcDir, hooks) {
  const { log = () => {}, report = () => {}, source = 'auto' } = hooks || {};
  const P = { phase: 'prepare', label: '准备中', bytes: 0, filesDone: 0, filesTotal: 1, total: 0 };
  let lastEmit = 0;
  const emit = (patch, force = false) => {
    Object.assign(P, patch);
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    report({ ...P });
  };
  const bump = (n) => { P.bytes += n; emit(); };

  emit({ label: '获取版本信息' }, true);
  const version = await resolveVersionJson(versionId, log, source);
  log(source === 'official' ? '下载源：官方' : source === 'mirror' ? '下载源：国内镜像' : '下载源：自动（国内镜像优先）');

  const vdir = path.join(mcDir, 'versions', versionId);
  const clientJar = path.join(vdir, `${versionId}.jar`);
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, `${versionId}.json`), JSON.stringify(version, null, 2), 'utf8');

  const { libs, natives } = resolveLibraries(version);
  const assetIndex = version.assetIndex || { id: version.assets, url: null };
  const loggingFile = version.logging && version.logging.client && version.logging.client.file;
  const logConfigPath = loggingFile ? path.join(mcDir, 'assets', 'log_configs', loggingFile.id) : null;

  const total =
    ((version.downloads && version.downloads.client && version.downloads.client.size) || 0) +
    ((loggingFile && loggingFile.size) || 0) +
    libs.reduce((s, l) => s + (l.size || 0), 0) +
    natives.reduce((s, n) => s + (n.size || 0), 0) +
    ((assetIndex && assetIndex.totalSize) || 0);

  log(`共需 ${libs.length} 个依赖库、${natives.length} 个本地库${assetIndex.totalSize ? `、约 ${(assetIndex.totalSize / 1048576).toFixed(0)} MB 资源文件` : ''}`);

  // ---------- 阶段一：客户端 / 依赖库 / 资源索引 ----------
  const tasks = [];
  if (version.downloads && version.downloads.client) {
    tasks.push({ urls: urlSet(version.downloads.client.url, source), dest: clientJar, size: version.downloads.client.size });
  }
  if (loggingFile && logConfigPath) {
    tasks.push({ urls: urlSet(loggingFile.url, source), dest: logConfigPath, size: loggingFile.size });
  }
  for (const lib of libs) {
    tasks.push({ urls: urlSet(lib.url, source), dest: path.join(mcDir, 'libraries', lib.path), size: lib.size });
  }
  for (const n of natives) {
    tasks.push({ urls: urlSet(n.url, source), dest: path.join(mcDir, 'libraries', n.path), size: n.size });
  }
  const indexPath = assetIndex.id ? path.join(mcDir, 'assets', 'indexes', `${assetIndex.id}.json`) : null;
  if (assetIndex.url && indexPath) {
    tasks.push({ urls: urlSet(assetIndex.url, source), dest: indexPath, size: assetIndex.size });
  }

  emit({ phase: 'download', label: '下载游戏核心文件', total, filesTotal: tasks.length, filesDone: 0 }, true);

  const runDownload = async (t) => {
    try {
      if (fs.existsSync(t.dest)) {
        const st = fs.statSync(t.dest);
        if (!t.size || st.size === t.size) {
          P.bytes += st.size;
          P.filesDone++;
          emit();
          return;
        }
      }
      await downloadAny(t.urls, t.dest, { onBytes: (n) => bump(n) });
      P.filesDone++;
      emit();
    } catch (e) {
      e.message = `下载 ${path.basename(t.dest)} 失败：${e.message}`;
      throw e;
    }
  };

  log('开始下载游戏核心文件…');
  await pool(tasks, 12, runDownload);
  emit({ label: '核心文件下载完成' }, true);
  log('核心文件下载完成');

  // ---------- 阶段二：解压 natives ----------
  const nativesDir = path.join(vdir, 'natives');
  emit({ phase: 'natives', label: '解压本地库（natives）' }, true);
  log(`解压本地库到 ${nativesDir}`);
  fs.rmSync(nativesDir, { recursive: true, force: true });
  fs.mkdirSync(nativesDir, { recursive: true });
  for (const n of natives) {
    const jar = path.join(mcDir, 'libraries', n.path);
    if (!fs.existsSync(jar)) continue;
    try {
      extractAll(jar, nativesDir, (name) => !name.endsWith('/') && !name.startsWith('META-INF'));
    } catch (e) {
      log(`警告：解压 ${path.basename(jar)} 失败 ${e.message}`);
    }
  }
  flattenNatives(nativesDir);

  // ---------- 阶段三：资源文件 ----------
  if (indexPath && fs.existsSync(indexPath)) {
    emit({ phase: 'assets', label: '校验资源文件' }, true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const objects = index.objects || {};
    const assetTasks = Object.values(objects).map((o) => ({
      urls: urlSet(`${RESOURCE_BASE}/${o.hash.slice(0, 2)}/${o.hash}`, source),
      dest: path.join(mcDir, 'assets', 'objects', o.hash.slice(0, 2), o.hash),
      size: o.size,
    }));
    log(`资源文件共 ${assetTasks.length} 个，开始下载…`);
    P.filesTotal += assetTasks.length;
    emit({ label: '下载游戏资源文件' }, true);

    let missing = 0;
    for (const t of assetTasks) if (!fs.existsSync(t.dest)) missing++;
    log(`其中 ${missing} 个需要下载，${assetTasks.length - missing} 个已存在`);

    await pool(assetTasks, 40, runDownload);
  }

  // ---------- 完成 ----------
  fs.writeFileSync(
    path.join(vdir, '.installed'),
    JSON.stringify({ versionId, installedAt: new Date().toISOString(), files: P.filesTotal, bytes: P.bytes }, null, 2)
  );
  emit({ phase: 'done', label: '安装完成', bytes: total, total, filesDone: P.filesTotal }, true);
  log('1.20.1 安装完成，可以启动游戏了。');
  return { versionId, files: P.filesTotal, bytes: total, clientJar };
}

/** 判断版本是否已经装好 */
function isInstalled(versionId, mcDir) {
  const vdir = path.join(mcDir, 'versions', versionId);
  return (
    fs.existsSync(path.join(vdir, '.installed')) &&
    fs.existsSync(path.join(vdir, `${versionId}.jar`)) &&
    fs.existsSync(path.join(vdir, `${versionId}.json`))
  );
}

/** 离线模式 UUID：与 Java 的 UUID.nameUUIDFromBytes("OfflinePlayer:" + name) 一致 */
function offlineUUID(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function flattenArguments(list, features) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') { out.push(item); continue; }
    if (!item) continue;
    if (item.rules && !ruleAllows(item.rules, features)) continue;
    if (typeof item.value === 'string') out.push(item.value);
    else if (Array.isArray(item.value)) out.push(...item.value);
  }
  return out;
}

function substitute(args, vars) {
  return args.map((a) =>
    a.replace(/\$\{([^}]+)\}/g, (_, key) => (key in vars ? String(vars[key]) : ''))
  );
}

/** 组装启动命令（不执行） */
function buildCommand({ version, versionId, mcDir, username, javaPath, memoryMb, width, height, uuid, accessToken }) {
  const { libs } = resolveLibraries(version);
  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = [
    ...libs.map((l) => path.join(mcDir, 'libraries', l.path)),
    path.join(mcDir, 'versions', versionId, `${versionId}.jar`),
  ].join(sep);

  const vdir = path.join(mcDir, 'versions', versionId);
  const nativesDir = path.join(vdir, 'natives');
  const assetsRoot = path.join(mcDir, 'assets');
  const assetsIndexName = (version.assetIndex && version.assetIndex.id) || version.assets || 'legacy';

  const vars = {
    auth_player_name: username,
    version_name: versionId,
    game_directory: mcDir,
    assets_root: assetsRoot,
    game_assets: path.join(assetsRoot, 'virtual', 'legacy'),
    assets_index_name: assetsIndexName,
    auth_uuid: uuid,
    auth_access_token: accessToken || '0',
    auth_session: `token:${accessToken || '0'}:${uuid}`,
    user_type: 'legacy',
    version_type: version.type || 'release',
    user_properties: '{}',
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    natives_directory: nativesDir,
    classpath,
    resolution_width: String(width || 854),
    resolution_height: String(height || 480),
    clientid: '',
    auth_xuid: '',
  };

  const argsObj = version.arguments || {};
  const jvmFromJson = flattenArguments(argsObj.jvm, {});
  const gameFromJson = flattenArguments(argsObj.game, {});

  let gameArgs = gameFromJson;
  if (!gameArgs.length && version.minecraftArguments) {
    gameArgs = version.minecraftArguments.split(/\s+/).filter(Boolean);
  }

  const mem = Math.max(512, Math.min(32768, Number(memoryMb) || 2048));
  const userJvm = [`-Xmx${mem}M`, `-Xms${Math.min(1024, Math.floor(mem / 2))}M`, '-XX:+UseG1GC', '-Dfile.encoding=UTF-8'];

  const jvmArgs = substitute([...userJvm, ...jvmFromJson], vars);

  // 日志配置（1.12+ 的 log4j 配置文件）
  const logging = version.logging && version.logging.client && version.logging.client.file;
  let logArg = null;
  if (logging) {
    const cfg = path.join(mcDir, 'assets', 'log_configs', logging.id);
    if (fs.existsSync(cfg)) {
      logArg = (version.logging.client.argument || '-Dlog4j.configurationFile=${path}').replace('${path}', cfg);
    }
  }
  if (logArg) jvmArgs.push(logArg);

  const mainClass = version.mainClass || 'net.minecraft.client.main.Main';
  const finalArgs = [...jvmArgs, mainClass, ...substitute(gameArgs, vars)];

  return { command: javaPath, args: finalArgs, cwd: mcDir, nativesDir, classpath };
}

/**
 * 启动游戏
 * @returns {{child, cmd}}
 */
function launch(opts) {
  const { onLog = () => {}, onExit = () => {} } = opts;
  const vdir = path.join(opts.mcDir, 'versions', opts.versionId);
  const jsonPath = path.join(vdir, `${opts.versionId}.json`);
  if (!fs.existsSync(jsonPath)) throw new Error('版本未安装：缺少版本 JSON');
  const version = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const uuid = offlineUUID(opts.username);
  const built = buildCommand({ ...opts, version, uuid });

  if (!fs.existsSync(built.nativesDir)) fs.mkdirSync(built.nativesDir, { recursive: true });
  fs.mkdirSync(opts.mcDir, { recursive: true });

  onLog(`启动命令: ${built.command} ${built.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, 'info');

  const child = spawn(built.command, built.args, {
    cwd: built.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, JAVA_TOOL_OPTIONS: '' },
  });

  // 把 log4j 的 XML 事件流还原成人类可读的一行行日志
  let inEvent = false;
  let buf = [];
  const flushEvent = () => {
    const joined = buf.join('\n');
    if (!joined.includes('</log4j:Event>')) return false;
    inEvent = false;
    buf = [];
    const level = (/level="(\w+)"/.exec(joined) || [])[1] || 'INFO';
    const msg = (/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/.exec(joined) || [])[1];
    if (msg && /Failed to verify authentication/.test(msg)) {
      onLog('离线模式：跳过正版验证（正常现象，不影响游戏）', 'info');
      return true;
    }
    if (!msg || !msg.trim()) return true;
    const lvl = level === 'ERROR' || level === 'FATAL' ? 'error' : level === 'WARN' ? 'warn' : 'game';
    onLog(msg.trim(), lvl);
    return true;
  };

  const feed = (line) => {
    if (line.includes('<log4j:Event')) {
      inEvent = true;
      buf = [line];
      flushEvent();
      return;
    }
    if (inEvent) {
      buf.push(line);
      if (!flushEvent()) {
        // 事件太长时避免无限堆积
        if (buf.length > 60) { inEvent = false; buf = []; }
      }
      return;
    }
    if (/^Picked up\s+JAVA_TOOL_OPTIONS:?\s*$/.test(line)) return;
    if (line.includes('</log4j:Throwable>') || line.startsWith(']]>')) return;
    onLog(line, 'game');
  };

  const pipe = (stream) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
      const lines = text.split(/\r?\n/);
      text = lines.pop() || '';
      for (const line of lines) feed(line);
    });
    stream.on('end', () => { if (text.trim()) feed(text); });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('error', (e) => onLog(`启动失败: ${e.message}`, 'error'));
  child.on('exit', (code) => onExit(code));

  return { child, built, uuid };
}

module.exports = { install, isInstalled, launch, buildCommand, resolveLibraries, resolveVersionJson, offlineUUID, mojangOs, LAUNCHER_NAME };

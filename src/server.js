'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const mc = require('./lib/mc');
const javaLib = require('./lib/java');

const ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(ROOT, 'ui');
const DATA_DIR = path.join(ROOT, 'data');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_MC_DIR = path.join(ROOT, '.minecraft');
const VERSION_ID = '1.20.1';
const REQUIRED_JAVA = 17;

const BASE_PORT = Number(process.env.PORT) || 37821;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RUNTIME_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_MC_DIR, { recursive: true });

// ---------------- 配置 ----------------
const defaultConfig = {
  username: '',
  memoryMb: 2048,
  javaPath: '',
  mcDir: DEFAULT_MC_DIR,
  width: 0,
  height: 0,
  source: 'auto', // auto | mirror | official
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaultConfig, ...raw };
  } catch {
    return { ...defaultConfig };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
let config = loadConfig();

// ---------------- Java 检测（带缓存） ----------------
let javaCache = { at: 0, list: [] };
function javaList(force = false) {
  if (force || Date.now() - javaCache.at > 60000) {
    try {
      javaCache = { at: Date.now(), list: javaLib.detectAll([RUNTIME_DIR]) };
    } catch (e) {
      javaCache = { at: Date.now(), list: [] };
    }
  }
  return javaCache.list;
}
function selectedJava(force = false) {
  return javaLib.pick(javaList(force), { preferred: config.javaPath, minMajor: REQUIRED_JAVA });
}

// ---------------- 任务系统 ----------------
const tasks = new Map();
function createTask(type, title) {
  const id = crypto.randomBytes(6).toString('hex');
  const task = {
    id,
    type,
    title,
    status: 'running',
    phase: 'start',
    label: '准备中',
    bytes: 0,
    total: 0,
    filesDone: 0,
    filesTotal: 0,
    speed: 0,
    logs: [],
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    _lastBytes: 0,
    _lastAt: Date.now(),
  };
  tasks.set(id, task);
  // 只保留最近 20 个任务
  if (tasks.size > 20) {
    const oldest = [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest && oldest.status !== 'running') tasks.delete(oldest.id);
  }
  return task;
}
function taskLog(task, msg, level = 'info') {
  const lines = String(msg).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    task.logs.push({ t: Date.now(), msg: line, level });
  }
  if (task.logs.length > 800) task.logs.splice(0, task.logs.length - 800);
}
function taskReport(task, p) {
  Object.assign(task, p);
  const now = Date.now();
  const dt = (now - task._lastAt) / 1000;
  if (dt > 0.3) {
    const delta = task.bytes - task._lastBytes;
    if (delta >= 0) {
      const inst = delta / dt;
      task.speed = task.speed ? task.speed * 0.6 + inst * 0.4 : inst;
    }
    task._lastBytes = task.bytes;
    task._lastAt = now;
  }
}
function taskDone(task, extra = {}) {
  task.status = 'done';
  task.endedAt = Date.now();
  Object.assign(task, extra);
}
function taskFail(task, err) {
  task.status = 'error';
  task.error = err && err.message ? err.message : String(err);
  task.endedAt = Date.now();
  taskLog(task, `错误：${task.error}`, 'error');
}
function serializeTask(task, from = 0) {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    phase: task.phase,
    label: task.label,
    bytes: task.bytes,
    total: task.total,
    filesDone: task.filesDone,
    filesTotal: task.filesTotal,
    speed: task.speed,
    error: task.error,
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    logFrom: from,
    logs: task.logs.slice(from).map((l) => l),
  };
}
function runningTask(type) {
  return [...tasks.values()].find((t) => t.type === type && t.status === 'running') || null;
}

// ---------------- 业务动作 ----------------
async function ensureJava(task) {
  let selected = selectedJava(true);
  if (selected && selected.major >= REQUIRED_JAVA) return selected;

  taskLog(task, `未检测到 Java ${REQUIRED_JAVA}+，准备自动安装 Temurin JRE 17…`);
  task.phase = 'java';
  taskReport(task, { label: '下载 Java 17 运行时' });
  const info = await javaLib.installJre17(RUNTIME_DIR, {
    log: (m) => taskLog(task, m),
    onProgress: (p) => taskReport(task, { bytes: p.bytes, total: p.total, label: p.label }),
    source: config.source,
  });
  javaCache = { at: 0, list: [] };
  return info;
}

async function doInstall(task) {
  const mcDir = config.mcDir || DEFAULT_MC_DIR;
  taskLog(task, `游戏目录：${mcDir}`);
  await ensureJava(task);
  await mc.install(VERSION_ID, mcDir, {
    log: (m) => taskLog(task, m),
    report: (p) => taskReport(task, p),
    source: config.source,
  });
  taskDone(task, { label: '安装完成' });
  taskLog(task, '全部文件已就绪', 'success');
}

async function doJavaInstall(task) {
  const info = await javaLib.installJre17(RUNTIME_DIR, {
    log: (m) => taskLog(task, m),
    onProgress: (p) => taskReport(task, { bytes: p.bytes, total: p.total, label: p.label }),
    source: config.source,
  });
  javaCache = { at: 0, list: [] };
  taskDone(task, { label: `Java ${info.version} 已安装` });
}

async function doLaunch(task) {
  const username = String(config.username || '').trim();
  if (!username) throw new Error('请先填写游戏用户名');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('用户名只能包含字母、数字和下划线，长度 3-16 位');
  }
  const mcDir = config.mcDir || DEFAULT_MC_DIR;
  if (!mc.isInstalled(VERSION_ID, mcDir)) throw new Error('1.20.1 尚未安装，请先点击「下载并安装」');

  const selected = await ensureJava(task);
  if (selected.major < REQUIRED_JAVA) {
    throw new Error(`当前 Java 版本为 ${selected.version}，1.20.1 需要 Java ${REQUIRED_JAVA} 或更高`);
  }
  taskLog(task, `使用 Java ${selected.version}（${selected.path}）`);
  taskLog(task, `离线账号：${username}`);

  task.phase = 'launching';
  taskReport(task, { label: '正在启动游戏', total: 0, bytes: 0 });

  const { child, uuid } = mc.launch({
    versionId: VERSION_ID,
    mcDir,
    username,
    javaPath: selected.path,
    memoryMb: config.memoryMb,
    width: config.width || 0,
    height: config.height || 0,
    onLog: (line, level) => taskLog(task, line, level || 'game'),
    onExit: (code) => {
      task.exitCode = code;
      if (task.stopping) {
        taskDone(task, { label: '游戏已结束' });
        taskLog(task, '游戏进程已结束。', 'success');
        return;
      }
      if (code === 0) {
        taskDone(task, { label: '游戏已退出' });
        taskLog(task, '游戏进程正常退出。', 'success');
      } else {
        task.status = 'error';
        task.error = `游戏异常退出（退出码 ${code}）`;
        task.endedAt = Date.now();
        task.label = '游戏异常退出';
        taskLog(task, `游戏异常退出，退出码 ${code}`, 'error');
      }
    },
  });

  taskReport(task, { label: `游戏运行中（UUID ${uuid.slice(0, 8)}…）` });
  task.proc = child;
  taskLog(task, '游戏进程已启动，正在加载…（首次启动需要生成材质，可能要 10-30 秒）', 'success');
}

async function doStop() {
  const launchTask = runningTask('launch');
  if (!launchTask || !launchTask.proc) throw new Error('当前没有正在运行的游戏');
  launchTask.stopping = true;
  taskLog(launchTask, '正在结束游戏进程…', 'error');
  const pid = launchTask.proc.pid;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('exit', resolve);
    killer.on('error', resolve);
  });
  return true;
}

// ---------------- HTTP ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function statePayload() {
  const mcDir = config.mcDir || DEFAULT_MC_DIR;
  const list = javaList();
  const sel = selectedJava();
  const installed = mc.isInstalled(VERSION_ID, mcDir);
  const installTask = runningTask('install');
  let versionInfo = null;
  try {
    const vdir = path.join(mcDir, 'versions', VERSION_ID);
    const marker = path.join(vdir, '.installed');
    if (fs.existsSync(marker)) versionInfo = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch { /* ignore */ }

  return {
    versionId: VERSION_ID,
    installed,
    versionInfo,
    mcDir,
    offlineUuid: config.username ? mc.offlineUUID(config.username) : '',
    java: {
      detected: list,
      selected: sel,
      ok: !!(sel && sel.major >= REQUIRED_JAVA),
      required: REQUIRED_JAVA,
      installing: !!(installTask && installTask.phase === 'java') || !!runningTask('java'),
    },
    config: {
      username: config.username,
      memoryMb: config.memoryMb,
      javaPath: config.javaPath,
      width: config.width,
      height: config.height,
      source: config.source,
    },
    tasks: {
      install: installTask ? installTask.id : null,
      launch: runningTask('launch') ? runningTask('launch').id : null,
      java: runningTask('java') ? runningTask('java').id : null,
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(UI_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!path.resolve(full).startsWith(path.resolve(UI_DIR))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/state') {
        return sendJson(res, 200, statePayload());
      }

      if (req.method === 'POST' && p === '/api/settings') {
        const body = await readBody(req);
        if (typeof body.username === 'string') config.username = body.username.slice(0, 16);
        if (body.memoryMb != null) config.memoryMb = Math.max(512, Math.min(32768, Number(body.memoryMb) || 2048));
        if (typeof body.javaPath === 'string') config.javaPath = body.javaPath;
        if (body.width != null) config.width = Math.max(0, Number(body.width) || 0);
        if (body.height != null) config.height = Math.max(0, Number(body.height) || 0);
        if (typeof body.source === 'string' && ['auto', 'mirror', 'official'].includes(body.source)) {
          config.source = body.source;
        }
        saveConfig(config);
        return sendJson(res, 200, { ok: true, config });
      }

      if (req.method === 'POST' && p === '/api/java/detect') {
        const list = javaList(true);
        return sendJson(res, 200, { list, selected: selectedJava(true) });
      }

      if (req.method === 'POST' && p === '/api/java/install') {
        if (runningTask('java')) return sendJson(res, 409, { error: '正在安装 Java' });
        const task = createTask('java', '安装 Java 17 运行时');
        doJavaInstall(task).catch((e) => taskFail(task, e));
        return sendJson(res, 200, { taskId: task.id });
      }

      if (req.method === 'POST' && p === '/api/version/install') {
        const running = runningTask('install');
        if (running) return sendJson(res, 200, { taskId: running.id, resumed: true });
        const task = createTask('install', '安装 Minecraft 1.20.1');
        task.total = 0;
        doInstall(task).catch((e) => taskFail(task, e));
        return sendJson(res, 200, { taskId: task.id });
      }

      if (req.method === 'POST' && p === '/api/version/launch') {
        const running = runningTask('launch');
        if (running) return sendJson(res, 200, { taskId: running.id, resumed: true });
        const task = createTask('launch', '启动 Minecraft 1.20.1');
        doLaunch(task).catch((e) => taskFail(task, e));
        return sendJson(res, 200, { taskId: task.id });
      }

      if (req.method === 'POST' && p === '/api/version/stop') {
        await doStop();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/quit') {
        sendJson(res, 200, { ok: true });
        const running = runningTask('launch');
        if (running && running.proc) {
          spawn('taskkill', ['/PID', String(running.proc.pid), '/T', '/F'], { windowsHide: true });
        }
        setTimeout(() => {
          try { server.close(); } catch { /* ignore */ }
          process.exit(0);
        }, 400);
        return undefined;
      }

      if (req.method === 'GET' && p === '/api/task') {
        const id = url.searchParams.get('id');
        const from = Number(url.searchParams.get('from') || 0);
        const task = tasks.get(id);
        if (!task) return sendJson(res, 404, { error: '任务不存在' });
        return sendJson(res, 200, serializeTask(task, from));
      }

      return sendJson(res, 404, { error: 'Unknown API' });
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    serveStatic(req, res, p);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// ---------------- 打开界面 ----------------
function openUi(url) {
  if (process.env.NO_OPEN === '1') return;
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const profile = path.join(DATA_DIR, 'ui-profile');
  for (const exe of edgeCandidates) {
    if (!fs.existsSync(exe)) continue;
    try {
      spawn(
        exe,
        [
          `--app=${url}`,
          '--window-size=1100,730',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate,msEdgeSplitScreen',
          `--user-data-dir=${profile}`,
        ],
        { detached: true, stdio: 'ignore', windowsHide: false }
      ).unref();
      return;
    } catch { /* 换下一个 */ }
  }
  // 兜底：默认浏览器
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

function listen(port, attempt = 0) {
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  曜石启动器已就绪  ->  ${url}\n  游戏目录: ${config.mcDir || DEFAULT_MC_DIR}\n`);
    openUi(url);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 10) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('服务启动失败：', e.message);
      process.exit(1);
    }
  });
}

listen(BASE_PORT);

process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
});

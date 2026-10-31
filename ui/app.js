'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  greeting: $('greeting'),
  subtitle: $('subtitle'),
  chipJava: $('chipJava'),
  chipVer: $('chipVer'),
  verDesc: $('verDesc'),
  meterFill: $('meterFill'),
  meterText: $('meterText'),
  meterRight: $('meterRight'),
  btnInstall: $('btnInstall'),
  btnJava: $('btnJava'),
  btnRedetect: $('btnRedetect'),
  btnLaunch: $('btnLaunch'),
  launchText: $('launchText'),
  username: $('username'),
  userHint: $('userHint'),
  uuidText: $('uuidText'),
  memory: $('memory'),
  memValue: $('memValue'),
  avatarImg: $('avatarImg'),
  avatarFallback: $('avatarFallback'),
  log: $('log'),
  liveDot: $('liveDot'),
  sideDot: $('sideDot'),
  sideVerState: $('sideVerState'),
  toastWrap: $('toastWrap'),
};

const STATE = {
  data: null,
  taskId: null,
  taskType: null,
  logFrom: 0,
  pollTimer: null,
  busy: false,
};

const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const fmtGB = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB');
const fmtSpeed = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : Math.max(0, Math.round(b / 1024)) + ' KB/s');

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  els.toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'error' ? 5200 : 3200);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------------- 日志 ----------------
function clearLog() {
  els.log.innerHTML = '<div class="log-line muted">等待操作…</div>';
}

function appendLogs(lines) {
  if (!lines || !lines.length) return;
  const first = els.log.querySelector('.muted');
  if (first && els.log.children.length === 1) els.log.innerHTML = '';

  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 60;
  for (const l of lines) {
    const div = document.createElement('div');
    div.className = `log-line ${l.level || 'info'}`;
    const d = new Date(l.t);
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    tsSpan.textContent = ts;
    div.appendChild(tsSpan);
    div.appendChild(document.createTextNode(l.msg));
    els.log.appendChild(div);
  }
  while (els.log.children.length > 1200) els.log.removeChild(els.log.firstChild);
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
}

// ---------------- 状态渲染 ----------------
function renderState(s) {
  STATE.data = s;

  // Java
  if (s.java.installing) {
    els.chipJava.className = 'chip';
    els.chipJava.innerHTML = '<i class="spinner"></i>准备 Java 17';
  } else if (s.java.ok && s.java.selected) {
    els.chipJava.className = 'chip ok';
    els.chipJava.textContent = `Java ${s.java.selected.version}`;
  } else if (s.java.detected.length) {
    els.chipJava.className = 'chip bad';
    els.chipJava.textContent = `Java ${s.java.detected[0].version}（需 17+）`;
  } else {
    els.chipJava.className = 'chip bad';
    els.chipJava.textContent = '未检测到 Java';
  }
  els.btnJava.hidden = s.java.ok;

  // 版本
  els.chipVer.className = 'chip ' + (s.installed ? 'ok' : '');
  els.chipVer.textContent = s.installed ? '1.20.1 已就绪' : '1.20.1 未安装';
  els.sideDot.className = 'dot ' + (s.installed ? 'ok' : 'warn');
  els.sideVerState.textContent = s.installed ? '已就绪' : '待安装';

  // 玩家
  if (!els.username.matches(':focus')) els.username.value = s.config.username || '';
  updateAvatar(s.offlineUuid);
  els.uuidText.textContent = s.offlineUuid || '—';
  els.memory.value = s.config.memoryMb;
  updateMemoryLabel();
  if (s.config.source) $('source').value = s.config.source;

  // 就绪文案
  if (s.installed) {
    els.greeting.textContent = s.config.username ? `你好，${s.config.username}` : '准备启动';
    els.subtitle.textContent = '客户端已就绪，填入用户名即可进入游戏。';
    els.verDesc.textContent = '客户端、依赖库与资源文件均已校验完成，可以开始游戏了。';
    els.meterFill.style.width = '100%';
    els.meterFill.className = 'meter-fill done';
    els.meterText.textContent = '已安装';
    els.meterRight.textContent = s.versionInfo ? `共 ${s.versionInfo.files || '—'} 个文件` : '';
  } else {
    els.greeting.textContent = '首次使用';
    els.subtitle.textContent = '需要先下载 1.20.1 的游戏文件（约 500 MB），首次安装请保持网络畅通。';
    els.verDesc.textContent = s.java.ok
      ? '尚未安装。点击下方按钮将自动下载客户端、依赖库、natives 与全部资源文件。'
      : '尚未安装。本机未检测到 Java 17，安装过程会自动下载官方 Temurin JRE 17 运行时。';
    if (!STATE.taskId) {
      els.meterFill.style.width = '0%';
      els.meterFill.className = 'meter-fill';
      els.meterText.textContent = '未安装';
      els.meterRight.textContent = '';
    }
  }
  renderButtons();
}

function renderButtons() {
  const s = STATE.data;
  if (!s) return;
  const installing = STATE.taskType === 'install' && STATE.busy;
  const launching = STATE.taskType === 'launch' && STATE.busy;

  els.btnInstall.disabled = installing || launching;
  els.btnInstall.textContent = installing ? '安装中…' : s.installed ? '重新校验文件' : '下载并安装';

  if (launching) {
    els.btnLaunch.disabled = false;
    els.btnLaunch.classList.remove('launching');
    els.btnLaunch.classList.add('stop');
    els.launchText.textContent = '结束游戏';
  } else if (installing) {
    els.btnLaunch.disabled = true;
    els.btnLaunch.classList.remove('stop');
    els.launchText.textContent = '正在安装 1.20.1…';
  } else if (!s.installed) {
    els.btnLaunch.disabled = false;
    els.btnLaunch.classList.remove('launching', 'stop');
    els.launchText.textContent = '下载并安装 1.20.1';
  } else {
    els.btnLaunch.disabled = false;
    els.btnLaunch.classList.remove('launching', 'stop');
    els.launchText.textContent = '启动游戏';
  }
}

function updateMemoryLabel() {
  const mb = Number(els.memory.value);
  els.memValue.textContent = mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
  const pct = ((mb - 512) / (8192 - 512)) * 100;
  els.memory.style.setProperty('--pct', pct + '%');
}

function updateAvatar(uuid) {
  if (!uuid) {
    els.avatarImg.hidden = true;
    els.avatarFallback.hidden = false;
    els.avatarFallback.textContent = '?';
    return;
  }
  const url = `https://mc-heads.net/avatar/${uuid}/64`;
  if (els.avatarImg.dataset.uuid === uuid) return;
  els.avatarImg.dataset.uuid = uuid;
  els.avatarFallback.hidden = false;
  els.avatarFallback.textContent = (els.username.value || '?').slice(0, 1).toUpperCase();
  els.avatarImg.onload = () => {
    els.avatarImg.hidden = false;
    els.avatarFallback.hidden = true;
  };
  els.avatarImg.onerror = () => {
    els.avatarImg.hidden = true;
  };
  els.avatarImg.src = url;
}

// ---------------- 任务轮询 ----------------
function watchTask(id, type) {
  STATE.taskId = id;
  STATE.taskType = type;
  STATE.busy = true;
  STATE.logFrom = 0;
  els.liveDot.classList.add('on');
  renderButtons();
  clearTimeout(STATE.pollTimer);
  poll();
}

async function poll() {
  const id = STATE.taskId;
  if (!id) return;
  try {
    const t = await api(`/api/task?id=${id}&from=${STATE.logFrom}`);
    appendLogs(t.logs);
    STATE.logFrom += t.logs.length;
    renderTask(t);
    if (t.status === 'running') {
      STATE.pollTimer = setTimeout(poll, STATE.taskType === 'launch' ? 1200 : 450);
    } else {
      finishTask(t);
    }
  } catch (e) {
    STATE.pollTimer = setTimeout(poll, 1500);
  }
}

function renderTask(t) {
  if (t.total > 0) {
    const pct = Math.min(100, (t.bytes / t.total) * 100);
    els.meterFill.style.width = pct.toFixed(1) + '%';
    els.meterText.textContent = `${t.label || '处理中'} ${pct.toFixed(0)}%`;
    const right = [];
    if (t.speed > 0 && t.status === 'running') right.push(fmtSpeed(t.speed));
    if (t.total) right.push(`${fmtGB(t.bytes)} / ${fmtGB(t.total)}`);
    els.meterRight.textContent = right.join(' · ');
  } else if (t.status === 'running') {
    els.meterText.textContent = t.label || '处理中';
  }

  if (t.type === 'launch' && t.status === 'running') {
    els.launchText.textContent = '结束游戏';
    els.btnLaunch.classList.add('stop');
    els.subtitle.textContent = '游戏进程已启动，查看下方日志可确认加载状态。';
  }
}

function finishTask(t) {
  STATE.busy = false;
  els.liveDot.classList.remove('on');

  if (t.status === 'error') {
    els.meterFill.className = 'meter-fill error';
    if (!els.meterFill.style.width || els.meterFill.style.width === '0%') els.meterFill.style.width = '100%';
    els.meterText.textContent = '失败：' + (t.error || '未知错误');
    toast(t.error || '操作失败', 'error');
  } else {
    if (t.type === 'install') {
      els.meterFill.style.width = '100%';
      els.meterFill.className = 'meter-fill done';
      els.meterText.textContent = '安装完成';
      els.meterRight.textContent = '';
      toast('Minecraft 1.20.1 安装完成', 'success');
    } else if (t.type === 'launch') {
      els.meterText.textContent = '游戏已退出';
      toast(t.exitCode === 0 ? '游戏已退出' : `游戏异常退出（${t.exitCode}）`, t.exitCode === 0 ? '' : 'error');
    } else if (t.type === 'java') {
      toast('Java 运行时已安装', 'success');
    }
  }

  STATE.taskId = null;
  STATE.taskType = null;
  refreshState();
}

// ---------------- 操作 ----------------
async function refreshState() {
  try {
    const s = await api('/api/state');
    renderState(s);
    // 恢复正在进行的任务
    if (!STATE.taskId) {
      if (s.tasks.install) watchTask(s.tasks.install, 'install');
      else if (s.tasks.launch) watchTask(s.tasks.launch, 'launch');
      else if (s.tasks.java) watchTask(s.tasks.java, 'java');
    }
  } catch (e) {
    els.subtitle.textContent = '无法连接启动器后端：' + e.message;
  }
}

async function saveSettings(patch, quiet = true) {
  try {
    const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    if (STATE.data) Object.assign(STATE.data.config, r.config);
    return r;
  } catch (e) {
    if (!quiet) toast('保存设置失败：' + e.message, 'error');
  }
}

async function startInstall() {
  if (STATE.busy) return;
  try {
    const r = await api('/api/version/install', { method: 'POST' });
    clearLog();
    watchTask(r.taskId, 'install');
    toast('开始安装 Minecraft 1.20.1');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function startLaunch() {
  const s = STATE.data;
  if (!s) return;
  if (!s.installed) return startInstall();

  const name = els.username.value.trim();
  if (!USER_RE.test(name)) {
    els.username.classList.add('invalid');
    els.username.focus();
    toast('用户名需为 3-16 位字母、数字或下划线', 'error');
    return;
  }
  await saveSettings({ username: name });

  try {
    const r = await api('/api/version/launch', { method: 'POST' });
    clearLog();
    watchTask(r.taskId, 'launch');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function stopGame() {
  try {
    await api('/api/version/stop', { method: 'POST' });
    toast('正在结束游戏…');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function installJava() {
  if (STATE.busy) return;
  try {
    const r = await api('/api/java/install', { method: 'POST' });
    clearLog();
    watchTask(r.taskId, 'java');
    toast('开始安装 Java 17 运行时');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 事件绑定 ----------------
els.btnInstall.addEventListener('click', startInstall);
els.btnLaunch.addEventListener('click', () => {
  if (STATE.taskType === 'launch' && STATE.busy) return stopGame();
  return startLaunch();
});
els.btnJava.addEventListener('click', installJava);
els.btnRedetect.addEventListener('click', async () => {
  els.chipJava.innerHTML = '<i class="spinner"></i>检测中';
  const r = await api('/api/java/detect', { method: 'POST' });
  await refreshState();
  toast(r.list.length ? `找到 ${r.list.length} 个 Java` : '未找到 Java，请点击安装');
});

let userTimer;
els.username.addEventListener('input', () => {
  const v = els.username.value.trim();
  els.username.classList.toggle('invalid', v.length > 0 && !USER_RE.test(v));
  els.avatarFallback.textContent = (v || '?').slice(0, 1).toUpperCase();
  clearTimeout(userTimer);
  userTimer = setTimeout(async () => {
    await saveSettings({ username: v });
    await refreshState();
  }, 400);
});
els.username.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startLaunch();
});

let memTimer;
els.memory.addEventListener('input', () => {
  updateMemoryLabel();
  clearTimeout(memTimer);
  memTimer = setTimeout(() => saveSettings({ memoryMb: Number(els.memory.value) }), 350);
});

$('btnClear').addEventListener('click', clearLog);
$('btnQuit').addEventListener('click', async () => {
  if (STATE.busy && STATE.taskType === 'launch') {
    toast('游戏正在运行，将一并结束游戏进程', '');
  }
  try {
    await api('/api/quit', { method: 'POST' });
  } catch { /* 进程已退出，忽略 */ }
  document.body.innerHTML =
    '<div style="height:100vh;display:grid;place-items:center;color:#7c8798;font-size:13px;text-align:center;line-height:2">' +
    '启动器已退出<br><span style="color:#4f5a69;font-size:11.5px">可以直接关闭此窗口，下次双击 start.bat 重新打开</span></div>';
});
$('source').addEventListener('change', async (e) => {
  await saveSettings({ source: e.target.value }, false);
  toast('下载源已切换为：' + e.target.options[e.target.selectedIndex].text);
});
$('btnCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.log.innerText);
    toast('日志已复制');
  } catch {
    toast('复制失败', 'error');
  }
});
$('navLog').addEventListener('click', () => els.log.parentElement.scrollIntoView({ behavior: 'smooth' }));
$('navVersion').addEventListener('click', () => document.querySelector('.version-card').scrollIntoView({ behavior: 'smooth' }));

document.addEventListener('DOMContentLoaded', () => {
  updateMemoryLabel();
  refreshState();
  setInterval(() => {
    if (!STATE.busy) refreshState();
  }, 8000);
});

refreshState();

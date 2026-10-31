'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const UA = 'YaoshiLauncher/1.0.0 (Windows; Node)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(600 * (i + 1));
    }
  }
  throw new Error(`获取 ${url} 失败: ${lastErr.message}`);
}

/**
 * 下载文件到 dest（先写 .part 再重命名），支持进度回调与重试
 * @param {string} url
 * @param {string} dest
 * @param {{onBytes?:(n:number)=>void, signal?:any, retries?:number}} opts
 */
async function download(url, dest, opts = {}) {
  const { onBytes, retries = 3 } = opts;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: opts.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = dest + '.part';
      const ws = fs.createWriteStream(tmp);
      let got = 0;
      try {
        for await (const chunk of res.body) {
          got += chunk.length;
          if (onBytes) onBytes(chunk.length);
          if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
        }
      } finally {
        await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
      }
      await fsp.rename(tmp, dest);
      return got;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`下载失败 ${url}: ${lastErr.message}`);
}

/** 依次尝试多个 URL，全部失败才抛错 */
async function downloadAny(urls, dest, opts = {}) {
  let lastErr;
  for (const url of urls) {
    try {
      return await download(url, dest, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('没有可用的下载地址');
}

/** 并发执行任务池 */
async function pool(items, concurrency, worker) {
  let idx = 0;
  const runners = new Array(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

module.exports = { getJson, download, downloadAny, pool, sleep };

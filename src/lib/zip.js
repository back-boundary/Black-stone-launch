'use strict';
// 极简 ZIP 读取器（支持 Zip64），只依赖 Node 内置 zlib。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function openZip(zipPath) {
  const buf = fs.readFileSync(zipPath);

  // 从尾部找 EOCD
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件: ' + zipPath);

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Zip64
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === EOCD64_LOC_SIG) {
        const z64Off = Number(buf.readBigUInt64LE(i + 8));
        if (buf.readUInt32LE(z64Off) === EOCD64_SIG) {
          entryCount = Number(buf.readBigUInt64LE(z64Off + 32));
          cdOffset = Number(buf.readBigUInt64LE(z64Off + 48));
        }
        break;
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);

    // Zip64 扩展字段
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
    }

    entries.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return { buf, entries };
}

function entryData(zip, entry) {
  const { buf } = zip;
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== LFH_SIG) throw new Error('坏损的 ZIP 条目: ' + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式 ' + entry.method + ': ' + entry.name);
}

function safeJoin(outDir, name) {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) return null;
  const full = path.join(outDir, clean);
  const root = path.resolve(outDir);
  if (!path.resolve(full).startsWith(root)) return null;
  return full;
}

/** 解压全部条目；filter(name) 返回 false 可跳过 */
function extractAll(zipPath, outDir, filter) {
  const zip = openZip(zipPath);
  fs.mkdirSync(outDir, { recursive: true });
  let count = 0;
  for (const entry of zip.entries) {
    if (filter && !filter(entry.name)) continue;
    const target = safeJoin(outDir, entry.name);
    if (!target) continue;
    if (entry.name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entryData(zip, entry));
    count++;
  }
  return count;
}

module.exports = { openZip, entryData, extractAll };

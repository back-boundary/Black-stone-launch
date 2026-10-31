async function probe(url) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'test' } });
    let got = 0;
    try { for await (const c of res.body) got += c.length; } catch (e) {}
    clearTimeout(timer);
    const dt = (Date.now() - t0) / 1000;
    console.log('  ' + res.status + ' ' + (got / 1024).toFixed(0) + 'KB in ' + dt.toFixed(1) + 's = ' + (got / 1024 / dt).toFixed(0) + ' KB/s');
  } catch (e) {
    console.log('  FAIL ' + e.name);
  }
}

(async () => {
  const listUrl = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jre/x64/windows/';
  const res = await fetch(listUrl, { headers: { 'User-Agent': 'test' } });
  const html = await res.text();
  const names = [...html.matchAll(/href="([^"]*OpenJDK17U-jre_x64_windows_hotspot_[^"]*\.zip)"/g)].map((m) => m[1]);
  console.log('TUNA 可用的 JRE 17 包:', names.slice(-3));
  if (names.length) {
    const url = new URL(names[names.length - 1], listUrl).toString();
    console.log('测试下载:', url);
    await probe(url);
  }
  const huawei = 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip';
  console.log('华为云 openjdk 17.0.2:');
  await probe(huawei);
})();

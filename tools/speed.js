const tests = [
  ['bmclapi manifest', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'],
  ['bmclapi lwjgl jar', 'https://bmclapi2.bangbang93.com/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar'],
  ['official lwjgl jar', 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar'],
];
async function speed(name, url, maxMs = 6000) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), maxMs);
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'test' } });
    let got = 0;
    try { for await (const c of res.body) got += c.length; } catch (e) {}
    clearTimeout(timer);
    const dt = (Date.now() - t0) / 1000;
    const kb = (got / 1024).toFixed(0);
    const kbs = (got / 1024 / dt).toFixed(0);
    console.log(name.padEnd(20) + ' ' + res.status + ' ' + kb + 'KB in ' + dt.toFixed(1) + 's = ' + kbs + ' KB/s');
  } catch (e) {
    console.log(name.padEnd(20) + ' FAIL ' + e.name + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
}
(async () => { for (const t of tests) await speed(t[0], t[1]); })();

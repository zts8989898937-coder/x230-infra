#!/usr/bin/env node
// X230 实时状态面板 —— 零依赖，读取 /proc 与 sysfs
'use strict';
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const PORT = 3081;
const SERVICES = ['sshd', 'smb', 'ntfy', 'netdata', 'dsh-web', 'tailscaled', 'clash-verge-service', 'hk-direct-route'];

let cpuPrev = null;
let netPrev = null;
let svcCache = { at: 0, data: {} };
let procCache = { at: 0, data: [] };

const rd = (p, d = '') => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return d; } };
const num = (p, d = 0) => { const v = parseFloat(rd(p, '')); return Number.isFinite(v) ? v : d; };

function cpuUsage() {
  const line = rd('/proc/stat', '').split('\n')[0];
  if (!line) return 0;
  const p = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (p[3] || 0) + (p[4] || 0);
  const total = p.reduce((a, b) => a + b, 0);
  if (!cpuPrev) { cpuPrev = { idle, total }; return 0; }
  const di = idle - cpuPrev.idle, dt = total - cpuPrev.total;
  cpuPrev = { idle, total };
  return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / dt))) : 0;
}

function memInfo() {
  const m = {};
  for (const l of rd('/proc/meminfo', '').split('\n')) {
    const [k, v] = l.split(':');
    if (k && v) m[k.trim()] = parseInt(v, 10) * 1024;
  }
  const total = m.MemTotal || 1;
  const avail = m.MemAvailable || 0;
  const swapTotal = m.SwapTotal || 0, swapFree = m.SwapFree || 0;
  return {
    total, used: total - avail, avail,
    pct: Math.round(100 * (total - avail) / total),
    swapTotal, swapUsed: swapTotal - swapFree,
    swapPct: swapTotal ? Math.round(100 * (swapTotal - swapFree) / swapTotal) : 0,
  };
}

function disk(mount) {
  try {
    const s = fs.statfsSync(mount);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - free, pct: Math.round(100 * (total - free) / total) };
  } catch { return null; }
}

function netRates() {
  const now = Date.now();
  const out = [];
  for (const l of rd('/proc/net/dev', '').split('\n')) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const name = l.slice(0, i).trim();
    if (!['enp0s25', 'tailscale0', 'Meta', 'wlp3s0'].includes(name)) continue;
    const f = l.slice(i + 1).trim().split(/\s+/).map(Number);
    out.push({ name, rx: f[0], tx: f[8], state: rd(`/sys/class/net/${name}/operstate`, 'unknown') });
  }
  const res = out.map(n => {
    const p = netPrev && netPrev[n.name];
    const dt = netPrev ? (now - netPrev.at) / 1000 : 0;
    const rxRate = p && dt > 0 ? Math.max(0, (n.rx - p.rx) / dt) : 0;
    const txRate = p && dt > 0 ? Math.max(0, (n.tx - p.tx) / dt) : 0;
    return { ...n, rxRate, txRate };
  });
  netPrev = { at: now, ...Object.fromEntries(out.map(n => [n.name, n])) };
  return res;
}

function temps() {
  const t = [];
  try {
    for (const d of fs.readdirSync('/sys/class/thermal')) {
      if (!d.startsWith('thermal_zone')) continue;
      const type = rd(`/sys/class/thermal/${d}/type`, d);
      const v = num(`/sys/class/thermal/${d}/temp`, NaN) / 1000;
      if (Number.isFinite(v)) t.push({ name: type, c: Math.round(v * 10) / 10 });
    }
  } catch {}
  return t;
}

function fan() {
  try {
    for (const d of fs.readdirSync('/sys/class/hwmon')) {
      const n = rd(`/sys/class/hwmon/${d}/name`, '');
      if (n === 'thinkpad') return num(`/sys/class/hwmon/${d}/fan1_input`, 0);
    }
  } catch {}
  return null;
}

function services() {
  if (Date.now() - svcCache.at < 5000) return svcCache.data;
  const data = {};
  try {
    const out = execSync(`systemctl is-active ${SERVICES.join(' ')} 2>/dev/null`, { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    SERVICES.forEach((s, i) => { data[s] = (lines[i] || 'unknown').trim(); });
  } catch (e) {
    const lines = (e.stdout || '').trim().split('\n');
    SERVICES.forEach((s, i) => { data[s] = (lines[i] || 'unknown').trim(); });
  }
  svcCache = { at: Date.now(), data };
  return data;
}

function topProcs() {
  if (Date.now() - procCache.at < 5000) return procCache.data;
  try {
    const out = execSync("ps -eo comm,%cpu,%mem --sort=-%cpu --no-headers | head -6", { encoding: 'utf8' });
    procCache = {
      at: Date.now(),
      data: out.trim().split('\n').map(l => {
        const [c, cpu, mem] = l.trim().split(/\s+/);
        return { c, cpu: parseFloat(cpu), mem: parseFloat(mem) };
      }),
    };
  } catch {}
  return procCache.data;
}

function freq() {
  const k = num('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 0);
  return k ? Math.round(k / 1000) : null;
}

function battery() {
  const cap = num('/sys/class/power_supply/BAT0/capacity', null);
  if (cap === null) return null;
  return { pct: cap, status: rd('/sys/class/power_supply/BAT0/status', '?'), ac: rd('/sys/class/power_supply/AC/online', '0') === '1' };
}

function collect() {
  const cpu = cpuUsage();
  const load = rd('/proc/loadavg', '0 0 0').split(' ').slice(0, 3).map(Number);
  const up = Math.round(num('/proc/uptime', 0));
  return {
    t: Date.now(),
    host: rd('/proc/sys/kernel/hostname', 'x230'),
    uptime: up,
    cpu: { pct: Math.round(cpu), load, freq: freq(), cores: 4 },
    mem: memInfo(),
    disk: { root: disk('/'), boot: disk('/boot') },
    net: netRates(),
    temps: temps(),
    fan: fan(),
    battery: battery(),
    services: services(),
    procs: topProcs(),
    kernel: rd('/proc/sys/kernel/osrelease', ''),
  };
}

const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>X230 状态</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--fg:#e6e9ef;--dim:#8b93a7;--ok:#3ddc84;--warn:#ffb020;--bad:#ff5c5c;--accent:#4c8dff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC",system-ui,sans-serif;padding:16px;padding-bottom:32px}
header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:6px}
h1{font-size:17px;margin:0;font-weight:600;letter-spacing:.3px}
.host{color:var(--dim);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{background:var(--card);border:1px solid #232733;border-radius:12px;padding:14px}
.card h2{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--dim);letter-spacing:.6px;text-transform:uppercase}
.big{font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.unit{font-size:14px;color:var(--dim);margin-left:2px}
.sub{color:var(--dim);font-size:12px;margin-top:6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.bar{height:6px;background:#242936;border-radius:3px;overflow:hidden;margin-top:10px}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:3px;transition:width .4s}
.bar.warn>i{background:var(--warn)}.bar.bad>i{background:var(--bad)}
.row{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:3px 0}
.row span:last-child{font-variant-numeric:tabular-nums;color:#cfd6e6}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:#555}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
.svc{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px}
.mono{font-variant-numeric:tabular-nums}
footer{margin-top:16px;color:#5d6577;font-size:11px;text-align:center}
</style></head><body>
<header><div><h1>X230 · 实时状态</h1><div class="host" id="host"></div></div><div class="host mono" id="clock"></div></header>
<div class="grid">
  <div class="card"><h2>CPU</h2><div class="big mono" id="cpuPct">–<span class="unit">%</span></div>
    <div class="bar" id="cpuBar"><i style="width:0%"></i></div>
    <div class="sub"><span id="cpuLoad">load –</span><span id="cpuFreq">–</span></div></div>
  <div class="card"><h2>内存</h2><div class="big mono" id="memPct">–<span class="unit">%</span></div>
    <div class="bar" id="memBar"><i style="width:0%"></i></div>
    <div class="sub"><span id="memTxt">–</span><span id="swapTxt">–</span></div></div>
  <div class="card"><h2>温度 / 风扇</h2><div class="big mono" id="tempBig">–<span class="unit">°C</span></div>
    <div class="sub"><span id="tempOther">–</span><span id="fanTxt">–</span></div></div>
  <div class="card"><h2>磁盘</h2><div class="big mono" id="diskPct">–<span class="unit">%</span></div>
    <div class="bar" id="diskBar"><i style="width:0%"></i></div>
    <div class="sub"><span id="diskTxt">–</span><span id="bootTxt">–</span></div></div>
  <div class="card"><h2>网络</h2><div id="netList"></div></div>
  <div class="card"><h2>电池</h2><div class="big mono" id="batPct">–<span class="unit">%</span></div>
    <div class="sub"><span id="batStatus">–</span><span id="batAc">–</span></div></div>
  <div class="card"><h2>服务</h2><div class="svc" id="svcList"></div></div>
  <div class="card"><h2>占用最高</h2><div id="procList"></div></div>
</div>
<footer id="foot">连接中…</footer>
<script>
const $=id=>document.getElementById(id);
const fmtB=b=>{if(b==null)return '–';const u=['B','K','M','G','T'];let i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}return b.toFixed(b<10?1:0)+u[i]};
const fmtRate=b=>fmtB(b)+'/s';
const pad=n=>String(n).padStart(2,'0');
function fmtUp(s){const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'天':'')+h+'时'+m+'分'}
function bar(el,pct){const i=el.querySelector('i');i.style.width=Math.min(100,pct)+'%';el.className='bar'+(pct>=90?' bad':pct>=75?' warn':'')}
async function tick(){
  try{
    const r=await fetch('/stats',{cache:'no-store'});if(!r.ok)throw 0;
    const d=await r.json();
    $('host').textContent=d.host+' · '+d.kernel;
    $('clock').textContent=new Date(d.t).toLocaleTimeString('zh-CN');
    $('cpuPct').innerHTML=d.cpu.pct+'<span class="unit">%</span>';
    bar($('cpuBar'),d.cpu.pct);
    $('cpuLoad').textContent='load '+d.cpu.load.join(' / ');
    $('cpuFreq').textContent=d.cpu.freq?d.cpu.freq+' MHz':'–';
    $('memPct').innerHTML=d.mem.pct+'<span class="unit">%</span>';
    bar($('memBar'),d.mem.pct);
    $('memTxt').textContent='已用 '+fmtB(d.mem.used)+' / '+fmtB(d.mem.total);
    $('swapTxt').textContent='zram '+fmtB(d.mem.swapUsed)+' / '+fmtB(d.mem.swapTotal);
    const core=d.temps.find(t=>/coretemp|x86_pkg/.test(t.name))||d.temps[0];
    $('tempBig').innerHTML=(core?core.c:'–')+'<span class="unit">°C</span>';
    $('tempOther').textContent=d.temps.filter(t=>t!==core).map(t=>t.name+' '+t.c+'°').join('  ')||'–';
    $('fanTxt').textContent=d.fan!=null?'风扇 '+d.fan+' RPM':'风扇 –';
    if(d.disk.root){$('diskPct').innerHTML=d.disk.root.pct+'<span class="unit">%</span>';bar($('diskBar'),d.disk.root.pct);
      $('diskTxt').textContent='根分区 '+fmtB(d.disk.root.used)+' / '+fmtB(d.disk.root.total);}
    $('bootTxt').textContent=d.disk.boot?'/boot '+fmtB(d.disk.boot.used):'';
    $('netList').innerHTML=d.net.map(n=>'<div class="row"><span>'+(n.state==='up'?'<span class="dot ok"></span>':'<span class="dot"></span>')+n.name+'</span><span>↓'+fmtRate(n.rxRate)+' ↑'+fmtRate(n.txRate)+'</span></div>').join('');
    if(d.battery){$('batPct').innerHTML=d.battery.pct+'<span class="unit">%</span>';
      $('batStatus').textContent=d.battery.status;$('batAc').textContent=d.battery.ac?'AC 已插':'电池供电';}
    $('svcList').innerHTML=Object.entries(d.services).map(([k,v])=>'<div><span class="dot '+(v==='active'?'ok':'bad')+'"></span>'+k+'</div>').join('');
    $('procList').innerHTML=d.procs.map(p=>'<div class="row"><span>'+p.c+'</span><span>'+p.cpu.toFixed(0)+'% / '+p.mem.toFixed(1)+'%</span></div>').join('');
    $('foot').textContent='运行 '+fmtUp(d.uptime)+' · 每 2 秒刷新';
  }catch(e){$('foot').textContent='连接失败，重试中…'}
}
tick();setInterval(tick,2000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/stats') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(collect()));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  res.writeHead(404); res.end('not found');
});

cpuUsage(); // 初始化基线
netRates();
server.listen(PORT, '0.0.0.0', () => console.log(`x230 status on :${PORT}`));

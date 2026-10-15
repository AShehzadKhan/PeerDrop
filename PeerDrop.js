#!/usr/bin/env node
/*
  PeerDrop Host – offline file sharing over a hotspot / any local network.
  No internet, no router, no npm install. Needs only Node.js (v14+).

  Run:   node peerdrop-host.js            (optional: --port 8080 --dir ./shared)
  Then:  open the address it prints on ANY device joined to the same hotspot/Wi-Fi.
*/
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const arg = process.argv.slice(2), opt = (n, d) => { const i = arg.indexOf('--' + n); return i > -1 ? arg[i + 1] : d; };
const PORT = +opt('port', 8080), DIR = path.resolve(opt('dir', 'shared'));
fs.mkdirSync(DIR, { recursive: true });

const texts = [];                       // shared notes / links (kept in memory)
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.pdf': 'application/pdf' };
const INLINE = /^(image|video|audio)\/|^application\/pdf$/;

const ips = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
const safe = n => { n = path.basename(String(n).replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 200); return n || 'file'; };
const uniq = n => { const e = path.extname(n), b = path.basename(n, e); let c = n, i = 1; while (fs.existsSync(path.join(DIR, c))) c = `${b} (${i++})${e}`; return c; };
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d)); } catch (e) { r({}); } }); });
const dec = s => { try { return decodeURIComponent(s); } catch (e) { return ''; } };

function list() {
  return fs.readdirSync(DIR, { withFileTypes: true }).filter(d => d.isFile() && !d.name.startsWith('.'))
    .map(d => { const s = fs.statSync(path.join(DIR, d.name)); return { name: d.name, size: s.size, time: s.mtimeMs }; })
    .sort((a, b) => b.time - a.time);
}

function serveFile(req, res, name, url) {
  const fp = path.join(DIR, safe(name));
  fs.stat(fp, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    const inline = INLINE.test(type) && !url.searchParams.has('dl');
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(path.basename(fp)) };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let s = m[1] ? +m[1] : st.size - +m[2], en = m[1] && m[2] ? +m[2] : st.size - 1;
      if (s > en || s >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      en = Math.min(en, st.size - 1);
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${s}-${en}/${st.size}`, 'Content-Length': en - s + 1 });
      return fs.createReadStream(fp, { start: s, end: en }).pipe(res);
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    fs.createReadStream(fp).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, M = req.method;
  try {
    if (M === 'GET' && p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAGE); }
    if (M === 'GET' && p === '/api/state') return json(res, { files: list(), texts, urls: ips(), port: PORT });
    if (M === 'GET' && p.startsWith('/f/')) return serveFile(req, res, dec(p.slice(3)), url);
    if (M === 'POST' && p === '/api/upload') {
      const orig = safe(dec(req.headers['x-filename'] || 'file'));
      const tmp = path.join(DIR, '.' + Date.now() + Math.random().toString(36).slice(2) + '.part');
      const ws = fs.createWriteStream(tmp);
      req.pipe(ws);
      ws.on('finish', () => { const name = uniq(orig); fs.renameSync(tmp, path.join(DIR, name)); console.log('  ⬇ received', name); json(res, { name }); });
      ws.on('error', () => { fs.unlink(tmp, () => {}); json(res, { error: 'write failed' }, 500); });
      req.on('aborted', () => { ws.destroy(); fs.unlink(tmp, () => {}); });
      return;
    }
    if (M === 'DELETE' && p.startsWith('/api/files/')) { fs.unlink(path.join(DIR, safe(dec(p.slice(11)))), () => json(res, { ok: 1 })); return; }
    if (M === 'POST' && p === '/api/text') {
      const t = String((await body(req)).text || '').slice(0, 100000);
      if (t.trim()) { texts.unshift({ id: Date.now() + '' + Math.random().toString(36).slice(2, 6), text: t, time: Date.now() }); texts.length = Math.min(texts.length, 50); }
      return json(res, { ok: 1 });
    }
    if (M === 'DELETE' && p.startsWith('/api/text/')) { const i = texts.findIndex(x => x.id === p.slice(10)); if (i > -1) texts.splice(i, 1); return json(res, { ok: 1 }); }
    res.writeHead(404); res.end('Not found');
  } catch (e) { res.writeHead(500); res.end('Error'); }
});
server.requestTimeout = 0; server.timeout = 0;
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: node peerdrop-host.js --port 8081` : e.message); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => {
  const u = ips().map(ip => `http://${ip}:${PORT}`);
  console.log('\n  PeerDrop Host is running  ✔\n');
  console.log('  On your other device (same hotspot / Wi-Fi) open:\n');
  (u.length ? u : ['(no network found – turn on a hotspot or join one)']).forEach(x => console.log('      ' + x));
  console.log('\n  Received files are saved in: ' + DIR);
  console.log('  Press Ctrl+C to stop.\n');
});

const PAGE = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#4f46e5">
<title>PeerDrop</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔄</text></svg>">
<style>
:root{--bg:#f5f6fb;--card:#fff;--tx:#161a2b;--mu:#6b7287;--ac:#4f46e5;--ac2:#eef0ff;--bd:#e3e6f0;--ok:#16a34a;--er:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0e111b;--card:#171b29;--tx:#eceffa;--mu:#98a0b8;--ac:#6d74ff;--ac2:#1f2440;--bd:#272d44}}
*{box-sizing:border-box}html,body{margin:0}
body{font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx);padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
.hidden{display:none!important}
header{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--card);border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:5}
.logo{font-weight:800;font-size:20px}.logo i{color:var(--ac);font-style:normal}
.pill{margin-left:auto;font-size:13px;padding:4px 10px;border-radius:99px;background:var(--ac2);display:flex;align-items:center;gap:6px}
.pill:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok)}.pill.off:before{background:var(--er)}
main{max-width:680px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:16px;margin-bottom:14px}
h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between;align-items:center}h3 small{color:var(--mu);font-weight:400}
.mu{color:var(--mu);font-size:14px}
.urls{display:flex;gap:8px;flex-wrap:wrap}.urls button{font:600 14px ui-monospace,Menlo,Consolas,monospace}
.zone{border:2px dashed var(--bd);border-radius:14px;padding:26px 12px;text-align:center;cursor:pointer;transition:.15s}
.zone.over,.zone:hover{border-color:var(--ac);background:var(--ac2)}.zone b{display:block;font-size:18px}.zone .em{font-size:34px}
button{font:inherit;cursor:pointer;border:1px solid var(--bd);background:var(--card);color:var(--tx);border-radius:10px;padding:8px 14px}
button.pri{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:600}
textarea{width:100%;font:inherit;color:var(--tx);background:var(--bg);border:1px solid var(--bd);border-radius:12px;padding:10px 12px;resize:vertical}
.row{display:flex;gap:8px;margin-top:8px;justify-content:flex-end}
.it{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--bd)}.it:first-of-type{border-top:0}
.ic{font-size:26px;width:44px;height:44px;display:grid;place-items:center;flex:none;border-radius:10px;background:var(--ac2);overflow:hidden}.ic img{width:100%;height:100%;object-fit:cover}
.in{flex:1;min-width:0}.nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acts{display:flex;gap:6px;flex:none}.acts a,.acts button{padding:6px 12px;font-size:14px;border-radius:10px;text-decoration:none}
.acts a{background:var(--ac);color:#fff}
.bar{height:5px;border-radius:5px;background:var(--bd);margin:6px 0 2px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--ok)}
.tx{white-space:pre-wrap;word-break:break-word}.tx a{color:var(--ac)}
.empty{text-align:center;color:var(--mu);padding:14px}
#toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#111;color:#fff;padding:8px 16px;border-radius:99px;font-size:14px;z-index:10}
</style></head><body>
<header><div class="logo">Peer<i>Drop</i></div><div class="pill" id="pill">Connected</div></header>
<main>
<div class="card" id="urlCard"><h3>Open on another device <small>same hotspot / Wi‑Fi</small></h3><div class="urls" id="urls"></div></div>

<div class="card"><h3>Send files <small>from this device</small></h3>
<div class="zone" id="zone"><div class="em">📤</div><b>Tap to choose files</b><span class="mu">or drag &amp; drop them here</span></div>
<input type="file" id="pick" multiple hidden><div id="queue"></div></div>

<div class="card"><h3>Shared files <small id="fcount"></small></h3><div id="files"></div></div>

<div class="card"><h3>Text &amp; links</h3>
<textarea id="txt" rows="2" placeholder="Type or paste text / a link to share…"></textarea>
<div class="row"><button class="pri" id="txtSend">Share text</button></div><div id="texts"></div></div>
</main>
<div id="toast" class="hidden"></div>
<script>
var $=function(s){return document.querySelector(s)};
function h(t,p,k){var e=document.createElement(t);p=p||{};for(var a in p){var v=p[a];if(a==='class')e.className=v;else if(a==='text')e.textContent=v;else if(a.slice(0,2)==='on')e.addEventListener(a.slice(2),v);else e.setAttribute(a,v)}(k||[]).forEach(function(c){if(c!=null)e.append(c)});return e}
function fmt(n){return n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB'}
function ago(t){var s=(Date.now()-t)/1000;return s<60?'just now':s<3600?Math.floor(s/60)+' min ago':s<86400?Math.floor(s/3600)+' h ago':new Date(t).toLocaleDateString()}
var tt;function toast(m){var e=$('#toast');e.textContent=m;e.classList.remove('hidden');clearTimeout(tt);tt=setTimeout(function(){e.classList.add('hidden')},1800)}
function copy(t){var ok=function(){toast('Copied ✓')};if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(t).then(ok,fb);else fb();function fb(){var a=h('textarea');a.value=t;document.body.append(a);a.select();try{document.execCommand('copy')}catch(e){}a.remove();ok()}}
function icon(n){n=n.toLowerCase();return/\.(png|jpe?g|gif|webp|heic|svg)$/.test(n)?'🖼️':/\.(mp4|mov|mkv|webm|avi)$/.test(n)?'🎬':/\.(mp3|wav|m4a|flac|ogg)$/.test(n)?'🎵':/\.(zip|rar|7z|tar|gz)$/.test(n)?'🗜️':/\.(pdf|docx?|xlsx?|pptx?|txt)$/.test(n)?'📄':/\.apk$/.test(n)?'📦':'📎'}
function linkify(t){var f=document.createDocumentFragment();t.split(/(https?:\/\/[^\s]+)/g).forEach(function(p){f.append(/^https?:\/\//.test(p)?h('a',{href:p,target:'_blank',rel:'noopener',text:p}):p)});return f}

/* ---- state polling ---- */
var last='';
function poll(){fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){$('#pill').textContent='Connected';$('#pill').classList.remove('off');var j=JSON.stringify(s);if(j!==last){last=j;render(s)}}).catch(function(){$('#pill').textContent='Host unreachable';$('#pill').classList.add('off')})}
function render(s){
 var u=$('#urls');u.replaceChildren();s.urls.forEach(function(ip){var url='http://'+ip+':'+s.port;u.append(h('button',{text:url,title:'Tap to copy',onclick:function(){copy(url)}}))});
 if(!s.urls.length)u.append(h('span',{class:'mu',text:'No network detected on the host.'}));
 var f=$('#files');f.replaceChildren();$('#fcount').textContent=s.files.length?s.files.length+' file'+(s.files.length>1?'s':''):'';
 if(!s.files.length)f.append(h('div',{class:'empty',text:'Nothing here yet – send a file from either device.'}));
 s.files.forEach(function(x){var href='/f/'+encodeURIComponent(x.name);var ic=h('div',{class:'ic'});
  if(/\.(png|jpe?g|gif|webp|svg)$/i.test(x.name)&&x.size<4e6)ic.append(h('img',{src:href,loading:'lazy'}));else ic.textContent=icon(x.name);
  f.append(h('div',{class:'it'},[ic,h('div',{class:'in'},[h('div',{class:'nm',text:x.name}),h('div',{class:'mu',text:fmt(x.size)+' · '+ago(x.time)})]),
   h('div',{class:'acts'},[h('a',{href:href+'?dl=1',download:x.name,text:'Download'}),h('button',{text:'🔗',title:'Copy link',onclick:function(){copy(location.origin+href+'?dl=1')}}),
    h('button',{text:'✕',title:'Delete',onclick:function(){if(confirm('Delete '+x.name+'?'))fetch('/api/files/'+encodeURIComponent(x.name),{method:'DELETE'}).then(poll)}})])]))});
 var t=$('#texts');t.replaceChildren();
 s.texts.forEach(function(x){t.append(h('div',{class:'it'},[h('div',{class:'in tx'},[linkify(x.text)]),h('div',{class:'acts'},[h('button',{text:'Copy',onclick:function(){copy(x.text)}}),h('button',{text:'✕',onclick:function(){fetch('/api/text/'+x.id,{method:'DELETE'}).then(poll)}})])]))})}
setInterval(function(){if(!document.hidden)poll()},2000);poll();

/* ---- uploads ---- */
var qs=[],active=0;
function add(files){for(var i=0;i<files.length;i++)qs.push({file:files[i],pct:0,st:'wait',el:null});draw();pump()}
function pump(){while(active<2){var it=qs.find(function(x){return x.st==='wait'});if(!it)return;send(it)}}
function send(it){it.st='up';active++;var x=new XMLHttpRequest();x.open('POST','/api/upload');x.setRequestHeader('X-Filename',encodeURIComponent(it.file.name));
 x.upload.onprogress=function(e){if(e.lengthComputable){it.pct=e.loaded/e.total*100;it.bar.style.width=it.pct+'%';it.sub.textContent=fmt(e.loaded)+' / '+fmt(e.total)}};
 x.onload=function(){active--;if(x.status===200){qs.splice(qs.indexOf(it),1);toast('Sent '+it.file.name+' ✓');poll()}else{it.st='err';it.sub.textContent='Failed'}draw();pump()};
 x.onerror=function(){active--;it.st='err';it.sub.textContent='Failed – is the host still running?';pump()};x.send(it.file)}
function draw(){var q=$('#queue');q.replaceChildren();qs.forEach(function(it){it.bar=h('i');it.bar.style.width=it.pct+'%';it.sub=h('div',{class:'mu',text:it.st==='wait'?'Waiting…':fmt(it.file.size)});
 q.append(h('div',{class:'it'},[h('div',{class:'ic',text:icon(it.file.name)}),h('div',{class:'in'},[h('div',{class:'nm',text:it.file.name}),h('div',{class:'bar'},[it.bar]),it.sub])]))})}
var z=$('#zone');z.onclick=function(){$('#pick').click()};$('#pick').onchange=function(e){add(e.target.files);e.target.value=''};
['dragenter','dragover'].forEach(function(n){addEventListener(n,function(e){e.preventDefault();z.classList.add('over')})});
['dragleave','drop'].forEach(function(n){addEventListener(n,function(e){e.preventDefault();z.classList.remove('over')})});
addEventListener('drop',function(e){if(e.dataTransfer&&e.dataTransfer.files.length)add(e.dataTransfer.files)});
addEventListener('paste',function(e){if(e.clipboardData&&e.clipboardData.files.length)add(e.clipboardData.files)});
$('#txtSend').onclick=function(){var v=$('#txt').value.trim();if(!v)return;fetch('/api/text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})}).then(function(){$('#txt').value='';poll()})};
</script></body></html>`;

#!/usr/bin/env node
/**
 * Claude Code Session Viewer
 * Usage: node tools/session-viewer.js [--port 3000] [--no-open]
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const args    = process.argv.slice(2);
const PORT    = parseInt(args[args.indexOf('--port') + 1] || '3000', 10) || 3000;
const BASE    = path.join(os.homedir(), '.claude', 'projects');
const NO_OPEN = args.includes('--no-open');

// ── JSONL parser ──────────────────────────────────────────────────────────────
function cleanText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-name>[^<]*<\/command-name>/g, '')
    .replace(/<command-message>[^<]*<\/command-message>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}

function extractUser(content) {
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text' && c.text)
      .map(c => cleanText(c.text)).filter(Boolean).join('\n\n');
  }
  return '';
}

function getToolDetail(name, input) {
  if (!input) return '';
  const n = name.toLowerCase();
  if (n === 'bash')  return input.command ? input.command.slice(0, 400) : '';
  if (n === 'read')  return input.file_path || '';
  if (n === 'write') return input.file_path || '';
  if (n === 'edit')  return (input.file_path || '')
    + (input.old_string ? '\n- ' + input.old_string.slice(0, 120) + '\n+ ' + (input.new_string || '').slice(0, 120) : '');
  if (n === 'grep')  return (input.pattern || '') + (input.path ? '  [' + input.path + ']' : '');
  if (n === 'glob')  return (input.pattern || '') + (input.path ? '  in ' + input.path : '');
  const first = Object.values(input).find(v => typeof v === 'string');
  return first ? first.slice(0, 150) : '';
}

function extractAssistant(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content.trim() : '';
  }
  return content.map(c => {
    if (c.type === 'text')     return c.text ? c.text.trim() : '';
    if (c.type === 'tool_use') {
      const detail = getToolDetail(c.name, c.input);
      return '[Tool: ' + c.name + (detail ? '\n' + detail : '') + ']';
    }
    return '';
  }).filter(Boolean).join('\n\n');
}

function parseSession(filePath) {
  let title = '';
  const messages = [];
  let mtime;
  try { mtime = fs.statSync(filePath).mtime; } catch { return null; }

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  let model = '';
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.type === 'user') {
      const content = d.message && d.message.content;
      if (Array.isArray(content)) {
        const textParts = content.filter(c => c.type === 'text' && c.text)
          .map(c => cleanText(c.text)).filter(Boolean);
        if (textParts.length) messages.push({ role: 'user', text: textParts.join('\n\n'), tok: null });
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const res = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
          if (res.trim()) messages.push({ role: 'tool_result', text: res.trim(), tok: null });
        }
      } else {
        const text = extractUser(content);
        if (text) messages.push({ role: 'user', text, tok: null });
      }
    }
    if (d.type === 'assistant') {
      const text = extractAssistant(d.message && d.message.content);
      if (!model && d.message && d.message.model) model = d.message.model;
      let tok = null;
      if (d.message && d.message.usage) {
        const u = d.message.usage;
        tok = {
          in:  (u.input_tokens || 0),
          out: (u.output_tokens || 0),
          cr:  (u.cache_read_input_tokens || 0),
          cc:  (u.cache_creation_input_tokens || 0),
        };
        totals.input       += tok.in;
        totals.output      += tok.out;
        totals.cacheRead   += tok.cr;
        totals.cacheCreate += tok.cc;
      }
      if (text) messages.push({ role: 'assistant', text, tok });
    }
  }

  if (!messages.length) return null;
  return {
    id:      path.basename(filePath, '.jsonl'),
    title:   title || '(no title)',
    date:    mtime.toLocaleString('sv-SE', { hour12: false }).slice(0, 16),
    project: path.basename(path.dirname(filePath)),
    model,
    totals,
    msgs:    messages,
  };
}

function loadAllSessions() {
  if (!fs.existsSync(BASE)) return [];
  const sessions = [];
  let dirs;
  try { dirs = fs.readdirSync(BASE); } catch { return []; }
  for (const proj of dirs) {
    const dir = path.join(BASE, proj);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const s = parseSession(path.join(dir, file));
      if (s) sessions.push(s);
    }
  }
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  return sessions;
}

// ── HTML (no template-literal interpolation issues) ───────────────────────────
function buildHtml(staticSessions) {
  const css = [
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    ':root{',
    '  --bg:#0f0f11;--sur:#1a1a1f;--sur2:#242429;--bdr:#2e2e36;',
    '  --acc:#d97706;--acc2:#92400e;',
    '  --ubg:#1e2433;--ubd:#3b4f7a;',
    '  --abg:#1a1f1a;--abd:#2d4a2d;',
    '  --tbg:#1e1a2e;--tbd:#4a3a6a;',
    '  --txt:#e2e2e8;--dim:#888896;--mut:#555560;',
    '  --cbg:#0d1117;--scr:#2e2e3a;',
    '}',
    'html,body{height:100%;background:var(--bg);color:var(--txt);font-family:"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.6}',
    '#app{display:flex;height:100vh;overflow:hidden}',
    // sidebar
    '#sb{width:300px;min-width:200px;max-width:440px;background:var(--sur);border-right:1px solid var(--bdr);display:flex;flex-direction:column;overflow:hidden;resize:horizontal}',
    '#sb-hdr{padding:12px 14px;border-bottom:1px solid var(--bdr);display:flex;flex-direction:column;gap:8px}',
    '#sb-hdr h1{font-size:11px;font-weight:700;color:var(--acc);letter-spacing:.08em;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}',
    '#btn-refresh{padding:2px 8px;background:transparent;border:1px solid var(--bdr);border-radius:4px;color:var(--mut);font-size:10px;cursor:pointer}',
    '#btn-refresh:hover{border-color:var(--acc);color:var(--acc)}',
    '#btn-sort{padding:2px 8px;background:transparent;border:1px solid var(--bdr);border-radius:4px;color:var(--mut);font-size:10px;cursor:pointer}',
    '#btn-sort:hover{border-color:var(--acc);color:var(--acc)}',
    '#date-from,#date-to{width:100%;padding:4px 6px;background:var(--sur2);border:1px solid var(--bdr);border-radius:5px;color:var(--txt);font-size:11px;outline:none;color-scheme:dark}',
    '#date-from:focus,#date-to:focus{border-color:var(--acc)}',
    '#date-filters{display:flex;gap:6px;align-items:center}',
    '#search{width:100%;padding:6px 10px;background:var(--sur2);border:1px solid var(--bdr);border-radius:6px;color:var(--txt);font-size:13px;outline:none}',
    '#search:focus{border-color:var(--acc)}',
    '#search::placeholder{color:var(--mut)}',
    // project tree
    '#ptree{border-bottom:1px solid var(--bdr);overflow-y:auto;max-height:38vh;flex-shrink:0}',
    '#ptree::-webkit-scrollbar{width:3px}',
    '#ptree::-webkit-scrollbar-thumb{background:var(--scr);border-radius:2px}',
    '.pt-all{padding:8px 14px;cursor:pointer;font-size:12px;font-weight:600;color:var(--dim);display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--bdr)}',
    '.pt-all:hover,.pt-all.sel{color:var(--acc);background:var(--sur2)}',
    '.pt-proj-hd{padding:7px 14px;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);user-select:none;border-bottom:1px solid var(--bdr)}',
    '.pt-proj-hd:hover,.pt-proj-hd.sel{background:var(--sur2);color:var(--txt)}',
    '.pt-proj-hd.sel{color:var(--acc)}',
    '.pt-arr{font-size:9px;transition:transform .15s;display:inline-block;color:var(--mut);flex-shrink:0}',
    '.pt-arr.open{transform:rotate(90deg)}',
    '.pt-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;font-size:11px}',
    '.pt-bdg{background:var(--bdr);padding:1px 6px;border-radius:10px;font-size:10px;flex-shrink:0}',
    '.pt-slist{display:none;padding:0 0 4px}',
    '.pt-slist.open{display:block}',
    '.pt-si{padding:5px 14px 5px 28px;cursor:pointer;font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pt-si:hover{background:var(--sur2);color:var(--txt)}',
    '.pt-si.active{color:var(--acc);background:var(--sur2)}',
    // session list
    '#list-hdr{padding:5px 14px;font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--bdr);flex-shrink:0;display:flex;justify-content:space-between;align-items:center}',
    '#slist{flex:1;overflow-y:auto;padding:4px 6px}',
    '#slist::-webkit-scrollbar{width:4px}',
    '#slist::-webkit-scrollbar-thumb{background:var(--scr);border-radius:2px}',
    '.si{padding:8px 10px;border-radius:7px;cursor:pointer;border:1px solid transparent;margin-bottom:2px}',
    '.si:hover{background:var(--sur2)}',
    '.si.active{background:var(--sur2);border-color:var(--acc2)}',
    '.si-ttl{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.si-meta{font-size:11px;color:var(--mut);margin-top:2px;display:flex;justify-content:space-between;gap:6px}',
    '.si-cnt{background:var(--bdr);padding:1px 5px;border-radius:10px;font-size:10px;flex-shrink:0}',
    '.si-ptag{font-size:10px;color:var(--acc);opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.si-tok{font-size:10px;color:var(--mut);margin-top:1px}',
    '.si-cost{font-size:10px;color:#6fcf6f;font-family:monospace;flex-shrink:0}',
    // main
    '#main{flex:1;display:flex;flex-direction:column;overflow:hidden}',
    '#cv-hdr{padding:11px 18px;border-bottom:1px solid var(--bdr);background:var(--sur);display:flex;align-items:center;gap:10px}',
    '#cv-meta{flex:1;overflow:hidden}',
    '#cv-title{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#cv-sub{font-size:11px;color:var(--mut);margin-top:2px}',
    '#cv-tok{font-size:11px;color:var(--mut);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap}',
    '.tok-chip{padding:1px 7px;border-radius:4px;font-size:10px;font-family:monospace}',
    '.tok-out{background:#1a2a1a;color:#6fcf6f;border:1px solid #2d4a2d}',
    '.tok-in{background:#1a1a2a;color:#6fa8cf;border:1px solid #2d3a4a}',
    '.tok-cr{background:#2a2a1a;color:#cfcf6f;border:1px solid #4a4a2d}',
    '.tok-cc{background:#2a1a1a;color:#cf8f6f;border:1px solid #4a2d2d}',
    '.msg-tok{font-size:10px;color:var(--mut);margin-top:3px;font-family:monospace}',
    '#btn-tools{padding:3px 10px;background:var(--sur2);border:1px solid var(--bdr);border-radius:5px;color:var(--dim);font-size:12px;cursor:pointer;flex-shrink:0}',
    '#btn-tools:hover{border-color:var(--acc);color:var(--acc)}',
    '#msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}',
    '#msgs::-webkit-scrollbar{width:5px}',
    '#msgs::-webkit-scrollbar-thumb{background:var(--scr);border-radius:3px}',
    '#empty{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--mut);height:100%}',
    '.msg{display:flex;gap:10px;max-width:860px}',
    '.msg.user{flex-direction:row-reverse;align-self:flex-end}',
    '.msg.assistant{align-self:flex-start}',
    '.av{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;margin-top:3px}',
    '.msg.user .av{background:var(--ubd);color:#aac4ff}',
    '.msg.assistant .av{background:var(--abd);color:#86c994}',
    '.msg.tool_result{align-self:flex-start}',
    '.msg.tool_result .av{background:#1a1a2e;color:#8888cc;font-size:9px}',
    '.msg.tool_result .bubble{background:#0d1117;border-color:#2a2a3a;border-top-left-radius:3px;max-height:260px;overflow-y:auto;font-family:Consolas,monospace;font-size:11px;line-height:1.5;padding:8px 12px}',
    '.bubble{padding:11px 15px;border-radius:12px;max-width:700px;word-break:break-word;font-size:13.5px;line-height:1.75;border:1px solid transparent;white-space:pre-wrap}',
    '.msg.user .bubble{background:var(--ubg);border-color:var(--ubd);border-top-right-radius:3px}',
    '.msg.assistant .bubble{background:var(--abg);border-color:var(--abd);border-top-left-radius:3px}',
    '.tool-chip{display:inline-block;font-family:Consolas,monospace;font-size:11px;padding:2px 7px;background:var(--tbg);border:1px solid var(--tbd);border-radius:4px;color:#c4a8ff;margin:2px 0}',
    '.bubble code{background:var(--cbg);padding:1px 4px;border-radius:3px;font-family:Consolas,monospace;font-size:12px;color:#f4b860}',
    '.bubble strong{color:#fff}',
    '#overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-size:16px;color:#ccc;z-index:99}',
  ].join('\n');

  // client-side JS — written as a plain string, no template literal tricks
  const js = [
    'var S=[], showTools=false, curIdx=null, activePrj=null, searchQ="", sortDir="desc";',
    'var GROUPS={};',
    '',
    'async function load(){',
    '  document.getElementById("overlay").style.display="flex";',
    '  try{',
    '    var r=await fetch("/api/sessions");',
    '    S=await r.json();',
    '    buildTree();',
    '    applyFilter();',
    '    var sid=new URLSearchParams(location.search).get("sid");',
    '    var target=sid!=null ? S.findIndex(function(s){return s.id===sid;}) : -1;',
    '    if(target>=0) pick(target);',
    '    else if(curIdx===null && S.length) pick(0);',
    '  }catch(e){alert("Load failed: "+e.message);}',
    '  document.getElementById("overlay").style.display="none";',
    '}',
    '',
    'function shortName(p){',
    '  return p.replace(/^C--Users-[^-]+-/,"").replace(/^C--/,"").replace(/-/g,"/");',
    '}',
    '',
    'function buildTree(){',
    '  GROUPS={};',
    '  S.forEach(function(s,i){',
    '    var p=s.project||"(unknown)";',
    '    if(!GROUPS[p]) GROUPS[p]=[];',
    '    GROUPS[p].push(i);',
    '  });',
    '  var h=[];',
    '  h.push("<div class=\\"pt-all sel\\" id=\\"pt-all\\">All Projects <span class=\\"pt-bdg\\">"+S.length+"</span></div>");',
    '  Object.keys(GROUPS).sort().forEach(function(proj,pi){',
    '    var ids=GROUPS[proj];',
    '    var pid="pt"+pi;',
    '    h.push("<div>");',
    '    h.push("<div class=\\"pt-proj-hd\\" id=\\""+pid+"-hd\\" data-pi=\\""+pi+"\\">"+',
    '      "<span class=\\"pt-arr\\" id=\\""+pid+"-arr\\">&#9654;</span>"+',
    '      "<span class=\\"pt-name\\">"+esc(shortName(proj))+"</span>"+',
    '      "<span class=\\"pt-bdg\\">"+ids.length+"</span></div>");',
    '    h.push("<div class=\\"pt-slist\\" id=\\""+pid+"-sl\\">");',
    '    ids.forEach(function(i){',
    '      h.push("<div class=\\"pt-si\\" id=\\"psi"+i+"\\" data-idx=\\""+i+"\\">"+esc(S[i].title)+"</div>");',
    '    });',
    '    h.push("</div></div>");',
    '  });',
    '  document.getElementById("ptree").innerHTML=h.join("");',
    '  // event delegation — no inline onclick strings needed',
    '  document.getElementById("ptree").addEventListener("click",function(e){',
    '    var all=e.target.closest(".pt-all");',
    '    var hd=e.target.closest(".pt-proj-hd");',
    '    var si=e.target.closest(".pt-si");',
    '    if(all) selPrj(null,null);',
    '    else if(hd) toggleProj(hd.id.replace("-hd",""), Number(hd.dataset.pi));',
    '    else if(si) pick(Number(si.dataset.idx));',
    '  });',
    '}',
    '',
    'function toggleProj(pid,pi){',
    '  var proj=Object.keys(GROUPS).sort()[pi];',
    '  var sl=document.getElementById(pid+"-sl");',
    '  var arr=document.getElementById(pid+"-arr");',
    '  var isOpen=sl.classList.contains("open");',
    '  sl.classList.toggle("open",!isOpen);',
    '  arr.classList.toggle("open",!isOpen);',
    '  selPrj(isOpen?null:proj, isOpen?null:pid);',
    '}',
    '',
    'function selPrj(proj,pid){',
    '  activePrj=proj;',
    '  document.querySelectorAll(".pt-all").forEach(function(el){el.classList.toggle("sel",proj===null);});',
    '  document.querySelectorAll(".pt-proj-hd").forEach(function(el){el.classList.remove("sel");});',
    '  if(pid) document.getElementById(pid+"-hd").classList.add("sel");',
    '  applyFilter();',
    '}',
    '',
    'function applyFilter(){',
    '  var lo=searchQ.toLowerCase();',
    '  var df=document.getElementById("date-from").value;',
    '  var dt=document.getElementById("date-to").value;',
    '  var list=S.filter(function(s){',
    '    var mp=activePrj===null||s.project===activePrj;',
    '    var mq=!lo||s.title.toLowerCase().includes(lo)||s.msgs.some(function(m){return m.text.toLowerCase().includes(lo);});',
    '    var d=s.date.slice(0,10);',
    '    var mdf=!df||d>=df;',
    '    var mdt=!dt||d<=dt;',
    '    return mp&&mq&&mdf&&mdt;',
    '  });',
    '  renderList(list);',
    '}',
    '',
    'function toggleSort(){',
    '  sortDir=sortDir==="desc"?"asc":"desc";',
    '  applyFilter();',
    '}',
    '',
    'function fmtK(n){',
    '  if(!n) return "0";',
    '  return n>=1000?(n/1000).toFixed(1)+"k":String(n);',
    '}',
    '',
    'var PRICING={',
    '  opus:{i:15,o:75,cr:1.50,cc:18.75},',
    '  sonnet:{i:3,o:15,cr:0.30,cc:3.75},',
    '  haiku:{i:0.80,o:4,cr:0.08,cc:1.00},',
    '  def:{i:3,o:15,cr:0.30,cc:3.75}',
    '};',
    'function calcCost(model,t){',
    '  if(!t) return 0;',
    '  var k=model?(model.indexOf("opus")>=0?"opus":model.indexOf("haiku")>=0?"haiku":"sonnet"):"def";',
    '  var p=PRICING[k]||PRICING.def;',
    '  return(t.input*p.i+t.output*p.o+(t.cacheRead||0)*p.cr+(t.cacheCreate||0)*p.cc)/1e6;',
    '}',
    'function fmtCost(c){',
    '  if(!c) return "";',
    '  return "$"+(c<0.001?c.toFixed(5):c<0.01?c.toFixed(4):c<1?c.toFixed(3):c.toFixed(2));',
    '}',
    '',
    'function renderList(list){',
    '  var sorted=list.slice();',
    '  if(sortDir==="asc") sorted.sort(function(a,b){return a.date.localeCompare(b.date);});',
    '  else sorted.sort(function(a,b){return b.date.localeCompare(a.date);});',
    '  var lbl=activePrj?shortName(activePrj):"All Projects";',
    '  document.getElementById("list-hdr-lbl").textContent=sorted.length+" sessions — "+lbl;',
    '  var btn=document.getElementById("btn-sort");',
    '  if(btn) btn.textContent=sortDir==="desc"?"↓ Newest":"↑ Oldest";',
    '  var el=document.getElementById("slist");',
    '  el.innerHTML=sorted.map(function(s){',
    '    var ri=S.indexOf(s);',
    '    var t=s.msgs.filter(function(m){return m.role==="user";}).length;',
    '    var cost=calcCost(s.model,s.totals);',
    '    var costStr=cost?"<span class=\\"si-cost\\">"+fmtCost(cost)+"</span>":"";',
    '    var tokStr="";',
    '    if(s.totals&&(s.totals.output||s.totals.input)){',
    '      tokStr="<div class=\\"si-tok\\">out "+fmtK(s.totals.output)+" \xB7 in "+fmtK(s.totals.input)',
    '        +(s.totals.cacheRead?" \xB7 cache&#8595; "+fmtK(s.totals.cacheRead):"")+"</div>";',
    '    }',
    '    return "<div class=\\"si"+(ri===curIdx?" active":"")+"\\\" id=\\"si"+ri+"\\" data-idx=\\""+ri+"\\">"+',
    '      "<div class=\\"si-ttl\\">"+esc(s.title)+"</div>"+',
    '      "<div class=\\"si-meta\\"><span>"+s.date+"</span><span class=\\"si-cnt\\">"+t+"t</span>"+costStr+"</div>"+',
    '      tokStr+',
    '      (activePrj===null?"<div class=\\"si-ptag\\">"+esc(shortName(s.project))+"</div>":"")+',
    '      "</div>";',
    '  }).join("");',
    '}',
    '',
    'document.getElementById("slist").addEventListener("click",function(e){',
    '  var si=e.target.closest(".si");',
    '  if(si) pick(Number(si.dataset.idx));',
    '});',
    '',
    'document.getElementById("search").addEventListener("input",function(e){',
    '  searchQ=e.target.value; applyFilter();',
    '});',
    'document.getElementById("date-from").addEventListener("change",function(){applyFilter();});',
    'document.getElementById("date-to").addEventListener("change",function(){applyFilter();});',
    'var rbtn=document.getElementById("btn-refresh"); if(rbtn) rbtn.addEventListener("click",load);',
    'document.getElementById("btn-tools").addEventListener("click",function(){',
    '  showTools=!showTools;',
    '  document.getElementById("btn-tools").textContent=showTools?"Tools ON":"Tools OFF";',
    '  if(curIdx!==null) renderMsgs(S[curIdx].msgs);',
    '});',
    '',
    'function pick(idx){',
    '  if(curIdx!==null){',
    '    var p=document.getElementById("si"+curIdx); if(p) p.classList.remove("active");',
    '    var t=document.getElementById("psi"+curIdx); if(t) t.classList.remove("active");',
    '  }',
    '  curIdx=idx;',
    '  var si=document.getElementById("si"+idx); if(si) si.classList.add("active");',
    '  var psi=document.getElementById("psi"+idx); if(psi){psi.classList.add("active");psi.scrollIntoView({block:"nearest"});}',
    '  var s=S[idx];',
    '  document.getElementById("cv-title").textContent=s.title;',
    '  document.getElementById("cv-title").style.color="";',
    '  var modelShort=s.model?s.model.replace("claude-","").replace(/-\\d{8}$/,""):"";',
    '  document.getElementById("cv-sub").textContent=s.date+(modelShort?"  ·  "+modelShort:"")+"  ·  "+shortName(s.project);',
    '  var tokEl=document.getElementById("cv-tok");',
    '  if(s.totals){',
    '    var to=s.totals;',
    '    tokEl.innerHTML=',
    '      "<span class=\\"tok-chip tok-out\\">out "+fmtK(to.output)+"</span>"+',
    '      "<span class=\\"tok-chip tok-in\\">in "+fmtK(to.input)+"</span>"+',
    '      (to.cacheRead?"<span class=\\"tok-chip tok-cr\\">cache&#8595; "+fmtK(to.cacheRead)+"</span>":"")+',
    '      (to.cacheCreate?"<span class=\\"tok-chip tok-cc\\">cache&#8593; "+fmtK(to.cacheCreate)+"</span>":"");',
    '  } else { tokEl.innerHTML=""; }',
    '  renderMsgs(s.msgs);',
    '}',
    '',
    'function renderMsgs(msgs){',
    '  var el=document.getElementById("msgs");',
    '  el.innerHTML="";',
    '  var vis=msgs.filter(function(m){return m.text.trim();});',
    '  if(!vis.length){el.innerHTML="<div id=\\"empty\\"><p>No messages</p></div>";return;}',
    '  vis.forEach(function(m){',
    '    var isResult=m.role==="tool_result";',
    '    var isCall=!isResult&&m.text.indexOf("[Tool:")===0&&m.text.trim().slice(-1)==="]";',
    '    if((isResult||isCall)&&!showTools) return;',
    '    var row=document.createElement("div");',
    '    row.className="msg "+(isResult?"tool_result":m.role);',
    '    var av=document.createElement("div");',
    '    av.className="av";',
    '    av.textContent=m.role==="user"?"U":isResult?"TR":"AI";',
    '    var b=document.createElement("div");',
    '    b.className="bubble";',
    '    if(isResult){',
    '      b.innerHTML="<pre style=\\"margin:0;white-space:pre-wrap;word-break:break-all\\">"+esc(m.text)+"</pre>";',
    '    } else if(isCall){',
    '      b.innerHTML="<span class=\\"tool-chip\\" style=\\"white-space:pre-wrap\\">"+esc(m.text)+"</span>";',
    '    } else {',
    '      b.innerHTML=fmt(m.text);',
    '    }',
    '    if(m.role==="assistant"&&m.tok&&m.tok.out){',
    '      var tk=document.createElement("div");',
    '      tk.className="msg-tok";',
    '      tk.textContent="out "+fmtK(m.tok.out)+(m.tok.in?" · in "+fmtK(m.tok.in):"")+(m.tok.cr?" · cache&#8595; "+fmtK(m.tok.cr):"");',
    '      b.appendChild(tk);',
    '    }',
    '    row.appendChild(av); row.appendChild(b); el.appendChild(row);',
    '  });',
    '  el.scrollTop=el.scrollHeight;',
    '}',
    '',
    'function fmt(t){',
    '  var s=esc(t);',
    '  s=s.replace(/`([^`\\n]{1,80})`/g,"<code>$1</code>");',
    '  s=s.replace(/\\*\\*([^*\\n]{1,100})\\*\\*/g,"<strong>$1</strong>");',
    '  return s;',
    '}',
    'function esc(s){',
    '  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
    '}',
    '',
    staticSessions
      ? 'S=' + JSON.stringify(staticSessions) + '; buildTree(); applyFilter(); if(S.length) pick(0); document.getElementById("overlay").style.display="none";'
      : 'load();',
  ].join('\n');

  const nav = '<nav style="height:38px;background:#111;border-bottom:1px solid #2e2e36;display:flex;align-items:center;padding:0 16px;gap:4px;flex-shrink:0">'
    + '<span style="font-size:11px;font-weight:700;color:#d97706;letter-spacing:.08em;margin-right:12px">CLAUDE</span>'
    + '<a href="/" style="padding:4px 12px;border-radius:5px;font-size:12px;text-decoration:none;background:#1a1a1f;color:#e2e2e8;border:1px solid #3a3a46">Sessions</a>'
    + '<a href="/dashboard" style="padding:4px 12px;border-radius:5px;font-size:12px;text-decoration:none;color:#888896">Dashboard</a>'
    + '</nav>';

  return '<!DOCTYPE html>\n'
    + '<html lang="ko"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Claude Code Sessions</title>'
    + '<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}' + css + '</style></head><body>'
    + nav
    + '<div id="overlay">Loading sessions…</div>'
    + '<div id="app" style="flex:1;overflow:hidden">'
    + '<div id="sb">'
    +   '<div id="sb-hdr">'
    +     '<h1>Claude Sessions ' + (staticSessions ? '<span style="font-size:9px;color:var(--mut);border:1px solid var(--bdr);border-radius:4px;padding:2px 7px;vertical-align:middle">Static</span>' : '<button id="btn-refresh">&#8635; Refresh</button>') + '</h1>'
    +     '<input id="search" type="text" placeholder="Search title or content…">'
    +     '<div id="date-filters">'
    +       '<input id="date-from" type="date" title="From date">'
    +       '<span style="color:var(--mut);font-size:11px">&#8594;</span>'
    +       '<input id="date-to" type="date" title="To date">'
    +     '</div>'
    +   '</div>'
    +   '<div id="ptree"></div>'
    +   '<div id="list-hdr">'
    +     '<span id="list-hdr-lbl">—</span>'
    +     '<button id="btn-sort" onclick="toggleSort()">↓ Newest</button>'
    +   '</div>'
    +   '<div id="slist"></div>'
    + '</div>'
    + '<div id="main">'
    +   '<div id="cv-hdr">'
    +     '<div id="cv-meta">'
    +       '<div id="cv-title" style="color:var(--mut)">← Select a session</div>'
    +       '<div id="cv-sub"></div>'
    +       '<div id="cv-tok"></div>'
    +     '</div>'
    +     '<button id="btn-tools">Tools OFF</button>'
    +   '</div>'
    +   '<div id="msgs"><div id="empty"><p style="font-size:32px">&#128172;</p><p>Select a session to read</p></div></div>'
    + '</div>'
    + '</div>'
    + '<script>\n' + js + '\n</script>'
    + '</body></html>';
}

// ── cost calculation ──────────────────────────────────────────────────────────
const PRICING = {
  opus:    { in: 15,   out: 75,  cr: 1.50,  cc: 18.75 },
  sonnet:  { in: 3,    out: 15,  cr: 0.30,  cc: 3.75  },
  haiku:   { in: 0.80, out: 4,   cr: 0.08,  cc: 1.00  },
  default: { in: 3,    out: 15,  cr: 0.30,  cc: 3.75  },
};

function getPrice(model) {
  if (!model) return PRICING.default;
  if (model.includes('opus'))   return PRICING.opus;
  if (model.includes('haiku'))  return PRICING.haiku;
  if (model.includes('sonnet')) return PRICING.sonnet;
  return PRICING.default;
}

function calcCost(model, t) {
  if (!t) return 0;
  const p = getPrice(model);
  return (t.input * p.in + t.output * p.out + t.cacheRead * p.cr + t.cacheCreate * p.cc) / 1e6;
}

// ── dashboard ─────────────────────────────────────────────────────────────────
function buildDashboard(sessions) {
  sessions.forEach(s => { s.cost = calcCost(s.model, s.totals); });

  const totalCost = sessions.reduce((a, s) => a + s.cost, 0);
  const totalOut  = sessions.reduce((a, s) => a + (s.totals ? s.totals.output : 0), 0);
  const totalIn   = sessions.reduce((a, s) => a + (s.totals ? s.totals.input : 0), 0);
  const totalCR   = sessions.reduce((a, s) => a + (s.totals ? s.totals.cacheRead : 0), 0);

  const byDate = {};
  sessions.forEach(s => {
    const d = s.date.slice(0, 10);
    if (!byDate[d]) byDate[d] = { cost: 0, count: 0 };
    byDate[d].cost += s.cost; byDate[d].count += 1;
  });
  const dates = Object.keys(byDate).sort();

  const byProj = {};
  sessions.forEach(s => {
    const p = s.project || '(unknown)';
    if (!byProj[p]) byProj[p] = { cost: 0, output: 0, count: 0 };
    byProj[p].cost += s.cost;
    byProj[p].output += s.totals ? s.totals.output : 0;
    byProj[p].count += 1;
  });

  const byModel = {};
  sessions.forEach(s => {
    const m = s.model ? s.model.replace(/-\d{8}$/, '') : '(unknown)';
    if (!byModel[m]) byModel[m] = { cost: 0, output: 0, count: 0 };
    byModel[m].cost += s.cost;
    byModel[m].output += s.totals ? s.totals.output : 0;
    byModel[m].count += 1;
  });

  function fmtK(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n||0); }
  function fmtCost(c) { return '$' + (c < 0.001 ? c.toFixed(5) : c < 0.01 ? c.toFixed(4) : c < 1 ? c.toFixed(3) : c.toFixed(2)); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function shortName(p) { return p.replace(/^C--Users-[^-]+-/, '').replace(/^C--/, '').replace(/-/g, '/'); }

  // SVG line chart
  function lineChart(data) {
    if (!data.length) return '<text x="10" y="20" fill="#555" font-size="12">No data</text>';
    const W = 580, H = 110, OX = 46, OY = 8, IW = W - OX - 8, IH = H - OY - 16;
    const vals = data.map(d => d[1]);
    const max = Math.max(...vals, 0.0001);
    const px = (i) => (OX + (i / Math.max(data.length-1,1)) * IW).toFixed(1);
    const py = (v) => (OY + IH - (v / max) * IH).toFixed(1);
    // grid lines
    const grid = [0, 0.5, 1].map(f => {
      const y = (OY + IH - f * IH).toFixed(0);
      return '<line x1="' + OX + '" y1="' + y + '" x2="' + (OX+IW) + '" y2="' + y + '" stroke="#2a2a32" stroke-width="1"/>'
        + '<text x="' + (OX-4) + '" y="' + (Number(y)+3) + '" fill="#444" font-size="9" text-anchor="end">' + fmtCost(f*max) + '</text>';
    }).join('');
    // area fill
    const ptsArr = data.map((d,i) => px(i)+','+py(d[1]));
    const areaPath = 'M '+px(0)+','+py(0)+' '+ptsArr.map((p,i)=>(i===0?'':p)).join(' ')+' L '+px(data.length-1)+','+(OY+IH)+' L '+OX+','+(OY+IH)+' Z';
    const line = '<polyline points="'+ptsArr.join(' ')+'" fill="none" stroke="#d97706" stroke-width="2"/>';
    const area = '<path d="'+areaPath+'" fill="#d97706" opacity="0.08"/>';
    const dots = data.map((d,i) =>
      '<circle cx="'+px(i)+'" cy="'+py(d[1])+'" r="3.5" fill="#d97706" stroke="#0f0f11" stroke-width="1.5"><title>'+d[0]+': '+fmtCost(d[1])+' ('+d[2]+' sessions)</title></circle>'
    ).join('');
    // x labels: show up to 7 evenly
    const step = Math.max(1, Math.floor(data.length / 7));
    const xLabels = data.map((d,i) => {
      if (i % step !== 0 && i !== data.length-1) return '';
      return '<text x="'+px(i)+'" y="'+(OY+IH+13)+'" fill="#444" font-size="9" text-anchor="middle">'+d[0].slice(5)+'</text>';
    }).join('');
    return '<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="overflow:visible">'+grid+area+line+dots+xLabels+'</svg>';
  }

  // stacked mini bars: project cost
  function projBars() {
    const sorted = Object.entries(byProj).sort((a,b) => b[1].cost - a[1].cost);
    const max = sorted[0] ? sorted[0][1].cost : 0.0001;
    return sorted.map(([p, v]) => {
      const pct = (v.cost / max * 100).toFixed(1);
      return '<div style="margin-bottom:8px">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">'
        + '<span style="color:#c4c4d0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">' + esc(shortName(p)) + '</span>'
        + '<span style="color:#6fcf6f;font-family:monospace;font-size:11px;flex-shrink:0;margin-left:8px">' + fmtCost(v.cost) + '</span>'
        + '</div>'
        + '<div style="background:#2a2a32;border-radius:3px;height:5px">'
        + '<div style="background:#d97706;border-radius:3px;height:5px;width:' + pct + '%"></div>'
        + '</div>'
        + '<div style="font-size:10px;color:#444;margin-top:2px">' + v.count + ' sessions · out ' + fmtK(v.output) + '</div>'
        + '</div>';
    }).join('');
  }

  // model pills
  function modelPills() {
    const COLORS = { opus: '#9f7dff', sonnet: '#6fa8cf', haiku: '#6fcf6f' };
    return Object.entries(byModel).sort((a,b) => b[1].cost - a[1].cost).map(([m, v]) => {
      const key = m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : 'sonnet';
      const col = COLORS[key] || '#888';
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #2a2a32">'
        + '<span style="width:8px;height:8px;border-radius:50%;background:' + col + ';flex-shrink:0"></span>'
        + '<span style="flex:1;font-size:12px;color:#c4c4d0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(m) + '</span>'
        + '<span style="font-size:11px;color:#555">' + v.count + ' sess</span>'
        + '<span style="font-size:11px;color:#6fcf6f;font-family:monospace;min-width:60px;text-align:right">' + fmtCost(v.cost) + '</span>'
        + '</div>';
    }).join('');
  }

  // session rows JSON for client-side table
  const sessionData = JSON.stringify(sessions.map(s => ({
    id:   s.id,
    date: s.date,
    title: s.title,
    proj: shortName(s.project || '(unknown)'),
    model: s.model ? s.model.replace('claude-', '').replace(/-\d{8}$/, '') : '',
    out: s.totals ? s.totals.output : 0,
    inp: s.totals ? s.totals.input : 0,
    cr: s.totals ? s.totals.cacheRead : 0,
    cost: s.cost,
  })));

  const projList = JSON.stringify(['All', ...Object.keys(byProj).sort().map(shortName)]);

  const lineSvgHtml = lineChart(dates.map(d => [d, byDate[d].cost, byDate[d].count]));

  const nav = '<nav style="height:38px;background:#111;border-bottom:1px solid #2e2e36;display:flex;align-items:center;padding:0 16px;gap:4px;flex-shrink:0">'
    + '<span style="font-size:11px;font-weight:700;color:#d97706;letter-spacing:.08em;margin-right:12px">CLAUDE</span>'
    + '<a href="/" style="padding:4px 12px;border-radius:5px;font-size:12px;text-decoration:none;color:#888896">Sessions</a>'
    + '<a href="/dashboard" style="padding:4px 12px;border-radius:5px;font-size:12px;text-decoration:none;background:#1a1a1f;color:#e2e2e8;border:1px solid #3a3a46">Dashboard</a>'
    + '</nav>';

  const css = `
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0f0f11;--sur:#1a1a1f;--bdr:#2e2e36;--txt:#e2e2e8;--mut:#555560;--acc:#d97706}
    body{background:var(--bg);color:var(--txt);font-family:"Segoe UI",system-ui,sans-serif;font-size:14px;overflow-x:hidden}
    .page{max-width:1200px;margin:0 auto;padding:20px 20px 40px}
    .sec-title{font-size:11px;font-weight:700;color:var(--acc);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
    .card{background:var(--sur);border:1px solid var(--bdr);border-radius:10px;padding:14px 16px}
    .card-label{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
    .card-val{font-size:24px;font-weight:700}
    .card-val.g{color:#6fcf6f}.card-val.b{color:#6fa8cf}.card-val.y{color:#d97706}.card-val.w{color:#e2e2e8}
    .card-sub{font-size:10px;color:var(--mut);margin-top:3px}
    .top-row{display:grid;grid-template-columns:1fr 280px;gap:14px;margin-bottom:20px}
    .box{background:var(--sur);border:1px solid var(--bdr);border-radius:10px;padding:16px}
    .side-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
    /* sessions table */
    .tbl-wrap{background:var(--sur);border:1px solid var(--bdr);border-radius:10px;overflow:hidden}
    .tbl-toolbar{padding:10px 14px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--bdr);flex-wrap:wrap}
    #tbl-search{background:#111;border:1px solid var(--bdr);border-radius:6px;padding:5px 10px;color:#e2e2e8;font-size:12px;width:200px;outline:none}
    #tbl-proj{background:#111;border:1px solid var(--bdr);border-radius:6px;padding:5px 10px;color:#e2e2e8;font-size:12px;outline:none}
    .tbl-count{font-size:11px;color:var(--mut);margin-left:auto}
    .tbl-scroll{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{padding:8px 12px;font-size:10px;color:var(--mut);border-bottom:1px solid var(--bdr);font-weight:600;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;cursor:pointer;user-select:none;background:var(--sur);position:sticky;top:0}
    th:hover{color:#e2e2e8}
    th .arr{font-size:9px;opacity:.5;margin-left:3px}
    td{padding:7px 12px;border-bottom:1px solid #1e1e26;color:var(--txt);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis}
    td.num{text-align:right;font-family:monospace;font-size:11px;color:#888896}
    td.cost-cell{text-align:right;font-family:monospace;font-size:12px;font-weight:600;color:#6fcf6f}
    tr:hover td{background:rgba(255,255,255,.025)}
    tr:last-child td{border-bottom:none}
    .model-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}
    .tag-opus{background:#2d2040;color:#9f7dff}
    .tag-sonnet{background:#1a2a3a;color:#6fa8cf}
    .tag-haiku{background:#1a2d1a;color:#6fcf6f}
    .tag-def{background:#2a2a2a;color:#888}
    .note{font-size:10px;color:#333;margin-top:14px}
    @media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.top-row,.side-row{grid-template-columns:1fr}}
  `;

  const js = `
    var SESSIONS = ${sessionData};
    var PROJECTS = ${projList};
    var sortCol = 'cost', sortAsc = false, filterProj = 'All', filterQ = '';

    function fmtK(n){ return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'k':String(n||0); }
    function fmtCost(c){ return '$'+(c<0.001?c.toFixed(5):c<0.01?c.toFixed(4):c<1?c.toFixed(3):c.toFixed(2)); }
    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function modelTag(m){
      var cls = m.includes('opus')?'tag-opus':m.includes('haiku')?'tag-haiku':m.includes('sonnet')?'tag-sonnet':'tag-def';
      var label = m.includes('opus')?'opus':m.includes('haiku')?'haiku':m.includes('sonnet')?'sonnet':m;
      return '<span class="model-tag '+cls+'">'+label+'</span>';
    }

    function getDateFiltered(){
      var df = document.getElementById('dash-date-from').value;
      var dt = document.getElementById('dash-date-to').value;
      return SESSIONS.filter(function(s){
        var d = s.date.slice(0,10);
        return (!df||d>=df) && (!dt||d<=dt);
      });
    }

    function aggregate(rows){
      var t = {cost:0,out:0,inp:0,cr:0};
      var byDate={}, byProj={}, byModel={};
      rows.forEach(function(s){
        t.cost+=s.cost; t.out+=s.out; t.inp+=s.inp; t.cr+=s.cr;
        var d=s.date.slice(0,10);
        if(!byDate[d]) byDate[d]={cost:0,count:0};
        byDate[d].cost+=s.cost; byDate[d].count++;
        if(!byProj[s.proj]) byProj[s.proj]={cost:0,output:0,count:0};
        byProj[s.proj].cost+=s.cost; byProj[s.proj].output+=s.out; byProj[s.proj].count++;
        var m=s.model||'(unknown)';
        if(!byModel[m]) byModel[m]={cost:0,output:0,count:0};
        byModel[m].cost+=s.cost; byModel[m].output+=s.out; byModel[m].count++;
      });
      return {t:t, byDate:byDate, byProj:byProj, byModel:byModel, projCount:Object.keys(byProj).length};
    }

    function renderCards(t, count, projCount){
      function card(lbl,val,sub,cls){ return '<div class="card"><div class="card-label">'+lbl+'</div><div class="card-val '+cls+'">'+val+'</div><div class="card-sub">'+sub+'</div></div>'; }
      var avg = count ? t.cost/count : 0;
      document.getElementById('dash-cards').innerHTML =
        card('Total Sessions', String(count), projCount+' projects', 'w') +
        card('Est. Total Cost', fmtCost(t.cost), 'Anthropic pricing', 'g') +
        card('Output Tokens', fmtK(t.out), 'input '+fmtK(t.inp), 'b') +
        card('Avg Cost / Session', fmtCost(avg), 'cache↓ '+fmtK(t.cr), 'y');
    }

    function lineChartSvg(data){
      if(!data.length) return '<p style="color:#555;font-size:12px;padding:20px 0">No data</p>';
      var W=580,H=110,OX=46,OY=8,IW=W-OX-8,IH=H-OY-16;
      var vals=data.map(function(d){return d[1];});
      var max=Math.max.apply(null,vals.concat([0.0001]));
      function px(i){return (OX+(i/Math.max(data.length-1,1))*IW).toFixed(1);}
      function py(v){return (OY+IH-(v/max)*IH).toFixed(1);}
      var grid=[0,0.5,1].map(function(f){
        var y=(OY+IH-f*IH).toFixed(0);
        return '<line x1="'+OX+'" y1="'+y+'" x2="'+(OX+IW)+'" y2="'+y+'" stroke="#2a2a32" stroke-width="1"/>'+
          '<text x="'+(OX-4)+'" y="'+(Number(y)+3)+'" fill="#444" font-size="9" text-anchor="end">'+fmtCost(f*max)+'</text>';
      }).join('');
      var ptsArr=data.map(function(d,i){return px(i)+','+py(d[1]);});
      var areaPath='M '+px(0)+','+py(data[0][1])+' '+ptsArr.slice(1).join(' ')+
        ' L '+px(data.length-1)+','+(OY+IH)+' L '+OX+','+(OY+IH)+' Z';
      var dots=data.map(function(d,i){
        return '<circle cx="'+px(i)+'" cy="'+py(d[1])+'" r="3.5" fill="#d97706" stroke="#0f0f11" stroke-width="1.5">'+
          '<title>'+d[0]+': '+fmtCost(d[1])+' ('+d[2]+' sessions)</title></circle>';
      }).join('');
      var step=Math.max(1,Math.floor(data.length/7));
      var xLabels=data.map(function(d,i){
        if(i%step!==0&&i!==data.length-1) return '';
        return '<text x="'+px(i)+'" y="'+(OY+IH+13)+'" fill="#444" font-size="9" text-anchor="middle">'+d[0].slice(5)+'</text>';
      }).join('');
      return '<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="overflow:visible">'+grid+
        '<path d="'+areaPath+'" fill="#d97706" opacity="0.08"/>'+
        '<polyline points="'+ptsArr.join(' ')+'" fill="none" stroke="#d97706" stroke-width="2"/>'+
        dots+xLabels+'</svg>';
    }

    function renderChart(byDate){
      var dates=Object.keys(byDate).sort();
      document.getElementById('dash-chart').innerHTML =
        lineChartSvg(dates.map(function(d){return [d,byDate[d].cost,byDate[d].count];}));
    }

    function renderModels(byModel){
      var COLORS={opus:'#9f7dff',sonnet:'#6fa8cf',haiku:'#6fcf6f'};
      var html=Object.entries(byModel).sort(function(a,b){return b[1].cost-a[1].cost;}).map(function(e){
        var m=e[0],v=e[1];
        var key=m.includes('opus')?'opus':m.includes('haiku')?'haiku':'sonnet';
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #2a2a32">'+
          '<span style="width:8px;height:8px;border-radius:50%;background:'+(COLORS[key]||'#888')+';flex-shrink:0"></span>'+
          '<span style="flex:1;font-size:12px;color:#c4c4d0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(m)+'</span>'+
          '<span style="font-size:11px;color:#555">'+v.count+' sess</span>'+
          '<span style="font-size:11px;color:#6fcf6f;font-family:monospace;min-width:60px;text-align:right">'+fmtCost(v.cost)+'</span>'+
          '</div>';
      }).join('');
      document.getElementById('dash-models').innerHTML = html||'<p style="color:#555;font-size:12px">No data</p>';
    }

    function renderProj(byProj){
      var sorted=Object.entries(byProj).sort(function(a,b){return b[1].cost-a[1].cost;});
      var max=sorted[0]?sorted[0][1].cost:0.0001;
      var html=sorted.map(function(e){
        var p=e[0],v=e[1];
        var pct=(v.cost/max*100).toFixed(1);
        return '<div style="margin-bottom:8px">'+
          '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">'+
          '<span style="color:#c4c4d0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">'+esc(p)+'</span>'+
          '<span style="color:#6fcf6f;font-family:monospace;font-size:11px;flex-shrink:0;margin-left:8px">'+fmtCost(v.cost)+'</span>'+
          '</div>'+
          '<div style="background:#2a2a32;border-radius:3px;height:5px">'+
          '<div style="background:#d97706;border-radius:3px;height:5px;width:'+pct+'%"></div>'+
          '</div>'+
          '<div style="font-size:10px;color:#444;margin-top:2px">'+v.count+' sessions \xB7 out '+fmtK(v.output)+'</div>'+
          '</div>';
      }).join('');
      document.getElementById('dash-proj').innerHTML = html||'<p style="color:#555;font-size:12px">No data</p>';
    }

    function renderTable(filtered){
      var rows=filtered.filter(function(s){
        var mq=!filterQ||s.title.toLowerCase().includes(filterQ)||s.proj.toLowerCase().includes(filterQ);
        var mp=filterProj==='All'||s.proj===filterProj;
        return mq&&mp;
      });
      rows.sort(function(a,b){
        var av=a[sortCol],bv=b[sortCol];
        if(typeof av==='string') return sortAsc?av.localeCompare(bv):bv.localeCompare(av);
        return sortAsc?av-bv:bv-av;
      });
      document.getElementById('tbl-count').textContent = rows.length+' / '+filtered.length+' sessions';
      document.getElementById('sess-tbody').innerHTML = rows.map(function(s){
        return '<tr style="cursor:pointer" data-sid="'+esc(s.id)+'">'
          +'<td>'+esc(s.date)+'</td>'
          +'<td title="'+esc(s.title)+'" style="max-width:260px">'+esc(s.title)+'</td>'
          +'<td style="max-width:140px;color:#888896" title="'+esc(s.proj)+'">'+esc(s.proj)+'</td>'
          +'<td>'+modelTag(s.model)+'</td>'
          +'<td class="num">'+fmtK(s.out)+'</td>'
          +'<td class="num">'+fmtK(s.inp)+'</td>'
          +'<td class="num">'+fmtK(s.cr)+'</td>'
          +'<td class="cost-cell">'+fmtCost(s.cost)+'</td>'
          +'</tr>';
      }).join('');
    }

    function applyFilter(){
      var filtered = getDateFiltered();
      var agg = aggregate(filtered);
      renderCards(agg.t, filtered.length, agg.projCount);
      renderChart(agg.byDate);
      renderModels(agg.byModel);
      renderProj(agg.byProj);
      renderTable(filtered);
      var df=document.getElementById('dash-date-from').value;
      var dt=document.getElementById('dash-date-to').value;
      document.getElementById('dash-period-lbl').textContent =
        (df||dt) ? (df||'…')+' → '+(dt||'…')+' \xB7 '+filtered.length+' sessions' : 'All time \xB7 '+filtered.length+' sessions';
    }

    function render(){ renderTable(getDateFiltered()); }

    function setSortCol(col){
      if(sortCol===col) sortAsc=!sortAsc; else { sortCol=col; sortAsc=false; }
      document.querySelectorAll('th[data-col]').forEach(function(th){
        var arr = th.querySelector('.arr');
        if(th.dataset.col===col){ arr.textContent=sortAsc?'▲':'▼'; arr.style.opacity='1'; }
        else { arr.textContent='▼'; arr.style.opacity='.25'; }
      });
      render();
    }

    var sel = document.getElementById('tbl-proj');
    PROJECTS.forEach(function(p){ var o=document.createElement('option'); o.value=p; o.textContent=p; sel.appendChild(o); });

    document.getElementById('tbl-search').addEventListener('input', function(e){ filterQ=e.target.value.toLowerCase(); render(); });
    document.getElementById('tbl-proj').addEventListener('change', function(e){ filterProj=e.target.value; render(); });
    document.querySelectorAll('th[data-col]').forEach(function(th){
      th.addEventListener('click', function(){ setSortCol(th.dataset.col); });
    });
    document.getElementById('sess-tbody').addEventListener('click', function(e){
      var tr = e.target.closest('tr[data-sid]');
      if(tr) window.location.href = '/?sid=' + encodeURIComponent(tr.dataset.sid);
    });
    document.getElementById('dash-date-from').addEventListener('change', applyFilter);
    document.getElementById('dash-date-to').addEventListener('change', applyFilter);
    document.getElementById('btn-clear-date').addEventListener('click', function(){
      document.getElementById('dash-date-from').value='';
      document.getElementById('dash-date-to').value='';
      applyFilter();
    });
    applyFilter();
  `;

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Claude Dashboard</title>'
    + '<style>' + css + '</style></head><body>'
    + nav
    + '<div class="page">'

    // date filter bar
    + '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;background:#1a1a1f;border:1px solid #2e2e36;border-radius:8px;padding:10px 14px">'
    + '<span style="font-size:10px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:.08em;margin-right:4px">Period</span>'
    + '<input id="dash-date-from" type="date" style="padding:4px 8px;background:#111;border:1px solid #2e2e36;border-radius:5px;color:#e2e2e8;font-size:12px;outline:none;color-scheme:dark">'
    + '<span style="color:#555560;font-size:12px">&#8594;</span>'
    + '<input id="dash-date-to" type="date" style="padding:4px 8px;background:#111;border:1px solid #2e2e36;border-radius:5px;color:#e2e2e8;font-size:12px;outline:none;color-scheme:dark">'
    + '<button id="btn-clear-date" style="padding:3px 10px;background:transparent;border:1px solid #2e2e36;border-radius:5px;color:#555560;font-size:11px;cursor:pointer;margin-left:4px">Clear</button>'
    + '<span id="dash-period-lbl" style="font-size:11px;color:#555560;margin-left:auto"></span>'
    + '</div>'

    // stat cards (dynamic)
    + '<div class="cards" id="dash-cards"></div>'

    // chart row (dynamic)
    + '<div class="top-row">'
    + '<div class="box"><div class="sec-title">Daily Cost</div><div id="dash-chart"></div></div>'
    + '<div class="box"><div class="sec-title">By Model</div><div id="dash-models"></div></div>'
    + '</div>'

    // project bars (dynamic)
    + '<div class="box" style="margin-bottom:20px"><div class="sec-title">By Project</div><div id="dash-proj"></div></div>'

    // sessions table
    + '<div class="tbl-wrap">'
    + '<div class="tbl-toolbar">'
    + '<div class="sec-title" style="margin:0">All Sessions</div>'
    + '<input id="tbl-search" type="text" placeholder="Search title / project…">'
    + '<select id="tbl-proj"></select>'
    + '<span id="tbl-count" class="tbl-count"></span>'
    + '</div>'
    + '<div class="tbl-scroll"><table>'
    + '<thead><tr>'
    + '<th data-col="date">Date<span class="arr">▼</span></th>'
    + '<th data-col="title">Title<span class="arr">▼</span></th>'
    + '<th data-col="proj">Project<span class="arr">▼</span></th>'
    + '<th data-col="model">Model<span class="arr">▼</span></th>'
    + '<th data-col="out" style="text-align:right">Out<span class="arr">▼</span></th>'
    + '<th data-col="inp" style="text-align:right">In<span class="arr">▼</span></th>'
    + '<th data-col="cr" style="text-align:right">Cache↓<span class="arr">▼</span></th>'
    + '<th data-col="cost" style="text-align:right">Est. Cost<span class="arr">▼</span></th>'
    + '</tr></thead>'
    + '<tbody id="sess-tbody"></tbody>'
    + '</table></div>'
    + '</div>'

    + '<p class="note">* Pricing: sonnet $3/$15, opus $15/$75, haiku $0.80/$4 (in/out per MTok). Cache read $0.30/$1.50/$0.08. Not actual billed amounts.</p>'
    + '</div>'
    + '<script>' + js + '</script>'
    + '</body></html>';
}

// ── server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/api/sessions') {
    try {
      const sessions = loadAllSessions();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(sessions));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/dashboard') {
    try {
      const sessions = loadAllSessions();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buildDashboard(sessions));
    } catch (e) {
      res.writeHead(500);
      res.end('<pre>' + e.message + '\n' + e.stack + '</pre>');
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(buildHtml());
});

// ── static mode ──────────────────────────────────────────────────────────────
if (args.includes('--static')) {
  const sessions = loadAllSessions();
  sessions.forEach(s => { s.cost = calcCost(s.model, s.totals); });
  const html = buildHtml(sessions);
  const out = path.join(os.tmpdir(), 'claude-session-viewer.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('Generated: ' + out);
  const openCmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  require('child_process').exec(openCmd + ' "' + out + '"');
  process.exit(0);
}

function onListen() {
  const url = 'http://localhost:' + PORT;
  console.log('Claude Session Viewer: ' + url);
  console.log('Reading from: ' + BASE);
  console.log('Ctrl+C to stop.\n');
  if (!NO_OPEN) {
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('child_process').exec(cmd + ' ' + url);
  }
}

function freePort(port, cb) {
  const { exec } = require('child_process');
  if (process.platform === 'win32') {
    exec('netstat -ano', (err, stdout) => {
      if (err) return cb();
      const pids = new Set();
      stdout.split('\n').forEach(line => {
        if (line.includes(':' + port) && line.includes('LISTENING')) {
          const m = line.trim().match(/(\d+)\s*$/);
          if (m) pids.add(m[1]);
        }
      });
      if (!pids.size) return cb();
      let done = 0;
      pids.forEach(pid => {
        exec('taskkill /F /PID ' + pid, () => { if (++done === pids.size) cb(); });
      });
    });
  } else {
    exec('fuser -k ' + port + '/tcp', cb);
  }
}

let retried = false;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !retried) {
    retried = true;
    console.log('Port ' + PORT + ' in use — freeing and retrying…');
    freePort(PORT, () => {
      setTimeout(() => server.listen(PORT, '127.0.0.1', onListen), 300);
    });
  } else {
    console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' still in use.' : e.message);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', onListen);

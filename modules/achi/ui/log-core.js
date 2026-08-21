const isJwt = s => typeof s==='string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s);
function jwtPayload(t){
  try{ let p=t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'); while(p.length%4) p+='=';
    return JSON.parse(atob(p)); }catch(e){ return null; }
}
/* Both tokens this API issues are JWTs, so "looks like a JWT" is not enough to
   identify an access token. The scan below walks every storage key, and a
   refresh token sitting in one of them would be picked up and sent as a bearer
   — which the API rejects, so every request 401s forever. The payload carries
   type:"access" | "refresh"; anything typed "refresh" is excluded. Tokens with
   no type claim are still accepted, so older sessions keep working. */
const isAccessJwt = s => isJwt(s) && (jwtPayload(s)||{}).type!=='refresh';
function scanStorage(match){
  for(const store of [localStorage, sessionStorage]){
    for(let i=0;i<store.length;i++){ const v=store.getItem(store.key(i));
      if(match(v)) return v;
      if(v && v[0]==='{'){ try{ const o=JSON.parse(v);
        for(const c of [o.access_token,o.refresh_token,o.token,o.state&&o.state.access_token,o.state&&o.state.refresh_token,o.state&&o.state.token])
          if(match(c)) return c;
      }catch(e){} } }
  }
  return null;
}
function getToken(){
  const direct = localStorage.getItem('oe_access_token');
  if(isAccessJwt(direct)) return direct;
  return scanStorage(isAccessJwt);
}
function getRefreshToken(){
  const direct = localStorage.getItem('oe_refresh_token');
  if(isJwt(direct)) return direct;
  return scanStorage(s => isJwt(s) && (jwtPayload(s)||{}).type==='refresh');
}
let TOKEN=getToken();   // reassigned by refreshToken() when the access token expires
const API='/api/v1/achi';
const $=id=>document.getElementById(id);
/* Shared dark ACHI hero for General Log-style workspaces.
   The page title comes from each page's existing data-achi-title attribute. */
(function addAchiLogHero(){
  if(window.ACHI_GENERAL_LOG !== true) return;

  const main=document.querySelector('main');
  if(!main || document.getElementById('achi-log-hero')) return;

  const title=(document.body.dataset.achiTitle || 'Log').trim();
  const hero=document.createElement('section');
  hero.id='achi-log-hero';
  hero.className='achi-log-hero';

  const eyebrow=document.createElement('div');
  eyebrow.className='achi-log-hero__eyebrow';
  eyebrow.textContent='ACHI SCAFFOLDING';

  const heading=document.createElement('h1');
  heading.className='achi-log-hero__title';
  heading.textContent=title;

  const subtitle=document.createElement('p');
  subtitle.className='achi-log-hero__subtitle';
  subtitle.textContent='Manage prospects, customer calls, follow-ups and quotations in one place.';

  hero.append(eyebrow, heading, subtitle);

  const kpis=main.querySelector('.kpis');
  if(kpis) main.insertBefore(hero, kpis);
  else main.appendChild(hero);
})();
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* Quick notes is a Quill editor now, so `description` can hold formatting HTML.
   Render it SAFELY: allow only Quill's formatting tags, strip every attribute,
   drop script/style, unwrap anything else to its text. Rendering stored HTML is
   an XSS vector — this is the whitelist that closes it. */
const RICH_TAGS=new Set(['P','BR','STRONG','B','EM','I','U','S','OL','UL','LI','BLOCKQUOTE','SPAN']);
function richText(html){
  const doc=new DOMParser().parseFromString(String(html??''),'text/html');
  (function walk(node){
    [...node.childNodes].forEach(ch=>{
      if(ch.nodeType!==1) return;
      if(ch.tagName==='SCRIPT'||ch.tagName==='STYLE'){ ch.remove(); return; }
      walk(ch);
      [...ch.attributes].forEach(a=>ch.removeAttribute(a.name));
      if(!RICH_TAGS.has(ch.tagName)) ch.replaceWith(...ch.childNodes);
    });
  })(doc.body);
  return doc.body.innerHTML;
}
const looksHTML=s=>/<\/?[a-z][\s\S]*>/i.test(String(s||''));   // old plain-text descs have no tags
/* The table's notes/files workspace is intentionally a plain textarea. Turn
   Quill HTML into readable text there instead of exposing tags to the user. */
function richTextToPlain(value){
  const source=String(value??'');
  if(!looksHTML(source)) return source;
  const doc=new DOMParser().parseFromString(richText(source),'text/html');
  const blocks=new Set(['P','DIV','H1','H2','H3','H4','H5','H6','BLOCKQUOTE']);
  const walk=node=>{
    if(node.nodeType===Node.TEXT_NODE) return node.nodeValue||'';
    if(node.nodeType!==Node.ELEMENT_NODE) return '';
    if(node.tagName==='BR') return '\n';
    const body=[...node.childNodes].map(walk).join('');
    if(node.tagName==='LI'){
      const parent=node.parentElement, ordered=parent&&parent.tagName==='OL';
      const index=ordered?[...parent.children].indexOf(node)+1:null;
      return `${ordered?index+'. ':'• '}${body.trim()}\n`;
    }
    return blocks.has(node.tagName)?body+'\n':body;
  };
  return walk(doc.body).replace(/\u200b/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

/* CAD preview. For a .dwg/.dxf attachment, ask the server to render it to SVG
   (/attachments/{id}/render) and show it in a modal. Any failure — a DWG on a
   server without LibreDWG, an unreadable file, too big — falls back to the
   caller's download(). Shared by both file lists (note workspace + quick notes),
   so there is one preview and one modal. */
/* Inline preview cards. A previewable attachment (DWG/DXF -> SVG, RVT/IFC -> 3D)
   expands as a card directly below its row rather than a popup, and a second
   click toggles it away. cadPreview(id,name,rowEl) is the shared entry both file
   lists call; renderCadSvg / renderModel3D fill the card body by type. */
const _PREVIEW_EXTS=['dwg','dxf','rvt','ifc'];
function isPreviewable(name){ return _PREVIEW_EXTS.includes((name||'').split('.').pop().toLowerCase()); }
async function attDownload(id,name){
  try{
    const r=await fetch(`${API}/attachments/${id}/download`,{headers:{Authorization:'Bearer '+TOKEN}});
    const url=URL.createObjectURL(await r.blob());
    const a=document.createElement('a'); a.href=url; a.download=name||'drawing'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(_){}
}
/* Open a DWG/DXF in OCE's DWG-Takeoff editor (rulers/measure/annotate) or a PDF
   in the PDF-Takeoff editor (scale/measure). The server uploads it into the
   editor (cached per attachment) and hands back the URL; we open it in a new
   tab. window.open() runs synchronously first so the pop-up isn't blocked. */
async function openInTakeoff(id,name){
  const w=window.open('','_blank');
  if(w){ try{ w.document.write('<p style="font:14px -apple-system,Segoe UI,sans-serif;color:#555;padding:26px">Opening in the editor…</p>'); }catch(_){} }
  try{
    const r=await fetch(`${API}/attachments/${id}/takeoff`,{method:'POST',headers:{Authorization:'Bearer '+TOKEN}});
    if(!r.ok){ const b=await r.json().catch(()=>({})); throw new Error(b.detail||'Could not open the editor'); }
    const d=await r.json();
    // The DWG editor loads drawings for the ACTIVE project; point it at the
    // project this drawing was uploaded into so it opens straight into the edit
    // view instead of the "upload a file" empty state. (Same-origin localStorage
    // is read by the editor tab on load.)
    if(d.project_id){   // DWG & BIM editors are scoped to a project — make ours active
      try{ localStorage.setItem('oe_active_project', JSON.stringify({id:d.project_id,name:'Call Log Drawings'})); }catch(_){}
    }
    if(w) w.location.href=d.url; else window.open(d.url,'_blank');
  }catch(e){ if(w){ try{w.close();}catch(_){} } alert(e.message||'Could not open the editor'); }
}
function cadPreview(id,name,rowEl){
  if(!rowEl) return;
  const nxt=rowEl.nextElementSibling;
  if(nxt&&nxt.classList.contains('att-card')&&nxt.dataset.for===id){ nxt.remove(); return; }  // toggle off
  // One card open per list at a time.
  rowEl.parentElement&&rowEl.parentElement.querySelectorAll(':scope > .att-card').forEach(c=>c.remove());
  const card=document.createElement('div'); card.className='att-card'; card.dataset.for=id;
  card.innerHTML=`<div class="att-card-bar"><span class="att-card-name">${esc(name)}</span>
    <span class="att-card-actions"><button type="button" class="att-card-dl">Download</button>
      <button type="button" class="att-card-x" aria-label="Close">&times;</button></span></div>
    <div class="att-card-body"><div class="cad-loading">Loading preview…</div></div>`;
  rowEl.after(card);
  card.querySelector('.att-card-dl').onclick=()=>attDownload(id,name);
  card.querySelector('.att-card-x').onclick=()=>card.remove();
  const body=card.querySelector('.att-card-body'), alive=()=>card.isConnected;
  const ext=(name||'').split('.').pop().toLowerCase();
  if(ext==='rvt'||ext==='ifc') renderModel3D(body,id,name,alive);
  else renderCadSvg(body,id,name,alive);
  requestAnimationFrame(()=>card.scrollIntoView({block:'nearest',behavior:'smooth'}));
}
async function renderCadSvg(body,id,name,alive){
  try{
    const r=await fetch(`${API}/attachments/${id}/render`,{headers:{Authorization:'Bearer '+TOKEN}});
    if(!r.ok){ const b=await r.json().catch(()=>({})); throw new Error(b.detail||'Could not render this file'); }
    const svg=await r.text(); if(!alive()) return;
    body.innerHTML=`<div class="att-svg">${svg}</div>`;
    // In the big popover, make the drawing pan/zoom-able (scroll to zoom, drag
    // to pan) and add the zoom/rotate control strip. The small tile thumbnail
    // stays static and toolless.
    if(body.closest('.att-preview')){
      const pz=attachPanZoom(body.querySelector('.att-svg'));
      buildCadTools(body,pz);
    }
  }catch(e){ if(alive()) body.innerHTML=`<div class="cad-msg"><b>Preview not available</b><br>${esc(e.message)}<br><br>Use <b>Download</b> above to open it in your CAD app.</div>`; }
}
/* Scroll-to-zoom (toward the cursor) + drag-to-pan on the SVG inside a container.
   Uses a CSS transform and pointer capture, so a drag keeps working outside the
   box and nothing leaks onto window. */
function attachPanZoom(box){
  if(!box) return null;
  const svg=box.querySelector('svg'); if(!svg) return null;
  box.classList.add('att-svg-pz');
  let scale=1,tx=0,ty=0,rot=0,drag=false,ox=0,oy=0;
  // Rotation reads best around the drawing's centre, so pan (translate) is the
  // outermost transform (screen-space) and zoom/rotate happen around the centre.
  svg.style.transformOrigin='center center';
  const apply=()=>{ svg.style.transform=`translate(${tx}px,${ty}px) rotate(${rot}deg) scale(${scale})`; };
  const zoom=f=>{ scale=Math.min(40,Math.max(0.2,scale*f)); apply(); };
  box.addEventListener('wheel',e=>{ e.preventDefault(); zoom(Math.exp(-e.deltaY*0.0016)); },{passive:false});
  svg.addEventListener('pointerdown',e=>{ drag=true; ox=e.clientX-tx; oy=e.clientY-ty; try{svg.setPointerCapture(e.pointerId);}catch(_){}; box.classList.add('grabbing'); });
  svg.addEventListener('pointermove',e=>{ if(!drag)return; tx=e.clientX-ox; ty=e.clientY-oy; apply(); });
  const end=e=>{ drag=false; try{svg.releasePointerCapture(e.pointerId);}catch(_){}; box.classList.remove('grabbing'); };
  svg.addEventListener('pointerup',end); svg.addEventListener('pointercancel',end);
  const reset=()=>{ scale=1;tx=0;ty=0;rot=0;apply(); };
  svg.addEventListener('dblclick',reset);                                // double-click resets
  return { zoom, rotate:d=>{ rot=(rot+(d||90))%360; apply(); }, reset };
}
// Small icon-or-text button for the expanded-preview control strip.
function prevTool(label,title,onClick){
  const b=document.createElement('button');
  b.type='button'; b.className='att-tool'; b.title=title; b.innerHTML=label;
  b.addEventListener('click',e=>{ e.stopPropagation(); onClick(b); });
  return b;
}
const ICON_ROTATE='<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
const ICON_SPIN='<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
// DWG/DXF: zoom + rotate strip driven by the pan/zoom controller above.
function buildCadTools(body,pz){
  const tools=body.closest('.att-preview')?.querySelector('.att-prev-tools');
  if(!tools||!pz) return;
  tools.innerHTML=''; tools.hidden=false;
  tools.appendChild(prevTool('&minus;','Zoom out',()=>pz.zoom(1/1.3)));
  tools.appendChild(prevTool('+','Zoom in',()=>pz.zoom(1.3)));
  const s=document.createElement('span'); s.className='sep'; tools.appendChild(s);
  tools.appendChild(prevTool(ICON_ROTATE,'Rotate 90°',()=>pz.rotate(90)));
  const s2=document.createElement('span'); s2.className='sep'; tools.appendChild(s2);
  tools.appendChild(prevTool('Fit','Reset view',()=>pz.reset()));
}
// RVT/IFC: orthographic view gizmos + spin toggle for the model-viewer.
function build3DTools(body,mv,hooks){
  const tools=body.closest('.att-preview')?.querySelector('.att-prev-tools');
  if(!tools) return;
  tools.innerHTML=''; tools.hidden=false;
  const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent='View'; tools.appendChild(lbl);
  const jump=orbit=>{ mv.setAttribute('camera-orbit',orbit); try{ mv.jumpCameraToGoal&&mv.jumpCameraToGoal(); }catch(_){}; };
  tools.appendChild(prevTool('Front','Front view',()=>jump('0deg 90deg auto')));
  tools.appendChild(prevTool('Back','Back view',()=>jump('180deg 90deg auto')));
  tools.appendChild(prevTool('Top','Top view',()=>jump('0deg 0deg auto')));
  tools.appendChild(prevTool('Side','Side view',()=>jump('90deg 90deg auto')));
  tools.appendChild(prevTool('Iso','Isometric view',()=>jump('45deg 60deg auto')));
  const s=document.createElement('span'); s.className='sep'; tools.appendChild(s);
  const spin=prevTool(ICON_SPIN+'<span>Spin</span>','Toggle auto-rotate',b=>{ b.classList.toggle('on',hooks.toggleSpin()); });
  tools.appendChild(spin);
  const s2=document.createElement('span'); s2.className='sep'; tools.appendChild(s2);
  tools.appendChild(prevTool('Reset','Reset view',()=>{ try{ mv.resetTurntableRotation&&mv.resetTurntableRotation(); }catch(_){}; jump('auto auto auto'); }));
}
/* <model-viewer> is loaded lazily on first 3D use so the 1 MB never touches
   normal Call Log browsing. */
let _mvLoad=null;
function ensureModelViewer(){
  if(window.customElements&&customElements.get('model-viewer')) return Promise.resolve();
  if(_mvLoad) return _mvLoad;
  _mvLoad=new Promise((resolve,reject)=>{
    const s=document.createElement('script'); s.type='module'; s.src=`${API}/ui/model-viewer.js`;
    s.onload=()=>customElements.whenDefined('model-viewer').then(resolve,resolve);
    s.onerror=()=>reject(new Error('Could not load the 3D viewer'));
    document.head.appendChild(s);
  });
  return _mvLoad;
}
async function renderModel3D(body,id,name,alive){
  const H={Authorization:'Bearer '+TOKEN};
  const msg=h=>{ if(alive()) body.innerHTML=h; };
  try{
    msg('<div class="cad-loading">Preparing 3D model… a large model can take a minute.</div>');
    const pr=await fetch(`${API}/attachments/${id}/model/prepare`,{method:'POST',headers:H});
    if(!pr.ok){ const b=await pr.json().catch(()=>({})); throw new Error(b.detail||'Could not prepare the model'); }
    let st=(await pr.json()).status; const t0=Date.now();
    while(st==='processing'){
      if(!alive()) return;                                    // card closed
      if(Date.now()-t0>6*60*1000) throw new Error('Timed out preparing the model');
      await new Promise(r=>setTimeout(r,2500));
      const sj=await (await fetch(`${API}/attachments/${id}/model/status`,{headers:H})).json()
                     .catch(()=>({status:'error',error:'Status check failed'}));
      st=sj.status;
      if(st==='error') throw new Error(sj.error||'Could not build the 3D model');
    }
    if(st!=='ready') throw new Error('Model is not ready');
    msg('<div class="cad-loading">Loading 3D view…</div>');
    // Load the .glb from its real same-origin URL (connect-src 'self' allows it;
    // a blob: URL is CSP-blocked). model-viewer can't set an Authorization
    // header, so the token rides as ?token= — the endpoint accepts either.
    try{ await ensureModelViewer(); }
    catch(_){ throw new Error('Could not load the 3D viewer'); }
    if(!alive()) return;
    body.innerHTML='';
    const mv=document.createElement('model-viewer');
    mv.setAttribute('src',`${API}/attachments/${id}/model.glb?token=${encodeURIComponent(TOKEN)}`);
    mv.setAttribute('camera-controls','');
    mv.setAttribute('interaction-prompt','none');
    mv.setAttribute('shadow-intensity','1');
    mv.setAttribute('exposure','1.1');
    mv.style.cssText='width:100%;height:72vh;background:#fff;display:block;border-radius:8px';
    // Idle-frozen to spare the GPU (model-viewer renders on demand — no auto-
    // rotate means no frames while idle); spin only while the pointer is over
    // it, UNLESS the Spin toolbar button has pinned it on.
    let spinSticky=false;
    mv.addEventListener('pointerenter',()=>mv.setAttribute('auto-rotate',''));
    mv.addEventListener('pointerleave',()=>{ if(!spinSticky) mv.removeAttribute('auto-rotate'); });
    mv.addEventListener('error',()=>{ if(alive()) msg('<div class="cad-msg"><b>3D preview not available</b><br>The model could not be displayed.<br><br>Use <b>Download</b> above to open it in your CAD app.</div>'); });
    body.appendChild(mv);
    // Expanded popover: orthographic view gizmos + spin toggle at the top.
    if(body.closest('.att-preview')){
      build3DTools(body,mv,{ toggleSpin:()=>{ spinSticky=!spinSticky; if(spinSticky) mv.setAttribute('auto-rotate',''); else mv.removeAttribute('auto-rotate'); return spinSticky; } });
    }
  }catch(e){
    msg(`<div class="cad-msg"><b>3D preview not available</b><br>${esc(e.message)}<br><br>Use <b>Download</b> above to open it in your CAD app.</div>`);
  }
}

/* ── Gallery cards: every attachment shows its own preview inline ──────────── */
const IMG_EXTS=['png','jpg','jpeg','gif','webp','bmp','svg','avif'];
function isImage(n){ return IMG_EXTS.includes((n||'').split('.').pop().toLowerCase()); }
function isPdf(n){ return (n||'').split('.').pop().toLowerCase()==='pdf'; }
function hasPreview(name){ return isPreviewable(name)||isImage(name)||isPdf(name); }
function attFmtSize(n){ n=+n||0; return n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B'; }
// Same-origin URL with the JWT as ?token so <img>/new-tab loads work (no header).
function rawUrl(id){ return `${API}/attachments/${id}/download?token=${encodeURIComponent(TOKEN)}`; }

function renderImage(body,id,name){
  const url=rawUrl(id);
  body.innerHTML=`<img class="att-img" src="${esc(url)}" alt="${esc(name)}" loading="lazy" title="Click to open full size">`;
  const img=body.querySelector('img');
  img.onerror=()=>{ body.innerHTML='<div class="cad-msg">Could not load image. Use <b>Download</b> above.</div>'; };
  img.onclick=()=>window.open(url,'_blank','noreferrer');
}

// pdf.js loaded lazily on first PDF; falls back to main-thread render if the
// worker can't spawn (CSP), so it renders regardless.
let _pdfLib=null;
function ensurePdfJs(){
  if(_pdfLib) return _pdfLib;
  _pdfLib=import(`${API}/ui/pdf.min.mjs`).then(m=>{ try{ m.GlobalWorkerOptions.workerSrc=`${API}/ui/pdf.worker.min.mjs`; }catch(_){}; return m; });
  return _pdfLib;
}
async function renderPdf(body,id,name,alive){
  const url=rawUrl(id);
  try{
    const lib=await ensurePdfJs();
    const buf=await (await fetch(`${API}/attachments/${id}/download`,{headers:{Authorization:'Bearer '+TOKEN}})).arrayBuffer();
    if(!alive()) return;
    const pdf=await lib.getDocument({data:buf}).promise;
    const page=await pdf.getPage(1);
    const base=page.getViewport({scale:1});
    const vp=page.getViewport({scale:Math.min(2,780/base.width)});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(vp.width); canvas.height=Math.ceil(vp.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    if(!alive()) return;
    // As an <img> (not a raw canvas) so it can object-fit a square tile.
    const img=document.createElement('img'); img.className='att-pdf'; img.src=canvas.toDataURL('image/png'); img.title='Click to open the PDF';
    body.innerHTML='';
    const wrap=document.createElement('div'); wrap.className='att-pdf-wrap'; wrap.appendChild(img);
    const hint=document.createElement('div'); hint.className='att-pdf-hint'; hint.textContent=`Page 1 of ${pdf.numPages} · click to open`;
    wrap.appendChild(hint); body.appendChild(wrap);
    img.onclick=()=>window.open(url,'_blank','noreferrer');
  }catch(e){ if(alive()) body.innerHTML='<div class="cad-msg">Could not preview this PDF. Use <b>Download</b> above to open it.</div>'; }
}

function renderPreviewByType(body,f,alive){
  const name=f.filename, ext=(name||'').split('.').pop().toLowerCase();
  if(IMG_EXTS.includes(ext)) return renderImage(body,f.id,name);
  if(ext==='pdf') return renderPdf(body,f.id,name,alive);
  if(ext==='dwg'||ext==='dxf') return renderCadSvg(body,f.id,name,alive);
  if(ext==='rvt'||ext==='ifc') return renderModel3D(body,f.id,name,alive);
  body.innerHTML='<div class="cad-msg">No preview for this file type. Use <b>Download</b> above.</div>';
}

/* One card per attachment; the preview loads lazily when the card scrolls into
   view, so a log with many files (or several RVTs) doesn't fetch/convert them
   all at once. delAttr is the list's delete-button data attribute so the
   existing delete delegation keeps working. */
function tileBadge(ext){
  if(ext==='rvt'||ext==='ifc') return '3D · '+ext.toUpperCase();
  if(ext==='dwg'||ext==='dxf') return 'CAD · '+ext.toUpperCase();
  if(IMG_EXTS.includes(ext)) return 'IMG · '+ext.toUpperCase();
  if(ext==='pdf') return 'PDF';
  return (ext||'FILE').toUpperCase();
}
var CUBE_SVG='<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
/* Square preview tile in a horizontal strip. The tile itself shows the preview
   (image/PDF/DWG rendered as a thumbnail; RVT/IFC show a 3D placeholder — a live
   model per tile is too heavy). Hovering lifts a larger pure-white popover with
   the full preview (the interactive 3D model for RVT). Clicking opens the file in
   a new page (image/PDF); CAD/RVT click is a no-op for now — behaviour TBD.
   delAttr keeps existing delete delegation working. */
function attachmentTile(f, delAttr, noPop){
  const ext=(f.filename||'').split('.').pop().toLowerCase();
  const is3d=(ext==='rvt'||ext==='ifc');
  const canPreview=hasPreview(f.filename);
  const hasEditor=(isPdf(f.filename)||ext==='dwg'||ext==='dxf'||is3d);   // has an OCE editor (takeoff / 3D)
  const tile=document.createElement('div'); tile.className='att-tile'; tile.dataset.for=f.id;
  var thumbHtml = is3d ? '<div class="att-3d-ph">'+CUBE_SVG+'<span>'+esc(ext.toUpperCase())+'</span></div>'
                       : (canPreview ? '<div class="cad-loading"></div>'
                                     : '<div class="att-3d-ph"><span>'+esc(ext.toUpperCase()||'FILE')+'</span></div>');
  tile.innerHTML=`
    <div class="att-tile-face" title="${esc(f.filename)}">
      <div class="att-tile-thumb">${thumbHtml}</div>
      <span class="att-tile-badge">${esc(tileBadge(ext))}</span>
      <div class="att-tile-cap">${esc(f.filename)}</div>
      ${delAttr?`<button type="button" class="att-tile-x" ${delAttr}="${esc(f.id)}" title="Remove">&times;</button>`:''}
    </div>
    <div class="att-preview">
      <div class="att-prev-head"><span>${esc(f.filename)}</span>
        <span class="att-prev-actions">
          ${hasEditor?`<button type="button" class="att-prev-edit">${is3d?'Open in 3D':'Open in editor'}</button>`:''}
          <button type="button" class="att-prev-dl" title="Download"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
        </span></div>
      <div class="att-prev-tools" hidden></div>
      <div class="att-prev-body">${canPreview?'<div class="cad-loading">Preview…</div>':'<div class="cad-msg">No preview for this type. Use the download button.</div>'}</div>
    </div>`;
  const face=tile.querySelector('.att-tile-face');
  const pop=tile.querySelector('.att-preview');
  const thumb=tile.querySelector('.att-tile-thumb');
  const popBody=tile.querySelector('.att-prev-body');
  const alive=()=>tile.isConnected;
  const openNew=()=>window.open(rawUrl(f.id),'_blank','noreferrer');
  tile.querySelector('.att-prev-dl').addEventListener('click',e=>{ e.stopPropagation(); attDownload(f.id,f.filename); });
  const editBtn=tile.querySelector('.att-prev-edit');
  if(editBtn) editBtn.addEventListener('click',e=>{ e.stopPropagation(); openInTakeoff(f.id,f.filename); });
  face.addEventListener('click',e=>{
    if(e.target.closest('.att-tile-x')) return;                 // delete handled by delegation
    if(isImage(f.filename)){ openNew(); return; }               // image -> view in a new tab
    if(hasEditor){ openInTakeoff(f.id,f.filename); return; }     // dwg/dxf -> takeoff, pdf -> measure, rvt/ifc -> 3D
  });
  // Tile thumbnail: render the real preview for image/PDF/DWG lazily when the
  // tile scrolls into view. RVT/IFC keep the placeholder (converting a model per
  // tile is too heavy); the live model loads in the hover popover.
  if(canPreview && !is3d){
    let ts=false;
    const start=()=>{ if(ts)return; ts=true; renderPreviewByType(thumb,f,alive); };
    if('IntersectionObserver' in window){
      const io=new IntersectionObserver(es=>{ es.forEach(e=>{ if(e.isIntersecting){ start(); io.disconnect(); } }); },{rootMargin:'200px'});
      io.observe(tile);
    } else start();
  }
  // Hover: open the centred popover (a grace timer lets the pointer travel to it
  // to interact — orbit 3D, scroll a PDF) and load the larger preview on first
  // hover. Moving off both the tile and the popover closes it. noPop skips this
  // (used inside the description-cell hover strip, which is itself a popover — a
  // nested one would be janky); those tiles are just thumbnails you click.
  if(!noPop){
    let ps=false;
    face.addEventListener('mouseenter',()=>{
      openPop(pop);
      if(canPreview && !ps){ ps=true; renderPreviewByType(popBody,f,alive); }
    });
    face.addEventListener('mouseleave',()=>laterHidePop(pop));
    pop.addEventListener('mouseenter',keepPop);
    pop.addEventListener('mouseleave',()=>laterHidePop(pop));
  }
  return tile;
}
// One centred preview popover open at a time, with a grace period so the pointer
// can cross from the tile to the (screen-centred) popover without it vanishing.
var _openPop=null, _popHideTimer=null;
function keepPop(){ clearTimeout(_popHideTimer); }
function openPop(pop){ clearTimeout(_popHideTimer); if(_openPop&&_openPop!==pop) _openPop.classList.remove('open'); pop.classList.add('open'); _openPop=pop; }
function laterHidePop(pop){ clearTimeout(_popHideTimer); _popHideTimer=setTimeout(function(){ pop.classList.remove('open'); if(_openPop===pop) _openPop=null; },260); }

const fail=m=>{const e=$('err');e.textContent=m;e.style.display='block';};
const clearErr=()=>{$('err').style.display='none';};
const validEmail=v=>!String(v||'').trim()||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const validLebanonPhone=n=>/^(?:0?[13456789]\d{6}|2(?:1|4|5|6|7|8|9)\d{6}|(?:70|71|76|78|79|81)\d{6})$/.test(n);
const validMobile=v=>{const s=String(v||'').trim();if(!s)return true;if(!/^([0-9 +_\-,.*#()]){1,20}$/.test(s))return false;const digits=s.replace(/\D/g,'');if(/^\+?961(?:\D|$)/.test(s))return validLebanonPhone(digits.slice(3));return digits.length>=7&&digits.length<=15;};
function showFeedback(title,message,input=null){
  input&&input.classList.add('email-invalid');
  const existing=document.querySelector('.feedback');
  if(existing) return;
  const modal=document.createElement('div');
  modal.className='feedback'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('aria-labelledby','feedback-title');
  modal.innerHTML=`<div class="feedback-box"><div class="feedback-head" id="feedback-title">${esc(title)}</div><div class="feedback-body">${esc(message)}</div><div class="feedback-foot"><button class="feedback-ok" type="button">OK</button></div></div>`;
  document.body.appendChild(modal);
  const close=()=>{ modal.remove(); if(input&&input.isConnected){ input.focus(); input.select&&input.select(); } };
  modal.querySelector('.feedback-ok').onclick=close;
  modal.onmousedown=e=>{ if(e.target===modal) close(); };
  modal.onkeydown=e=>{ if(e.key==='Escape'||e.key==='Enter'){e.preventDefault();close();} };
  requestAnimationFrame(()=>modal.querySelector('.feedback-ok').focus());
}
/* One line for where the entry's contact went: created fresh, or matched an
   existing directory row (and by which key). Null when the row earned none. */
function contactSaveStatus(res){
  if(!res||!res.contact_id) return null;
  const name=res.contact_name?` “${res.contact_name}”`:'';
  if(res.contact_created) return `New contact${name} added to the directory`;
  const how={phone:'phone number',email:'email',company:'company name'}[res.contact_matched_by];
  return `Contact${name} already exists${how?' — matched by '+how:''}; no duplicate created`;
}
function showSavedFeedback(res){
  document.querySelector('.save-feedback')?.remove();
  const popup=document.createElement('div');
  popup.className='save-feedback';popup.setAttribute('role','status');popup.setAttribute('aria-live','polite');
  const cs=contactSaveStatus(res);
  popup.innerHTML='<span class="save-feedback-mark">✓</span><span>Log saved'+(cs?'<div class="save-feedback-sub">'+esc(cs)+'</div>':'')+'</span>';
  document.body.appendChild(popup);
  setTimeout(()=>popup.remove(),cs?4200:2600);
}
const showInvalidEmail=input=>showFeedback('Invalid Email','Please Enter a valid Email address',input);
const showInvalidMobile=input=>showFeedback('Invalid Phone Number','Please Enter a valid Phone Number',input);
/* Picklists for the expanded row. Free text on these fields let the same place
   arrive spelled three ways, which made the grid's filters unreliable. The
   values are the ones the team uses; DISTRICTS/CITIES are Lebanon-specific
   because that is where the sites are. */
const SOCIALS=['IG','FB','LinkedIn','TikTok','X'],
      LOG_STATES=['OPEN','SCHEDULED','VIEWED','CANCELLED','DONE','TRANSFERRED'],
      COPY_TARGETS=['Log only','Site Visit','CRM — new deal','Quotation','Project Files','Dispatch / Fleet','Inventory','Job Orders'],
      ROLES=['Owner','Engineer','Contractor','Foreman','Site manager','Architect','Procurement'],
      SUBJECTS=['External scaffolding','Rental per piece','New project','Current job status',
                'Off-hire','Adaptation','Inspection','Complaint','Invoice'],
      /* Country -> District -> City, for the countries ACHI works in. District is
         the top admin division (governorate/emirate/region), City the town under
         it. A country not in this map keeps District and City as free text, since
         accurate lists for the rest of the world cannot be hardcoded. */
      GEO={
        'Lebanon':{
          'Beirut':['Achrafieh','Hamra','Verdun','Mar Mikhael','Ras Beirut','Gemmayzeh','Badaro','Mazraa','Sodeco','Ain el Mreisseh','Ras el Nabaa','Zqaq el Blat','Bachoura','Msaytbeh','Ain el Tineh','Manara','Clemenceau','Kantari','Saifi','Rmeil'],
          'Mount Lebanon':['Baabda','Jounieh','Jbeil','Aley','Broummana','Bhamdoun','Dbayeh','Zalka','Antelias','Beit Mery','Bikfaya','Beit Chabab','Bteghrine','Baabdat','Zouk Mosbeh','Zouk Mikael','Kaslik','Jal el Dib','Naccache','Rabieh','Mansourieh','Dekwaneh','Sin el Fil','Hazmieh','Furn el Chebbak','Chiyah','Hadath','Kfarshima','Bsalim','Ain Saadeh','Bikfaya','Damour','Naameh','Choueifat','Bhamdoun','Sofar','Dhour Choueir','Bologna'],
          'North':['Tripoli','Zgharta','Batroun','Koura','Bcharre','Amioun','Chekka','Mina','Qalamoun','Kousba','Enfeh','Deddeh','Bterram','Kfarhata','Ehden','Kfarsghab','Tannourine','Douma','Hasroun','Bziza'],
          'Akkar':['Halba','Qoubaiyat','Bebnine','Chadra','Michmich','Fnaideq','Rahbeh','Bire','Aandqet','Tikrit','Cheikh Mohammad','Mounjez','Beino','Berqayel'],
          'Beqaa':['Zahle','Chtaura','Anjar','Bar Elias','Rayak','Taalabaya','Saadnayel','Jdita','Kab Elias','Ferzol','Ablah','Qab Elias','Majdel Anjar','Riyaq','Mreijat'],
          'Baalbek-Hermel':['Baalbek','Hermel','Deir el Ahmar','Ras Baalbek','Aarsal','Laboue','Nabi Chit','Douris','Chmistar','Britel','Younine','Fakiha'],
          'South':['Sidon','Tyre','Jezzine','Sarafand','Ghazieh','Zahrani','Nabatieh','Qana','Maghdouche','Anqoun','Rmeileh','Aadloun','Bisariyeh','Kfar Hatta','Ain el Delb'],
          'Nabatieh':['Nabatieh','Marjayoun','Hasbaya','Bint Jbeil','Kfar Roummane','Zawtar','Habbouch','Ansar','Doueir','Kfar Tibnit','Arnoun','Chaqra','Tebnine','Aitaroun','Ainata'],
        },
        'United Arab Emirates':{
          'Abu Dhabi':['Abu Dhabi','Al Ain','Ruwais','Madinat Zayed'],
          'Dubai':['Dubai','Jebel Ali','Hatta'],
          'Sharjah':['Sharjah','Khor Fakkan','Kalba'],
          'Ajman':['Ajman'],'Umm Al Quwain':['Umm Al Quwain'],
          'Ras Al Khaimah':['Ras Al Khaimah'],'Fujairah':['Fujairah','Dibba'],
        },
        'Saudi Arabia':{
          'Riyadh':['Riyadh','Al Kharj','Diriyah'],
          'Makkah':['Mecca','Jeddah','Taif'],
          'Madinah':['Medina','Yanbu'],
          'Eastern Province':['Dammam','Khobar','Dhahran','Jubail','Al Ahsa'],
          'Asir':['Abha','Khamis Mushait'],'Tabuk':['Tabuk'],'Qassim':['Buraidah','Unaizah'],
        },
        'Qatar':{
          'Doha':['Doha'],'Al Rayyan':['Al Rayyan'],'Al Wakrah':['Al Wakrah'],
          'Al Khor':['Al Khor'],'Umm Salal':['Umm Salal'],'Al Daayen':['Lusail'],
        },
        'Kuwait':{
          'Al Asimah':['Kuwait City'],'Hawalli':['Hawalli','Salmiya'],'Farwaniya':['Farwaniya'],
          'Ahmadi':['Ahmadi','Fahaheel'],'Jahra':['Jahra'],'Mubarak Al-Kabeer':['Mubarak Al-Kabeer'],
        },
        'Bahrain':{
          'Capital':['Manama'],'Muharraq':['Muharraq'],
          'Northern':['Hamad Town','Budaiya'],'Southern':['Riffa','Isa Town'],
        },
        'Oman':{
          'Muscat':['Muscat','Seeb','Bawshar'],'Dhofar':['Salalah'],
          'Al Batinah North':['Sohar'],'Al Batinah South':['Rustaq'],
          'Musandam':['Khasab'],'Al Dakhiliyah':['Nizwa'],
        },
      };
      /* Site-info country dropdown: the names ACHI works in, in the map's order.
         Kept separate from the phone-picker COUNTRIES (which is dial-code triples). */
      const GEO_COUNTRIES=Object.keys(GEO);
      /* Full world list for the Country dropdown, alphabetical. GEO_COUNTRIES
         (the 7 with District/City cascade data) is separate and unchanged; the
         cascade keys off it by name. A country not in GEO leaves District/City free. */
      const COUNTRY_NAMES=['Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia','Cameroon','Canada','Cape Verde','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo (Brazzaville)','Congo (Kinshasa)','Costa Rica','Croatia','Cuba','Cyprus','Czechia','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau','Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];
      const districtsFor=c=>GEO[c]?Object.keys(GEO[c]):null;              // null => free text
      const citiesFor=(c,d)=>GEO[c]&&GEO[c][d]?GEO[c][d]:null;
  /* Custom cities added by users are stored server-side (achi_geo_city) so they
     are shared, not per-browser. Loaded once into customCities and merged with
     the predefined GEO towns. cityOptions appends the "+ Add New" sentinel when
     a country and district are both chosen. */
  /* Custom districts, same DB-backed pattern as cities: predefined GEO districts
     ∪ user-added ones, with "+ Add District" so any country becomes usable. */
  const DISTRICT_ADD='__add_district__';
  let customDistricts={};
  const districtsMerged=c=>[...new Set([...(districtsFor(c)||[]),...(customDistricts[c]||[])])];
  const districtOptions=c=>c?[...districtsMerged(c),DISTRICT_ADD]:[];
  async function loadCustomDistricts(){
    try{ const rows=await api('/geo/districts'); customDistricts={};
      for(const r of rows){ (customDistricts[r.country]=customDistricts[r.country]||[]).push(r.district); }
    }catch(e){/* predefined GEO districts still work */}
  }
  async function addDistrictAndSelect(sel){
    const country=rxGeoCurrent('country');
    const previousDistrict=rxGeoCurrent('district');
    const currentCity=rxGeoCurrent('city');

    if(!country){
      rxSetGeoValue(
        'district',
        districtOptions(country),
        previousDistrict
      );
      return;
    }

    const name=(
      window.prompt(
        'New district for '+country+' (max 128 characters):'
      )||''
    ).trim();

    if(!name){
      rxSetGeoValue(
        'district',
        districtOptions(country),
        previousDistrict
      );
      return;
    }

    if(name.length>128){
      fail('District must be 128 characters or fewer.');

      rxSetGeoValue(
        'district',
        districtOptions(country),
        previousDistrict
      );

      return;
    }

    try{
      const saved=await api(
        '/geo/districts',
        {
          method:'POST',
          body:JSON.stringify({
            country,
            district:name
          })
        }
      );

      const list=
        customDistricts[country]=
        customDistricts[country]||[];

      if(
        !list.includes(saved.district) &&
        !(districtsFor(country)||[]).includes(saved.district)
      ){
        list.push(saved.district);
      }

      rxSetGeoValue(
        'district',
        districtOptions(country),
        saved.district
      );

      rxRebuildCityForDistrict(
        country,
        saved.district,
        currentCity
      );

      clearErr();

    }catch(e){
      fail(e.message);

      rxSetGeoValue(
        'district',
        districtOptions(country),
        previousDistrict
      );

      rxRebuildCityForDistrict(
        country,
        previousDistrict,
        currentCity
      );
    }
  }
  const CITY_ADD='__add_city__';
  let customCities={};

  const cityKey=(c,d)=>String(c||'')+'|'+String(d||'');

  const mergedCities=(c,d)=>[
    ...new Set([
      ...(citiesFor(c,d)||[]),
      ...(customCities[cityKey(c,d)]||[])
    ])
  ];

  /* All known cities for a country, regardless of district.
    Includes both predefined GEO cities and backend-added custom cities. */
  const allCitiesForCountry=c=>{
    if(!c) return [];

    const values=[];

    for(const district of districtsMerged(c)){
      values.push(...mergedCities(c,district));
    }

    const prefix=String(c)+'|';

    for(const [key,cities] of Object.entries(customCities)){
      if(key.startsWith(prefix)){
        values.push(...cities);
      }
    }

    return [...new Set(values)];
  };

  /* Return a district only when the city has exactly one matching district.
    If the city is unknown, or exists in multiple districts, return blank. */
  const districtForCity=(c,city)=>{
    if(!c||!city) return '';

    const wanted=rxGeoNorm(city);
    const matches=[];

    const districts=[
      ...new Set([
        ...districtsMerged(c),
        ...Object.keys(customCities)
          .filter(key=>key.startsWith(String(c)+'|'))
          .map(key=>key.slice(String(c).length+1))
      ])
    ];

    for(const district of districts){
      const found=mergedCities(c,district)
        .some(value=>rxGeoNorm(value)===wanted);

      if(found) matches.push(district);
    }

    return matches.length===1 ? matches[0] : '';
  };

  /* With a district: show that district's cities plus "+ Add City".
    Without a district: show every known city for the selected country. */
  const cityOptions=(c,d)=>{
    if(!c) return [];

    if(d){
      return [
        ...mergedCities(c,d),
        CITY_ADD
      ];
    }

    return allCitiesForCountry(c);
  };
  async function loadCustomCities(){
    try{ const rows=await api('/geo/cities'); customCities={};
      for(const r of rows){ const k=cityKey(r.country,r.district); (customCities[k]=customCities[k]||[]).push(r.city); }
    }catch(e){/* dropdown still works from predefined lists */}
  }
  /* Add a city to the database and select it. Async because it hits the server;
     the change handler calls it fire-and-forget. On failure the select falls
     back to the current options with nothing chosen. */
  async function addCityAndSelect(sel){
    const country=rxGeoCurrent('country');
    const district=rxGeoCurrent('district');
    const previousCity=rxGeoCurrent('city');

    if(!country||!district){
      rxSetGeoValue(
        'city',
        cityOptions(country,district),
        previousCity
      );
      return;
    }

    const name=(
      window.prompt(
        'New city for '+district+' (max 128 characters):'
      )||''
    ).trim();

    if(!name){
      rxSetGeoValue(
        'city',
        cityOptions(country,district),
        previousCity
      );
      return;
    }

    if(name.length>128){
      fail('City must be 128 characters or fewer.');

      rxSetGeoValue(
        'city',
        cityOptions(country,district),
        previousCity
      );

      return;
    }

    try{
      const saved=await api(
        '/geo/cities',
        {
          method:'POST',
          body:JSON.stringify({
            country,
            district,
            city:name
          })
        }
      );

      const k=cityKey(country,district);
      const list=
        customCities[k]=
        customCities[k]||[];

      if(
        !list.includes(saved.city) &&
        !(citiesFor(country,district)||[]).includes(saved.city)
      ){
        list.push(saved.city);
      }

      rxSetGeoValue(
        'city',
        cityOptions(country,district),
        saved.city
      );

      clearErr();

    }catch(e){
      fail(e.message);

      rxSetGeoValue(
        'city',
        cityOptions(country,district),
        previousCity
      );
    }
  }
  /* Module-scope so the change handler (also module-scope) can call it: rebuild
     a site-info select's options when the level above changes, refresh its
     enhanced button label. The menu reads <option>s on open, so this suffices. */
  const rxFillSelect=(id,list,selected)=>{
    const sel=$('rx-'+id); if(!sel) return;

    const chosen=String(selected||'');
    const values=[...new Set(list||[])];

    /* Keep a manually typed/custom value selectable even when it is not part of
      the predefined/backend list. Insert it before "+ Add ..." commands. */
    if(chosen && !values.includes(chosen)){
      const commandIndex=values.findIndex(value=>String(value).startsWith('__add_'));

      if(commandIndex>=0) values.splice(commandIndex,0,chosen);
      else values.push(chosen);
    }

    sel.innerHTML=['',...values].map(o=>
      `<option value="${esc(o)}"${o===chosen?' selected':''}>${
        esc(
          o===CITY_ADD?'+ Add City':
          o===DISTRICT_ADD?'+ Add District':
          (o||'—')
        )
      }</option>`
    ).join('');

    sel.value=chosen;

    /* Country/District/City have a visible text input sitting over this select.
      Whenever code changes the underlying select, keep that visible value synced. */
    const input=document.querySelector(`[data-geo-input="${id}"]`);
    if(input) input.value=chosen;

    if(sel.dataset.rxEnhanced&&sel._rxButton){
      sel._rxButton.querySelector('span').textContent=rxSelectLabel(sel);
    }
  };

  function rxGeoInput(id){
    return document.querySelector(`[data-geo-input="${id}"]`);
  }

  function rxGeoCurrent(id){
    const input=rxGeoInput(id);
    if(input) return input.value.trim();

    const sel=$('rx-'+id);
    return sel ? String(sel.value||'').trim() : '';
  }

  /* Normalize against an existing option when possible:
      lebanon -> Lebanon
      jounieh -> Jounieh
    Unknown/custom values remain untouched. */
  function rxSetGeoValue(id,list,value){
    const raw=String(value||'').trim();
    const options=[...(list||[])];

    const commands=options.filter(option=>
      String(option).startsWith('__add_')
    );

    const normalOptions=options.filter(option=>
      !String(option).startsWith('__add_')
    );

    const chosen=raw
      ? rxGeoChoice(raw,normalOptions)
      : '';

    rxFillSelect(id,[...normalOptions,...commands],chosen);

    const input=rxGeoInput(id);
    if(input) input.dataset.geoCommitted=chosen;

    return chosen;
  }

  function rxCityKnownForCountry(country,city){
    if(!country||!city) return false;

    const wanted=rxGeoNorm(city);

    return allCitiesForCountry(country)
      .some(value=>rxGeoNorm(value)===wanted);
  }

  /* When District changes, narrow the City dropdown.

    A known city that belongs to another district is cleared.
    An unknown/custom city is deliberately preserved. */
  function rxRebuildCityForDistrict(country,district,currentCity){
    const city=String(
      currentCity===undefined
        ? rxGeoCurrent('city')
        : currentCity
    ).trim();

    const options=cityOptions(country,district);

    if(!city){
      rxSetGeoValue('city',options,'');
      return '';
    }

    if(!district){
      return rxSetGeoValue('city',options,city);
    }

    const wanted=rxGeoNorm(city);

    const belongsHere=mergedCities(country,district)
      .some(value=>rxGeoNorm(value)===wanted);

    if(belongsHere){
      return rxSetGeoValue('city',options,city);
    }

    /* Unknown city = manual/custom value. Do not destroy it merely because the
      District changed. */
    if(!rxCityKnownForCountry(country,city)){
      return rxSetGeoValue('city',options,city);
    }

    rxSetGeoValue('city',options,'');
    return '';
  }

  /* If the selected/typed city maps to exactly one district, fill it.
    Ambiguous and unknown cities leave District untouched. */
  function syncDistrictFromCity(){
    const country=rxGeoCurrent('country');
    const city=rxGeoCurrent('city');

    if(!country||!city) return '';

    const district=districtForCity(country,city);

    if(!district) return '';

    const current=rxGeoCurrent('district');

    if(rxGeoNorm(current)!==rxGeoNorm(district)){
      rxSetGeoValue(
        'district',
        districtOptions(country),
        district
      );
    }

    /* Rebuild the City list for the newly determined district while preserving
      and canonicalizing the city the user actually chose. */
    rxSetGeoValue(
      'city',
      cityOptions(country,district),
      city
    );

    return district;
  }

  function rxApplyCountryValue(value){
    const input=rxGeoInput('country');
    const previous=input
      ? String(input.dataset.geoCommitted??input.value??'').trim()
      : rxGeoCurrent('country');

    const country=rxSetGeoValue(
      'country',
      COUNTRY_NAMES,
      value
    );

    /* Same place with different casing is normalization, not a Country change. */
    const changed=
      rxGeoNorm(previous)!==rxGeoNorm(country);

    if(changed){
      rxSetGeoValue(
        'district',
        districtOptions(country),
        ''
      );

      rxSetGeoValue(
        'city',
        cityOptions(country,''),
        ''
      );
    }

    return country;
  }

  function rxApplyDistrictValue(value){
    const country=rxSetGeoValue(
      'country',
      COUNTRY_NAMES,
      rxGeoCurrent('country')
    );

    const currentCity=rxGeoCurrent('city');

    const district=rxSetGeoValue(
      'district',
      districtOptions(country),
      value
    );

    rxRebuildCityForDistrict(
      country,
      district,
      currentCity
    );

    return district;
  }

  function rxApplyCityValue(value){
    const country=rxSetGeoValue(
      'country',
      COUNTRY_NAMES,
      rxGeoCurrent('country')
    );

    const district=rxGeoCurrent('district');

    const city=rxSetGeoValue(
      'city',
      cityOptions(country,district),
      value
    );

    syncDistrictFromCity();

    return city;
  }

  /* Manual text entry uses exactly the same logic as dropdown selection.
    "change" fires when the user finishes editing/leaves the field, which avoids
    rewriting their text/cursor on every individual keystroke. */
  function wireGeoManualInputs(){
    const wire=(id,handler)=>{
      const input=rxGeoInput(id);

      if(!input || input.dataset.geoWired) return;

      input.dataset.geoWired='1';
      input.dataset.geoCommitted=input.value.trim();

      input.addEventListener('change',()=>{
        handler(input.value);
      });
    };

    wire('country',rxApplyCountryValue);
    wire('district',rxApplyDistrictValue);
    wire('city',rxApplyCityValue);
  }
      /* Flat unions, so the grid's non-cascading dropdowns still show everything. */
      const DISTRICTS=[...new Set(Object.values(GEO).flatMap(d=>Object.keys(d)))],
            CITIES=[...new Set(Object.values(GEO).flatMap(d=>Object.values(d).flat()))];
const STATUSES=['open','scheduled','viewed','cancelled','done','transferred'],
      TYPES=['Prospect','Lead','Client','Field','Fleet','Yard','Invoice','Balance','General'],
      CATEGORIES=['lead','site_surveys','measurements_take_off','estimation','quotation','jobs'],
      /* "Pre" pulldown, ported from erp_next_custom tabbed_grid.js (#pg-cm-pre).
         Same option set and order. Upstream marks both Eng and Arch `selected`
         and then overrides it with selPre.value; that default is per-column
         (architect columns default to "Arch"), so on a general call log the
         blank stays the default here. */
      PREFIXES=['Mr','Ms','Mrs','Dr','Eng','Arch'];
const SOCIAL_KEY='achi_social_platforms',
      SOCIAL_ADD_PLATFORM='__add_social_platform__';
const allSocials=()=>[...SOCIALS,...customPicklistValues(SOCIAL_KEY).filter(value=>!SOCIALS.includes(value))];
const socialOptionsHTML=(selected='IG')=>[...allSocials(),SOCIAL_ADD_PLATFORM].map(value=>
  `<option value="${value}"${value===selected?' selected':''}>${
    value===SOCIAL_ADD_PLATFORM?'+ Add New Platform':value
  }</option>`).join('');
const ROLE_KEY='achi_roles', ROLE_ADD='__add_role__',
      SUBJECT_KEY='achi_log_subjects', SUBJECT_ADD='__add_subject__',
      REFERENCE_KEY='achi_log_references', REFERENCE_ADD='__add_reference__';
const customPicklistValues=key=>{ try{
  const values=JSON.parse(localStorage.getItem(key)||'[]');
  return Array.isArray(values)?values.filter(value=>typeof value==='string'&&value.trim()):[];
}catch(e){ return []; } };
const allRoles=()=>[...ROLES,...customPicklistValues(ROLE_KEY).filter(value=>!ROLES.includes(value))];
const allSubjects=()=>[...SUBJECTS,...customPicklistValues(SUBJECT_KEY).filter(value=>!SUBJECTS.includes(value))];
const REFERENCES=['Inbound Call','Outreach','Site Visit','Referral','Email','Website',
                  'Instagram DM','Facebook DM','LinkedIn'];
const allReferences=()=>[...REFERENCES,...customPicklistValues(REFERENCE_KEY).filter(value=>!REFERENCES.includes(value))];
function addCustomPicklistValue({key,values,label}){
  const value=(window.prompt(`New ${label} (max 64 characters):`)||'').trim();
  if(!value) return null;
  if(value.length>64){ fail(`${label[0].toUpperCase()+label.slice(1)} must be 64 characters or fewer.`); return null; }
  if(!values().includes(value)) localStorage.setItem(key,JSON.stringify([...customPicklistValues(key),value]));
  clearErr(); return value;
}
const addRole=()=>addCustomPicklistValue({key:ROLE_KEY,values:allRoles,label:'role'});
const addSubject=()=>addCustomPicklistValue({key:SUBJECT_KEY,values:allSubjects,label:'log subject'});
/* Quick-notes subject quick-pick: preset actions the crew reach for most, plus
   a "+ Add New" that stores custom ones in localStorage (like the other lists).
   Picking one fills the free-text Subject input; nothing is saved from the
   dropdown itself (data-nosave) — the subject persists through the note. */
const NOTE_SUBJECT_KEY='achi_note_subjects', NOTE_SUBJECT_ADD='__add_note_subject__';
const NOTE_SUBJECTS=['To be quoted','Request installation','Request dismantling','Wants to review price'];
const allNoteSubjects=()=>[...NOTE_SUBJECTS,...customPicklistValues(NOTE_SUBJECT_KEY).filter(v=>!NOTE_SUBJECTS.includes(v))];
const addNoteSubject=()=>addCustomPicklistValue({key:NOTE_SUBJECT_KEY,values:allNoteSubjects,label:'note subject'});
const addReference=()=>addCustomPicklistValue({key:REFERENCE_KEY,values:allReferences,label:'reference'});
const addSocialPlatform=()=>addCustomPicklistValue({key:SOCIAL_KEY,values:allSocials,label:'social platform'});
const COMPANY_KEY='achi_company_types', COMPANY_ADD='__add_company__';
/* Base company types; the field is data-nosave (no model column yet), so a
   custom one lives only in the dropdown until that column exists — but the
   picklist behaves like the others meanwhile. */
const COMPANY_TYPES=['All types','Contractor','Developer','Architect','Owner'];
const allCompanyTypes=()=>[...COMPANY_TYPES,...customPicklistValues(COMPANY_KEY).filter(v=>!COMPANY_TYPES.includes(v))];
const addCompanyType=()=>addCustomPicklistValue({key:COMPANY_KEY,values:allCompanyTypes,label:'company type'});
const PREFIX_ADD_LABEL='+ Add New';
/* Custom prefixes. The backend stores prefix as a free string (ContactPatch caps
   it at 16), so a new option needs no API change — only somewhere to remember it.
   Kept in localStorage beside achi_bh; that means per-browser, NOT shared across
   the team. A shared list would need a real endpoint. */
const PREFIX_KEY='achi_prefixes', PREFIX_ADD='__add__';
/* Custom log types. The API validates this field by length rather than
   membership, so a new option needs no deploy — only somewhere to remember it.
   localStorage means per-browser, like the prefixes; a shared list needs an
   endpoint. Rows still carrying the older values (inbound_call, note …) are
   folded in so their dropdown shows what they actually hold. */
const TYPE_KEY='achi_log_types', TYPE_ADD='__addtype__';
const customTypes=()=>{ try{ const a=JSON.parse(localStorage.getItem(TYPE_KEY)||'[]');
  return Array.isArray(a)?a.filter(x=>typeof x==='string'&&x.trim()):[]; }catch(e){ return []; } };
const allTypes=(current)=>{ const seen=new Set(TYPES), out=[...TYPES];
  for(const t of [...customTypes(),current]) if(t&&!seen.has(t)){ seen.add(t); out.push(t); }
  return out; };
function addType(){
  const v=(window.prompt('New log type (max 64 characters):')||'').trim();
  if(!v) return null;
  if(v.length>64){ fail('Log type must be 64 characters or fewer.'); return null; }
  if(!allTypes().includes(v)) localStorage.setItem(TYPE_KEY,JSON.stringify([...customTypes(),v]));
  clearErr(); return v;
}
/* A log carries ONE tag — a label to group and filter it (Supplier, Client, or a
   custom one). Picklist works like log types: two seeds, plus per-browser custom
   values in localStorage, plus whatever tags the loaded rows already use so the
   vocabulary is exactly "the tags in use". "+ Add Tag" prompts for a new one. */
const TAG_KEY='achi_log_tags', TAG_ADD='__add_tag__';
const TAGS_SEED=['Supplier','Client'];
const tagOf=r=>String(r&&r.tags||'').trim();
const allTags=current=>{
  const seen=new Set(), out=[];
  const push=v=>{ v=String(v||'').trim(); const k=v.toLowerCase();
    if(v&&!seen.has(k)){ seen.add(k); out.push(v); } };
  TAGS_SEED.forEach(push);
  customPicklistValues(TAG_KEY).forEach(push);
  // A row's tags field is a comma-joined string, and so is `current` — split them
  // so the vocabulary is INDIVIDUAL tags, never a whole "a,b,c" value shown (and
  // selectable) as one option. ROWS is initialised at load; allTags only ever runs
  // from UI handlers, well after.
  const pushMany=s=>String(s||'').split(',').forEach(push);
  (Array.isArray(ROWS)?ROWS:[]).forEach(r=>pushMany(tagOf(r)));
  pushMany(current);
  return out;
};
const addTag=()=>addCustomPicklistValue({key:TAG_KEY,values:allTags,label:'tag'});
const customPrefixes=()=>{ try{ const a=JSON.parse(localStorage.getItem(PREFIX_KEY)||'[]');
  return Array.isArray(a)?a.filter(x=>typeof x==='string'&&x.trim()):[]; }catch(e){ return []; } };
const allPrefixes=()=>[...PREFIXES,...customPrefixes().filter(x=>!PREFIXES.includes(x))];
/* Options are built here rather than via selOpts() because these values are
   user-typed: they must be escaped in the value attribute, and shown verbatim
   instead of run through label()'s capitalisation. */
const prefixOpts=v=>'<option value=""></option>'
  +allPrefixes().map(x=>`<option value="${esc(x)}"${x===v?' selected':''}>${esc(x)}</option>`).join('')
  +`<option value="${PREFIX_ADD}">＋ Add new…</option>`;
function addPrefix(){
  const v=(window.prompt('New prefix (max 16 characters):')||'').trim();
  if(!v) return null;
  if(v.length>16){ fail('Prefix must be 16 characters or fewer.'); return null; }
  if(!allPrefixes().includes(v)) localStorage.setItem(PREFIX_KEY,JSON.stringify([...customPrefixes(),v]));
  clearErr(); return v;
}
function removePrefix(value){
  if(!customPrefixes().includes(value)||PREFIXES.includes(value)) return false;
  localStorage.setItem(PREFIX_KEY,JSON.stringify(customPrefixes().filter(v=>v!==value)));
  clearErr(); return true;
}
const label=s=>String(s||'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
/* ── Extra column renderers for the General Log (stage / docs / communication).
   Additive: the standard Log never renders these columns, so these are inert
   there. Kept here so both pages share one core script. ──────────────────── */
/* The General Log stage dropdown: the full sales pipeline, in order. The keys
   are what the backend stores (schemas.py STAGES); the labels/colours drive the
   cell dot, the coloured menu option, and the progress bar. */
const GL_STAGES=[
  {k:'prospect',         label:'Prospect',      color:'#2563eb'},
  {k:'outreach',         label:'Outreach',      color:'#d97706'},
  {k:'follow_up',        label:'Follow-up',     color:'#0891b2'},
  {k:'first_contact',    label:'First Contact', color:'#7c3aed'},
  {k:'second_follow_up', label:'2nd Follow-up', color:'#0d9488'},
  {k:'enquiry',          label:'Enquiry',       color:'#2563eb'},
  {k:'site_survey',      label:'Site Visit',    color:'#0891b2'},
  {k:'drawing',          label:'Drawing',       color:'#0ea5e9'},
  {k:'takeoff',          label:'Takeoff',       color:'#0284c7'},
  {k:'boq',              label:'BOQ',           color:'#7c3aed'},
  {k:'resources',        label:'Resources',     color:'#9333ea'},
  {k:'plan',             label:'Plan',          color:'#6366f1'},
  {k:'costing',          label:'Costing',       color:'#ea580c'},
  {k:'pricing',          label:'Pricing',       color:'#f59e0b'},
  {k:'quotation',        label:'Quotation',     color:'#4f46e5'},
  {k:'negotiation',      label:'Negotiation',   color:'#16a34a'},
  {k:'accepted',         label:'Accepted',      color:'#15803d'},
  {k:'cancelled',        label:'Cancelled',     color:'#dc2626'},
  {k:'on_hold',          label:'On Hold',       color:'#e11d48'},
];
const GL_STAGE_BY_KEY=Object.fromEntries(GL_STAGES.map(s=>[s.k,s]));
const GL_STAGE_ORDER=GL_STAGES.map(s=>s.k);
/* A General Log-style workspace can declare ACHI_LOG_FILTER.stages before this
   script loads. Standard Log and General Log declare nothing, so they keep the
   complete pipeline. Invalid configuration is ignored safely. */
const GL_STAGE_PIPELINE=(()=>{
  const raw=(typeof window!=='undefined') ? window.ACHI_LOG_FILTER : null;
  const configured=raw && Array.isArray(raw.stages) ? raw.stages : [];
  const allowed=configured.filter(
    stage=>typeof stage==='string' && GL_STAGE_BY_KEY[stage]
  );
  return allowed.length ? Array.from(new Set(allowed)) : GL_STAGE_ORDER.slice();
})();
const GL_STAGE_COLOR=Object.fromEntries(GL_STAGES.map(s=>[s.k,s.color]));
// Rows from before the pipeline expansion carry a couple of retired keys.
const GL_LEGACY_STAGE={lead:'enquiry',measurements:'takeoff'};
const glStageKey=s=>{
  const raw=String(s||'').trim();

  // ONLY missing stage defaults to Prospect
  if(!raw) return 'prospect';

  const k=GL_LEGACY_STAGE[raw]||raw;

  // Keep any valid explicitly selected stage
  return GL_STAGE_BY_KEY[k] ? k : 'prospect';
};
const glStageLabel=s=>{const k=glStageKey(s);return (GL_STAGE_BY_KEY[k]||{}).label||label(k);};
// The bar is a fixed 6 segments filled to the stage's position in the pipeline,
// so it stays compact whether there are 6 stages or 18. "cancelled" reads as a
// stalled deal (empty bar in its own red); everything else fills proportionally.
const GL_STAGE_SEGMENTS=6;
function glStageCell(r){
  const k=glStageKey(r.stage),color=GL_STAGE_COLOR[k],idx=GL_STAGE_ORDER.indexOf(k);
  const fill=k==='cancelled'?0:Math.max(1,Math.round((idx+1)/GL_STAGE_ORDER.length*GL_STAGE_SEGMENTS));
  const segs=Array.from({length:GL_STAGE_SEGMENTS},(_,i)=>`<span class="lseg${i<fill?' on':''}" style="${i<fill?`background:${color}`:''}"></span>`).join('');
  return `<div class="lstage"><span class="lstage-top"><span class="lstage-dot" style="background:${color}"></span><span class="lstage-label" style="color:${color}">${esc(glStageLabel(k))}</span><svg class="lstage-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg></span><span class="lstage-bar">${segs}</span></div>`;
}
const GL_DOCS=[['srv','SURV'],['dwg','DWG'],['mt','M/T'],['boq','BOQ'],['cst','CST'],['qte','QTE']];
const GL_COMM_COLOR={Call:'#2563eb',Phone:'#2563eb',Email:'#7c3aed',WhatsApp:'#16a34a','In-person':'#ea580c',SMS:'#0891b2',Instagram:'#db2777',Facebook:'#1d4ed8',LinkedIn:'#0a66c2',X:'#0f172a',TikTok:'#0f172a',Other:'#64748b'};
// Short two/three-letter tags for the Communication pills (photo #3).

const GL_COMM_ABBR={Call:'PH',Phone:'PH',Email:'EM',WhatsApp:'WA','In-person':'IP',SMS:'SMS',Instagram:'IG',Facebook:'FB',LinkedIn:'LI',X:'X',TikTok:'TT',Other:'··'};
function glCommColor(k){
  return GL_COMM_COLOR[k] || '#64748b';
}
const glCommAbbr=k=>GL_COMM_ABBR[k]||String(k||'').slice(0,2).toUpperCase();
const glCommPill=(k,n)=>{const c=glCommColor(k);return `<span class="lcomm" style="color:${c};border-color:${c}44;background:${c}14" title="${esc(k)}${n!=null?': '+n:''}">${esc(glCommAbbr(k))}${n!=null?' '+n:''}</span>`;};
// Channels the "+" menu offers on the Communication cell (kept short on purpose).
const GL_COMM_ADD=[
  'Call',
  'WhatsApp',
  'Email',
  'LinkedIn',
  'Facebook',
  'Instagram',
  'X'
];
function glDocsCell(r){
  const raw = Array.isArray(r.deliverables)
    ? r.deliverables
    : [];

  let selected = raw.map(value => {
    const name = String(value || '').trim();

    if(!name) return null;

    const fixed = GL_DOCS.find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );

    return fixed ? fixed[1] : name;
  }).filter(Boolean);

  // Fallback for older rows/API responses.
  if(!selected.length){
    const d = r.docs || {};

    selected = GL_DOCS
      .filter(([k]) => d[k])
      .map(([, label]) => label);
  }

  // Remove duplicates without changing the displayed name.
  const seen = new Set();

  selected = selected.filter(name => {
    const key = name.toLowerCase();

    if(seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  if(!selected.length){
    return '<span class="mt">—</span>';
  }

  return `<div class="ldocs">${
    selected
      .map(name =>
        `<span class="ldoc selected-only">${esc(name)}</span>`
      )
      .join('')
  }</div>`;
}
/* This log's own per-channel counters, seeded from the legacy single
   `communication` value the first time so old rows upgrade seamlessly. */
function glCommTally(r){
  let t=r.comm_tally;
  if(t&&typeof t==='object'&&Object.keys(t).length) return t;
  return r.communication?{[r.communication]:1}:{};
}
/* Communication cell: an interactive counter chip per channel — click a chip to
   add one, its "×" to remove it — plus a "+" to add a channel. Per log row. */
function glCommCell(r){
  const t=glCommTally(r);
  const channels=Object.keys(t).filter(k=>t[k]>0).sort((a,b)=>t[b]-t[a]||a.localeCompare(b));
  const chips=channels.map(k=>{const c=glCommColor(k);
    return `<button type="button" class="ctchip" data-cc-inc="${esc(k)}" title="${esc(k)}: ${t[k]} — click to add one" style="color:${c};border-color:${c}55;background:${c}14">`
      +`<span class="cta">${esc(glCommAbbr(k))}</span><span class="ctn">${t[k]}</span>`
      +`<span class="ctx" data-cc-del="${esc(k)}" title="Remove ${esc(k)}">×</span></button>`;
  }).join('');
  return `<span class="ctally">${chips}<button type="button" class="ctadd" data-cc-add title="Add a channel">+</button></span>`;
}
const GL_MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function toLocalDateTimeValue(value){
  if(!value) return '';

  const d=new Date(value);
  if(isNaN(d)) return '';

  const p=n=>String(n).padStart(2,'0');

  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtLastTouchDateTime(value){
  if(!value) return '—';

  const d=new Date(value);
  if(isNaN(d)) return String(value||'');

  const p=n=>String(n).padStart(2,'0');

  let hour=d.getHours();
  const ampm=hour>=12?'PM':'AM';
  hour=hour%12||12;

  return `${p(d.getDate())} ${GL_MONTHS[d.getMonth()]} ${d.getFullYear()} `
       + `${p(hour)}:${p(d.getMinutes())} ${ampm}`;
}

function glLastTouchCell(r){
  const when=r.occurred_at||r.created_at||r.last_touch_at;

  const t=glCommTally(r);
  const channels=Object.keys(t)
    .filter(k=>t[k]>0)
    .sort((a,b)=>t[b]-t[a]||a.localeCompare(b));

  const total=channels.reduce((s,k)=>s+t[k],0);
  const abbrs=channels.map(k=>glCommAbbr(k)).join(', ');
  const sub=[abbrs,total?`${total} TOTAL`:''].filter(Boolean).join(' · ');

  return `
    <span class="lt">
      <button
        type="button"
        class="lt-date lt-date-button"
        data-last-touch-open
        title="Change Last Touch date and time"
      >${when?esc(fmtLastTouchDateTime(when)):'—'}</button>

      <input
        type="datetime-local"
        class="lt-picker-hidden"
        data-last-touch
        value="${esc(toLocalDateTimeValue(when))}"
        aria-label="Last Touch date and time"
      >

      ${sub?`<span class="lt-sub">${esc(sub)}</span>`:''}
    </span>
  `;
}
const SVG={
  mail:`<svg viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M2 4l6 5 6-5"/></svg>`,
  pin:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  copy:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="9" rx="1.2"/><path d="M3 11H2a1 1 0 01-1-1V2a1 1 0 011-1h7a1 1 0 011 1v2"/></svg>`,
  pen:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M10 4l2 2"/></svg>`,
  check:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,8 6,12 14,4"/></svg>`,
  up:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10 8,6 12,10"/></svg>`,
  plus:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>`,
  expand:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,2 14,2 14,6"/><polyline points="6,14 2,14 2,10"/><line x1="14" y1="2" x2="9" y2="7"/><line x1="2" y1="14" x2="7" y2="9"/></svg>`,
  chev:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>`,
  trash:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1"/><path d="M6 7v5m4-5v5"/><rect x="3" y="4" width="10" height="9" rx="1.5"/></svg>`,
  wa:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`,
};

/* Access tokens last an hour (expires_in 3600). Leave this page open longer and
   every call 401s. The API issues a refresh token alongside, so swap it for a
   new access token and retry once — the user sees nothing. Shared promise so a
   burst of parallel 401s triggers one refresh, not one per request. */
let refreshing=null;
function refreshToken(){
  if(refreshing) return refreshing;
  const rt=getRefreshToken();
  if(!rt) return Promise.resolve(false);
  refreshing=fetch('/api/v1/users/auth/refresh/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:rt})})
    .then(r=>r.ok?r.json():null)
    .then(d=>{ if(d&&d.access_token){ TOKEN=d.access_token;
      try{ localStorage.setItem('oe_access_token',TOKEN); if(d.refresh_token) localStorage.setItem('oe_refresh_token',d.refresh_token); }catch(e){}
      return true; } return false; })
    .catch(()=>false)
    .finally(()=>{ refreshing=null; });
  return refreshing;
}
async function api(path,opts={},retried){
  const r=await fetch(API+path,{...opts,headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN,...(opts.headers||{})}});
  if(r.status===401){
    if(!retried && await refreshToken()) return api(path,opts,true);
    // message, not "401": callers do fail(e.message), which used to overwrite
    // the explanation with the bare status code
    fail('Session expired — open the main app on this exact host, sign in, then reload.');
    throw new Error('Session expired — open the main app on this exact host, sign in, then reload.'); }
  const body=await r.json().catch(()=>({}));
  if(!r.ok){ const d=body.detail; throw new Error(Array.isArray(d)?d.map(x=>x.msg).join('; '):(d||r.status)); }
  return body;
}
async function searchContacts(q,retried){
  const term=String(q||'').trim();
  const url=term
    ? '/api/v1/contacts/search/?q='+encodeURIComponent(term)+'&limit=12'
    : '/api/v1/contacts/?limit=12';
  const r=await fetch(url,{headers:{Authorization:'Bearer '+TOKEN}});
  if(r.status===401){
    if(!retried && await refreshToken()) return searchContacts(q,true);
    throw new Error('Session expired'); }
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.detail||r.status);
  return Array.isArray(body.items)?body.items:[];
}
function fmtDT(s){ const d=new Date(s); if(isNaN(d))return String(s||'').slice(0,16).replace('T',' ');
  const p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function fmtCompactDT(s){ const d=new Date(s); if(isNaN(d))return String(s||'');
  return `${String(d.getDate()).padStart(2,'0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`; }
function fmtHeaderDT(s){
  const d=new Date(s); if(isNaN(d)) return '';
  const p=n=>String(n).padStart(2,'0'), hour=d.getHours(), h=hour%12||12;
  return `${p(d.getMonth()+1)}/${p(d.getDate())}/${d.getFullYear()} ${p(h)}:${p(d.getMinutes())} ${hour<12?'AM':'PM'}`;
}
const dateTimeHTML=s=>`<span class="dt pg-dt-full">${esc(fmtDT(s))}</span><span class="dt pg-dt-compact">${esc(fmtCompactDT(s))}</span>`;
const badge=s=>`<span class="badge b-${esc(s)}">${esc(s)}</span>`;
const tagv=v=>v?`<span class="tag">${esc(label(v))}</span>`:'<span class="mt">—</span>';
/* Tags are one comma-separated string; split, trim and drop blanks so "a, ,b"
   never renders an empty chip. Shown as blue label chips to read apart from the
   grey type/category tags. */
const splitTags=s=>{const seen=new Set();return String(s||'').split(',').map(t=>t.trim()).filter(t=>{const k=t.toLowerCase();return t&&!seen.has(k)&&(seen.add(k),true);});};
const tagsHTML=s=>{const a=splitTags(s);return a.length?`<span class="tags">${a.map(t=>`<span class="tag tag-lbl">${esc(t)}</span>`).join('')}</span>`:'<span class="mt">—</span>';};
const dash=v=>v?esc(v):'<span class="mt">—</span>';
const selOpts=(o,v)=>o.map(x=>`<option value="${x}"${x===v?' selected':''}>${esc(label(x))}</option>`).join('');
function phone(m){ if(!m)return '<span class="mt">—</span>'; const d=m.replace(/[^0-9]/g,''); return `<span class="ph">${esc(m)}</span><a class="wa" href="https://wa.me/${d}" target="_blank" rel="noreferrer" title="WhatsApp">${SVG.wa}</a>`; }
/* Owner initials: first letter of the first name + first letter of the last.
   "Paul Smith" -> PS, "Paul" -> P, nothing usable -> X. Previously this sliced
   the first two characters off owner_user_id, so a UUID rendered as "5C".
   OCE's User has a single full_name, so first/last come from splitting it;
   middle names are ignored — first word and last word only. */
function initials(name){
  const parts=String(name||'').trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return 'X';
  const first=parts[0][0]||'';
  const last=parts.length>1?(parts[parts.length-1][0]||''):'';
  return (first+last).toUpperCase() || 'X';
}
function avatar(name,id){ if(!name&&!id)return '<span class="mt">—</span>';
  return `<span class="avatar" title="${esc(name||id)}">${esc(initials(name))}</span>`; }
/* files/sketch live behind the description popup — mark the cell so a row shows it has them */
function marks(r){ let s='';
  if(r.attachment_count>0) s+=`<span class="cellmark" title="${r.attachment_count} file(s) attached"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>${r.attachment_count}</span>`;
  if(r.has_drawing) s+=`<span class="cellmark" title="Has a drawing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></span>`;
  return s?`<span class="cellmarks">${s}</span>`:''; }

/* columns: full CRM Log List set. tab=null → always. edit.target: file|log|contact */
/* Country dial codes. Flags are real images (flagcdn) rather than emoji, because
   Windows renders flag emoji as bare letter pairs. [iso2, name, dial] */
const DEFAULT_ISO='lb', DEFAULT_DIAL='+961';
const COUNTRIES=[
  ['lb','Lebanon','+961'],['ae','United Arab Emirates','+971'],['sa','Saudi Arabia','+966'],['qa','Qatar','+974'],
  ['kw','Kuwait','+965'],['bh','Bahrain','+973'],['om','Oman','+968'],['jo','Jordan','+962'],['sy','Syria','+963'],
  ['iq','Iraq','+964'],['eg','Egypt','+20'],['tr','Turkey','+90'],['cy','Cyprus','+357'],['il','Israel','+972'],
  ['ps','Palestine','+970'],['ir','Iran','+98'],['ye','Yemen','+967'],
  ['gb','United Kingdom','+44'],['ie','Ireland','+353'],['fr','France','+33'],['de','Germany','+49'],
  ['it','Italy','+39'],['es','Spain','+34'],['pt','Portugal','+351'],['nl','Netherlands','+31'],
  ['be','Belgium','+32'],['ch','Switzerland','+41'],['at','Austria','+43'],['se','Sweden','+46'],
  ['no','Norway','+47'],['dk','Denmark','+45'],['fi','Finland','+358'],['pl','Poland','+48'],
  ['cz','Czechia','+420'],['gr','Greece','+30'],['ro','Romania','+40'],['bg','Bulgaria','+359'],
  ['hu','Hungary','+36'],['hr','Croatia','+385'],['rs','Serbia','+381'],['ua','Ukraine','+380'],
  ['ru','Russia','+7'],['us','United States','+1'],['ca','Canada','+1'],['mx','Mexico','+52'],
  ['br','Brazil','+55'],['ar','Argentina','+54'],['cl','Chile','+56'],['co','Colombia','+57'],
  ['au','Australia','+61'],['nz','New Zealand','+64'],['in','India','+91'],['pk','Pakistan','+92'],
  ['bd','Bangladesh','+880'],['lk','Sri Lanka','+94'],['np','Nepal','+977'],['cn','China','+86'],
  ['jp','Japan','+81'],['kr','South Korea','+82'],['sg','Singapore','+65'],['my','Malaysia','+60'],
  ['id','Indonesia','+62'],['th','Thailand','+66'],['vn','Vietnam','+84'],['ph','Philippines','+63'],
  ['hk','Hong Kong','+852'],['za','South Africa','+27'],['ng','Nigeria','+234'],['ke','Kenya','+254'],
  ['gh','Ghana','+233'],['et','Ethiopia','+251'],['ma','Morocco','+212'],['dz','Algeria','+213'],
  ['tn','Tunisia','+216'],['ly','Libya','+218'],['sd','Sudan','+249'],['am','Armenia','+374'],
  ['ge','Georgia','+995'],['az','Azerbaijan','+994'],['kz','Kazakhstan','+7'],['af','Afghanistan','+93'],
];
const flagSrc=iso=>`https://flagcdn.com/24x18/${iso}.png`;

/* A page may preset window.ACHI_LOG_COLS (the General Log does) to render a
   different column set; otherwise the standard Log columns below are used. */
const COLS=(typeof window!=='undefined'&&Array.isArray(window.ACHI_LOG_COLS)&&window.ACHI_LOG_COLS.length)?window.ACHI_LOG_COLS:[
  {k:'num',    h:'#',              tab:null, cls:'num pg-f-num', w:42},
  {k:'when',   h:'Date & Time',    tab:null, cls:'pg-f-date', w:132},
  {k:'status', h:'Status',         tab:null, cls:'pg-f-stat', w:105, edit:{kind:'status',target:'file',field:'status',val:r=>r.status}},
  {k:'prefix', h:'Pre',            tab:0, w:70,  draft:'select', edit:{kind:'prefix',target:'contact',field:'prefix',val:r=>r.prefix||''}},
  {k:'first',  h:'First',          tab:0, w:120, draft:'text', edit:{kind:'text',target:'contact',field:'first_name',val:r=>r.first_name||''}},
  {k:'last',   h:'Last',           tab:0, w:120, draft:'text', edit:{kind:'text',target:'contact',field:'last_name',val:r=>r.last_name||''}},
  {k:'company',h:'Company',        tab:0, w:160, draft:'text', edit:{kind:'text',target:'contact',field:'company_name',val:r=>r.company_name||''}},
  {k:'desc',   h:'Description',    tab:0, w:320, wide:true, draft:'text', note:true, edit:{kind:'text',target:'log',field:'description',val:r=>r.description||''}},
  {k:'location',h:'Location',      tab:0, w:170, draft:'text', edit:{kind:'text',target:'file',field:'site_location',val:r=>r.site_location||''}},
  {k:'tags',   h:'Tags',           tab:0, w:170, draft:'select', edit:{kind:'tags',target:'log',field:'tags',val:r=>r.tags||''}},
  {k:'owner',  h:'Owner',          tab:0, w:80},
  {k:'type',   h:'Log Type',       tab:0, w:140, draft:'select', edit:{kind:'type',target:'log',field:'log_type',val:r=>r.log_type}},
  {k:'category',h:'Category',      tab:0, w:170, draft:'select', edit:{kind:'category',target:'log',field:'category',val:r=>r.category||''}},
  {k:'stage',  h:'Stage',          tab:0, w:176, edit:{kind:'stage',target:'file',field:'stage',val:r=>glStageKey(r.stage)}},
  {k:'mobile', h:'Mobile',         tab:1, w:215, draft:'tel', edit:{kind:'text',target:'contact',field:'mobile',val:r=>r.mobile||''}},
  {k:'email',  h:'Email',          tab:1, w:200, draft:'text', edit:{kind:'text',target:'contact',field:'email',val:r=>r.email||''}},
  {k:'maps',   h:'Maps',           tab:2, w:120, draft:'text', edit:{kind:'text',target:'file',field:'maps_url',val:r=>r.maps_url||''}},
  {k:'country',h:'Country',        tab:2, w:110, draft:'text', edit:{kind:'country',target:'file',field:'country',val:r=>r.country||''}},
  {k:'district',h:'District',      tab:2, w:120, draft:'text', edit:{kind:'district',target:'file',field:'district',val:r=>r.district||''}},
  {k:'city',   h:'City',           tab:2, w:120, draft:'text', edit:{kind:'city',target:'file',field:'city',val:r=>r.city||''}},
  {k:'street', h:'Street',         tab:2, w:140, draft:'text', edit:{kind:'text',target:'file',field:'street',val:r=>r.street||''}},
  {k:'communication',h:'Communication', tab:3, w:188},
  {k:'last_touch',h:'Last Touch',  tab:3, w:200},
  {k:'updates',h:'Updates',        tab:3, w:300, wide:true, draft:'text', note:true, edit:{kind:'text',target:'log',field:'updates',val:r=>r.updates||''}},
  {k:'followup',h:'Follow-up Date',tab:3, w:150, draft:'date', edit:{kind:'date',target:'log',field:'follow_up_date',val:r=>r.follow_up_date||''}},
  {k:'funotes',h:'Follow-up Notes',tab:3, w:300, wide:true, draft:'text', note:true, edit:{kind:'text',target:'log',field:'follow_up_notes',val:r=>r.follow_up_notes||''}},
];
const FIXED_KEYS=(typeof window!=='undefined'&&Array.isArray(window.ACHI_FIXED_KEYS))?window.ACHI_FIXED_KEYS:['num','when','status'];
const DRAFT_KEYS=COLS.filter(c=>c.draft).map(c=>c.k);
// The General Log sets this so shared cells (e.g. Follow-up) can render its
// variant without changing how the standard Log page looks.
const GENERAL_LOG=(typeof window!=='undefined'&&window.ACHI_GENERAL_LOG===true);
// Operational workspaces opt into a display-only business code. It belongs to
// the workspace being viewed, never to an individual row's workflow stage.
// The permanent ContactFile log_code is never changed or used as this suffix.
const BUSINESS_CODE=(typeof window!=='undefined'&&typeof window.ACHI_BUSINESS_CODE==='string')
  ?window.ACHI_BUSINESS_CODE.trim():'';
function formatBusinessCode(r,rowNumber){
  const displayNumber=String(rowNumber);
  if(!GENERAL_LOG||!r) return displayNumber;

  // The unconfigured General Log deliberately keeps its existing permanent
  // code display. Only explicitly configured workspaces use a visible index.
  if(!BUSINESS_CODE){
    return r.log_code?String(r.log_code).replace(/^MT(?=-)/,'M/T'):displayNumber;
  }
  return BUSINESS_CODE?`${BUSINESS_CODE}-${displayNumber}`:displayNumber;
}
/* User-selected column filters. These are separate from ACHI_LOG_FILTER:
   the latter defines an immutable workspace scope; these only narrow it. */
const LOG_COLUMN_FILTER_SPECS=Object.freeze({
  num:           {kind:'text',     param:'number'},
  when:          {kind:'date',     from:'when_from',to:'when_to'},
  status:        {kind:'multi',    param:'status'},
  prefix:        {kind:'multi',    param:'prefix'},
  first:         {kind:'text',     param:'first'},
  last:          {kind:'text',     param:'last'},
  company:       {kind:'text',     param:'company'},
  owner:         {kind:'multi',    param:'owner',unassigned:'unassigned'},
  mobile:        {kind:'text',     param:'mobile'},
  email:         {kind:'text',     param:'email'},
  maps:          {kind:'presence', param:'has_map'},
  desc:          {kind:'text',     param:'description'},
  type:          {kind:'multi',    param:'type'},
  stage:         {kind:'multi',    param:'stage'},
  communication: {kind:'multi',    param:'communication',mode:'communication_mode'},
  last_touch:    {kind:'date',     from:'last_touch_from',to:'last_touch_to'},
  deliverables:  {kind:'multi',    param:'deliverable',mode:'deliverable_mode'},
  tags:          {kind:'multi',    param:'tag',mode:'tag_mode'},
  updates:       {kind:'text',     param:'updates'},
  followup:      {kind:'date',     from:'follow_up_from',to:'follow_up_to',state:'follow_up_state'},
  country:       {kind:'multi',    param:'country'},
  district:      {kind:'multi',    param:'district'},
  city:          {kind:'multi',    param:'city'},
  street:        {kind:'text',     param:'street'},
});

const LOG_COLUMN_KEYS=new Set(COLS.map(column=>column.k));
const LOG_COLUMN_FILTERS=Object.create(null);
const LOG_FILTER_STORAGE_KEY=
  `achi_log_column_filters_v1:${location.pathname}`;

function logFilterValues(raw){
  const source=Array.isArray(raw)
    ? raw
    : raw==null
      ? []
      : [raw];

  const values=[];
  const seen=new Set();

  for(const item of source){
    const value=String(item||'').trim();
    const fingerprint=value.toLocaleLowerCase();

    if(!value||seen.has(fingerprint)) continue;

    seen.add(fingerprint);
    values.push(value);
  }

  return values;
}

function normaliseLogColumnFilter(key,raw){
  const spec=LOG_COLUMN_FILTER_SPECS[key];

  if(!spec||!LOG_COLUMN_KEYS.has(key)) return null;

  if(spec.kind==='text'){
    const value=String(
      raw&&typeof raw==='object'&&'value' in raw
        ? raw.value
        : raw||''
    ).trim();

    return value?{value}:null;
  }

  if(spec.kind==='multi'){
    const values=logFilterValues(
      raw&&typeof raw==='object'&&'values' in raw
        ? raw.values
        : raw
    );
    const unassigned=Boolean(
      raw&&typeof raw==='object'&&raw.unassigned
    );

    if(!values.length&&!unassigned) return null;

    return {
      values,
      unassigned,
      mode:
        raw&&typeof raw==='object'&&raw.mode==='all'
          ? 'all'
          : 'any',
    };
  }

  if(spec.kind==='presence'){
    const value=
      raw&&typeof raw==='object'&&'value' in raw
        ? raw.value
        : raw;

    if(value!==true&&value!==false) return null;

    return {value};
  }

  if(spec.kind==='date'){
    const from=String(raw&&raw.from||'').trim();
    const to=String(raw&&raw.to||'').trim();
    const state=String(raw&&raw.state||'').trim();

    if(!from&&!to&&!state) return null;

    return {from,to,state};
  }

  return null;
}

function persistLogColumnFilters(){
  try{
    sessionStorage.setItem(
      LOG_FILTER_STORAGE_KEY,
      JSON.stringify(LOG_COLUMN_FILTERS),
    );
  }catch(_){}
}

function setLogColumnFilter(key,raw,{persist=true}={}){
  const state=normaliseLogColumnFilter(key,raw);

  if(state) LOG_COLUMN_FILTERS[key]=state;
  else delete LOG_COLUMN_FILTERS[key];

  if(persist) persistLogColumnFilters();
}

function clearLogColumnFilter(key){
  delete LOG_COLUMN_FILTERS[key];
  persistLogColumnFilters();
}

function clearAllLogColumnFilters(){
  Object.keys(LOG_COLUMN_FILTERS).forEach(
    key=>delete LOG_COLUMN_FILTERS[key],
  );
  persistLogColumnFilters();
}

function hasLogColumnFilter(key){
  return Boolean(LOG_COLUMN_FILTERS[key]);
}

function restoreLogColumnFilters(){
  try{
    const saved=JSON.parse(
      sessionStorage.getItem(LOG_FILTER_STORAGE_KEY)||'{}',
    );

    if(!saved||typeof saved!=='object') return;

    Object.entries(saved).forEach(([key,value])=>{
      setLogColumnFilter(key,value,{persist:false});
    });
  }catch(_){}
}

function logFilterDateTime(value,endOfDay=false){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))) return '';

  const time=endOfDay?'T23:59:59.999':'T00:00:00';
  const date=new Date(`${value}${time}`);

  return isNaN(date)?'':date.toISOString();
}

function logLocalToday(){
  const date=new Date();
  const pad=value=>String(value).padStart(2,'0');

  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

function appendLogColumnFilterParams(params){
  for(const [key,state] of Object.entries(LOG_COLUMN_FILTERS)){
    const spec=LOG_COLUMN_FILTER_SPECS[key];

    if(!spec||!state) continue;

    if(spec.kind==='text'){
      params.set(spec.param,state.value);
      continue;
    }

    if(spec.kind==='multi'){
      state.values.forEach(value=>params.append(spec.param,value));

      if(spec.unassigned&&state.unassigned){
        params.set(spec.unassigned,'true');
      }

      if(spec.mode&&state.mode==='all'){
        params.set(spec.mode,'all');
      }

      continue;
    }

    if(spec.kind==='presence'){
      params.set(spec.param,String(state.value));
      continue;
    }

    if(spec.kind==='date'){
      const from=logFilterDateTime(state.from);
      const to=logFilterDateTime(state.to,true);

      if(spec.from&&from) params.set(spec.from,from);
      if(spec.to&&to) params.set(spec.to,to);
      if(spec.state&&state.state){
        params.set(spec.state,state.state);
        params.set('today',logLocalToday());
      }
    }
  }
}

restoreLogColumnFilters();
// A follow-up date is overdue once it's in the past and the file isn't closed.
function isOverdueFollowup(r){
  if(!r||!r.follow_up_date) return false;
  if(r.status==='done'||r.status==='cancelled') return false;
  const due=new Date(String(r.follow_up_date)+'T00:00:00');
  if(isNaN(due)) return false;
  const today=new Date(); today.setHours(0,0,0,0);
  return due<today;
}
function cellHTML(c,r,i){switch(c.k){
  case 'num': return `<span class="rn${BUSINESS_CODE?' rn-code':''}">${esc(formatBusinessCode(r,i+1))}</span>`;
  case 'when': {
  const when = r.occurred_at || r.created_at;
  if(!when) return '<span class="mt">—</span>';

  const d = new Date(when);
  if(isNaN(d)) return esc(when);

  const p = n => String(n).padStart(2,'0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const hour = d.getHours();
  const h = hour % 12 || 12;

  const text =
    `${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ` +
    `${p(h)}:${p(d.getMinutes())} ${hour < 12 ? 'AM' : 'PM'}`;

  return `<span class="lt-date">${esc(text)}</span>`;
}  case 'status': return badge(r.status);
  case 'prefix': return dash(r.prefix);
  case 'first': return dash(r.first_name);
  case 'last': return dash(r.last_name);
  case 'company': return dash(r.company_name);
  case 'desc': return `<span class="desc-cell-text">${r.description?(looksHTML(r.description)?richText(r.description):esc(r.description)):'<span class="mt">—</span>'}</span>`+marks(r);
  case 'location': {
    // The Location column shows the CITY as a Google Maps link — the pinned
    // maps_url when one is set, otherwise a Maps search for city/district/country.
    const _city=String(r.city||'').trim();
    if(!_city) return '<span class="mt">—</span>';
    const _q=[r.city,r.district,r.country].filter(Boolean).join(', ');
    const _url=(r.maps_url&&normalizeMapsUrl(r.maps_url))||('https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(_q));
    return `<a class="loc-link" href="${esc(_url)}" target="_blank" rel="noreferrer" title="Open in Google Maps">${SVG.pin}${esc(_city)}</a>`;
  }
  case 'owner': return avatar(r.owner_name,r.owner);
  case 'type': return tagv(r.log_type);
  case 'category': return tagv(r.category);
  case 'tags': return tagsHTML(r.tags);
  case 'mobile': return phone(r.mobile);
  case 'email': {
    if(!r.email) return '<span class="mt">—</span>';
    // A sent (green paper-plane) or not-yet (grey clock) badge, pinned to the end.
    const _sent=r.email_sent
      ? '<span class="sent-ic sent-yes" title="An email was already sent to this address"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg></span>'
      : '<span class="sent-ic sent-no" title="No email sent to this address yet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>';
    return `<span class="email-cell"><button class="email-btn" type="button" data-compose-email="${esc(r.email)}" title="Compose email">${SVG.mail}<span>${esc(r.email)}</span></button>${_sent}</span>`;
  }
  case 'maps': return r.maps_url
    ? `<span class="maps-cell"><a class="maps-btn" href="${esc(r.maps_url)}" target="_blank" rel="noreferrer" data-mapurl="${esc(r.maps_url)}"><span class="pin">${SVG.pin}</span><span>Open in Maps</span></a><button class="map-copy" data-copy="${esc(r.maps_url)}" title="Copy link">${SVG.copy}</button><button class="map-edit" data-edit-map title="Edit link">${SVG.pen}</button></span>`
    : '<span class="mt">—</span>';
  case 'country': return dash(r.country);
  case 'district': return dash(r.district);
  case 'city': return dash(r.city);
  case 'street': return dash(r.street);
  case 'updates': return r.updates?esc(r.updates):'<span class="mt">—</span>';
  case 'followup': {
    if(!r.follow_up_date) return '<span class="mt">—</span>';
    const overdue=isOverdueFollowup(r);
    // General Log renders it as plain text (red + "!" when overdue); the standard
    // Log page keeps its badge, just tinted red when overdue.
    if(GENERAL_LOG) return `<span class="fu-date${overdue?' fu-overdue':''}">${esc(r.follow_up_date)}${overdue?' !':''}</span>`;
    return `<span class="badge ${overdue?'b-cancelled fu-overdue':'b-scheduled'}">${esc(r.follow_up_date)}${overdue?' !':''}</span>`;
  }
  case 'funotes': return r.follow_up_notes?esc(r.follow_up_notes):'<span class="mt">—</span>';
  /* General Log extra columns */
  case 'ref': return r.reference?`<span class="enq-ref">${esc(r.reference)}</span>`:'<span class="mt">—</span>';
  case 'role': return dash(r.role);
  case 'stage': return glStageCell(r);
  case 'communication': return glCommCell(r);
  case 'last_touch': return glLastTouchCell(r);
  case 'deliverables': return glDocsCell(r);
}}

const ROW_CACHE_KEY=
  `achi_log_rows_v2:${window.location.pathname}`;let ROWS=[], openOnly=false, activeTab=0;
// Deleted Logs filter. When on, the grid renders `deletedRows` (soft-deleted
// logs fetched separately) instead of ROWS, read-only, for restore / permanent
// delete. Kept distinct from ROWS so KPIs and the active list stay correct.
// Toggled and populated by log-deleted.js.
let deletedView=false, deletedRows=[];
/* A full refresh destroys the page before /logs/ can answer. Keep the last
   successful result for this browser tab so the existing table remains visible
   while the fresh request runs. Do not restore it without a login token. */
if(TOKEN){
  try{
    const cached=JSON.parse(sessionStorage.getItem(ROW_CACHE_KEY)||'[]');
    if(Array.isArray(cached)) ROWS=cached;
  }catch(_){}
}
const selectedRows=new Set();
let topDraft={}, bottomDrafts=[];   // persisted client-side entry state
let selected=new Set();             // selected log ids

async function stats(){
  try{
    const path=typeof logStatsPath==='function'
    ? logStatsPath()
    : '/logs/stats';
    const s = await api(path);

    $('k-total').textContent = s.total ?? 0;
    $('k-open').textContent = s.open ?? 0;
    $('k-month').textContent = s.this_month ?? 0;
    $('k-done').textContent = s.done ?? 0;

  }catch(e){
    console.warn('Could not load log stats', e);
  }
}
/* ── column widths (ported from tabbed_grid.js _wireColResize) ─────────────
 * Widths are per-column and remembered per browser, so someone who widens
 * "What was said" keeps it wide tomorrow. The table is `table-layout:fixed`,
 * so setting the th width is what actually sizes the column — the body cells
 * follow it and nothing has to be touched per row. */
const COLW_KEY='achi_log_col_widths_v2', COLW_MIN=42,
      BUSINESS_CODE_COLUMN_MIN=136;
let COLW={};
function loadColWidths(){
  try{ COLW=JSON.parse(localStorage.getItem(COLW_KEY)||'{}')||{}; }catch(e){ COLW={}; }
}
function saveColWidths(){
  try{ localStorage.setItem(COLW_KEY,JSON.stringify(COLW)); }catch(e){}
}
const colWidth=c=>Math.max(
  c.k==='num'&&BUSINESS_CODE?BUSINESS_CODE_COLUMN_MIN:COLW_MIN,
  Number(COLW[c.k])||c.w,
);
function fixedLeft(key){
  let left=0;
  for(const k of FIXED_KEYS){
    if(k===key) return left;
    const c=COLS.find(x=>x.k===k); if(c) left+=colWidth(c);
  }
  return 0;
}
function colClass(c,extra=''){
  return [extra,FIXED_KEYS.includes(c.k)?'pg-f':'',c.k==='status'?'pg-f-shadow':'',c.k==='when'&&colWidth(c)<=110?'pg-dt-narrow':''].filter(Boolean).join(' ');
}
function fixedStyle(c){
  const width=colWidth(c);
  return `${FIXED_KEYS.includes(c.k)?`position:sticky;left:${fixedLeft(c.k)}px;`:''}min-width:${width}px;width:${width}px;max-width:${width}px;`;
}
function applyFixedLayout(){
  for(const c of COLS){
    const width=colWidth(c);
    document.querySelectorAll(`[data-k="${c.k}"]`).forEach(cell=>{
      cell.classList.toggle('pg-dt-narrow',c.k==='when'&&colWidth(c)<=110);
      cell.style.minWidth=width+'px';
      cell.style.width=width+'px';
      cell.style.maxWidth=width+'px';
      if(FIXED_KEYS.includes(c.k)){
        cell.style.position='sticky';
        cell.style.left=fixedLeft(c.k)+'px';
      }
    });
  }
}
function buildHead(){
  $('thead').innerHTML=COLS.map(c=>{
    // The # header doubles as select-all: the rows already select by clicking
    // their own number cell, so the column header toggling the whole column is
    // where people look for it. role/aria-pressed because a <th> is not a button.
    const sel=c.k==='num'
      ? ` class="${colClass(c,`${c.cls||''} num-head`)}" role="button" tabindex="0" aria-pressed="false" title="Select or unselect all rows"`
      : ` class="${colClass(c,c.cls||'')}"`;
    const filterButton=LOG_COLUMN_FILTER_SPECS[c.k]
      ? `<button type="button" class="log-col-filter-btn${
          hasLogColumnFilter(c.k)?' is-active':''
        }" data-log-filter-key="${c.k}" aria-label="Filter ${esc(c.h)}"
          title="Filter ${esc(c.h)}">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 3h12L9.4 8.1v3.7l-2.8 1.4V8.1z"/>
          </svg>
        </button>`
      : '';
    return `<th data-tab="${c.tab??''}" data-k="${c.k}"${sel} style="${fixedStyle(c)}">`
    +`<span class="log-col-head-label">${c.h}</span>`
    +filterButton
    +`</span><span class="rz" data-k="${c.k}" title="Drag to resize"></span></th>`;
    +`${c.h}<span class="rz" data-k="${c.k}" title="Drag to resize"></span></th>`;
  }).join('');
}
/* Pointer events rather than mouse, so this works on the tablet a surveyor
   carries as well as a desktop. One delegated listener on the header survives
   buildHead() being called again. */
function wireColResize(){
  const head=$('thead');
  if(!head || head.dataset.rzWired) return;
  head.dataset.rzWired='1';
  head.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.rz'); if(!handle) return;
    e.preventDefault(); e.stopPropagation();
    const th=handle.closest('th'), key=handle.dataset.k;
    if(!th||!key) return;
    const startX=e.clientX, startW=th.getBoundingClientRect().width;
    handle.classList.add('rz-active');
    document.body.classList.add('col-resizing');
    handle.setPointerCapture&&handle.setPointerCapture(e.pointerId);
    const move=ev=>{
      const next=Math.max(COLW_MIN,Math.round(startW+ev.clientX-startX));
      COLW[key]=next;
      applyFixedLayout();
    };
    const up=()=>{
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerup',up);
      handle.classList.remove('rz-active');
      document.body.classList.remove('col-resizing');
      saveColWidths();
      moveIndToActive();   // the pill indicator tracks column offsets
    };
    window.addEventListener('pointermove',move);
    window.addEventListener('pointerup',up);
  });
  // Double-click a handle to put that column back to its designed width.
  head.addEventListener('dblclick',e=>{
    const handle=e.target.closest('.rz'); if(!handle) return;
    const c=COLS.find(x=>x.k===handle.dataset.k); if(!c) return;
    delete COLW[c.k]; saveColWidths();
    applyFixedLayout();
  });
}
function moveIndToActive(){ const b=tabsEl&&tabsEl.querySelector('.pill-tab.on'); if(b) moveInd(b); }

function draftCell(c,dp,st,rowNumber){
  if(c.k==='num') return BUSINESS_CODE
    ?'<span class="rn rn-draft">+</span>'
    :`<span class="rn">${rowNumber}</span>`;
  // Frappe's CRM Log draft rows show the actual creation value as
  // DD/MM/YYYY HH:MM instead of the relative placeholder "now".
  if(c.k==='when'){
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const hour = d.getHours();
  const h = hour % 12 || 12;

  const text =
    `${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ` +
    `${p(h)}:${p(d.getMinutes())} ${hour < 12 ? 'AM' : 'PM'}`;

  return `<span class="lt-date">${esc(text)}</span>`;
  }
  if(c.k==='status') return `<input class="din pg-select-input draft-popup-select" id="${dp}-status" data-dp="${dp}" data-dk="status" data-select-value="${esc(st.status||'open')}" value="${esc(label(st.status||'open'))}" readonly>`;
  if(c.k==='owner') return `<span class="mt">you</span>`;
  const id=`${dp}-${c.k}`, v=esc(st[c.k]||'');
  if(c.draft==='select'){
    if(c.k==='prefix') return `<input class="din pg-select-input draft-popup-select" id="${id}" data-dp="${dp}" data-dk="prefix" data-select-value="${esc(st.prefix||'')}" value="${esc(st.prefix||'')}" readonly>`;
    if(c.k==='category') return `<input class="din pg-select-input draft-popup-select" id="${id}" data-dp="${dp}" data-dk="category" data-select-value="${esc(st.category||'')}" value="${esc(label(st.category||''))}" readonly>`;
    if(c.k==='type') return `<input class="din pg-select-input draft-popup-select" id="${id}" data-dp="${dp}" data-dk="type" data-select-value="${esc(st.type||'inbound_call')}" value="${esc(label(st.type||'inbound_call'))}" readonly>`;
    if(c.k==='tags') return `<input class="din pg-select-input draft-popup-select" id="${id}" data-dp="${dp}" data-dk="tags" data-select-value="${esc(st.tags||'')}" value="${esc(st.tags||'')}" placeholder="Select tag" readonly>`; }
  if(c.draft==='date') return `<input class="din" id="${id}" data-dp="${dp}" data-dk="${c.k}" type="date" value="${v}">`;
  if(c.draft==='tel'){ const iso=st.iso||DEFAULT_ISO, dial=st.dial||DEFAULT_DIAL;
    return `<span class="tel-wrap"><button type="button" class="tel-cc" data-dp="${dp}" title="Country code"><img src="${flagSrc(iso)}" alt=""><span class="cc">${esc(dial)}</span>${SVG.chev}</button>`
      + `<input class="din tel-num" id="${id}" data-dp="${dp}" data-dk="mobilenum" placeholder="70 123 456" value="${esc(st.mobilenum||'')}"></span>`; }
  if(c.draft==='text'){
    const ph={prefix:'Mr/Ms',first:'First',last:'Last',company:'Company',desc:'What was said…',location:'Location',mobile:'+961…',email:'Email',maps:'Maps URL',country:'Country',district:'District',city:'City',street:'Street',updates:'Updates',funotes:'Notes'}[c.k]||'';
    const type=c.k==='email'?' type="email" inputmode="email" autocomplete="email"':c.k==='first'?' autocomplete="off"':'';
    const inp=`<input class="din" id="${id}" data-dp="${dp}" data-dk="${c.k}" placeholder="${ph}" value="${v}"${type}${c.note?' data-note="1"':''}>`;
    if(c.note) return `<span class="note-wrap">${inp}<button type="button" class="note-exp" data-noteexp data-for="${id}" title="Open notes, files and drawing">${SVG.expand}</button></span>`;
    if(c.k==='email') return `<span class="draft-email">${inp}<button class="draft-compose" type="button" data-draft-compose="${id}" title="Compose email"${validEmail(st[c.k])&&st[c.k]?'':' hidden'}>${SVG.mail}</button></span>`;
    if(c.k==='maps') return `<span class="draft-map-wrap">${inp}<button type="button" class="map-edit" data-draft-map="${id}" title="Set map location">${SVG.pen}</button></span>`;
    return inp;
  }
  return `<span class="mt">—</span>`;
}
function draftRowHTML(dp,st,isTop,rowNumber){
  const key=`draft:${dp}`, selected=selectedRows.has(key)?' row-selected':'';
  return `<tr class="draft selectable-row ${isTop?'dtop':''}${selected}" data-row-key="${key}">${COLS.map(c=>{
    const select=c.k==='num'?`data-select-row="${key}" title="Select this row" aria-label="Select row ${rowNumber}"`:'';
    return `<td data-tab="${c.tab??''}" data-k="${c.k}" class="${colClass(c,[c.cls||'',c.wide?'wide':''].filter(Boolean).join(' '))}" style="${fixedStyle(c)}" ${select}>${draftCell(c,dp,st,rowNumber)}</td>`;
  }).join('')}</tr>`;
}

function dataRowHTML(r,i,rowNumber){ const key=`log:${r.id}`; return `<tr class="data selectable-row${selectedRows.has(key)?' row-selected':''}" data-row-key="${key}" data-file="${r.file_id}" data-log="${r.id}" data-i="${i}">${
  COLS.map(c=>{
    const ed=c.edit?`data-edit data-kind="${c.edit.kind}" data-target="${c.edit.target}" data-field="${c.edit.field}" data-val="${esc(c.edit.val(r))}"`:'';
    const cls=colClass(c,[c.cls||'',c.k==='num'&&BUSINESS_CODE?'business-code-cell':'',c.wide?'wide':'',c.note?'notecell':'',c.edit?(['stage','comm','status','type','category','prefix','role','subject','district','city','country','tags'].includes(c.edit.kind)?'sel':'ed'):''].filter(Boolean).join(' '));
    const select=c.k==='num'?`data-select-row="${key}" title="Select this row" aria-label="Select row ${rowNumber}"`:'';
    const exp=c.note?`<button type="button" class="note-exp" data-noteexp title="Open notes, files and drawing">${SVG.expand}</button>`:'';
    return `<td data-tab="${c.tab??''}" data-k="${c.k}" class="${cls}" style="${fixedStyle(c)}" ${select} ${ed}>${c.k==='num'?`<span class="rn${BUSINESS_CODE?' rn-code':''}">${esc(formatBusinessCode(r,rowNumber))}</span>`:cellHTML(c,r,i)}${exp}</td>`;
  }).join('')
}</tr>`; }

function visibleSelectableRows(){ return [...$('rows').querySelectorAll('tr.selectable-row')]; }
/* Select-all skips the top draft row. It is the permanent blank "new entry" row,
   not a record — sweeping it in meant Delete counted a row that does not exist
   yet. Clicking its own number cell still selects it, which is the only way it
   can be selected deliberately. */
function selectAllTargets(){ return visibleSelectableRows().filter(tr=>!tr.classList.contains('dtop')); }
function allRowsSelected(){
  const rows=selectAllTargets();
  return rows.length>0&&rows.every(tr=>selectedRows.has(tr.dataset.rowKey));
}
/* Reflect the selection state on the # header. Guarded because render() calls
   this and the header may not be built yet on the very first pass. */
function refreshSelectionButton(){
  const th=$('thead').querySelector('th[data-k="num"]');
  if(!th) return;
  const all=allRowsSelected();
  th.classList.toggle('on',all);
  th.setAttribute('aria-pressed',String(all));
  th.setAttribute('title',all?'Unselect all rows':'Select all rows');
  // Swap the expand-row button label based on selection state.
  const btn=$('expand-row');
  if(!btn) return;
  const logCount=logKeys().length;
  if(logCount>1){
    btn.style.display='none';
  } else if(selectedLogId()){
    btn.style.display='';
    btn.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 8h10M8 3l5 5-5 5"/></svg> Expand Row';
  } else {
    btn.style.display='';
    btn.innerHTML='<span class="tb-add-plus">+</span> Add Log';
  }
}
function toggleSelectAll(){
  const rows=selectAllTargets(), all=allRowsSelected();
  rows.forEach(tr=>toggleRowSelection(tr,!all));
  refreshSelectionButton(); refreshDeleteButton();
}
function toggleRowSelection(tr,force){
  const id=tr.dataset.rowKey, on=force===undefined?!selectedRows.has(id):force;
  if(on) selectedRows.add(id); else selectedRows.delete(id);
  tr.classList.toggle('row-selected',on);
  refreshSelectionButton();
}

function render(){
  // Text search is handled by the API, together with column filters, so results
  // are correct even when matching rows are outside the currently loaded set.
  let rows=deletedView
    ? deletedRows
    : (openOnly?ROWS.filter(r=>r.status==='open'):ROWS);
  let rowNumber=1;
  const body=[
    deletedView?'':draftRowHTML(
      'd',
      topDraft,
      true,
      BUSINESS_CODE?rowNumber:rowNumber++,
    ),
    rows.length?rows.map((r,i)=>dataRowHTML(r,i,rowNumber++)).join(''):'',
    deletedView?'':bottomDrafts.map((st,i)=>draftRowHTML(
      'b'+i,
      st,
      false,
      BUSINESS_CODE?rowNumber:rowNumber++,
    )).join(''),
  ].join('');
  $('rows').innerHTML=body;
  refreshSelectionButton();
  refreshDeleteButton();
}

/* Open the Last Touch calendar when its displayed date is clicked. */
$('rows').addEventListener('click',e=>{
  const button=e.target.closest('[data-last-touch-open]');
  if(!button) return;

  const cell=button.closest('td');
  const picker=cell?.querySelector('input[data-last-touch]');
  if(!picker) return;

  try{
    picker.showPicker();
  }catch(_){
    picker.click();
  }
});


/* Save the selected Last Touch date + time. */
$('rows').addEventListener('change',async e=>{
  const input=e.target.closest('input[data-last-touch]');
  if(!input) return;

  const tr=input.closest('tr[data-log]');
  if(!tr) return;

  const logId=tr.dataset.log;
  const row=ROWS.find(r=>String(r.id)===String(logId));
  const previous=row?.occurred_at||'';

  try{
    const occurredAt=input.value
      ? new Date(input.value).toISOString()
      : null;

    await api('/logs/'+logId,{
      method:'PATCH',
      body:JSON.stringify({
        occurred_at:occurredAt
      })
    });

    if(row) row.occurred_at=occurredAt;

    const label=tr.querySelector('[data-last-touch-open]');
    if(label){
      label.textContent=occurredAt
        ? fmtLastTouchDateTime(occurredAt)
        : '—';
    }

    clearErr();

  }catch(err){
    input.value=toLocalDateTimeValue(previous);
    fail(err.message||'Could not update Last Touch');
  }
});

/* Save the General Log Last Touch date + time. */
$('rows').addEventListener('change',async e=>{
  const input=e.target.closest('input[data-last-touch]');
  if(!input) return;

  const tr=input.closest('tr[data-log]');
  if(!tr) return;

  const logId=tr.dataset.log;
  const row=ROWS.find(r=>String(r.id)===String(logId));
  const previous=row&&row.occurred_at ? row.occurred_at : '';

  try{
    input.disabled=true;

    const occurredAt=input.value
      ? new Date(input.value).toISOString()
      : null;

    await api('/logs/'+logId,{
      method:'PATCH',
      body:JSON.stringify({
        occurred_at:occurredAt
      })
    });

    if(row) row.occurred_at=occurredAt;

    clearErr();
  }catch(err){
    input.value=toLocalDateTimeValue(previous);
    fail(err.message||'Could not update Last Touch');
  }finally{
    input.disabled=false;
  }
});

/* Keep row creation spatially obvious. The grid has its own vertical scroll
   container, so scrolling the page is not enough: target the exact rendered
   <tr> while preserving the user's horizontal column position. */
function revealGridRow(selector,focusId){
  requestAnimationFrame(()=>{
    const row=$('rows').querySelector(selector);
    if(!row)return;
    const box=$('touter'),br=box.getBoundingClientRect(),rr=row.getBoundingClientRect();
    const top=box.scrollTop+(rr.top-br.top)-Math.max(0,(box.clientHeight-rr.height)/2);
    box.scrollTo({top:Math.max(0,top),left:box.scrollLeft,behavior:'smooth'});
    const input=focusId&&$(focusId);
    if(input)input.focus({preventScroll:true});
  });
}

function revealSavedRow(logId){
  if(!logId)return;
  let selector=`tr[data-log="${CSS.escape(String(logId))}"]`;
  // A search can hide the row that was just created. Clear only when necessary
  // so "Save" always lands on the actual saved row instead of leaving it lost.
  if(!$('rows').querySelector(selector)){
    $('q').value='';
    openOnly=false;
    $('k-open-card').classList.remove('on');
    render();
  }
  revealGridRow(selector);
}

/* Delete the selected rows. Uses the shared selectedRows set (keys are `log:<id>`)
   so it stays in step with the select-all / row-number selection. */
/* Draft rows are selectable too, and their keys are `draft:<dp>` rather than
   `log:<id>`. Deleting has to tell them apart: a saved row is deleted through the
   API, an unsaved draft row is simply discarded. Sending a draft key to
   DELETE /logs/ 404s and used to abort the whole batch, deleting nothing. */
const logKeys=()=>[...selectedRows].filter(k=>String(k).startsWith('log:'));
const draftKeys=()=>[...selectedRows].filter(k=>String(k).startsWith('draft:'));
/* Unique email addresses of the selected saved rows — the recipients of a
   broadcast. Rows with no email are skipped; duplicates are collapsed. */
function selectedEmails(){
  const set=new Set();
  logKeys().forEach(k=>{ const id=String(k).slice(4); const r=ROWS.find(x=>x.id===id); const e=String(r&&r.email||'').trim(); if(e) set.add(e); });
  return [...set];
}
function refreshEmailButton(){
  const btn=$('btn-email'); if(!btn) return;
  const emails=selectedEmails();
  btn.classList.toggle('on', emails.length>0);
  const c=$('email-count'); if(c) c.textContent=emails.length;
}
function refreshDeleteButton(){
  const n=logKeys().length+draftKeys().length, del=$('btn-del');
  if(del){ del.classList.toggle('on', n>0); const c=$('del-count'); if(c) c.textContent=n; }
  refreshEmailButton();
  // Expand needs exactly one saved row — the same condition the card uses.
  // Expand Row is always available now: with a selection it edits that row,
  // without one it opens a blank form that creates a new entry. Only the tooltip
  // changes with the selection.
  const exp=$('expand-row'); if(exp) exp.title=selectedLogId()?'Open the selected row to edit':'Open a blank form for a new entry';
  refreshQuickQuote();
  if(deletedView && window.updateDeletedBar) window.updateDeletedBar();   // keep Restore/Delete counts in step
}

/* ── quick quotation ────────────────────────────────────────────────────────
   Drafts a customer quotation from the selected row. OCE has no sales-side
   quotation module — rfq_bidding, bid_management and tendering all model us
   soliciting bids — so this posts to our own /logs/{id}/quotation.

   Shown only for exactly ONE selected saved row: a quotation is addressed to a
   single customer, and a draft row has no id to address it to. */
// qvHidden is scoped to ONE row: dismissing the card should not suppress it for
// the rest of the session, so selecting a different row brings it back.
let qvHidden=false, qvLastId=null;
const qvNum=id=>{ const v=parseFloat($(id).value); return isNaN(v)?0:v; };
function selectedLogId(){
  const logs=logKeys();
  if(logs.length!==1) return null;
  return logs[0].slice(4);   // strip "log:"
}
function refreshQuickQuote(){
  const card=$('qv'); if(!card) return;
  if(deletedView){ card.hidden=true; return; }   // no quotation from the deleted view
  const id=selectedLogId();
  if(id!==qvLastId){ qvLastId=id; qvHidden=false; qvMsg(''); }
  if(!id||qvHidden){ card.hidden=true; return; }
  const r=ROWS.find(x=>x.id===id);
  if(!r){ card.hidden=true; return; }
  card.hidden=false;
  const who=[r.contact_name,r.company_name].filter(Boolean).join(' · ')||'this enquiry';
  $('qv-for').textContent=`${r.file_number?r.file_number+' — ':''}${who}`;
  if(!$('qv-city').value && r.city) $('qv-city').value=r.city;
  qvTotals();
}
/* Totals mirror quotation_service.compute_totals. Duplicated deliberately: this
   is a live preview and must not wait on a round trip. The SERVER's numbers are
   the ones stored — if the two ever disagree, the server is right. */
function qvTotals(){
  const hire=qvNum('qv-area')*qvNum('qv-weeks')*qvNum('qv-rate');
  let sub=hire+qvNum('qv-erection')+qvNum('qv-transport')+qvNum('qv-extras')-qvNum('qv-discount');
  if(sub<0) sub=0;
  const vat=sub*qvNum('qv-vat')/100;
  $('qv-sub').textContent=sub.toFixed(2);
  $('qv-vatv').textContent=vat.toFixed(2);
  $('qv-tot').textContent=(sub+vat).toFixed(2);
}
function qvMsg(text,cls){ const m=$('qv-msg'); m.textContent=text||''; m.className='qv-msg'+(cls?' '+cls:''); }

/* ── expanded row ───────────────────────────────────────────────────────────
   The selected row as one vertical page: every field stacked, the map rendered
   rather than linked, and quotation drafting at the bottom. Sections come from
   COLS' own tab numbers, so a column added to the table shows up here without
   anyone remembering to update this. */
/* The sheet groups fields the way the design reference does — Contact, Log,
   Site, Follow-up — by explicit column key rather than the table's tab numbers,
   because the on-phone reading order is not the same as the grid's tab order
   (a name and its phone belong together here; in the grid they sit in different
   tabs). Add a column to COLS and add its key here to show it in the sheet. */
const RX_CARDS=[
  {title:'Contact',   name:true, keys:['company','mobile','email']},
  {title:'Log',       keys:['status','type','category']},
  {title:'Site',      map:true, keys:['location','country','district','city','street','maps']},
  {title:'Follow-up', keys:['followup']},
  {title:'Notes',     keys:['desc','updates','funotes']},
];
const RX_LONG=new Set(['desc','updates','funotes']);

/* The name as one line — "Mr Test arara" — that splits into three inline boxes
   (prefix / first / last) when tapped. The boxes carry the same data-k keys as
   the grid columns, so they save through the exact same path as every other
   field; nothing special downstream. */
function rxNameHTML(src){
  const pre=src.prefix||'', first=src.first_name||'', last=src.last_name||'';
  const disp=[pre,first,last].filter(Boolean).join(' ')||'Add name';
  const opts=(selectPopupChoices('prefix')||[]).filter(o=>(typeof o==='string'?o:o.value)!==PREFIX_ADD);
  const prefixSel=`<select data-k="prefix" id="rx-prefix">${opts.map(o=>{
    const v=typeof o==='string'?o:o.value; const l=typeof o==='string'?(o||'—'):(o.label||o.value||'—');
    return `<option value="${esc(v)}"${String(v)===String(pre)?' selected':''}>${esc(l)}</option>`;}).join('')}</select>`;
  return `<div class="rx-name-wrap" id="rx-name-wrap">
    <button type="button" class="rx-name" id="rx-name-toggle"><span class="nm" id="rx-name-disp">${esc(disp)}</span>${SVG.pen}</button>
    <div class="rx-name-edit">${prefixSel}`
    +`<input type="text" data-k="first" id="rx-first" placeholder="First" value="${esc(first)}">`
    +`<input type="text" data-k="last" id="rx-last" placeholder="Last" value="${esc(last)}"></div></div>`;
}
/* Linked badges from what the row actually has — never fabricated. */
function rxBadgesHTML(r){
  const b=[];
  if(r.company_contact_id) b.push('Company contact');
  if(r.has_drawing) b.push('Linked: Site Visit');
  if(r.attachment_count>0) b.push(`${r.attachment_count} attachment${r.attachment_count>1?'s':''}`);
  if(!b.length) return '';
  return `<div class="rx-badges">${b.map(x=>`<span class="rx-badge">${esc(x)}</span>`).join('')}</div>`;
}
let rxRowId=null;
let rxStateValue='OPEN';
function rxStateMark(state){
  const cls=String(state||'OPEN').toLowerCase();
  return `<span class="rx-state-mark ${esc(cls)}">${state==='DONE'?'✓':''}</span>`;
}
function setRxState(state){
  rxStateValue=LOG_STATES.includes(state)?state:'OPEN';
  const labelEl=$('rx-state-label'), mark=$('rx-state-mark'), menu=$('rx-state-menu');
  if(labelEl) labelEl.textContent=rxStateValue;
  if(mark){ mark.className='rx-state-mark '+rxStateValue.toLowerCase(); mark.textContent=rxStateValue==='DONE'?'✓':''; }
  if(menu) menu.querySelectorAll('.rx-state-option').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.state===rxStateValue)));
}
function prepareRxState(state){
  const menu=$('rx-state-menu');
  if(menu) menu.innerHTML=LOG_STATES.map(s=>
    `<button type="button" class="rx-state-option" role="option" data-state="${s}">${rxStateMark(s)}<span>${s}</span></button>`).join('');
  setRxState(state);
}
function closeRxState(){
  const menu=$('rx-state-menu'), btn=$('rx-state-btn');
  if(menu) menu.hidden=true;
  if(btn) btn.setAttribute('aria-expanded','false');
}
let rxSelectMenu=null, rxSelectSource=null, rxSelectButton=null;
let rxLocationOpen=null;
function rxSelectLabel(select){
  const option=select.options[select.selectedIndex];
  return option&&option.textContent.trim()?option.textContent.trim():'—';
}
function closeRxSelect(){
  if(rxSelectMenu) rxSelectMenu.hidden=true;
  if(rxSelectButton) rxSelectButton.setAttribute('aria-expanded','false');
  rxSelectSource=null; rxSelectButton=null;
}
function closeRxLocation(){
  if(!rxLocationOpen) return;
  rxLocationOpen.menu.hidden=true;
  rxLocationOpen.box.classList.remove('is-open');
  rxLocationOpen.button.setAttribute('aria-expanded','false');
  rxLocationOpen.input.setAttribute('aria-expanded','false');
  rxLocationOpen=null;
}
document.addEventListener('mousedown',event=>{
  if(rxLocationOpen&&!rxLocationOpen.box.contains(event.target)) closeRxLocation();
});
function ensureRxSelectMenu(){
  if(rxSelectMenu) return;
  rxSelectMenu=document.createElement('div');
  rxSelectMenu.className='rx-select-menu';
  rxSelectMenu.setAttribute('role','listbox');
  rxSelectMenu.hidden=true;
  document.body.appendChild(rxSelectMenu);
  const choose=e=>{
    const remove=e.target.closest('.rx-select-delete[data-value]');
    if(remove&&rxSelectSource?.dataset.rxSelect==='prefix'){
      e.preventDefault(); e.stopPropagation();
      const select=rxSelectSource, button=rxSelectButton, value=remove.dataset.value;
      if(removePrefix(value)){
        const option=[...select.options].find(item=>item.value===value);
        if(option) option.remove();
        if(select.value===value) select.value='';
        closeRxSelect();
        openRxSelect(select,button);
      }
      return;
    }
    const option=e.target.closest('.rx-select-option[data-index]');
    if(!option||!rxSelectSource) return;
    e.preventDefault();
    const select=rxSelectSource, button=rxSelectButton;
    select.dataset.rxPreviousValue=select.value;
    select.selectedIndex=Number(option.dataset.index);
    select.dispatchEvent(new Event('change',{bubbles:true}));
    button.querySelector('span').textContent=rxSelectLabel(select);
    closeRxSelect();
    button.focus();
  };
  rxSelectMenu.addEventListener('mousedown',choose);
  rxSelectMenu.addEventListener('click',choose);
  rxSelectMenu.addEventListener('keydown',e=>{
    const options=[...rxSelectMenu.querySelectorAll('.rx-select-option')], current=options.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();
      options[(current+(e.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus();
    }else if(e.key==='Escape'){
      e.preventDefault(); e.stopPropagation();
      const button=rxSelectButton; closeRxSelect(); button?.focus();
    }else if(e.key.length===1&&/[a-z0-9]/i.test(e.key)){
      /* Type-ahead: jump to the first option starting with the pressed key;
         pressing it again cycles through the rest. Lets the ~200-country list
         be navigated by letter, the way a native <select> does. */
      e.preventDefault();
      const k=e.key.toLowerCase();
      const matches=options.filter(o=>(o.textContent||'').trim().toLowerCase().startsWith(k));
      if(matches.length){
        const at=matches.indexOf(document.activeElement);
        const next=matches[(at+1)%matches.length];
        next.focus(); next.scrollIntoView({block:'nearest'});
      }
    }
  });
}
function openRxSelect(select,button){
  ensureRxSelectMenu();
  if(rxSelectSource===select&&!rxSelectMenu.hidden){ closeRxSelect(); return; }
  closeRxState(); closeRxSelect();
  rxSelectSource=select; rxSelectButton=button;
  const removablePrefixes=new Set(customPrefixes().filter(value=>!PREFIXES.includes(value)));
  rxSelectMenu.innerHTML=[...select.options].map((option,index)=>{
    const choice=`<button type="button" class="rx-select-option${[SOCIAL_ADD_PLATFORM,REFERENCE_ADD,PREFIX_ADD,ROLE_ADD,TYPE_ADD,SUBJECT_ADD,NOTE_SUBJECT_ADD,CITY_ADD,DISTRICT_ADD,COMPANY_ADD,TAG_ADD].includes(option.value)?' add-command':''}" role="option" data-index="${index}" aria-selected="${option.selected}">${esc(option.textContent.trim()||'—')}</button>`;
    return select.dataset.rxSelect==='prefix'&&removablePrefixes.has(option.value)
      ? `<div class="rx-select-row">${choice}<button type="button" class="rx-select-delete" data-value="${esc(option.value)}" aria-label="Delete ${esc(option.value)}" title="Delete">×</button></div>`
      : choice;
  }).join('');
  // For the Quick-notes subject combobox the trigger is a slim chevron, but the
  // menu should drop down across the whole field — so anchor it to the framed
  // row when the button lives inside one; every other select anchors to itself.
  const r=(button.closest('.rx-notes-subject-row')||button).getBoundingClientRect();
  const width=Math.max(r.width,150), menuHeight=Math.min(220,select.options.length*32);
  rxSelectMenu.style.width=Math.min(width,window.innerWidth-16)+'px';
  rxSelectMenu.style.left=Math.max(8,Math.min(r.left,window.innerWidth-width-8))+'px';
  rxSelectMenu.style.top=(r.bottom+menuHeight+8<=window.innerHeight?r.bottom+4:Math.max(8,r.top-menuHeight-4))+'px';
  rxSelectMenu.hidden=false;
  button.setAttribute('aria-expanded','true');
  const selected=rxSelectMenu.querySelector('[aria-selected="true"]')||rxSelectMenu.querySelector('.rx-select-option');
  selected?.scrollIntoView({block:'nearest'}); selected?.focus();
}
function enhanceRxSelect(select){
  if(select.dataset.rxEnhanced){
    const button=select._rxButton;
    if(button) button.querySelector('span').textContent=rxSelectLabel(select);
    return;
  }
  select.dataset.rxEnhanced='1';
  select.classList.add('rx-native-select');
  const button=document.createElement('button');
  button.type='button';
  button.className='rx-select-btn'+(select.id==='rx-copy'?' rx-copy-btn':'');
  button.setAttribute('aria-haspopup','listbox');
  button.setAttribute('aria-expanded','false');
  button.innerHTML=`<span>${esc(rxSelectLabel(select))}</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m2.5 4.5 3.5 3 3.5-3"/></svg>`;
  button.addEventListener('click',()=>openRxSelect(select,button));
  select.insertAdjacentElement('afterend',button);
  select._rxButton=button;
}
function enhanceRxLocationSelect(select){
  if(select.dataset.rxLocationEnhanced) return;
  select.dataset.rxLocationEnhanced='1';
  select.classList.add('rx-native-select');
  const box=document.createElement('div');
  box.className='rx-location-combobox';
  const input=document.createElement('input');
  input.type='text'; input.className='rx-location-input'; input.autocomplete='off';
  input.placeholder=select.dataset.rxSelect==='country'?'Type/select country':`Type/select ${select.dataset.rxSelect}`;
  input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-expanded','false');
  const button=document.createElement('button');
  button.type='button'; button.className='rx-location-toggle'; button.tabIndex=-1;
  button.setAttribute('aria-label',`Show ${select.dataset.rxSelect} options`);
  button.innerHTML='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m2.5 4.5 3.5 3 3.5-3"/></svg>';
  const menu=document.createElement('div');
  menu.className='rx-location-dropdown'; menu.hidden=true; menu.setAttribute('role','listbox');
  box.append(input,button,menu); select.insertAdjacentElement('afterend',box);
  const sync=()=>{ input.value=select.value||''; };
  select._rxLocationSync=sync; sync();
  let isFiltering=false;
  const matches=()=>{
    const query=isFiltering?input.value.trim().toLocaleLowerCase():'';
    return [...select.options].filter(option=>option.value)
      .filter(option=>!query||option.textContent.trim().toLocaleLowerCase().includes(query));
  };
  const render=()=>{
    const options=matches();
    menu.innerHTML=options.length?options.map(option=>
      `<button type="button" class="rx-location-option${option.value.startsWith('__')?' add-command':''}" role="option" data-value="${esc(option.value)}" aria-selected="${option.value===select.value}">${esc(option.textContent.trim())}</button>`
    ).join(''):'<div class="rx-location-empty">No matching options</div>';
  };
  const selectValue=value=>{
    const existing=[...select.options].find(option=>option.value.toLocaleLowerCase()===value.toLocaleLowerCase());
    if(!existing&&value){ select.add(new Option(value,value)); }
    select.value=existing?existing.value:value;
    isFiltering=false; sync(); select.dispatchEvent(new Event('change',{bubbles:true})); closeRxLocation();
  };
  const open=()=>{
    if(rxLocationOpen?.box===box){ closeRxLocation(); return; }
    closeRxState(); closeRxSelect(); closeRxLocation(); render();
    menu.hidden=false; box.classList.add('is-open'); button.setAttribute('aria-expanded','true');
    input.setAttribute('aria-expanded','true'); rxLocationOpen={box,menu,button,input};
  };
  input.addEventListener('focus',open);
  input.addEventListener('input',()=>{ isFiltering=true; render(); if(menu.hidden) open(); });
  input.addEventListener('change',()=>selectValue(input.value.trim()));
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'){ event.preventDefault(); closeRxLocation(); }
    if(event.key==='Enter'){ const first=matches()[0]; if(first){ event.preventDefault(); selectValue(first.value); } }
    if(event.key==='ArrowDown'){ event.preventDefault(); open(); menu.querySelector('.rx-location-option')?.focus(); }
  });
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',()=>{
    if(rxLocationOpen?.box===box) closeRxLocation();
    else {
      input.focus();
      if(rxLocationOpen?.box!==box) open();
    }
  });
  menu.addEventListener('mousedown',event=>event.preventDefault());
  menu.addEventListener('click',event=>{
    const option=event.target.closest('.rx-location-option'); if(option) selectValue(option.dataset.value);
  });
}
function enhanceRxSelects(){
  $('rx').querySelectorAll('select[data-rx-select="country"],select[data-rx-select="district"],select[data-rx-select="city"]').forEach(enhanceRxLocationSelect);
  $('rx').querySelectorAll('select:not(.rx-native-select)').forEach(enhanceRxSelect);
  $('rx').querySelectorAll('select.rx-native-select:not([data-rx-location-enhanced])').forEach(enhanceRxSelect);
}
/* Push a quick-pick into the free-text Quick-notes Subject. The 'input' event is
   what the Quill mount wired to syncHidden(), so this also updates the saved
   description. Defined here so the rx-body change handler can call it. */
function applyNoteSubject(text){
  const s=document.getElementById('rx-notes-subject');
  if(!s) return;
  s.value=text;
  s.dispatchEvent(new Event('input',{bubbles:true}));
}
function addRxSocialRow(){
  const list=$('rx-social-list');
  if(!list) return;
  list.insertAdjacentHTML('beforeend',`<div class="rx-social">
    <select class="rx-in" data-nosave data-social-platform>${socialOptionsHTML()}</select>
    <input class="rx-in" data-nosave placeholder="@handle">
    <button type="button" class="rx-social-remove" aria-label="Remove social handle" title="Remove handle">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 4.5l7 7m0-7-7 7"/></svg>
    </button></div>`);
  const row=list.lastElementChild;
  enhanceRxSelect(row.querySelector('select'));
  requestAnimationFrame(()=>row.querySelector('input').focus());
}

function rxFieldHTML(c,r){
  const v=c.edit&&c.edit.val?String(c.edit.val(r)??''):'';
  const id='rx-'+c.k;
  const attrs=`id="${id}" data-k="${c.k}"`;
  let control;
  if(RX_LONG.has(c.k)) control=`<textarea ${attrs}>${esc(v)}</textarea>`;
  else if(c.edit&&c.edit.kind==='date') control=`<input type="date" ${attrs} value="${esc(v)}">`;
  else if(c.edit&&['status','type','category','prefix','role','subject','district','city','country'].includes(c.edit.kind)){
    // Same option sets the grid's popup uses, so the two cannot disagree —
    // minus the "＋ Add new…" sentinel, which is a command, not a value. In a
    // real <select> it is directly selectable and would be saved as a prefix.
    const opts=(selectPopupChoices(c.edit.kind)||[]).filter(o=>{const v=(typeof o==='string'?o:o.value);return v!==PREFIX_ADD&&v!==TYPE_ADD;});
    control=`<select ${attrs}>${opts.map(o=>{
      const val=typeof o==='string'?o:o.value; const lab=typeof o==='string'?label(o):(o.label||label(o.value));
      return `<option value="${esc(val)}"${String(val)===String(v)?' selected':''}>${esc(lab)}</option>`;}).join('')}</select>`;
  }
  else control=`<input type="text" ${attrs} value="${esc(v)}">`;
  return `<div class="rx-f"><label for="${id}">${esc(c.h)}</label>${control}<span class="rx-note" id="${id}-note"></span></div>`;
}

function rxMapHTML(r){
  const url=r.maps_url?normalizeMapsUrl(r.maps_url):null;
  if(!url) return '<div class="rx-none">No map link on this row.</div>';
  const c=mapsCoords(url);
  if(!c) return `<div class="rx-none">Preview unavailable for this link.</div><a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`;
  // Tiles as <img>, never an embed iframe: the CSP allows https images but
  // blocks third-party frames, so an embed renders blank. See tileMap().
  return `<div class="rx-map"><div class="mapwrap" id="rx-mapwrap"></div>`
    +`<a href="${esc(url)}" target="_blank" rel="noreferrer">Open in Google Maps</a></div>`;
}

function openExpandedRow(explicitId){
  if(deletedView) return;   // deleted rows are read-only — no edit popup, no blank-create
  // With a row selected (or an explicit id from "Save & continue"), edit it.
  // Without one, open blank and CREATE on save — rxRowId === null is the flag
  // the save path reads to tell edit from create.
  const id=explicitId||selectedLogId();
  const r=id?ROWS.find(x=>x.id===id):null;
  rxRowId=r?id:null;
  const isNew=!r;
  const src=r||{};   // empty object -> every field renders blank
  // Title is set to the log number further down (was "Add Log"/"Log Details").
  $('rx-sub').textContent=r?'view or update this call log':'fill while you’re on the call — everything prices itself live';

  /* Laid out to the Add Log mockups. Fields whose model column exists carry
     data-k and save through the normal path; the rest are marked data-nosave
     and are visual only until they have a column, so the design is reviewable
     now without inventing fields the API would reject. */
  const opt=(list,v,blank)=>((blank?['']:[]).concat(list)).map(o=>
    `<option value="${esc(o)}"${String(o)===String(v||'')?' selected':''}>${esc(
        o===TYPE_ADD?'+ Add New':o===PREFIX_ADD?'+ Add New':o===COMPANY_ADD?'+ Add New':o===CITY_ADD?'+ Add City':o===ROLE_ADD?'＋ Add Role':o===TAG_ADD?'＋ Add Tag':o===NOTE_SUBJECT_ADD?'+ Add New':o===SUBJECT_ADD||o===REFERENCE_ADD?'＋ Add New':(o||'—'))}</option>`).join('');
  const F=(lab,ctl,req)=>`<div><label class="rx-l">${esc(lab)}${req?' <span class="req">*</span>':''}</label>${ctl}</div>`;

  const IN=(k,ph,v,ns)=>`<input class="rx-in" ${ns?'data-nosave':`data-k="${k}"`} placeholder="${esc(ph||'')}" value="${esc(v??'')}">`;
  const SEL=(k,list,v,blank,ns)=>`<select class="rx-in" id="rx-${k}" data-rx-select="${k}" ${ns?'data-nosave':`data-k="${k}"`}>${opt(list,v,blank)}</select>`;
  const GEOSEL=(k,list,v,placeholder)=>{
    const values=[...(list||[])];

    /* Preserve an existing/custom value even when it is not currently present
      in the predefined/backend option list. */
    if(v && !values.includes(v)){
      values.unshift(v);
    }

    return `
      <div class="rx-geo-combo">
        <input
          type="text"
          class="rx-in rx-geo-input"
          data-k="${k}"
          data-geo-input="${k}"
          value="${esc(v||'')}"
          placeholder="${esc(placeholder||'')}"
          autocomplete="off"
        >
        ${SEL(k,values,v,true,true)}
      </div>
    `;
  };
  const g=(cls,...f)=>`<div class="rx-grid ${cls}">${f.join('')}</div>`;
  const DIRECT={role:'role',company_type:'company_type',subject:'subject',no:'site_number',bldg:'site_building',floor:'site_floor'};
  const val=k=>{ if(k==='reference') return src.reference||''; if(DIRECT[k]) return src[DIRECT[k]]||''; const c=COLS.find(x=>x.k===k&&x.edit); return c?c.edit.val(src):''; };
  const countryValue=isNew ? (val('country')||'Lebanon') : val('country');
  const districtValue=val('district');
  const cityValue=val('city');
  let html='';
  html+=g('rx-g4',
    F('Pre',        SEL('prefix',[...allPrefixes(),PREFIX_ADD],val('prefix'),true)),
    F('First name', IN('first','Type or pick...',val('first')),true),
    F('Last name',  IN('last','Type or pick...',val('last'))),
    F('Role',       SEL('role',[...allRoles(),ROLE_ADD],val('role'),true)));
  html+=g('rx-gc',
    F('Phone / WhatsApp', rxPhoneListHTML(rxExistingPhones(src))+`<button type="button" class="rx-add-related" id="rx-add-related">+ Add Contact Person</button>`),
    F('Email',            rxEmailListHTML(rxExistingEmails(src))),
    F('Company',          IN('company','Type or pick',val('company'))),
    F('Company type',     SEL('company_type',[...new Set([val('company_type'),...allCompanyTypes()].filter(Boolean)),COMPANY_ADD],val('company_type'),true)));
  // Additional contact people — a full-width block under the contact row, filled
  // by "+ Add Contact Person". Hidden until it has at least one person.
  const relatedRows=rxRelatedRowsHTML(rxExistingRelated(src));
  html+=`<div class="rx-related-wrap${relatedRows?'':' rx-related-empty'}" id="rx-related-wrap"><label class="rx-l">Additional contacts</label><div class="rx-related-list" id="rx-related-list">${relatedRows}</div></div>`;
  let savedSocials=[]; try{ savedSocials=JSON.parse(src.socials||'[]')||[]; }catch(e){}
  const socialRow=(plat,handle)=>`<div class="rx-social"><select class="rx-in" data-nosave data-social-platform>${socialOptionsHTML(plat||'IG')}</select>`
    +`<input class="rx-in" data-nosave placeholder="@handle" value="${esc(handle||'')}"></div>`;
  const socialRows=(savedSocials.length?savedSocials:[{platform:'',handle:''}]).map(s=>socialRow(s.platform,s.handle)).join('');
  const socialHandles=`<div><label class="rx-l">Social handles</label><div class="rx-social-list" id="rx-social-list">${socialRows}</div>
    <button type="button" class="rx-add-handle" id="rx-add-handle">+ Add Handle</button></div>`;
  html+=g('rx-g2',socialHandles,
    F('Reference',SEL('reference',[...allReferences(),REFERENCE_ADD],val('reference'),true)));
  html+=g('rx-g2',
  F('Log type', SEL('type',[...allTypes(val('type')),TYPE_ADD],val('type'),true)),
  // One OR MORE tags — click to open a checkbox dropdown.
  F('Tags', `<input class="rx-in rx-tags-input" id="rx-tags" data-k="tags" data-select-value="${esc(val('tags'))}" value="${esc(val('tags'))}" placeholder="Select tags…" readonly>`));
  const gpsButton=`<button type="button" class="rx-use-location" id="rx-use-location" title="Use this device's current location"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.5C5.51 1.5 3.5 3.51 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.49-2.01-4.5-4.5-4.5zm0 6.1a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z" fill="currentColor"/></svg><span>Use My Current Location</span></button>`;
  const siteCountry=isNew?'Lebanon':val('country');
  html+=`<div class="rx-fs"><h4>Site info</h4>`
    +`<div class="rx-mapfield">${F('Google maps link',`<div class="rx-map-input-row">${IN('maps','https://maps.app.goo.gl/…',val('maps'))}${gpsButton}</div><div class="rx-location-status" id="rx-location-status" role="status"></div>`)}`
    +`<div class="rx-mapprev" id="rx-mapprev" hidden></div></div>`
    +g('rx-g3',
        F('Country',
          GEOSEL('country',COUNTRY_NAMES,countryValue,'Type or select country')),
        F('District',
          GEOSEL('district',districtOptions(countryValue),districtValue,'Type or select district')),
        F('City',
          GEOSEL('city',cityOptions(countryValue,districtValue),cityValue,'Type or select city')))
    +g('rx-g4', F('Street',   IN('street','Street name',val('street'))),
                F('No.',      IN('no','12',val('no'))),
                F('Building', IN('bldg','Bldg',val('bldg'))),
                F('Floor',    IN('floor','GF',val('floor'))))
    +`</div>`;
  html+=`<div class="rx-notes">
    <div class="rx-notes-head" id="rx-notes-head">
  <h4>Quick notes — no time? dump everything here</h4>

  <button type="button"
          class="rx-notes-attach-btn"
          id="rx-notes-attach-btn">
    <svg viewBox="0 0 24 24"
         fill="none"
         stroke="currentColor"
         stroke-width="2"
         stroke-linecap="round"
         stroke-linejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
    </svg>
    Attach file
  </button>
</div>
    <div class="rx-notes-subject-row">
      <input type="text" class="rx-notes-subject" id="rx-notes-subject" placeholder="Subject…" maxlength="200" autocomplete="off">
      ${SEL('notesubject',[...allNoteSubjects(),NOTE_SUBJECT_ADD],'',true,true)}
    </div>
    <input type="file" id="rx-notes-file-input" multiple style="display:none">
    <div class="rx-notes-dropzone" id="rx-notes-dropzone">
      <div id="quill-desc-editor"></div>
      <div id="quill-desc-toolbar">
        <button class="ql-bold"></button>
        <button class="ql-italic"></button>
        <button class="ql-underline"></button>
        <button class="ql-strike"></button>
        <button class="ql-list" value="ordered"></button>
        <button class="ql-list" value="bullet"></button>
        <button class="ql-blockquote"></button>
        <button class="ql-clean"></button>
      </div>
    </div>
    <input type="hidden" data-k="desc" id="quill-desc-hidden" value="${esc(val('desc'))}">
  </div>
  <div class="rx-attach" id="rx-attach-section" style="display:none">
    <h4>Attachments</h4>
    <div class="rx-notes-files" id="rx-notes-files"></div>
  </div>`;
  // Attachments & drawing and Cost estimate were deliberately removed earlier;
  // Quick notes (above, with its own Attach file) is the last section. Alfred's
  // quick-notes patch reintroduced those two blocks here — kept out on purpose.
  /* Header and footer picklists. The state and copy-to values have no column
     yet, so they are presentational — the log still saves through the normal
     path and nothing is silently dropped, because they are never sent. */
  const fill=(id,list)=>{ const el=$(id); if(el) el.innerHTML=list.map(o=>`<option>${esc(o)}</option>`).join(''); };
  const currentState=String(r&&r.status||'OPEN').toUpperCase();
  prepareRxState(currentState);
  fill('rx-copy',COPY_TARGETS);
  /* Save button follows the copy-to target: "Save Log" when the log stays put,
     otherwise "Save & copy to <target>". CRM's option reads "CRM — new deal"; the
     button says just "CRM". The copy-to select sits in the static footer, outside
     rx-body, so its change is bound here rather than on the body handler. */
  const updateSaveLabel=()=>{
    const v=($('rx-copy')&&$('rx-copy').value)||'Log only';
    const btn=$('rx-save'); if(!btn) return;
    btn.textContent=v==='Log only'?'Save Log':'Save & copy to '+(v==='CRM — new deal'?'CRM':v);
  };
  if($('rx-copy')&&!$('rx-copy').dataset.saveLabelWired){
    $('rx-copy').dataset.saveLabelWired='1';
    $('rx-copy').addEventListener('change',updateSaveLabel);
  }
  updateSaveLabel();
  const rowIndex=r?ROWS.findIndex(row=>row.id===r.id):-1;
  // Show the log number AS the title (replacing "Add Log"), and hide the now
  // redundant "Log #…" chip that used to sit beside it.
  $('rx-title').textContent=`Log #${r&&rowIndex>=0?ROWS.length-rowIndex:ROWS.length+1}`;
  const rxNum=$('rx-num'); if(rxNum) rxNum.style.display='none';
  const whenDate=new Date(r&&r.created_at?r.created_at:Date.now());
  const w=$('rx-when');
  if(w){
    const p=n=>String(n).padStart(2,'0');
    w.value=`${whenDate.getFullYear()}-${p(whenDate.getMonth()+1)}-${p(whenDate.getDate())}T${p(whenDate.getHours())}:${p(whenDate.getMinutes())}`;
    $('rx-when-label').textContent=fmtHeaderDT(whenDate);
  }
  /* A native <select> has no pick hook to intercept, so "＋ Add new…" is caught
     on change: prompt, store, then replace the sentinel with the new value.
     Cancelling restores the previous selection, so the sentinel can never be
     the value that gets saved. */
  setTimeout(()=>{ const sel=$('rx-body').querySelector('select[data-k="type"]'); if(!sel) return;
    let last=sel.value;
    sel.addEventListener('change',()=>{
      if(sel.value!==TYPE_ADD){ last=sel.value; return; }
      const added=addType();
      if(added){ if(![...sel.options].some(o=>o.value===added)) sel.add(new Option(added,added),sel.options.length-1);
                 sel.value=added; last=added; }
      else sel.value=last;
    });
  },0);
  $('rx-body').innerHTML=html;
  enhanceRxSelects();
  wireGeoManualInputs();
  rxRenumberPersons();
  $('rx').hidden=false;

  // Tiles need the real width, which only exists once the sheet is laid out.
  rxUpdateMapPreview();   // render for any link already on the row
  $('rx-body').scrollTop=0;
}

/* Live preview under the Google-maps field. Reads the maps input, and if the
   link resolves to coordinates, draws OSM tiles below it; otherwise hides. */
let rxMapReq=0, rxMapTimer=null;
function rxDrawMap(box,url,c){
  box.hidden=false;
  box.innerHTML=`<div class="mapwrap">${tileMap(c.lat,c.lng,box.clientWidth||500,200,15)}</div>`
    +`<a href="${esc(url)}" target="_blank" rel="noreferrer">Open in Google Maps</a>`;
}
function rxGeoNorm(value){
  return String(value||'').toLowerCase()
    .replace(/\b(governorate|province|district|region|county|state)\b/g,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
}
function rxGeoChoice(value,options){
  if(!value) return '';
  const wanted=rxGeoNorm(value);
  return (options||[]).find(option=>rxGeoNorm(option)===wanted)||value;
}
function rxFillGeocoded(id,options,value){
  if(!value) return;
  const selected=rxGeoChoice(value,options);
  const commands=(options||[]).filter(option=>String(option).startsWith('__add_'));
  const list=(options||[]).filter(option=>!commands.includes(option));
  if(!list.includes(selected)) list.push(selected);
  rxFillSelect(id,[...list,...commands],selected);
}
function rxApplyGeocodedAddress(data){
  if(data.country){
    rxFillGeocoded('country',GEO_COUNTRIES,data.country);
    const country=$('rx-country')?.value||data.country;
    if(data.district){
      rxFillGeocoded('district',districtsFor(country)||[],data.district);
      const district=$('rx-district')?.value||data.district;
      if(data.city) rxFillGeocoded('city',cityOptions(country,district),data.city);
    }else if(data.city){
      rxFillGeocoded('city',[],data.city);
    }
  }
  const street=$('rx-body').querySelector('[data-k="street"]');
  if(street&&data.street) street.value=data.street;
}
function rxUseCurrentLocation(){
  const button=$('rx-use-location'),statusEl=$('rx-location-status');
  const input=$('rx-body').querySelector('input[data-k="maps"]');
  if(!button||!statusEl||!input)return;
  const finish=(message,kind)=>{
    button.disabled=false;
    button.querySelector('span').textContent='Use My Current Location';
    statusEl.textContent=message;
    statusEl.className='rx-location-status'+(kind?' '+kind:'');
  };
  if(!window.isSecureContext){finish('Current location requires HTTPS or localhost.','bad');return;}
  if(!navigator.geolocation){finish('Current location is not supported by this browser.','bad');return;}
  button.disabled=true;
  button.querySelector('span').textContent='Getting location…';
  statusEl.textContent='Allow location access and wait for your position…';
  statusEl.className='rx-location-status';
  navigator.geolocation.getCurrentPosition(position=>{
    const {latitude:lat,longitude:lng,accuracy}=position.coords;
    if(!Number.isFinite(lat)||!Number.isFinite(lng)){
      finish('The device returned an invalid location. Please try again.','bad');
      return;
    }
    input.value=`https://www.google.com/maps?q=${lat.toFixed(7)},${lng.toFixed(7)}`;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    const metres=Number.isFinite(Number(accuracy))?Math.round(accuracy):null;
    finish(`Location added${metres===null?'':` — accuracy about ${metres} m`}. Check the map preview before saving.`,'ok');
  },error=>{
    if(error.code===1)finish('Location permission was denied. Allow it in browser settings and try again.','bad');
    else if(error.code===3)finish('Location request timed out. Check Windows location services and try again.','bad');
    else finish('Your device could not determine its location.','bad');
  },{enableHighAccuracy:true,timeout:20000,maximumAge:0});
}
function rxUpdateMapPreview(){
  const box=$('rx-mapprev'); if(!box) return;
  const inp=$('rx-body').querySelector('[data-k="maps"]');
  const raw=(inp&&inp.value||'').trim();
  const url=raw?normalizeMapsUrl(raw):'';
  clearTimeout(rxMapTimer);
  const req=++rxMapReq;                 // newest input wins any in-flight resolve
  if(!url){ box.hidden=true; box.innerHTML=''; return; }
  // Full links carry coordinates — draw immediately, no server round-trip.
  const inline=mapsCoords(url);
  if(inline) rxDrawMap(box,url,inline);
  // The backend resolves short links and reverse-geocodes both short and full
  // links. Debounced so pasting/typing does not hammer either provider.
  else { box.hidden=false; box.innerHTML='<div class="rx-map-load">Loading preview…</div>'; }
  rxMapTimer=setTimeout(async()=>{
    try{
      const c=await api('/resolve-maps?url='+encodeURIComponent(url));
      if(req!==rxMapReq) return;        // superseded — drop this result
      rxDrawMap(box,url,c);
      rxApplyGeocodedAddress(c);
    }catch(_){
      if(req!==rxMapReq) return;
      box.hidden=false;
      box.innerHTML=`<div class="rx-map-load">Preview not available — <a href="${esc(url)}" target="_blank" rel="noreferrer">open in Google Maps</a></div>`;
    }
  },450);
}
/* Collect the sheet's fields into the {person, site, log} shape POST /logs/
   expects — the same shape draftPayload builds for the grid's own rows, so a
   new entry made here is indistinguishable from one typed into the table. */
// Social handles are a repeatable list (no single data-k), so collect them by row.
function rxCollectSocials(){
  const list=$('rx-social-list');
  return (list?[...list.querySelectorAll('.rx-social')]:[]).map(row=>({
    platform:(row.querySelector('[data-social-platform]')?.value||'').trim(),
    handle:(row.querySelector('input')?.value||'').trim()
  })).filter(s=>s.handle);
}
// Popup fields with no COLS/inline-edit entry (role, company type, log subject,
// social handles, address no/bldg/floor). rxSave only knows COLS fields, so on
// EDIT these are saved here straight to the file. Read by data-k (IN inputs have
// no id). See rxSaveAll.
const rxExtraCur=k=>{ const el=$('rx-body').querySelector('[data-k="'+k+'"]'); return el?String(el.value||'').trim():''; };
/* ── Phone numbers: a repeatable "Add Number" list. Saved to the contact's
   shared achi_contact_info bucket, so the log popup and the Contacts page edit
   the SAME numbers on the SAME record. Mirrors the Contacts editor (label +
   country code + number), reusing the popup's own tel-cc / contactPhoneParts. */
const PHONE_LABELS=['Primary','Mobile','WhatsApp','Office','Site','Home','Other'];
let rxPhoneSeq=0;
const nextPhoneId=()=>'rx-phone-'+(++rxPhoneSeq);
function rxPhoneOptions(sel){
  const list=PHONE_LABELS.includes(sel)?PHONE_LABELS:[sel,...PHONE_LABELS];
  return list.map(l=>`<option value="${esc(l)}"${l===sel?' selected':''}>${esc(l)}</option>`).join('');
}
function rxPhoneRow(phone,removable){
  const parts=contactPhoneParts((phone&&phone.number)||'');
  const label=(phone&&phone.label)||'Mobile';
  const id=nextPhoneId();
  return `<div class="rx-phone-row" data-rx-phone-row>`
    +`<select class="rx-in rx-phone-label" data-rx-phone-label aria-label="Number type">${rxPhoneOptions(label)}</select>`
    +`<span class="tel-wrap"><button type="button" class="tel-cc" data-rx-phone="${id}" aria-label="Choose country code" title="Country code"><img src="${flagSrc(parts.iso)}" alt=""><span class="cc">${esc(parts.dial)}</span>${SVG.chev}</button>`
    +`<input class="rx-in tel-num rx-phone-num" id="${id}" data-rx-tel inputmode="tel" autocomplete="tel-national" placeholder="70 123 456" value="${esc(parts.mobilenum)}"></span>`
    +`<button type="button" class="rx-phone-remove" data-rx-phone-remove aria-label="Remove number" title="Remove number"${removable?'':' hidden'}>&times;</button>`
  +`</div>`;
}
function rxPhoneListHTML(phones){
  const list=(phones&&phones.length)?phones:[{label:'Mobile',number:''}];
  return `<div class="rx-phone-list" id="rx-phone-list">${list.map((p,i)=>rxPhoneRow(p,i>0)).join('')}</div>`
    +`<button type="button" class="rx-add-phone" id="rx-add-phone">+ Add Number</button>`;
}
/* Numbers to seed the popup with: the row's labelled list, else its single number. */
function rxExistingPhones(src){
  if(src&&Array.isArray(src.phones)&&src.phones.length) return src.phones;
  const m=src&&(src.mobile||'');
  return m?[{label:'Mobile',number:m}]:[];
}
/* Read every non-empty row into [{label, number}] — number is dial + national, the
   same shape the Contacts editor stores. */
function rxCollectPhones(){
  const out=[];
  document.querySelectorAll('#rx-phone-list [data-rx-phone-row]').forEach(row=>{
    const national=(row.querySelector('.rx-phone-num')?.value||'').trim();
    if(!national) return;
    const dial=(row.querySelector('.tel-cc .cc')?.textContent||DEFAULT_DIAL).trim();
    const label=(row.querySelector('[data-rx-phone-label]')?.value||'Mobile').trim()||'Mobile';
    out.push({label,number:`${dial} ${national}`.trim()});
  });
  return out.slice(0,8);
}
function rxFirstInvalidPhone(){
  for(const row of document.querySelectorAll('#rx-phone-list [data-rx-phone-row]')){
    const inp=row.querySelector('.rx-phone-num'); const national=(inp?.value||'').trim();
    if(!national) continue;
    const dial=(row.querySelector('.tel-cc .cc')?.textContent||DEFAULT_DIAL).trim();
    if(!validMobile(`${dial} ${national}`)) return inp;
  }
  return null;
}
function rxPhonesChanged(r){
  const norm=a=>JSON.stringify((a||[]).map(p=>({label:p.label||'Mobile',number:String(p.number||'').trim()})));
  return norm(rxCollectPhones())!==norm(r&&r.phones);
}
async function rxSavePhones(r){
  const phones=rxCollectPhones();
  await api('/files/'+r.file_id+'/contact',{method:'PATCH',body:JSON.stringify({phones})});
  r.phones=phones; r.mobile=phones[0]?phones[0].number:'';
}

/* ── Emails: a repeatable "Add Email" list, saved to the same shared bucket the
   Contacts page uses (primary_email = first). Mirrors the phone list. ── */
const EMAIL_LABELS=['Primary','Work','Personal','Accounts','Sales','Other'];
function rxEmailOptions(sel){
  const list=EMAIL_LABELS.includes(sel)?EMAIL_LABELS:[sel,...EMAIL_LABELS];
  return list.map(l=>`<option value="${esc(l)}"${l===sel?' selected':''}>${esc(l)}</option>`).join('');
}
function rxEmailRow(email,removable){
  const addr=(email&&email.address)||'';
  const label=(email&&email.label)||'Other';
  const showCompose=validEmail(addr)&&addr.trim();
  return `<div class="rx-email-row" data-rx-email-row>`
    +`<select class="rx-in rx-email-label" data-rx-email-label aria-label="Email type">${rxEmailOptions(label)}</select>`
    +`<span class="draft-email"><input class="rx-in rx-email-addr" data-rx-email inputmode="email" autocomplete="email" placeholder="name@company.com" value="${esc(addr)}">`
    +`<button class="draft-compose" type="button" data-rx-compose title="Compose email"${showCompose?'':' hidden'}>${SVG.mail}</button></span>`
    +`<button type="button" class="rx-email-remove" data-rx-email-remove aria-label="Remove email" title="Remove email"${removable?'':' hidden'}>&times;</button>`
  +`</div>`;
}
function rxEmailListHTML(emails){
  const list=(emails&&emails.length)?emails:[{label:'Primary',address:''}];
  return `<div class="rx-email-list" id="rx-email-list">${list.map((e,i)=>rxEmailRow(e,i>0)).join('')}</div>`
    +`<button type="button" class="rx-add-email" id="rx-add-email">+ Add Email</button>`;
}
function rxExistingEmails(src){
  if(src&&Array.isArray(src.emails)&&src.emails.length) return src.emails;
  const e=src&&(src.email||'');
  return e?[{label:'Primary',address:e}]:[];
}
function rxCollectEmails(){
  const out=[];
  document.querySelectorAll('#rx-email-list [data-rx-email-row]').forEach(row=>{
    const address=(row.querySelector('.rx-email-addr')?.value||'').trim();
    if(!address) return;
    const label=(row.querySelector('[data-rx-email-label]')?.value||'Other').trim()||'Other';
    out.push({label,address});
  });
  return out.slice(0,8);
}
function rxFirstInvalidEmail(){
  for(const row of document.querySelectorAll('#rx-email-list [data-rx-email-row]')){
    const inp=row.querySelector('.rx-email-addr'); const address=(inp?.value||'').trim();
    if(address&&!validEmail(address)) return inp;
  }
  return null;
}
function rxEmailsChanged(r){
  const norm=a=>JSON.stringify((a||[]).map(e=>({label:e.label||'Other',address:String(e.address||'').trim()})));
  return norm(rxCollectEmails())!==norm(r&&r.emails);
}
async function rxSaveEmails(r){
  const emails=rxCollectEmails();
  await api('/files/'+r.file_id+'/contact',{method:'PATCH',body:JSON.stringify({emails})});
  r.emails=emails; r.email=emails[0]?emails[0].address:'';
}

/* ── Additional contact people ("+ Add Contact Person"): name + relationship +
   phone, saved to the shared related_contacts bucket = the Contacts page. ── */
/* Each additional contact person is a mini card mirroring the main contact:
   prefix / first / last / role, then phone / email / primary, with a Remove. */
function rxPersonOpts(list,sel){
  return ['',...list].map(o=>`<option value="${esc(o)}"${o===(sel||'')?' selected':''}>${esc(o||'—')}</option>`).join('');
}
/* Legacy {name,tag} entries: show the whole name in first, tag as role. */
function rxPersonFields(rc){
  rc=rc||{};
  let first=rc.first_name||'', last=rc.last_name||'';
  if(!first&&!last&&rc.name){ const p=String(rc.name).trim().split(/\s+/); first=p[0]||''; last=p.slice(1).join(' '); }
  return {prefix:rc.prefix||'', first, last, role:rc.role||rc.tag||'', phone_label:rc.phone_label||'Mobile', phone:rc.phone||'', email:rc.email||'', primary:!!rc.primary};
}
function rxRelatedRow(rc){
  const f=rxPersonFields(rc);
  const parts=contactPhoneParts(f.phone);
  const id=nextPhoneId();
  return `<div class="rx-person" data-rx-related-row>`
    +`<div class="rx-person-head"><span class="rx-person-t" data-rx-person-num>Contact</span>`
      +`<button type="button" class="rx-person-x" data-rx-related-remove aria-label="Remove contact person">&times; Remove</button></div>`
    +`<div class="rx-grid rx-g4">`
      +`<div><label class="rx-l">Pre</label><select class="rx-in" data-rc-prefix>${rxPersonOpts(allPrefixes(),f.prefix)}</select></div>`
      +`<div><label class="rx-l">First name</label><input class="rx-in" data-rc-first maxlength="128" placeholder="Type or pick..." value="${esc(f.first)}"></div>`
      +`<div><label class="rx-l">Last name</label><input class="rx-in" data-rc-last maxlength="128" placeholder="Type or pick..." value="${esc(f.last)}"></div>`
      +`<div><label class="rx-l">Role</label><select class="rx-in" data-rc-role>${rxPersonOpts(allRoles(),f.role)}</select></div>`
    +`</div>`
    +`<div class="rx-grid rx-g-person">`
      +`<div><label class="rx-l">Phone / WhatsApp</label><div class="rx-person-tel">`
        +`<select class="rx-in rx-phone-label" data-rc-phone-label aria-label="Number type">${rxPhoneOptions(f.phone_label)}</select>`
        +`<span class="tel-wrap"><button type="button" class="tel-cc" data-rx-phone="${id}" aria-label="Choose country code" title="Country code"><img src="${flagSrc(parts.iso)}" alt=""><span class="cc">${esc(parts.dial)}</span>${SVG.chev}</button>`
        +`<input class="rx-in tel-num" id="${id}" data-rc-phone data-rx-tel inputmode="tel" autocomplete="tel-national" placeholder="70 123 456" value="${esc(parts.mobilenum)}"></span>`
      +`</div></div>`
      +`<div><label class="rx-l">Email</label><input class="rx-in" data-rc-email inputmode="email" autocomplete="email" placeholder="name@company.com" value="${esc(f.email)}"></div>`
      +`<div><label class="rx-l">Primary?</label><select class="rx-in" data-rc-primary><option value="no"${f.primary?'':' selected'}>No</option><option value="yes"${f.primary?' selected':''}>Yes</option></select></div>`
    +`</div>`
  +`</div>`;
}
function rxRelatedRowsHTML(list){ return (list||[]).map(rxRelatedRow).join(''); }
function rxExistingRelated(src){ return (src&&Array.isArray(src.related_contacts))?src.related_contacts:[]; }
/* Header numbering — the main contact is Contact 1, so these start at 2. Re-run
   after add/remove so the numbers stay contiguous. */
function rxRenumberPersons(){
  document.querySelectorAll('#rx-related-list [data-rx-related-row]').forEach((row,i)=>{
    const t=row.querySelector('[data-rx-person-num]'); if(t) t.textContent='Contact '+(i+2);
  });
}
function rxReadPerson(row){
  const g=s=>row.querySelector(s);
  const first=(g('[data-rc-first]')?.value||'').trim();
  const last=(g('[data-rc-last]')?.value||'').trim();
  const email=(g('[data-rc-email]')?.value||'').trim();
  const national=(g('[data-rc-phone]')?.value||'').trim();
  const dial=(g('.tel-cc .cc')?.textContent||DEFAULT_DIAL).trim();
  return {
    prefix:(g('[data-rc-prefix]')?.value||'').trim()||null,
    first_name:first||null, last_name:last||null,
    role:(g('[data-rc-role]')?.value||'').trim()||null,
    phone_label:(g('[data-rc-phone-label]')?.value||'Mobile').trim(),
    phone:national?`${dial} ${national}`.trim():'',
    email:email||null,
    primary:(g('[data-rc-primary]')?.value==='yes'),
    _first:first,_last:last,_email:email,_national:national,_dial:dial,
  };
}
function rxCollectRelated(){
  const out=[];
  document.querySelectorAll('#rx-related-list [data-rx-related-row]').forEach(row=>{
    const p=rxReadPerson(row);
    if(!p._first&&!p._last&&!p._email&&!p._national) return;      // empty card
    out.push({prefix:p.prefix,first_name:p.first_name,last_name:p.last_name,role:p.role,phone_label:p.phone_label,phone:p.phone||null,email:p.email,primary:p.primary});
  });
  return out.slice(0,8);
}
/* A started card needs at least a name; validate phone/email if given. */
function rxRelatedInvalid(){
  for(const row of document.querySelectorAll('#rx-related-list [data-rx-related-row]')){
    const p=rxReadPerson(row);
    if(!p._first&&!p._last&&!p._email&&!p._national) continue;
    if(!p._first&&!p._last) return {el:row.querySelector('[data-rc-first]'),msg:'Each contact person needs a name.'};
    if(p._email&&!validEmail(p._email)) return {el:row.querySelector('[data-rc-email]'),msg:'Invalid email for a contact person.'};
    if(p._national&&!validMobile(`${p._dial} ${p._national}`)) return {el:row.querySelector('[data-rc-phone]'),msg:'Invalid phone for a contact person.'};
  }
  return null;
}
/* Normalise both sides to compare (ignores phone_label so relabelling alone is
   not treated as a change; folds legacy name/tag). */
function rxPersonKey(e){
  e=e||{}; const f=rxPersonFields(e);
  return {prefix:f.prefix||'',first:f.first||'',last:f.last||'',role:f.role||'',phone:String(f.phone||'').trim(),email:String(f.email||'').trim(),primary:!!f.primary};
}
function rxRelatedChanged(r){
  const norm=a=>JSON.stringify((a||[]).map(rxPersonKey));
  return norm(rxCollectRelated())!==norm(r&&r.related_contacts);
}
async function rxSaveRelated(r){
  const related_contacts=rxCollectRelated();
  await api('/files/'+r.file_id+'/contact',{method:'PATCH',body:JSON.stringify({related_contacts})});
  r.related_contacts=related_contacts;
}
function rxExtrasChanged(r){
  let saved='[]'; try{ saved=JSON.stringify(JSON.parse(r.socials||'[]')); }catch(e){}
  return rxExtraCur('role')!==String(r.role||'')
    || rxExtraCur('company_type')!==String(r.company_type||'')
    || rxExtraCur('no')!==String(r.site_number||'')
    || rxExtraCur('bldg')!==String(r.site_building||'')
    || rxExtraCur('floor')!==String(r.site_floor||'')
    || JSON.stringify(rxCollectSocials())!==saved;
}
async function rxSaveExtras(r){
  const patch={
    lead_role: rxExtraCur('role')||null,
    lead_company_type: rxExtraCur('company_type')||null,
    lead_socials: JSON.stringify(rxCollectSocials()),
    site_number: rxExtraCur('no')||null,
    site_building: rxExtraCur('bldg')||null,
    site_floor: rxExtraCur('floor')||null,
  };
  await api('/files/'+r.file_id,{method:'PATCH',body:JSON.stringify(patch)});
  Object.assign(r,{
  role:patch.lead_role,
  company_type:patch.lead_company_type,
  socials:patch.lead_socials,
  site_number:patch.site_number,
  site_building:patch.site_building,
  site_floor:patch.site_floor
});
}
function rxCollectNew(){
  const v={};
  $('rx-body').querySelectorAll('[data-k]').forEach(el=>{ v[el.dataset.k]=rxFieldValue(el); });
  const socials=rxCollectSocials();
  const first=v.first||'', last=v.last||'', company=v.company||'';
  const isCo=!!company && !first && !last;           // company with no person name -> a company contact
  const mob=(rxCollectPhones()[0]||{}).number||null;   // first number/email seed the contact;
  const eml=(rxCollectEmails()[0]||{}).address||null;  // full lists are saved right after create
  const person=isCo
    ? {is_company:true, company_name:company, company_type:v.company_type||null, mobile:mob, email:eml, socials}
    : {is_company:false, prefix:v.prefix||null, first_name:first||null, last_name:last||null,
       company_name:company||null, role:v.role||null, company_type:v.company_type||null,
       mobile:mob, email:eml, socials};
  const hasSite=v.country||v.district||v.city||v.street||v.maps||v.location||v.no||v.bldg||v.floor;
  const site=hasSite?{country:v.country||'Lebanon', district:v.district||null, city:v.city||null,
    street:v.street||null, maps_url:v.maps||null, site_location:v.location||null,
    site_number:v.no||null, site_building:v.bldg||null, site_floor:v.floor||null}:null;
return {
  person,
  site,
  subject:v.subject||'',
  status:(rxStateValue||'OPEN').toLowerCase(),
  log_type:v.type||'inbound_call',

  // Use selected stage. Only default to Prospect if none exists.
  stage:v.stage || 'prospect',

  category:v.category||null,
  reference:v.reference||null,
  tags:(v.tags&&v.tags!==TAG_ADD)?v.tags:'',
  description:v.desc||'',
  updates:v.updates||'',
  follow_up_date:v.followup||null,
  follow_up_notes:v.funotes||''
};
}

function rxBusy(on){ const a=$('rx-save'),b=$('rx-cancel'); if(a)a.disabled=on; if(b)b.disabled=on; }

async function rxCreateNew(keepOpen){
  const st=$('rx-status');
  const payload=rxCollectNew();
  // A file needs an identity — the same rule the grid enforces before saving.
  if(!(payload.person.first_name||payload.person.last_name||payload.person.company_name)){
    st.textContent='Enter at least a name or company'; st.className='rx-status bad'; return;
  }
  const badEmail=rxFirstInvalidEmail();
  if(badEmail){
    st.textContent='Invalid email'; st.className='rx-status bad'; showInvalidEmail(badEmail); return;
  }
  const badPhone=rxFirstInvalidPhone();
  if(badPhone){
    st.textContent='Invalid phone number'; st.className='rx-status bad'; showInvalidMobile(badPhone); return;
  }
  const badRel=rxRelatedInvalid();
  if(badRel){
    st.textContent=badRel.msg; st.className='rx-status bad'; if(badRel.el) badRel.el.focus(); return;
  }
  rxBusy(true); st.textContent='Saving…'; st.className='rx-status';
  try{
    const res=await api('/logs/',{method:'POST',body:JSON.stringify(payload)});
    const newLogId=res&&res.log&&res.log.id;
    const cs=contactSaveStatus(res);
    st.textContent=cs?'Created — '+cs:'Created'; st.className='rx-status ok';
    // The sheet may close in 700ms — the toast outlives it, so "already
    // exists" is never lost with the sheet.
    if(cs) composeToast(cs,!!res.contact_created);
    await load();                               // pull the new row into the grid
    // Save the full labelled lists onto the just-created contact so every number,
    // email and contact-person lands in the shared achi_contact_info bucket = the
    // Contacts page. One PATCH; only the fields with content are sent.
    const phones=rxCollectPhones(), emails=rxCollectEmails(), related_contacts=rxCollectRelated();
    const nr=ROWS.find(x=>x.id===newLogId);
    if(nr && (phones.length||emails.length||related_contacts.length)){
      const body={};
      if(phones.length) body.phones=phones;
      if(emails.length) body.emails=emails;
      if(related_contacts.length) body.related_contacts=related_contacts;
      try{
        await api('/files/'+nr.file_id+'/contact',{method:'PATCH',body:JSON.stringify(body)});
        nr.phones=phones; nr.mobile=phones[0]?phones[0].number:nr.mobile;
        nr.emails=emails; nr.email=emails[0]?emails[0].address:nr.email;
        nr.related_contacts=related_contacts;
      }catch(_){}                               // the log is already saved; a contact-detail hiccup must not fail creation
    }
    revealSavedRow(newLogId);
    rxBusy(false);
    // Save & continue: reopen on the row we just made so editing carries on,
    // including files/drawing which need a saved log. Plain Save: close.
    if(keepOpen && newLogId && ROWS.find(x=>x.id===newLogId)){ openExpandedRow(newLogId); }
    else setTimeout(closeExpandedRow,700);
  }catch(e){ st.textContent=e.message||'Could not create'; st.className='rx-status bad'; rxBusy(false); }
}


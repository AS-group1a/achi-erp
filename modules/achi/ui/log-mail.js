/* Transient bottom-of-screen toast, styled like the "Log saved" one. `ok=false`
   tints it as a soft warning so a "recorded but not actually delivered" send
   reads differently from a clean success. */
function composeToast(text,ok=true){
  document.querySelector('.save-feedback')?.remove();
  const t=document.createElement('div');
  t.className='save-feedback'; t.setAttribute('role','status'); t.setAttribute('aria-live','polite');
  if(!ok){ t.style.background='#8a5a00'; }
  t.innerHTML=`<span class="save-feedback-mark">${ok?'✓':'!'}</span><span>${esc(text)}</span>`;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),3200);
}
/* POST multipart/form-data (files) with bearer auth + one silent token refresh,
   the FormData twin of api(). Never sets Content-Type — the browser adds the
   multipart boundary itself. Throws Error with .status set for the caller. */
async function apiMultipart(path,formData,retried){
  const r=await fetch(API+path,{method:'POST',headers:{Authorization:'Bearer '+TOKEN},body:formData});
  if(r.status===401){
    if(!retried && await refreshToken()) return apiMultipart(path,formData,true);
    throw Object.assign(new Error('Session expired — open the main app on this host, sign in, then reload.'),{status:401}); }
  const body=await r.json().catch(()=>({}));
  if(!r.ok){ const d=body.detail; throw Object.assign(new Error(Array.isArray(d)?d.map(x=>x.msg).join('; '):(d||('Error '+r.status))),{status:r.status}); }
  return body;
}
/* The compose popup — sends through the shared company mailbox, with the same
   rich-text toolbar and file attach/drag-drop as the Quick Notes box. `ctx`
   optionally carries {log_id,file_id,contact_id} so the sent record ties back
   to the enquiry it was written from. */
function openEmailCompose(email,fromRx=false,ctx={}){
  document.querySelector('.compose')?.remove();
  // Accept one email OR a list (broadcast). Names + "already emailed" flags come
  // from the loaded grid rows (the server sets email_sent per row).
  const recipients=(Array.isArray(email)?email:[email]).map(e=>String(e||'').trim()).filter(Boolean);
  const rowByEmail=e=>ROWS.find(r=>String(r.email||'').toLowerCase()===String(e||'').toLowerCase());
  const nameOf=e=>{ const r=rowByEmail(e); return (r&&(r.contact_name||r.company_name))||e; };
  const alreadySent=recipients.filter(e=>{ const r=rowByEmail(e); return r&&r.email_sent; });
  const panel=document.createElement('section'); panel.className='compose'+(fromRx?' from-rx':''); panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','New Message');
  panel.innerHTML=`<div class="compose-head"><div class="compose-title">${SVG.mail} New Message</div>
      <button class="compose-close" type="button" aria-label="Close message">&times;</button></div>
    <div class="compose-row"><span class="compose-label">To</span><span class="compose-recipients">${recipients.map(e=>`<span class="compose-recipient">${esc(e)}</span>`).join('')}</span></div>
    ${alreadySent.length?`<div class="compose-warn">⚠️ Hey, you already sent to ${esc(alreadySent.map(nameOf).join(', '))}.</div>`:''}
    <div class="compose-row"><span class="compose-label">Subject</span><input class="compose-subject" type="text" placeholder="Subject…"></div>
    <div class="compose-editor-wrap" id="compose-dropzone">
      <div id="compose-quill-editor"></div>
      <div id="compose-quill-toolbar">
        <button class="ql-bold"></button><button class="ql-italic"></button><button class="ql-underline"></button><button class="ql-strike"></button>
        <button class="ql-list" value="ordered"></button><button class="ql-list" value="bullet"></button>
        <button class="ql-blockquote"></button><button class="ql-clean"></button>
      </div>
      <div class="compose-attachments" id="compose-attachments"></div>
    </div>
    <input type="file" id="compose-file-input" multiple style="display:none">
    <div class="compose-foot">
      <button class="compose-send" type="button">Send</button>
      <button class="compose-attach-btn" type="button"><svg viewBox="0 0 16 16"><path d="M13.5 9.5v2a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2"/><polyline points="10.5 5.5 8 3 5.5 5.5"/><line x1="8" y1="3" x2="8" y2="10.5"/></svg>Attach file</button>
      <span class="compose-foot-spacer"></span>
      <button class="compose-mailto" type="button">Open in mail app</button>
    </div>`;
  document.body.appendChild(panel);
  const close=()=>{panel.remove();document.removeEventListener('keydown',onKey);};
  const onKey=e=>{if(e.key==='Escape')close();};
  const subjEl=panel.querySelector('.compose-subject'), sendBtn=panel.querySelector('.compose-send');
  const attWrap=panel.querySelector('#compose-attachments');

  // Rich-text editor (same Quill setup as Quick Notes).
  const quill=new Quill(panel.querySelector('#compose-quill-editor'),{theme:'snow',placeholder:'Write your message…',modules:{toolbar:panel.querySelector('#compose-quill-toolbar')}});

  // Attachments held client-side until Send; each is a File, sent as a real
  // email attachment.
  const atts=[];
  // Image-preview tiles like the Quick-notes attachments (same .att-* styles and
  // the shared openPop/keepPop hover popover). These files aren't uploaded yet,
  // so previews come from a local object URL cached on the File until removed.
  const cImg=f=>/^image\//i.test(f.type||'')||/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name||'');
  const cUrl=f=>{ if(!f.__url) f.__url=URL.createObjectURL(f); return f.__url; };
  const cTile=(f,i)=>{
    const ext=((f.name||'').split('.').pop()||'file').toLowerCase();
    const img=cImg(f);
    const tile=document.createElement('div'); tile.className='att-tile';
    tile.innerHTML=`
      <div class="att-tile-face" title="${esc(f.name)}">
        <div class="att-tile-thumb">${img?`<img class="att-img" src="${cUrl(f)}" alt="">`:`<div class="att-3d-ph"><span>${esc(ext.toUpperCase())}</span></div>`}</div>
        <span class="att-tile-badge">${esc(ext.toUpperCase())}</span>
        <div class="att-tile-cap">${esc(f.name)}</div>
        <button type="button" class="att-tile-x" data-i="${i}" title="Remove">&times;</button>
      </div>
      ${img?`<div class="att-preview"><div class="att-prev-head"><span>${esc(f.name)}</span></div>
        <div class="att-prev-body"><img src="${cUrl(f)}" alt="" style="max-width:100%;max-height:78vh;object-fit:contain"></div></div>`:''}`;
    if(img){
      const face=tile.querySelector('.att-tile-face'), pop=tile.querySelector('.att-preview');
      face.addEventListener('mouseenter',()=>openPop(pop));
      face.addEventListener('mouseleave',()=>laterHidePop(pop));
      pop.addEventListener('mouseenter',keepPop);
      pop.addEventListener('mouseleave',()=>laterHidePop(pop));
    }
    return tile;
  };
  const renderAtts=()=>{ attWrap.innerHTML=''; if(!atts.length) return; const strip=document.createElement('div'); strip.className='att-strip'; atts.forEach((f,i)=>strip.appendChild(cTile(f,i))); attWrap.appendChild(strip); };
  attWrap.addEventListener('click',e=>{ const x=e.target.closest('[data-i]'); if(x){ const f=atts[+x.dataset.i]; if(f&&f.__url) URL.revokeObjectURL(f.__url); atts.splice(+x.dataset.i,1); renderAtts(); } });
  const addFiles=list=>{ for(const f of list) atts.push(f); renderAtts(); };
  const fileInput=panel.querySelector('#compose-file-input');
  panel.querySelector('.compose-attach-btn').onclick=()=>fileInput.click();
  fileInput.addEventListener('change',()=>{ if(fileInput.files.length) addFiles([...fileInput.files]); fileInput.value=''; });

  // Drag-and-drop onto the editor area (same counter trick as Quick Notes).
  const dz=panel.querySelector('#compose-dropzone'); let dc=0;
  dz.addEventListener('dragenter',e=>{ e.preventDefault(); if(++dc===1) dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave',()=>{ if(--dc<=0){ dc=0; dz.classList.remove('drag-over'); } });
  dz.addEventListener('dragover',e=>e.preventDefault());
  dz.addEventListener('drop',e=>{ e.preventDefault(); dc=0; dz.classList.remove('drag-over'); const fs=[...(e.dataTransfer.files||[])]; if(fs.length) addFiles(fs); });

  // By default Quill EMBEDS a dropped/pasted image straight into the message
  // text (as a huge base64 blob). Intercept on the editor itself in the CAPTURE
  // phase — so this runs BEFORE Quill's own handler — and route files to the
  // attachment list instead, exactly like clicking "Attach file". stopPropagation
  // also keeps the wrapper's drop handler above from adding them a second time.
  quill.root.addEventListener('dragover',e=>{ e.preventDefault(); },true);
  quill.root.addEventListener('drop',e=>{ const fs=[...(e.dataTransfer&&e.dataTransfer.files||[])]; if(fs.length){ e.preventDefault(); e.stopPropagation(); dc=0; dz.classList.remove('drag-over'); addFiles(fs); } },true);
  quill.root.addEventListener('paste',e=>{ const fs=[...(e.clipboardData&&e.clipboardData.files||[])]; if(fs.length){ e.preventDefault(); e.stopPropagation(); addFiles(fs); } },true);

  const openMail=()=>{const subject=subjEl.value.trim(),body=quill.getText().trim();window.location.href=`mailto:${encodeURIComponent(recipients.join(','))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;};

  /* Send for real: build a multipart form (subject, HTML body, files) and POST
     to /mail/send, which delivers it through the shared company mailbox and
     records it. The button locks while in flight so a double-click can't send
     twice; a failure re-arms it. */
  const send=async()=>{
    const subject=subjEl.value.trim();
    let bodyHTML=quill.root.innerHTML; if(bodyHTML==='<p><br></p>') bodyHTML='';
    const empty=!subject&&!quill.getText().trim()&&!atts.length;
    if(empty){ showFeedback('Nothing to send','Add a subject, a message, or an attachment first.'); return; }
    sendBtn.disabled=true; const label=sendBtn.textContent; sendBtn.textContent='Sending…';
    // One POST per recipient — so each send is recorded against its own row and the
    // "already emailed" state updates for everyone. backend 'smtp' means the company
    // mailbox delivered it; 'console' means the server only logged it.
    let okCount=0, failCount=0, delivered=false, lastErr='';
    for(const to of recipients){
      try{
        const fd=new FormData();
        fd.append('to',to); fd.append('subject',subject); fd.append('body',bodyHTML);
        const cx = recipients.length===1 ? ctx : (()=>{ const r=rowByEmail(to); return r?{log_id:r.id,file_id:r.file_id,contact_id:r.contact_id}:{}; })();
        if(cx.log_id) fd.append('log_id',cx.log_id);
        if(cx.file_id) fd.append('file_id',cx.file_id);
        if(cx.contact_id) fd.append('contact_id',cx.contact_id);
        atts.forEach(f=>fd.append('files',f,f.name));
        const rec=await apiMultipart('/mail/send',fd);
        okCount++; if(rec&&rec.backend==='smtp') delivered=true;
      }catch(err){ failCount++; lastErr=err.message||'send failed'; }
    }
    if(okCount){
      composeToast(
        recipients.length>1
          ? `Email ${delivered?'sent':'recorded'} for ${okCount}${failCount?` of ${recipients.length}`:''} recipient${okCount>1?'s':''}${delivered?' ✓':' — company email isn’t set up, so nothing was delivered'}`
          : (delivered?'Email sent ✓':'Email recorded — the company email isn’t set up yet, so it wasn’t actually delivered.'),
        delivered && !failCount);
      try{ await load(); }catch(_){}   // refresh so the "sent" icons update
      close();
    }else{
      sendBtn.disabled=false; sendBtn.textContent=label;
      showFeedback('Couldn’t send',lastErr||'Something went wrong sending the email.');
    }
  };
  panel.querySelector('.compose-close').onclick=close;
  sendBtn.onclick=send;
  panel.querySelector('.compose-mailto').onclick=openMail;
  document.addEventListener('keydown',onKey);
  requestAnimationFrame(()=>subjEl.focus());
}

/* ── Quill rich-text + file attachments for the "desc" quick-notes field ───
   DOM flow: openExpandedRow() does $('rx-body').innerHTML = html inside the
   function body, then returns. A MutationObserver on #rx-body fires the
   instant that write lands, so #quill-desc-editor is guaranteed to exist
   when mountQuillDesc() runs.                                               */
(function(){
  let quillDesc = null;

    const DELIVERABLE_OPTIONS = [
    { key:'srv', label:'SURV' },
    { key:'dwg', label:'DWG' },
    { key:'mt',  label:'M/T' },
    { key:'boq', label:'BOQ' },
    { key:'cst', label:'CST' },
    { key:'qte', label:'QTE' }
  ];

  // Temporary frontend state.
  // Step 3 will persist these selections in the backend.
  const attachmentDeliverables = new Map();

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function fmtSize(n){
    return n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B';
  }
  function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  /* Combine the Subject line and the Quill body into the single `description`
     HTML that gets saved. The subject is stored as a marked heading at the very
     top so it persists (there is no separate column) and splitAndLoad() below
     pulls it back out into the input when the log is reopened. */
  function syncHidden(){
    const h = document.getElementById('quill-desc-hidden');
    if(!h || !quillDesc) return;
    const raw = quillDesc.root.innerHTML;
    const body = raw === '<p><br></p>' ? '' : raw;
    const subjEl = document.getElementById('rx-notes-subject');
    const subj = subjEl ? subjEl.value.trim() : '';
    const subjHTML = subj ? '<p class="achi-note-subject"><strong>'+esc(subj)+'</strong></p>' : '';
    h.value = subjHTML + body;
  }

  /* ── current log id ───────────────────────────────────────────────────
     rxRowId is the global set by openExpandedRow before the form is built. */
  function currentLogId(){ return typeof rxRowId !== 'undefined' ? rxRowId : null; }

  /* ── file list rendering ──────────────────────────────────────────────── */

    function deliverablePickerHTML(f){
    const id = String(f.id);

    if(!attachmentDeliverables.has(id)){
      const existing = Array.isArray(f.deliverables)
        ? f.deliverables
        : [];

      attachmentDeliverables.set(id, new Set(existing));
    }

    const selected = attachmentDeliverables.get(id);

    const selectedLabels = DELIVERABLE_OPTIONS
      .filter(o => selected.has(o.key))
      .map(o => o.label);

    const buttonText = selectedLabels.length
      ? selectedLabels.join(', ')
      : 'Classify file';

    return `
      <div class="rx-deliv-picker" data-att-id="${esc(id)}">

        <button type="button"
                class="rx-deliv-btn"
                data-deliv-toggle>
          <span>${esc(buttonText)}</span>
          <span class="rx-deliv-arrow">⌄</span>
        </button>

        <div class="rx-deliv-menu">
          ${DELIVERABLE_OPTIONS.map(o => `
            <label class="rx-deliv-option">
              <input
                type="checkbox"
                value="${esc(o.key)}"
                data-deliv-option
                ${selected.has(o.key) ? 'checked' : ''}
              >
              <span>${esc(o.label)}</span>
            </label>
          `).join('')}
        </div>

      </div>
    `;
  }

    function renderFiles(files){
    const el = document.getElementById('rx-notes-files');
    if(!el) return;

    const sec = document.getElementById('rx-attach-section');

    el.innerHTML = '';

    if(!files.length){
      if(sec) sec.style.display = 'none';
      return;
    }

    if(sec) sec.style.display = '';

    const strip = document.createElement('div');
    strip.className = 'att-strip';

    files.forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'rx-att-classified';

      // Existing attachment preview
      wrap.appendChild(
        attachmentTile(f, 'data-att-del')
      );

      // New Deliverables selector
      const pickerHolder = document.createElement('div');
      pickerHolder.innerHTML = deliverablePickerHTML(f);
      wrap.appendChild(pickerHolder.firstElementChild);

      strip.appendChild(wrap);
    });

    el.appendChild(strip);
  }

  async function loadFiles(){
    const logId = currentLogId();
    if(!logId) return;
    try{
      const list = await api('/logs/'+logId+'/attachments');
      renderFiles(Array.isArray(list) ? list : []);
    }catch(e){ /* non-fatal — attachment list is a convenience */ }
  }

  /* Open an attachment via blob URL (bearer-auth, same as openNoteWorkspace). */
  async function openAttachment(id){
    try{
      const r = await fetch(API+'/attachments/'+id+'/download',
                            {headers:{Authorization:'Bearer '+TOKEN}});
      if(!r.ok) throw new Error('Could not open file');
      const url = URL.createObjectURL(await r.blob());
      window.open(url,'_blank','noreferrer');
      setTimeout(()=>URL.revokeObjectURL(url), 60000);
    }catch(e){ alert(e.message); }
  }

  async function deleteAttachment(id){
    if(!confirm('Remove this file?')) return;
    try{
      await api('/attachments/'+id, {method:'DELETE'});
      await loadFiles();
    }catch(e){ alert('Could not remove: '+e.message); }
  }

  /* ── upload one or more File objects ─────────────────────────────────── */
  async function uploadFiles(files){
    let logId = currentLogId();

    // New unsaved log — silently save it first so we have a log_id to attach to.
    if(!logId){
      const payload = rxCollectNew();
      if(!(payload.person.first_name || payload.person.last_name || payload.person.company_name)){
        alert('Enter at least a name or company before attaching files.');
        return;
      }
      const st = $('rx-status');
      rxBusy(true);
      st.textContent = 'Saving…'; st.className = 'rx-status';
      try{
        const res = await api('/logs/', {method:'POST', body:JSON.stringify(payload)});
        logId = res && res.log && res.log.id;
        rxRowId = logId;                          // promote to "saved" state
        st.textContent = 'Saved'; st.className = 'rx-status ok';
        await load();
        revealSavedRow(logId);
        rxBusy(false);
        // Show the attach button now that we have a real log id.
        const head = document.getElementById('rx-notes-head');
        if(head && !document.getElementById('rx-notes-attach-btn')){
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'rx-notes-attach-btn';
          btn.id = 'rx-notes-attach-btn';
          btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13.5 9.5v2a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2"/>
            <polyline points="10.5 5.5 8 3 5.5 5.5"/>
            <line x1="8" y1="3" x2="8" y2="10.5"/>
          </svg> Attach file`;
          head.appendChild(btn);
          const fi = document.getElementById('rx-notes-file-input');
          if(fi) btn.addEventListener('click', () => fi.click());
        }
      }catch(e){
        st.textContent = e.message || 'Could not save'; st.className = 'rx-status bad';
        rxBusy(false);
        return;
      }
    }

    const filesEl = document.getElementById('rx-notes-files');
    const notice  = document.createElement('div');
    notice.className = 'rx-notes-uploading';
    if(filesEl) filesEl.before(notice);

    for(const f of files){
      notice.textContent = `Uploading ${f.name}…`;
      try{
        const fd = new FormData();
        fd.append('file', f, f.name);
        await fetch(API+'/logs/'+logId+'/attachments',
                    {method:'POST', headers:{Authorization:'Bearer '+TOKEN}, body:fd});
      }catch(e){ alert('Upload failed for '+f.name+': '+e.message); }
    }
    notice.remove();
    await loadFiles();
  }

  /* ── wire drag-drop and file-picker after each form mount ─────────────── */
  function wireAttachments(){
    const dropzone  = document.getElementById('rx-notes-dropzone');
    const fileInput = document.getElementById('rx-notes-file-input');
    const attachBtn = document.getElementById('rx-notes-attach-btn');
    const filesEl   = document.getElementById('rx-notes-files');
    if(!dropzone || !fileInput) return;

    /* File-picker button → open the hidden <input type="file"> */
    if(attachBtn) attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if(fileInput.files.length) uploadFiles([...fileInput.files]);
      fileInput.value = '';   // reset so the same file can be re-picked
    });

    /* Drag-and-drop on the dropzone wrapper */
    let dragCount = 0;   // counter handles entering child elements gracefully
    dropzone.addEventListener('dragenter', e => {
      e.preventDefault();
      if(++dragCount === 1) dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => {
      if(--dragCount <= 0){ dragCount = 0; dropzone.classList.remove('drag-over'); }
    });
    dropzone.addEventListener('dragover', e => e.preventDefault());
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dragCount = 0;
      dropzone.classList.remove('drag-over');
      const files = [...(e.dataTransfer.files || [])];
      if(files.length) uploadFiles(files);
    });

    /* Quill (the note body) sits inside the dropzone and would otherwise catch a
       dropped image and embed it INLINE in the text. Intercept the drop on the
       editor itself in the CAPTURE phase — before Quill sees it — and send the
       files to Attachments instead, so they land under the message box, not in it. */
    const noteEditor = dropzone.querySelector('.ql-editor') || (quillDesc && quillDesc.root);
    if(noteEditor){
      noteEditor.addEventListener('dragover', e => {
        if(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
      }, true);
      noteEditor.addEventListener('drop', e => {
        const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
        if(files.length){
          e.preventDefault();
          e.stopPropagation();
          dragCount = 0;
          dropzone.classList.remove('drag-over');
          uploadFiles(files);
        }
      }, true);
    }

    /* Clicks on the file list: open or delete */
    if(filesEl){
      filesEl.addEventListener('click', e => {
                const toggle = e.target.closest('[data-deliv-toggle]');

        if(toggle){
          e.preventDefault();
          e.stopPropagation();

          const picker = toggle.closest('.rx-deliv-picker');
          const menu = picker.querySelector('.rx-deliv-menu');

          // Close any other open Deliverables menu
          document.querySelectorAll('.rx-deliv-menu.open').forEach(m => {
            if(m !== menu) m.classList.remove('open');
          });

          menu.classList.toggle('open');
          return;
        }
              filesEl.addEventListener('change', async e => {
  const checkbox = e.target.closest('[data-deliv-option]');
  if(!checkbox) return;

  const picker = checkbox.closest('.rx-deliv-picker');
  const id = picker.dataset.attId;

  const selected = new Set(
    [...picker.querySelectorAll('[data-deliv-option]:checked')]
      .map(cb => cb.value)
  );

  const deliverables = [...selected];

  // Update button immediately
  const labels = DELIVERABLE_OPTIONS
    .filter(o => selected.has(o.key))
    .map(o => o.label);

  const text = picker.querySelector('[data-deliv-toggle] span');

  if(text){
    text.textContent = labels.length
      ? labels.join(', ')
      : 'Classify file';
  }

  try{
    // Save selected classifications to backend
    await api('/attachments/' + id + '/deliverables', {
      method: 'PATCH',
      body: JSON.stringify({
        deliverables: deliverables
      })
    });

    // Only keep frontend state after backend save succeeds
    attachmentDeliverables.set(id, selected);

  }catch(err){
    alert('Could not save Deliverables: ' + (err.message || err));

    // Reload attachment from backend to restore real saved state
    await loadFiles();
  }
});


        const openLink = e.target.closest('[data-att-open]');
        if(openLink){ e.preventDefault();
          const id=openLink.dataset.attOpen, nm=openLink.getAttribute('title')||openLink.textContent||'';
          const ext=nm.split('.').pop().toLowerCase();
          // DWG/DXF (SVG) and RVT/IFC (3D) get the shared inline card; others open as before.
          if(isPreviewable(nm) && typeof cadPreview==='function') cadPreview(id,nm,openLink.closest('.rx-notes-file'));
          else openAttachment(id);
          return; }
        const delBtn = e.target.closest('[data-att-del]');
        if(delBtn){ deleteAttachment(delBtn.dataset.attDel); }
      });
    }

    /* ── Resize handle ────────────────────────────────────────────────────
       We resize .ql-container (the editor wrapper). The toolbar and file
       list sit below it in normal flow, so they move down automatically.   */
    const qlContainer = dropzone.querySelector('.ql-container');
    if(qlContainer){
      // Inject handle element into the container so it sits inside the border.
      const handle = document.createElement('div');
      handle.className = 'rx-notes-resize-handle';
      handle.title = 'Drag to resize';
      handle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="#8a5a12" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`;
      qlContainer.style.position = 'relative';
      qlContainer.appendChild(handle);

      const MIN_H = 78;    // px — matches the original min-height
      let startY, startH;

      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        startY = e.clientY;
        startH = qlContainer.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';

        function onMove(e){
          const newH = Math.max(MIN_H, startH + (e.clientY - startY));
          qlContainer.style.height = newH + 'px';
        }
        function onUp(){
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    /* Load existing attachments for this log. */
    loadFiles();
  }

  /* ── Quill mount ──────────────────────────────────────────────────────── */
  function mountQuillDesc(){
    const container = document.getElementById('quill-desc-editor');
    const hidden    = document.getElementById('quill-desc-hidden');
    if(!container || !hidden) return;

    quillDesc = new Quill(container, {
      theme: 'snow',
      placeholder: 'Type fast while on the call \u2014 details can be sorted into the sections after hanging up\u2026',
      modules:{
        toolbar: '#quill-desc-toolbar'
      }
    });

    /* The stored description may begin with a marked subject heading; pull it
       into the Subject input and load only the body into Quill. */
    let initial = hidden.value;
    const subjEl = document.getElementById('rx-notes-subject');
    if(initial && initial.indexOf('achi-note-subject') !== -1){
      const doc = new DOMParser().parseFromString(initial, 'text/html');
      const head = doc.body.firstElementChild;
      if(head && head.classList.contains('achi-note-subject')){
        if(subjEl) subjEl.value = head.textContent.trim();
        head.remove();
        initial = doc.body.innerHTML;
      }
    }
    if(initial){
      if(/<[a-z][\s\S]*>/i.test(initial)){
        quillDesc.root.innerHTML = initial;
      } else {
        quillDesc.setText(initial);
      }
      quillDesc.setSelection(quillDesc.getLength(), 0);
    }
    /* Typing in the subject must update the saved value too, not just the body. */
    if(subjEl) subjEl.addEventListener('input', syncHidden);

    quillDesc.on('text-change', syncHidden);

    /* Wire file attachments now that the full notes section is in the DOM. */
    wireAttachments();
  }

  /* ── MutationObserver — fires on every innerHTML swap of #rx-body ─────── */
  function startObserver(){
    const body = document.getElementById('rx-body');
    if(!body){ setTimeout(startObserver, 200); return; }
    new MutationObserver(function(mutations){
      for(const m of mutations){
        if(m.type === 'childList' && m.addedNodes.length){
          if(document.getElementById('quill-desc-editor')){
            quillDesc = null;
            mountQuillDesc();
          }
          break;
        }
      }
    }).observe(body, { childList: true });
  }
  startObserver();

  /* Flush editor HTML into hidden input just before save. */
  const _origSaveAll = window.rxSaveAll;
  window.rxSaveAll = async function(...args){
    syncHidden();
    return _origSaveAll && _origSaveAll.apply(this, args);
  };
})();

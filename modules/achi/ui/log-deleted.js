/* ── Deleted Logs (a grid filter, not a popup) ─────────────────────────────
   Toggling the "Deleted Logs" chip by the KPIs flips the grid into a read-only
   view of soft-deleted logs (GET /logs/?deleted=true), reusing the same table
   and columns. Selected rows can be Restored (POST /logs/{id}/restore) or, for
   admins, permanently deleted (DELETE /logs/{id}/permanent).

   The grid state (`deletedView`, `deletedRows`) and the render/read-only guards
   live in log-core.js; this file drives them. Loads last, so every global it
   uses — $ api esc load render selectedRows deletedView deletedRows jwtPayload
   TOKEN fail — already exists.                                                 */
(function(){
  const btn = $('btn-deleted');
  if(!btn) return;

  // Permanent delete is admin-only server-side; hide its button for non-admins.
  const IS_ADMIN = (() => { try { return (jwtPayload(TOKEN) || {}).role === 'admin'; } catch (_) { return false; } })();

  const selectedIds = () =>
    [...selectedRows].filter(k => String(k).startsWith('log:')).map(k => String(k).slice(4));

  async function fetchDeleted(){
    try{deletedRows = await api(
        logFilteredPath('/logs/?deleted=true'),
      ); }
    catch(e){ deletedRows = []; fail(e.message); }
  }

    window.reloadDeletedLogs = async function(){
    await fetchDeleted();
    render();
  };

  async function enter(){
    deletedView = true;
    document.body.classList.add('deleted-view');
    btn.classList.add('on');
    selectedRows.clear();                 // active selection doesn't carry into this view
    openOnly = false; $('k-open-card').classList.remove('on');
    const qv = $('qv'); if(qv) qv.hidden = true;
    $('rows').innerHTML = '';             // drop the active rows immediately, before the fetch
    await fetchDeleted();
    render();
  }

  function exit(){
    deletedView = false;
    document.body.classList.remove('deleted-view');
    btn.classList.remove('on');
    selectedRows.clear();
    render();
  }

  function toggle(){ deletedView ? exit() : enter(); }

  // Counts on the Restore / Delete-permanently buttons. Called from
  // refreshDeleteButton (log-core.js) on every selection change while in view.
  window.updateDeletedBar = function(){
    const n = selectedIds().length;
    const rc = $('restore-count'), pc = $('perma-count');
    if(rc) rc.textContent = n;
    if(pc) pc.textContent = n;
    $('btn-restore').classList.toggle('on', n > 0);
    $('btn-perma').classList.toggle('on', n > 0);
  };

  async function restore(){
    const ids = selectedIds();
    if(!ids.length) return;
    let ok = 0, err = '';
    for(const id of ids){
      try{ await api('/logs/'+id+'/restore',{method:'POST'}); ok++; selectedRows.delete('log:'+id); }
      catch(e){ err = err || e.message; }              // one bad row must not stop the rest
    }
    await fetchDeleted();
    render();
    if(ok) load();                                     // active grid + KPIs pick the rows back up
    if(err) alert('Some logs could not be restored: ' + err);
  }

  async function permaDelete(){
    const ids = selectedIds();
    if(!ids.length) return;
    if(!confirm(`Permanently delete ${ids.length} log${ids.length>1?'s':''}? This cannot be undone.`)) return;
    let err = '';
    for(const id of ids){
      try{ await api('/logs/'+id+'/permanent',{method:'DELETE'}); selectedRows.delete('log:'+id); }
      catch(e){ err = err || e.message; }
    }
    await fetchDeleted();
    render();
    if(err) alert('Some logs could not be permanently deleted: ' + err);   // e.g. non-admin (403)
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */
  btn.addEventListener('click', toggle);
  $('btn-restore').addEventListener('click', restore);
  $('btn-perma').addEventListener('click', permaDelete);
  if(!IS_ADMIN) $('btn-perma').style.display = 'none';   // permanent delete is admin-only
})();

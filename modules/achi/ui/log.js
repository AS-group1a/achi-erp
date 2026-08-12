async function rxSaveAll(keepOpen){
  if(rxRowId===null) return rxCreateNew(keepOpen);   // blank sheet -> create, don't patch
  const st=$('rx-status');
  // Guard the email/phone/contact-person rows up front: any invalid entry blocks
  // the save and points the user at the offending row, so nothing slips through.
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
  const fields=[...$('rx-body').querySelectorAll('[data-k]')];
  const r=ROWS.find(x=>x.id===rxRowId);
  if(!r){ st.textContent='Row not loaded'; st.className='rx-status bad'; return; }
  const changed=fields.filter(el=>{
    if(el.dataset.k==='reference') return String(r.reference||'')!==rxFieldValue(el);
    const c=COLS.find(x=>x.k===el.dataset.k);
    return c&&c.edit&&String(c.edit.val(r)??'')!==rxFieldValue(el);
  });
  const extrasChanged=rxExtrasChanged(r);
  const phonesChanged=rxPhonesChanged(r);
  const emailsChanged=rxEmailsChanged(r);
  const relatedChanged=rxRelatedChanged(r);
  if(!changed.length && !extrasChanged && !phonesChanged && !emailsChanged && !relatedChanged){
    st.textContent='Nothing to save'; st.className='rx-status';
    if(!keepOpen) setTimeout(closeExpandedRow,500);
    return;
  }
  rxBusy(true); st.textContent='Saving…'; st.className='rx-status';
  // Sequential, not Promise.all: these PATCH the same file and contact, and
  // firing them together interleaves writes to one row.
  let failed=0;
  for(const el of changed){ try{ await rxSave(el); }catch(e){ failed++; } }
  // Fields with no COLS/inline-edit entry go straight to the file.
  if(extrasChanged){ try{ await rxSaveExtras(r); }catch(e){ failed++; } }
  // Phone / email / contact-person lists -> the contact's shared bucket, so the
  // Contacts page sees the same numbers, emails and people.
  if(phonesChanged){ try{ await rxSavePhones(r); }catch(e){ failed++; } }
  if(emailsChanged){ try{ await rxSaveEmails(r); }catch(e){ failed++; } }
  if(relatedChanged){ try{ await rxSaveRelated(r); }catch(e){ failed++; } }
  rxBusy(false);
  if(failed){ st.textContent=`${failed} field(s) failed`; st.className='rx-status bad'; }
  else {
    st.textContent='Saved'; st.className='rx-status ok'; setTimeout(()=>{ if($('rx-status'))$('rx-status').textContent=''; },2000);
    if(!keepOpen) setTimeout(closeExpandedRow,450);
  }
}
function closeExpandedRow(){ closeRxState(); closeRxSelect(); closeContactMatches(); $('rx').hidden=true; rxRowId=null; }

/* Field saves go through the SAME endpoints as the grid's inline editors, keyed
   off each column's own edit.target — so nothing here can save to a different
   place than the table would. */
async function rxSave(el){
  if(el.dataset.k==='reference'){
    if(!rxRowId) return;
    const row=ROWS.find(x=>x.id===rxRowId); if(!row) return;
    const value=rxFieldValue(el);
    await api('/logs/'+row.id,{method:'PATCH',body:JSON.stringify({reference:value||null})});
    row.reference=value;
    return;
  }
  const c=COLS.find(x=>x.k===el.dataset.k); if(!c||!c.edit||!rxRowId) return;
  const r=ROWS.find(x=>x.id===rxRowId); if(!r) return;
  const note=$(el.id+'-note'), field=c.edit.field, target=c.edit.target;
  const setNote=(t,cls)=>{ if(note){ note.textContent=t; note.className='rx-note '+(cls||''); } };
  const nv=rxFieldValue(el);
  if(String(c.edit.val(r)??'')===nv) return;                // nothing changed
  if(field==='email'&&nv&&!validEmail(nv)){ setNote('Invalid email','rx-err'); showInvalidEmail(el); throw new Error('Invalid email'); }
  if(field==='mobile'&&nv&&!validMobile(nv)){ setNote('Invalid mobile','rx-err'); showInvalidMobile(el); throw new Error('Invalid mobile'); }
  try{
    if(target==='file') await api('/files/'+r.file_id,{method:'PATCH',body:JSON.stringify({[field]:nv||null})});
    else if(target==='contact') await api('/files/'+r.file_id+'/contact',{method:'PATCH',body:JSON.stringify({[field]:nv||null})});
    else await api('/logs/'+r.id,{method:'PATCH',body:JSON.stringify({[field]:nv||null})});
    ROWS.forEach(x=>{ if((target==='log'&&x.id===r.id)||(target!=='log'&&x.file_id===r.file_id)) x[field]=nv; });
    setNote('Saved','rx-saved');
    setTimeout(()=>setNote(''),1600);
    render();                                                // keep the grid in step
  }catch(e){ setNote(e.message||'Could not save','rx-err'); }
}
function rxTotals(){
  const n=id=>{ const v=parseFloat(($(id)||{}).value); return isNaN(v)?0:v; };
  let sub=n('rx-q-area')*n('rx-q-weeks')*n('rx-q-rate')+n('rx-q-erection')+n('rx-q-transport')+n('rx-q-extras')-n('rx-q-discount');
  if(sub<0) sub=0;
  const vat=sub*n('rx-q-vat')/100;
  $('rx-q-sub').textContent=sub.toFixed(2); $('rx-q-vatv').textContent=vat.toFixed(2);
  $('rx-q-tot').textContent=(sub+vat).toFixed(2);
}
async function rxDraftQuotation(){
  if(!rxRowId) return;
  const r=ROWS.find(x=>x.id===rxRowId); if(!r) return;
  const m=$('rx-q-msg'), btn=$('rx-q-draft');
  const val=id=>{ const el=$(id); const v=el?el.value.trim():''; return v===''?undefined:v; };
  const body={area_sqm:val('rx-q-area'),duration_weeks:val('rx-q-weeks'),rate:val('rx-q-rate'),
    erection:val('rx-q-erection'),transport:val('rx-q-transport'),extras:val('rx-q-extras'),
    discount:val('rx-q-discount'),vat_percent:val('rx-q-vat'),scope:val('rx-q-scope')};
  Object.keys(body).forEach(k=>body[k]===undefined&&delete body[k]);
  btn.disabled=true; m.textContent='Drafting…'; m.className='qv-msg';
  try{
    const q=await api(`/logs/${encodeURIComponent(r.file_id)}/quotation`,{method:'POST',body:JSON.stringify(body)});
    m.textContent=`Saved ${q.quotation_number} — total ${q.total} ${q.currency}`; m.className='qv-msg ok';
  }catch(e){ m.textContent=e.message||'Could not draft quotation'; m.className='qv-msg bad'; }
  finally{ btn.disabled=false; }
}
async function draftQuotation(){
  const id=selectedLogId();
  if(!id){ qvMsg('Select one row first.','bad'); return; }
  const btn=$('qv-draft'); btn.disabled=true; qvMsg('Drafting…');
  // Blank stays blank: the server fills customer fields from the row, and an
  // empty string here would overwrite them with nothing.
  const val=id2=>{ const v=$(id2).value.trim(); return v===''?undefined:v; };
  const body={
    area_sqm:val('qv-area'), duration_weeks:val('qv-weeks'), rate:val('qv-rate'),
    erection:val('qv-erection'), transport:val('qv-transport'), extras:val('qv-extras'),
    discount:val('qv-discount'), vat_percent:val('qv-vat'),
    scope:val('qv-scope'), notes:val('qv-notes'), site_city:val('qv-city'),
    valid_until:val('qv-valid'),
  };
  Object.keys(body).forEach(k=>body[k]===undefined&&delete body[k]);
  // The endpoint keys off the FILE, not the log row: a file is the enquiry a
  // quotation is addressed to, and one file can carry several log entries.
  const row=ROWS.find(x=>x.id===id);
  if(!row){ qvMsg('Row not loaded — reload and try again.','bad'); btn.disabled=false; return; }
  try{
    const q=await api(`/logs/${encodeURIComponent(row.file_id)}/quotation`,{method:'POST',body:JSON.stringify(body)});
    qvMsg(`Saved ${q.quotation_number} — total ${q.total} ${q.currency}`,'ok');
  }catch(e){ qvMsg(e.message||'Could not draft quotation','bad'); }
  finally{ btn.disabled=false; }
}
async function deleteSelected(){
  const logs=logKeys(), drafts=draftKeys();
  const n=logs.length+drafts.length;
  if(!n) return;
  if(!confirm(`Delete ${n} row${n>1?'s':''}? Saved logs can be restored from the Deleted Logs view.`)) return;
  clearErr();
  const failed=[];
  for(const k of logs){
    const id=String(k).slice(4);
    try{ await api('/logs/'+id,{method:'DELETE'}); selectedRows.delete(k); }
    catch(e){ failed.push(e.message); }          // keep going; one bad row must not stop the rest
  }
  // Unsaved draft rows: discard them locally. Bottom rows are spliced high index
  // first so earlier removals don't shift the ones still to go.
  const idx=[];
  for(const k of drafts){
    const dp=String(k).slice(6);
    selectedRows.delete(k);
    if(dp==='d') topDraft={}; else idx.push(+dp.slice(1));
  }
  idx.sort((a,b)=>b-a).forEach(i=>bottomDrafts.splice(i,1));
  await load();
  refreshDeleteButton();
  if(failed.length) fail(`Could not delete ${failed.length} row(s): ${failed[0]}`);
}

/* ── draft interactions (delegated once) ── */
function stateFor(dp){ return dp==='d'?topDraft:bottomDrafts[+dp.slice(1)]; }
function draftInputs(dp){ return [...$('rows').querySelectorAll(`.din[data-dp="${dp}"]`)]; }
let contactMatchTimer=null,contactMatchSeq=0,contactMatchDrop=null;
let contactMatchItems=[],contactMatchActive=0,contactMatchInput=null;
function closeContactMatches(){
  clearTimeout(contactMatchTimer);
  if(contactMatchDrop)contactMatchDrop.remove();
  contactMatchDrop=null;contactMatchItems=[];contactMatchInput=null;
}
function contactName(c){return [c.first_name,c.last_name].filter(Boolean).join(' ').trim()||c.company_name||'Unnamed contact';}
function contactPrefix(c){
  for(const v of Object.values(c.custom_properties||{}))if(v&&typeof v==='object'&&v.prefix)return v.prefix;
  return '';
}
function contactPhoneParts(phone){
  const raw=String(phone||'').trim();
  const found=[...COUNTRIES].sort((a,b)=>b[2].length-a[2].length).find(c=>raw.startsWith(c[2]));
  return found?{iso:found[0],dial:found[2],mobilenum:raw.slice(found[2].length).trim()}:{iso:DEFAULT_ISO,dial:DEFAULT_DIAL,mobilenum:raw};
}
/* Peel a country code off a pasted number. "0096170.." is normalised to "+96170.."
   first. Returns {iso,dial,mobilenum} only when a KNOWN dial code leads the value,
   so a bare national number ("70123456") is left untouched for the picker's
   current country. */
function detectPhone(raw){
  const s=String(raw||'').trim().replace(/^00/,'+');
  if(!s.startsWith('+')) return null;
  const parts=contactPhoneParts(s);
  return s.startsWith(parts.dial)?parts:null;
}
/* Set a .tel-wrap's country button (flag + dial) in place. */
function setTelCountry(wrap,iso,dial){
  const btn=wrap&&wrap.querySelector('.tel-cc'); if(!btn) return;
  const img=btn.querySelector('img'); if(img) img.src=flagSrc(iso);
  const cc=btn.querySelector('.cc'); if(cc) cc.textContent=dial;
}
function rxFieldValue(el){
  const value=el.value.trim();
  if(el.dataset.k!=='mobile'||!value) return value;
  const dial=el.closest('.tel-wrap')?.querySelector('.tel-cc .cc')?.textContent?.trim()||DEFAULT_DIAL;
  return `${dial} ${value}`.trim();
}
function contactAddress(c){return c.address&&typeof c.address==='object'?c.address:{};}
function fillDraftFromContact(dp,c){
  const st=stateFor(dp);if(!st)return;
  st.__choosingContact=true;
  const phone=contactPhoneParts(c.primary_phone),address=contactAddress(c);
  Object.assign(st,{prefix:contactPrefix(c),first:c.first_name||'',last:c.last_name||'',company:c.company_name||'',
    email:c.primary_email||'',iso:phone.iso,dial:phone.dial,mobilenum:phone.mobilenum,
    country:address.country||address.country_name||c.country_code||'',district:address.district||address.state||'',
    city:address.city||'',street:address.street||address.address_line_1||''});
  closeContactMatches();
  const outer=$('touter'),left=outer.scrollLeft,top=outer.scrollTop;
  render();outer.scrollLeft=left;outer.scrollTop=top;
  const next=$(dp+'-desc')||$(dp+'-last');if(next){next.focus();next.scrollIntoView({inline:'center',block:'nearest'});}
  setTimeout(()=>{delete st.__choosingContact;},0);
}
function fillRxFromContact(c){
  const body=$('rx-body'), phone=contactPhoneParts(c.primary_phone), address=contactAddress(c);
  const set=(key,value)=>{
    const el=body.querySelector(`[data-k="${key}"]`);
    if(!el) return;
    const next=String(value||'');
    if(el.tagName==='SELECT'){
      if([...el.options].some(option=>option.value===next)) el.value=next;
      enhanceRxSelect(el);
    }else el.value=next;
  };
  set('prefix',contactPrefix(c));
  set('first',c.first_name);
  set('last',c.last_name);
  set('company',c.company_name);
  set('email',c.primary_email);
  set('country',address.country||address.country_name||c.country_code);
  set('district',address.district||address.state);
  set('city',address.city);
  set('street',address.street||address.address_line_1);
  const mobile=body.querySelector('[data-k="mobile"]');
  if(mobile){
    mobile.value=phone.mobilenum;
    const button=mobile.closest('.tel-wrap')?.querySelector('.tel-cc');
    const img=button?.querySelector('img'), dial=button?.querySelector('.cc');
    if(img) img.src=flagSrc(phone.iso);
    if(dial) dial.textContent=phone.dial;
  }
  /* Keep the user in the name workflow after choosing a saved contact. Focus
     before closing so closeContactMatches also cancels the focus-triggered
     autocomplete timer; otherwise the same surname list immediately reopens. */
  body.querySelector('[data-k="last"]')?.focus();
  closeContactMatches();
}
function pickContactMatch(input,c){
  if(input.closest('#rx-body')) fillRxFromContact(c);
  else fillDraftFromContact(input.dataset.dp,c);
}
function placeContactMatches(){
  if(!contactMatchDrop||!contactMatchInput)return;
  const r=contactMatchInput.getBoundingClientRect();
  const w=contactMatchInput.closest('#rx-body')?r.width:Math.max(300,r.width);
  contactMatchDrop.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
  contactMatchDrop.style.top=Math.min(innerHeight-8,r.bottom+2)+'px';
  contactMatchDrop.style.width=w+'px';
}
function renderContactMatches(){
  if(!contactMatchDrop)return;
  contactMatchDrop.innerHTML='';
  contactMatchItems.forEach((c,i)=>{
    const item=document.createElement('div');item.className='pg-ac-item contact-match'+(i===contactMatchActive?' pg-ac-active':'');
    const main=document.createElement('span');main.className='contact-match-main';main.textContent=contactName(c);
    const meta=document.createElement('span');meta.className='contact-match-meta';meta.textContent=[c.company_name,c.primary_phone,c.primary_email].filter(Boolean).join(' · ');
    item.append(main,meta);item.onmousedown=e=>{e.preventDefault();pickContactMatch(contactMatchInput,c);};
    contactMatchDrop.appendChild(item);
  });
  contactMatchDrop.style.display='block';
  placeContactMatches();
}
async function showContactMatches(input){
  const q=input.value.trim(),seq=++contactMatchSeq;
  const inExpanded=!!input.closest('#rx-body');
  if(!inExpanded&&q.length<2){closeContactMatches();return;}
  try{
    const items=await searchContacts(q);if(seq!==contactMatchSeq||!input.isConnected||document.activeElement!==input)return;
    const prefix=q.toLowerCase();
    contactMatchItems=prefix?items.filter(c=>[c.first_name,c.last_name,c.company_name,contactName(c)]
      .some(v=>String(v||'').toLowerCase().startsWith(prefix))):items;
    contactMatchActive=0;contactMatchInput=input;
    if(!contactMatchItems.length){closeContactMatches();return;}
    if(contactMatchDrop)contactMatchDrop.remove();
    contactMatchDrop=document.createElement('div');contactMatchDrop.className='pg-ac-drop contact-match-drop'+(inExpanded?' rx-contact-match-drop':'');
    document.body.appendChild(contactMatchDrop);renderContactMatches();
  }catch(e){if(seq===contactMatchSeq)closeContactMatches();}
}
function queueContactMatches(input){clearTimeout(contactMatchTimer);contactMatchTimer=setTimeout(()=>showContactMatches(input),180);}
function contactMatchKey(e){
  if(!contactMatchDrop||e.target!==contactMatchInput)return false;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();e.stopPropagation();contactMatchActive=(contactMatchActive+(e.key==='ArrowDown'?1:-1)+contactMatchItems.length)%contactMatchItems.length;renderContactMatches();return true;}
  if(e.key==='Enter'&&contactMatchItems[contactMatchActive]){e.preventDefault();e.stopPropagation();pickContactMatch(e.target,contactMatchItems[contactMatchActive]);return true;}
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeContactMatches();return true;}
  return false;
}
function addBottomRow(){
  const index=bottomDrafts.length, left=$('touter').scrollLeft;
  bottomDrafts.push({});
  render();
  $('touter').scrollLeft=left;
  revealGridRow(`tr[data-row-key="draft:b${index}"]`,`b${index}-first`);
}
function removeBottomRow(dp){ bottomDrafts.splice(+dp.slice(1),1); render(); }
function draftMobile(st){
  const num=(st.mobilenum||'').trim();
  if(!num) return null;
  return `${st.dial||DEFAULT_DIAL} ${num}`.trim();
}
function validDraftMobile(st){ return validMobile(draftMobile(st)); }
function draftPayload(st){
  const first=(st.first||'').trim(),last=(st.last||'').trim(),company=(st.company||'').trim();
  const isCo=!!company&&!first&&!last;
  const mob=draftMobile(st);
  const person=isCo?{is_company:true,company_name:company,mobile:mob,email:st.email||null}
    :{is_company:false,prefix:st.prefix||null,first_name:first||null,last_name:last||null,company_name:company||null,mobile:mob,email:st.email||null};
  const hasSite=st.country||st.district||st.city||st.street||st.maps||st.location;
  return {person,site:hasSite?{country:st.country||'Lebanon',district:st.district||null,city:st.city||null,street:st.street||null,maps_url:st.maps||null,site_location:st.location||null}:null,
    status:st.status||'open',log_type:st.type||'inbound_call',category:st.category||null,tags:st.tags||'',description:st.desc||'',updates:st.updates||'',follow_up_date:st.followup||null,follow_up_notes:st.funotes||''};
}
const committing=new Set();
/* A row is saveable the moment it has an identity: a first name or a company.
   Everything else on the row is optional and can be filled in afterwards. */
function draftIsSaveable(st){ return !!((st.first||'').trim() || (st.company||'').trim()); }
async function commitDraft(dp){
  const st=stateFor(dp); if(!st) return;
  if(!validDraftMobile(st)){ showInvalidMobile($(dp+'-mobile')); return; }
  if(!validEmail(st.email)){ showInvalidEmail($(dp+'-email')); return; }
  if(!draftIsSaveable(st)){ const el=$(dp+'-first'); if(el)el.focus(); return; }
  if(committing.has(dp)) return;
  committing.add(dp);
  try{
    const showSaved=!!((st.first||'').trim() || (st.company||'').trim());
    const made=await api('/logs/',{method:'POST',body:JSON.stringify(draftPayload(st))});
    const logId=made&&made.log&&made.log.id;
    if(logId&&st.__drawing){ await api('/logs/'+logId,{method:'PATCH',body:JSON.stringify({drawing:st.__drawing})}); }
    if(logId&&st.__pendingFiles&&st.__pendingFiles.length){
      for(const f of st.__pendingFiles){
        const fd=new FormData(); fd.append('file',f,f.name);
        const r=await fetch(`${API}/logs/${logId}/attachments`,{method:'POST',headers:{Authorization:'Bearer '+TOKEN},body:fd});
        if(!r.ok){ const b=await r.json().catch(()=>({})); throw new Error(b.detail||`Could not upload ${f.name}`); }
      }
    }
    if(dp==='d') topDraft={}; else bottomDrafts.splice(+dp.slice(1),1);
    await load();
    revealSavedRow(logId);
    if(showSaved) showSavedFeedback(made);
  }catch(e){ fail(e.message); }
  finally{ committing.delete(dp); }
}

/* Flush saveable drafts on the way out (refresh, navigation, or the embed being
   hidden). Uses keepalive so the request survives the page going away — a normal
   fetch would be cancelled mid-flight. Fire-and-forget: there is no page left to
   report an error to, and losing typed work is the worse failure. */
function flushDrafts(){
  if(!TOKEN) return;
  const list=[['d',topDraft]].concat(bottomDrafts.map((st,i)=>['b'+i,st]));
  for(const [dp,st] of list){
    if(!st||!draftIsSaveable(st)||committing.has(dp)) continue;
    committing.add(dp);
    // No UI left to correct a bad email — drop it rather than lose the whole row.
    if(!validEmail(st.email)) st.email='';
    if(!validDraftMobile(st)) st.mobilenum='';
    try{
      fetch(API+'/logs/',{method:'POST',keepalive:true,
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},
        body:JSON.stringify(draftPayload(st))});
    }catch(_){}
  }
  topDraft={}; bottomDrafts.length=0;
}
window.addEventListener('pagehide',flushDrafts);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') flushDrafts(); });
window.addEventListener('message',e=>{ if(e&&e.data&&e.data.type==='achi-flush') flushDrafts(); });

/* A draft saves only after focus leaves the entire row. Moving from First to
   Last or Company must keep the same DOM and state alive; committing there
   rebuilds the table and can discard text entered during the asynchronous save.
   Pickers and the notes workspace never count as leaving. */
/* (Description-cell hover preview lives in showDescHover() below — grece's card
   with the note text; its file tray reuses our attachment tiles.) */
$('rows').addEventListener('focusout',e=>{
  const el=e.target;
  if(!(el.classList&&el.classList.contains('din'))) return;
  const tr=el.closest('tr.draft'), dp=el.dataset&&el.dataset.dp;
  if(!tr||!dp) return;
  setTimeout(()=>{
    const a=document.activeElement;
    if(a&&a.closest&&(a.closest('.cc-drop')||a.closest('.pg-note-workspace'))) return;
    if(a&&a.closest&&a.closest('tr.draft')===tr) return;
    if(document.querySelector('.pg-note-workspace')) return;
    const st=stateFor(dp);
    if(st&&st.__choosingContact) return;
    if(st&&draftIsSaveable(st)) commitDraft(dp);
  },140);
});
$('rows').addEventListener('input',e=>{ const el=e.target; if(!(el.dataset&&el.dataset.dp))return;
  const st=stateFor(el.dataset.dp); if(!st)return;
  if(el.dataset.dk==='prefix' && el.value===PREFIX_ADD){   // sentinel, never stored
    st.prefix=addPrefix()||''; const dp=el.dataset.dp; render();
    const s=document.getElementById(dp+'-prefix'); if(s) s.focus();
    return; }
  st[el.dataset.dk]=el.value;
  if(el.dataset.dk==='first')queueContactMatches(el);
  if(el.dataset.dk==='mobilenum'&&validDraftMobile(st))el.classList.remove('email-invalid');
  if(el.dataset.dk==='email'){const valid=validEmail(el.value);if(valid)el.classList.remove('email-invalid');const button=el.closest('.draft-email')?.querySelector('.draft-compose');if(button)button.hidden=!(el.value.trim()&&valid); }
});
$('rows').addEventListener('click',e=>{
  const el=e.target.closest('.draft-popup-select'); if(!el)return;
  const kind=el.dataset.dk, st=stateFor(el.dataset.dp); if(!st)return;
  if(kind==='tags'){   // several tags, comma-joined; committed with the draft
    openSelectPopup(el.closest('td'),el,selectPopupChoices('tags'),value=>{ st.tags=value; },
      {multi:true,addSentinel:TAG_ADD,onAdd:addTag});
    return;
  }
  openSelectPopup(el.closest('td'),el,selectPopupChoices(kind),value=>{
    if(kind==='prefix'&&value===PREFIX_ADD){const added=addPrefix();if(!added)return;value=added;}
    if(kind==='type'&&value===TYPE_ADD){const added=addType();if(!added)return;value=added;}
    st[kind]=value; el.dataset.selectValue=value; el.value=(kind==='category'||kind==='type'||kind==='status')?label(value):value; el.focus();
  });
});
$('rows').addEventListener('keydown',e=>{ const el=e.target; if(!(el.classList&&el.classList.contains('din')))return;
  if(el.dataset.dk==='first'&&contactMatchKey(e))return;
  if(e.key==='Enter'&&(el.dataset.dk==='first'||el.dataset.dk==='company')){
    e.preventDefault();e.stopPropagation();commitDraft(el.dataset.dp);return;}
  if(e.key==='Enter'){ e.preventDefault(); const dp=el.dataset.dp,st=stateFor(dp); if(el.dataset.dk==='mobilenum'&&!validDraftMobile(st)){showInvalidMobile(el);return;} if(el.dataset.dk==='email'&&!validEmail(el.value)){showInvalidEmail(el);return;} const ins=draftInputs(dp); const i=ins.indexOf(el);
    if(i<ins.length-1){ ins[i+1].focus(); ins[i+1].scrollIntoView({inline:'center',block:'nearest'}); } else commitDraft(dp); } });
$('rows').addEventListener('focusout',e=>{const el=e.target;if(el&&el.dataset&&el.dataset.dk==='email'&&!validEmail(el.value))showInvalidEmail(el);});
$('rows').addEventListener('focusout',e=>{const el=e.target;if(el&&el.dataset&&el.dataset.dk==='mobilenum'&&!validDraftMobile(stateFor(el.dataset.dp)))showInvalidMobile(el);});
/* Same paste-detect for the grid's draft phone cells: peel the country code into
   the picker and the draft state, then mark validity. */
$('rows').addEventListener('paste',e=>{
  const el=e.target; if(!el.dataset||el.dataset.dk!=='mobilenum') return;
  setTimeout(()=>{
    const dp=el.dataset.dp, st=stateFor(dp); if(!st) return;
    const p=detectPhone(el.value);
    if(p){ st.iso=p.iso; st.dial=p.dial; st.mobilenum=p.mobilenum; el.value=p.mobilenum; setTelCountry(el.closest('.tel-wrap'),p.iso,p.dial); }
    else { st.mobilenum=el.value; }
    el.classList.toggle('tel-bad', !!el.value.trim() && !validDraftMobile(st));
  },0);
});
$('add-row').addEventListener('click',addBottomRow);
$('btn-del').addEventListener('click',deleteSelected);
$('btn-email').addEventListener('click',()=>{ const emails=selectedEmails(); if(emails.length) openEmailCompose(emails,false,{}); });
/* Quick quotation. One delegated listener on the card so the eight number
   inputs do not each need wiring, and so the totals stay live while typing. */
$('qv').addEventListener('input',e=>{ if(e.target.matches('input[type="number"]')) qvTotals(); });
$('qv-draft').addEventListener('click',draftQuotation);
$('qv-collapse').addEventListener('click',()=>{ qvHidden=true; $('qv').hidden=true; });
/* Expanded row. Delegated so the sheet's contents can be rebuilt on every open
   without re-binding: change saves selects/dates immediately, blur saves text
   once the user has stopped typing. */
// Arrow-function wrappers: wiring a handler directly passes the click Event as
// the first argument — openExpandedRow(Event) and rxSaveAll(Event) both misread
// that truthy Event as "explicit id" / "keep open".
$('expand-row').addEventListener('click',()=>openExpandedRow());
/* Detect the double-click from pointer-downs instead of the browser's `dblclick`
   event. Editable cells replace their contents after the first click, and some
   browsers then consider the second click to have a different target and never
   emit `dblclick`. Open the existing full form for the row that was clicked. */
let lastRowPointer={id:null,at:0};
$('rows').addEventListener('pointerdown',e=>{
  const tr=e.target.closest('tr.data[data-log]');
  if(!tr||e.button!==0||e.target.closest('a,button')) return;
  const now=Date.now(), id=tr.dataset.log;
  const isDouble=lastRowPointer.id===id&&now-lastRowPointer.at<=500;
  lastRowPointer=isDouble?{id:null,at:0}:{id,at:now};
  if(!isDouble) return;
  e.preventDefault();
  openExpandedRow(id);
});
$('rx-close').addEventListener('click',closeExpandedRow);
$('rx-cancel').addEventListener('click',closeExpandedRow);
$('rx-save').addEventListener('click',()=>rxSaveAll(false));        // save + close
$('rx-when').addEventListener('change',e=>{ $('rx-when-label').textContent=fmtHeaderDT(e.target.value); });
$('rx-state-btn').addEventListener('click',()=>{
  const menu=$('rx-state-menu'), btn=$('rx-state-btn');
  const opening=menu.hidden;
  menu.hidden=!opening;
  btn.setAttribute('aria-expanded',String(opening));
  if(opening) menu.querySelector(`[data-state="${rxStateValue}"]`)?.focus();
});
$('rx-state-menu').addEventListener('click',e=>{
  const option=e.target.closest('.rx-state-option[data-state]');
  if(!option) return;
  setRxState(option.dataset.state);
  closeRxState();
  $('rx-state-btn').focus();
});
document.addEventListener('mousedown',e=>{
  const picker=$('rx-state');
  if(picker&&!picker.contains(e.target)) closeRxState();
  if(rxSelectMenu&&!rxSelectMenu.contains(e.target)&&!(rxSelectButton&&rxSelectButton.contains(e.target))) closeRxSelect();
  if(contactMatchDrop&&!contactMatchDrop.contains(e.target)&&e.target!==contactMatchInput) closeContactMatches();
});

// Open the shared note workspace for this row and jump straight to a tool, so
// Files lands on the file picker and Drawing on the canvas — not the notes text.
function rxOpenWorkspace(action){
  if(!rxRowId){ fail('Save the entry first, then add files or a drawing.'); return; }
  const td=document.querySelector(`tr[data-log="${rxRowId}"] td[data-field="description"]`);
  const col=COLS.find(c=>c.k==='desc');
  if(!td||!col){ fail('Open the row in the table first, then reopen.'); return; }
  openNoteWorkspace(td,col);                    // owns upload/list/download/drawing
  const btn=document.querySelector('.pg-note-workspace '+(action==='draw'?'.pg-note-drawing':'.pg-note-upload'));
  if(btn) btn.click();                          // synchronous: keeps the user gesture
}
// Name line <-> three inline boxes; Files / Drawing open the shared workspace.
$('rx-body').addEventListener('click',e=>{
  const removeHandle=e.target.closest('.rx-social-remove');
  if(removeHandle){ closeRxSelect(); removeHandle.closest('.rx-social')?.remove(); return; }
  if(e.target.closest('#rx-add-handle')){ addRxSocialRow(); return; }
  if(e.target.closest('[data-rx-compose]')){
    const email=e.target.closest('.rx-email-row')?.querySelector('.rx-email-addr')||$('rx-email');
    if(email&&validEmail(email.value)&&email.value.trim()) openEmailCompose(email.value.trim(),true);
    else if(email) showInvalidEmail(email);
    return;
  }
  const countryCode=e.target.closest('.tel-cc[data-rx-phone]');
  if(countryCode){ openCc(countryCode); return; }
  if(e.target.closest('#rx-add-phone')){
    const list=$('rx-phone-list');
    if(list){ list.insertAdjacentHTML('beforeend', rxPhoneRow({label:'Mobile',number:''},true));
      list.lastElementChild?.querySelector('.rx-phone-num')?.focus(); }
    return;
  }
  const rmPhone=e.target.closest('[data-rx-phone-remove]');
  if(rmPhone){ rmPhone.closest('[data-rx-phone-row]')?.remove(); return; }
  if(e.target.closest('#rx-add-email')){
    const list=$('rx-email-list');
    if(list){ list.insertAdjacentHTML('beforeend', rxEmailRow({label:'Other',address:''},true));
      list.lastElementChild?.querySelector('.rx-email-addr')?.focus(); }
    return;
  }
  const rmEmail=e.target.closest('[data-rx-email-remove]');
  if(rmEmail){ rmEmail.closest('[data-rx-email-row]')?.remove(); return; }
  if(e.target.closest('#rx-add-related')){
    const wrap=$('rx-related-wrap'), list=$('rx-related-list');
    if(wrap) wrap.classList.remove('rx-related-empty');
    if(list){ list.insertAdjacentHTML('beforeend', rxRelatedRow({})); rxRenumberPersons();
      list.lastElementChild?.querySelector('[data-rc-first]')?.focus(); }
    return;
  }
  const rmRel=e.target.closest('[data-rx-related-remove]');
  if(rmRel){ rmRel.closest('[data-rx-related-row]')?.remove(); rxRenumberPersons();
    if($('rx-related-list') && !$('rx-related-list').children.length) $('rx-related-wrap')?.classList.add('rx-related-empty');
    return; }
  if(e.target.closest('#rx-name-toggle')){ const w=$('rx-name-wrap'); if(w){ w.classList.add('on'); const f=$('rx-first'); if(f) f.focus(); } return; }
  if(e.target.closest('#rx-files')){ rxOpenWorkspace('files'); return; }
  if(e.target.closest('#rx-draw')){ rxOpenWorkspace('draw'); return; }
});
// Enter advances to the next field, like Tab (Tab still works natively). Skips
// textareas so notes can hold line breaks, and lets selects open normally.
$('rx-body').addEventListener('keydown',e=>{
  if((e.target.dataset.k==='first'||e.target.dataset.k==='last')&&contactMatchKey(e)) return;
  if(e.key!=='Enter'||e.shiftKey) return;
  const t=e.target;
  if(t.tagName==='TEXTAREA') return;
  e.preventDefault();
  if((t.dataset.k==='mobile'||t.dataset.rxTel)&&t.value&&!validMobile(t.value)){ showInvalidMobile(t); return; }
  if((t.dataset.k==='email'||t.dataset.rxEmail!==undefined)&&t.value&&!validEmail(t.value)){ showInvalidEmail(t); return; }
  const f=[...$('rx-body').querySelectorAll('input,select,textarea,button')].filter(el=>!el.disabled&&el.offsetParent!==null);
  const i=f.indexOf(t);
  if(i>=0&&i+1<f.length) f[i+1].focus();
});
$('rx-body').addEventListener('focusout',e=>{
  if(e.target.dataset.k==='email'){
    if(!validEmail(e.target.value)){ showInvalidEmail(e.target); return; }
    e.target.classList.remove('email-invalid');
  }
  if(e.target.dataset.k==='mobile'&&e.target.value&&!validMobile(e.target.value)){ showInvalidMobile(e.target); return; }
  const w=$('rx-name-wrap'); if(!w||!w.classList.contains('on')) return;
  // Collapse only once focus has actually left the name block (a tick later, so
  // tabbing prefix->first->last does not keep snapping it shut).
  setTimeout(()=>{ if(w.contains(document.activeElement)) return;
    const nm=[$('rx-prefix')?.value,$('rx-first')?.value,$('rx-last')?.value].map(x=>(x||'').trim()).filter(Boolean).join(' ')||'Add name';
    const d=$('rx-name-disp'); if(d) d.textContent=nm;
    w.classList.remove('on');
  },0);
});
$('rx-body').addEventListener('focusin',e=>{
  if(e.target.dataset.k==='first'||e.target.dataset.k==='last') queueContactMatches(e.target);
});
/* Paste a number into the Add Log phone field: if it carries a country code,
   switch the picker to that country and drop the code from the field, then flag
   whether the result is a valid number. Paste fires before the value updates, so
   read it on the next tick. */
function rxValidatePhone(el){
  const dial=el.closest('.tel-wrap')?.querySelector('.tel-cc .cc')?.textContent?.trim()||DEFAULT_DIAL;
  el.classList.toggle('tel-bad', !!el.value.trim() && !validMobile(`${dial} ${el.value}`));
}
$('rx-body').addEventListener('paste',e=>{
  const el=e.target; if(!el.dataset||!(el.dataset.k==='mobile'||el.dataset.rxTel)) return;
  setTimeout(()=>{
    const p=detectPhone(el.value);
    if(p){ setTelCountry(el.closest('.tel-wrap'),p.iso,p.dial); el.value=p.mobilenum; }
    rxValidatePhone(el);
  },0);
});
$('rx-body').addEventListener('blur',e=>{ if(e.target.dataset&&(e.target.dataset.k==='mobile'||e.target.dataset.rxTel)) rxValidatePhone(e.target); },true);
$('rx').addEventListener('mousedown',e=>{ if(e.target===$('rx')) closeExpandedRow(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!$('rx').hidden) closeExpandedRow(); });
/* Tags: click the field to open the multi-select checkbox dropdown (the same one
   the grid uses). Delegated on rx-body so it survives every popup re-render. */
$('rx-body').addEventListener('click',e=>{
  const inp=e.target.closest('.rx-tags-input'); if(!inp) return;
  openSelectPopup(inp,inp,selectPopupChoices('tags'),()=>{},{multi:true,addSentinel:TAG_ADD,onAdd:addTag});
});
$('rx-body').addEventListener('change',e=>{
  const el=e.target;
  const customPicklist=el.dataset.rxSelect==='role'&&el.value===ROLE_ADD
    ? {sentinel:ROLE_ADD,add:addRole}
    : el.dataset.rxSelect==='subject'&&el.value===SUBJECT_ADD
      ? {sentinel:SUBJECT_ADD,add:addSubject}
    : el.dataset.rxSelect==='prefix'&&el.value===PREFIX_ADD
      ? {sentinel:PREFIX_ADD,add:addPrefix}
    : el.dataset.rxSelect==='company_type'&&el.value===COMPANY_ADD
      ? {sentinel:COMPANY_ADD,add:addCompanyType}
    : el.dataset.rxSelect==='reference'&&el.value===REFERENCE_ADD
      ? {sentinel:REFERENCE_ADD,add:addReference}
    : el.dataset.rxSelect==='tags'&&el.value===TAG_ADD
      ? {sentinel:TAG_ADD,add:addTag}
      : null;
  if(customPicklist){
    const previous=el.dataset.rxPreviousValue;
    const added=customPicklist.add();
    if(added){
      if(![...el.options].some(option=>option.value===added))
        el.add(new Option(added,added),el.options.length-1);
      el.value=added;
    }else el.value=previous&&previous!==customPicklist.sentinel?previous:'';
    enhanceRxSelect(el);
  }
  if(el.dataset.rxSelect==='notesubject'){
    // Quick-pick: fill the Subject (or add a new preset), then reset the picker
    // to blank so it behaves like a menu rather than a stored value.
    if(el.value===NOTE_SUBJECT_ADD){
      const added=addNoteSubject();
      if(added){
        if(![...el.options].some(o=>o.value===added)) el.add(new Option(added,added),el.options.length-1);
        applyNoteSubject(added);
      }
    }else if(el.value){ applyNoteSubject(el.value); }
    el.value='';
    enhanceRxSelect(el);
  }
  if(el.matches('select[data-social-platform]')&&el.value===SOCIAL_ADD_PLATFORM){
    const previous=el.dataset.rxPreviousValue;
    const added=addSocialPlatform();
    if(added){
      if(![...el.options].some(option=>option.value===added))
        el.add(new Option(added,added),el.options.length-1);
      el.value=added;
    }else el.value=allSocials().includes(previous)?previous:'IG';
    enhanceRxSelect(el);
  }
  /* Site-info cascade: District follows Country, City follows District. Choosing
     a country repopulates its districts and clears the city; choosing a district
     repopulates its cities. A country not in GEO leaves both empty (no data to
     match), which is the honest state until that country's lists exist. */
  if(el.dataset.rxSelect==='country'){
    rxFillSelect('district',districtOptions(el.value),'');
    rxFillSelect('city',null,'');
  }
  if(el.dataset.rxSelect==='district'&&el.value===DISTRICT_ADD){ addDistrictAndSelect(el); }
  else if(el.dataset.rxSelect==='district'){
    const country=$('rx-country')&&$('rx-country').value;
    rxFillSelect('city',cityOptions(country,el.value),'');
  }
  if(el.dataset.rxSelect==='city'&&el.value===CITY_ADD){ addCityAndSelect(el); }
  if(el.id&&el.id.startsWith('rx-q-')){ rxTotals(); }
});
$('rx-body').addEventListener('input',e=>{ if(e.target.id&&e.target.id.startsWith('rx-q-')) rxTotals();
  if(e.target.dataset&&(e.target.dataset.k==='first'||e.target.dataset.k==='last')) queueContactMatches(e.target);
  if(e.target.dataset&&(e.target.dataset.k==='email'||e.target.dataset.rxEmail!==undefined)){
    const valid=validEmail(e.target.value);
    e.target.classList.toggle('email-invalid', !!e.target.value.trim()&&!valid);
    const button=e.target.closest('.draft-email')?.querySelector('[data-rx-compose]');
    if(button) button.hidden=!(valid&&e.target.value.trim());
  }
  if(e.target.dataset&&e.target.dataset.k==='maps') rxUpdateMapPreview(); });
$('rx-body').addEventListener('click',e=>{
  if(e.target.closest('#rx-use-location')){rxUseCurrentLocation();return;}
  if(e.target.closest('#rx-q-draft')) rxDraftQuotation();
});
/* Double-clicking the Quick-notes subject opens its preset dropdown — the same
   menu the chevron opens on a single click. openRxSelect anchors to the framed
   row, so it drops down across the whole field. */
$('rx-body').addEventListener('dblclick',e=>{
  if(e.target&&e.target.id==='rx-notes-subject'){
    const sel=$('rx-notesubject');
    if(sel&&sel._rxButton) openRxSelect(sel,sel._rxButton);
  }
});
/* Select-all lives on the # header. Ignore clicks that land on the resize grip,
   or dragging a column edge would also flip the whole selection. */
$('thead').addEventListener('click',e=>{
  if(e.target.closest('.rz')) return;
  if(e.target.closest('th[data-k="num"]')) toggleSelectAll();
});
$('thead').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ') return;
  if(!e.target.closest('th[data-k="num"]')) return;
  e.preventDefault(); toggleSelectAll();
});
$('rows').addEventListener('click',e=>{ const ccb=e.target.closest('.tel-cc'); if(ccb){ openCc(ccb); return; }
  const num=e.target.closest('td[data-select-row]'); if(num){ toggleRowSelection(num.closest('tr.selectable-row')); refreshDeleteButton(); return; }
  const a=e.target.closest('[data-add]'); if(a){ addBottomRow(); return; }
  const email=e.target.closest('[data-compose-email]'); if(email){ const tr=email.closest('tr'); const row=tr?ROWS.find(x=>x.id===tr.dataset.log):null; openEmailCompose(email.dataset.composeEmail,false,{log_id:tr&&tr.dataset.log||null,file_id:tr&&tr.dataset.file||null,contact_id:row&&row.contact_id||null}); return; }
  const draftEmail=e.target.closest('[data-draft-compose]'); if(draftEmail){const input=$(draftEmail.dataset.draftCompose);if(input&&validEmail(input.value)&&input.value.trim())openEmailCompose(input.value.trim());return;}
  const rm=e.target.closest('[data-rm]'); if(rm){ removeBottomRow(rm.getAttribute('data-rm')); return; }
  const ne=e.target.closest('.note-exp'); if(ne){
    const forId=ne.getAttribute('data-for');
    if(forId){ const inp=document.getElementById(forId); if(inp) openDraftNoteWorkspace(inp); return; }
    const ntd=ne.closest('td[data-k]');
    if(ntd){ const col=COLS.find(c=>c.k===ntd.dataset.k); if(col) openNoteWorkspace(ntd,col); }
    return; }
  const cp=e.target.closest('[data-copy]'); if(cp){ try{navigator.clipboard.writeText(cp.dataset.copy);}catch(_){} cp.classList.add('copied'); cp.innerHTML=SVG.check; setTimeout(()=>{cp.classList.remove('copied');cp.innerHTML=SVG.copy;},1000); return; }
  const draftMap=e.target.closest('[data-draft-map]'); if(draftMap){ const inp=$(draftMap.dataset.draftMap); if(inp) openMapsLocationPopup(inp); return; }
  const editMap=e.target.closest('[data-edit-map]'); if(editMap){ const mtd=editMap.closest('td[data-edit]'); if(mtd) openMapsLocationPopup(mtd); return; }
  const numTd=e.target.closest('td.num'); if(numTd && numTd.closest('tr.data')){ const tr=numTd.closest('tr.data'); toggleRowSelection(tr); refreshDeleteButton(); return; }
  const td=e.target.closest('td[data-edit]'); if(td && td.closest('tr.data')){ if(!e.target.closest('a,button')){ if(td.dataset.field==='maps_url') openMapsLocationPopup(td); else openEditor(td); } } });

/* ── country-code picker (real flag images; emoji flags don't render on Windows) ── */
let ccDrop=null, ccBtn=null;
function ensureCcDrop(){ if(ccDrop) return;
  ccDrop=document.createElement('div'); ccDrop.className='cc-drop';
  ccDrop.innerHTML=`<input class="cc-search" placeholder="Search country or code…"><div class="cc-list"></div>`;
  document.body.appendChild(ccDrop);
  ccDrop.querySelector('.cc-search').addEventListener('input',e=>renderCcList(e.target.value));
  ccDrop.addEventListener('mousedown',e=>{ const it=e.target.closest('.cc-item[data-iso]'); if(it){ e.preventDefault(); pickCc(it.dataset.iso,it.dataset.dial); } });
  document.addEventListener('mousedown',e=>{ if(ccDrop.classList.contains('vis') && !ccDrop.contains(e.target) && !e.target.closest('.tel-cc')) closeCc(); });
}
function renderCcList(q){ const t=(q||'').trim().toLowerCase();
  const rows=COUNTRIES.filter(c=>!t||c[1].toLowerCase().includes(t)||c[2].includes(t)||c[0]===t);
  ccDrop.querySelector('.cc-list').innerHTML = rows.length
    ? rows.map(c=>`<div class="cc-item" data-iso="${c[0]}" data-dial="${c[2]}"><img src="${flagSrc(c[0])}" alt=""><span class="cc-name">${esc(c[1])}</span><span class="cc-dial">${esc(c[2])}</span></div>`).join('')
    : `<div class="cc-item" style="cursor:default;opacity:.6">No match</div>`;
}
function openCc(btn){ ensureCcDrop(); ccBtn=btn;
  const s=ccDrop.querySelector('.cc-search'); s.value=''; renderCcList('');
  const r=btn.getBoundingClientRect();
  ccDrop.style.left=Math.max(8,Math.min(r.left,window.innerWidth-300))+'px';
  ccDrop.style.top=((r.bottom+290>window.innerHeight) ? Math.max(8,r.top-290) : r.bottom+4)+'px';
  ccDrop.classList.add('vis'); s.focus();
}
function closeCc(){ if(ccDrop) ccDrop.classList.remove('vis'); ccBtn=null; }
function pickCc(iso,dial){ if(!ccBtn) return;
  const dp=ccBtn.dataset.dp, st=dp?stateFor(dp):null;
  if(st){ st.iso=iso; st.dial=dial; }
  const rxPhone=ccBtn.dataset.rxPhone;
  const img=ccBtn.querySelector('img'); if(img) img.src=flagSrc(iso);
  const cc=ccBtn.querySelector('.cc'); if(cc) cc.textContent=dial;
  closeCc();
  const num=rxPhone?document.getElementById(rxPhone):document.getElementById(dp+'-mobile');
  if(num) num.focus();
}

/* ── Maps hover preview (ported from the tabbed grid) ── */
let mapsPopup=null, mapsTimer=null;
function ensureMapsPopup(){ if(mapsPopup)return; mapsPopup=document.createElement('div'); mapsPopup.className='maps-popup';
  mapsPopup.addEventListener('mouseenter',()=>clearTimeout(mapsTimer)); mapsPopup.addEventListener('mouseleave',()=>{mapsTimer=setTimeout(hideMapsPopup,150);}); document.body.appendChild(mapsPopup); }
function hideMapsPopup(){ if(mapsPopup) mapsPopup.classList.remove('vis'); }
function mapsCoords(url){ const pats=[/@(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,/\/maps\/search\/(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,/[?&]q=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/,/[?&]ll=(-?\d+\.?\d*),\+?(-?\d+\.?\d*)/];
  for(const p of pats){ const m=String(url||'').match(p); if(m) return {lat:parseFloat(m[1]),lng:parseFloat(m[2])}; } return null; }
function normalizeMapsUrl(value){
  const raw=String(value||'').trim(); if(!raw)return '';
  let candidate=raw;
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)){
    const lower=candidate.toLowerCase();
    if(!(lower.startsWith('www.google.')||lower.startsWith('google.')||lower.startsWith('maps.google.')||lower.startsWith('maps.app.goo.gl')||lower.startsWith('goo.gl/maps')))return '';
    candidate='https://'+candidate;
  }
  try{ const u=new URL(candidate),host=u.hostname.toLowerCase().replace(/^www\./,''),path=u.pathname.toLowerCase();
    if(!['http:','https:'].includes(u.protocol))return '';
    const valid=/^maps\.google\./.test(host)||(host==='google.com'&&path.includes('/maps'))||(host.endsWith('.google.com')&&path.includes('/maps'))||host==='maps.app.goo.gl'||(host==='goo.gl'&&path.startsWith('/maps'));
    return valid?u.href:'';
  }catch(_){return '';}
}
// measure rather than hardcode: the popup box changed width with the OSM embed,
// and a stale constant here silently mis-flips it at the viewport edge
function positionPopup(pop,anchor){ const r=anchor.getBoundingClientRect(); const pw=pop.offsetWidth||240, ph=pop.offsetHeight||190; let left=r.left, top=r.bottom+6;
  if(left+pw>window.innerWidth-8) left=window.innerWidth-pw-8; if(top+ph>window.innerHeight-8) top=r.top-ph-6;
  pop.style.left=Math.max(8,left)+'px'; pop.style.top=Math.max(8,top)+'px'; }
/* Map preview built from OSM raster tiles as <img>.
 *
 * NOT openstreetmap.org/export/embed.html: the app serves this page with
 * `frame-src 'self' blob: data:`, so any third-party <iframe> is blocked and the
 * preview renders blank. `img-src` allows any https, so tiles are the one thing
 * that actually draws here. Verify with:
 *   curl -sD- -o/dev/null localhost:8080/api/v1/achi/ui | grep -i frame-src
 *
 * Mercator: x is linear in longitude; y needs the log-tangent projection. The
 * point is placed at the box centre and the pin is drawn over it, since a tile
 * carries no marker of its own. */
function tileMap(lat,lng,W,H,z){
  const n=Math.pow(2,z);
  const wx=((lng+180)/360)*n*256;
  const s=Math.sin(lat*Math.PI/180);
  const wy=(0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*n*256;
  const tlX=wx-W/2, tlY=wy-H/2;
  let out='';
  for(let tx=Math.floor(tlX/256); tx*256<tlX+W; tx++){
    for(let ty=Math.floor(tlY/256); ty*256<tlY+H; ty++){
      if(ty<0||ty>=n) continue;
      const xx=((tx%n)+n)%n;
      out+=`<img class="mt-tile" src="/api/v1/achi/tile/${z}/${xx}/${ty}" style="left:${Math.round(tx*256-tlX)}px;top:${Math.round(ty*256-tlY)}px" alt="" loading="lazy">`;
    }
  }
  return `<div class="tilemap" style="width:${W}px;height:${H}px">${out}<span class="maps-pin">${SVG.pin}</span></div>`;
}
/* Set Location popup ported from frappe-bench's GridShell. The layout and
   interaction match _openMapsLocationPopup; only the preview renderer and save
   call use ACHI-native facilities. */
function openMapsLocationPopup(target){
  const existing=document.getElementById('pg-loc-popup');
  if(existing){ existing._gpsStop?.(); existing.remove(); }
  const isInput=target.tagName==='INPUT', initial=isInput?target.value:(target.dataset.val||'');
  const ov=document.createElement('div'); ov.id='pg-loc-popup'; ov.className='pg-modal-overlay pg-loc-overlay';
  ov.setAttribute('role','dialog'); ov.setAttribute('aria-modal','true'); ov.setAttribute('aria-label','Set Map Location');
  // Must sit above .rx (2147482500) when opened from Add Log, while remaining
  // below global feedback/error overlays (2147483000).
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147482900;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
  ov.innerHTML=`<div style="background:#fff;border-radius:12px;width:min(440px,calc(100vw - 32px));box-shadow:0 8px 40px rgba(0,0,0,.22);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#1e3f85,#2563eb);padding:18px 20px 14px;color:#fff;"><div style="font-size:14px;font-weight:700;margin-bottom:4px;">Set Map Location</div><div style="font-size:11.5px;opacity:.8;">Use your current GPS position or paste a link</div></div>
    <div style="padding:18px 20px;"><button id="pg-loc-use-gps" type="button" style="width:100%;height:40px;border:none;border-radius:10px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;"><svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M8 1.5C5.51 1.5 3.5 3.51 3.5 6c0 3.75 4.5 8.5 4.5 8.5s4.5-4.75 4.5-8.5c0-2.49-2.01-4.5-4.5-4.5zm0 6.1a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z" fill="currentColor"/></svg>Use My Current Location</button>
      <div style="font-size:11px;color:#9ca3af;text-align:center;margin-bottom:10px;">- or paste link manually -</div>
      <input id="pg-loc-manual" type="text" value="${esc(initial)}" placeholder="https://maps.google.com/…" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:8px;padding:8px 12px;font-size:12px;outline:none;">
      <div id="pg-loc-preview" style="display:none;margin-top:12px;border:1px solid #dce6f5;border-radius:12px;overflow:hidden;background:#f8fafc;"><div id="pg-loc-preview-map" style="display:block;width:100%;height:190px;overflow:hidden;"></div><div id="pg-loc-preview-label" style="padding:8px 11px;font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div></div></div>
    <div style="padding:0 20px 18px;display:flex;gap:8px;"><button id="pg-loc-cancel" type="button" style="flex:1;height:36px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;color:#374151;font-size:12px;cursor:pointer;">Cancel</button><button id="pg-loc-save" type="button" style="flex:2;height:36px;border:none;border-radius:8px;background:#1e3f85;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">Save Link</button></div>
    <div id="pg-loc-status" style="padding:0 20px 14px;font-size:11.5px;color:#6b7280;min-height:18px;"></div></div>`;
  document.body.appendChild(ov);
  const input=ov.querySelector('#pg-loc-manual'),preview=ov.querySelector('#pg-loc-preview'),map=ov.querySelector('#pg-loc-preview-map'),labelEl=ov.querySelector('#pg-loc-preview-label'),status=ov.querySelector('#pg-loc-status');
  const updatePreview=()=>{ const raw=input.value.trim(),url=normalizeMapsUrl(raw); if(!raw){preview.style.display='none';input.style.borderColor='#e2e8f0';status.textContent='';return;} if(!url){preview.style.display='none';input.style.borderColor='#ef4444';status.textContent='Please paste a valid Google Maps link.';return;} input.style.borderColor='#16a34a';const c=mapsCoords(url);if(!c){preview.style.display='none';status.textContent='Preview unavailable for this link';return;}preview.style.display='block';map.innerHTML=tileMap(c.lat,c.lng,map.clientWidth||400,190,15);labelEl.textContent=url;status.textContent='Map preview ready'; };
  let gpsStop=()=>{};
  ov._gpsStop=()=>gpsStop();
  const previewGpsPosition=position=>{
    const {latitude:lat,longitude:lng,accuracy}=position.coords;
    input.value=`https://www.google.com/maps?q=${lat.toFixed(7)},${lng.toFixed(7)}`;
    updatePreview();
    const metres=Number.isFinite(Number(accuracy))?Math.round(accuracy):null;
    status.textContent=`Current location received${metres===null?'':` — accuracy about ${metres} m`}. Confirm the pin, then click Save Link.`;
  };
  const close=()=>{ gpsStop(); ov.remove(); };
  const commit=async url=>{ try{ if(isInput){ const dp=target.dataset.dp,st=dp?stateFor(dp):null; if(st)st.maps=url;target.value=url;target.dispatchEvent(new Event('input',{bubbles:true})); }
      else { const tr=target.closest('tr'),fileId=tr.dataset.file;await api('/files/'+fileId,{method:'PATCH',body:JSON.stringify({maps_url:url})});ROWS.forEach(r=>{if(r.file_id===fileId)r.maps_url=url;});target.dataset.val=url;refreshCell(target); }
      clearErr();close();
    }catch(e){status.textContent=e.message||'Save failed. Please try again.';} };
  const useCurrentLocation=()=>{
    const gpsBtn=ov.querySelector('#pg-loc-use-gps');
    if(!window.isSecureContext){ status.textContent='Current location requires HTTPS or localhost.'; return; }
    if(!navigator.geolocation){ status.textContent='Current location is not supported by this browser.'; return; }
    gpsStop();
    gpsBtn.disabled=true; gpsBtn.textContent='Getting current location…';
    status.textContent='Allow location access. The preview will update if a more accurate position arrives.';
    let best=null,settled=false,watchId=null,timer=null;
    const stop=()=>{
      if(watchId!==null) navigator.geolocation.clearWatch(watchId);
      if(timer!==null) clearTimeout(timer);
      watchId=null; timer=null;
    };
    gpsStop=stop;
    const reset=message=>{
      settled=true; stop();
      gpsBtn.disabled=false; gpsBtn.textContent='Use My Current Location';
      if(message) status.textContent=message;
    };
    watchId=navigator.geolocation.watchPosition(position=>{
      if(settled)return;
      const accuracy=Number(position.coords.accuracy);
      if(!Number.isFinite(position.coords.latitude)||!Number.isFinite(position.coords.longitude))return;
      const bestAccuracy=best?Number(best.coords.accuracy):NaN;
      if(!best||!Number.isFinite(bestAccuracy)||(Number.isFinite(accuracy)&&accuracy<bestAccuracy))best=position;
      previewGpsPosition(best);
      if(accuracy<=50){
        reset(`Current location received — accuracy about ${Math.round(accuracy)} m. Confirm the pin, then click Save Link.`);
      }
    },error=>{
      if(settled)return;
      if(error.code===1)reset('Location permission was denied. Allow it in browser settings and try again.');
      else if(!best) status.textContent='Still waiting for a location from this device…';
    },{enableHighAccuracy:true,timeout:20000,maximumAge:0});
    timer=setTimeout(()=>{
      if(settled)return;
      if(best){
        previewGpsPosition(best);
        const accuracy=Number(best.coords.accuracy);
        reset(`Best location available${Number.isFinite(accuracy)?` — accuracy about ${Math.round(accuracy)} m`:''}. Confirm the pin, then click Save Link.`);
        return;
      }
      reset('No location was received. Enable location services or paste the Maps link.');
    },21000);
  };
  ov.querySelector('#pg-loc-use-gps').onclick=useCurrentLocation;
  ov.querySelector('#pg-loc-save').onclick=()=>{ const raw=input.value.trim(),url=normalizeMapsUrl(raw);if(!raw){status.textContent='Please enter a Maps URL or use GPS.';return;}if(!url){status.textContent='Please paste a valid Google Maps link.';input.style.borderColor='#ef4444';input.focus();input.select();return;}commit(url); };
  ov.querySelector('#pg-loc-cancel').onclick=close;ov.onmousedown=e=>{if(e.target===ov)close();};ov.onkeydown=e=>{e.stopPropagation();if(e.key==='Escape')close();else if(e.key==='Enter'){e.preventDefault();ov.querySelector('#pg-loc-save').click();}};input.oninput=updatePreview;if(initial)updatePreview();requestAnimationFrame(()=>input.focus());
}
function showMapsPopup(anchor,url){ ensureMapsPopup(); const c=mapsCoords(url);
  if(c){ mapsPopup.innerHTML=`<div class="maps-popup-inner">`
      +tileMap(c.lat,c.lng,248,160,15)
      +`<button type="button" class="popup-expand" data-mapexp data-lat="${c.lat}" data-lng="${c.lng}" title="Expand map">${SVG.expand}</button>`
      +`</div><div class="maps-popup-url">${esc(url)}</div>`; }
  else { mapsPopup.innerHTML=`<div class="maps-popup-fallback">${esc(url)}</div>`; }
  mapsPopup.classList.add('vis'); positionPopup(mapsPopup,anchor); }
/* Expand modal (upstream _openExpandModal, type "maps"): same embed at a wider
   bbox. Reuses the note workspace's overlay so there is one modal style. */
function openMapModal(lat,lng){
  document.querySelector('.pg-note-workspace')?.remove();
  hideMapsPopup();
  const ov=document.createElement('div');
  ov.className='pg-note-workspace'; ov.setAttribute('role','dialog'); ov.setAttribute('aria-modal','true');
  ov.innerHTML=`<div class="pg-note-workspace-box" style="width:min(760px,calc(100vw - 32px))">
    <div class="pg-note-workspace-head"><div class="pg-note-workspace-title">Map Preview</div>
      <div class="pg-note-workspace-head-actions"><button type="button" class="pg-note-workspace-close" data-mapclose aria-label="Close">&times;</button></div></div>
    <div class="map-modal-body">${tileMap(lat,lng,700,460,16)}</div>
  </div>`;
  const close=()=>{ ov.remove(); document.removeEventListener('keydown',onKey,true); };
  const onKey=e=>{ if(e.key==='Escape'){ e.stopPropagation(); close(); } };
  ov.addEventListener('mousedown',e=>{ if(e.target===ov||e.target.closest('[data-mapclose]')) close(); });
  document.addEventListener('keydown',onKey,true);
  document.body.appendChild(ov);
}
$('rows').addEventListener('mouseover',e=>{ const b=e.target.closest('.maps-btn'); if(b){ clearTimeout(mapsTimer); showMapsPopup(b,b.dataset.mapurl); } });
$('rows').addEventListener('mouseout',e=>{ const b=e.target.closest('.maps-btn'); if(b){ mapsTimer=setTimeout(hideMapsPopup,150); } });

/* The Description column previews its complete note on hover without changing
   table row height. Keep the card outside .tscroll so it is not clipped. */
const DESC_HOVER_DELAY=1000;
const DESC_HOVER_BRIDGE_DELAY=150;
let descHoverCard=null, descHoverTimer=0, descShowTimer=0, descHoverUrls=[];
function hideDescHover(){
  clearTimeout(descHoverTimer); clearTimeout(descShowTimer);
  descHoverUrls.forEach(URL.revokeObjectURL); descHoverUrls=[];
  if(descHoverCard){ descHoverCard.remove(); descHoverCard=null; }
}
function scheduleDescHoverHide(delay=0){
  clearTimeout(descHoverTimer);
  if(delay>0) descHoverTimer=setTimeout(hideDescHover,delay);
  else hideDescHover();
}
async function showDescHover(td){
  const value=td.dataset.val||'';
  if(!value.trim()||td.querySelector('input,textarea')) return;
  hideDescHover();
  const card=document.createElement('div');
  card.className='desc-hover-card';
  card.setAttribute('role','tooltip');
  card.innerHTML=`<div class="desc-hover-body">${looksHTML(value)?richText(value):esc(value)}</div><div class="desc-hover-files"></div>`;
  document.body.appendChild(card);
  card.addEventListener('mouseenter',()=>clearTimeout(descHoverTimer));
  card.addEventListener('mouseleave',()=>scheduleDescHoverHide());
  const r=td.getBoundingClientRect(), cr=card.getBoundingClientRect(), gap=8;
  let left=Math.min(Math.max(gap,r.left),window.innerWidth-cr.width-gap);
  let top=r.bottom+gap;
  if(top+cr.height>window.innerHeight-gap) top=Math.max(gap,r.top-cr.height-gap);
  card.style.left=Math.round(left)+'px';
  card.style.top=Math.round(top)+'px';
  descHoverCard=card;

  const logId=td.closest('tr')?.dataset.log;
  if(!logId) return;
  try{
    const files=await api(`/logs/${logId}/attachments`);
    if(descHoverCard!==card||!card.isConnected) return;
    const tray=card.querySelector('.desc-hover-files');
    // Our own gallery tiles (thumbnail: image / PDF page 1 / DWG linework / 3D
    // placeholder; click opens it in the right editor). noPop = no nested hover
    // popover, since this card is itself a hover popover.
    tray.innerHTML='';
    files.forEach(f=>tray.appendChild(attachmentTile(f,null,true)));
    const next=card.getBoundingClientRect();
    if(top+next.height>innerHeight-gap) card.style.top=Math.max(gap,r.top-next.height-gap)+'px';
  }catch(_){}
}
$('rows').addEventListener('mouseover',e=>{
  const td=e.target.closest('tr.data td.notecell[data-k="desc"]');
  if(td&&!td.contains(e.relatedTarget)){
    clearTimeout(descHoverTimer); clearTimeout(descShowTimer);
    descShowTimer=setTimeout(()=>showDescHover(td),DESC_HOVER_DELAY);
  }
});
$('rows').addEventListener('mouseout',e=>{
  const td=e.target.closest('tr.data td.notecell[data-k="desc"]');
  if(td&&!td.contains(e.relatedTarget)){
    clearTimeout(descShowTimer);
    if(descHoverCard) scheduleDescHoverHide(DESC_HOVER_BRIDGE_DELAY);
  }
});
$('touter').addEventListener('scroll',hideDescHover);
window.addEventListener('resize',hideDescHover);
// the popup is appended to document.body, so the grid's delegation never sees it
document.addEventListener('click',e=>{ const x=e.target.closest&&e.target.closest('[data-mapexp]');
  if(x){ e.preventDefault(); openMapModal(parseFloat(x.dataset.lat),parseFloat(x.dataset.lng)); } });

/* ── shortcut: Shift+R adds a row ──────────────────────────────────────────
 * Ported from erp_next_custom/public/js/core/grid/tabbed_grid.js
 * (_installAddRowShortcut). Same contract: one document-level capture-phase
 * listener that CLICKS the visible "+" button rather than calling addBottomRow()
 * directly, so the shortcut and the mouse share one code path. Accepts the
 * physical KeyR as well as the produced "r"/"R" so it survives non-QWERTY layouts.
 */
function isTypingTarget(t){
  if(!t) return false;
  if(t.isContentEditable) return true;
  const tag=(t.tagName||'').toUpperCase();
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return true;
  return !!(t.closest && t.closest('input,textarea,select,[contenteditable]'));
}
document.addEventListener('keydown',e=>{
  if(!e.shiftKey||e.ctrlKey||e.metaKey||e.altKey) return;                 // plain Shift+R only
  if(e.code!=='KeyR' && String(e.key||'').toLowerCase()!=='r') return;    // layout-proof
  if(e.repeat) return;                                                    // ignore held-key repeat
  if(isTypingTarget(e.target)) return;                                    // not while typing a draft cell
  if($('rows').querySelector('.cellinput')) return;                       // not while an inline editor is open
  const btn=$('add-row');
  if(!btn) return;
  e.preventDefault(); e.stopPropagation();
  btn.click();
},true);
/* ── inline editor for existing rows (single-cell, no re-render, Enter advances) ── */
function nextEditableInRow(td){ let n=td.nextElementSibling; while(n){ if(n.hasAttribute('data-edit')) return n; n=n.nextElementSibling; } return null; }
function refreshCell(td){ const tr=td.closest('tr'); const r=ROWS.find(x=>x.id===tr.dataset.log); const c=COLS.find(x=>x.k===td.dataset.k); if(r&&c){ td.innerHTML=cellHTML(c,r,+tr.dataset.i); } }
function selectPopupChoices(kind){
  if(kind==='status') return STATUSES.map(value=>({value,label:label(value)}));
  if(kind==='stage') return GL_STAGE_PIPELINE.map(value=>({value,label:glStageLabel(value),color:GL_STAGE_COLOR[value]}));
  if(kind==='comm') return ['','Call','Email','WhatsApp','In-person','Other'].map(value=>({value,label:value||'—'}));
  /* Blank first: these are optional, and without it a row could not be cleared
     once set. Values are shown verbatim — they are proper nouns, not the
     snake_case the other lists carry. */
  if(kind==='role')     return ['',...ROLES].map(value=>({value,label:value||'—'}));
  if(kind==='subject')  return ['',...SUBJECTS].map(value=>({value,label:value||'—'}));
  if(kind==='district') return ['',...DISTRICTS].map(value=>({value,label:value||'—'}));
  if(kind==='city')     return ['',...CITIES].map(value=>({value,label:value||'—'}));
  if(kind==='country')  return ['',...COUNTRY_NAMES].map(value=>({value,label:value||'—'}));
  if(kind==='type') return [...allTypes(),TYPE_ADD].map(value=>({value,label:value===TYPE_ADD?'＋ Add new…':value}));
  if(kind==='tags') return ['',...allTags(),TAG_ADD].map(value=>({value,label:value===TAG_ADD?'＋ Add Tag':(value||'—')}));
  if(kind==='category') return ['',...CATEGORIES].map(value=>({value,label:value?label(value):'—'}));
  const removable=new Set(customPrefixes().filter(value=>!PREFIXES.includes(value)));
  return ['',...allPrefixes(),PREFIX_ADD].map(value=>({
    value,
    label:value===PREFIX_ADD?'＋ Add new…':value||'—',
    removable:removable.has(value)
  }));
}
function openSelectPopup(td,el,choices,onPick,opts){
  opts=opts||{};
  document.querySelector('.pg-ac-drop')?.remove();
  const drop=document.createElement('div'); drop.className='pg-ac-drop'; document.body.appendChild(drop);
  const placeDrop=()=>{const r=td.getBoundingClientRect(),maxH=Math.min(260,(choices.length+1)*32),below=innerHeight-r.bottom-8,top=below>=Math.min(maxH,120)?r.bottom+2:Math.max(8,r.top-maxH-2);drop.style.left=Math.max(8,Math.min(r.left,innerWidth-r.width-8))+'px';drop.style.top=top+'px';drop.style.minWidth=r.width+'px';drop.style.maxWidth=Math.max(r.width,innerWidth-16)+'px';};
  // Multi-select mode (tags): toggle several; the popup stays open. Selection is
  // kept comma-joined in el.value / el.dataset.selectValue; onPick fires with the
  // joined string on every change. mousedown+preventDefault keeps focus on the
  // cell so a click doesn't blur-close the editor mid-selection.
  if(opts.multi){
    const addSentinel=opts.addSentinel, onAdd=opts.onAdd;
    const selected=new Set(String(el.dataset.selectValue||el.value||'').split(',').map(s=>s.trim()).filter(Boolean));
    const commit=()=>{const j=[...selected].join(',');el.dataset.selectValue=j;el.value=j;onPick(j);};
    const render=()=>{drop.innerHTML='';choices.forEach(o=>{
      const isAdd=(o.value===addSentinel);
      const item=document.createElement('div');item.className='pg-ac-item'+((!isAdd&&selected.has(o.value))?' pg-ac-selected':'');
      const text=document.createElement('span');text.className='pg-ac-item-label';text.textContent=isAdd?o.label:((selected.has(o.value)?'✓ ':'')+o.label);item.appendChild(text);
      item.onmousedown=e=>{e.preventDefault();
        if(isAdd){const added=onAdd&&onAdd();if(added){if(!choices.some(c=>c.value===added))choices.splice(choices.length-1,0,{value:added,label:added});selected.add(added);commit();render();}return;}
        if(selected.has(o.value))selected.delete(o.value);else selected.add(o.value);commit();render();};
      drop.appendChild(item);});
      drop.style.display='block';placeDrop();};
    el.onclick=()=>render();drop.onwheel=e=>e.stopPropagation();
    el.onkeydown=e=>{if(e.key==='Escape'||e.key==='Enter'||e.key==='Tab'){e.preventDefault();e.stopPropagation();drop.remove();}};
    el.addEventListener('blur',()=>setTimeout(()=>drop.remove(),180),{once:true});
    render();return;
  }
  let active=Math.max(0,choices.findIndex(o=>o.value===(el.dataset.selectValue??el.value)));
  const place=()=>{const r=td.getBoundingClientRect(),maxH=Math.min(220,choices.length*32),below=innerHeight-r.bottom-8,top=below>=Math.min(maxH,120)?r.bottom+2:Math.max(8,r.top-maxH-2);drop.style.left=Math.max(8,Math.min(r.left,innerWidth-r.width-8))+'px';drop.style.top=top+'px';drop.style.minWidth=r.width+'px';drop.style.maxWidth=Math.max(r.width,innerWidth-16)+'px';};
  const render=(scroll=false)=>{drop.innerHTML='';choices.forEach((o,i)=>{
    const item=document.createElement('div');item.className='pg-ac-item'+(i===active?' pg-ac-active':'');
    // Stage options carry a colour: show it as a leading dot so the menu matches
    // the cell's coloured dot (photo #1).
    if(o.color){const dot=document.createElement('span');dot.className='pg-ac-dot';dot.style.background=o.color;item.appendChild(dot);}
    const text=document.createElement('span');text.className='pg-ac-item-label';text.textContent=o.label;item.appendChild(text);
    if(o.removable){
      const remove=document.createElement('button');remove.type='button';remove.className='pg-ac-delete';remove.textContent='×';remove.title='Delete';remove.setAttribute('aria-label',`Delete ${o.label}`);
      remove.onmousedown=e=>{e.preventDefault();e.stopPropagation();if(!removePrefix(o.value))return;choices.splice(i,1);if(active>=choices.length)active=Math.max(0,choices.length-1);render();};
      item.appendChild(remove);
    }
    item.onmousedown=e=>{if(e.target.closest('.pg-ac-delete'))return;e.preventDefault();drop.remove();onPick(o.value);};drop.appendChild(item);
  });drop.style.display='block';place();if(scroll)drop.querySelector('.pg-ac-active')?.scrollIntoView({block:'nearest'});};
  const move=d=>{active=(active+d+choices.length)%choices.length;render(true);};
  el.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();move(e.key==='ArrowDown'?1:-1);}else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();e.stopPropagation();const o=choices[active];if(o){drop.remove();onPick(o.value);}}else if(e.key==='Escape'){e.stopPropagation();drop.remove();}};
  el.onclick=()=>render(true); drop.onwheel=e=>e.stopPropagation();
  el.addEventListener('blur',()=>setTimeout(()=>drop.remove(),180),{once:true});
  render(true);
}
function openEditor(td){
  if(td.querySelector('input,select')) return;
  const col=COLS.find(c=>c.k===td.dataset.k);
  // long-text cells edit inline like any other; the ⤢ arrow opens the full workspace
  const kind=td.dataset.kind, val=td.dataset.val||'', field=td.dataset.field, target=td.dataset.target;
  const tr=td.closest('tr'), logId=tr.dataset.log, fileId=tr.dataset.file;
  let el;

  if(field==='mobile'){
    const raw=String(val||'').trim();
    let iso=DEFAULT_ISO, dial=DEFAULT_DIAL, num='';
    for(const [cIso,_,cDial] of COUNTRIES){
      if(raw.startsWith(cDial)){ iso=cIso; dial=cDial; num=raw.slice(cDial.length).trim(); break; }
    }
    if(!num && raw.startsWith('+')){
      const m=raw.match(/^\+(\d{1,3})/);
      if(m){ dial='+'+m[1]; num=raw.slice(m[0].length).trim(); }
    }
    if(!num) num=raw.replace(/^\+\d{1,3}/,'').trim();
    const wrap=document.createElement('div'); wrap.className='tel-wrap';
    const ccBtn=document.createElement('button'); ccBtn.type='button'; ccBtn.className='tel-cc'; ccBtn.dataset.dp='mobile-inline';
    ccBtn.innerHTML=`<img src="${flagSrc(iso)}" alt=""><span class="cc">${esc(dial)}</span>${SVG.chev}`;
    el=document.createElement('input'); el.className='cellinput tel-num'; el.type='text'; el.value=num; el.placeholder='70 123 456';
    wrap.appendChild(ccBtn); wrap.appendChild(el); td.innerHTML=''; td.appendChild(wrap);
    el.focus(); el.select();
    let ran=false;
    const finish=async(save,advance)=>{ if(ran)return;
      const cc=(ccBtn.querySelector('.cc')?.textContent||DEFAULT_DIAL).trim()||DEFAULT_DIAL;
      const nv=save?`${cc}${el.value.trim().replace(/[^\d]/g,'')}`:val;
      if(save&&field==='email'&&!validEmail(nv)){showInvalidEmail(el);return;}
      ran=true;
      if(save && nv!==val){ try{
        if(target==='file'){ await api('/files/'+fileId,{method:'PATCH',body:JSON.stringify({[field]:nv||null})}); }
        else if(target==='contact'){ await api('/files/'+fileId+'/contact',{method:'PATCH',body:JSON.stringify({[field]:nv||null})}); }
        else { await api('/logs/'+logId,{method:'PATCH',body:JSON.stringify({[field]:nv||null})}); }
        ROWS.forEach(r=>{ if((target==='log'&&r.id===logId)||(target!=='log'&&r.file_id===fileId)) r[field]=nv; });
        td.dataset.val=nv; clearErr(); stats();
      }catch(e){ fail(e.message); } }
      refreshCell(td);
      if(advance){ const nx=nextEditableInRow(td); if(nx){ nx.scrollIntoView({inline:'center',block:'nearest'}); openEditor(nx); } }
    };
    el.addEventListener('blur',e=>{ if(e.relatedTarget && (e.relatedTarget.closest('.tel-cc')||e.relatedTarget.closest('.cc-drop'))) return; finish(true,false); });
    el.addEventListener('keydown',ev=>{ if(ev.key==='Enter'){ev.preventDefault();finish(true,true);} else if(ev.key==='Escape'){ran=true;refreshCell(td);} });
    return;
  }

  const frappeSelect=kind==='stage'||kind==='comm'||kind==='status'||kind==='type'||kind==='category'||kind==='prefix'||kind==='tags';
  if(frappeSelect){ el=document.createElement('input');el.type='text';el.readOnly=true;el.className='cellinput pg-select-input';el.dataset.selectValue=val;el.value=kind==='stage'?glStageLabel(val):((kind==='category'||kind==='type'||kind==='status')?label(val):val); }
  else { el=document.createElement('input'); el.className='cellinput'; el.type=field==='email'?'email':kind==='date'?'date':'text'; el.value=val; }
  td.innerHTML=''; td.appendChild(el); el.focus();
  if(el.tagName==='SELECT'){ try{ el.showPicker(); }catch(e){} }   // open on one click
  else if(el.select){ el.select(); }
  let ran=false;
  const finish=async(save,advance)=>{ if(ran)return;
    // window.prompt() blurs the select, which would otherwise commit the "＋ Add
    // new…" sentinel as a real prefix. Refuse it and leave the editor open.
    if(el.value===PREFIX_ADD) return;
    const nv=frappeSelect?(el.dataset.selectValue||''):el.value;
    if(save&&field==='mobile'&&!validMobile(nv)){showInvalidMobile(el);return;}
    if(save&&field==='email'&&!validEmail(nv)){showInvalidEmail(el);return;}
    ran=true;
    if(save && nv!==val){ try{
      if(target==='file'){ await api('/files/'+fileId,{method:'PATCH',body:JSON.stringify({[field]:nv||null})}); }
      else if(target==='contact'){ await api('/files/'+fileId+'/contact',{method:'PATCH',body:JSON.stringify({[field]:nv||null})}); }
      else { await api('/logs/'+logId,{method:'PATCH',body:JSON.stringify({[field]:nv||null})}); }
      // mirror into the local row (contact/file fields shared across a file's logs)
      ROWS.forEach(r=>{ if((target==='log'&&r.id===logId)||(target!=='log'&&r.file_id===fileId)) r[field]=nv; });
      td.dataset.val=nv; clearErr(); stats();
    }catch(e){ fail(e.message); } }
    refreshCell(td);
    if(advance){ const nx=nextEditableInRow(td); if(nx){ nx.scrollIntoView({inline:'center',block:'nearest'}); openEditor(nx); } }
  };
  el.addEventListener('blur',()=>finish(true,false));
  el.addEventListener('keydown',ev=>{ if(ev.key==='Enter'){ev.preventDefault();finish(true,true);} else if(ev.key==='Escape'){ran=true;refreshCell(td);} });
  if(el.tagName==='SELECT') el.addEventListener('change',()=>{
    if(kind==='prefix' && el.value===PREFIX_ADD){
      const v=addPrefix(); el.innerHTML=prefixOpts(v||val); el.value=v||val; el.focus(); return; }
    finish(true,false); });
  if(frappeSelect && kind==='tags'){   // several tags; saved on blur (finish reads el.value)
    openSelectPopup(td,el,selectPopupChoices('tags'),()=>{},{multi:true,addSentinel:TAG_ADD,onAdd:addTag});
  } else if(frappeSelect) openSelectPopup(td,el,selectPopupChoices(kind),value=>{
    if(kind==='prefix'&&value===PREFIX_ADD){const added=addPrefix();if(!added){ran=true;refreshCell(td);return;}value=added;}
    if(kind==='type'&&value===TYPE_ADD){const added=addType();if(!added){ran=true;refreshCell(td);return;}value=added;}
    el.dataset.selectValue=value;el.value=kind==='stage'?glStageLabel(value):((kind==='category'||kind==='type'||kind==='status')?label(value):value);finish(true,false);
  });
}

/* ── description popup: notes + files + drawing ──────────────────────────
   Ported from the frappe grid's note workspace so the two look and behave the
   same. Simpler here in one way: this only ever opens on a saved row, so there
   is none of frappe's "persist the draft first" dance — the log id already
   exists by the time a cell is clickable. */
function openNoteWorkspace(td,col){
  const tr=td.closest('tr'), logId=tr.dataset.log, field=td.dataset.field;
  const row=ROWS.find(r=>r.id===logId)||{};
  const oldVal=td.dataset.val||'';
  let editorBaseline=richTextToPlain(oldVal);
  const pendingFiles=[];
  let attached=[], saving=false;

  document.querySelector('.pg-note-workspace')?.remove();

  const ov=document.createElement('div');
  ov.className='pg-note-workspace'; ov.setAttribute('role','dialog'); ov.setAttribute('aria-modal','true');
  ov.innerHTML=`
    <div class="pg-note-workspace-box">
      <div class="pg-note-workspace-head">
        <div><div class="pg-note-workspace-title">${esc(col.h)}</div><div class="pg-note-workspace-sub">Notes, documents, PDFs, images, and drawing</div></div>
        <div class="pg-note-workspace-head-actions">
          <button type="button" class="pg-note-head-tool pg-note-upload"><span>&#128206;</span> Files</button>
          <button type="button" class="pg-note-head-tool pg-note-drawing"><span>&#9998;</span> Drawing</button>
          <button type="button" class="pg-note-workspace-close" aria-label="Close">&times;</button>
        </div>
      </div>
      <div class="pg-note-workspace-body">
        <label class="pg-note-workspace-label">Notes</label>
        <textarea class="pg-note-workspace-text" placeholder="Add your notes here…">${esc(editorBaseline)}</textarea>
        <div class="pg-note-files"></div>
        <div class="pg-note-workspace-status"></div>
      </div>
      <div class="pg-note-workspace-foot">
        <div class="pg-note-workspace-hint">Enter saves and continues &middot; Shift+Enter adds a line</div>
        <div class="pg-note-workspace-actions"><button type="button" class="pg-note-cancel">Cancel</button><button type="button" class="pg-note-save">Save &amp; Continue</button></div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q=s=>ov.querySelector(s);
  const ta=q('.pg-note-workspace-text'), filesEl=q('.pg-note-files'), statusEl=q('.pg-note-workspace-status'),
        saveBtn=q('.pg-note-save'), drawBtn=q('.pg-note-drawing');
  const close=()=>ov.remove();

  function renderFiles(){
    // Uploaded attachments are compact tiles in a horizontal strip (hover to
    // preview); pending (unsaved) files stay simple rows — no id to preview yet.
    filesEl.innerHTML='';
    if(attached.length){
      const strip=document.createElement('div'); strip.className='att-strip';
      attached.forEach(f=>strip.appendChild(attachmentTile(f,'data-del')));
      filesEl.appendChild(strip);
    }
    pendingFiles.forEach((f,i)=>{
      const d=document.createElement('div'); d.className='pg-note-file';
      d.innerHTML=`<span>${esc(f.name)}</span><span class="pg-note-file-right"><span class="pg-note-file-pending">Ready to upload</span><button type="button" class="pg-note-file-del" data-pending="${i}" title="Remove">&times;</button></span>`;
      filesEl.appendChild(d);
    });
    if(!attached.length&&!pendingFiles.length) filesEl.innerHTML='<div class="pg-note-file"><span>No files attached yet</span></div>';
  }
  const fmtSize=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B';

  /* The API is bearer-only — there is no cookie session, so a plain href would
     401. Fetch the bytes with the token and hand the browser a blob instead. */
  async function openAttachment(id,name){
    const ext=(name||'').split('.').pop().toLowerCase();
    // Download-or-open: PDFs/images preview in a tab; everything else downloads
    // with its real name to open in the right desktop app.
    const download=async()=>{
      const r=await fetch(`${API}/attachments/${id}/download`,{headers:{Authorization:'Bearer '+TOKEN}});
      if(!r.ok) throw new Error('Could not open the file');
      const blob=await r.blob(), url=URL.createObjectURL(blob);
      const canPreview=(blob.type==='application/pdf')||blob.type.startsWith('image/')
        ||['pdf','png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext);
      if(canPreview){ window.open(url,'_blank','noreferrer'); }
      else { const a=document.createElement('a'); a.href=url; a.download=name||'file'; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    };
    // Previewable files (DWG/DXF/RVT/IFC) are shown as inline cards by the file-
    // list click handlers; a direct openAttachment call just downloads/opens.
    return download();
  }

  async function loadFiles(){
    try{ attached=await api(`/logs/${logId}/attachments`); if(ov.isConnected) renderFiles(); }
    catch(e){ statusEl.textContent=e.message; }
  }

  async function persistNote(){
    const nv=ta.value;
    // Viewing notes or managing files must not flatten stored rich text. Replace
    // it with plain text only when the user actually changes the textarea.
    if(nv===editorBaseline) return td.dataset.val||oldVal;
    await api('/logs/'+logId,{method:'PATCH',body:JSON.stringify({[field]:nv})});
    td.dataset.val=nv;
    ROWS.forEach(r=>{ if(r.id===logId) r[field]=nv; });
    editorBaseline=nv;
    return nv;
  }

  async function saveAndContinue(){
    if(saving) return;
    saving=true; saveBtn.disabled=true; drawBtn.disabled=true; statusEl.textContent='Saving…';
    try{
      await persistNote();
      if(pendingFiles.length){
        statusEl.textContent=`Uploading ${pendingFiles.length} file${pendingFiles.length===1?'':'s'}…`;
        for(const f of pendingFiles){
          const fd=new FormData(); fd.append('file',f,f.name);
          const r=await fetch(`${API}/logs/${logId}/attachments`,{method:'POST',headers:{Authorization:'Bearer '+TOKEN},body:fd});
          if(!r.ok){ const b=await r.json().catch(()=>({})); throw new Error(b.detail||`Could not upload ${f.name}`); }
        }
        const row=ROWS.find(r=>r.id===logId);
        if(row) row.attachment_count=(row.attachment_count||0)+pendingFiles.length;
        pendingFiles.length=0;
      }
      clearErr(); close(); refreshCell(td);
      const nx=nextEditableInRow(td);
      if(nx){ nx.scrollIntoView({inline:'center',block:'nearest'}); openEditor(nx); }
    }catch(e){
      saving=false; saveBtn.disabled=false; drawBtn.disabled=false;
      statusEl.textContent=e.message||'Save failed. Please try again.';
    }
  }

  q('.pg-note-upload').addEventListener('click',()=>{
    const inp=document.createElement('input');
    inp.type='file'; inp.multiple=true; inp.accept='.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.dwg,.dxf,.rvt,.ifc,image/*';
    inp.addEventListener('change',()=>{ pendingFiles.push(...Array.from(inp.files||[])); renderFiles(); },{once:true});
    inp.click();
  });

  filesEl.addEventListener('click',async e=>{
    const link=e.target.closest('[data-open]');
    if(link){ e.preventDefault();
      const nm=link.dataset.name||link.textContent;
      if(isPreviewable(nm)){ cadPreview(link.dataset.open, nm, link.closest('.pg-note-file')); return; }
      try{ await openAttachment(link.dataset.open, nm); }catch(err){ statusEl.textContent=err.message; }
      return; }
    const btn=e.target.closest('[data-del],[data-pending]'); if(!btn) return;
    if(btn.dataset.pending!==undefined){ pendingFiles.splice(+btn.dataset.pending,1); renderFiles(); return; }
    const id=btn.dataset.del; btn.disabled=true;
    try{
      const r=await fetch(`${API}/attachments/${id}`,{method:'DELETE',headers:{Authorization:'Bearer '+TOKEN}});
      if(!r.ok) throw new Error('Could not remove the file');
      attached=attached.filter(f=>f.id!==id); renderFiles();
      const row=ROWS.find(x=>x.id===logId); if(row) row.attachment_count=attached.length;
    }catch(err){ btn.disabled=false; statusEl.textContent=err.message; }
  });

  drawBtn.addEventListener('click',async()=>{
    if(saving) return;
    if(typeof achi_drawing==='undefined'){ statusEl.textContent='Drawing tool is unavailable.'; return; }
    saving=true; drawBtn.disabled=true; saveBtn.disabled=true; statusEl.textContent='Preparing drawing…';
    let initial='';
    try{ await persistNote(); initial=(await api(`/logs/${logId}/drawing`)).drawing||''; }
    catch(e){ statusEl.textContent=e.message||'Could not open the drawing.'; drawBtn.disabled=false; saveBtn.disabled=false; saving=false; return; }
    ov.style.display='none';   // hidden, not destroyed: the notes come back untouched
    achi_drawing.open({
      title:`Drawing — ${col.h}`,
      initial,
      async onSave(json,hasShapes){
        await api('/logs/'+logId,{method:'PATCH',body:JSON.stringify({drawing:json})});
        const row=ROWS.find(r=>r.id===logId); if(row) row.has_drawing=hasShapes?1:0;
        drawBtn.classList.toggle('has-content',!!hasShapes);
        statusEl.textContent=hasShapes?'Drawing saved.':'Drawing cleared.';
      },
      onClose(){
        if(!ov.isConnected) return;
        ov.style.display='flex'; drawBtn.disabled=false; saveBtn.disabled=false; saving=false;
        requestAnimationFrame(()=>ta.focus());
      },
    });
  });

  q('.pg-note-workspace-close').addEventListener('click',close);
  q('.pg-note-cancel').addEventListener('click',close);
  ov.addEventListener('mousedown',e=>{ if(e.target===ov) close(); });
  ta.addEventListener('keydown',e=>{ e.stopPropagation();
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); saveAndContinue(); } });
  ov.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.stopPropagation(); close(); } });
  saveBtn.addEventListener('click',saveAndContinue);

  drawBtn.classList.toggle('has-content',!!row.has_drawing);
  renderFiles(); loadFiles();
  requestAnimationFrame(()=>{
    ta.style.height=Math.min(Math.max(112,ta.scrollHeight+2),Math.round(innerHeight*.42))+'px';
    ta.focus(); ta.setSelectionRange(ta.value.length,ta.value.length);
  });
}

/* The highlighted entry row is not in the database yet. Frappe still opens its
   note workspace there, so keep files and drawing on the draft state and flush
   them immediately after POST /logs/ gives the row a real log id. */
function openDraftNoteWorkspace(input){
  const dp=input.dataset.dp, key=input.dataset.dk, st=stateFor(dp); if(!st) return;
  const col=COLS.find(c=>c.k===key)||{h:'Notes'};
  st.__pendingFiles=st.__pendingFiles||[];
  document.querySelector('.pg-note-workspace')?.remove();
  const ov=document.createElement('div'); ov.className='pg-note-workspace'; ov.setAttribute('role','dialog'); ov.setAttribute('aria-modal','true');
  ov.innerHTML=`<div class="pg-note-workspace-box">
    <div class="pg-note-workspace-head"><div><div class="pg-note-workspace-title">${esc(col.h)}</div><div class="pg-note-workspace-sub">Notes, documents, PDFs, images, and drawing</div></div><div class="pg-note-workspace-head-actions"><button type="button" class="pg-note-head-tool pg-note-upload"><span>&#128206;</span> Files</button><button type="button" class="pg-note-head-tool pg-note-drawing"><span>&#9998;</span> Drawing</button><button type="button" class="pg-note-workspace-close" aria-label="Close">&times;</button></div></div>
    <div class="pg-note-workspace-body"><label class="pg-note-workspace-label">Notes</label><textarea class="pg-note-workspace-text" placeholder="Add your notes here…">${esc(st[key]||'')}</textarea><div class="pg-note-files"></div><div class="pg-note-workspace-status">Files and drawing will upload when this row is saved.</div></div>
    <div class="pg-note-workspace-foot"><div class="pg-note-workspace-hint">Enter saves and continues &middot; Shift+Enter adds a line</div><div class="pg-note-workspace-actions"><button type="button" class="pg-note-cancel">Cancel</button><button type="button" class="pg-note-save">Save &amp; Continue</button></div></div>
  </div>`;
  document.body.appendChild(ov);
  const q=s=>ov.querySelector(s), ta=q('.pg-note-workspace-text'), files=q('.pg-note-files'), draw=q('.pg-note-drawing');
  const renderFiles=()=>{ files.innerHTML=st.__pendingFiles.map((f,i)=>`<div class="pg-note-file"><span>${esc(f.name)}</span><span class="pg-note-file-right"><span class="pg-note-file-pending">Ready to upload</span><button type="button" class="pg-note-file-del" data-pending="${i}" title="Remove">&times;</button></span></div>`).join('')||'<div class="pg-note-file"><span>No files attached yet</span></div>'; };
  const close=()=>ov.remove();
  const save=()=>{ st[key]=ta.value; input.value=ta.value; close(); const ins=draftInputs(dp), i=ins.indexOf(input); if(i>=0&&ins[i+1]) ins[i+1].focus(); };
  q('.pg-note-upload').onclick=()=>{ const pick=document.createElement('input'); pick.type='file'; pick.multiple=true; pick.accept='.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.dwg,.dxf,.rvt,.ifc,image/*'; pick.onchange=()=>{ st.__pendingFiles.push(...Array.from(pick.files||[])); renderFiles(); }; pick.click(); };
  files.onclick=e=>{ const b=e.target.closest('[data-pending]'); if(b){ st.__pendingFiles.splice(+b.dataset.pending,1); renderFiles(); } };
  draw.onclick=()=>{ if(typeof achi_drawing==='undefined') return; ov.style.display='none'; achi_drawing.open({title:`Drawing — ${col.h}`,initial:st.__drawing||'',onSave(json){st.__drawing=json;draw.classList.add('has-content');},onClose(){if(ov.isConnected){ov.style.display='flex';requestAnimationFrame(()=>ta.focus());}}}); };
  q('.pg-note-workspace-close').onclick=close; q('.pg-note-cancel').onclick=close; q('.pg-note-save').onclick=save;
  ov.onmousedown=e=>{if(e.target===ov)close();}; ta.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();save();}};
  draw.classList.toggle('has-content',!!st.__drawing); renderFiles();
  requestAnimationFrame(()=>{
    ta.style.height=Math.min(Math.max(112,ta.scrollHeight+2),Math.round(innerHeight*.42))+'px';
    ta.focus();
  });
}

async function load(){ try{
  ROWS=await api('/logs/');
  try{ sessionStorage.setItem(ROW_CACHE_KEY,JSON.stringify(ROWS)); }catch(_){}
  stats(); render();
}catch(e){ fail(e.message); } }

/* tabs = scroll positions */
const tabsEl=$('tabs'), ind=$('ind'), outer=$('touter');

function moveInd(b){
  ind.style.left=b.offsetLeft+'px';
  ind.style.width=b.offsetWidth+'px';
}

function firstThForTab(n){
  return $('thead').querySelector(`th[data-tab="${n}"]`);
}

function fixedColumnsRight(){
  const outerLeft=outer.getBoundingClientRect().left;
  return FIXED_KEYS.reduce((right,key)=>{
    const th=$('thead').querySelector(`th[data-k="${key}"]`);
    return th?Math.max(right,th.getBoundingClientRect().right):right;
  },outerLeft);
}

function maxHorizontalScroll(){
  return Math.max(0,outer.scrollWidth-outer.clientWidth);
}

function ensureTabScrollSpace(){
  const table=$('tbl');
  const last=firstThForTab(3);
  if(!table||!last) return;

  let spacer=$('tab-scroll-space');
  if(!spacer){
    spacer=document.createElement('div');
    spacer.id='tab-scroll-space';
    spacer.setAttribute('aria-hidden','true');
    spacer.style.cssText='height:1px;pointer-events:none';
    outer.appendChild(spacer);
  }

  const tableBox=table.getBoundingClientRect();
  const remaining=tableBox.right-last.getBoundingClientRect().left;
  const visible=outer.getBoundingClientRect().right-fixedColumnsRight();
  const tail=Math.max(0,visible-remaining+8);
  spacer.style.width=Math.ceil(tableBox.width+tail)+'px';
}

function tabTargetLeft(n){
  const th=firstThForTab(n);
  if(!th||n===0) return 0;
  ensureTabScrollSpace();
  const delta=th.getBoundingClientRect().left-fixedColumnsRight()-8;
  return Math.max(
    0,
    Math.min(maxHorizontalScroll(),outer.scrollLeft+delta)
  );
}

function scrollToTab(n){
  outer.scrollTo({left:tabTargetLeft(n),behavior:'smooth'});
  setActivePill(n);
}

function setActivePill(n){
  activeTab=n;
  tabsEl.querySelectorAll('.pill-tab').forEach(b=>{
    const on=+b.dataset.tab===n;
    b.classList.toggle('on',on);
    if(on) moveInd(b);
  });
}

function tabFromScroll(){
  const max=maxHorizontalScroll();
  let best=0;
  if(max>0&&outer.scrollLeft>=max-2){
    best=3;
  }else{
    const boundary=fixedColumnsRight()+12;
    [0,1,2,3].forEach(n=>{
      const th=firstThForTab(n);
      if(th&&th.getBoundingClientRect().left<=boundary) best=n;
    });
  }
  if(best!==activeTab) setActivePill(best);
}
tabsEl.querySelectorAll('.pill-tab').forEach(b=>b.onclick=()=>scrollToTab(+b.dataset.tab));
let sraf=0; outer.addEventListener('scroll',()=>{ $('totop').classList.toggle('show',outer.scrollTop>200); if(sraf)return; sraf=requestAnimationFrame(()=>{sraf=0;tabFromScroll();}); });
$('totop').onclick=()=>outer.scrollTo({top:0,behavior:'smooth'});
window.addEventListener('load',()=>moveInd(tabsEl.querySelector('.pill-tab.on')));
$('k-open-card').onclick=()=>{ openOnly=!openOnly; $('k-open-card').classList.toggle('on',openOnly); render(); };
$('q').oninput=render;

/* bottom drag strip resizes table height (persisted) */
(function(){
  const saved=+localStorage.getItem('achi_bh'); if(saved>160) outer.style.setProperty('--bh',saved+'px');
  $('vrz').addEventListener('pointerdown',e=>{
    const start={y:e.clientY,h:outer.getBoundingClientRect().height}; document.body.classList.add('resizing');
    const mv=ev=>{ const h=Math.max(180,Math.min(1400,start.h+(ev.clientY-start.y))); outer.style.setProperty('--bh',h+'px'); };
    const up=()=>{ window.removeEventListener('pointermove',mv); window.removeEventListener('pointerup',up); document.body.classList.remove('resizing');
      localStorage.setItem('achi_bh',Math.round(outer.getBoundingClientRect().height)); };
    window.addEventListener('pointermove',mv); window.addEventListener('pointerup',up);
  });
})();

/* boot */
$('totop').innerHTML=SVG.up;
$('btn-del').innerHTML=SVG.trash+'<span>Delete</span> <span class="tb-cnt" id="del-count">0</span>';
$('btn-email').innerHTML=SVG.mail+'<span>Email</span> <span class="tb-cnt" id="email-count">0</span>';
loadColWidths(); buildHead(); wireColResize(); setActivePill(0); stats(); render();
if(!TOKEN) fail('Not signed in on this host. Open the main app at THIS address (same localhost/IP), sign in, then reload.');
else { load(); loadCustomCities(); loadCustomDistricts(); }

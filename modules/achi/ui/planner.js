(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { view: 'month', cursor: new Date(), events: [], sourceEvents: [], tasks: [], users: [], me: null, editingId: null, draggingTask: null, draggingEvent: null, resizingEvent: null, query:'', sources: {own:true,task:true,meeting:true,related:true,crm:true,site_visit:true}, selectedMemberIds: new Set() };
  const api = '/api/v1/achi/planner';
  // ACHI API routes authenticate with the token held by the upstream login UI.
  // Planner is a standalone page, so it must attach that token itself rather
  // than relying on a cookie-only request.
  const apiFetch = (url, options={}) => {
    let token = '';
    try { token = localStorage.getItem('oe_access_token') || sessionStorage.getItem('oe_access_token') || ''; } catch (_error) {}
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, {...options, headers, credentials:'same-origin'});
  };
  const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const eventTypes = {meeting:'Meeting',appointment:'Appointment',event:'Event',reminder:'Reminder',time_block:'Work block',task_block:'Task block',site_visit:'Site visit',call:'Call',follow_up:'Follow-up',deadline:'Deadline'};
  const pad = n => String(n).padStart(2, '0');
  const isoLocal = date => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  const dateAtMidnight = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const addDays = (date, days) => { const next = new Date(date); next.setDate(next.getDate()+days); return next; };
  const monday = date => addDays(dateAtMidnight(date), (date.getDay()+6)%7 * -1);
  const esc = value => String(value || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const msg = text => { const node=$('planner-message'); node.textContent=text; node.hidden=!text; };
  const eventDate = event => new Date(event.start_at);
  const rangeFor = () => {
    const anchor = dateAtMidnight(state.cursor);
    if (state.view === 'month') { const first = new Date(anchor.getFullYear(),anchor.getMonth(),1); const start=monday(first); return [start,addDays(start,42)]; }
    if (state.view === 'week') { const start=monday(anchor); return [start,addDays(start,7)]; }
    if (state.view === 'day') return [anchor,addDays(anchor,1)];
    return [anchor,addDays(anchor,60)];
  };
  const formatTime = event => event.all_day ? 'All day' : new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(eventDate(event));
  const displayPeriod = () => {
    const [start,end] = rangeFor(); const options={month:'long',year:'numeric'};
    if (state.view==='month') return new Intl.DateTimeFormat(undefined,options).format(state.cursor);
    if (state.view==='day') return new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(start);
    return `${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(start)} – ${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(addDays(end,-1))}`;
  };
  async function load() {
    const [start,end] = rangeFor(); msg('');
    try {
      const [eventsResponse, followUpsResponse, siteVisitsResponse]=await Promise.all([apiFetch(`${api}/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`),apiFetch(`${api}/sources/crm-follow-ups?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`),apiFetch(`${api}/sources/site-visits?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)]);
      if(!eventsResponse.ok) throw new Error((await eventsResponse.json().catch(()=>({}))).detail || 'Could not load Planner events.');
      state.events=(await eventsResponse.json()).items; state.sourceEvents=[...(followUpsResponse.ok?await followUpsResponse.json():[]),...(siteVisitsResponse.ok?await siteVisitsResponse.json():[])]; render(); renderReminderQueue(); await loadUnscheduledTasks();
    } catch(error) { state.events=[]; state.sourceEvents=[]; render(); msg(error.message || 'Could not load Planner events.'); }
  }
  async function loadUnscheduledTasks() {
    const container=$('planner-task-backlog-list');
    try {
      const response=await apiFetch(`${api}/tasks/unscheduled`);
      if(!response.ok) throw new Error('Could not load unscheduled tasks.');
      state.tasks=(await response.json()).items;
      $('planner-task-count').textContent=String(state.tasks.length);
      container.innerHTML=state.tasks.length ? state.tasks.map(task=>`<button type="button" draggable="true" class="planner-task-card" data-task-id="${esc(task.id)}"><span class="planner-task-number">${esc(task.task_number)}</span><strong>${esc(task.title)}</strong><span class="planner-task-meta">${esc(task.priority)} · ${esc(task.assigned_to_name || 'Unassigned')} · ${task.scheduled_block_count||0} scheduled block${task.scheduled_block_count===1?'':'s'}</span></button>`).join('') : '<p class="planner-task-empty">No active tasks available.</p>';
    } catch(error) { state.tasks=[]; $('planner-task-count').textContent='0'; container.innerHTML='<p class="planner-task-empty">Tasks could not be loaded.</p>'; }
  }
  async function loadDirectory() {
    try {
      const [usersResponse,meResponse]=await Promise.all([apiFetch(`${api}/users`),apiFetch(`${api}/users/me`)]);
      if(!usersResponse.ok||!meResponse.ok) throw new Error('Could not load Planner attendees.');
      state.users=await usersResponse.json(); state.me=await meResponse.json(); state.selectedMemberIds=new Set(state.users.map(user=>user.user_id)); renderMemberFilters();
    } catch(error) { state.users=[]; state.me=null; msg(error.message); }
  }
  function externalAttendeesText(attendees) { return attendees.filter(row=>row.external_email).map(row=>row.display_name&&row.display_name!==row.external_email?`${row.display_name} <${row.external_email}>`:row.external_email).join('\n'); }
  function renderMemberFilters() { $('planner-member-filters').innerHTML=state.users.map(user=>`<label><input type="checkbox" data-planner-member="${esc(user.user_id)}" ${state.selectedMemberIds.has(user.user_id)?'checked':''}> ${esc(user.display_name)}</label>`).join('')||'<p class="planner-task-empty">No team members available.</p>'; }
  function renderReminderQueue() {
    const list=$('planner-reminder-list'), count=$('planner-reminder-count');
    const now=Date.now(), soon=now+7*24*60*60*1000;
    const items=state.events.flatMap(event=>(event.reminder_minutes||[]).map(minutes=>({event,at:new Date(new Date(event.start_at).getTime()-minutes*60_000)})))
      .filter(item=>item.at.getTime()>=now&&item.at.getTime()<=soon)
      .filter(item=>item.event.visibility!=='private'||item.event.organizer_user_id===state.me?.user_id)
      .sort((a,b)=>a.at-b.at).slice(0,8);
    count.textContent=String(items.length);
    list.innerHTML=items.length?items.map(({event,at})=>`<button type="button" class="planner-reminder-item" data-event-id="${esc(eventKey(event))}"><strong>${esc(event.title)}</strong><small>${esc(new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(at))} · ${esc(eventTypes[event.event_type]||event.event_type)}</small></button>`).join(''):'<p class="planner-task-empty">No reminders in the next 7 days.</p>';
  }
  function visibleEvents() { const matches=event=>!state.query||[event.title,event.description,event.location,event.related_record_label].some(value=>String(value||'').toLowerCase().includes(state.query)); const plannerEvents=state.events.filter(event=>{ const people=new Set([event.organizer_user_id,...(event.attendees||[]).map(row=>row.user_id).filter(Boolean)]); if(![...people].some(id=>state.selectedMemberIds.has(id)))return false; if(!matches(event))return false; if(event.organizer_user_id===state.me?.user_id)return state.sources.own; if(event.event_type==='task_block')return state.sources.task; if(event.related_record_id)return state.sources.related; return state.sources.meeting; }); const sourceEvents=state.sourceEvents.filter(event=>matches(event)&&(event.source==='crm_follow_up'?state.sources.crm:event.source==='site_visit'?state.sources.site_visit:false)); return [...plannerEvents,...sourceEvents].sort((a,b)=>eventDate(a)-eventDate(b)); }
  function parseExternalAttendees(value) { return value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{const match=line.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);return match?{external_name:match[1].trim(),external_email:match[2].trim()}:{external_name:'',external_email:line};}); }
  function setRelatedRecord(record) { $('planner-related-type').value=record?.record_type||''; $('planner-related-id').value=record?.record_id||''; $('planner-related-label').value=record?.label||''; $('planner-related-search').value=record?.label||''; $('planner-related-current').textContent=record?`Linked to ${record.label} (${record.stage}).`:'No related record selected.'; $('planner-related-results').hidden=true; }
  async function searchRelatedRecords() { const query=$('planner-related-search').value.trim(); const results=$('planner-related-results'); if(query.length<2){results.hidden=true;results.innerHTML='';return;} try { const response=await apiFetch(`${api}/related-records?q=${encodeURIComponent(query)}`); if(!response.ok)throw new Error('Could not search ACHI records.'); const records=await response.json(); results.innerHTML=records.map(record=>`<button type="button" data-related-record='${esc(JSON.stringify(record))}'><strong>${esc(record.label)}</strong><small>${esc(record.stage)}${record.location?` · ${esc(record.location)}`:''}</small></button>`).join('')||'<p class="planner-empty">No matching ACHI records.</p>'; results.hidden=false; } catch(error) { results.innerHTML='<p class="planner-empty">Record search is unavailable.</p>'; results.hidden=false; } }
  const eventKey = event => event.instance_key || event.id;
  const repeatFrequency = event => (event?.recurrence_rule||'').match(/(?:^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/)?.[1] || '';
  function eventButton(event) { if(event.source){const sourceLabel=event.source==='site_visit'?'Site Visit':'CRM follow-up';return `<button class="planner-event" data-source-item="${esc(event.id)}" data-source="${esc(event.source)}" data-type="${esc(event.event_type)}" type="button" title="Source-backed ${esc(sourceLabel)}. Edit it in its source module."><span class="planner-event-time">${esc(formatTime(event))}</span>${esc(event.title)}</button>`;} return `<button class="planner-event" draggable="true" data-event-id="${esc(eventKey(event))}" data-type="${esc(event.event_type)}" data-private="${event.visibility==='private'}" type="button" title="Drag to reschedule. Repeating events move the whole series."><span class="planner-event-time">${esc(formatTime(event))}</span>${esc(event.title)}${event.all_day?'':`<span class="planner-event-resize" draggable="true" data-resize-event="${esc(eventKey(event))}" title="Drag to a time slot to change the end time"></span>`}</button>`; }
  function renderMonth() {
    const [start] = rangeFor(); const calendar=$('planner-calendar'); let html='<div class="planner-month">';
    weekdays.forEach(day=>html+=`<div class="planner-weekday">${day}</div>`);
    const events=visibleEvents(); for(let i=0;i<42;i++){ const date=addDays(start,i), key=dayKey(date), today=dayKey(new Date()); const items=events.filter(event=>dayKey(eventDate(event))===key); html+=`<section class="planner-day ${date.getMonth()!==state.cursor.getMonth()?'is-outside':''} ${key===today?'is-today':''}" data-new-date="${key}"><span class="planner-day-number">${date.getDate()}</span>${items.slice(0,4).map(eventButton).join('')}${items.length>4?`<button class="planner-event" type="button" data-more-date="${key}">+${items.length-4} more</button>`:''}</section>`; }
    calendar.innerHTML=html+'</div>';
  }
  function renderAgenda() {
    const calendar=$('planner-calendar'), events=visibleEvents(); if(!events.length){calendar.innerHTML='<p class="planner-empty">No scheduled items in this period.</p>';return;}
    let current=''; let html='<div class="planner-agenda">'; events.forEach(event=>{ const date=eventDate(event), label=new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(date); if(label!==current){current=label;html+=`<div class="planner-agenda-day">${esc(label)}</div>`;} html+=`<button type="button" class="planner-agenda-item" data-event-id="${esc(eventKey(event))}"><span class="planner-agenda-time">${esc(formatTime(event))}</span><span><strong>${esc(event.title)}</strong><p>${esc(eventTypes[event.event_type]||event.event_type)}${event.location ? ` · ${esc(event.location)}` : ''}</p></span></button>`; }); calendar.innerHTML=html+'</div>';
  }
  function renderTimeline() {
    const [start,end]=rangeFor(); const days=[];
    for(let day=start;day<end;day=addDays(day,1)) days.push(day);
    const visible=visibleEvents();
    const now=new Date(), todayKey=dayKey(now);
    const calendar=$('planner-calendar');
    const dayLabel=new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'});
    const hours=Array.from({length:13},(_,index)=>index+7);
    let html=`<div class="planner-timeline planner-timeline-${state.view}"><div class="planner-timeline-head"><span></span>${days.map(day=>`<span>${esc(dayLabel.format(day))}</span>`).join('')}</div><div class="planner-timeline-body">`;
    hours.forEach(hour=>{
      html+=`<div class="planner-time-label">${String(hour).padStart(2,'0')}:00</div>`;
      days.forEach(day=>{
        const key=dayKey(day);
        const events=visible.filter(event=>!event.all_day&&dayKey(eventDate(event))===key&&eventDate(event).getHours()===hour);
        const isCurrent=key===todayKey&&hour===now.getHours();
        html+=`<div class="planner-time-slot ${isCurrent?'is-current-time':''}" data-new-date="${key}" data-new-hour="${hour}">${isCurrent?`<span class="planner-now" style="top:${(now.getMinutes()/60)*100}%"></span>`:''}${events.map(eventButton).join('')}</div>`;
      });
    });
    const allDay=visible.filter(event=>event.all_day&&days.some(day=>dayKey(day)===dayKey(eventDate(event))));
    if(allDay.length) html+=`<div class="planner-all-day-row"><strong>All day</strong><div>${allDay.map(eventButton).join('')}</div></div>`;
    calendar.innerHTML=html+'</div></div>';
  }
  function render() { $('planner-period-label').textContent=displayPeriod(); document.querySelectorAll('[data-planner-view]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.plannerView===state.view))); if(state.view==='month')renderMonth(); else if(state.view==='agenda')renderAgenda(); else renderTimeline(); }
  function defaultWindow(date = state.cursor) { const start=new Date(date); start.setHours(9,0,0,0); const end=new Date(start); end.setHours(10,0,0,0); return [start,end]; }
  function openDialog(event, date) { const dialog=$('planner-dialog'); state.editingId=event?.id || null; const [fallbackStart,fallbackEnd]=defaultWindow(date); $('planner-dialog-title').textContent=event?'Edit event':'New event'; $('planner-title').value=event?.title || ''; $('planner-type').value=event?.event_type || 'event'; $('planner-visibility').value=event?.visibility || 'team'; $('planner-start').value=isoLocal(event?new Date(event.start_at):fallbackStart); $('planner-end').value=isoLocal(event?new Date(event.end_at):fallbackEnd); $('planner-all-day').checked=Boolean(event?.all_day); $('planner-repeat').value=repeatFrequency(event); $('planner-repeat-until').value=event?.recurrence_end_at?isoLocal(new Date(event.recurrence_end_at)):''; $('planner-location').value=event?.location || ''; $('planner-meeting-url').value=event?.meeting_url || ''; $('planner-description').value=event?.description || ''; setRelatedRecord(event?.related_record_id?{record_type:event.related_record_type,record_id:event.related_record_id,label:event.related_record_label,stage:'existing record'}:null); document.querySelectorAll('[name="planner-reminder"]').forEach(input=>{input.checked=(event?.reminder_minutes||[]).includes(Number(input.value));}); const selected=new Set((event?.attendees||[]).filter(row=>row.user_id).map(row=>row.user_id)); $('planner-attendees').innerHTML=state.users.map(user=>`<label><input type="checkbox" data-planner-attendee value="${esc(user.user_id)}" ${selected.has(user.user_id)?'checked':''}> ${esc(user.display_name)}</label>`).join('')||'<span>No team members are available.</span>'; $('planner-external-attendees').value=externalAttendeesText(event?.attendees||[]); const mine=(event?.attendees||[]).find(row=>row.user_id===state.me?.user_id); const response=mine?.response_status||''; $('planner-rsvp').hidden=!mine; $('planner-rsvp').dataset.eventId=event?.id||''; $('planner-rsvp').dataset.currentResponse=response; document.querySelectorAll('[data-rsvp]').forEach(button=>button.classList.toggle('is-selected',button.dataset.rsvp===response)); $('planner-conflicts').hidden=true; $('planner-cancel-event').hidden=!event; $('planner-delete').hidden=!event; dialog.showModal(); }
  function closeDialog(){ $('planner-dialog').close(); state.editingId=null; }
  async function cancelEvent(){ if(!state.editingId||!window.confirm('Cancel this Planner event?'))return; try{const response=await apiFetch(`${api}/events/${state.editingId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'cancelled'})});if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Could not cancel event.');closeDialog();await load();}catch(error){msg(error.message||'Could not cancel event.');}}
  function dateFromKey(key,hour=9){ const [y,m,d]=key.split('-').map(Number); return new Date(y,m-1,d,hour); }
  async function checkConflicts({show=false}={}) {
    const start=new Date($('planner-start').value), end=new Date($('planner-end').value);
    const internal=[...document.querySelectorAll('[data-planner-attendee]:checked')].map(input=>input.value);
    const userIds=[...new Set([...(state.me?[state.me.user_id]:[]),...internal])];
    const notice=$('planner-conflicts');
    if(!userIds.length||Number.isNaN(start.valueOf())||Number.isNaN(end.valueOf())||end<=start){ notice.hidden=true; return []; }
    try {
      const response=await apiFetch(`${api}/conflicts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_ids:userIds,start_at:start.toISOString(),end_at:end.toISOString(),exclude_event_id:state.editingId})});
      if(!response.ok) throw new Error();
      const conflicts=await response.json();
      if(show){ notice.textContent=conflicts.length?`Scheduling conflict: ${conflicts.map(row=>`${row.display_name} is busy (${row.title})`).join('; ')}`:'No attendee conflicts for this time.'; notice.hidden=false; }
      else notice.hidden=true;
      return conflicts;
    } catch { if(show){notice.textContent='Could not check attendee availability.';notice.hidden=false;} return []; }
  }
  async function save(event) { event.preventDefault(); const start=new Date($('planner-start').value), end=new Date($('planner-end').value), repeat=$('planner-repeat').value, repeatUntil=$('planner-repeat-until').value; const reminder_minutes=[...document.querySelectorAll('[name="planner-reminder"]:checked')].map(input=>Number(input.value)); const internal=[...document.querySelectorAll('[data-planner-attendee]:checked')].map(input=>({user_id:input.value})); const attendees=[...internal,...parseExternalAttendees($('planner-external-attendees').value)]; const user_ids=[...new Set([...(state.me?[state.me.user_id]:[]),...internal.map(row=>row.user_id)])]; const body={title:$('planner-title').value,event_type:$('planner-type').value,visibility:$('planner-visibility').value,start_at:start.toISOString(),end_at:end.toISOString(),all_day:$('planner-all-day').checked,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Beirut',location:$('planner-location').value,meeting_url:$('planner-meeting-url').value,description:$('planner-description').value,reminder_minutes,attendees,recurrence_rule:repeat?`FREQ=${repeat};INTERVAL=1`:null,recurrence_end_at:repeatUntil?new Date(repeatUntil).toISOString():null,related_record_type:$('planner-related-type').value||null,related_record_id:$('planner-related-id').value||null,related_record_label:$('planner-related-label').value||''}; try { if(user_ids.length){const check=await apiFetch(`${api}/conflicts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_ids,start_at:body.start_at,end_at:body.end_at,exclude_event_id:state.editingId})});if(check.ok){const conflicts=await check.json();if(conflicts.length&&!window.confirm(`${conflicts.map(row=>`${row.display_name}: ${row.title}`).join('\n')}\n\nContinue anyway?`))return;}} const url=state.editingId?`${api}/events/${state.editingId}`:`${api}/events`; const method=state.editingId?'PATCH':'POST'; const response=await apiFetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Could not save event.'); closeDialog(); await load(); } catch(error){ msg(error.message||'Could not save event.'); } }
  async function rsvp(responseStatus) { const eventId=$('planner-rsvp').dataset.eventId; if(!eventId)return; try { const response=await apiFetch(`${api}/events/${eventId}/rsvp`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({response_status:responseStatus})}); if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Could not save response.'); const updated=await response.json(); state.events=state.events.map(row=>row.id===updated.id?updated:row); openDialog(updated); render(); } catch(error) { msg(error.message||'Could not save response.'); } }
  async function remove(){ if(!state.editingId||!window.confirm('Delete this Planner event?'))return; try{const response=await apiFetch(`${api}/events/${state.editingId}`,{method:'DELETE'});if(!response.ok)throw new Error('Could not delete event.');closeDialog();await load();}catch(error){msg(error.message);}}
  async function scheduleTask(taskId, dateKey, hour) { const start=dateFromKey(dateKey,Number(hour||9)); const end=new Date(start); end.setHours(end.getHours()+1); const body={task_id:taskId,start_at:start.toISOString(),end_at:end.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Beirut'}; try { const response=await apiFetch(`${api}/task-blocks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Could not schedule task.'); await load(); } catch(error) { msg(error.message||'Could not schedule task.'); } }
  async function moveEvent(item, dateKey, hour) { const original=new Date(item.start_at), start=dateFromKey(dateKey, hour===undefined?original.getHours():Number(hour)); start.setMinutes(hour===undefined?original.getMinutes():0,0,0); const end=new Date(start.getTime()+(new Date(item.end_at).getTime()-original.getTime())); const body={start_at:start.toISOString(),end_at:end.toISOString()}; try { const response=await apiFetch(`${api}/events/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Could not move event.'); await load(); } catch(error) { msg(error.message||'Could not move event.'); await load(); } }
  async function resizeEvent(item, dateKey, hour) { if(hour===undefined){msg('Use Week or Day view to resize an event.');return;} const start=new Date(item.start_at), end=dateFromKey(dateKey,Number(hour)+1); if(end<=start){msg('The event end must be after its start time.');return;} try { const response=await apiFetch(`${api}/events/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({end_at:end.toISOString()})}); if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Could not resize event.'); await load(); } catch(error) { msg(error.message||'Could not resize event.'); await load(); } }
  function move(direction){ if(state.view==='month')state.cursor.setMonth(state.cursor.getMonth()+direction);else if(state.view==='week')state.cursor=addDays(state.cursor,7*direction);else if(state.view==='day')state.cursor=addDays(state.cursor,direction);else state.cursor=addDays(state.cursor,30*direction);load(); }
  document.addEventListener('click', event=>{ const related=event.target.closest('[data-related-record]');if(related){setRelatedRecord(JSON.parse(related.dataset.relatedRecord));return;} const sourceItem=event.target.closest('[data-source-item]');if(sourceItem){msg(sourceItem.dataset.source==='site_visit'?'This Site Visit is source-backed. Edit its scheduled date in Site Survey.':'This CRM follow-up is source-backed. Edit its date and notes in Log or CRM.');return;} const view=event.target.closest('[data-planner-view]');if(view){state.view=view.dataset.plannerView;load();return;} const item=event.target.closest('[data-event-id]');if(item){openDialog(state.events.find(row=>eventKey(row)===item.dataset.eventId));return;} const day=event.target.closest('[data-new-date]');if(day&&!event.target.closest('button'))openDialog(null,dateFromKey(day.dataset.newDate,Number(day.dataset.newHour||9))); });
  document.addEventListener('change', event=>{ const source=event.target.closest('[data-planner-source]'); if(source){state.sources[source.dataset.plannerSource]=source.checked;render();return;} const member=event.target.closest('[data-planner-member]'); if(member){if(member.checked)state.selectedMemberIds.add(member.dataset.plannerMember);else state.selectedMemberIds.delete(member.dataset.plannerMember);render();} });
  document.addEventListener('dragstart', event=>{ const resize=event.target.closest('[data-resize-event]'); if(resize){state.resizingEvent=state.events.find(row=>eventKey(row)===resize.dataset.resizeEvent)||null; if(state.resizingEvent){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',state.resizingEvent.id);}return;} const task=event.target.closest('[data-task-id]'); if(task){state.draggingTask=task.dataset.taskId; event.dataTransfer.effectAllowed='copy'; event.dataTransfer.setData('text/plain',state.draggingTask); return;} const item=event.target.closest('[data-event-id]'); if(item){state.draggingEvent=state.events.find(row=>eventKey(row)===item.dataset.eventId)||null; if(state.draggingEvent){event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain',state.draggingEvent.id);}} });
  document.addEventListener('dragover', event=>{ const target=event.target.closest('[data-new-date]'); if(!target||(!state.draggingTask&&!state.draggingEvent&&!state.resizingEvent))return; event.preventDefault(); event.dataTransfer.dropEffect=state.draggingTask?'copy':'move'; target.classList.add('is-drop-target'); });
  document.addEventListener('dragleave', event=>{ event.target.closest('[data-new-date]')?.classList.remove('is-drop-target'); });
  document.addEventListener('drop', event=>{ const target=event.target.closest('[data-new-date]'); if(!target||(!state.draggingTask&&!state.draggingEvent&&!state.resizingEvent))return; event.preventDefault(); target.classList.remove('is-drop-target'); const taskId=state.draggingTask, plannerEvent=state.draggingEvent, resizingEvent=state.resizingEvent; state.draggingTask=null; state.draggingEvent=null; state.resizingEvent=null; if(taskId)scheduleTask(taskId,target.dataset.newDate,target.dataset.newHour); else if(resizingEvent)resizeEvent(resizingEvent,target.dataset.newDate,target.dataset.newHour); else moveEvent(plannerEvent,target.dataset.newDate,target.dataset.newHour); });
  document.addEventListener('dragend', ()=>{document.querySelectorAll('.is-drop-target').forEach(node=>node.classList.remove('is-drop-target'));state.draggingTask=null;state.draggingEvent=null;state.resizingEvent=null;});
  $('planner-search').addEventListener('input',event=>{state.query=event.target.value.trim().toLowerCase();render();});
  $('planner-cancel-event').addEventListener('click',cancelEvent);
  let relatedSearchTimer, conflictCheckTimer; $('planner-related-search').addEventListener('input',()=>{clearTimeout(relatedSearchTimer); relatedSearchTimer=setTimeout(searchRelatedRecords,220);}); ['planner-start','planner-end','planner-attendees'].forEach(id=>$(id).addEventListener('change',()=>{clearTimeout(conflictCheckTimer);conflictCheckTimer=setTimeout(()=>checkConflicts({show:true}),180);})); $('planner-new').addEventListener('click',()=>{const menu=$('planner-new-options');menu.hidden=!menu.hidden;$('planner-new').setAttribute('aria-expanded',String(!menu.hidden));}); document.querySelectorAll('[data-planner-new-type]').forEach(button=>button.addEventListener('click',()=>{ $('planner-new-options').hidden=true; $('planner-new').setAttribute('aria-expanded','false'); openDialog(); $('planner-type').value=button.dataset.plannerNewType; })); document.querySelector('[data-planner-new-task]').addEventListener('click',()=>{window.location.assign('/api/v1/achi/tasks/ui');}); $('planner-prev').addEventListener('click',()=>move(-1)); $('planner-next').addEventListener('click',()=>move(1)); $('planner-today').addEventListener('click',()=>{state.cursor=new Date();load();}); $('planner-close').addEventListener('click',closeDialog); $('planner-cancel').addEventListener('click',closeDialog); $('planner-delete').addEventListener('click',remove); $('planner-form').addEventListener('submit',save); document.querySelectorAll('[data-rsvp]').forEach(button=>button.addEventListener('click',()=>rsvp(button.dataset.rsvp))); setInterval(()=>{if(state.view==='week'||state.view==='day')render();},60_000); loadDirectory().finally(load);
})();

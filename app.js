import { LEGACY_KEY, money, parsePence, prepareLegacy } from './core.js';

const $ = id => document.getElementById(id);
const config = window.COFFEE_CONFIG || {};
const state = { client: null, snapshot: null, channel: null, pending: null, prepared: null, loading: false };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const nameOf = id => state.snapshot?.people.find(person => person.id === id)?.name || 'Unknown person';
const active = () => state.snapshot?.people.filter(person => person.active) || [];
const node = (tag, className = '', content = '') => { const item = document.createElement(tag); if (className) item.className = className; item.textContent = content; return item; };

function message(value = '', error = false) { $('board-message').textContent = value; $('board-message').classList.toggle('error', error); }
function joinMessage(value = '', error = false) { $('join-message').textContent = value; $('join-message').classList.toggle('error', error); }
function connection(value, mode = '') { $('connection').textContent = value; $('connection').className = `connection ${mode}`; }
function show(view) { for (const name of ['setup','join','board']) $(`${name}-view`).hidden = name !== view; }
async function rpc(name, args = {}) { const { data, error } = await state.client.rpc(name, args); if (error) throw new Error(error.message || 'The request failed.'); return data; }
function selected(container) { return [...$(container).querySelectorAll('input:checked')].map(input => input.value); }
function clearPreview() { $('preview-box').hidden = true; $('preview-box').classList.remove('success'); }

function attendeeChips(container, className, selectedIds = []) {
  const host = $(container); host.replaceChildren();
  for (const person of active()) {
    const label = node('label', 'chip');
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = className; input.value = person.id;
    input.checked = selectedIds.includes(person.id);
    input.addEventListener('change', clearPreview);
    label.append(input, node('span', '', person.name)); host.append(label);
  }
  if (!active().length) host.append(node('p', 'empty', 'Add people to start recording rounds.'));
}

function renderPeople() {
  const host = $('people-list'); host.replaceChildren();
  for (const person of active()) {
    const row = node('div','person-row'); row.append(node('strong','',person.name));
    const button = node('button','text-button','Archive'); button.type = 'button';
    button.setAttribute('aria-label',`Archive ${person.name}`);
    button.addEventListener('click', async () => {
      if (!confirm(`Archive ${person.name}? Their history and balance will remain, but they will not appear in new rounds.`)) return;
      button.disabled = true;
      try { await rpc('coffee_archive_person',{p_person_id:person.id}); await load(); }
      catch (error) { message(error.message,true); button.disabled = false; }
    });
    row.append(button); host.append(row);
  }
}

function renderLeaderboard() {
  const host = $('leaderboard'); host.replaceChildren();
  const balances = [...state.snapshot.balances].sort((a,b) => b.balance_pence - a.balance_pence || nameOf(a.person_id).localeCompare(nameOf(b.person_id)));
  if (!balances.length) { host.append(node('p','empty','Add a person to get started.')); return; }
  for (const item of balances) {
    const person = state.snapshot.people.find(p => p.id === item.person_id);
    const row = node('div','leader-row'); const left = node('div');
    left.append(node('strong','',person?.name || 'Unknown'));
    if (person && !person.active) left.append(node('span','sub','Archived'));
    left.append(node('span','sub',`${item.bought} bought · ${item.attended} attended · ${money(item.spent_pence)} paid`));
    const amount = node('span',`balance ${item.balance_pence >= 0 ? 'positive' : 'negative'}`,`${item.balance_pence >= 0 ? '+' : '−'}${money(Math.abs(item.balance_pence))}`);
    row.append(left,amount); host.append(row);
  }
}

function renderHistory() {
  const host = $('history'); host.replaceChildren();
  const rounds = [...state.snapshot.rounds].sort((a,b) => b.round_date.localeCompare(a.round_date) || b.created_at.localeCompare(a.created_at));
  if (!rounds.length) { host.append(node('p','empty','No rounds recorded yet.')); return; }
  for (const round of rounds) {
    const row = node('div','history-row'); const top = node('div','history-top');
    const date = new Date(`${round.round_date}T12:00:00`);
    top.append(node('strong','',`${nameOf(round.buyer_id)} bought`),node('strong','',money(round.cost_pence)));
    row.append(top,node('div','sub',`${date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}${round.display_time ? ` · ${round.display_time}` : ''} · ${round.kind === 'round' ? 'Today’s round' : 'Historic'} · ${round.attendee_ids.map(nameOf).join(', ')}`));
    const button = node('button','text-button','Delete round'); button.type = 'button';
    button.addEventListener('click', async () => {
      if (!confirm(`Delete this ${money(round.cost_pence)} round? Its spend and attendance will be reversed.`)) return;
      button.disabled = true;
      try { await rpc('coffee_delete_round',{p_round_id:round.id}); await load(); }
      catch (error) { message(error.message,true); button.disabled = false; }
    });
    row.append(button); host.append(row);
  }
}

function render() {
  const previousToday = selected('today-attendees');
  const previousHistoric = selected('historic-attendees');
  attendeeChips('today-attendees','today-attendee',previousToday.length ? previousToday : (state.snapshot.version === 0 ? active().map(p => p.id) : []));
  attendeeChips('historic-attendees','historic-attendee',previousHistoric);
  const buyer = $('historic-buyer'), prior = buyer.value; buyer.replaceChildren();
  const placeholder = node('option','','Choose buyer'); placeholder.value = ''; buyer.append(placeholder);
  for (const person of active()) { const option = node('option','',person.name); option.value = person.id; buyer.append(option); }
  buyer.value = active().some(p => p.id === prior) ? prior : '';
  renderPeople(); renderLeaderboard(); renderHistory();
  $('version-label').textContent = `Version ${state.snapshot.version}`;
  $('migration-preview').hidden = !state.prepared;
  connection('Live', 'live'); show('board');
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  try { state.snapshot = await rpc('coffee_snapshot'); render(); message(); }
  catch (error) { connection('Connection issue','offline'); message(`Couldn’t refresh: ${error.message}`,true); throw error; }
  finally { state.loading = false; }
}

function startUpdates() {
  if (state.channel) return;
  state.channel = state.client.channel('coffee-revision')
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'coffee_revision'},() => { void load().catch(() => {}); })
    .subscribe();
  setInterval(() => { if (!document.hidden && state.snapshot) void load().catch(() => {}); },30000);
}

async function preview() {
  const ids = selected('today-attendees');
  if (!ids.length) { message('Tick who is in today first.',true); return; }
  $('preview').disabled = true;
  try {
    const buyerId = await rpc('coffee_preview',{p_attendee_ids:ids});
    const box = $('preview-box'); box.replaceChildren();
    box.append(node('strong','',`${nameOf(buyerId)} should buy next`));
    const balances = state.snapshot.balances.filter(row => ids.includes(row.person_id))
      .sort((a,b) => a.balance_pence - b.balance_pence);
    box.append(node('small','',balances.map(row => `${nameOf(row.person_id)} ${row.balance_pence >= 0 ? '+' : '−'}${money(Math.abs(row.balance_pence))}`).join(' · ')));
    box.hidden = false; message();
  } catch (error) { message(error.message,true); }
  finally { $('preview').disabled = false; }
}

async function saveRound(event, historic) {
  event.preventDefault();
  const ids = selected(historic ? 'historic-attendees' : 'today-attendees');
  const buyerId = historic ? $('historic-buyer').value : null;
  if (historic && buyerId && !ids.includes(buyerId)) ids.push(buyerId);
  if (!ids.length) { message('Choose at least one attendee.',true); return; }
  if (historic && !buyerId) { message('Choose the historic buyer.',true); return; }
  let cost;
  try { cost = parsePence($(historic ? 'historic-cost' : 'round-cost').value); }
  catch (error) { message(error.message,true); return; }
  const date = historic ? $('historic-date').value : today();
  if (!date) { message('Choose a date.',true); return; }
  const signature = JSON.stringify([ids,cost,date,buyerId]);
  if (!state.pending || state.pending.signature !== signature) state.pending = { signature, id: crypto.randomUUID() };
  const button = $(historic ? 'historic-button' : 'record-button'); button.disabled = true;
  try {
    const result = await rpc('coffee_record_round',{
      p_request_id:state.pending.id,p_attendee_ids:ids,p_cost_pence:cost,
      p_round_date:date,p_historic_buyer_id:buyerId
    });
    state.pending = null;
    await load();
    $(historic ? 'historic-cost' : 'round-cost').value = '';
    if (historic) { $('historic-buyer').value = ''; $('historic-attendees').querySelectorAll('input').forEach(input => input.checked = false); }
    const box = $('preview-box'); box.replaceChildren();
    box.append(node('strong','',`${nameOf(result.buyer_id)} bought this round`));
    box.append(node('small','',result.duplicate ? 'This request was already recorded once.' : `${money(cost)} recorded for ${ids.length} people.`));
    box.classList.add('success'); box.hidden = false;
  } catch (error) { message(`Couldn’t record: ${error.message}. Refresh before changing the form; retrying the same form is safe.`,true); }
  finally { button.disabled = false; }
}

function download(json, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(json,null,2)],{type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}

function prepareBackup(raw) {
  if (raw?.format !== 'coffee-round-live-v1') return prepareLegacy(raw);
  if (!Array.isArray(raw.people) || !Array.isArray(raw.rounds)) throw new Error('Invalid live backup.');
  const byId = new Map(raw.people.map(person => [person.id,person.name]));
  return prepareLegacy({
    people:raw.people.filter(person => person.active).map(person => person.name),
    history:raw.rounds.map(round => {
      const [year,month,day] = round.round_date.split('-');
      return { date:`${day}/${month}/${year}`,buyer:byId.get(round.buyer_id),
        attendees:round.attendee_ids.map(id => byId.get(id)),cost:round.cost_pence / 100,time:round.display_time || '' };
    })
  });
}

function showMigration(prepared) {
  state.prepared = prepared;
  const box = $('migration-preview'); box.replaceChildren(); box.hidden = false;
  box.append(node('strong','',`Ready to import ${prepared.people.length} people and ${prepared.rounds.length} rounds.`));
  if (prepared.discrepancies.length) box.append(node('p','small',`Old totals differ from recorded history for ${prepared.discrepancies.join(', ')}. The live board will calculate balances from the recorded rounds.`));
  if (!state.snapshot.is_admin || state.snapshot.people.length || state.snapshot.rounds.length) {
    box.append(node('p','small','Only the first joined member can import, and the live board must be empty.')); return;
  }
  const button = node('button','','Import into live board'); button.type = 'button';
  button.addEventListener('click',async () => {
    if (!confirm(`Import ${prepared.rounds.length} rounds and ${prepared.people.length} people into this empty live board? Your old device data will stay in place.`)) return;
    button.disabled = true;
    try { await rpc('coffee_import_legacy',{p_people:prepared.people,p_rounds:prepared.rounds}); state.prepared = null; box.hidden = true; await load(); message('Import complete. Download a live backup for safekeeping.'); }
    catch (error) { message(`Import failed: ${error.message}`,true); button.disabled = false; }
  });
  box.append(button);
}

async function join(event) {
  event.preventDefault();
  const name = $('join-name').value.trim(), code = $('join-code').value.trim();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  joinMessage('Checking code…');
  try {
    let { data, error } = await state.client.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      ({data,error} = await state.client.auth.signInAnonymously());
      if (error) throw error;
    }
    const success = await rpc('coffee_join',{p_code:code,p_name:name});
    if (!success) { joinMessage('That code did not match. Ask the organiser to check it.',true); return; }
    $('join-code').value = '';
    localStorage.setItem('coffeeRoundLiveName',name);
    await load(); startUpdates();
  } catch (error) { joinMessage(`Couldn’t join: ${error.message}`,true); }
  finally { button.disabled = false; }
}

async function init() {
  $('historic-date').value = today();
  $('join-name').value = localStorage.getItem('coffeeRoundLiveName') || '';
  $('join-form').addEventListener('submit',join);
  $('refresh').addEventListener('click',() => { void load().catch(() => {}); });
  $('select-all').addEventListener('click',() => { $('today-attendees').querySelectorAll('input').forEach(input => input.checked = true); clearPreview(); });
  $('clear-all').addEventListener('click',() => { $('today-attendees').querySelectorAll('input').forEach(input => input.checked = false); clearPreview(); });
  $('preview').addEventListener('click',() => { void preview(); });
  $('round-form').addEventListener('submit',event => { void saveRound(event,false); });
  $('historic-form').addEventListener('submit',event => { void saveRound(event,true); });
  $('person-form').addEventListener('submit',async event => {
    event.preventDefault(); const name = $('person-name').value.trim();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { await rpc('coffee_add_person',{p_name:name}); $('person-name').value = ''; await load(); }
    catch (error) { message(`Couldn’t add person: ${error.message}`,true); }
    finally { button.disabled = false; }
  });
  $('export').addEventListener('click',() => download({format:'coffee-round-live-v1',exported_at:new Date().toISOString(),
    people:state.snapshot.people,rounds:state.snapshot.rounds},`coffee-live-backup-${today()}.json`));
  $('import-local').addEventListener('click',() => {
    try { const raw = localStorage.getItem(LEGACY_KEY); if (!raw) throw new Error('No old V3 data was found on this browser. Export a backup from the old app and use Import backup file.'); showMigration(prepareLegacy(JSON.parse(raw))); }
    catch (error) { message(error.message,true); }
  });
  $('import-file-button').addEventListener('click',() => $('import-file').click());
  $('import-file').addEventListener('change',async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { if (file.size > 5_000_000) throw new Error('Backup file is too large.'); showMigration(prepareBackup(JSON.parse(await file.text()))); message(); }
    catch (error) { message(`Couldn’t read backup: ${error.message}`,true); }
    finally { event.target.value = ''; }
  });
  if (!config.supabaseUrl || !config.supabasePublishableKey) { connection('Setup needed','offline'); show('setup'); return; }
  if (!window.supabase?.createClient) { connection('Connection issue','offline'); show('join'); joinMessage('The Supabase library did not load. Check your connection and refresh.',true); return; }
  state.client = window.supabase.createClient(config.supabaseUrl,config.supabasePublishableKey);
  try {
    const {data,error} = await state.client.auth.getSession(); if (error) throw error;
    if (data.session) { try { await load(); startUpdates(); return; } catch { /* A session alone does not grant board access. */ } }
    connection('Code required'); show('join');
  } catch (error) { connection('Connection issue','offline'); show('join'); joinMessage(error.message,true); }
}

void init();


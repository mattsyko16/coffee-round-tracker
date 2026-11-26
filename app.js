import { LEGACY_KEY, catalogPrice, money, parsePence, prepareBackup, prepareLegacy, validDrinkName, validateDrinkItems } from './core.js';

const $ = id => document.getElementById(id);
const config = window.COFFEE_CONFIG || {};
const state = { client: null, snapshot: null, channel: null, pending: null, prepared: null, loading: false,
  drinkDrafts: { round: new Map(), historic: new Map() }, priceDrafts: new Map(),
  totalAuto: { round: true, historic: true } };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const nameOf = id => state.snapshot?.people.find(person => person.id === id)?.name || 'Unknown person';
const active = () => state.snapshot?.people.filter(person => person.active) || [];
const activeDrinks = () => (state.snapshot?.drinks || []).filter(drink => drink.active)
  .sort((a,b) => a.name.localeCompare(b.name, 'en-GB'));
const node = (tag, className = '', content = '') => { const item = document.createElement(tag); if (className) item.className = className; item.textContent = content; return item; };

function message(value = '', error = false) { $('board-message').textContent = value; $('board-message').classList.toggle('error', error); }
function priceMessage(value = '', error = false) { $('price-message').textContent = value; $('price-message').classList.toggle('error', error); }
function joinMessage(value = '', error = false) { $('join-message').textContent = value; $('join-message').classList.toggle('error', error); }
function connection(value, mode = '') { $('connection').textContent = value; $('connection').className = `connection ${mode}`; }
function show(view) { for (const name of ['setup','join','board']) $(`${name}-view`).hidden = name !== view; }
async function rpc(name, args = {}) { const { data, error } = await state.client.rpc(name, args); if (error) throw new Error(error.message || 'The request failed.'); return data; }
function selected(container) { return [...$(container).querySelectorAll('input:checked')].map(input => input.value); }
function clearPreview() { $('preview-box').hidden = true; $('preview-box').classList.remove('success'); }

function syncDrinkTotal(mode) {
  const enabled = $(`${mode}-split`).value === 'drinks';
  $(`${mode}-total-help`).hidden = !enabled;
  if (!enabled) return;
  const ids = selected(mode === 'round' ? 'today-attendees' : 'historic-attendees');
  const prices = ids.map(id => {
    try { return parsePence(state.drinkDrafts[mode].get(id)?.price ?? ''); }
    catch { return null; }
  });
  const complete = ids.length > 0 && prices.every(price => price !== null);
  const totalInput = $(`${mode}-cost`);
  const status = $(`${mode}-subtotal`);
  if (!complete) {
    if (state.totalAuto[mode]) totalInput.value = '';
    status.textContent = 'Enter a price for each attendee to calculate the total.';
    return;
  }
  const subtotal = prices.reduce((sum, price) => sum + price, 0);
  if (state.totalAuto[mode]) totalInput.value = (subtotal / 100).toFixed(2);
  let actual;
  try { actual = parsePence(totalInput.value); }
  catch { status.textContent = `Drink subtotal ${money(subtotal)}. Enter the actual total paid.`; return; }
  const difference = actual - subtotal;
  status.textContent = difference === 0 ? `Drink subtotal ${money(subtotal)}.`
    : `Drink subtotal ${money(subtotal)}. ${difference > 0 ? 'Extra' : 'Discount'} ${money(Math.abs(difference))} shared equally.`;
}

function attendeeChips(container, className, selectedIds = []) {
  const host = $(container); host.replaceChildren();
  for (const person of active()) {
    const label = node('label', 'chip');
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = className; input.value = person.id;
    input.checked = selectedIds.includes(person.id);
    input.addEventListener('change', () => { clearPreview(); renderDrinkRows(container === 'today-attendees' ? 'round' : 'historic'); });
    label.append(input, node('span', '', person.name)); host.append(label);
  }
  if (!active().length) host.append(node('p', 'empty', 'Add people to start recording rounds.'));
}

function renderDrinkRows(mode) {
  const host = $(`${mode}-drinks`), enabled = $(`${mode}-split`).value === 'drinks';
  host.hidden = !enabled;
  host.replaceChildren();
  if (!enabled) { syncDrinkTotal(mode); return; }
  const ids = selected(mode === 'round' ? 'today-attendees' : 'historic-attendees');
  if (!ids.length) { host.append(node('p', 'empty', 'Tick who was there to choose their drinks.')); syncDrinkTotal(mode); return; }
  host.append(node('p', 'small', 'Choose a drink for each person. The total fills in automatically; you can change it to match the receipt.'));
  for (const id of ids) {
    const draft = state.drinkDrafts[mode].get(id) || { drink: '', price: '' };
    const row = node('div', 'drink-row');
    const typeLabel = node('label', '', `${nameOf(id)}’s drink`);
    const typeSelect = document.createElement('select');
    const placeholder = node('option', '', 'Choose drink'); placeholder.value = ''; typeSelect.append(placeholder);
    for (const drink of activeDrinks()) {
      const option = node('option', '', drink.name); option.value = drink.name; typeSelect.append(option);
    }
    typeSelect.value = draft.drink;
    typeSelect.addEventListener('change', () => {
      const price = catalogPrice(state.snapshot?.drinks || [], typeSelect.value);
      state.drinkDrafts[mode].set(id, { drink: typeSelect.value, price });
      priceInput.value = price;
      syncDrinkTotal(mode);
    });
    typeLabel.append(typeSelect);
    const priceLabel = node('label', '', 'Price (£)');
    const priceInput = document.createElement('input');
    priceInput.type = 'text'; priceInput.inputMode = 'decimal'; priceInput.placeholder = 'e.g. 2.50'; priceInput.value = draft.price;
    priceInput.addEventListener('input', () => {
      state.drinkDrafts[mode].set(id, { ...state.drinkDrafts[mode].get(id), price: priceInput.value });
      syncDrinkTotal(mode);
    });
    priceLabel.append(priceInput);
    row.append(typeLabel, priceLabel); host.append(row);
  }
  syncDrinkTotal(mode);
}

function collectDrinkItems(mode, ids, totalPence) {
  const items = ids.map(id => {
    const draft = state.drinkDrafts[mode].get(id);
    if (!draft?.drink || !activeDrinks().some(drink => drink.name === draft.drink))
      throw new Error(`Choose ${nameOf(id)}’s drink from the current price list.`);
    let price;
    try { price = parsePence(draft.price); }
    catch { throw new Error(`Enter a valid price for ${nameOf(id)}’s drink.`); }
    return { person_id: id, drink: draft.drink, price_pence: price };
  });
  return validateDrinkItems(items, ids, totalPence);
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

function renderPriceList() {
  const host = $('drink-price-list'); host.replaceChildren();
  const drinks = activeDrinks();
  if (!drinks.length) { host.append(node('p', 'empty', 'Add a drink below to start the price list.')); return; }
  for (const drink of drinks) {
    const row = node('div', 'drink-price-row');
    row.append(node('strong', '', drink.name));
    const form = node('form', 'price-edit-form');
    const label = node('label', '', 'Price (£)');
    const input = document.createElement('input');
    input.type = 'text'; input.inputMode = 'decimal'; input.placeholder = 'Set price';
    input.required = true;
    input.value = state.priceDrafts.get(drink.id)?.value ?? catalogPrice([drink], drink.name);
    input.addEventListener('input', () => {
      const draft = state.priceDrafts.get(drink.id);
      state.priceDrafts.set(drink.id, { value: input.value, expectedPrice: draft?.expectedPrice ?? drink.price_pence });
    });
    label.append(input);
    const save = node('button', '', 'Save price'); save.type = 'submit';
    save.setAttribute('aria-label', `Save price for ${drink.name}`);
    form.append(label, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      let price;
      try { price = parsePence(input.value); }
      catch (error) { priceMessage(error.message, true); return; }
      save.disabled = true;
      try {
        await rpc('coffee_set_drink_price', {
          p_drink_id: drink.id, p_price_pence: price,
          p_expected_price_pence: state.priceDrafts.get(drink.id)?.expectedPrice ?? drink.price_pence
        });
        state.priceDrafts.delete(drink.id);
        await load(); priceMessage(`${drink.name} price updated.`);
      } catch (error) { priceMessage(`Couldn’t update price: ${error.message}`, true); save.disabled = false; }
    });
    const archive = node('button', 'text-button', 'Archive'); archive.type = 'button';
    archive.setAttribute('aria-label', `Archive ${drink.name}`);
    archive.addEventListener('click', async () => {
      if (!confirm(`Archive ${drink.name}? It will leave the dropdowns, but past rounds will stay unchanged.`)) return;
      archive.disabled = true;
      try { await rpc('coffee_archive_drink', { p_drink_id: drink.id }); state.priceDrafts.delete(drink.id); await load(); priceMessage(`${drink.name} archived.`); }
      catch (error) { priceMessage(`Couldn’t archive drink: ${error.message}`, true); archive.disabled = false; }
    });
    row.append(form, archive); host.append(row);
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
    if (Array.isArray(round.drink_items)) {
      row.append(node('div', 'sub', round.drink_items.map(item =>
        `${nameOf(item.person_id)}: ${item.drink[0].toUpperCase() + item.drink.slice(1)} ${money(item.price_pence)}`).join(' · ')));
      const difference = round.cost_pence - round.drink_items.reduce((sum, item) => sum + item.price_pence, 0);
      if (difference) row.append(node('div', 'sub', `${difference > 0 ? 'Extra' : 'Discount'} ${money(Math.abs(difference))} shared equally among attendees.`));
    }
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
  renderDrinkRows('round'); renderDrinkRows('historic');
  renderPeople(); renderLeaderboard(); renderHistory(); renderPriceList();
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
  const mode = historic ? 'historic' : 'round';
  const split = $(`${mode}-split`).value;
  const ids = selected(historic ? 'historic-attendees' : 'today-attendees');
  const buyerId = historic ? $('historic-buyer').value : null;
  if (historic && buyerId && !ids.includes(buyerId)) {
    if (split === 'drinks') { message('Tick the buyer as an attendee and choose their drink.', true); return; }
    ids.push(buyerId);
  }
  if (!ids.length) { message('Choose at least one attendee.',true); return; }
  if (historic && !buyerId) { message('Choose the historic buyer.',true); return; }
  let cost;
  try { cost = parsePence($(historic ? 'historic-cost' : 'round-cost').value); }
  catch (error) { message(error.message,true); return; }
  let drinks = null;
  if (split === 'drinks') {
    try { drinks = collectDrinkItems(mode, ids, cost); }
    catch (error) { message(error.message, true); return; }
  }
  const date = historic ? $('historic-date').value : today();
  if (!date) { message('Choose a date.',true); return; }
  const signature = JSON.stringify([ids,cost,date,buyerId,drinks]);
  if (!state.pending || state.pending.signature !== signature) state.pending = { signature, id: crypto.randomUUID() };
  const button = $(historic ? 'historic-button' : 'record-button'); button.disabled = true;
  try {
    const result = await rpc(drinks ? 'coffee_record_round_itemized' : 'coffee_record_round',{
      p_request_id:state.pending.id,p_attendee_ids:ids,p_cost_pence:cost,
      p_round_date:date,p_historic_buyer_id:buyerId,
      ...(drinks ? { p_drinks: drinks } : {})
    });
    state.pending = null;
    await load();
    $(historic ? 'historic-cost' : 'round-cost').value = '';
    state.drinkDrafts[mode].clear();
    state.totalAuto[mode] = true;
    if (historic) { $('historic-buyer').value = ''; $('historic-attendees').querySelectorAll('input').forEach(input => input.checked = false); }
    renderDrinkRows(mode);
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
    try {
      await rpc(prepared.catalog ? 'coffee_import_with_catalog' : 'coffee_import_legacy', {
        p_people: prepared.people, p_rounds: prepared.rounds,
        ...(prepared.catalog ? { p_catalog: prepared.catalog } : {})
      });
      state.prepared = null; box.hidden = true; await load(); message('Import complete. Download a live backup for safekeeping.');
    }
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
  $('select-all').addEventListener('click',() => { $('today-attendees').querySelectorAll('input').forEach(input => input.checked = true); clearPreview(); renderDrinkRows('round'); });
  $('clear-all').addEventListener('click',() => { $('today-attendees').querySelectorAll('input').forEach(input => input.checked = false); clearPreview(); renderDrinkRows('round'); });
  for (const mode of ['round', 'historic']) {
    $(`${mode}-split`).addEventListener('change', () => {
      if ($(`${mode}-split`).value === 'drinks') state.totalAuto[mode] = true;
      renderDrinkRows(mode);
    });
    $(`${mode}-cost`).addEventListener('input', () => {
      if ($(`${mode}-split`).value === 'drinks') {
        state.totalAuto[mode] = false;
        syncDrinkTotal(mode);
      }
    });
    $(`${mode}-use-subtotal`).addEventListener('click', () => {
      state.totalAuto[mode] = true;
      syncDrinkTotal(mode);
    });
  }
  $('historic-buyer').addEventListener('change', () => {
    const id = $('historic-buyer').value;
    if (id) {
      const input = [...$('historic-attendees').querySelectorAll('input')].find(item => item.value === id);
      if (input) input.checked = true;
    }
    renderDrinkRows('historic');
  });
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
  $('drink-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('new-drink-name').value.trim();
    if (!validDrinkName(name)) { priceMessage('Enter a drink name of up to 80 characters.', true); return; }
    let price;
    try { price = parsePence($('new-drink-price').value); }
    catch (error) { priceMessage(error.message, true); return; }
    const button = $('add-drink-button'); button.disabled = true;
    try {
      await rpc('coffee_add_drink', { p_name: name, p_price_pence: price });
      $('new-drink-name').value = ''; $('new-drink-price').value = '';
      await load(); priceMessage(`${name} added to the price list.`);
    } catch (error) { priceMessage(`Couldn’t add drink: ${error.message}`, true); }
    finally { button.disabled = false; }
  });
  $('export').addEventListener('click',() => download({format:'coffee-round-live-v1',exported_at:new Date().toISOString(),
    people:state.snapshot.people,rounds:state.snapshot.rounds,catalog:state.snapshot.drinks || []},`coffee-live-backup-${today()}.json`));
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

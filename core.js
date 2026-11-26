export const LEGACY_KEY = 'coffeeRoundTrackerLocalV3';
export const money = pence => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
export const validDrinkName = value => typeof value === 'string'
  && value.trim().length >= 1 && value.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
export const catalogPrice = (catalog, name) => {
  const drink = catalog.find(item => item.active && item.name === name);
  return Number.isInteger(drink?.price_pence) && drink.price_pence > 0
    ? (drink.price_pence / 100).toFixed(2) : '';
};

export function parsePence(value, allowZero = false) {
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a cost in pounds, up to £10,000.00.');
  const [pounds, pennies = ''] = raw.split('.');
  const result = Number(pounds) * 100 + Number(pennies.padEnd(2, '0'));
  if (result > 1000000 || (!allowZero && result === 0)) throw new Error('Enter a cost from £0.01 to £10,000.00.');
  return result;
}

export function validateDrinkItems(items, attendeeIds, totalPence) {
  const attendees = new Set(attendeeIds);
  if (!Array.isArray(items) || items.length !== attendeeIds.length || attendees.size !== attendeeIds.length)
    throw new Error('Choose one drink and price for each attendee.');
  const seen = new Set();
  for (const item of items) {
    if (!attendees.has(item?.person_id) || seen.has(item.person_id) || !validDrinkName(item.drink)
        || !Number.isInteger(item.price_pence) || item.price_pence < 1 || item.price_pence > 1000000)
      throw new Error('Choose one valid drink and price for each attendee.');
    seen.add(item.person_id);
  }
  allocateDrinkShares(items, totalPence);
  return items;
}

export function allocateDrinkShares(items, totalPence) {
  if (!Array.isArray(items) || !items.length || !Number.isInteger(totalPence))
    throw new Error('Choose drinks and a valid total.');
  const subtotal = items.reduce((sum, item) => sum + item.price_pence, 0);
  const difference = totalPence - subtotal;
  const each = Math.floor(difference / items.length);
  const penniesLeft = difference - each * items.length;
  const ordered = [...items].sort((a,b) => a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0);
  const shares = new Map(ordered.map((item,index) => [
    item.person_id, item.price_pence + each + (index < penniesLeft ? 1 : 0)
  ]));
  if ([...shares.values()].some(share => share < 0))
    throw new Error('That discount would make a person’s share negative. Adjust the total or drink prices.');
  return items.map(item => ({ ...item, share_pence: shares.get(item.person_id) }));
}

export function fairRows(people, rounds) {
  const rows = new Map(people.map(person => [person.id, {
    ...person, spent_pence: 0, share_pence: 0, bought: 0, attended: 0, balance_pence: 0
  }]));
  for (const round of rounds) {
    const buyer = rows.get(round.buyer_id);
    if (buyer) { buyer.spent_pence += round.cost_pence; buyer.bought++; }
    if (Array.isArray(round.drink_items)) {
      allocateDrinkShares(round.drink_items, round.cost_pence).forEach(item => {
        const row = rows.get(item.person_id);
        if (row) { row.share_pence += item.share_pence; row.attended++; }
      });
    } else {
      const ids = [...round.attendee_ids].sort();
      const base = Math.floor(round.cost_pence / ids.length);
      const extra = round.cost_pence % ids.length;
      ids.forEach((id, index) => {
        const row = rows.get(id);
        if (row) { row.share_pence += base + (index < extra ? 1 : 0); row.attended++; }
      });
    }
  }
  return [...rows.values()].map(row => ({ ...row, balance_pence: row.spent_pence - row.share_pence }));
}

export function chooseBuyer(rows, attendeeIds) {
  const attending = rows.filter(row => attendeeIds.includes(row.id));
  attending.sort((a, b) => a.balance_pence - b.balance_pence
    || a.spent_pence - b.spent_pence || a.bought - b.bought
    || a.name.toLocaleLowerCase('en-GB').localeCompare(b.name.toLocaleLowerCase('en-GB'))
    || a.id.localeCompare(b.id));
  return attending[0]?.id ?? null;
}

function legacyDate(value) {
  if (typeof value !== 'string') throw new Error('A history date is missing.');
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error(`Unrecognised history date: ${value}`);
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso) throw new Error(`Invalid history date: ${value}`);
  return iso;
}

export function prepareLegacy(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.people) || !Array.isArray(raw.history))
    throw new Error('This is not a Coffee Round Tracker V3 backup.');
  if (raw.people.length > 50 || raw.history.length > 5000) throw new Error('Backup is too large.');
  const all = new Map();
  const add = (name, active) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('A person has an invalid name.');
    const clean = name.trim();
    const key = clean.toLocaleLowerCase('en-GB');
    if (all.has(key)) { if (active) all.get(key).active = true; return; }
    all.set(key, { name: clean, active });
  };
  raw.people.forEach(name => add(name, true));
  if (Array.isArray(raw.archivedPeople)) raw.archivedPeople.forEach(name => add(name, false));
  const rounds = raw.history.map((item, index) => {
    if (!item || !Array.isArray(item.attendees) || item.attendees.length < 1 || item.attendees.length > 50)
      throw new Error(`History row ${index + 1} has invalid attendees.`);
    add(item.buyer, false);
    item.attendees.forEach(name => add(name, false));
    const attendeeNames = [...new Map(item.attendees.map(name => [name.trim().toLocaleLowerCase('en-GB'), name.trim()])).values()];
    if (!attendeeNames.some(name => name.toLocaleLowerCase('en-GB') === item.buyer.trim().toLocaleLowerCase('en-GB')))
      attendeeNames.push(item.buyer.trim());
    const costPence = Number.isInteger(item.cost_pence) ? item.cost_pence : parsePence(item.cost ?? 0, true);
    if (costPence < 0 || costPence > 1000000) throw new Error(`History row ${index + 1} has an invalid cost.`);
    let drinks;
    if (item.drinks != null) {
      if (!Array.isArray(item.drinks)) throw new Error(`History row ${index + 1} has invalid drinks.`);
      const byName = new Map(attendeeNames.map(name => [name.toLocaleLowerCase('en-GB'), name]));
      const seen = new Set();
      drinks = item.drinks.map(drink => {
        const person = typeof drink?.person === 'string' ? drink.person.trim() : '';
        const key = person.toLocaleLowerCase('en-GB');
        if (!byName.has(key) || seen.has(key) || !validDrinkName(drink?.drink)
            || !Number.isInteger(drink.price_pence) || drink.price_pence < 1 || drink.price_pence > 1000000)
          throw new Error(`History row ${index + 1} has invalid drinks.`);
        seen.add(key);
        return { person: byName.get(key), drink: drink.drink, price_pence: drink.price_pence };
      });
      if (drinks.length !== attendeeNames.length)
        throw new Error(`History row ${index + 1} has a missing drink.`);
    }
    return { date: legacyDate(item.date), buyer: item.buyer.trim(), attendees: attendeeNames,
      cost_pence: costPence, time: typeof item.time === 'string' ? item.time.slice(0,40) : '',
      ...(drinks ? { drinks } : {}) };
  });
  if (all.size < 1 || all.size > 50) throw new Error('Backup must contain 1 to 50 people.');
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const reconstructed = new Map([...all.values()].map(person => [person.name.toLocaleLowerCase('en-GB'), { attended: 0, bought: 0, spent_pence: 0 }]));
  for (const round of rounds) {
    reconstructed.get(round.buyer.toLocaleLowerCase('en-GB')).bought++;
    reconstructed.get(round.buyer.toLocaleLowerCase('en-GB')).spent_pence += round.cost_pence;
    round.attendees.forEach(name => reconstructed.get(name.toLocaleLowerCase('en-GB')).attended++);
  }
  const discrepancies = [];
  for (const [name, old] of Object.entries(stats)) {
    const actual = reconstructed.get(name.toLocaleLowerCase('en-GB'));
    if (!actual) continue;
    const spent = Math.round(Number(old.spent || 0) * 100);
    if (actual.attended !== Number(old.attended || 0) || actual.bought !== Number(old.bought || 0) || actual.spent_pence !== spent)
      discrepancies.push(name);
  }
  return { people: [...all.values()], rounds, discrepancies };
}

export function prepareCatalog(raw) {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('Invalid drink price list.');
  const seen = new Set();
  return raw.map(item => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const key = name.toLocaleLowerCase('en-GB');
    if (!validDrinkName(name) || seen.has(key) || typeof item.active !== 'boolean'
        || (item.price_pence !== null && (!Number.isInteger(item.price_pence)
          || item.price_pence < 1 || item.price_pence > 1000000)))
      throw new Error('Invalid drink price list.');
    seen.add(key);
    return { name, price_pence: item.price_pence, active: item.active };
  });
}

export function prepareBackup(raw) {
  if (raw?.format !== 'coffee-round-live-v1') return prepareLegacy(raw);
  if (!Array.isArray(raw.people) || !Array.isArray(raw.rounds)) throw new Error('Invalid live backup.');
  const byId = new Map(raw.people.map(person => [person.id, person.name]));
  const prepared = prepareLegacy({
    people: raw.people.filter(person => person.active).map(person => person.name),
    archivedPeople: raw.people.filter(person => !person.active).map(person => person.name),
    history: raw.rounds.map(round => {
      const [year, month, day] = round.round_date.split('-');
      return { date: `${day}/${month}/${year}`, buyer: byId.get(round.buyer_id),
        attendees: round.attendee_ids.map(id => byId.get(id)), cost_pence: round.cost_pence,
        time: round.display_time || '',
        ...(Array.isArray(round.drink_items) ? { drinks: round.drink_items.map(item => ({
          person: byId.get(item.person_id), drink: item.drink, price_pence: item.price_pence
        })) } : {}) };
    })
  });
  if (raw.catalog != null) prepared.catalog = prepareCatalog(raw.catalog);
  return prepared;
}

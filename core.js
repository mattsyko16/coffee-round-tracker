export const LEGACY_KEY = 'coffeeRoundTrackerLocalV3';
export const money = pence => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

export function parsePence(value, allowZero = false) {
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a cost in pounds, up to £10,000.00.');
  const [pounds, pennies = ''] = raw.split('.');
  const result = Number(pounds) * 100 + Number(pennies.padEnd(2, '0'));
  if (result > 1000000 || (!allowZero && result === 0)) throw new Error('Enter a cost from £0.01 to £10,000.00.');
  return result;
}

export function fairRows(people, rounds) {
  const rows = new Map(people.map(person => [person.id, {
    ...person, spent_pence: 0, share_pence: 0, bought: 0, attended: 0, balance_pence: 0
  }]));
  for (const round of rounds) {
    const buyer = rows.get(round.buyer_id);
    if (buyer) { buyer.spent_pence += round.cost_pence; buyer.bought++; }
    const ids = [...round.attendee_ids].sort();
    const base = Math.floor(round.cost_pence / ids.length);
    const extra = round.cost_pence % ids.length;
    ids.forEach((id, index) => {
      const row = rows.get(id);
      if (row) { row.share_pence += base + (index < extra ? 1 : 0); row.attended++; }
    });
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
  const rounds = raw.history.map((item, index) => {
    if (!item || !Array.isArray(item.attendees) || item.attendees.length < 1 || item.attendees.length > 50)
      throw new Error(`History row ${index + 1} has invalid attendees.`);
    add(item.buyer, false);
    item.attendees.forEach(name => add(name, false));
    const attendeeNames = [...new Map(item.attendees.map(name => [name.trim().toLocaleLowerCase('en-GB'), name.trim()])).values()];
    if (!attendeeNames.some(name => name.toLocaleLowerCase('en-GB') === item.buyer.trim().toLocaleLowerCase('en-GB')))
      attendeeNames.push(item.buyer.trim());
    return { date: legacyDate(item.date), buyer: item.buyer.trim(), attendees: attendeeNames,
      cost_pence: parsePence(item.cost ?? 0, true), time: typeof item.time === 'string' ? item.time.slice(0,40) : '' };
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


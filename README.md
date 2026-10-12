# Coffee Round Tracker · Live

A shared, mobile-friendly coffee board. Members enter their name and one private access code; they do not configure Supabase. Each browser gets an anonymous Supabase account. The access code is checked in the database and is never included in the website files.

This is a **new app for a new Supabase project**. The currently deployed coffee app and its database are not changed by these files.

## What it does

- Records a buyer, date, actual cost, and exact attendees for each round.
- Calculates each attendee's share of each round in integer pennies. Odd pennies go to attendee IDs in a fixed order, so the round's shares always add to its cost.
- Shows fair balance as **paid minus share**. Positive is ahead; negative is behind.
- Previews the most-behind present person before saving. The database chooses again inside a locked transaction at save time, so simultaneous phones cannot both rely on a stale preview. The saved buyer is shown afterward.
- Adds historic rounds, archives people without erasing their history, shows leaderboard and history, deletes erroneous rounds, and downloads a live JSON backup.
- Imports the old `coffeeRoundTrackerLocalV3` data or a JSON backup into an **empty** live board. Only the first member to join can import.
- Refreshes after changes via Realtime, with a 30-second foreground fallback.

## Owner setup

1. Create a **new** Supabase project. In **Authentication → Providers**, enable **Anonymous Sign-Ins**. Do not reuse the Empty Threats project or any currently deployed coffee database.
2. In its SQL Editor, run `supabase.sql` once. This creates new `coffee_*` tables and RPCs. Keep the SQL file for review; it does not contain a code or credentials.
3. Generate a long random code in SQL Editor:

   ```sql
   select replace(gen_random_uuid()::text, '-', '') as access_code;
   ```

   Copy the 32-character result privately. Set its hash with a separate statement, replacing the placeholder:

   ```sql
   update public.coffee_settings
   set code_hash = encode(sha256(convert_to('PASTE-ACCESS-CODE-HERE','UTF8')),'hex')
   where id = true;
   ```

4. Copy the new project's URL and **publishable** key from Supabase into `config.js`. The publishable key is meant to be public. Never put the access code, a secret key, or a service-role key in that file.
5. Serve these files over HTTPS as a static site. GitHub Pages works: put `index.html`, `styles.css`, `core.js`, `app.js`, and `config.js` at the repository root, then enable Pages from that branch. Do not replace the existing coffee repository's deployed branch unless you later decide to switch over.
6. Open the new URL, enter your name and access code. The first successfully joined browser becomes the import admin. Add people manually or import the old data before creating new rounds. Share the new URL and code with members.

Run `npm test` locally to check money calculations and legacy import preparation. In a disposable Supabase project, run `tests/schema-audit.sql` after the schema to verify RLS and grants. No build step is required.

## Bring over the old phone data

1. Open the **old** coffee app on the phone that holds the data and use **Export Backup**. Save the JSON file somewhere safe. Keep the old app and its data until you have checked the live board.
2. Join the new board **first** with your own browser. If the old and new pages share the same origin, **Find old data on this device** can read `coffeeRoundTrackerLocalV3`. Otherwise use **Import backup file** and select the exported JSON.
3. Review the import preview. It reports any names whose old cumulative stats differ from what the recorded history reconstructs. The live board uses recorded rounds as the source of truth; it cannot infer unrecorded spend or attendance from summary totals.
4. Import while the live board is empty. Compare the people, history, spend, and balances with the old app. Download a live backup.

The import is atomic: an invalid row fails the whole transaction, and an already populated live board rejects import. The import does not remove the old browser's local storage. A live backup can also be imported into another **new, empty** board using the same import control.

## Access and safety

- A high-entropy code is hashed in the database. Anyone with the code can join, so share it privately. Changing the hash stops future joins with the old code; existing member devices stay members until removed.
- Supabase's `authenticated` role includes anonymous signed-in browsers. Every board RPC checks for membership. Only the first member can run import. Direct writes to app tables are revoked; row-level security is enabled on all tables. The revision marker is the only Realtime table, and its select policy permits joined members only.
- To revoke a device, delete its row from `public.coffee_members` in SQL Editor. Rotate the code too if that device knows it. To see members, query `select user_id, display_name, is_admin, joined_at from public.coffee_members order by joined_at;` in SQL Editor.
- Inputs are validated again by SQL, including member IDs, unique attendees, cost, date, and the empty-board import condition. Saves use idempotency IDs and serialize on the revision row. Text from the database and backup is rendered with `textContent`.
- New phones or cleared browser data need the code again. A device cannot recover its anonymous session after browser storage is cleared.

## Source references

This implementation follows the [existing coffee tracker](https://github.com/mattsyko16/coffee-round-tracker) for features and the [Empty Threats Song Chooser](https://github.com/mattsyko16/Empty-Threats-Song-Chooser) for anonymous sessions and server-side code verification. Its database permissions and serialized round writes are specific to this app.


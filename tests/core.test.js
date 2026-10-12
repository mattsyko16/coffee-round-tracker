import test from 'node:test';
import assert from 'node:assert/strict';
import { fairRows, chooseBuyer, parsePence, prepareLegacy } from '../core.js';

const people = [
  {id:'00000000-0000-0000-0000-000000000001',name:'Matt',active:true},
  {id:'00000000-0000-0000-0000-000000000002',name:'Dan',active:true},
  {id:'00000000-0000-0000-0000-000000000003',name:'Kris',active:true}
];

test('spend fairness divides each actual round among only its attendees', () => {
  const rounds = [
    {buyer_id:people[0].id,attendee_ids:[people[0].id,people[1].id],cost_pence:1001},
    {buyer_id:people[2].id,attendee_ids:[people[0].id,people[2].id],cost_pence:600}
  ];
  const rows = fairRows(people,rounds);
  assert.deepEqual(rows.map(r => r.share_pence),[801,500,300]);
  assert.deepEqual(rows.map(r => r.balance_pence),[200,-500,300]);
  assert.equal(rows.reduce((sum,row) => sum + row.balance_pence,0),0);
  assert.equal(chooseBuyer(rows,[people[0].id,people[1].id]),people[1].id);
  assert.equal(chooseBuyer(rows,[people[0].id,people[2].id]),people[0].id);
});

test('odd penny allocation and tie-breaks are deterministic', () => {
  const rows = fairRows(people,[{buyer_id:people[2].id,attendee_ids:[people[2].id,people[0].id,people[1].id],cost_pence:1}]);
  assert.deepEqual(rows.map(row => row.share_pence),[1,0,0]);
  assert.equal(rows.reduce((sum,row) => sum + row.share_pence,0),1);
  assert.equal(chooseBuyer(fairRows(people,[]),people.map(p => p.id)),people[1].id);
});

test('costs use integer pennies and reject ambiguous amounts', () => {
  assert.equal(parsePence('9.6'),960);
  assert.equal(parsePence('0',true),0);
  for (const value of ['1.999','-1','Infinity','', '10000.01']) assert.throws(() => parsePence(value));
});

test('legacy migration keeps removed participants as archived and reports unreconstructable totals', () => {
  const backup = {people:['Matt','Dan'],stats:{Matt:{attended:9,bought:9,spent:90}},history:[
    {date:'03/10/2026',buyer:'Jack',attendees:['Matt','Jack'],cost:9.6}
  ]};
  const migrated = prepareLegacy(backup);
  assert.deepEqual(migrated.people,[{name:'Matt',active:true},{name:'Dan',active:true},{name:'Jack',active:false}]);
  assert.deepEqual(migrated.rounds[0],{date:'2026-10-03',buyer:'Jack',attendees:['Matt','Jack'],cost_pence:960,time:''});
  assert.deepEqual(migrated.discrepancies,['Matt']);
  assert.deepEqual(backup.people,['Matt','Dan']);
});

test('legacy migration rejects invalid dates and malformed data', () => {
  assert.throws(() => prepareLegacy({people:['Matt'],history:[{date:'31/02/2026',buyer:'Matt',attendees:['Matt'],cost:2}]}));
  assert.throws(() => prepareLegacy({people:['Matt'],history:[{date:'01/10/2026',buyer:'Matt',attendees:[],cost:2}]}));
});


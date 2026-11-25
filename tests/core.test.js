import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogPrice, fairRows, chooseBuyer, parsePence, prepareBackup, prepareCatalog, prepareLegacy, validateDrinkItems } from '../core.js';

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

test('individual drink prices change fair shares and the next buyer', () => {
  const ids = people.map(person => person.id);
  const drinks = [
    {person_id:ids[0],drink:'latte',price_pence:500},
    {person_id:ids[1],drink:'tea',price_pence:200},
    {person_id:ids[2],drink:'latte',price_pence:500}
  ];
  assert.equal(validateDrinkItems(drinks,ids,1200),drinks);
  const rows = fairRows(people,[{buyer_id:ids[0],attendee_ids:ids,cost_pence:1200,drink_items:drinks}]);
  assert.deepEqual(rows.map(row => row.share_pence),[500,200,500]);
  assert.deepEqual(rows.map(row => row.balance_pence),[700,-200,-500]);
  assert.equal(chooseBuyer(rows,ids),ids[2]);
  assert.equal(rows.reduce((sum,row) => sum + row.balance_pence,0),0);
});

test('drink list requires one valid price per attendee and must match the bill', () => {
  const ids = [people[0].id,people[1].id];
  const valid = [
    {person_id:ids[0],drink:'americano',price_pence:300},
    {person_id:ids[1],drink:'tea',price_pence:200}
  ];
  assert.throws(() => validateDrinkItems(valid,ids,600),/add up/);
  assert.throws(() => validateDrinkItems([valid[0],valid[0]],ids,600));
  assert.equal(validateDrinkItems([{...valid[0],drink:'Flat white'},valid[1]],ids,500).length,2);
  assert.throws(() => validateDrinkItems([{...valid[0],drink:'\n'},valid[1]],ids,500));
  assert.throws(() => validateDrinkItems([valid[0]],ids,300));
});

test('the shared price list supplies current defaults without changing recorded prices', () => {
  const catalog = [
    {name:'Tea',price_pence:210,active:true},
    {name:'Latte',price_pence:430,active:true},
    {name:'Flat white',price_pence:null,active:true},
    {name:'Old drink',price_pence:300,active:false}
  ];
  assert.equal(catalogPrice(catalog,'Tea'),'2.10');
  assert.equal(catalogPrice(catalog,'Latte'),'4.30');
  assert.equal(catalogPrice(catalog,'Flat white'),'');
  assert.equal(catalogPrice(catalog,'Old drink'),'');
  const [matt,dan] = people;
  const rows = fairRows([matt,dan],[{buyer_id:matt.id,attendee_ids:[matt.id,dan.id],cost_pence:600,
    drink_items:[{person_id:matt.id,drink:'Latte',price_pence:400},{person_id:dan.id,drink:'Tea',price_pence:200}]}]);
  assert.deepEqual(rows.map(row => row.share_pence),[400,200]);
});

test('live backup retains drink prices and archived people for import', () => {
  const [matt,dan,kris] = people;
  const backup = {format:'coffee-round-live-v1',catalog:[
    {name:'Tea',price_pence:210,active:true},
    {name:'Flat white',price_pence:390,active:true}
  ],people:[
    {...matt,active:true},{...dan,active:true},{...kris,active:false}
  ],rounds:[{round_date:'2026-11-25',buyer_id:matt.id,attendee_ids:[matt.id,dan.id],
    cost_pence:700,drink_items:[
      {person_id:matt.id,drink:'latte',price_pence:500},
      {person_id:dan.id,drink:'tea',price_pence:200}
    ]}]};
  const prepared = prepareBackup(backup);
  assert.deepEqual(prepared.people.map(person => person.active),[true,true,false]);
  assert.deepEqual(prepared.rounds[0].drinks,[
    {person:'Matt',drink:'latte',price_pence:500},
    {person:'Dan',drink:'tea',price_pence:200}
  ]);
  assert.equal(prepared.rounds[0].cost_pence,700);
  assert.deepEqual(prepared.catalog,backup.catalog);
});

test('drink catalog backup rejects duplicate and invalid prices', () => {
  assert.deepEqual(prepareCatalog([{name:' Flat white ',price_pence:390,active:true}]),
    [{name:'Flat white',price_pence:390,active:true}]);
  assert.throws(() => prepareCatalog([
    {name:'Tea',price_pence:200,active:true},
    {name:'tea',price_pence:210,active:true}
  ]));
  assert.throws(() => prepareCatalog([{name:'Tea',price_pence:-1,active:true}]));
});


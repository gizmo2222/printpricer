// Runs firestore.rules against the Firebase Rules test API (no emulator).
// Usage (PowerShell): $env:TOKEN = (gcloud auth print-access-token); npm run test:rules-api
// The emulator suite in rules-tests/ (npm run test:rules) is the main check; this one needs a live-project token.
// $env:INVERT = '1' flips every expectation; all cases should then fail.
import { readFileSync } from 'node:fs';

const PROJECT = 'printpricer';
const rules = readFileSync(process.argv[2] || 'firestore.rules', 'utf8');
const D = '/databases/(default)/documents';
const TIME = '2026-11-05T12:00:00Z';
const NOW = Date.parse(TIME);

const OWNER = 'ownerUid', MEMBER = 'memberUid', OUT = 'outsiderUid';
const EMAIL = { [OWNER]: 'o@x.com', [MEMBER]: 'm@x.com', [OUT]: 'out@x.com' };
const G = {
  name: 'Shop', joinCode: 'ABCD-EFGH', ownerUid: OWNER,
  members: [OWNER, MEMBER], memberEmails: { [OWNER]: EMAIL[OWNER], [MEMBER]: EMAIL[MEMBER] },
  createdAt: TIME,
};
const auth = (uid, provider = 'password') => ({
  uid, token: { email: EMAIL[uid] || '', firebase: { sign_in_provider: provider } },
});
const mockGet = (fn, data) => ({ function: fn, args: [{ anyValue: {} }], result: { value: data === null ? null : { data } } });
const mockExists = v => ({ function: 'exists', args: [{ anyValue: {} }], result: { value: v } });
const groupGet = [mockGet('get', G)];

const cases = [];
function t(name, expect, { as, path, method, data, existing, mocks = [], provider }) {
  const request = { auth: as ? auth(as, provider) : null, path: D + path, method, time: TIME };
  if (data !== undefined) request.resource = { data };
  const tc = { expectation: expect, request, functionMocks: mocks };
  if (existing !== undefined) tc.resource = { data: existing };
  cases.push({ name, tc });
}
const upd = (name, expect, as, changes, extra = {}) =>
  t(name, expect, { as, path: '/groups/G', method: 'update', data: { ...G, ...changes }, existing: G, ...extra });
const without = (obj, k) => { const o = { ...obj }; delete o[k]; return o; };

// ---- hole 1: group updates by role
upd('1 member makes self owner', 'DENY', MEMBER, { ownerUid: MEMBER });
upd('2 member removes owner', 'DENY', MEMBER, { members: [MEMBER], memberEmails: { [MEMBER]: EMAIL[MEMBER] } });
upd('3 member changes join code', 'DENY', MEMBER, { joinCode: 'ZZZZ-ZZZZ' });
upd('4 member renames', 'ALLOW', MEMBER, { name: 'New name' });
upd('4b member empty name', 'DENY', MEMBER, { name: '' });
upd('5 member leaves', 'ALLOW', MEMBER, { members: [OWNER], memberEmails: without(G.memberEmails, MEMBER) });
upd('5b member leaves but keeps email', 'DENY', MEMBER, { members: [OWNER] });
upd('6 owner leaves', 'DENY', OWNER, { members: [MEMBER], memberEmails: without(G.memberEmails, OWNER) });
upd('7 owner removes member', 'ALLOW', OWNER, { members: [OWNER], memberEmails: without(G.memberEmails, MEMBER) });
upd('7b owner rotates code', 'ALLOW', OWNER, { joinCode: 'WXYZ-2345' });
upd('7c owner adds outsider', 'DENY', OWNER, { members: [OWNER, MEMBER, OUT] });
upd('7d owner hands over to member', 'ALLOW', OWNER, { ownerUid: MEMBER });
upd('7e owner hands over to outsider', 'DENY', OWNER, { ownerUid: OUT });
upd('7f owner edits a member email', 'DENY', OWNER, { memberEmails: { ...G.memberEmails, [MEMBER]: 'evil@x.com' } });
upd('7g member refreshes own email', 'ALLOW', MEMBER, { memberEmails: { ...G.memberEmails } });
upd('7h member sets fake own email', 'DENY', MEMBER, { memberEmails: { ...G.memberEmails, [MEMBER]: 'o@x.com' } });

// ---- hole 2: joining proves the current code
const join = { members: [OWNER, MEMBER, OUT], memberEmails: { ...G.memberEmails, [OUT]: EMAIL[OUT] } };
upd('8 outsider joins, no code written', 'DENY', OUT, join, { mocks: [mockGet('getAfter', { currentGroupId: 'G' })] });
upd('9 outsider joins with current code', 'ALLOW', OUT, join, { mocks: [mockGet('getAfter', { currentGroupId: 'G', joinCode: 'ABCD-EFGH' })] });
upd('10 outsider joins with fake email', 'DENY', OUT, { ...join, memberEmails: { ...G.memberEmails, [OUT]: 'o@x.com' } },
  { mocks: [mockGet('getAfter', { joinCode: 'ABCD-EFGH' })] });
upd('11 outsider joins with old code', 'DENY', OUT, join, { mocks: [mockGet('getAfter', { joinCode: 'OLD-COD' })] });
upd('11b outsider adds a friend too', 'DENY', OUT, { ...join, members: [OWNER, MEMBER, OUT, 'friend'] },
  { mocks: [mockGet('getAfter', { joinCode: 'ABCD-EFGH' })] });
upd('11c outsider joins and renames', 'DENY', OUT, { ...join, name: 'Mine' }, { mocks: [mockGet('getAfter', { joinCode: 'ABCD-EFGH' })] });
upd('11d anonymous joins', 'DENY', OUT, join, { provider: 'anonymous', mocks: [mockGet('getAfter', { joinCode: 'ABCD-EFGH' })] });
const LEG = { ...G, joinCode: 'ABC-DEF' };
t('11e join legacy 6-char group', 'ALLOW', { as: OUT, path: '/groups/G', method: 'update', existing: LEG,
  data: { ...LEG, ...join }, mocks: [mockGet('getAfter', { joinCode: 'ABC-DEF' })] });

// ---- group create / read
const NEWG = { name: 'Mine', joinCode: 'QRST-UVWX', ownerUid: OUT, members: [OUT], memberEmails: { [OUT]: EMAIL[OUT] }, createdAt: TIME };
t('26 create group', 'ALLOW', { as: OUT, path: '/groups/N', method: 'create', data: NEWG });
t('26b create group with extra member', 'DENY', { as: OUT, path: '/groups/N', method: 'create', data: { ...NEWG, members: [OUT, MEMBER] } });
t('26c create group with fake email', 'DENY', { as: OUT, path: '/groups/N', method: 'create', data: { ...NEWG, memberEmails: { [OUT]: 'o@x.com' } } });
t('26d create group for someone else', 'DENY', { as: OUT, path: '/groups/N', method: 'create', data: { ...NEWG, ownerUid: MEMBER } });
t('26e create group bad code', 'DENY', { as: OUT, path: '/groups/N', method: 'create', data: { ...NEWG, joinCode: 'abc' } });
t('27 outsider reads group', 'DENY', { as: OUT, path: '/groups/G', method: 'get', existing: G });
t('27b member reads group', 'ALLOW', { as: MEMBER, path: '/groups/G', method: 'get', existing: G });

// ---- join codes
t('28 get a code', 'ALLOW', { as: OUT, path: '/joinCodes/ABCD-EFGH', method: 'get', existing: { gid: 'G' } });
t('24 list codes', 'DENY', { as: OUT, path: '/joinCodes/ABCD-EFGH', method: 'list', existing: { gid: 'G' } });
t('25 owner registers rotated code', 'ALLOW', { as: OWNER, path: '/joinCodes/WXYZ-2345', method: 'create', data: { gid: 'G' },
  mocks: [mockGet('getAfter', { ...G, joinCode: 'WXYZ-2345' })] });
t('25b owner registers non-current code', 'DENY', { as: OWNER, path: '/joinCodes/WXYZ-2345', method: 'create', data: { gid: 'G' },
  mocks: [mockGet('getAfter', G)] });
t('25c member registers code', 'DENY', { as: MEMBER, path: '/joinCodes/ABCD-EFGH', method: 'create', data: { gid: 'G' },
  mocks: [mockGet('getAfter', G)] });
t('25d overwrite a code', 'DENY', { as: OWNER, path: '/joinCodes/ABCD-EFGH', method: 'update', data: { gid: 'G' }, existing: { gid: 'X' },
  mocks: [mockGet('getAfter', G)] });
t('23 member deletes code', 'DENY', { as: MEMBER, path: '/joinCodes/ABCD-EFGH', method: 'delete', existing: { gid: 'G' }, mocks: [mockExists(true), ...groupGet] });
t('23b owner deletes code', 'ALLOW', { as: OWNER, path: '/joinCodes/ABCD-EFGH', method: 'delete', existing: { gid: 'G' }, mocks: [mockExists(true), ...groupGet] });
t('23c anyone deletes orphan code', 'ALLOW', { as: OUT, path: '/joinCodes/ABCD-EFGH', method: 'delete', existing: { gid: 'gone' }, mocks: [mockExists(false)] });

// ---- holes 4 & 6: activity
const ACT = { uid: MEMBER, email: EMAIL[MEMBER], action: 'stamped an estimate', timestamp: NOW };
const act = (name, expect, data, as = MEMBER) => t(name, expect, { as, path: '/groups/G/activity/a', method: 'create', data, mocks: groupGet });
act('12 member logs activity', 'ALLOW', ACT);
act('13 activity with fake email', 'DENY', { ...ACT, email: 'o@x.com' });
act('13b activity as someone else', 'DENY', { ...ACT, uid: OWNER });
act('14 activity in the future', 'DENY', { ...ACT, timestamp: NOW + 3600000 });
act('14b activity extra key', 'DENY', { ...ACT, pinned: true });
act('14c activity huge action', 'DENY', { ...ACT, action: 'x'.repeat(601) });
act('14d outsider logs activity', 'DENY', { ...ACT, uid: OUT, email: EMAIL[OUT] }, OUT);
t('15 member deletes activity', 'DENY', { as: MEMBER, path: '/groups/G/activity/a', method: 'delete', existing: ACT, mocks: groupGet });
t('16 owner deletes activity', 'ALLOW', { as: OWNER, path: '/groups/G/activity/a', method: 'delete', existing: ACT, mocks: groupGet });
t('16b member edits activity', 'DENY', { as: MEMBER, path: '/groups/G/activity/a', method: 'update', data: ACT, existing: ACT, mocks: groupGet });

// ---- holes 3 & 5: sub-collections
const sub = (name, expect, path, method, data, as = MEMBER, existing) => t(name, expect, { as, path: '/groups/G/' + path, method, data, existing, mocks: groupGet });
const PRODUCT = { name: 'Vase', notes: '', sellPrice: '', photos: [], printerId: '1730000000000', hours: 2.5,
  laborMinutes: '', packagingCost: '', shippingCost: '', filaments: [{ name: 'PLA', grams: 40, costPerKg: 25 }], bom: [] };
sub('18 member saves product', 'ALLOW', 'products/p', 'create', PRODUCT);
sub('18a member updates legacy product', 'ALLOW', 'products/p', 'update', { ...PRODUCT, photo: 'data:x' }, MEMBER, PRODUCT);
sub('17 product unknown key', 'DENY', 'products/p', 'create', { ...PRODUCT, foo: 1 });
sub('18b product 25 photos', 'DENY', 'products/p', 'create', { ...PRODUCT, photos: Array(25).fill('x') });
sub('18c product filaments not a list', 'DENY', 'products/p', 'create', { ...PRODUCT, filaments: 'x' });
const SPOOL = { name: 'Black PLA', material: 'PLA', color: '#222222', costPerKg: 25, spoolGrams: 1000, remainingGrams: 800, notes: '',
  refillHistory: [{ date: NOW, grams: 200, afterGrams: 1000, op: 'refill' }] };
sub('18d member saves spool', 'ALLOW', 'spools/s', 'create', SPOOL);
sub('18e spool costPerKg as string', 'ALLOW', 'spools/s', 'update', { ...SPOOL, costPerKg: '25' }, MEMBER, SPOOL);
sub('18f spool name a map', 'DENY', 'spools/s', 'create', { ...SPOOL, name: { a: 1 } });
const PRINTER = { name: 'My Printer', preset: '', watts: '120', hourlyRate: '', gramsPerHour: '', swapPct: '' };
sub('18g member saves printer', 'ALLOW', 'printers/p', 'create', PRINTER);
sub('18h printer extra key', 'DENY', 'printers/p', 'create', { ...PRINTER, admin: true });
sub('18i member deletes product', 'ALLOW', 'products/p', 'delete', undefined, MEMBER, PRODUCT);
const ARCH = { name: 'x', date: '2026-11-05T12:00:00.000Z', hours: 1, grams: 10, printerId: null, printerName: null, filaments: [], breakdown: { total: 3 } };
sub('19 member edits archive entry', 'DENY', 'archive/a', 'update', ARCH, MEMBER, ARCH);
sub('19b owner edits archive entry', 'ALLOW', 'archive/a', 'update', ARCH, OWNER, ARCH);
sub('20 member deletes archive entry', 'ALLOW', 'archive/a', 'delete', undefined, MEMBER, ARCH);
sub('20b member stamps archive entry', 'ALLOW', 'archive/a', 'create', ARCH);
sub('21 member writes settings/other', 'DENY', 'settings/other', 'create', { a: 1 });
sub('21b member writes settings/main', 'ALLOW', 'settings/main', 'update', { kwh: '0.15' }, MEMBER, {});
sub('21c member deletes settings/main', 'DENY', 'settings/main', 'delete', undefined, MEMBER, {});
sub('22 outsider reads spool', 'DENY', 'spools/s', 'get', undefined, OUT, SPOOL);
sub('22b member reads spool', 'ALLOW', 'spools/s', 'get', undefined, MEMBER, SPOOL);
sub('22c outsider writes product', 'DENY', 'products/p', 'create', PRODUCT, OUT);

// ---- users
t('30 user writes own doc', 'ALLOW', { as: OUT, path: '/users/' + OUT, method: 'update', data: { currentGroupId: 'G', joinCode: 'ABCD-EFGH' }, existing: {} });
t('30b user writes other doc', 'DENY', { as: OUT, path: '/users/' + MEMBER, method: 'update', data: { joinCode: 'x' }, existing: {} });

const body = { source: { files: [{ name: 'firestore.rules', content: rules }] },
  testSuite: { testCases: cases.map(c => process.env.INVERT ? { ...c.tc, expectation: c.tc.expectation === 'ALLOW' ? 'DENY' : 'ALLOW' } : c.tc) } };
const res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}:test`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.TOKEN}`, 'Content-Type': 'application/json', 'x-goog-user-project': PROJECT },
  body: JSON.stringify(body),
});
const out = await res.json();
// process.exitCode, not process.exit(): exiting right after fetch crashes Node on Windows.
if (!res.ok) {
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = 2;
} else {
  if (out.issues?.length) console.log('ISSUES', JSON.stringify(out.issues, null, 2));
  const results = out.testResults || [];
  let fail = 0;
  results.forEach((r, i) => {
    if (r.state !== 'SUCCESS') {
      fail++;
      console.log(`FAIL ${cases[i].name}: expected ${cases[i].tc.expectation}`, JSON.stringify(r.debugMessages || r.errorPosition || ''));
    }
  });
  if (results.length !== cases.length) fail = cases.length;
  console.log(`cases ${cases.length}, results ${results.length}, fail ${fail}`);
  process.exitCode = fail ? 1 : 0;
}

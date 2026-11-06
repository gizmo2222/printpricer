// Firestore emulator suite for ../firestore.rules. Run: npm test (see package.json).
import { readFileSync } from 'node:fs';
import { describe, it, before, after, beforeEach } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  writeBatch, arrayUnion, arrayRemove, deleteField, serverTimestamp,
} from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-printpricer',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 } });
});
after(() => env.cleanup());
beforeEach(async () => { await env.clearFirestore(); await seed(); });

const OWNER = 'ownerUid', MEMBER = 'memberUid', OUT = 'outsiderUid', G = 'G';
const EMAIL = { [OWNER]: 'o@x.com', [MEMBER]: 'm@x.com', [OUT]: 'out@x.com' };
const CODE = 'ABCD-EFGH';
const GROUP = { name: 'Shop', joinCode: CODE, ownerUid: OWNER, members: [OWNER, MEMBER],
  memberEmails: { [OWNER]: EMAIL[OWNER], [MEMBER]: EMAIL[MEMBER] }, createdAt: new Date('2026-11-05T12:00:00Z') };
const ANON = { firebase: { sign_in_provider: 'anonymous' } };
const who = {
  owner: () => env.authenticatedContext(OWNER, { email: EMAIL[OWNER] }).firestore(),
  member: () => env.authenticatedContext(MEMBER, { email: EMAIL[MEMBER] }).firestore(),
  outsider: () => env.authenticatedContext(OUT, { email: EMAIL[OUT] }).firestore(),
  anonOwner: () => env.authenticatedContext(OWNER, { email: EMAIL[OWNER], ...ANON }).firestore(),
  anonMember: () => env.authenticatedContext(MEMBER, { email: EMAIL[MEMBER], ...ANON }).firestore(),
  anonOutsider: () => env.authenticatedContext(OUT, { email: EMAIL[OUT], ...ANON }).firestore(),
  unauth: () => env.unauthenticatedContext().firestore(),
};
const gref = (db, p = '') => doc(db, 'groups/' + G + (p ? '/' + p : ''));
const ok = p => assertSucceeds(p), no = p => assertFails(p);

const ACT = { uid: MEMBER, email: EMAIL[MEMBER], action: 'stamped an estimate', timestamp: Date.now() };
const PRODUCT = { name: 'Vase', notes: '', sellPrice: '', photos: [], printerId: '1730000000000', hours: 2.5,
  laborMinutes: '', packagingCost: '', shippingCost: '', filaments: [{ name: 'PLA', grams: 40 }], bom: [] };
const SPOOL = { name: 'Black PLA', material: 'PLA', color: '#222222', costPerKg: 25, spoolGrams: 1000, remainingGrams: 800, notes: '',
  refillHistory: [{ date: 1, grams: 200 }] };
const PRINTER = { name: 'My Printer', preset: '', watts: '120', hourlyRate: '', gramsPerHour: '', swapPct: '' };
// Real shapes: `entry` in archive.js saveQuote (id stripped by pushDiff), and defaultSettings in state.js.
const SETTINGS = { filamentCost: '25', kwh: '0.15', failurePct: '5', marginPct: '30', estDensity: '', estFillPct: '', laborRate: '20',
  marketplacePreset: 'etsy', marketplaceCustomListing: '', marketplaceCustomTxnPct: '', marketplaceCustomPaymentPct: '',
  marketplaceCustomPaymentFlat: '', businessName: 'Shop', businessEmail: 'hi@x.com', businessNotes: 'Portland' };
const LEGACY_SETTINGS = { ...SETTINGS, estGramsPerHour: '', estSwapPct: '', hourlyRate: '1.5', printerPreset: 'Bambu X1C', watts: 120 };
const ARCH = { name: 'Vase', date: '2026-11-05T12:00:00.000Z', hours: 2.5, grams: 40, printerId: 1730000000000, printerName: 'My Printer',
  filaments: [{ name: 'PLA', grams: 40, spoolId: 's' }],
  addons: { laborMinutes: 10, packagingCost: 0, shippingCost: 0, notes: '', sellPrice: '', photos: [], bom: [{ name: 'Magnet', qty: 2, unitCost: 0.1 }] },
  breakdown: { filament: 1, electricity: 0.1, time: 0.5, labor: 3, packaging: 0, bom: 0.2, shipping: 0, subtotal: 4.8, failure: 0.2, margin: 1.5, total: 6.5, fees: 0, net: 6.5 },
  settingsSnapshot: SETTINGS };
const LEGACY_ARCH = { id: 1700000000000, name: 'Old', date: '2025-01-01T00:00:00.000Z', hours: 1, grams: 10, printerId: null, printerName: null,
  filaments: [], breakdown: { total: 3 }, settingsSnapshot: LEGACY_SETTINGS };

async function seed() {
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    await setDoc(gref(d), GROUP);
    await setDoc(doc(d, 'joinCodes', CODE), { gid: G });
    await setDoc(doc(d, 'groups', 'other'), { ...GROUP, ownerUid: 'someoneElse', members: ['someoneElse'], memberEmails: { someoneElse: 's@x.com' } });
    await setDoc(doc(d, 'joinCodes', 'TAKN-CODE'), { gid: 'other' });
    await setDoc(doc(d, 'joinCodes', 'GONE-CODE'), { gid: 'deadGroup' });
    await setDoc(doc(d, 'users', OWNER), { currentGroupId: G, joinCode: CODE });
    await setDoc(doc(d, 'users', MEMBER), { currentGroupId: G, joinCode: CODE });
    await setDoc(gref(d, 'spools/s'), SPOOL);
    await setDoc(gref(d, 'printers/p'), PRINTER);
    await setDoc(gref(d, 'products/p'), PRODUCT);
    await setDoc(gref(d, 'archive/a'), ARCH);
    await setDoc(gref(d, 'settings/main'), SETTINGS);
    await setDoc(gref(d, 'activity/a'), ACT);
  });
}

// Client-identical batches (joinGroupByCode / rotateJoinCode in printpricer/js/firebase.js).
async function joinBatch(db, uid, code, email = EMAIL[uid]) {
  const b = writeBatch(db);
  b.update(gref(db), { members: arrayUnion(uid), [`memberEmails.${uid}`]: email });
  b.set(doc(db, 'users', uid), { currentGroupId: G, joinCode: code }, { merge: true });
  return b.commit();
}
async function rotateBatch(db, oldCode, newCode, { del = true } = {}) {
  const b = writeBatch(db);
  b.update(gref(db), { joinCode: newCode });
  if (del) b.delete(doc(db, 'joinCodes', oldCode));
  b.set(doc(db, 'joinCodes', newCode), { gid: G });
  return b.commit();
}
const upd = (db, data) => updateDoc(gref(db), data);
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

// ---------------------------------------------------------------- users
describe('users/{uid}', () => {
  it('self can get/create/update/delete', async () => {
    const db = who.outsider(), r = doc(db, 'users', OUT);
    await ok(setDoc(r, { currentGroupId: G, joinCode: CODE }));
    await ok(getDoc(r));
    await ok(updateDoc(r, { currentGroupId: 'x' }));
    await ok(deleteDoc(r));
  });
  it('other signed-in user cannot get/create/update/delete', async () => {
    const db = who.outsider(), r = doc(db, 'users', MEMBER);
    await no(getDoc(r)); await no(setDoc(doc(db, 'users', 'fresh'), { a: 1 }));
    await no(updateDoc(r, { joinCode: 'x' })); await no(deleteDoc(r));
  });
  it('unauthenticated cannot get/write', async () => {
    const db = who.unauth(), r = doc(db, 'users', MEMBER);
    await no(getDoc(r)); await no(setDoc(r, { a: 1 })); await no(deleteDoc(r));
  });
  it('self can write the exact docs the app writes (ensureUserDoc, join, leave)', async () => {
    const r = doc(who.outsider(), 'users', OUT);
    await ok(setDoc(r, { email: EMAIL[OUT], createdAt: serverTimestamp(), currentGroupId: null }));
    await ok(updateDoc(r, { email: EMAIL[OUT] }));
    await ok(setDoc(r, { currentGroupId: G, joinCode: CODE }, { merge: true }));
    await ok(updateDoc(r, { currentGroupId: 'other' }));
    await ok(setDoc(r, { currentGroupId: null, joinCode: deleteField() }, { merge: true }));
  });
  // Finding 8 (RULES-REVIEW.md): anyone can make an anonymous account, so it must get no storage here.
  it('anonymous account cannot read/write/delete even its own user doc', async () => {
    const db = who.anonOutsider(), r = doc(db, 'users', OUT);
    await no(setDoc(r, { currentGroupId: null })); await no(getDoc(r));
    await no(getDoc(doc(who.anonMember(), 'users', MEMBER)));
    await no(updateDoc(doc(who.anonMember(), 'users', MEMBER), { currentGroupId: null }));
    await no(deleteDoc(doc(who.anonMember(), 'users', MEMBER)));
  });
  it('users doc rejects forged / oversize fields', async () => {
    const r = doc(who.outsider(), 'users', OUT);
    await no(setDoc(r, { evil: 'x'.repeat(5000) }));
    await no(setDoc(r, { email: 'x'.repeat(321) }));
    await no(setDoc(r, { email: 1 }));
    await no(setDoc(r, { createdAt: 'yesterday' }));
    await no(setDoc(r, { currentGroupId: 'x'.repeat(129) }));
    await no(setDoc(r, { currentGroupId: 5 }));
    await no(setDoc(r, { joinCode: 'not a code' }));
    await no(updateDoc(doc(who.member(), 'users', MEMBER), { blob: 'x' }));
  });
});

// ---------------------------------------------------------------- joinCodes
describe('joinCodes/{code}', () => {
  it('signed-in user can get a known code', () => ok(getDoc(doc(who.outsider(), 'joinCodes', CODE))));
  it('nobody can list codes', async () => {
    await no(getDocs(collection(who.member(), 'joinCodes')));
    await no(getDocs(collection(who.owner(), 'joinCodes')));
  });
  it('anonymous and unauthenticated cannot get a code', async () => {
    await no(getDoc(doc(who.anonOutsider(), 'joinCodes', CODE)));
    await no(getDoc(doc(who.unauth(), 'joinCodes', CODE)));
  });
  it('owner can register rotated code (batch)', () => ok(rotateBatch(who.owner(), CODE, 'WXYZ-2345')));
  it('owner can register a legacy 6-char code', () => ok(rotateBatch(who.owner(), CODE, 'ABC-DEF')));
  it('member cannot register a code', async () => {
    const db = who.member(); const b = writeBatch(db);
    b.update(gref(db), { joinCode: 'WXYZ-2345' }); b.set(doc(db, 'joinCodes', 'WXYZ-2345'), { gid: G });
    await no(b.commit());
  });
  it('outsider cannot register a code for a group they do not own', () =>
    no(setDoc(doc(who.outsider(), 'joinCodes', 'WXYZ-2345'), { gid: G })));
  it('owner cannot register a code that is not the group current code', () =>
    no(setDoc(doc(who.owner(), 'joinCodes', 'WXYZ-2345'), { gid: G })));
  it('anonymous owner / unauthenticated cannot register a code', async () => {
    const db = who.anonOwner(); const b = writeBatch(db);
    b.update(gref(db), { joinCode: 'WXYZ-2345' }); b.set(doc(db, 'joinCodes', 'WXYZ-2345'), { gid: G });
    await no(b.commit());
    await no(setDoc(doc(who.unauth(), 'joinCodes', 'WXYZ-2345'), { gid: G }));
  });
  it('code doc with extra key or wrong type gid is refused', async () => {
    const db = who.owner();
    for (const data of [{ gid: G, extra: 1 }, { gid: 5 }]) {
      const b = writeBatch(db); b.update(gref(db), { joinCode: 'WXYZ-2345' });
      b.set(doc(db, 'joinCodes', 'WXYZ-2345'), data); await no(b.commit());
    }
  });
  it('owner cannot overwrite a taken code (update refused)', async () => {
    const db = who.owner(); const b = writeBatch(db);
    b.update(gref(db), { joinCode: 'TAKN-CODE' }); b.set(doc(db, 'joinCodes', 'TAKN-CODE'), { gid: G });
    await no(b.commit());
    await no(updateDoc(doc(db, 'joinCodes', CODE), { gid: 'X' }));
  });
  it('owner can delete own group code', () => ok(deleteDoc(doc(who.owner(), 'joinCodes', CODE))));
  it('anyone signed in can delete an orphan code', () => ok(deleteDoc(doc(who.outsider(), 'joinCodes', 'GONE-CODE'))));
  it('member and outsider cannot delete a live code', async () => {
    await no(deleteDoc(doc(who.member(), 'joinCodes', CODE)));
    await no(deleteDoc(doc(who.outsider(), 'joinCodes', CODE)));
  });
  it('anonymous and unauthenticated cannot delete (even orphan)', async () => {
    await no(deleteDoc(doc(who.anonOutsider(), 'joinCodes', 'GONE-CODE')));
    await no(deleteDoc(doc(who.unauth(), 'joinCodes', 'GONE-CODE')));
    await no(deleteDoc(doc(who.anonOwner(), 'joinCodes', CODE)));
  });
});

// ---------------------------------------------------------------- groups
const NEWG = () => ({ name: 'Mine', joinCode: 'QRST-UVWX', ownerUid: OUT, members: [OUT],
  memberEmails: { [OUT]: EMAIL[OUT] }, createdAt: serverTimestamp() });
describe('groups/{gid}', () => {
  const create = (db, data) => setDoc(doc(db, 'groups', 'N'), data);
  it('signed-in user can create own group', () => ok(create(who.outsider(), NEWG())));
  it('legacy 6-char code accepted on create', () => ok(create(who.outsider(), { ...NEWG(), joinCode: 'QRS-TUV' })));
  it('create denied: anonymous / unauthenticated', async () => {
    await no(create(who.anonOutsider(), NEWG())); await no(create(who.unauth(), NEWG()));
  });
  it('create denied: forged fields', async () => {
    const db = who.outsider();
    const bad = [
      { ownerUid: MEMBER }, { members: [OUT, MEMBER] }, { memberEmails: { [OUT]: 'o@x.com' } },
      { memberEmails: { [OUT]: EMAIL[OUT], [MEMBER]: 'm@x.com' } }, { extra: 1 },
      { name: '' }, { name: 'x'.repeat(101) }, { name: 5 }, { joinCode: 'abc' }, { members: OUT },
      { createdAt: new Date('2020-01-01') }, { memberEmails: 'x' },
    ];
    for (const b of bad) await no(create(db, { ...NEWG(), ...b }));
    await no(create(db, without(NEWG(), 'createdAt')));
  });
  it('member can get and list own group', async () => {
    await ok(getDoc(gref(who.member())));
    await ok(getDocs(query(collection(who.member(), 'groups'), where('members', 'array-contains', MEMBER))));
  });
  it('outsider/anonymous/unauthenticated cannot get or list the group', async () => {
    await no(getDoc(gref(who.outsider()))); await no(getDoc(gref(who.anonMember()))); await no(getDoc(gref(who.unauth())));
    await no(getDocs(query(collection(who.outsider(), 'groups'), where('members', 'array-contains', MEMBER))));
  });
  it('owner can rename, rotate code, remove member', async () => {
    await ok(upd(who.owner(), { name: 'New' }));
    await ok(upd(who.owner(), { joinCode: 'WXYZ-2345' }));
    await ok(upd(who.owner(), { members: arrayRemove(MEMBER), [`memberEmails.${MEMBER}`]: deleteField() }));
  });
  it('owner can hand the group to a member', () => ok(upd(who.owner(), { ownerUid: MEMBER })));
  it('member can rename and refresh own email', async () => {
    await ok(upd(who.member(), { name: 'New' }));
    await ok(upd(who.member(), { [`memberEmails.${MEMBER}`]: EMAIL[MEMBER] }));
  });
  it('member can leave', () => ok(upd(who.member(), { members: arrayRemove(MEMBER), [`memberEmails.${MEMBER}`]: deleteField() })));
  it('outsider can join with current code (client batch)', () => ok(joinBatch(who.outsider(), OUT, CODE)));
  it('update denied for outsider/anonymous/unauthenticated', async () => {
    await no(upd(who.outsider(), { name: 'Hacked' }));
    await no(upd(who.anonMember(), { name: 'Hacked' }));
    await no(upd(who.anonOwner(), { name: 'Hacked' }));
    await no(upd(who.unauth(), { name: 'Hacked' }));
  });
  it('update denied: forged fields (owner)', async () => {
    const db = who.owner();
    await no(upd(db, { name: '' })); await no(upd(db, { name: 'x'.repeat(101) })); await no(upd(db, { name: 7 }));
    await no(upd(db, { joinCode: 'bad' })); await no(upd(db, { extra: 1 })); await no(upd(db, { createdAt: new Date() }));
    await no(upd(db, { members: [OWNER, MEMBER, OUT] }));
    await no(upd(db, { members: 'x' }));
  });
  it('update denied: forged fields (member)', async () => {
    const db = who.member();
    await no(upd(db, { extra: 1 })); await no(upd(db, { name: 'x'.repeat(101) })); await no(upd(db, { name: 9 }));
    await no(upd(db, { createdAt: new Date() }));
  });
  it('delete: owner only', async () => {
    await no(deleteDoc(gref(who.member()))); await no(deleteDoc(gref(who.outsider())));
    await no(deleteDoc(gref(who.anonOwner()))); await no(deleteDoc(gref(who.unauth())));
    await ok(deleteDoc(gref(who.owner())));
  });
});

// ---------------------------------------------------------------- sub-collections
function crud(name, path, valid, bads) {
  describe(`groups/{gid}/${name}`, () => {
    const col = db => collection(db, 'groups/' + G + '/' + name);
    it('member can get, list, create, update, delete', async () => {
      const db = who.member();
      await ok(getDoc(gref(db, path))); await ok(getDocs(col(db)));
      await ok(setDoc(gref(db, name + '/new'), valid));
      await ok(updateDoc(gref(db, path), valid));
      await ok(deleteDoc(gref(db, path)));
    });
    it('owner can create and delete', async () => {
      await ok(setDoc(gref(who.owner(), name + '/new'), valid)); await ok(deleteDoc(gref(who.owner(), path)));
    });
    it('non-member denied everything', async () => {
      const db = who.outsider();
      await no(getDoc(gref(db, path))); await no(getDocs(col(db)));
      await no(setDoc(gref(db, name + '/new'), valid)); await no(updateDoc(gref(db, path), valid)); await no(deleteDoc(gref(db, path)));
    });
    it('anonymous (even a member uid) denied everything', async () => {
      const db = who.anonMember();
      await no(getDoc(gref(db, path))); await no(getDocs(col(db)));
      await no(setDoc(gref(db, name + '/new'), valid)); await no(updateDoc(gref(db, path), valid)); await no(deleteDoc(gref(db, path)));
    });
    it('unauthenticated denied everything', async () => {
      const db = who.unauth();
      await no(getDoc(gref(db, path))); await no(getDocs(col(db)));
      await no(setDoc(gref(db, name + '/new'), valid)); await no(updateDoc(gref(db, path), valid)); await no(deleteDoc(gref(db, path)));
    });
    bads.forEach(([label, patch]) => {
      it(`forged field denied: ${label}`, async () => {
        const db = who.member(); const data = { ...valid, ...patch };
        await no(setDoc(gref(db, name + '/new'), data)); await no(updateDoc(gref(db, path), data));
      });
    });
  });
}
crud('spools', 'spools/s', SPOOL, [
  ['extra key', { admin: true }], ['name a map', { name: { a: 1 } }], ['oversize name', { name: 'x'.repeat(201) }],
  ['oversize notes', { notes: 'x'.repeat(10001) }], ['costPerKg bool', { costPerKg: true }],
  ['costPerKg long string', { costPerKg: 'x'.repeat(65) }], ['refillHistory not list', { refillHistory: 'x' }],
  ['refillHistory 1001 entries', { refillHistory: Array(1001).fill(1) }], ['material oversize', { material: 'x'.repeat(101) }],
]);
crud('printers', 'printers/p', PRINTER, [
  ['extra key', { admin: true }], ['name a number', { name: 5 }], ['oversize name', { name: 'x'.repeat(201) }],
  ['watts a map', { watts: { a: 1 } }], ['swapPct long string', { swapPct: 'x'.repeat(65) }], ['preset oversize', { preset: 'x'.repeat(201) }],
]);
crud('products', 'products/p', PRODUCT, [
  ['extra key', { foo: 1 }], ['25 photos', { photos: Array(25).fill('x') }], ['filaments not list', { filaments: 'x' }],
  ['65 filaments', { filaments: Array(65).fill(1) }], ['201 bom', { bom: Array(201).fill(1) }], ['oversize name', { name: 'x'.repeat(501) }],
  ['oversize notes', { notes: 'x'.repeat(20001) }], ['photo not string', { photo: 5 }], ['hours a list', { hours: [1] }],
]);
describe('products legacy photo', () => {
  it('member can save legacy photo string', () => ok(updateDoc(gref(who.member(), 'products/p'), { ...PRODUCT, photo: 'data:x' })));
});

describe('groups/{gid}/archive', () => {
  const col = db => collection(db, 'groups/' + G + '/archive');
  it('member can get, list, create, delete', async () => {
    const db = who.member();
    await ok(getDoc(gref(db, 'archive/a'))); await ok(getDocs(col(db)));
    await ok(setDoc(gref(db, 'archive/n'), ARCH)); await ok(deleteDoc(gref(db, 'archive/a')));
  });
  it('only owner can update', async () => {
    await no(updateDoc(gref(who.member(), 'archive/a'), ARCH));
    await ok(updateDoc(gref(who.owner(), 'archive/a'), ARCH));
  });
  it('non-member denied get/list/create/update/delete', async () => {
    for (const db of [who.outsider(), who.anonMember(), who.anonOwner(), who.unauth()]) {
      await no(getDoc(gref(db, 'archive/a'))); await no(getDocs(col(db)));
      await no(setDoc(gref(db, 'archive/n'), ARCH)); await no(updateDoc(gref(db, 'archive/a'), ARCH)); await no(deleteDoc(gref(db, 'archive/a')));
    }
  });
  it('accepts entries from the old single-file app and from group seeding', async () => {
    await ok(setDoc(gref(who.member(), 'archive/old'), LEGACY_ARCH));
    await ok(setDoc(gref(who.member(), 'archive/min'), { name: 'x' }));
  });
  // Finding 9 (RULES-REVIEW.md): archive docs have a schema and size caps.
  it('rejects forged / oversize archive fields, on create and on owner update', async () => {
    const bad = [{ ...ARCH, evil: 1 }, { ...ARCH, name: 'x'.repeat(501) }, { ...ARCH, name: 5 }, { ...ARCH, date: 'x'.repeat(65) },
      { ...ARCH, hours: { a: 1 } }, { ...ARCH, printerId: [1] }, { ...ARCH, printerName: 'x'.repeat(201) },
      { ...ARCH, filaments: Array(65).fill({}) }, { ...ARCH, addons: 'x' }, { ...ARCH, addons: { notes: 'x'.repeat(20001) } },
      { ...ARCH, addons: { photos: Array(25).fill('') } }, { ...ARCH, addons: { bom: Array(201).fill({}) } },
      { ...ARCH, breakdown: 'x'.repeat(5000) }, { ...ARCH, settingsSnapshot: [] }];
    for (const d of bad) {
      await no(setDoc(gref(who.member(), 'archive/n'), d));
      await no(setDoc(gref(who.owner(), 'archive/a'), d));
    }
  });
});

describe('groups/{gid}/settings', () => {
  it('member can get, list, create main, update main', async () => {
    const db = who.member();
    await ok(getDoc(gref(db, 'settings/main'))); await ok(getDocs(collection(db, 'groups/G/settings')));
    await ok(setDoc(gref(db, 'settings/main'), { ...SETTINGS, marginPct: '40' }));
    await env.withSecurityRulesDisabled(c => deleteDoc(gref(c.firestore(), 'settings/main')));
    await ok(setDoc(gref(db, 'settings/main'), SETTINGS));
  });
  it('accepts Reset (all blank), numbers, and old single-file-app keys', async () => {
    const db = who.member(), blank = Object.fromEntries(Object.keys(SETTINGS).map(k => [k, '']));
    await ok(setDoc(gref(db, 'settings/main'), blank));
    await ok(setDoc(gref(db, 'settings/main'), { ...SETTINGS, filamentCost: 25, kwh: 0.15 }));
    await ok(setDoc(gref(db, 'settings/main'), LEGACY_SETTINGS));
    await ok(setDoc(gref(db, 'settings/main'), {}));
  });
  // Finding 9 (RULES-REVIEW.md): settings has a schema and size caps.
  it('rejects forged / oversize settings fields', async () => {
    const bad = [{ ...SETTINGS, currency: '$' }, { ...SETTINGS, kwh: 'x'.repeat(65) }, { ...SETTINGS, kwh: [1] },
      { ...SETTINGS, businessName: 'x'.repeat(501) }, { ...SETTINGS, businessEmail: 'x'.repeat(321) },
      { ...SETTINGS, businessNotes: 'x'.repeat(2001) }, { ...SETTINGS, businessNotes: 5 }, { ...SETTINGS, watts: { a: 1 } }];
    for (const d of bad) await no(setDoc(gref(who.member(), 'settings/main'), d));
    await no(updateDoc(gref(who.owner(), 'settings/main'), { blob: 'x'.repeat(5000) }));
  });
  it('member cannot write another doc id', async () => {
    await no(setDoc(gref(who.member(), 'settings/other'), { a: 1 }));
    await no(setDoc(gref(who.owner(), 'settings/other'), { a: 1 }));
  });
  it('nobody can delete settings/main', async () => {
    await no(deleteDoc(gref(who.member(), 'settings/main'))); await no(deleteDoc(gref(who.owner(), 'settings/main')));
  });
  it('non-member denied', async () => {
    for (const db of [who.outsider(), who.anonMember(), who.unauth()]) {
      await no(getDoc(gref(db, 'settings/main'))); await no(getDocs(collection(db, 'groups/G/settings')));
      await no(updateDoc(gref(db, 'settings/main'), { kwh: '1' })); await no(setDoc(gref(db, 'settings/main'), SETTINGS));
    }
  });
});

describe('groups/{gid}/activity', () => {
  const create = (db, data, id = 'n') => setDoc(gref(db, 'activity/' + id), data);
  it('member can get, list, create own', async () => {
    const db = who.member();
    await ok(getDoc(gref(db, 'activity/a'))); await ok(getDocs(collection(db, 'groups/G/activity')));
    await ok(create(db, { ...ACT, timestamp: Date.now() }));
  });
  it('owner can create own entry and delete any', async () => {
    await ok(create(who.owner(), { ...ACT, uid: OWNER, email: EMAIL[OWNER] }));
    await ok(deleteDoc(gref(who.owner(), 'activity/a')));
  });
  it('nobody can update an entry', async () => {
    await no(updateDoc(gref(who.member(), 'activity/a'), ACT)); await no(updateDoc(gref(who.owner(), 'activity/a'), ACT));
  });
  it('member cannot delete', () => no(deleteDoc(gref(who.member(), 'activity/a'))));
  it('non-member / anonymous / unauthenticated denied', async () => {
    for (const db of [who.outsider(), who.anonMember(), who.unauth()]) {
      await no(getDoc(gref(db, 'activity/a'))); await no(getDocs(collection(db, 'groups/G/activity')));
      await no(create(db, ACT)); await no(deleteDoc(gref(db, 'activity/a')));
    }
    await no(deleteDoc(gref(who.anonOwner(), 'activity/a')));
  });
  it('forged fields denied', async () => {
    const db = who.member(), now = Date.now();
    const bad = [{ uid: OWNER }, { email: 'o@x.com' }, { pinned: true }, { action: 'x'.repeat(601) }, { action: '' }, { action: 5 },
      { timestamp: now + 3600000 }, { timestamp: 0 }, { timestamp: -5 }, { timestamp: 1.5 }, { timestamp: String(now) }, { email: 5 }];
    for (const b of bad) await no(create(db, { ...ACT, timestamp: now, ...b }));
    await no(create(db, without(ACT, 'action'))); await no(create(db, without(ACT, 'uid')));
  });
});

// ---------------------------------------------------------------- hole regressions
describe('hole 1 regression: group updates split by role', () => {
  it('member cannot make self owner', () => no(upd(who.member(), { ownerUid: MEMBER })));
  it('member cannot take over: ownerUid + members rewrite', () =>
    no(upd(who.member(), { ownerUid: MEMBER, members: [MEMBER], memberEmails: { [MEMBER]: EMAIL[MEMBER] } })));
  it('member cannot remove the owner', () =>
    no(upd(who.member(), { members: [MEMBER], memberEmails: { [MEMBER]: EMAIL[MEMBER] } })));
  it('member cannot remove another member', () => no(upd(who.member(), { members: arrayRemove(OWNER), [`memberEmails.${OWNER}`]: deleteField() })));
  it('member cannot change join code', () => no(upd(who.member(), { joinCode: 'ZZZZ-ZZZZ' })));
  it('member leaving must also drop own email entry', () => no(upd(who.member(), { members: arrayRemove(MEMBER) })));
  it('member cannot leave and rename in one write', () =>
    no(upd(who.member(), { name: 'x', members: arrayRemove(MEMBER), [`memberEmails.${MEMBER}`]: deleteField() })));
  it('owner cannot leave the group', () => no(upd(who.owner(), { members: arrayRemove(OWNER), [`memberEmails.${OWNER}`]: deleteField() })));
  it('owner cannot add an outsider as member', () =>
    no(upd(who.owner(), { members: arrayUnion(OUT), [`memberEmails.${OUT}`]: EMAIL[OUT] })));
  it('owner cannot hand the group to an outsider', () => no(upd(who.owner(), { ownerUid: OUT })));
  it('owner cannot edit another member email', () => no(upd(who.owner(), { [`memberEmails.${MEMBER}`]: 'evil@x.com' })));
  it('member cannot set a fake own email', () => no(upd(who.member(), { [`memberEmails.${MEMBER}`]: 'o@x.com' })));
  it('member cannot edit the owner email', () => no(upd(who.member(), { [`memberEmails.${OWNER}`]: 'evil@x.com' })));
});

describe('hole 2 regression: joining proves the current code', () => {
  it('outsider cannot join without writing the code', async () => {
    const db = who.outsider(); const b = writeBatch(db);
    b.update(gref(db), { members: arrayUnion(OUT), [`memberEmails.${OUT}`]: EMAIL[OUT] });
    b.set(doc(db, 'users', OUT), { currentGroupId: G }, { merge: true });
    await no(b.commit());
  });
  it('outsider cannot join by group id alone (bare group update)', () =>
    no(upd(who.outsider(), { members: arrayUnion(OUT), [`memberEmails.${OUT}`]: EMAIL[OUT] })));
  it('outsider cannot join with a stale/old code', () => no(joinBatch(who.outsider(), OUT, 'OLD-CODE')));
  it('outsider cannot join with a wrong code', () => no(joinBatch(who.outsider(), OUT, 'ZZZZ-ZZZZ')));
  it('old code stops working after rotation', async () => {
    await ok(rotateBatch(who.owner(), CODE, 'WXYZ-2345'));
    await no(joinBatch(who.outsider(), OUT, CODE));
    await ok(joinBatch(who.outsider(), OUT, 'WXYZ-2345'));
  });
  it('removed member cannot rejoin with the old code after rotation', async () => {
    await ok(upd(who.owner(), { members: arrayRemove(MEMBER), [`memberEmails.${MEMBER}`]: deleteField() }));
    await ok(rotateBatch(who.owner(), CODE, 'WXYZ-2345'));
    await no(joinBatch(who.member(), MEMBER, CODE));
  });
  it('outsider cannot join with a fake email', () => no(joinBatch(who.outsider(), OUT, CODE, 'o@x.com')));
  it('outsider cannot add a friend too', async () => {
    const db = who.outsider(); const b = writeBatch(db);
    b.update(gref(db), { members: arrayUnion(OUT, 'friend'), [`memberEmails.${OUT}`]: EMAIL[OUT] });
    b.set(doc(db, 'users', OUT), { currentGroupId: G, joinCode: CODE }, { merge: true });
    await no(b.commit());
  });
  it('outsider cannot join and rename at once', async () => {
    const db = who.outsider(); const b = writeBatch(db);
    b.update(gref(db), { name: 'Mine', members: arrayUnion(OUT), [`memberEmails.${OUT}`]: EMAIL[OUT] });
    b.set(doc(db, 'users', OUT), { currentGroupId: G, joinCode: CODE }, { merge: true });
    await no(b.commit());
  });
  it('outsider cannot join and take ownership at once', async () => {
    const db = who.outsider(); const b = writeBatch(db);
    b.update(gref(db), { ownerUid: OUT, members: arrayUnion(OUT), [`memberEmails.${OUT}`]: EMAIL[OUT] });
    b.set(doc(db, 'users', OUT), { currentGroupId: G, joinCode: CODE }, { merge: true });
    await no(b.commit());
  });
  it('outsider cannot add someone else via the join path', async () => {
    const db = who.outsider(); const b = writeBatch(db);
    b.update(gref(db), { members: arrayUnion('friend'), 'memberEmails.friend': 'f@x.com' });
    b.set(doc(db, 'users', OUT), { currentGroupId: G, joinCode: CODE }, { merge: true });
    await no(b.commit());
  });
  it('anonymous account cannot join even with the current code', () => no(joinBatch(who.anonOutsider(), OUT, CODE)));
  it('unauthenticated cannot join', () => no(joinBatch(who.unauth(), OUT, CODE)));
  it('legacy 6-char group can be joined with its code', async () => {
    await env.withSecurityRulesDisabled(c => updateDoc(gref(c.firestore()), { joinCode: 'ABC-DEF' }));
    await ok(joinBatch(who.outsider(), OUT, 'ABC-DEF'));
  });
  it('member cannot rotate the join code', () => no(rotateBatch(who.member(), CODE, 'WXYZ-2345')));
  it('owner rotation: batch works, old doc gone, new doc readable', async () => {
    await ok(rotateBatch(who.owner(), CODE, 'WXYZ-2345'));
    await ok(getDoc(doc(who.outsider(), 'joinCodes', 'WXYZ-2345')));
    await env.withSecurityRulesDisabled(async c => {
      const s = await getDoc(doc(c.firestore(), 'joinCodes', CODE));
      if (s.exists()) throw new Error('old code doc still present');
    });
  });
  it('owner rotation to a taken code is refused', () => no(rotateBatch(who.owner(), CODE, 'TAKN-CODE')));
});

describe('hole 3 regression: shared-data narrowing', () => {
  it('member cannot edit an archive entry in place', () => no(updateDoc(gref(who.member(), 'archive/a'), { total: 999 })));
  it('member cannot write settings other than main', () => no(setDoc(gref(who.member(), 'settings/evil'), { a: 1 })));
  it('member cannot delete settings/main', () => no(deleteDoc(gref(who.member(), 'settings/main'))));
  it('member cannot plant broken-shape products', () => no(setDoc(gref(who.member(), 'products/bad'), { ...PRODUCT, filaments: 'x' })));
  it('outsider cannot delete shared data', async () => {
    for (const p of ['spools/s', 'printers/p', 'products/p', 'archive/a']) await no(deleteDoc(gref(who.outsider(), p)));
  });
  it('members keep delete on spools/printers/products/archive (kept on purpose)', async () => {
    for (const p of ['spools/s', 'printers/p', 'products/p', 'archive/a']) await ok(deleteDoc(gref(who.member(), p)));
  });
});

describe('hole 4 regression: emails match the signed-in account', () => {
  it('group create with someone else email is refused', () =>
    no(setDoc(doc(who.outsider(), 'groups', 'N'), { ...NEWG(), memberEmails: { [OUT]: 'o@x.com' } })));
  it('group create with no email claim and non-empty email is refused', () =>
    no(setDoc(doc(env.authenticatedContext(OUT).firestore(), 'groups', 'N'), NEWG())));
  it('join with spoofed email is refused', () => no(joinBatch(who.outsider(), OUT, CODE, 'o@x.com')));
  it('member cannot spoof own memberEmails entry', () => no(upd(who.member(), { [`memberEmails.${MEMBER}`]: 'o@x.com' })));
  it('activity with spoofed email is refused', () => no(setDoc(gref(who.member(), 'activity/n'), { ...ACT, email: 'o@x.com' })));
  it('activity as someone else is refused', () => no(setDoc(gref(who.member(), 'activity/n'), { ...ACT, uid: OWNER })));
  it('activity with future timestamp is refused', () => no(setDoc(gref(who.member(), 'activity/n'), { ...ACT, timestamp: Date.now() + 3600000 })));
  it('activity with extra key is refused', () => no(setDoc(gref(who.member(), 'activity/n'), { ...ACT, pinned: true })));
  it('activity with oversize action is refused', () => no(setDoc(gref(who.member(), 'activity/n'), { ...ACT, action: 'x'.repeat(601) })));
  it('activity within 5 min clock skew is allowed', () => ok(setDoc(gref(who.member(), 'activity/n'), { ...ACT, timestamp: Date.now() + 120000 })));
});

describe('hole 5 regression: schemas and size caps', () => {
  it('spool with extra key is refused', () => no(setDoc(gref(who.member(), 'spools/n'), { ...SPOOL, x: 1 })));
  it('spool name as map is refused', () => no(setDoc(gref(who.member(), 'spools/n'), { ...SPOOL, name: { a: 1 } })));
  it('spool with 10001-char notes is refused', () => no(setDoc(gref(who.member(), 'spools/n'), { ...SPOOL, notes: 'x'.repeat(10001) })));
  it('spool costPerKg as string is allowed (app stores typed strings)', () => ok(updateDoc(gref(who.member(), 'spools/s'), { ...SPOOL, costPerKg: '25' })));
  it('printer with extra key is refused', () => no(setDoc(gref(who.member(), 'printers/n'), { ...PRINTER, admin: true })));
  it('product with unknown key is refused', () => no(setDoc(gref(who.member(), 'products/n'), { ...PRODUCT, foo: 1 })));
  it('product with 25 photos is refused', () => no(setDoc(gref(who.member(), 'products/n'), { ...PRODUCT, photos: Array(25).fill('x') })));
  it('product with 20001-char notes is refused', () => no(setDoc(gref(who.member(), 'products/n'), { ...PRODUCT, notes: 'x'.repeat(20001) })));
  it('product filaments not a list is refused', () => no(setDoc(gref(who.member(), 'products/n'), { ...PRODUCT, filaments: 'x' })));
});

describe('hole 6 regression: owner clears activity; orphan codes deletable', () => {
  it('member cannot delete activity', () => no(deleteDoc(gref(who.member(), 'activity/a'))));
  it('owner can delete activity', () => ok(deleteDoc(gref(who.owner(), 'activity/a'))));
  it('owner cannot edit activity', () => no(updateDoc(gref(who.owner(), 'activity/a'), ACT)));
  it('orphan join code can be cleared by any signed-in user', () => ok(deleteDoc(doc(who.outsider(), 'joinCodes', 'GONE-CODE'))));
  it('live join code cannot be deleted by non-owner', () => no(deleteDoc(doc(who.outsider(), 'joinCodes', CODE))));
  it('code of another group cannot be deleted by this group owner', () => no(deleteDoc(doc(who.owner(), 'joinCodes', 'TAKN-CODE'))));
});

describe('hole 7 regression: join code format', () => {
  it('group create with lowercase code is refused', () =>
    no(setDoc(doc(who.outsider(), 'groups', 'N'), { ...NEWG(), joinCode: 'abcd-efgh' })));
  it('group create with 7-char code is refused', () =>
    no(setDoc(doc(who.outsider(), 'groups', 'N'), { ...NEWG(), joinCode: 'ABCD-EFG' })));
  it('group create with no dash is refused', () =>
    no(setDoc(doc(who.outsider(), 'groups', 'N'), { ...NEWG(), joinCode: 'ABCDEFGH' })));
  it('owner cannot rotate to a short weak code', async () => {
    await no(rotateBatch(who.owner(), CODE, 'AB-CD'));
    await no(upd(who.owner(), { joinCode: '1234' }));
  });
  it('owner cannot register a joinCodes doc with a malformed code', async () => {
    const db = who.owner(); const b = writeBatch(db);
    b.update(gref(db), { joinCode: 'abcd-efgh' }); b.set(doc(db, 'joinCodes', 'abcd-efgh'), { gid: G });
    await no(b.commit());
  });
  it('8-char and legacy 6-char codes are both accepted', async () => {
    await ok(rotateBatch(who.owner(), CODE, 'WXYZ-2345'));
    await ok(rotateBatch(who.owner(), 'WXYZ-2345', 'XYZ-234'));
  });
});

# firestore.rules review

The first review compared `firestore.rules` with `printpricer/js/firebase.js` at commit `810a5a8`. It found holes 1-7 below, and all seven are now fixed in `firestore.rules` and the app. The Firebase emulator needs Java, which this machine doesn't have. Instead, `tests/rules-api.mjs` runs 73 cases against Google's Rules test API, and all 73 pass (see [Automated checks](#automated-checks)).

**Status (2026-11-06):** both parts are live. The app went first (main `6b3024d`, `?v=36`). The rules were published at 05:22 UTC as ruleset `1be5e97d-bb38-44b9-a93b-97c05ea9753f`, and the published source matches `firestore.rules`.

The ruleset before this change was `296503e1-650e-4c7e-ac77-fa9ef6cdd8b3` (2026-10-08). To roll back, open Firebase console → Firestore → Rules → history and restore that version.

Cross-group isolation still holds. Every sub-collection rule calls `isMember(gid)` with the `gid` from the path, and reading a group requires membership.

| # | Severity | Hole | Status |
|---|----------|------|--------|
| 1 | High | Any member could rewrite the group doc: become owner, remove members, change the join code | Fixed |
| 2 | High | Knowing the group ID was enough to join, forever. Removed members could rejoin | Fixed |
| 3 | Medium | Any member can delete or overwrite shared data | Kept on purpose, narrowed (see 3) |
| 4 | Medium | Emails in `memberEmails` and activity entries were not checked | Fixed |
| 5 | Low | Sub-collection documents had no schema or size limits | Fixed |
| 6 | Low | Activity could never be deleted; join codes were orphaned when their group was deleted | Fixed |
| 7 | Low | Join codes could be guessed (6 chars, `Math.random`) | Fixed |
| 8 | OK | One group cannot reach another group's data | Still holds |

---

## 1. Group doc updates are split by role (was High)

**Was:** any member could write any field of `groups/{gid}`, e.g. `{ ownerUid: me, members: [me] }`, and take the group over.

**Now:** `allow update` is `signedIn() && (ownerUpdate() || memberUpdate() || leaving() || joining())`:

- `ownerUpdate()`: only the current `ownerUid`. It may change `name`, `joinCode`, `ownerUid`, `members` and `memberEmails`. It can only remove members, never add them (old members `hasAll` new). The new `ownerUid` must still be a member. `memberEmails` keys may change only for the members being removed.
- `memberUpdate()`: any member may change only `name` (1-100 chars) and their own `memberEmails` entry, which must equal their token email.
- `leaving()`: a member who is **not** the owner removes only themselves from `members` and deletes their own `memberEmails` key.
- `joining()`: see 2.

The owner can't leave, because the app has no way to hand the group over yet. `leaveGroup()` refuses with a clear message, and so do the rules.

## 2. Joining proves the current code; owners can rotate it (was High)

**Was:** any signed-in user who knew `gid` could add themselves, so a removed member could rejoin at any time.

**Now:**

```
function joining() {
  return !wasMember()
    && changed().hasOnly(['members', 'memberEmails'])
    && request.resource.data.members.toSet() == resource.data.members.toSet().union([request.auth.uid].toSet())
    && request.resource.data.members.size() == resource.data.members.size() + 1
    && emailsChanged().hasOnly([request.auth.uid])
    && request.resource.data.memberEmails.get(request.auth.uid, '') == tokenEmail()
    && getAfter(/databases/$(database)/documents/users/$(request.auth.uid)).data.get('joinCode', '') == resource.data.joinCode;
}
```

`joinGroupByCode()` now writes the group update and `users/{uid}: { currentGroupId, joinCode }` in **one batch**. A wrong or stale code fails with "that code may have just been changed".

**Rotate:** a group owner now sees a **Change join code** button. `rotateJoinCode()` runs one batch: it updates `groups/{gid}.joinCode`, deletes the old `joinCodes` doc (only if it exists and points to this group, or the batch would fail) and creates the new one. The `joinCodes` create rule uses `getAfter(group).joinCode == code`, so it passes inside that batch. Members who are already in stay in. Anyone who knows only the old code or the group ID is locked out.

**Removing someone:** the app has no remove-member button yet. The owner removes the person's uid from `members` and `memberEmails` in the Firebase console (the rules allow it), then clicks **Change join code**. Until the code is rotated, someone who still knows the current code can rejoin.

## 3. Members can still delete shared data: kept on purpose (Medium)

**Decision:** members keep create, update and delete on `spools`, `printers`, `products` and `archive`. This is the least disruptive rule that keeps every current member flow working:

- Deleting a spool, printer or product, deleting an archive entry, **Undo** after stamping and **Clear history** all use `deleteDoc` from members' browsers (`storage.js` `pushDiff`).
- The rules can't tell "delete one product" from "delete every product". Making deletes owner-only would break those buttons for every member who is not the owner.

**Narrowed:**

- `archive` updates are owner-only. The app never edits an archive entry in place.
- `settings` accepts only the `main` doc and can't be deleted.
- Shapes and sizes are validated (see 5), so a member can't plant broken data that crashes other members' views.

What's left: a malicious member can still delete things, or delete and re-create an archive entry. For a group of trusted people sharing a printer, that's accepted. If it becomes a problem, turn on Firestore point-in-time recovery or scheduled backups, or make deletes owner-only and change the UI so members ask the owner to delete.

## 4. Emails must match the signed-in account (was Medium)

**Now:**

- **Group create:** `memberEmails` has only the creator's key, and its value `== request.auth.token.get('email', '')`.
- **Join and member update:** your own `memberEmails` entry must equal your token email.
- **Activity create:** keys are only `uid`, `email`, `action` and `timestamp`. `uid` is yours and `email` is your token email. `action` is a string of 1-600 chars. `timestamp` is an int, `> 0`, and no later than `request.time.toMillis() + 300000` (5 minutes of clock skew).

`timestamp` stays a client `Date.now()` int, not `serverTimestamp()`. `activity.js` renders it with `new Date(+e.timestamp)` and sorts it numerically. A Firestore Timestamp would break both, and offline writes would show a null time until they sync. The upper bound stops entries pinned to the top of the feed with a future date.

`signedIn()` does not require `email_verified`, because the app doesn't send verification emails. Someone could sign up with another person's address. If email verification is turned on in Firebase Auth, add `&& request.auth.token.email_verified == true` to `signedIn()`.

## 5. Shared documents have schemas and size caps (was Low)

**Now:** `create` and `update` need `keys().hasOnly([...])` with the fields the app really writes, plus type and size checks:

- **spools:** `name` up to 200 chars, `material` and `color` up to 100, `notes` up to 10000. `costPerKg`, `spoolGrams` and `remainingGrams` are each a number or a string of up to 64 chars. `refillHistory` is a list of up to 1000 entries.
- **printers:** `name` and `preset` up to 200 chars. `watts`, `hourlyRate`, `gramsPerHour` and `swapPct` are each a number or a short string.
- **products:** `name` up to 500 chars, `notes` up to 20000. `photos` is a list of up to 24. Legacy `photo` must be a string. `filaments` up to 64 entries and `bom` up to 200. `sellPrice`, `printerId`, `hours`, `laborMinutes`, `packagingCost` and `shippingCost` are each a number or a short string.

Form fields accept a string or a number, because the app stores some values as typed strings. Firestore's 1 MiB doc limit and the app's 950 KB product check still cap photo data. Activity has no rate limit; that would need a counter doc or a Cloud Function.

## 6. Owner can clear activity; orphaned codes can be deleted (was Low)

**Now:**

- `activity`: `allow delete: if isGroupOwner(gid)`. There is no UI for it yet; use the console.
- `joinCodes`: `allow delete: if signedIn() && (!exists(groupPath(resource.data.gid)) || groupData(resource.data.gid).ownerUid == request.auth.uid)`. A code whose group is gone no longer stays taken forever.

Deleting a group still leaves its sub-collections behind. The app has no delete-group action. If one is added, it must delete the join code and the sub-collections before the group doc (comment at the group `delete` rule).

## 7. Longer, cryptographically random codes (was Low)

**Now:** `generateJoinCode()` uses `crypto.getRandomValues`, with rejection sampling so it has no modulo bias. It makes 8 characters from the 31-letter alphabet (no I, L, O, 0, 1), formatted `ABCD-EFGH`, so there are about 8.5×10¹¹ codes. `joinGroupByCode()` still accepts 6-char `ABC-DEF` codes from older groups. `isCode()` in the rules accepts both forms.

Optional extra steps: turn on App Check so only the real site can call Firestore, and set a budget alert.

---

## Deploy order

1. Deploy the app (with `firebase.js`, `auth-ui.js`, `utils.js` and `index.html` from this change).
2. Publish `firestore.rules` from the Firebase console.

Clients still running the old app will fail to join under the new rules, because they don't write `users/{uid}.joinCode`. After a reload they work. **Change join code** fails until the new rules are published, because the old `joinCodes` rule refuses the batch.

## Automated checks

`tests/rules-api.mjs` sends `firestore.rules` and 73 test cases to the Firebase Rules test API (`projects/printpricer:test`). It uses no emulator and doesn't touch real data: `get`, `exists` and `getAfter` are mocked per case. It covers the 24 checks below plus:

- owner rotate, hand-over and remove;
- joins that try to add a friend, rename the group, sign in anonymously, or use a legacy 6-char code;
- group create;
- `joinCodes` create, update and delete;
- activity with an extra key, a 601-char action, or sent by an outsider;
- spool, printer and product shapes;
- archive, settings and `users` docs.

It needs a Google login with access to the project:

```powershell
gcloud auth login
```

```powershell
$env:TOKEN = (gcloud auth print-access-token); npm run test:rules
```

The run prints `cases 73, results 73, fail 0` and exits with 0. To prove the API really evaluates each case, set `$env:INVERT = '1'`, which flips every expectation; all 73 cases must then fail. Both runs were done on 2026-11-06.

The suite is not part of `npm test`, because it needs network access and a login. Run it after any change to `firestore.rules`.

## Manual checks

These are the same cases, by hand. Use Firebase console → Firestore → Rules → **Rules Playground** with the new rules pasted in (don't publish yet). The Playground simulates one request against the real data, with "Authenticated" set to a uid and an email (provider `password`). Make two test accounts, OWNER and MEMBER, and one group G where OWNER is owner and MEMBER is a member. Let OUTSIDER be a third uid.

| # | As | Operation | Expect |
|---|----|-----------|--------|
| 1 | MEMBER | update `groups/G` `{ ownerUid: MEMBER }` | Deny |
| 2 | MEMBER | update `groups/G` `{ members: [MEMBER] }` (remove the owner) | Deny |
| 3 | MEMBER | update `groups/G` `{ joinCode: 'ZZZZ-ZZZZ' }` | Deny |
| 4 | MEMBER | update `groups/G` `{ name: 'New name' }` | Allow |
| 5 | MEMBER | update `groups/G` removing only MEMBER from `members` and `memberEmails` | Allow |
| 6 | OWNER | the same leave update for OWNER | Deny |
| 7 | OWNER | update `groups/G` removing MEMBER from `members` and `memberEmails` | Allow |
| 8 | OUTSIDER | update `groups/G` adding OUTSIDER to `members` plus own email; `users/OUTSIDER` has no `joinCode` | Deny |
| 9 | OUTSIDER | same as 8, after setting `users/OUTSIDER.joinCode` to G's current code in the console | Allow |
| 10 | OUTSIDER | same as 9 but with `memberEmails.OUTSIDER: 'someone@else.com'` | Deny |
| 11 | OUTSIDER | same as 8 but `users/OUTSIDER.joinCode` holds an old code | Deny |
| 12 | MEMBER | create `groups/G/activity/x` `{ uid: MEMBER, email: <MEMBER's email>, action: 'test', timestamp: <now ms> }` | Allow |
| 13 | MEMBER | same with `email: 'owner@x.com'` | Deny |
| 14 | MEMBER | same with `timestamp: 9999999999999` | Deny |
| 15 | MEMBER | delete `groups/G/activity/x` | Deny |
| 16 | OWNER | delete `groups/G/activity/x` | Allow |
| 17 | MEMBER | create `groups/G/products/p` `{ name: 'x', filaments: [], foo: 1 }` | Deny (unknown key) |
| 18 | MEMBER | create `groups/G/products/p` `{ name: 'x', hours: '2', filaments: [] }` | Allow |
| 19 | MEMBER | update an existing `groups/G/archive/a` | Deny |
| 20 | MEMBER | delete `groups/G/archive/a` | Allow |
| 21 | MEMBER | write `groups/G/settings/other` | Deny |
| 22 | OUTSIDER | get `groups/G/spools/s` | Deny (isolation) |
| 23 | MEMBER | delete `joinCodes/<G's code>` | Deny |
| 24 | anyone signed in | list `joinCodes` | Deny |

Then, in the real app after publishing:

- Create a group: you get an 8-char code. Join from the second account with the code.
- As owner, click **Change join code**. The old code says "No group found". The new code works for a third account.
- As owner, click **Leave group**: an error explains that owners can't leave.
- A group made before this change still accepts its 6-char code.

Those real-app checks still need doing; they need two or three real accounts. Once Java is installed, the suite can move to `@firebase/rules-unit-testing` with `firebase emulators:exec --only firestore`, which also tests multi-doc batches end to end.

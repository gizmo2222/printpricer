# firestore.rules review

Reviewed `firestore.rules` against `printpricer/js/firebase.js` at commit `810a5a8`.
The Firebase emulator needs Java, which is not installed on this machine, so this is a written review instead of emulator tests. Line numbers refer to `firestore.rules`.

Summary: **cross-group isolation holds**. Nobody can read or write another group's data without first becoming a member. The holes are inside a group: any member can take the group over, and a removed member can always get back in.

| # | Severity | Hole |
|---|----------|------|
| 1 | High | Any member can rewrite the group doc: become owner, remove members, change the join code |
| 2 | High | Knowing the group ID is enough to join, forever. Removed members can rejoin |
| 3 | Medium | Any member can delete or overwrite all products, spools, printers, settings and archive entries |
| 4 | Medium | Emails in `memberEmails` and activity entries are not checked |
| 5 | Low | Sub-collection documents have no schema or size limits |
| 6 | Low | Activity entries can never be deleted; join codes and sub-collections are orphaned when a group is deleted |
| 7 | Low | Join codes can be guessed with single `get`s |
| — | OK | One group cannot reach another group's data |

---

## 1. Any member can rewrite the group doc (High)

**Where:** lines 70-71. `allow update: if signedIn() && (request.auth.uid in resource.data.members || ...)`. A member may change any field.

**How to reach it:** sign in as any member and run, from the browser console on the app:

```js
updateDoc(doc(db, 'groups', GID), { ownerUid: MY_UID, members: [MY_UID], memberEmails: {} })
```

The member is now the only member and the owner. Everyone else loses access to the group's data, and the new owner can delete the group (line 83) or register a new join code. The same update can rename the group or set `joinCode` to anything.

**Fix:** split the member update into the cases the app actually uses. A member can rename the group, can remove only themselves (leaving), and only the owner can remove others or change `ownerUid` and `joinCode`:

```
function changed() { return request.resource.data.diff(resource.data).affectedKeys(); }
function isOwner() { return resource.data.ownerUid == request.auth.uid; }

allow update: if signedIn() && (
  // owner: anything except handing the group to a non-member
  (isOwner() && request.resource.data.ownerUid in request.resource.data.members)
  // member: rename only
  || (request.auth.uid in resource.data.members && changed().hasOnly(['name']))
  // member: leave (remove only yourself)
  || (request.auth.uid in resource.data.members
      && changed().hasOnly(['members', 'memberEmails'])
      && request.resource.data.members.toSet() == resource.data.members.toSet().difference([request.auth.uid].toSet())
      && !(request.auth.uid in request.resource.data.get('memberEmails', {})))
  // non-member: join (see 2)
  || joining()
);
```

Leaving as the owner should either be refused or hand over `ownerUid` in the same write.

## 2. The group ID is the real key, and it never changes (High)

**Where:** lines 72-80, and `joinGroupByCode` in firebase.js (lines 260-279). The non-member branch lets anyone who knows `gid` add themselves. The comment on lines 18-20 says the join code is the only way to learn the ID, but once someone has joined they keep the ID.

**How to reach it:**
- A member who is removed (by the owner, or by anyone via hole 1) still knows `gid` from their own `users/{uid}.currentGroupId` or from the URL/console. They call the same `updateDoc` as `joinGroupByCode` and are back in, with full read/write.
- Changing the join code does not help. The owner can delete `joinCodes/{old}` (line 56) and register a new one, but the join rule never looks at the code, only at `gid`.
- Anyone who ever saw the code once can look up `gid` and then join at any later time, even after the code is rotated.

**Fix:** make joining prove the current code. Have the joiner write the code they used, and check it against the group:

```
function joining() {
  return !(request.auth.uid in resource.data.members)
    && changed().hasOnly(['members', 'memberEmails'])
    && request.resource.data.members.toSet() == resource.data.members.toSet().union([request.auth.uid].toSet())
    && request.resource.data.get('memberEmails', {}).diff(resource.data.get('memberEmails', {})).affectedKeys().hasOnly([request.auth.uid])
    && exists(/databases/$(database)/documents/joinCodes/$(resource.data.joinCode))
    && getAfter(/databases/$(database)/documents/users/$(request.auth.uid)).data.joinCode == resource.data.joinCode;
}
```

…with the client writing `users/{uid}.joinCode` in the same batch as the group update. An alternative is a `groups/{gid}/banned/{uid}` doc that the owner writes on removal and the join rule checks with `!exists(...)`. Then add a "rotate join code" action for the owner: update `joinCode`, delete the old `joinCodes` doc and create the new one in one batch. Today `allow update: if false` on line 55 is fine, because rotation is delete plus create.

## 3. Any member can wipe the shared data (Medium)

**Where:** lines 86-90. `allow read, write: if isMember(gid)` covers create, update and delete for spools, archive, settings, printers and products.

**How to reach it:** as any member, loop over `getDocs(collection(db, 'groups', GID, 'products'))` and `deleteDoc` each one. The same works for the archive, which is the estimate history. Nothing records it, because activity logging is client-side and optional (firebase.js lines 300-310).

**Fix:** decide whether this is intended for a trusted small team. If it is not, give deletes to the owner only, and make the archive append-only:

```
match /products/{id} {
  allow read, create, update: if isMember(gid);
  allow delete: if isMember(gid) && groupData(gid).ownerUid == request.auth.uid;
}
match /archive/{id} {
  allow read, create: if isMember(gid);
  allow update, delete: if isMember(gid) && groupData(gid).ownerUid == request.auth.uid;
}
```

## 4. Emails are not checked (Medium)

**Where:** line 77 (`memberEmails` entry on join), the member branch on line 71, and line 95 (activity checks only `uid`). `signedIn()` (lines 25-28) does not require `email_verified`.

**How to reach it:**
- On join, write `memberEmails.{myUid}: 'owner@company.com'`. The members list then shows that email.
- Or sign up with someone else's address; nothing requires verification.
- Create an activity entry with `uid` = your own but `email: 'someone-else@…'`, any `action` text and any `timestamp` (for example far in the future, to pin it to the top of the feed).

The app renders these with `textContent`, so this is impersonation in the UI, not XSS.

**Fix:**

```
// join: your own email entry must match your token
&& request.resource.data.memberEmails[request.auth.uid] == request.auth.token.email
// activity
allow create: if isMember(gid)
  && request.resource.data.keys().hasOnly(['uid', 'email', 'action', 'timestamp'])
  && request.resource.data.uid == request.auth.uid
  && request.resource.data.email == request.auth.token.email
  && request.resource.data.action is string && request.resource.data.action.size() <= 200
  && request.resource.data.timestamp is int
  && request.resource.data.timestamp <= request.time.toMillis() + 60000;
```

Add `&& request.auth.token.email_verified == true` to `signedIn()` if email verification is turned on in Firebase Auth. Better still, switch `timestamp` to `serverTimestamp()` and check `== request.time`.

## 5. No schema or size limits on shared documents (Low)

**Where:** lines 86-90, 95.

**How to reach it:** any member can write documents of any shape, up to Firestore's 1 MiB limit, into every sub-collection, and can create activity entries without limit. A bad or buggy client can break other members' views with a product that has `filaments: "x"`, and can run up storage and read costs. The app's own size check (`checkProductSize`, 950 KB) is client-side only.

**Fix:** add `keys().hasOnly([...])` and type checks for the main fields of products, printers and spools, and cap string or array sizes, e.g. `request.resource.data.get('photos', []).size() <= 6`. Rate limiting activity needs a per-user counter doc or a Cloud Function; that is optional at this scale.

## 6. Orphans and undeletable activity (Low)

**Where:** line 56, line 83, lines 93-96.

- `activity` has no `delete` rule, so nobody, not even the owner, can clear the feed or remove a spoofed entry (see 4).
- Deleting `groups/{gid}` does not delete its sub-collections, and once the group doc is gone `isMember(gid)` fails for everyone. The data stays in the database, billed, and unreachable except from the console.
- Line 56 reads the group to authorise deleting a join code. After the group is deleted, the code doc can no longer be deleted by anyone, and the code stays taken.

The app has no "delete group" action today (`firebase.js` never deletes a group), so this only matters once one is added.

**Fix:** allow the owner to delete activity entries. Delete the join code and the sub-collections before the group doc, or use a Cloud Function on group delete. Let the join code delete pass when the group no longer exists: `!exists(/databases/$(database)/documents/groups/$(resource.data.gid)) || groupData(resource.data.gid).ownerUid == request.auth.uid`.

## 7. Join codes can be guessed (Low)

**Where:** line 46. Any signed-in user may `get` any `joinCodes/{code}`.

**How to reach it:** codes are 6 characters, `ABC-DEF`, from `generateJoinCode` (31^6, about 887 million combinations, picked with `Math.random`, not `crypto.getRandomValues`). A script with an account can `get` codes in a loop. Each miss is a billed read for the project, and with enough groups some hits are likely. Combined with hole 2, a hit means permanent membership.

**Fix:** fixing hole 2 limits the damage. Longer codes (8 or more characters) make guessing impractical. Turn on App Check so only the real site can call Firestore, and set a budget alert.

---

## What is fine

- **Cross-group isolation.** Every sub-collection rule calls `isMember(gid)` with the `gid` from the path, and the group read on line 61 requires membership. Queries across groups need `where('members', 'array-contains', uid)`, which only returns the caller's own groups. A member of group A cannot read or write group B.
- **Join codes cannot be listed** (line 47) or overwritten (line 55). A taken code makes `setDoc` an update, which is refused, and `registerJoinCode` then picks a new code.
- **Only the owner can register a code**, and only the group's current code (lines 51-54).
- **Group create** forces the creator to be owner and only member (lines 63-65).
- **`users/{uid}`** is private to its owner (line 40). Anonymous users can write their own doc, which is harmless.
- **Anonymous accounts** cannot touch groups (`signedIn()` excludes them).

## Suggested order

1. Fix 1 and 2 together. They share the update rule, and 2 is pointless without 1.
2. Fix 4 (email checks). These are small rule changes.
3. Decide on 3 with the people who use the app.
4. 5 to 7 when convenient.

Before publishing new rules, test them in the Firebase console's Rules Playground, or with the emulator once Java is installed (`firebase emulators:start --only firestore` and `@firebase/rules-unit-testing`).

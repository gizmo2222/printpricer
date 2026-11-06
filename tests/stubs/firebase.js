// Stands in for the three Firebase CDN modules (app, auth, firestore).
// firebase.js only calls these at load time; nothing in the tests talks to
// Firestore, and isInCloudMode() is false unless a test sets state.user.

export function initializeApp(config) { return { config }; }
export function getAuth() { return {}; }
export function getFirestore() { return {}; }
export async function enableIndexedDbPersistence() {}

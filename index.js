// ============================================================
// lil-mayo · CLOUD FUNCTIONS
//
// Two callable functions:
//   - startRun:    creates a /runs doc, returns runId to the client.
//                  Rate-limited per UID so a single user can't spam runs.
//   - submitScore: validates the runId, runs plausibility checks on the
//                  submitted score, and writes a single /leaderboard entry.
//
// Security model:
//   - All clients are signed in anonymously, so context.auth.uid is always
//     present. We reject any call without it.
//   - Firestore rules forbid client writes to /leaderboard and /runs.
//     The Admin SDK in these functions bypasses rules.
//   - Run docs are single-use (marked `used: true` on first submitScore).
// ============================================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Pin region. Must match FUNCTIONS_REGION in the client HTML.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// ===== TUNABLES =====
// These should match (or be looser than) the in-game tuning. If you change
// the game's tier/speed curves, revisit these numbers.

// Highest plausible cash per second a player could reasonably collect.
// Set very loose so legit fast runs at high speed never get rejected.
// Cheater filter relies on the runId + duration check, not this number.
const MAX_CASH_PER_SECOND = 1000;

// Absolute ceilings — anything beyond these is obviously bogus.
// Configured very loose per design: real player runs should never hit these,
// they're just here as the final "no way this is real" sanity floor.
//   ABS_MAX_CASH      — total cash for one run. Set high so big runs pass.
//   ABS_MAX_TOP_SPEED — peak speed multiplier. Real peak in extreme runs is
//                       ~8-10×; 50 is just a "definitely not real" ceiling.
const ABS_MAX_CASH      = 100_000;
const ABS_MAX_TOP_SPEED = 50;
const ABS_MIN_RUN_MS    = 1_500;
const ABS_MAX_RUN_MS    = 60 * 60_000;

// Rate limits.
const START_RUN_COOLDOWN_MS = 3_000;   // one startRun per UID per 3 s
const SUBMIT_COOLDOWN_MS    = 30_000;  // one submission per UID per 30 s

// Name validation.
const NAME_MIN = 1;
const NAME_MAX = 12;
const NAME_REGEX = /^[A-Z0-9_\.\-@!\?]+$/;  // uppercase letters/digits + a few symbols

// A tiny in-function blocklist. Tune to your taste — keep it small,
// most moderation is better done by manually deleting bad entries from
// the Firestore console.
const BLOCKLIST = [
  'NIGGER','FAGGOT','RETARD','KIKE','CHINK','SPIC','TRANNY',
];
function isBlocked(name){
  const upper = String(name).toUpperCase();
  return BLOCKLIST.some(bad => upper.includes(bad));
}

// ============================================================
// startRun
// Returns a runId tied to this user. The user must echo it back
// when calling submitScore.
// ============================================================
exports.startRun = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');

  // Per-UID rate limit on starting runs.
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const now = Date.now();
  if (userSnap.exists){
    const last = userSnap.get('lastStartMs') || 0;
    if (now - last < START_RUN_COOLDOWN_MS){
      throw new HttpsError('resource-exhausted',
        'Slow down — try again in a moment.');
    }
  }

  // Create the run doc.
  const runRef = await db.collection('runs').add({
    uid,
    startedAt: FieldValue.serverTimestamp(),
    used: false,
  });
  await userRef.set({ lastStartMs: now }, { merge: true });

  return {
    runId: runRef.id,
    startedAt: now,  // approximate, server-truthed at submit time
  };
});

// ============================================================
// submitScore
// Validates the runId, runs plausibility checks, writes the entry.
// ============================================================
exports.submitScore = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');

  const data = request.data || {};
  let { runId, name, cash, topSpeed } = data;

  // ---- Shape & type checks ----
  if (typeof runId !== 'string' || !runId)
    throw new HttpsError('invalid-argument', 'Missing runId.');
  if (typeof name !== 'string')
    throw new HttpsError('invalid-argument', 'Name must be a string.');
  if (typeof cash !== 'number' || !Number.isFinite(cash))
    throw new HttpsError('invalid-argument', 'Cash must be a number.');
  if (typeof topSpeed !== 'number' || !Number.isFinite(topSpeed))
    throw new HttpsError('invalid-argument', 'topSpeed must be a number.');

  // ---- Per-UID submission rate limit ----
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const now = Date.now();
  if (userSnap.exists){
    const lastSubmit = userSnap.get('lastSubmitMs') || 0;
    if (now - lastSubmit < SUBMIT_COOLDOWN_MS){
      throw new HttpsError('resource-exhausted',
        'You just submitted a score. Wait a moment and try again.');
    }
  }

  // ---- Name validation ----
  name = name.trim().toUpperCase().slice(0, NAME_MAX);
  if (name.length < NAME_MIN)
    throw new HttpsError('invalid-argument', 'Name is required.');
  if (!NAME_REGEX.test(name))
    throw new HttpsError('invalid-argument', 'Name has invalid characters.');
  if (isBlocked(name))
    throw new HttpsError('invalid-argument', 'Pick another name.');

  // ---- Score sanity ceilings ----
  if (cash < 0 || cash > ABS_MAX_CASH)
    throw new HttpsError('out-of-range', 'Cash out of range.');
  if (topSpeed < 1 || topSpeed > ABS_MAX_TOP_SPEED)
    throw new HttpsError('out-of-range', 'Top speed out of range.');

  // ---- Run doc validation ----
  // This is the heart of the security model. The run doc was created
  // server-side with a serverTimestamp. We trust it, not the client.
  const runRef = db.collection('runs').doc(runId);
  const runSnap = await runRef.get();
  if (!runSnap.exists)
    throw new HttpsError('not-found', 'No such run.');
  const run = runSnap.data();
  if (run.uid !== uid)
    throw new HttpsError('permission-denied', 'Run does not belong to you.');
  if (run.used)
    throw new HttpsError('failed-precondition', 'Run already submitted.');
  if (!run.startedAt || typeof run.startedAt.toMillis !== 'function')
    throw new HttpsError('failed-precondition', 'Run is missing start time.');

  const startedMs = run.startedAt.toMillis();
  const elapsedMs = now - startedMs;
  if (elapsedMs < ABS_MIN_RUN_MS)
    throw new HttpsError('failed-precondition', 'Run too short.');
  if (elapsedMs > ABS_MAX_RUN_MS)
    throw new HttpsError('failed-precondition', 'Run timed out.');

  // ---- The key plausibility check: cash vs run duration ----
  // Player cannot have legitimately earned more than
  // (elapsedSeconds × MAX_CASH_PER_SECOND).
  const elapsedSec = elapsedMs / 1000;
  const maxPlausibleCash = elapsedSec * MAX_CASH_PER_SECOND;
  if (cash > maxPlausibleCash){
    console.warn('[submitScore] rejecting implausible cash', {
      uid, runId, cash, elapsedSec, maxPlausibleCash,
    });
    throw new HttpsError('failed-precondition', 'Score looks implausible.');
  }

  // ---- All checks passed. Write the entry. ----
  // Atomic: mark the run used + write the leaderboard entry + update user.
  const batch = db.batch();
  batch.update(runRef, { used: true, claimedAt: FieldValue.serverTimestamp() });
  const entryRef = db.collection('leaderboard').doc();
  batch.set(entryRef, {
    name,
    cash,
    topSpeed,
    uid,
    ts: FieldValue.serverTimestamp(),
  });
  batch.set(userRef, { lastSubmitMs: now }, { merge: true });
  await batch.commit();

  return { ok: true, entryId: entryRef.id };
});

# lil-mayo · Leaderboard Setup (Windows)

This wires the leaderboard to **Firebase**: Anonymous Auth + Firestore + Cloud Functions. No App Check, no IP collection, no HMAC. Server-side run docs + plausibility checks do the security work.

## What's in this package

```
lil-mayo.html              ← your site (Firebase config goes inside)
firebase.json              ← deploy config
firestore.rules            ← public read, no client writes
firestore.indexes.json     ← index config (empty for now)
functions/
  index.js                 ← startRun + submitScore Cloud Functions
  package.json             ← function deps
images/                    ← put your PNGs here (filenames must match):
  congratz-bg.png          ← behind the leaderboard pop-up
  crashed-bg.png           ← behind the in-game crashed-out screen
  feature-1.png            ← first slot under the leaderboard
  feature-2.png            ← middle slot
  feature-3.png            ← third slot
```

If you'd rather use different filenames, change them in `lil-mayo.html`:
- Background images: search for `.ne-bg` and `#overlay.crashed-out::before` in the `<style>` block.
- The 3 feature slots: search for `feature-1.png` and you'll find all three together.

## One-time setup

### 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project**. Pick a name.
2. Disable Google Analytics (not needed for this).
3. In the project dashboard, click the gear ⚙️ → **Project settings**.
4. Scroll to **Your apps** → click the **Web** icon (`</>`). Register the app with any nickname. **Do NOT enable Firebase Hosting yet.**
5. Copy the `firebaseConfig` object Firebase shows you. You'll paste it into `lil-mayo.html` in step 5.

### 2. Upgrade to Blaze (pay-as-you-go)

Cloud Functions require Blaze. There's a generous free tier — for a small game you'll almost certainly pay $0/mo. Set a budget alert at $5 for safety.

1. Bottom-left of console → **Upgrade** → **Blaze**.
2. Set a budget alert: **Usage and billing** → **Details & settings** → **Modify plan** → add a $5 alert.

### 3. Enable the services

In the Firebase console for your project:

1. **Authentication** → Get started → **Sign-in method** tab → enable **Anonymous**.
2. **Firestore Database** → Create database → start in **production mode** (we'll deploy rules in a second) → pick the same region you'll use for functions (default `us-central1` is fine).
3. **Functions** → Get started (this just confirms billing is on).

### 4. Install Firebase CLI on your Windows machine

Open **Command Prompt** or **PowerShell** as admin and run:

```bat
npm install -g firebase-tools
firebase login
```

`firebase login` opens a browser tab to sign in with your Google account.

### 5. Drop in your Firebase config

Open `lil-mayo.html` and find the `firebaseConfig = {` block near the top of the script section. Replace `YOUR_API_KEY` etc. with the values from step 1.5.

If your Firestore region isn't `us-central1`, also update `FUNCTIONS_REGION` on the line below (and in `functions/index.js` `setGlobalOptions`).

### 6. Initialize the project locally

In Command Prompt, navigate to the folder that contains `firebase.json`:

```bat
cd C:\path\to\lil-mayo
firebase use --add
```

It'll ask which project — pick the one you created. Give it an alias like `default`.

### 7. Install function dependencies

```bat
cd functions
npm install
cd ..
```

### 8. Deploy everything

```bat
firebase deploy
```

This pushes the Firestore rules, the indexes file, and both Cloud Functions. First deploy takes 2–5 minutes (it has to provision the functions).

### 9. Test it

Open `lil-mayo.html` in a browser (you can just double-click it, or serve it locally with `npx serve .`). Play a round, get a high score, enter a name. Check the Firebase console → **Firestore** → you should see a new doc in `/leaderboard`.

If the submit fails, open the browser devtools console — the error message comes from your Cloud Function and will tell you why (too short, name invalid, etc.).

## What's protected

| Attack | Outcome |
|---|---|
| User writes `{cash: 9999999}` from devtools | **Blocked** — Firestore rules forbid all client writes. |
| Scripted `curl` / Postman call to `submitScore` | **Blocked** — needs a valid `runId` from a prior `startRun`. |
| Call `startRun` then `submitScore` 1 second later | **Blocked** — `ABS_MIN_RUN_MS` (1.5s) rejects. |
| Call `startRun`, wait 5s, submit `cash: 999999` | **Blocked** — exceeds `5s × MAX_CASH_PER_SECOND` (1250). |
| Call `submitScore` 50× in a loop | **Blocked** — per-UID 30s cooldown. |
| Play legit, pause script in devtools, set `score = X` (within cap), submit | **Passes** — this is the unavoidable limit of client-side games. |
| Profanity / slurs in name | **Blocked** — small blocklist in `functions/index.js`. |

## Tuning the cheat thresholds

Open `functions/index.js`. The top constants:

- `MAX_CASH_PER_SECOND` — main lever. Watch real submissions for a week, find the genuine ceiling, set this ~30% above it.
- `ABS_MAX_CASH`, `ABS_MAX_TOP_SPEED` — absolute caps. Should be impossible to reach legitimately.
- `START_RUN_COOLDOWN_MS`, `SUBMIT_COOLDOWN_MS` — rate limits. Loosen if real users complain, tighten if you see spam.

After editing, redeploy just the functions:

```bat
firebase deploy --only functions
```

## Cleaning up bad entries

Firebase console → **Firestore** → `leaderboard` → click any doc → 🗑️.

The leaderboard auto-trims to top 10 on display (the client only requests the top 10), but old extras stay in the collection. If you want to actually delete them you can do it manually or write a scheduled function later.

## Adding App Check later

If you ever see scripted abuse from real browsers (Puppeteer farms, etc.):

1. Console → **App Check** → register your site with reCAPTCHA v3.
2. In `functions/index.js`, change `onCall(async (request) => {...})` to `onCall({ enforceAppCheck: true }, async (request) => {...})` on both functions.
3. In `lil-mayo.html`, add a few lines after `initializeApp` to init App Check. The Firebase docs have a copy-paste snippet.

That's it. Architecture doesn't change.

## Going further

- **Admin moderation page**: gated to your email, shows recent submissions with delete buttons. Worth building once entries start piling up.
- **Seasons**: add `season: "s1"` to each entry, query by season, reset every month.
- **Verified flag**: manually mark certain entries `verified: true` so prize allocation only considers verified ones.

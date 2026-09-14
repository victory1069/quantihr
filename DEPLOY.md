# Deploying the API and building the app for testing

Two pieces: the API goes to Render, the Android app is built by EAS and points
at the deployed API.

---

## 1. API → Render

[`render.yaml`](render.yaml) is a blueprint: it declares the web service and the
Postgres instance together, so Render creates both and wires `DATABASE_URL`
between them.

1. Push this branch to GitHub (already done).
2. render.com → **New** → **Blueprint** → pick the `quantihr` repo.
3. Apply. Render creates `quanti-api` and `quanti-db`, generates `JWT_SECRET`,
   and deploys.
4. Note the service URL, e.g. `https://quanti-api.onrender.com`.
5. Check it: `curl https://quanti-api.onrender.com/health` → `{"status":"ok",
   "driver":"postgres", ...}`. **`driver` must read `postgres`.** If it says
   `pglite`, `DATABASE_URL` did not reach the process and all data is in memory.

The schema is applied on boot by `db.applySchema()` — there is no migration
step to run.

### Why this deploys with `NODE_ENV=development`

Not an oversight. Production mode would make the deployment untestable:

- `src/index.ts` seeds only when `NODE_ENV !== 'production'`, so production
  boots an empty database — no org, no employees, nothing to look at.
- `lib/env.ts` refuses to start in production unless `EMAIL_DRIVER` is `ses` or
  `smtp`, which means standing up a mail provider before you can see anything.
- The seeded accounts use `@kanjufoods.test` addresses. `.test` is reserved by
  RFC 2606 and is unroutable, so no mail provider could deliver a magic link to
  them regardless.

What is *not* downgraded: `DATABASE_URL` points at real managed Postgres, so
RLS — the tenant isolation mechanism — behaves exactly as in production. Only
seeding and mail delivery differ from a production boot.

### Signing in without a mail provider

`routes/auth.ts` returns the magic link in the response body outside production,
and the app follows it. Nothing to configure.

If you need the link by hand, it is in the Render logs prefixed `[email] →`.

### Free-tier limits worth knowing before you rely on this

- The web service **sleeps after 15 minutes idle**. The next request takes
  roughly 50 seconds while it wakes. First launch after a break looks like the
  app hanging — it is the API cold-starting.
- Render **expires free Postgres 30 days after creation**. The database is
  deleted, not just stopped. Upgrade it or expect to recreate the blueprint.
- Uploads use `STORAGE_DRIVER=local`, and Render's disk is ephemeral. Documents
  and meeting audio do not survive a redeploy. Fine for testing; switch to
  `s3` for anything real.

### Optional extras

Set these in the Render dashboard, not in `render.yaml`:

- `ANTHROPIC_API_KEY` — turns on meeting summarisation. Without it the pipeline
  reports the summary as unavailable rather than inventing one.
- `EMAIL_DRIVER=smtp` + `SMTP_*` — real magic-link delivery, needed only once
  you have accounts on routable domains.

---

## 2. Android app → EAS

### One-time setup

```bash
npm install -g eas-cli
export EXPO_TOKEN=<your token from expo.dev/settings/access-tokens>

cd apps/mobile
eas init            # creates the EAS project, writes extra.eas.projectId
```

### Point the build at your API

`EXPO_PUBLIC_API_URL` is inlined into the JS bundle **at build time** — a built
APK cannot be repointed afterwards. Replace the `REPLACE-ME` placeholder in
[`apps/mobile/eas.json`](apps/mobile/eas.json) with the Render URL first — the `base` profile is inherited by all three, so there is one place to change it.

`http://localhost:4000` — the default in `src/api/client.ts` — is the phone
itself on a device, which is why this has to be set.

### Build

```bash
cd apps/mobile

eas build --profile preview     --platform android   # standalone APK
eas build --profile development --platform android   # dev client
```

EAS generates and stores the Android keystore on first build.

Both profiles produce an APK (not AAB) with `distribution: internal`, so EAS
gives you a download link and QR code. Sideload it directly — no Play Store.

### Which profile to use

- **preview** — self-contained. Install and run, no laptop involved. This is the
  one to hand to someone else.
- **development** — loads JS from Metro over the LAN, so you can edit code and
  change the API URL without rebuilding. Needs `npm start` running here and the
  phone on the same wifi.

Expo Go will not work for either. `react-native-mmkv`, `expo-sqlite`,
`expo-audio` and `expo-local-authentication` are native modules that are not in
the Go runtime; a custom build is required.

---

## Note on the react-native version

Expo SDK 57 bundles **react-native 0.86.3** (`expo/bundledNativeModules.json`),
but npm had hoisted **0.87.1**, because `react-native` was not a direct
dependency of the mobile app and so nothing constrained it — `expo install
--check` never audited it either.

That skew was survivable for Metro bundling, and the repo carries two shims for
it ([`metro.config.js`](apps/mobile/metro.config.js) and
[`scripts/patch-rn-polyfills.cjs`](scripts/patch-rn-polyfills.cjs)). A native
EAS build is a different matter: Gradle, autolinking and every Expo module
compile against 0.86.3's headers and build scripts, where those JS-level shims
do not apply.

`react-native` is now an explicit dependency of `@quanti/mobile` pinned to
`0.86.3`, with a matching entry in the root `overrides` so npm cannot hoist a
second copy — the same treatment `react` already had, and for the same reason.

Keep it in step with the SDK: after any `expo` upgrade, check
`node -p "require('expo/bundledNativeModules.json')['react-native']"` and move
the pin to match.

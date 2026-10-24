# Wellbe phone app (iPhone and Android)

The client app you already have (`client/index.html`, the game, the shared core) packed into a real app with Capacitor. Same screens, plus what only an installed app can do: push notifications, reminders that work with the phone locked, and steps from Apple Health or Google Health Connect.

Nothing here is built yet: building needs your Apple and Google accounts (see `supabase/README-PHASE5.md`, "What only Majd can do").

## What is in this folder

* `capacitor.config.ts`: app name Wellbe, app ID `com.wellbe.client`. The ID can never change after the first upload: confirm it before step 3.
* `package.json`: the plugins.
  * Push notifications: `@capacitor/push-notifications` (Apple and Firebase).
  * Reminders on the phone, no server: `@capacitor/local-notifications`. `src/reminders.js` plans 8 water reminders (each can be turned off or moved in the app), the midday move more nudge, and the 10:00 quote.
  * Steps: `@capgo/capacitor-health` (Apple HealthKit and Google Health Connect, read only, steps only). `src/health.js`.
  * In app purchases (coin packs, outfits, online workout subscription): `@revenuecat/purchases-capacitor`. Center packages are paid at the center or online with Areeba / Whish, never through the stores.
* `scripts/copy-web.js`: copies the client app, the game and the core into `www/`, the folder the app is built from. The 3D models stay online and load on first play.

## Build steps (on a Mac, about 2 hours the first time)

1. Install Xcode from the App Store, then Node 20 (nodejs.org) and CocoaPods (`sudo gem install cocoapods`). For Android also install Android Studio.
2. In this folder: `npm install`. Then pin the two community plugins to their current version (`npm install @capgo/capacitor-health@latest @revenuecat/purchases-capacitor@latest`) and check `src/health.js` against that version's method names. If Capacitor has a newer major version by then, upgrade all `@capacitor/*` packages together.
3. `npx cap add ios` and `npx cap add android` (once).
4. `npm run ios` opens Xcode. In Xcode:
   * Signing and Capabilities: pick your team (the Apple Developer account), add **HealthKit** and **Push Notifications**.
   * Info.plist: add `NSHealthShareUsageDescription` = "Wellbe reads your steps to count your daily 10,000 steps goal." and `NSUserNotificationsUsageDescription`.
   * Product, Archive, then Distribute App to TestFlight. Test on your phone first.
5. `npm run android` opens Android Studio. In `AndroidManifest.xml` add the Health Connect read steps permission (`android.permission.health.READ_STEPS`) and the privacy policy link the Health Connect rules ask for. Build, Generate Signed Bundle, upload to the Play Console internal test track.
6. Store pages: the privacy policy link (`client/privacy.html` on your site), the health data explanation, a demo client account for the reviewers, screenshots. Apple and Google both review the first version (a few days).

## How the client app uses it

Inside the installed app `window.Capacitor` exists, so the client app can call `WellbeReminders.plan({...})` after the client changes a reminder, and `WellbeHealth.stepsToday()` for the streak. In a normal browser these do nothing, so the web version keeps working unchanged. Wiring these two calls into the client app screens is part of the boot rewrite in Phase 5.

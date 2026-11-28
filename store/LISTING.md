# Pebble Appstore listing

The material behind PebbleKey for Volvo's listing in the Pebble Appstore:
https://apps.repebble.com/17029805a6d84b6295f32a36

## Before you list it publicly

- **Test with a second Volvo ID.** It is not verified that the Volvo application behind the
  sign-in service accepts accounts other than its owner's. Have someone else sign in first.
- **Shared quota.** All users share that application's 10,000 Volvo API calls per day.
- **The name.** Volvo's developer terms restrict use of Volvo's names and marks. Decide whether
  to keep "Volvo" in the listing name.

Submitting as **Unlisted** first covers all three: the app is installable from its link but
does not appear in search, and you can switch it to Listed later.

## Fields

| Field | Value |
| --- | --- |
| File | `dist/PebbleKey.pbw` (version 1.2.0) |
| App name | PebbleKey for Volvo |
| Category | Remotes |
| Description | the text in [description.txt](description.txt) |
| Small icon (80×80) | [icon-80.png](icon-80.png) |
| Large icon (144×144) | [icon-144.png](icon-144.png) |
| Banner (720×320, optional) | [banner.png](banner.png), the same file for every platform |
| Website URL | https://github.com/alarmatwork/PebbleKey |
| Source code URL | https://github.com/alarmatwork/PebbleKey |
| Release notes | see [Release notes](#release-notes) below |
| Visibility | Unlisted to start with, Listed once tested |

## Screenshots

Five per watch model, in [screenshots/](screenshots/), taken from `dist/PebbleKey.pbw` in the
emulator with sample car data. Each file name starts with the platform it belongs to.

| Platform | Watch | Size |
| --- | --- | --- |
| aplite | Pebble, Pebble Steel | 144×168 |
| basalt | Pebble Time, Time Steel | 144×168 |
| chalk | Pebble Time Round | 180×180 |
| diorite | Pebble 2 | 144×168 |
| emery | Pebble Time 2 | 200×228 |
| flint | Pebble 2 Duo | 144×168 |
| gabbro | Pebble Round 2 | 260×260 |

The five screens, in the order to upload them: `1_locked`, `2_unlocked`, `3_climate`,
`4_far_away`, `5_charging`.

## Release notes

**1.2.0**

> UP now locks or unlocks: PebbleKey asks the car and does the opposite. DOWN opens a menu with
> car info, find car, and flashing the lights.
> Climate no longer reports a failure when the car is only slow to confirm.
> After locking, the watch no longer briefly goes back to the old lock state.

**1.1.0**

> Shows charging: a lightning bolt next to the battery level, the charge target and the time
> left. To switch it on, tap Sign in with Volvo in the settings once more.
> When your Volvo login has run out, the watch now says so as soon as you open the app.

**1.0.0**

> First release.

## Submitting

Use the web form rather than `pebble publish` for the first submission: the form lets you pick
Unlisted, while `pebble publish` lists a new app publicly at once.

1. Open the [Developer Dashboard](https://developer.repebble.com/dashboard) and sign in with
   Google, GitHub or Apple. Use the same method every time.
2. Click **New** and upload `dist/PebbleKey.pbw`.
3. Fill in the fields from the table above and upload the icons.
4. Upload the screenshots under each platform.
5. Set **App visibility** to Unlisted and click **Submit App**.

There is no review queue: the app is live at `https://apps.repebble.com/<id>` straight away.

## Releasing an update later

If the update asks Volvo for a new permission, deploy the sign-in service first
(`cd broker && npx wrangler deploy`), so that people who sign in again get it.

1. Raise `version` in `package.json`. The store refuses a version it has seen before.
2. Run `tools/make_dist.sh` to rebuild `dist/PebbleKey.pbw`.
3. In the dashboard, open the app, click **New Release** and upload the new file with release
   notes. Or run `pebble login` once and then `pebble publish --pbw dist/PebbleKey.pbw`.

People who installed from the store get the new release through the Pebble app. People who
installed the file from GitHub do not.

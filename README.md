# PebbleKey

Lock, unlock and pre-heat a Volvo from a Pebble watch.

<img src="docs/screenshot.png" alt="PebbleKey on a Pebble Time 2" width="200">

PebbleKey is a Pebble watchapp that talks to Volvo's
[Connected Vehicle API](https://developer.volvocars.com/apis/connected-vehicle/v2/overview/).
There is no server and no extra phone app: the phone half is JavaScript that runs inside the
official Pebble app, and your Volvo credentials stay on your own phone.

| Button | Action |
| --- | --- |
| Hold UP | Unlock (asks for a second hold if the phone is not near the car) |
| Hold SELECT (middle) | Climate on, or off if PebbleKey turned it on |
| Hold DOWN | Lock |

The line under the title shows what the car last reported: lock state, anything left open and
battery level.

> **Status:** a personal project built for a Volvo EX30. It is young and lightly tested. Other
> Volvo models that support the Connected Vehicle API should work but have not been tried.
> It is not affiliated with Volvo Cars or with Pebble / Core Devices. It can unlock your car:
> use it at your own risk.

## What you need

- A Pebble watch paired with the current Pebble phone app (built for all models, from the
  original Pebble to Pebble 2 Duo, Pebble Time 2 and Pebble Round 2)
- A Volvo with an active Volvo ID and remote services
- A computer with Python 3.8+ and [uv](https://docs.astral.sh/uv/) to log in and build
- A free account at [developer.volvocars.com](https://developer.volvocars.com/)

## Setup

### 1. Create a Volvo API application

1. Sign in at [developer.volvocars.com](https://developer.volvocars.com/), open your account
   page and create an application. It gets a **VCC API key** straight away.
2. Click **Publish** on the application. This is where you choose scopes and the redirect URI,
   and where you get the **client ID** and **client secret**.
3. Redirect URI: `http://localhost:8765/callback`
4. Scopes: tick all of these now. I found no way to add one later short of creating a new
   application.

| Scope | Used for |
| --- | --- |
| `conve:lock` | Lock (required) |
| `conve:unlock` | Unlock (required) |
| `conve:climatization_start_stop` | Climate on/off |
| `conve:lock_status`, `conve:doors_status` | Lock state and open doors on the status line |
| `conve:fuel_status`, `conve:battery_charge_level` | Battery level on the status line |
| `location:read` | Distance check before unlocking |

Only lock and unlock are required. Anything you leave out is simply missing in the app.

### 2. Log in once on your computer

```bash
python3 tools/volvo_login.py
```

The script asks for the client ID, client secret, VCC API key (the primary one) and your car's
17-character VIN, then opens the Volvo ID sign-in in your browser. Tick **Remember me** there.

It checks which scopes your application has, requests only those, and prints a **setup code**
starting with `EX30K1.`. The code contains your client secret and login, so treat it like a
password.

Your answers are saved in `tools/.volvo.json`, which is git-ignored and readable only by you.
Use `--reconfigure` to enter them again, for example after creating a new Volvo application.

### 3. Build the watchapp

```bash
uv tool install --python 3.13 pebble-tool
```

```bash
pebble sdk install latest
```

```bash
npm install
```

```bash
pebble build
```

The result is a `.pbw` file in `build/`.

### 4. Install it on the watch

Either send the `.pbw` file to your phone and open it with the Pebble app, or install over the
developer connection:

1. In the Pebble phone app: **Settings > Phone > Connectivity**, turn on
   **Use LAN developer connection**.
2. **Devices** tab, three-dot menu on your connected watch, turn **Dev Connection** on (off and
   on again if it already was).
3. With the phone awake and the IP address shown under that switch:

```bash
pebble install --phone <phone-ip>
```

The LAN developer connection has no authentication. Use it on a network you trust and switch it
off afterwards.

### 5. Paste the setup code

In the Pebble phone app open PebbleKey's settings, paste the setup code and save. The watch
shows "Setup saved" and, a moment later, the car's status.

The Pebble phone app will ask you to allow PebbleKey:

- **Internet access**, to reach `auth.volvocars.com` and `api.volvocars.com` (nothing else)
- **Location**, only for the distance check before unlocking

### 6. Quick launch (optional)

On the watch, **Settings > Quick Launch** lets you open PebbleKey by holding a button on the
watchface. Opening the app never does anything by itself: release the button, then hold UP,
SELECT or DOWN.

## How it behaves

**Unlock safety.** Before unlocking, the phone compares its position with where the car is
parked. Within 200 m the unlock goes straight through. Further away, or when either position
is unknown, the watch shows why and unlocks only if you hold UP again within 15 seconds. The
range (100 m, 200 m, 500 m or off) is in the settings. Lock and climate work from anywhere.

**Climate.** Volvo's API cannot report whether climate is running, so the middle button goes by
what PebbleKey last did: it stops climate if PebbleKey started it in the last 30 minutes,
otherwise it starts it. If you switched climate from the Volvo app or the car in between, the
first hold may do nothing visible; hold again.

**Status line.** Read when the app opens and again a few seconds after a lock or unlock. It is
what the car last told Volvo, so it can lag behind the car.

**Feedback.** A command takes a few seconds. The watch buzzes once on success and twice on
failure, with the reason on screen.

**Login lifetime.** Volvo limits a login to 3 months. When the watch shows
"Login expired, redo setup", repeat steps 2 and 5. Volvo also replaces the login token every
time it is used, so a setup code stops working once the watch has sent its first command.

## Messages on the watch

| Message | Meaning |
| --- | --- |
| Set up in Pebble app | No setup code has been entered yet |
| Allow internet in Pebble app | The Pebble phone app is blocking PebbleKey's internet access |
| No internet on phone | The phone could not reach Volvo |
| Login expired, redo setup | Run the login script again and paste the new code |
| Not allowed (scopes?) | Your Volvo application lacks the scope for this action |
| Car is asleep / Car is offline | The car did not take the command; try again shortly |
| A door is open | The car refused to lock |
| Car is 2.3 km away | Distance check: hold UP again to unlock anyway |
| No car location / No phone location | Distance check could not run; hold UP again to unlock anyway |
| No reply from phone | The watch lost its connection to the phone |

## Security notes

- Anyone holding your unlocked watch while it is connected to your phone can unlock your car.
- Your client secret and login token are stored in the Pebble phone app's storage for this
  watchapp, on your phone only.
- The setup code and `tools/.volvo.json` hold the same secrets. Do not share or commit them.

## Development

```bash
node --test
```

runs the tests for the phone-side code against a fake Volvo backend; no car or account needed.

| Path | Contents |
| --- | --- |
| `src/c/main.c` | Watch UI and buttons |
| `src/pkjs/volvo.js` | Token refresh and Volvo API calls |
| `src/pkjs/proximity.js` | Distance check between phone and car |
| `src/pkjs/index.js` | Glue between watch, settings page and the two modules above |
| `src/pkjs/config.json` | Settings page ([Clay](https://github.com/pebble/clay)) |
| `tools/volvo_login.py` | One-time Volvo ID login |
| `test/` | Tests |

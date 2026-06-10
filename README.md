# claude usage widget

An iPhone home screen widget for [Scriptable](https://scriptable.app) (free) that shows your Claude usage at a glance:

- **Session usage** — the rolling 5-hour window
- **Weekly usage** — the 7-day window (plus the weekly Opus window if your plan has one)
- **Time until reset** — countdown to the next window reset
- **Color coding** — green → orange → red as you approach the limit
- **Notifications** — a warning when usage crosses 90%, and an alert when a heavily-used window resets

No app to open, no server to run: one JavaScript file inside Scriptable, refreshing in the background.

## How it works

The widget calls the same usage endpoint that powers Claude Code's `/usage` command (`api.anthropic.com/api/oauth/usage`), authenticated with your Claude Code OAuth credentials. Access tokens expire after a few hours, but the stored **refresh token** lets the widget mint new ones automatically — so after a one-time setup there is no manual token maintenance.

All credentials are stored in the iOS Keychain via Scriptable's `Keychain` API, never in the script file itself.

## Setup (~3 minutes)

**Prerequisite:** a Claude subscription (Pro/Max) that you've used to log in to Claude Code on any computer.

1. **Get your credentials.** On a machine where Claude Code is logged in, copy the contents of the credentials file to your clipboard:
   - macOS/Linux: `cat ~/.claude/.credentials.json | pbcopy` (or just open the file and copy it)
   - Send it to your phone however you like (AirDrop a note, iCloud clipboard via Handoff, etc.) and copy it on the phone
2. **Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)** from the App Store.
3. **Create the script.** In Scriptable, tap **+**, paste the contents of [`claude-usage.js`](claude-usage.js), and name it `claude-usage`.
4. **Run it once** (tap the play button). Choose **paste credentials**, then **read clipboard**. You should see "saved". Use **test fetch** to confirm it works.
5. **Add the widget.** Long-press the home screen → **Edit** → **Add Widget** → search "Scriptable" → pick the small (or medium) size → tap the widget → set **Script** to `claude-usage`.

That's it. The widget refreshes in the background (iOS controls the exact cadence, typically every 15–30 minutes).

## Configuration

Edit the `CONFIG` block at the top of the script:

| option | default | meaning |
|---|---|---|
| `warnAt` | `60` | % where bars turn orange |
| `dangerAt` | `85` | % where bars turn red |
| `notifyAt` | `90` | % that triggers a near-limit notification (once per window) |
| `resetNotifyAbove` | `75` | schedule a "limit reset" notification if usage was above this % |
| `refreshMinutes` | `5` | requested widget refresh interval |

## Widget states

- **setup needed** — no credentials stored yet; run the script in the app
- **re-auth needed** — the refresh token stopped working; re-paste credentials from `~/.claude/.credentials.json`
- **`claude · as of 9:41`** header — network was unreachable, showing the last cached numbers

## Troubleshooting

- **"fetch failed: AUTH"** — your refresh token was rotated or revoked. Re-copy `~/.claude/.credentials.json` (log in to Claude Code again if needed) and re-paste.
- **Notifications don't appear** — allow notifications for Scriptable in iOS Settings, and note alerts only fire when the widget refreshes in the background.
- **Widget feels stale** — iOS throttles widget refreshes; tapping the widget opens claude.ai, and re-adding the widget forces a refresh.

## Caveats

- The usage endpoint is **undocumented** and could change shape without notice; the widget fails soft (shows cached data) when it does.
- Claude Code on your desktop refreshes the same credentials. If Anthropic ever invalidates old refresh tokens on rotation, the widget's copy may stop working and need a one-time re-paste.

## Security note

Your credentials grant access to your Claude account — treat `~/.claude/.credentials.json` like a password. The script keeps them in the iOS Keychain and only ever sends them to `anthropic.com` endpoints. Clear them anytime via the script's **clear stored data** menu option.

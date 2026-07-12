<img width="556" height="288" alt="usage" src="https://github.com/user-attachments/assets/878aed73-09df-42cc-9cce-264622a1f343" />  

# claude usage widget

An iPhone home screen widget for [Scriptable](https://scriptable.app) (free) that shows your Claude usage at a glance:

- **Session usage** — the rolling 5-hour window
- **Weekly usage** — the 7-day window (plus the weekly Opus window if your plan has one)
- **Time until reset** — a big live countdown ticking every second, centered beneath the session bar, and the reset day + time under the weekly bar
- **Color coding** — green → orange → red as you approach the limit
- **Notifications** — a warning when usage crosses 90%, and an alert when a heavily-used window resets

No app to open, no server to run: one JavaScript file inside Scriptable, refreshing in the background.

## How it works

The widget calls the same usage endpoint that powers Claude Code's `/usage` command (`api.anthropic.com/api/oauth/usage`). You log in **directly on the phone** using the same OAuth flow Claude Code uses — no computer needed. Access tokens expire after a few hours, but the stored **refresh token** lets the widget mint new ones automatically — so after a one-time login there is no manual token maintenance.

All credentials are stored in the iOS Keychain via Scriptable's `Keychain` API, never in the script file itself.

## Setup (~2 minutes)

**Prerequisite:** a Claude subscription (Pro/Max).

1. **Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)** from the App Store.
2. **Create the script.** In Scriptable, tap **+**, paste the contents of [`claude-usage.js`](claude-usage.js), and name it `claude-usage`.
3. **Log in.** Run the script (tap the play button) and choose **log in with claude**. A browser sheet opens: log in to your Claude account, approve access, tap **copy code** on the page that appears, then close the sheet. The script picks the code up from your clipboard — tap **continue** and you should see "logged in". Use **show usage** to confirm it works.
4. **Add the widget(s).** Long-press the home screen → **Edit** → **Add Widget** → search "Scriptable" → pick the small (or medium) size → tap the widget → set **Script** to `claude-usage`. In the same configuration screen, set **Parameter** to choose the view:
   - `session` — dedicated session widget: bar, huge live countdown, reset clock time
   - `week` — dedicated weekly widget: week (+ weekly Opus) bars with reset day + time
   - leave empty — combined view with everything on one widget

   For the roomiest setup, add two small widgets side by side: one with `session`, one with `week`.

That's it. The widget refreshes in the background (iOS controls the exact cadence, typically every 15–30 minutes).

### Alternative: paste credentials from a computer

If the in-app login doesn't work for you, the old path still exists: on a machine where Claude Code is logged in, copy the contents of the credentials file (`~/.claude/.credentials.json` on macOS/Linux, `%USERPROFILE%\.claude\.credentials.json` on Windows — for WSL: `wsl cat ~/.claude/.credentials.json | clip`), get it to your phone, copy it there, then choose **paste credentials** in the script menu. Delete the message you sent yourself afterwards; it's a credential. Note that logging in on the phone is not just easier but also more robust: the widget gets its own token pair, independent of the one your desktop Claude Code rotates.

## Configuration

Edit the `CONFIG` block at the top of the script:

| option | default | meaning |
|---|---|---|
| `warnAt` | `60` | % where bars turn orange |
| `dangerAt` | `85` | % where bars turn red |
| `notifyAt` | `90` | % that triggers a near-limit notification (once per window) |
| `resetNotifyAbove` | `75` | schedule a "limit reset" notification if usage was above this % |
| `refreshMinutes` | `5` | requested widget refresh interval |
| `tapAction` | `"refresh"` | what tapping the widget does: `"refresh"` shows a fresh usage readout, `"claude"` opens claude.ai |

## Reset times

The big `H:MM:SS` countdown centered beneath the session bar is a timer element that iOS renders and ticks itself — it's always second-exact, regardless of when the widget last refreshed, and it keeps working even when the percentages are showing cached data. If it passes zero before iOS redraws the widget, it counts *up* from the reset moment — a clear sign the bars are from the finished window.

The weekly windows reset days out, so they show a static day + time instead (e.g. `resets fri 16:45`).

## Tap to refresh

iOS decides when the widget image redraws (typically every 15–30 minutes), so the displayed percentages can lag — especially right after a limit resets. Tapping the widget works around this: it opens Scriptable, fetches your usage live, and shows a popup with current session/week percentages and exact reset times. The fetch also updates the cache, so the widget image itself catches up on its next scheduled redraw.

## Widget states

- **setup needed** — no credentials stored yet; run the script in the app and log in
- **re-auth needed** — the refresh token stopped working; run the script and log in again
- when the network is unreachable, the widget silently shows the last cached numbers — tap it for a live readout if in doubt

## Troubleshooting

- **"fetch failed: AUTH"** — your refresh token was rotated or revoked. Run the script and choose **log in with claude** again.
- **"token exchange returned http 4xx" during login** — authorization codes are single-use and expire within minutes. Start the login again and paste the fresh code right away.
- **Notifications don't appear** — allow notifications for Scriptable in iOS Settings, and note alerts only fire when the widget refreshes in the background.
- **Widget feels stale** — iOS throttles widget refreshes; tap the widget for live numbers, and re-adding the widget forces a redraw.

## Caveats

- The usage endpoint is **undocumented** and could change shape without notice; the widget fails soft (shows cached data) when it does.
- If you used the **paste credentials** path, Claude Code on your desktop refreshes the same credentials — if Anthropic ever invalidates old refresh tokens on rotation, the widget's copy may stop working and need a re-paste. The in-app login doesn't have this problem: the widget holds its own tokens.

## Security note

Your credentials grant access to your Claude account — treat the credentials file like a password. The script keeps them in the iOS Keychain and only ever sends them to `anthropic.com` endpoints. Clear them anytime via the script's **clear stored data** menu option.

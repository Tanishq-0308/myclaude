---
name: android
description: Drive Android emulators and USB devices with adb - start or stop emulators (with or without a window), take and view screenshots, tap buttons by their text or id, type, swipe, scroll, draw or write with a finger/pen stroke, launch apps, install APKs, read crash logs, and compare screens against Figma designs. Use whenever the user mentions an emulator, AVD, tablet, phone, adb, an Android app on a device, or wants something done on the device screen.
---

# Android devices and emulators

Everything goes through the helper script next to this file. It finds `adb` and `emulator`
in the Android SDK automatically.

```
node "<this skill's base directory>/scripts/android.mjs" <command> [args]
```

Run it with no arguments to see every command. With more than one device connected, add `-s <serial>`
(for example `-s emulator-5554`) right after the script path.

## Starting an emulator

1. `devices` – something may already be running. Reuse it if it is.
2. `avds` – the emulators the user has.
3. `start <avd>` – starts it in the background and waits until Android has fully booted.
   Add `--headless` when the user wants no emulator window (check the system prompt for the
   user's emulator window preference). A headless emulator still works normally; you see it via screenshots.

Never run the `emulator` binary in the foreground yourself – it never exits and would block you.

## The loop: look, act, look again

1. **Look**: `screenshot <name>` (e.g. `screenshot login-step2`), then open the printed PNG path with
   the Read tool to actually see it. A bare name is saved in `./screenshots/` and the folder is created
   for you - never run `mkdir` or chain other commands in front of the helper (`cd x && …`, `mkdir … &&`);
   run the helper on its own so it doesn't need approval.
2. **Find targets**: `ui` lists every labelled element with its centre coordinates, `find <text>` narrows it.
3. **Act**: prefer `tap <text|id|desc>` over raw coordinates. Use `tap <x> <y>` only for things
   with no label (canvas areas, custom views) and take the coordinates from a screenshot or `ui`.
4. **Look again** after every action that should change the screen. A command exiting 0 does
   not mean it worked – `input tap` succeeds even when it hits nothing.

Coordinates are in device pixels (see `size`). Screenshots are full device resolution, so a point
you see in the PNG at (x, y) is the same (x, y) for tap/draw.

## Typing, keys, gestures

- `type <text>` types into the focused field (tap the field first).
- `key back|home|enter|del|tab|menu|recent`
- `swipe x1 y1 x2 y2 [ms]`, `scroll up|down|left|right`, `longpress <text|x y> [ms]`

## Writing text by hand

**Never draw letters yourself point by point** - it is slow and looks bad. Use `write`, which renders
real single-stroke handwriting fonts and sends the whole text in one fast call:

```
write "Area of a circle: A = pi r^2" --font neat --size 90 --x 150 --y 200
```

- `--font`: `neat` (tidy handwriting, default), `print` (clean print), `cursive`, `elegant` (flowing script)
- `--size`: capital-letter height in pixels (60–120 suits a tablet). `--x/--y`: top-left of the text.
- `--width`: wrap width (default: to the right edge). Long text wraps onto new lines automatically.
  Use `\n` inside the text for your own line breaks.
- The output tells you the vertical span (`text spans y 341–711`) - use it to place the next block below.
- Pick the area first from a screenshot so you don't write over existing content or toolbars.
- One `write` call per block of text. A whole sentence takes a few seconds.

## Drawing

- `draw x,y x,y ... | x,y x,y ...` draws continuous strokes; `|` starts a new stroke. Put every stroke of
  a drawing in ONE call. Points are densified automatically, so a few corner points per stroke are enough.
- `draw-path "<SVG path>" --x X --y Y --scale S` - best for pictures: write the drawing as an SVG path
  (M/L/C/Q/H/V/Z; y grows downward) and draw it in one call.
- `draw-shape circle cx cy r` · `rect x1 y1 x2 y2` · `line x1 y1 x2 y2`.

How strokes are sent (automatic): Android ≤ 11 → raw touch stream; Android 12+ → a virtual touchscreen
via `uinput`; otherwise `input motionevent` (slow). Strokes are sent as a **pen (stylus)** by default,
which drawing apps never palm-reject. Add `--tool finger` to draw as a finger (strokes are then spaced
≥ 220 ms apart, because many whiteboard apps reject a touch that starts right after another one).

If strokes go missing: try `--tool finger` or `--tool pen` (whichever you didn't use), `--gap 300`
(longer pause between strokes) or `--slow 10`. If stroke beginnings are cut off, the app ignores the
first few pixels of a touch; the lead-in handles that automatically (`--leadin 0` turns it off).

- Select the app's pen/brush tool first (e.g. `tap Pen`), and check the result with a screenshot.
- Clean up test strokes with the app's Undo. Careful with erasers: many erase whole strokes they touch.

## Apps, installs and crashes

- `launch <package>`, `stop-app <package>`, `clear <package>` (wipes app data – ask first)
- `install <path.apk>`
- `current` shows which app/activity is in front.
- `logcat` shows recent errors; `logcat MyTag:D AndroidRuntime:E` for specific tags.
  Clear old logs first with `adb logcat -c` when reproducing a bug.
- When the app's source is in the working directory, trace a crash to the file and line.

## Comparing with Figma designs

When the user gives a Figma link or asks whether a screen matches the design:

1. Get the design: use the Figma MCP tools if they are available (get the node's screenshot,
   design context and variables). If they report "needs auth", tell the user to sign in once with
   `claude` → `/mcp` → figma → Authenticate, or to export the frame as PNG into the project.
2. Take a device screenshot of the same screen state.
3. View both images and compare what a user would notice: missing or extra elements, wrong text,
   colours, font sizes/weights, spacing and alignment, icon differences, states (disabled, selected).
4. Ignore sub-pixel and anti-aliasing differences, status bar content and device-specific insets.
5. Report each difference with where it is, what the design says, and what the device shows.
   Say when you're unsure instead of reporting a doubtful defect.

For implementing a design in code, use the `figma:figma-design-to-code` / `figma:figma-use` skills if present.

## Safety

- Never trigger real payments, delete accounts, or send messages to real people.
- `clear`, `pm uninstall`, factory resets and wiping data need the user's OK first.
- Don't leave test strokes or test data behind on the user's own app – undo or clean up.

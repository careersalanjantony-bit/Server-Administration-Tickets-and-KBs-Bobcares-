# Chamilo Quiz Autopilot (Firefox extension)

Fills in a Chamilo LMS quiz (`…/main/exercise/exercise_submit.php`) from **your own answer key**:

1. Reads the question on the page and finds the matching entry in your key. Questions and answer options can be in any (shuffled) order, and the wording can differ a bit.
2. Ticks the matching answer and highlights it (green = sure, amber = check this).
3. Clicks **Next question** after a short delay.
4. **Pauses** on any question it isn't sure about, so you can check or pick the answer and then press **Continue**.
5. On the last question it **never** clicks **End test** on its own. It shows a summary of every answer and waits for you to confirm.

## Install (Firefox)

**For a quick try (removed when Firefox restarts):**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `tools/chamilo-quiz-autopilot/manifest.json`.
3. Pin the **Quiz Autopilot** icon from the extensions (puzzle) menu.

**To keep it installed:** release Firefox only accepts signed add-ons. Either

- sign it yourself as an *unlisted* (private) add-on:
  `npx web-ext sign --channel=unlisted --source-dir tools/chamilo-quiz-autopilot --api-key=… --api-secret=…`
  (you get the API keys from addons.mozilla.org → Developer Hub → Manage API Keys), then open the `.xpi` it creates in Firefox, or
- use Firefox Developer Edition / Nightly, set `xpinstall.signatures.required` to `false` in `about:config`, zip the folder contents and install the zip from `about:addons` → ⚙ → *Install Add-on From File…*.

## Use

1. Click the toolbar icon and paste your answer key into the box. The count under the box shows how many questions were recognised. Use **Show parsed questions** to check them.
2. Click **Save key**.
3. Open the quiz, go to the first question, then click **Start autopilot** (in the popup or in the panel at the bottom-right of the page).
4. When it pauses, check the amber-highlighted answer (change it if needed) and click **Continue**.
5. At the end, review the summary and click **Yes, End test**, or **Not yet** to stop and review the answers yourself.

**Answer this page only** ticks the answer on the current question without clicking anything else. Use it to test your key before a full run.

## Answer-key formats

Paste any mix of these. Lines that don't match are ignored, for example the numbered "answers to memorize" block from a chat.

```text
| # | Question | Correct Answer |                 ← markdown table (the # column is optional)
|---|---|---|
| 1 | Which plan provides assistance with AnyDesk? | Dedicated Engineer Session or PLSM |

Which is not a billable task in PSM/SMM? | Server hack
Select correct statements about MySQL recovery => All of the above   (also ->, :: or a TAB)

Q: What to do when you get server add tickets?
A: All of the above

Which plan provides assistance with AnyDesk?                          ← a line ending in "?"
Dedicated Engineer Session or PLSM                                    ← answer on the next line
```

JSON also works: `[{"q": "…", "a": "…"}]`.

Tips:

- **`A OR B`** (capital OR) means either wording is acceptable. If both options appear on the page, the autopilot pauses and lets you choose.
- **`A + B + C`** or `A; B` lists several statements. On a single-answer question with an *All of the above* option it picks that option and asks you to check. On a multiple-answer (checkbox) question it ticks each matching option.
- Answers such as *All of the above*, *All listed steps* or *All of the statements are correct* all match the page's "All …" option.
- The same question can appear several times in the key. That's fine.

## How it decides it is "sure"

For every entry in the key it scores how well the key question matches the page question (word overlap, ignoring filler words and numbering) and how well the key answer matches each option. It auto-advances only when all of these hold:

- the question clearly matches
- one option clearly beats the others
- no other key entry points to a different option

Otherwise it pauses. The panel shows which key entry it used and the match scores.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V2, which Firefox fully supports). Runs only on `*/main/exercise/*` pages. |
| `matcher.js` | Answer-key parser and fuzzy matching. Pure functions, shared by the page script, the popup and the tests. |
| `content.js` | Reads the quiz page, ticks answers, clicks Next, shows the panel and the End-test confirmation. |
| `popup/` | Toolbar popup for pasting the key and starting or stopping. |
| `test/matcher.test.js` | Unit tests: `node --test tools/chamilo-quiz-autopilot/test/matcher.test.js` |

The answer key is stored only in the extension's local storage (`browser.storage.local`) and never leaves your browser.

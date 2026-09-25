# Chamilo Quiz Autopilot (Firefox extension)

Fills in a Chamilo LMS quiz (`…/main/exercise/exercise_submit.php`) from **your own answer key**:

1. Reads the question on the page and finds the matching entry in your key. Questions and answer options can be in any (shuffled) order, and the wording can differ a bit.
2. Answers it (radio buttons, checkboxes, matching drop-downs, or typed answers) and highlights what it chose (green = sure, amber = check this).
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

Paste the key the way you have it. Formats can be mixed. Intro text, headings (for example "Additional Questions You Shared Later") and number-only "answers to memorize" lists are ignored. The count under the box tells you how many questions were recognised. Exact duplicates are counted once.

```text
1. Which plan provides assistance with AnyDesk          ← numbered question ("Q:", "Q1." and "Question 1:" work too)
Answer: ✅ Dedicated Engineer Session or PLSM            ← "Answer:", "Ans:", "A:" or "Correct answer:"; ✅ and **bold** are ignored

4. Select correct usage to run a php script …
Answer: ✅                                               ← the answer can start on the next line…
* `user@server [~]# /usr/local/bin/php …/adhoc_task.php --failed`
* `root@server [~]# sudo -u user bash -c '/usr/local/bin/php …'`     ← …as a bullet list

14. Match following tasks in order of priority
Answer: ✅
1. Priority Chats                                       ← a numbered list inside an answer stays part of it
2. Priority Tickets

21. What is the correct two-step process to follow during migrations?
Answer: ✅ Perform migration without DNS change and test (customer to test using hosts file).
Do a final data resync (files & database), update DNS, and test again.   ← answers can run over several lines

### 36. What is the correct procedure after completing work on a customer’s Windows server?
**Answer:** Log out properly from the Windows server      ← questions as markdown headings, "---" between them
---

| # | Question | Correct Answer |                        ← markdown table (the # column is optional)
|---|---|---|
| 1 | Which plan provides assistance with AnyDesk? | Dedicated Engineer Session or PLSM |

Which is not a billable task in PSM/SMM? | Server hack           ← one line: "|", "=>", "->", "::" or a TAB
Which plan provides assistance with AnyDesk?                      ← a line ending in "?"
Dedicated Engineer Session or PLSM                                ← and its answer on the next line

1. Which command lists open ports?
a) netstat -r
b) ss -tulpn ✅                                          ← options with the right one marked ✅ or "(correct)"
```

JSON also works: `[{"q": "…", "a": "…"}]`.

Tips:

- On a **multiple-answer (checkbox)** question, every bullet/line of the answer ticks its matching option. So do `A OR B` and `A + B`. Wrong options that differ by only a word (for example `php` instead of `/usr/local/bin/php`) are left unticked.
- On a **single-answer** question:
  - **`A OR B`** means either is fine. If both appear as options, the autopilot pauses so you can choose.
  - An answer with **several statements** (bullets, `A + B`, `A; B`) picks the *All of the above* option. It pauses if the page has a statement your key doesn't mention.
- Answers such as *All of the above*, *All listed steps* or *All of the statements are correct* all match the page's "All …" option.
- A **numbered list** in the answer (for example the priority order) is used for matching / ordering questions with drop-downs. "1", "1st", "First" and "Priority 1" all count as position 1.

## Question types

| On the page | What the autopilot does |
|---|---|
| Single answer (radio buttons) | Ticks the matching option. |
| Multiple answers (checkboxes) | Ticks every option your key lists and unticks the rest. |
| Matching / ordering (drop-downs) | Picks each drop-down from the pairs or numbered list in your key. It also handles Chamilo's lettered "A. …" lists. |
| Typed answer (text box / fill in the blanks) | Types the answer from your key, then **always pauses** so you can check it before continuing. |

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

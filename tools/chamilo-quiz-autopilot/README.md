# Chamilo Quiz Autopilot (Firefox extension)

Fills in a Chamilo LMS quiz (`…/main/exercise/exercise_submit.php`) from **your own answer key**:

1. Reads the question on the page and finds the matching entry in your key. Questions and answer options can be in any (shuffled) order, and the wording can differ a bit.
2. Answers it (radio buttons, checkboxes, drag-and-drop ordering, matching drop-downs, or typed answers) and highlights what it chose (green = sure, amber = check this).
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

1. Click the toolbar icon and paste your questions and answers into **Add or update questions**. A paste is saved to your **question bank** straight away. The popup shows how many questions are saved.
2. Open the quiz, go to the first question, then click **Start autopilot** (in the popup or in the panel at the bottom-right of the page).
3. When it pauses, check the amber-highlighted answer (change it if needed) and click **Continue**.
4. At the end, review the summary and click **Yes, End test**, or **Not yet** to stop and review the answers yourself.

**Answer this page only** fills in the answer on the current question without clicking anything else. Use it to test before a full run.

## Question bank

Everything you paste is kept in the add-on's own storage, so you don't paste it again for every quiz.

- **Adding more later:** paste new questions and answers into the popup at any time. New questions are **added**. A question that is already saved gets its answer **updated** if the new answer differs. Everything else is left alone. The popup reports e.g. *"3 added, 1 updated, 30 already saved"* and has an **Undo** link.
- **Question bank page** (popup → **Open bank**, or `about:addons` → Quiz Autopilot → Preferences) lets you:
  - search and **edit** saved questions (to fix a wrong entry, edit its answer)
  - **add** a question by hand
  - **import** text or a backup file
  - **export a backup** (`.json`)
  - **undo the last change**
- There is **no delete button**, so a shared copy can't wipe questions from the cloud. **Undo last change** can still take back a paste you just made on the same computer.
- **Also save answers I pick myself** (popup checkbox, off by default): when the autopilot pauses and you choose the answer yourself, that question and your answer are saved too, so next time it is answered automatically. Only switch this on when you're sure of your picks.

### Keeping the saved questions when Firefox restarts

A **temporarily loaded** add-on (about:debugging) is removed when Firefox closes, and Firefox deletes its stored data with it. The popup and the question bank page warn you when that's the case. To keep your questions:

- **Turn on cloud sync** (below). The questions live on your Vercel server and come back automatically. Put the address and key in `config.js` so the add-on also reconnects on its own after a restart.
- Or **export a backup** before closing Firefox, then use **Import…** on the question bank page after loading the add-on again.
- Or **install the add-on permanently** (see *To keep it installed* above). A permanently installed add-on keeps its data across restarts.

## Password lock (optional)

With a password set, the popup and the question bank page show only a password box, and the autopilot does nothing on quiz pages until it is unlocked.

- Unlocking lasts until Firefox closes. **Lock** (in the popup and on the bank page) locks it again straight away.
- After 5 wrong tries it makes you wait 30 seconds, and longer after more wrong tries.

To set it, make a hash of your password and put it in `config.js`:

```sh
node tools/chamilo-quiz-autopilot/scripts/make-password.js "your password"
```

```js
passwordHash: 'pbkdf2-sha256$200000$…',   // the line the script printed
```

Only this salted hash is stored, never the password itself. Leave `passwordHash` empty for no lock.

This keeps casual users out. It is not strong protection: someone who unzips the add-on can edit its files and remove the lock. Also read the access key in `config.js` as a second password. If it's the same as the lock password, anyone who opens `config.js` can read it, so use a different one.

## Cloud sync with Vercel (same questions on every computer)

The `server/` folder is a small Vercel project that stores the question bank in **Upstash Redis** (Vercel's one-click Redis database, free plan). Once it's connected:

- Every question you add, edit or delete is uploaded straight away. If the server can't be reached, the change waits and is uploaded on the next sync.
- On every quiz question the add-on first downloads the latest questions (waiting at most 4 seconds), then answers from the full cloud bank. If the server is offline it answers from the last downloaded copy.
- A computer that has never seen your questions gets all of them the first time it connects. If that first download fails (e.g. a network blip), the quiz page says so and tries again every 5 seconds (up to 5 times) instead of stopping.
- If two computers change the same question, the newer answer wins.

### 1. Deploy the server (once)

1. Make sure this code is on GitHub (merge the pull request, or pick this branch when importing).
2. Go to [vercel.com/new](https://vercel.com/new), import this repository and set **Root Directory** to `tools/chamilo-quiz-autopilot/server` (framework preset *Other*, no build settings needed). Click **Deploy**.
3. In the new project open **Storage** → **Create Database** (or *Connect Store*) → **Upstash** → *Redis* → free plan → connect it to this project. Vercel adds the database settings (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) for you.
4. Open **Settings → Environment Variables** and add `BANK_TOKEN` with a long random password of your choice. This is the **access key** the add-on uses.
5. Open **Deployments** → ⋯ → **Redeploy** so the new settings take effect.
6. Open `https://<your-project>.vercel.app`. The status page should show green checks for the server, the access key and the database.

Using the command line instead: `cd tools/chamilo-quiz-autopilot/server && npx vercel`. Then add the Upstash store in the dashboard, run `npx vercel env add BANK_TOKEN`, and finish with `npx vercel --prod`.

### 2. Connect the add-on

Open the question bank (popup → **Open bank**) → **Cloud sync**. Enter the server address (`https://<your-project>.vercel.app`) and the access key, then click **Connect**. The questions already on that computer are uploaded, and everything in the cloud is downloaded. The popup then shows *"Cloud sync on, synced just now"* and has a **Sync now** button.

### 3. Other computers: connect automatically

Open `config.js` in your copy of the add-on and fill in:

```js
globalThis.QUIZ_AUTOPILOT_CONFIG = {
  serverUrl: 'https://your-project.vercel.app',
  accessKey: 'your BANK_TOKEN',
};
```

Any computer that loads that copy connects on its own and downloads all your questions, with nothing to paste. It also reconnects after every Firefox restart. Settings entered in the Cloud sync panel override `config.js`, and **Disconnect** turns sync off on that computer.

**Keep the access key private.** Anyone who has it can read and change your question bank. Don't commit a filled-in `config.js` to a public repository. To lock everyone out, change `BANK_TOKEN` in Vercel and redeploy.

## Answer-key formats

**Paste the full question, followed by its correct answer only** (not the other options). Formats can be mixed. Intro text, headings (for example "Additional Questions You Shared Later") and number-only "answers to memorize" lists are ignored. The count under the box tells you how many questions were recognised. Exact duplicates are counted once.

```text
Which plan provides assistance with AnyDesk             ← the full question
Dedicated Engineer Session or PLSM                      ← its correct answer only, on the next line
                                                        ← blank line between questions
Match following tasks in order of priority
1. Priority Chats                                       ← a list right below = a multi-part / ordering answer
2. Priority Tickets

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
- A **numbered list** in the answer (for example the priority order) is used for drag-and-drop ordering and for matching / ordering questions with drop-downs. "1", "1st", "First" and "Priority 1" all count as position 1.

## Question types

| On the page | What the autopilot does |
|---|---|
| Single answer (radio buttons) | Ticks the matching option. |
| Multiple answers (checkboxes) | Ticks every option your key lists and unticks the rest. |
| Drag-and-drop ordering (items dragged into numbered slots) | Drags each item into its slot, like a real mouse drag, so Chamilo records it. Items already in the right slot are left alone, and wrong ones are moved out first. It then checks the result and pauses if an item didn't land. |
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
| `bank.js` | The question bank: merging new questions and answers, backup export/import, undo, and tracking changes to upload. |
| `background.js` | Cloud sync: uploads local changes and downloads the cloud bank (Vercel server). |
| `config.js` | Optional built-in server address and access key (so a copy connects on its own) and password lock hash. |
| `lock.js` | The optional password lock. `scripts/make-password.js` makes the hash for `config.js`. |
| `server/` | The Vercel project: `api/questions` (the shared bank), `api/health` (setup check), and a status page. Tests: `cd server && npm test`. |
| `bank/` | The question bank page (search, edit, delete, add, import, export). |
| `content.js` | Reads the quiz page, ticks answers, clicks Next, shows the panel and the End-test confirmation. |
| `popup/` | Toolbar popup: add questions to the bank, start or stop, settings. |
| `test/` | Unit tests: `node --test tools/chamilo-quiz-autopilot/test/matcher.test.js tools/chamilo-quiz-autopilot/test/bank.test.js tools/chamilo-quiz-autopilot/test/lock.test.js` |

The question bank is stored in the extension's local storage (`browser.storage.local`). It only leaves your browser if you turn on cloud sync, which sends it to **your own** Vercel server and nowhere else, or if you export a backup file yourself.

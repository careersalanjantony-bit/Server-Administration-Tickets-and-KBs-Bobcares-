/*
 * Runs on S4 pages. Two jobs: read the shift form, and post to it.
 *
 * Posting goes through fetch() rather than submitting the form element. A real
 * submit reloads the page, which tears down this script halfway through a run;
 * a same-origin fetch sends the identical form-encoded body, keeps the session
 * cookie, and leaves the run intact.
 */
(function () {
  "use strict";

  function describeInput(el) {
    const type = (el.type || "text").toLowerCase();
    return {
      name: el.name,
      type,
      // Never carry a credential out of the page.
      value: type === "password" ? "" : el.value || "",
      // A radio or checkbox only counts if it is ticked; its value attribute is
      // there either way. Without this the last of seven radios won.
      checked: type === "radio" || type === "checkbox" ? !!el.checked : undefined,
      // A disabled control is not submitted, so it must not be echoed either.
      disabled: !!el.disabled,
    };
  }

  function describeSelect(el) {
    return {
      name: el.name,
      // What the browser would submit for it as rendered. A multi-select
      // sends several values, which a flat body cannot carry, so it is left
      // for the mapping to fill or not at all.
      selected: el.multiple || el.value === undefined ? undefined : el.value,
      disabled: !!el.disabled,
      options: Array.from(el.options).map((o) => ({
        value: o.value,
        text: (o.textContent || "").trim(),
      })),
    };
  }

  /**
   * Fields that belong to no form element.
   *
   * S4's month page carries an empty <form name="shift"> and renders the
   * controls elsewhere in the document, so walking document.forms alone finds
   * a form with nothing in it. This sweeps up everything named that a real
   * form did not already claim.
   */
  function looseFields(doc) {
    const claimed = new Set();
    Array.from(doc.forms).forEach((form) => {
      form.querySelectorAll("input, textarea, select").forEach((el) => claimed.add(el));
    });
    const inputs = [];
    const selects = [];
    doc.querySelectorAll("input[name], textarea[name]").forEach((el) => {
      if (!claimed.has(el)) inputs.push(describeInput(el));
    });
    doc.querySelectorAll("select[name]").forEach((el) => {
      if (!claimed.has(el)) selects.push(describeSelect(el));
    });
    if (!inputs.length && !selects.length) return null;
    const form = Array.from(doc.forms)[0];
    return {
      name: form ? form.getAttribute("name") || "" : "",
      action: form ? form.getAttribute("action") || "" : "",
      method: "POST",
      inputs,
      selects,
      loose: true,
    };
  }

  /** Read every form in a document: field names and dropdown options. */
  function probeDocument(doc) {
    const forms = Array.from(doc.forms).map((form) => ({
      name: form.getAttribute("name") || "",
      action: form.getAttribute("action") || "",
      method: (form.getAttribute("method") || "GET").toUpperCase(),
      inputs: Array.from(form.querySelectorAll("input, textarea"))
        .filter((el) => el.name)
        .map(describeInput),
      selects: Array.from(form.querySelectorAll("select"))
        .filter((el) => el.name)
        .map(describeSelect),
    }));
    const loose = looseFields(doc);
    if (loose) forms.push(loose);
    return forms;
  }

  function probeForms() {
    return probeDocument(document);
  }

  /**
   * Where the shift editor might live.
   *
   * S4's month grid holds an empty <form name="shift"> and opens the real
   * editor in a separate window, so the controls are simply not in the page
   * somebody is looking at. Rather than asking them to go and find it, pull
   * the candidate urls out of the grid's own markup and read those pages.
   */
  function candidateEditUrls(limit) {
    const found = new Map();
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const pattern = /["'`]([^"'`\s]*index\.php\?[^"'`\s]*)["'`]/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1].replace(/&amp;/g, "&");
      let url;
      try {
        url = new URL(raw, location.href);
      } catch (error) {
        continue;
      }
      if (url.hostname !== location.hostname) continue;
      const text = url.href.toLowerCase();
      // edit_co_shift is what the editor's own url carries; rank on that.
      let rank = 3;
      if (text.includes("edit_co_shift") || text.includes("edit_shift")) rank = 0;
      else if (text.includes("edit")) rank = 1;
      else if (text.includes("shift")) rank = 2;
      else continue;
      if (!found.has(url.href) || found.get(url.href) > rank) found.set(url.href, rank);
    }
    return [...found.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
      .slice(0, limit || 8)
      .map(([href]) => href);
  }

  /**
   * Calendar row ids sitting in the grid's markup.
   *
   * The editor's url ends "...action=chkshift&cal_id=" with the number added
   * by javascript, so scraping gives the bare prefix. Fetched with no id the
   * page still renders the form, but its Category and Shift Time dropdowns
   * come back empty — S4 fills those in against a real row. So the ids are
   * pulled out separately and pinned onto the prefix.
   */
  function calendarIds(limit) {
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const ids = new Set();
    const direct = /cal_id\s*=\s*['"]?(\d{2,})/gi;
    let match;
    while ((match = direct.exec(html)) !== null) ids.add(match[1]);
    // ...and numbers sitting next to a chkshift reference, which is how the
    // grid's onclick handlers pass them.
    const near = /chkshift[^\n]{0,120}?(\d{3,})/gi;
    while ((match = near.exec(html)) !== null) ids.add(match[1]);
    return [...ids].slice(0, limit || 4);
  }

  /**
   * Bits of the grid's markup around the editor references.
   *
   * The ids are assembled in javascript, so the url scraper only ever sees
   * "...cal_id=" with nothing after it. Rather than guess at the pattern,
   * hand back the surrounding markup and let a human read it.
   */
  function gridSamples(limit) {
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const samples = [];
    const needles = [/chkshift/gi, /cal_id/gi, /edit_co_shift/gi];
    needles.forEach((needle) => {
      let match;
      while ((match = needle.exec(html)) !== null && samples.length < (limit || 6)) {
        const from = Math.max(0, match.index - 160);
        samples.push(html.slice(from, match.index + 200).replace(/\s+/g, " ").trim());
        if (samples.length >= (limit || 6)) break;
      }
    });
    // De-duplicate near-identical neighbours.
    const seen = new Set();
    return samples.filter((text) => {
      const key = text.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Every cell in the month grid, as the arguments its popup() call carries.
   *
   * Read off the live page where possible: a fetched page never runs its
   * scripts, so any cells S4 draws in javascript only exist in the open tab.
   */
  function gridCells(doc, limit) {
    const html = doc.documentElement ? doc.documentElement.innerHTML : "";
    const signature = S4Mapping.popupSignature(html);
    const params =
      signature && signature.params.length ? signature.params : S4Mapping.KNOWN_POPUP_PARAMS;
    const cells = [];
    const calls = [];
    const max = limit || 4000;
    const readCalls = (code) => {
      const call = /(?:^|[^\w.])popup\s*\(/g;
      let match;
      while ((match = call.exec(code)) !== null && cells.length < max) {
        // Skip the definition itself: "function popup(cal_id, date, ...)".
        if (/function\s*$/.test(code.slice(Math.max(0, match.index - 12), match.index + 1))) continue;
        const args = S4Mapping.parseCallArgs(code.slice(match.index + match[0].length));
        if (!args || !args.length) continue;
        const cell = {};
        params.forEach((name, i) => {
          cell[name] = args[i] === undefined ? "" : args[i];
        });
        cells.push(cell);
        if (calls.length < 3) calls.push(code.slice(match.index, match.index + 260).trim());
      }
    };
    const elements = doc.querySelectorAll ? doc.querySelectorAll("[onclick], a[href]") : [];
    Array.from(elements).forEach((el) => {
      if (cells.length >= max) return;
      readCalls(`${el.getAttribute("onclick") || ""} ${el.getAttribute("href") || ""}`);
    });
    // Cells wired up some other way — ondblclick, a handler in a script
    // block — still carry the call in the markup somewhere.
    if (!cells.length && html) {
      readCalls(
        html
          .replace(/&quot;/g, '"')
          .replace(/&#0?39;|&apos;/g, "'")
          .replace(/&amp;/g, "&")
      );
    }
    return {
      signature: signature
        ? { params: signature.params, template: signature.template, source: signature.source }
        : null,
      cells,
      calls,
    };
  }

  /**
   * What a page is, in a line: its title, whether it is a login page, and the
   * start of its visible text. When every page reads as empty, this is what
   * tells an expired session from a changed layout.
   */
  function pageFacts(doc) {
    const password = doc.querySelectorAll
      ? Array.from(doc.querySelectorAll("input")).filter(
          (el) => (el.type || "").toLowerCase() === "password"
        ).length
      : 0;
    const body = doc.body ? doc.body.textContent || "" : "";
    return {
      title: (doc.title || "").trim().slice(0, 80),
      login: password > 0,
      // Visible text only — input values are not text, so nothing typed leaks.
      snippet: body.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  }

  /** Fetch another S4 page with the current session and read its forms. */
  async function probeUrl(url) {
    const response = await fetch(url, { credentials: "same-origin" });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Object.assign(
      {
        ok: response.status < 400,
        status: response.status,
        // Where S4 actually answered from. A redirect to the login page is the
        // usual way a session running out shows itself.
        finalUrl: response.url || url,
        redirected: !!response.redirected,
        forms: probeDocument(doc),
        grid: gridCells(doc),
      },
      pageFacts(doc)
    );
  }

  function postUrl(action) {
    if (!action) return location.origin + "/index.php?action=view_shift";
    return new URL(action, location.href).href;
  }

  // S4 answers with a rendered page, not a status code we can trust alone, so
  // the response is scanned for the words it uses when something went wrong.
  const FAILURE_WORDS = /\b(error|invalid|failed|not\s+allowed|denied|cannot|exception)\b/i;

  function judge(status, text) {
    if (status < 200 || status >= 400) {
      return { ok: false, detail: `HTTP ${status}` };
    }
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const hit = stripped.match(FAILURE_WORDS);
    if (hit) {
      const at = Math.max(0, stripped.toLowerCase().indexOf(hit[0].toLowerCase()) - 60);
      return { ok: false, detail: stripped.slice(at, at + 200) };
    }
    return { ok: true, detail: `HTTP ${status}, ${stripped.length} chars back` };
  }

  async function postOne(body, action) {
    const url = postUrl(action);
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams(body).toString(),
    });
    const text = await response.text();
    const verdict = judge(response.status, text);
    return { url, status: response.status, ...verdict };
  }

  browser.runtime.onMessage.addListener((message) => {
    switch (message && message.type) {
      case "ping":
        return Promise.resolve({ ok: true, url: location.href, title: document.title });
      case "probe":
        return Promise.resolve({
          ok: true,
          forms: probeForms(),
          candidates: candidateEditUrls(message.limit),
          calendarIds: calendarIds(message.idLimit),
          gridSamples: gridSamples(message.sampleLimit),
          grid: gridCells(document),
          page: pageFacts(document),
        });
      case "probeUrl":
        return probeUrl(message.url).catch((error) => ({
          ok: false,
          forms: [],
          detail: `${error.name}: ${error.message}`,
        }));
      case "post":
        return postOne(message.body, message.action).catch((error) => ({
          ok: false,
          detail: `${error.name}: ${error.message}`,
        }));
      default:
        return undefined;
    }
  });
})();

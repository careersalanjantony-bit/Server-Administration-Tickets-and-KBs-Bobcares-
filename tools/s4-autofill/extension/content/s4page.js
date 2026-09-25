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
    return {
      name: el.name,
      type: (el.type || "text").toLowerCase(),
      // Never carry a credential out of the page.
      value: (el.type || "").toLowerCase() === "password" ? "" : el.value || "",
    };
  }

  function describeSelect(el) {
    return {
      name: el.name,
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
  function looseFields() {
    const claimed = new Set();
    Array.from(document.forms).forEach((form) => {
      form.querySelectorAll("input, textarea, select").forEach((el) => claimed.add(el));
    });
    const inputs = [];
    const selects = [];
    document.querySelectorAll("input[name], textarea[name]").forEach((el) => {
      if (!claimed.has(el)) inputs.push(describeInput(el));
    });
    document.querySelectorAll("select[name]").forEach((el) => {
      if (!claimed.has(el)) selects.push(describeSelect(el));
    });
    if (!inputs.length && !selects.length) return null;
    const form = Array.from(document.forms)[0];
    return {
      name: form ? form.getAttribute("name") || "" : "",
      action: form ? form.getAttribute("action") || "" : "",
      method: "POST",
      inputs,
      selects,
      loose: true,
    };
  }

  /** Read every form on the page: field names and dropdown options. */
  function probeForms() {
    const forms = Array.from(document.forms).map((form) => ({
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
    const loose = looseFields();
    if (loose) forms.push(loose);
    return forms;
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
        return Promise.resolve({ ok: true, forms: probeForms() });
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

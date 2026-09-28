/**
 * popup.js - paste the audit report (or a prebuilt JSON array), parse it, and
 * store it against the audit currently open in the active tab.
 */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const $ = function (id) { return document.getElementById(id); };

  const AUDIT_URL_RE = /server-audit\/([^/]+)\/edit\/([^/?#]+)/;
  let lastParsed = null;

  function show(kind, text) {
    const box = $("msg");
    box.className = kind;
    box.textContent = text;
  }

  function activeAudit() {
    return Promise.resolve(
      api.tabs.query({ active: true, currentWindow: true })
    ).then(function (tabs) {
      const url = tabs && tabs[0] && tabs[0].url;
      const m = url && url.match(AUDIT_URL_RE);
      if (!m) {
        throw new Error(
          "Open the server-audit edit page in this tab first " +
          "(.../bob_Portal/server-audit/<client>/edit/<audit>), then reopen this popup."
        );
      }
      return { key: "audit:" + m[1] + ":" + m[2], tabId: tabs[0].id, url: url };
    });
  }

  function summarise(parsed) {
    const lines = [];
    lines.push(
      parsed.kind === "json"
        ? "Read " + parsed.items.length + " items from JSON."
        : "Parsed report: " + parsed.resolved + " of " + parsed.items.length +
          " checklist items resolved."
    );

    if (parsed.system && parsed.system.Hostname) {
      lines.push("Server: " + parsed.system.Hostname);
    }

    const flagged = parsed.items.filter(function (i) { return i.status === "inactive"; });
    if (flagged.length) {
      lines.push(
        "",
        "Flagged inactive (" + flagged.length + "): " +
          flagged.map(function (i) { return i.category; }).join(", ")
      );
    }

    if (parsed.unresolved && parsed.unresolved.length) {
      lines.push(
        "",
        "Left blank for manual entry (" + parsed.unresolved.length + "):"
      );
      parsed.unresolved.forEach(function (u) {
        lines.push("  - " + (u.section ? u.section + " / " : "") + u.category + " - " + u.reason);
      });
    }

    if (parsed.unmapped && parsed.unmapped.length) {
      lines.push(
        "",
        parsed.unmapped.length + " report lines matched no checklist item " +
          "(add them to lib/rules.js if they should map to one)."
      );
    }
    return lines.join("\n");
  }

  function parseInput() {
    const text = $("input").value;
    lastParsed = window.AuditParser.parseAny(text);
    return lastParsed;
  }

  /* ------------------------------------------------------------------ wire */

  $("preview").addEventListener("click", function () {
    try {
      const parsed = parseInput();
      show(parsed.unresolved.length ? "warn" : "ok", summarise(parsed));
    } catch (err) {
      show("err", err.message);
    }
  });

  $("start").addEventListener("click", function () {
    let parsed;
    try {
      parsed = parseInput();
    } catch (err) {
      return show("err", err.message);
    }

    activeAudit()
      .then(function (ctx) {
        const state = {
          items: parsed.items,
          cursor: 0,
          pending: null,
          unconfirmed: 0,
          paused: false,
          confirmMode: $("immediate").checked ? "immediate" : "confirmed",
          savedAt: new Date().toISOString(),
          server: (parsed.system && parsed.system.Hostname) || null
        };
        const patch = {};
        patch[ctx.key] = state;
        return Promise.resolve(api.storage.local.set(patch)).then(function () {
          return api.tabs.reload(ctx.tabId);
        });
      })
      .then(function () {
        show("ok", summarise(parsed) + "\n\nSaved. The page is reloading - item 1 will open filled in.");
      })
      .catch(function (err) {
        show("err", err.message);
      });
  });

  $("copy").addEventListener("click", function () {
    try {
      const parsed = lastParsed || parseInput();
      navigator.clipboard.writeText(JSON.stringify(parsed.items, null, 2)).then(
        function () { show("ok", "AUDIT_DATA JSON copied to the clipboard."); },
        function () { show("err", "Could not write to the clipboard."); }
      );
    } catch (err) {
      show("err", err.message);
    }
  });

  $("status").addEventListener("click", function () {
    activeAudit()
      .then(function (ctx) {
        return Promise.resolve(api.storage.local.get(ctx.key)).then(function (all) {
          const state = all && all[ctx.key];
          if (!state) return show("warn", "No data stored for this audit yet.");
          const done = Math.min(state.cursor || 0, state.items.length);
          show(
            "ok",
            "Audit " + ctx.key + "\n" +
              (state.server ? "Server: " + state.server + "\n" : "") +
              "Progress: item " + (done + 1) + " of " + state.items.length +
              (state.paused ? " (paused)" : "") + "\n" +
              "Saved: " + (state.savedAt || "unknown")
          );
        });
      })
      .catch(function (err) { show("err", err.message); });
  });

  $("reset").addEventListener("click", function () {
    activeAudit()
      .then(function (ctx) {
        return Promise.resolve(api.storage.local.get(ctx.key)).then(function (all) {
          const state = all && all[ctx.key];
          if (!state) return show("warn", "No data stored for this audit yet.");
          state.cursor = 0;
          state.pending = null;
          state.unconfirmed = 0;
          state.paused = false;
          const patch = {};
          patch[ctx.key] = state;
          return Promise.resolve(api.storage.local.set(patch)).then(function () {
            show("ok", "Progress reset to item 1. Reload the page to start again.");
          });
        });
      })
      .catch(function (err) { show("err", err.message); });
  });

  $("clear").addEventListener("click", function () {
    activeAudit()
      .then(function (ctx) {
        return Promise.resolve(api.storage.local.remove(ctx.key)).then(function () {
          show("ok", "Stored data for this audit removed.");
        });
      })
      .catch(function (err) { show("err", err.message); });
  });
})();

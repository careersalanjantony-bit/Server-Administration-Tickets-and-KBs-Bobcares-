/**
 * content.js - runs on every load of a Bob_Portal server-audit edit page.
 *
 * Why an extension and not a console snippet: submitting an audit item is a
 * classic POST/redirect/GET, so the page fully reloads after every Submit and
 * takes all page JavaScript state with it. Progress therefore lives in
 * browser.storage.local, keyed per audit, and this script re-runs from scratch
 * on each load and picks up where it left off.
 *
 * It fills fields. It never clicks Submit - there is no code path in this file
 * that activates a submit control. The human reviews every item and submits it.
 */
(function () {
  "use strict";

  const LOG = "[audit-autofill]";
  const BANNER_ID = "bobcares-audit-autofill-banner";
  const FILL_TIMEOUT_MS = 3000;

  const api = typeof browser !== "undefined" ? browser : chrome;
  if (!api || !api.storage) return;

  /* ------------------------------------------------------------ storage key */

  /**
   * One progress record per audit, so working through server A does not
   * clobber progress on server B.
   * URL: /bob_Portal/server-audit/<clientId>/edit/<auditId>
   */
  function storageKey() {
    const m = location.pathname.match(/server-audit\/([^/]+)\/edit\/([^/?#]+)/);
    if (!m) return null;
    return "audit:" + m[1] + ":" + m[2];
  }

  function getState(key) {
    return Promise.resolve(api.storage.local.get(key)).then(function (all) {
      return (all && all[key]) || null;
    });
  }

  function setState(key, state) {
    const patch = {};
    patch[key] = state;
    return Promise.resolve(api.storage.local.set(patch));
  }

  /* ---------------------------------------------------------------- helpers */

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[*:.]+$/, "")
      .trim();
  }

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.offsetParent !== null || style.position === "fixed";
  }

  function fire(el, types) {
    types.forEach(function (t) {
      el.dispatchEvent(new Event(t, { bubbles: true }));
    });
  }

  /** Poll for a condition instead of guessing a fixed delay. */
  function waitFor(test, timeoutMs) {
    return new Promise(function (resolve) {
      const started = Date.now();
      (function tick() {
        let result = null;
        try {
          result = test();
        } catch (e) {
          result = null;
        }
        if (result) return resolve(result);
        if (Date.now() - started > (timeoutMs || FILL_TIMEOUT_MS)) return resolve(null);
        setTimeout(tick, 80);
      })();
    });
  }

  /* ----------------------------------------------------------- modal lookup */

  function modalTitle(modalEl) {
    const candidates = [
      ".card-title",
      ".modal-title",
      ".modal-header h4",
      ".modal-header h5",
      ".modal-header"
    ];
    for (let i = 0; i < candidates.length; i++) {
      const el = modalEl.querySelector(candidates[i]);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  }

  function allModals() {
    return Array.prototype.slice.call(
      document.querySelectorAll('div[id^="subcategory_"]')
    );
  }

  /**
   * Resolve a checklist item to its modal element.
   * Several items share a title ("Control Panel" and "Operating System" appear
   * under both Software Updates and Software Life Time), so `occurrence`
   * picks between same-titled modals in DOM order. An explicit `modalId` in
   * the data always wins.
   */
  function findModal(item) {
    const modals = allModals();

    if (item.modalId) {
      const byId = document.getElementById(item.modalId);
      if (byId) return { el: byId, ambiguous: false, matchedOn: "modalId" };
    }

    const aliases = (item.titleAliases && item.titleAliases.length
      ? item.titleAliases
      : [item.category]
    ).map(norm);

    const matches = modals.filter(function (m) {
      return aliases.indexOf(norm(modalTitle(m))) !== -1;
    });

    if (!matches.length) return null;

    const idx = Math.min(item.occurrence || 0, matches.length - 1);
    return {
      el: matches[idx],
      ambiguous: matches.length > 1,
      total: matches.length,
      matchedOn: "title"
    };
  }

  function openModal(modalEl) {
    const $ = window.jQuery || window.$;
    if ($ && typeof $(modalEl).modal === "function") {
      $(modalEl).modal("show");
      return;
    }
    // Fallback if jQuery/Bootstrap is not reachable from this context.
    modalEl.classList.add("show");
    modalEl.style.display = "block";
    modalEl.removeAttribute("aria-hidden");
  }

  /* ------------------------------------------------------------- field fill */

  function setRadio(scope, namePrefix, value) {
    const radios = scope.querySelectorAll(
      'input[type="radio"][name^="' + namePrefix + '"]'
    );
    for (let i = 0; i < radios.length; i++) {
      if (radios[i].value === String(value)) {
        radios[i].checked = true;
        radios[i].click(); // let the site's own handlers run (reveals the recommendation block)
        fire(radios[i], ["input", "change"]);
        return true;
      }
    }
    return false;
  }

  function setValue(el, value) {
    if (!el) return false;
    el.value = value == null ? "" : String(value);
    fire(el, ["input", "change", "keyup"]);
    return true;
  }

  /** IDs are duplicated across modals in this app, so always scope by modal. */
  function findComment(modalEl) {
    return (
      modalEl.querySelector('textarea[name="comment"]') ||
      modalEl.querySelector('textarea[id^="comment"]') ||
      modalEl.querySelector("textarea")
    );
  }

  /**
   * Find a field inside the recommendation block by its visible label, with a
   * name/id fallback. Labels are more stable here than the generated names.
   */
  function fieldByLabel(scope, wanted, nameHints) {
    const target = norm(wanted);

    const labels = scope.querySelectorAll("label");
    for (let i = 0; i < labels.length; i++) {
      const text = norm(labels[i].textContent);
      if (text.indexOf(target) !== 0) continue;

      const forId = labels[i].getAttribute("for");
      if (forId) {
        const byFor = scope.querySelector("#" + CSS.escape(forId));
        if (byFor) return byFor;
      }
      const nested = labels[i].querySelector("input, textarea, select");
      if (nested) return nested;

      let sib = labels[i].nextElementSibling;
      while (sib) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(sib.tagName)) return sib;
        const inner = sib.querySelector && sib.querySelector("input, textarea, select");
        if (inner) return inner;
        sib = sib.nextElementSibling;
      }
    }

    const fields = scope.querySelectorAll("input, textarea, select");
    for (let j = 0; j < fields.length; j++) {
      const key = norm(
        (fields[j].name || "") + " " + (fields[j].id || "") + " " +
        (fields[j].getAttribute("placeholder") || "")
      );
      for (let k = 0; k < nameHints.length; k++) {
        if (key.indexOf(nameHints[k]) !== -1) return fields[j];
      }
    }
    return null;
  }

  function fillRecommendation(modalEl, rec) {
    return waitFor(function () {
      const divs = modalEl.querySelectorAll('[id^="recommendation-div-"]');
      for (let i = 0; i < divs.length; i++) {
        if (visible(divs[i])) return divs[i];
      }
      return null;
    }, FILL_TIMEOUT_MS).then(function (recDiv) {
      const scope = recDiv || modalEl;
      const warnings = [];

      const issueEl = fieldByLabel(scope, "issue", ["issue", "problem"]);
      if (!setValue(issueEl, rec.issue)) warnings.push("issue field not found");

      const recEl = fieldByLabel(scope, "recommendation", ["recommend", "solution"]);
      if (!setValue(recEl, rec.recommendation)) warnings.push("recommendation field not found");

      const hoursEl =
        scope.querySelector('input[name^="service-hours"]') ||
        fieldByLabel(scope, "service hour", ["service-hour", "servicehour", "hours"]);
      if (!setValue(hoursEl, rec.hours == null ? "" : rec.hours)) {
        warnings.push("service hours field not found");
      }

      if (!recDiv) warnings.push("recommendation block never became visible");
      return warnings;
    });
  }

  function fillItem(modalEl, item) {
    const warnings = [];

    if (!setRadio(modalEl, "sub_category-value", item.status === "active" ? "1" : "-1")) {
      warnings.push("status radio not found");
    }

    const comment = findComment(modalEl);
    if (!setValue(comment, item.details || "")) warnings.push("details textarea not found");

    if (!setRadio(modalEl, "recommendation-status", item.recommendation ? "1" : "-1")) {
      warnings.push("recommendation radio not found");
    }

    if (!item.recommendation) return Promise.resolve(warnings);
    return fillRecommendation(modalEl, item.recommendation).then(function (more) {
      return warnings.concat(more);
    });
  }

  /* ----------------------------------------------------------- save confirm */

  /**
   * After a successful Submit the app reloads the page with a success flash.
   * That is how we know the pending item really saved, rather than assuming it
   * did the moment we filled the form (which would silently skip an item the
   * user cancelled).
   */
  function sawSaveConfirmation() {
    const nodes = document.querySelectorAll(
      '.alert, .alert-success, .toast, .swal-text, [class*="success"]'
    );
    for (let i = 0; i < nodes.length; i++) {
      const text = norm(nodes[i].textContent);
      if (!text || text.length > 200) continue;
      if (/success|added successfully|updated successfully|saved/.test(text)) return true;
    }
    return false;
  }

  /* ----------------------------------------------------------------- banner */

  function styleEl(el, styles) {
    Object.keys(styles).forEach(function (k) {
      el.style[k] = styles[k];
    });
    return el;
  }

  function button(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title || label;
    styleEl(b, {
      font: "500 11px/1.4 system-ui, sans-serif",
      padding: "3px 7px",
      marginRight: "4px",
      border: "1px solid rgba(255,255,255,.45)",
      borderRadius: "4px",
      background: "rgba(255,255,255,.14)",
      color: "#fff",
      cursor: "pointer"
    });
    b.addEventListener("click", onClick);
    return b;
  }

  function renderBanner(opts) {
    const old = document.getElementById(BANNER_ID);
    if (old) old.remove();

    const box = document.createElement("div");
    box.id = BANNER_ID;
    styleEl(box, {
      position: "fixed",
      top: "12px",
      right: "12px",
      zIndex: "2147483647",
      maxWidth: "330px",
      padding: "10px 12px",
      borderRadius: "6px",
      background: opts.tone === "warn" ? "#8a5a00" : opts.tone === "done" ? "#14632b" : "#123a63",
      color: "#fff",
      font: "13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif",
      boxShadow: "0 4px 14px rgba(0,0,0,.32)"
    });

    const head = document.createElement("div");
    styleEl(head, { fontWeight: "600", marginBottom: "3px" });
    head.textContent = opts.title;
    box.appendChild(head);

    if (opts.body) {
      const body = document.createElement("div");
      styleEl(body, { opacity: ".92", marginBottom: "6px", wordBreak: "break-word" });
      body.textContent = opts.body;
      box.appendChild(body);
    }

    if (opts.warnings && opts.warnings.length) {
      const warn = document.createElement("div");
      styleEl(warn, {
        marginBottom: "6px",
        padding: "5px 6px",
        borderRadius: "4px",
        background: "rgba(0,0,0,.28)",
        font: "11px/1.4 system-ui, sans-serif"
      });
      warn.textContent = "Check manually: " + opts.warnings.join("; ");
      box.appendChild(warn);
    }

    const bar = document.createElement("div");
    styleEl(bar, { marginTop: "4px" });
    (opts.buttons || []).forEach(function (b) {
      bar.appendChild(button(b.label, b.title, b.onClick));
    });
    box.appendChild(bar);

    document.body.appendChild(box);
    return box;
  }

  /* ------------------------------------------------------------------- main */

  function nextFillableIndex(items, from) {
    for (let i = from; i < items.length; i++) {
      if (items[i] && items[i].status) return i;
    }
    return -1;
  }

  function run() {
    const key = storageKey();
    if (!key) return;

    getState(key).then(function (state) {
      if (!state || !state.items || !state.items.length) return;

      const items = state.items;
      const skipped = items.filter(function (i) { return !i || !i.status; });

      // Step 1: did the item we filled last time actually save?
      if (state.pending != null) {
        const confirmed = state.confirmMode === "immediate" || sawSaveConfirmation();
        if (confirmed) {
          state.cursor = state.pending + 1;
          state.pending = null;
          state.unconfirmed = 0;
        } else {
          state.unconfirmed = (state.unconfirmed || 0) + 1;
        }
      }

      if (state.paused) {
        renderBanner({
          title: "Audit autofill - paused",
          body: "Progress kept at item " + (state.cursor + 1) + " of " + items.length + ".",
          buttons: [
            {
              label: "Resume",
              onClick: function () {
                state.paused = false;
                setState(key, state).then(function () { location.reload(); });
              }
            }
          ]
        });
        return;
      }

      const idx = nextFillableIndex(items, state.cursor || 0);

      if (idx === -1) {
        state.cursor = items.length;
        state.pending = null;
        setState(key, state);
        renderBanner({
          title: "Audit autofill - all items done",
          tone: "done",
          body:
            items.length - skipped.length + " of " + items.length + " items filled." +
            (skipped.length
              ? " " + skipped.length + " had no status in the report and were left for you: " +
                skipped.map(function (s) { return s.category; }).join(", ")
              : ""),
          buttons: [
            {
              label: "Start over",
              onClick: function () {
                state.cursor = 0;
                state.pending = null;
                setState(key, state).then(function () { location.reload(); });
              }
            },
            { label: "Dismiss", onClick: function () { document.getElementById(BANNER_ID).remove(); } }
          ]
        });
        return;
      }

      const item = items[idx];
      const found = findModal(item);

      if (!found) {
        // Do not stall the whole run on one missing item.
        state.cursor = idx + 1;
        state.pending = null;
        setState(key, state);
        renderBanner({
          title: "Audit autofill - item skipped",
          tone: "warn",
          body:
            'No modal on this page is titled "' + item.category + '" (' + item.section +
            "). Fill that one by hand. Reload to continue with the next item.",
          buttons: [
            { label: "Continue", onClick: function () { location.reload(); } }
          ]
        });
        return;
      }

      openModal(found.el);

      waitFor(function () { return visible(found.el) ? found.el : null; }, FILL_TIMEOUT_MS)
        .then(function () { return fillItem(found.el, item); })
        .then(function (warnings) {
          if (found.ambiguous) {
            warnings = warnings.concat([
              found.total + ' modals are titled "' + item.category +
              '"; used #' + ((item.occurrence || 0) + 1) + " (" + found.el.id + ")"
            ]);
          }
          if (state.unconfirmed >= 2) {
            warnings = warnings.concat([
              "last save was not detected - if you did submit it, use 'Mark done' to advance"
            ]);
          }

          state.pending = idx;
          state.cursor = idx;
          setState(key, state);

          const advance = function (to) {
            state.cursor = to;
            state.pending = null;
            state.unconfirmed = 0;
            setState(key, state).then(function () { location.reload(); });
          };

          renderBanner({
            title: "Item " + (idx + 1) + " of " + items.length + " - " + item.category,
            tone: warnings.length ? "warn" : "info",
            body:
              item.section + " | status: " +
              (item.status === "active" ? "Active" : "Inactive") +
              (item.recommendation ? " | recommendation filled" : "") +
              ". Review it, then click Submit yourself.",
            warnings: warnings,
            buttons: [
              { label: "Back", title: "Redo the previous item", onClick: function () { advance(Math.max(0, idx - 1)); } },
              { label: "Skip", title: "Leave this item alone and move on", onClick: function () { advance(idx + 1); } },
              { label: "Mark done", title: "Treat this item as submitted and move on", onClick: function () { advance(idx + 1); } },
              {
                label: "Pause",
                title: "Stop autofilling until resumed",
                onClick: function () {
                  state.paused = true;
                  state.pending = null;
                  setState(key, state).then(function () {
                    document.getElementById(BANNER_ID).remove();
                  });
                }
              }
            ]
          });
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();

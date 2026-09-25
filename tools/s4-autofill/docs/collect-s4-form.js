/*
 * Collect S4's form field names without giving anything else access to S4.
 *
 * 1. Log in to S4 and open the shift edit page, e.g.
 *      https://s4.inhouse.net/index.php?action=view_shift&sdate=2026-11-01&edate=2026-11-30&t=6&edit_co_shift=N
 * 2. Open the browser console (F12, then "Console").
 * 3. Paste this whole file in and press Enter.
 * 4. It copies a JSON block to your clipboard (and prints it). Save it as
 *    s4-form-dump.json and run:
 *      python3 -m s4autofill inspect --from-json s4-form-dump.json --save
 *
 * It reads field NAMES and dropdown OPTIONS only. It sends nothing anywhere,
 * and it deliberately skips the value of any password field.
 */
(() => {
  const dump = [...document.forms].map((form) => ({
    name: form.getAttribute("name") || "",
    action: form.getAttribute("action") || "",
    method: (form.getAttribute("method") || "GET").toUpperCase(),
    inputs: [...form.querySelectorAll("input, textarea")]
      .filter((el) => el.name)
      .map((el) => ({
        name: el.name,
        type: (el.type || "text").toLowerCase(),
        // Never carry a credential out of the page.
        value: (el.type || "").toLowerCase() === "password" ? "" : (el.value || ""),
      })),
    selects: [...form.querySelectorAll("select")]
      .filter((el) => el.name)
      .map((el) => ({
        name: el.name,
        options: [...el.options].map((o) => ({
          value: o.value,
          text: (o.textContent || "").trim(),
        })),
      })),
  }));

  const json = JSON.stringify(dump, null, 2);
  console.log(json);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(json)
      .then(() => console.log("%c✓ copied to clipboard", "color:green;font-weight:bold"))
      .catch(() => console.log("clipboard blocked — copy the JSON printed above by hand"));
  }
  return `${dump.length} form(s) found`;
})();

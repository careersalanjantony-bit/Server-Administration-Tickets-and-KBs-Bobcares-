#!/usr/bin/env node
/**
 * Self-contained tests for the report parser. No framework:
 *   node tests/parser.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const parser = require(path.join(__dirname, "..", "extension", "lib", "parser.js"));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(name + ": " + err.message);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(
      (what || "value") + " = " + JSON.stringify(actual) +
      ", expected " + JSON.stringify(expected)
    );
  }
}

function truthy(value, what) {
  if (!value) throw new Error((what || "value") + " is falsy");
}

const SAMPLE = fs.readFileSync(
  path.join(__dirname, "..", "samples", "report-detailed.log"),
  "utf8"
);
const out = parser.buildAuditData(SAMPLE);

function item(section, category) {
  const hit = out.items.filter(function (i) {
    return i.section === section && i.category === category;
  })[0];
  if (!hit) throw new Error("no item " + section + " / " + category);
  return hit;
}

/* ------------------------------------------------------------- verdicts */

check("leading verdict word with dash separator", function () {
  const v = parser.readVerdict("Good - Active: iptables nftables");
  eq(v.status, "active", "status");
  eq(v.detail, "Active: iptables nftables", "detail");
});

check("warning maps to inactive", function () {
  eq(parser.readVerdict("Warning - Rules Engine is unknown").status, "inactive");
});

check("verdict inside a trailing parenthesis", function () {
  const v = parser.readVerdict("cloudlinux 8.10 (Supported)");
  eq(v.status, "active", "status");
  eq(v.detail, "cloudlinux 8.10", "detail");
});

check("multi-word verdict beats its prefix", function () {
  eq(parser.readVerdict("Update Available (Tier: release)").status, "inactive");
});

check("longest phrase wins over a short one", function () {
  eq(parser.readVerdict("Not configured").status, "inactive");
  eq(parser.readVerdict("No issues found").status, "active");
});

check("a verdict word must not match a longer word", function () {
  // "no" must not swallow "nominal"; unknown words stay unresolved.
  eq(parser.readVerdict("nominal throughput"), null);
});

check("plain facts have no verdict", function () {
  eq(parser.readVerdict("dnf"), null);
  eq(parser.readVerdict("/usr/bin/rkhunter"), null);
});

check("ANSI colour codes are stripped", function () {
  const coloured =
    "=== 1. Threat Protection ===\n" +
    "System Firewall : [32mGood[0m - Active: firewalld\n";
  const built = parser.buildAuditData(coloured);
  const fw = built.items.filter(function (i) {
    return i.category === "System Firewall";
  })[0];
  eq(fw.status, "active", "status");
  eq(fw.details, "Active: firewalld", "details");
});

/* --------------------------------------------------------------- parsing */

check("values keep their own colons", function () {
  const report = parser.parseReport("Web Server Uptime     : Running (01:50:03)\n");
  eq(report.entries[0].label, "Web Server Uptime", "label");
  eq(report.entries[0].value, "Running (01:50:03)", "value");
});

check("section headers are recognised and denumbered", function () {
  const names = out.items.length && parser.parseReport(SAMPLE).sections
    .map(function (s) { return s.name; });
  truthy(names.indexOf("Threat Protection") !== -1, "Threat Protection section");
  truthy(names.indexOf("Software Updates") !== -1, "Software Updates section");
});

/* ------------------------------------------------------- checklist mapping */

check("every checklist item is emitted", function () {
  let expected = 0;
  parser.rules.sections.forEach(function (s) { expected += s.items.length; });
  eq(out.items.length, expected, "item count");
  eq(expected, 38, "checklist size");
});

check("good firewall line maps to active with no recommendation", function () {
  const fw = item("Threat Protection", "System Firewall");
  eq(fw.status, "active", "status");
  eq(fw.recommendation, null, "recommendation");
  truthy(fw.details.indexOf("iptables") !== -1, "details mention iptables");
});

check("warning line maps to inactive and attaches a recommendation", function () {
  const waf = item("Threat Protection", "Web App Firewall");
  eq(waf.status, "inactive", "status");
  truthy(waf.recommendation, "recommendation present");
  truthy(waf.recommendation.hours > 0, "service hours set");
});

check("zero pending updates counts as active", function () {
  eq(item("Software Updates", "PHP").status, "active");
  eq(item("Software Updates", "Web Server").status, "active");
});

check("section-scoped lookup picks the right duplicate label", function () {
  // "Control Panel" appears in System Information (a version string) and in
  // Software Updates (the verdict). The checklist item needs the verdict.
  const cp = item("Software Updates", "Control Panel");
  eq(cp.source, "Control panel", "source label");
  eq(cp.status, "inactive", "status");
  truthy(cp.details.indexOf("11.138.0.6") !== -1, "details mention the newer version");
});

check("inverted source flips the verdict", function () {
  // "Reboot required: Yes" is a problem, not a pass.
  const reboot = item("Proactive Defence", "Reboot Procedure");
  eq(reboot.status, "inactive", "status");
  truthy(reboot.recommendation, "recommendation present");
});

check("presence interpreter handles a bare value", function () {
  eq(item("Proactive Defence", "IP RDNS").status, "active");
});

check("high email queue is flagged", function () {
  const q = item("Server Health", "Email Queue");
  eq(q.status, "inactive", "status");
  truthy(q.details.indexOf("138") !== -1, "details keep the queue size");
});

check("extras are appended to the details", function () {
  const scanner = item("Threat Protection", "Malware Scanner");
  truthy(scanner.details.indexOf("ClamAV: Present") !== -1, "ClamAV extra");
  truthy(scanner.details.indexOf("Cron job: Present") !== -1, "cron extra");
});

check("missing sections are reported, never guessed", function () {
  // The sample has no Backup section, so those items must stay blank.
  const local = item("Backup", "Local");
  eq(local.status, null, "status");
  eq(local.unresolved, true, "unresolved flag");
  truthy(
    out.unresolved.some(function (u) { return u.category === "Local"; }),
    "listed in unresolved"
  );
});

check("unmapped report lines are surfaced", function () {
  truthy(out.unmapped.length > 0, "unmapped list populated");
  truthy(
    out.unmapped.some(function (u) { return u.label === "Kernel environment"; }),
    "Kernel environment reported as unmapped"
  );
});

check("system facts are extracted", function () {
  eq(out.system.Hostname, "whm1.example-host.tld");
});

/* --------------------------------------------------------------- parseAny */

check("parseAny accepts raw report text", function () {
  const parsed = parser.parseAny(SAMPLE);
  eq(parsed.kind, "report", "kind");
  truthy(parsed.resolved > 0, "resolved something");
});

check("parseAny accepts a prebuilt JSON array", function () {
  const parsed = parser.parseAny(JSON.stringify(out.items));
  eq(parsed.kind, "json", "kind");
  eq(parsed.items.length, out.items.length, "item count");
});

check("parseAny rejects empty input", function () {
  let threw = false;
  try { parser.parseAny("   "); } catch (e) { threw = true; }
  truthy(threw, "threw on empty input");
});

check("parseAny rejects text that is not an audit report", function () {
  let threw = false;
  try { parser.parseAny("hello world\nnothing to see here\n"); } catch (e) { threw = true; }
  truthy(threw, "threw on unrelated text");
});

/* ----------------------------------------------------------------- report */

if (failures.length) {
  process.stderr.write("\n" + failures.length + " test(s) failed:\n");
  failures.forEach(function (f) { process.stderr.write("  FAIL  " + f + "\n"); });
  process.stderr.write("\n" + passed + " passed, " + failures.length + " failed\n");
  process.exit(1);
}
process.stdout.write(passed + " tests passed\n");

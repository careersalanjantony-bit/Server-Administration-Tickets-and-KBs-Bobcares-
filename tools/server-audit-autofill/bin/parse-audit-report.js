#!/usr/bin/env node
/**
 * parse-audit-report.js - CLI wrapper around the same parser the extension
 * popup uses, for when you would rather pipe the report straight off the
 * server than paste it into the popup.
 *
 *   node bin/parse-audit-report.js samples/report-detailed.log
 *   ssh root@server 'bash cpanel-audit.sh' | node bin/parse-audit-report.js
 *   node bin/parse-audit-report.js report.log --summary
 *   node bin/parse-audit-report.js report.log --unmapped
 *   node bin/parse-audit-report.js report.log --strict > audit-data.json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const parser = require(path.join(__dirname, "..", "extension", "lib", "parser.js"));

function parseArgs(argv) {
  const opts = { file: null, summary: false, unmapped: false, strict: false, compact: false };
  argv.forEach(function (arg) {
    if (arg === "--summary") opts.summary = true;
    else if (arg === "--unmapped") opts.unmapped = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--compact") opts.compact = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg.charAt(0) !== "-") opts.file = arg;
    else {
      process.stderr.write("Unknown option: " + arg + "\n");
      process.exit(2);
    }
  });
  return opts;
}

function usage() {
  process.stdout.write(
    [
      "Usage: parse-audit-report.js [report-file] [options]",
      "",
      "Reads cpanel-audit.sh output (or stdin) and writes the AUDIT_DATA JSON",
      "array to stdout, ready to paste into the extension popup.",
      "",
      "  --summary    human-readable breakdown on stderr instead of JSON",
      "  --unmapped   list report lines no checklist item consumed",
      "  --strict     exit 1 if any checklist item could not be resolved",
      "  --compact    single-line JSON instead of indented",
      ""
    ].join("\n")
  );
}

function readInput(file) {
  if (file) return fs.readFileSync(file, "utf8");
  if (process.stdin.isTTY) {
    process.stderr.write("No input file and nothing on stdin. Use --help.\n");
    process.exit(2);
  }
  return fs.readFileSync(0, "utf8");
}

function printSummary(out) {
  const err = process.stderr;
  err.write("Resolved " + out.resolved + " of " + out.items.length + " checklist items.\n");
  if (out.system && Object.keys(out.system).length) {
    err.write("\nServer:\n");
    Object.keys(out.system).forEach(function (k) {
      err.write("  " + k + ": " + out.system[k] + "\n");
    });
  }

  let section = null;
  err.write("\nChecklist:\n");
  out.items.forEach(function (item) {
    if (item.section !== section) {
      section = item.section;
      err.write("\n  " + section + "\n");
    }
    const status = item.unresolved
      ? "MANUAL  "
      : item.status === "active"
        ? "active  "
        : "INACTIVE";
    err.write(
      "    " + status + "  " + item.category +
      (item.recommendation ? "  [+recommendation]" : "") + "\n"
    );
  });

  if (out.unresolved.length) {
    err.write("\nLeft for manual entry (" + out.unresolved.length + "):\n");
    out.unresolved.forEach(function (u) {
      err.write("  - " + u.section + " / " + u.category + ": " + u.reason + "\n");
    });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const text = readInput(opts.file);
  const out = parser.buildAuditData(text);

  if (opts.unmapped) {
    process.stderr.write(
      "Report lines not consumed by any checklist item (" + out.unmapped.length + "):\n"
    );
    out.unmapped.forEach(function (u) {
      process.stderr.write("  [" + u.section + "] " + u.label + ": " + u.value + "\n");
    });
  }

  if (opts.summary) {
    printSummary(out);
  } else {
    process.stdout.write(
      JSON.stringify(out.items, null, opts.compact ? 0 : 2) + "\n"
    );
    if (out.unresolved.length) {
      process.stderr.write(
        out.unresolved.length + " item(s) left blank for manual entry. " +
        "Run with --summary to see which.\n"
      );
    }
  }

  if (opts.strict && out.unresolved.length) process.exit(1);
}

main();

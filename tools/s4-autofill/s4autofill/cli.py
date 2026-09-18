"""Command line entry point. Run `python -m s4autofill --help`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .model import (
    CONFIG_DIR, Roster, Tech, load_month_input, load_roster, load_shift_config,
    save_month_input, save_roster,
)
from .monthcal import normalise_weekdays, parse_month
from .intake import holidays_from_args, read_intake, write_intake, write_slot_legend
from .export import write_all
from .formimport import (
    apply_suggestions, read_notes, read_submissions, to_month_input,
)
from .scheduler import build_plan
from .s4client import S4Client, load_form_config, save_form_config, suggest_mapping
from .validate import summarise, validate

DEFAULT_OUT = Path("out")


def _load(args: argparse.Namespace):
    config = load_shift_config(Path(args.shifts) if args.shifts else None)
    roster = load_roster(Path(args.roster) if args.roster else None)
    return config, roster


def _print_issues(issues) -> int:
    for issue in issues:
        print(issue.format())
    errors, warnings = summarise(issues)
    print(f"\n{errors} error(s), {warnings} warning(s)")
    return errors


# --------------------------------------------------------------------- roster


def cmd_roster_list(args: argparse.Namespace) -> int:
    _, roster = _load(args)
    print(f"{'id':16}{'division':10}{'active':8}{'fixed off':26}{'fixed slot':12}preferences")
    for tech in sorted(roster.techs, key=lambda t: (t.division, t.id)):
        if args.division and tech.division != args.division:
            continue
        if not tech.active and not args.all:
            continue
        print(f"{tech.id:16}{tech.division:10}{'yes' if tech.active else 'no':8}"
              f"{'-'.join(tech.fixed_off) or '-':26}{tech.fixed_slot or '-':12}"
              f"{','.join(tech.preferences) or '-'}")
    active = sum(1 for t in roster.techs if t.active)
    print(f"\n{active} active of {len(roster.techs)}")
    return 0


def cmd_roster_add(args: argparse.Namespace) -> int:
    config, roster = _load(args)
    if roster.has(args.tech_id):
        print(f"{args.tech_id} is already in the roster; use `roster set` to change them.",
              file=sys.stderr)
        return 1
    slot_ids = {s.id for s in config.slots}
    for slot_id in list(args.prefer or []) + ([args.fixed_slot] if args.fixed_slot else []):
        if slot_id not in slot_ids:
            print(f"unknown slot {slot_id!r}; known slots: {', '.join(sorted(slot_ids))}",
                  file=sys.stderr)
            return 1
    tech = Tech(
        id=args.tech_id,
        email=args.email or f"{args.tech_id}@poornam.com",
        division=args.division,
        display_name=args.display_name or "",
        fixed_off=normalise_weekdays(args.fixed_off or []),
        fixed_slot=args.fixed_slot,
        preferences=list(args.prefer or []),
        tags=list(args.tag or []),
        joined=args.joined,
        prefs_submitted_at=args.submitted_at or "2999-01-01T00:00:00",
        notes=args.note or "",
    )
    roster.techs.append(tech)
    path = save_roster(roster, Path(args.roster) if args.roster else None)
    print(f"added {tech.id} ({tech.division}) to {path}")
    if args.fixed_slot:
        print(f"note: also add {tech.id!r} to the 'dedicated' list of slot "
              f"{args.fixed_slot} in config/shifts.json")
    return 0


def cmd_roster_remove(args: argparse.Namespace) -> int:
    _, roster = _load(args)
    if not roster.has(args.tech_id):
        print(f"{args.tech_id} is not in the roster", file=sys.stderr)
        return 1
    tech = roster.get(args.tech_id)
    if args.hard:
        roster.techs = [t for t in roster.techs if t.id != args.tech_id]
        action = "removed"
    else:
        # The default keeps history intact: past months still reference them.
        tech.active = False
        tech.left = args.left
        action = f"deactivated (left={args.left or 'unset'})"
    path = save_roster(roster, Path(args.roster) if args.roster else None)
    print(f"{action} {args.tech_id} in {path}")
    return 0


def cmd_roster_set(args: argparse.Namespace) -> int:
    config, roster = _load(args)
    if not roster.has(args.tech_id):
        print(f"{args.tech_id} is not in the roster", file=sys.stderr)
        return 1
    tech = roster.get(args.tech_id)
    slot_ids = {s.id for s in config.slots}
    if args.division:
        tech.division = args.division
    if args.email:
        tech.email = args.email
    if args.fixed_off is not None:
        tech.fixed_off = normalise_weekdays(args.fixed_off)
    if args.fixed_slot is not None:
        tech.fixed_slot = args.fixed_slot or None
    if args.prefer is not None:
        for slot_id in args.prefer:
            if slot_id not in slot_ids:
                print(f"unknown slot {slot_id!r}", file=sys.stderr)
                return 1
        tech.preferences = list(args.prefer)
    if args.avoid is not None:
        tech.avoid_slots = list(args.avoid)
    if args.submitted_at:
        tech.prefs_submitted_at = args.submitted_at
    if args.flexy_start:
        tech.flexy_start = args.flexy_start
    if args.max_nights is not None:
        tech.max_nights_per_month = args.max_nights
    if args.no_night_before_off is not None:
        tech.no_night_before_off = args.no_night_before_off == "yes"
    if args.active is not None:
        tech.active = args.active == "yes"
    if args.note is not None:
        tech.notes = args.note
    path = save_roster(roster, Path(args.roster) if args.roster else None)
    print(f"updated {tech.id} in {path}")
    return 0


# --------------------------------------------------------------------- intake


def cmd_intake(args: argparse.Namespace) -> int:
    config, roster = _load(args)
    out = Path(args.out or f"intake/{args.month}")
    sheet = write_intake(roster, config, args.month, out / f"intake-{args.month}.csv",
                         include_inactive=args.all)
    legend = write_slot_legend(config, out / "slot-legend.csv")
    print(f"intake sheet : {sheet}")
    print(f"slot legend  : {legend}")
    print("\nAsk every tech to fill in their row:")
    print("  total_off_days       - how many days off they want this month")
    print("  cl_days              - casual leave days")
    print("  public_holiday_days  - public holidays they are taking")
    print("  preference_1..3      - slot ids from the legend, best first")
    print("  leave_dates          - exact dates if they already know them, e.g. '5:CL; 12:PH'")
    return 0


def cmd_import_form(args: argparse.Namespace) -> int:
    """Turn the team's off-request form export into a month input."""
    config, roster = _load(args)
    path = Path(args.file)
    try:
        submissions, holidays, warnings = read_submissions(path, args.month)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"read {len(submissions)} submission(s) from {path}")
    if holidays:
        print("\npublic holidays named in the form:")
        for iso, name in sorted(holidays.items()):
            print(f"  {iso}  {name}")

    print("\nsubmission order (this is the FIFO queue):")
    for position, submission in enumerate(submissions, start=1):
        marker = "" if roster.has(submission.tech) else "   << not in roster"
        print(f"  {position:2}. {submission.tech:14} "
              f"{len(submission.off_days):2} off, {len(submission.leave_days):2} leave{marker}")

    suggestions = read_notes(submissions)
    if suggestions:
        print("\nconstraints found in the free-text notes:")
        for suggestion in suggestions:
            print(f"  {suggestion.describe()}")
        if not args.apply_notes:
            print("\n  These are NOT applied. Re-run with --apply-notes to write them "
                  "into the roster,\n  or set them yourself with `roster set`.")

    month_input, more = to_month_input(submissions, roster, config, args.month, holidays,
                                       leave_category=args.leave_category)
    applied: list[str] = []
    if args.apply_notes:
        applied = apply_suggestions(suggestions, roster, config, args.fewer_nights_cap)

    for warning in warnings + more:
        print(f"[WARNING] {warning}")
    if applied:
        print("\napplied from notes:")
        for line in applied:
            print(f"  {line}")

    if args.save:
        save_roster(roster, Path(args.roster) if args.roster else None)
        saved = save_month_input(month_input)
        print(f"\nsaved month input to {saved} and updated the roster queue order")
    else:
        print("\nNothing written. Re-run with --save to keep this, "
              f"then: s4autofill plan --month {args.month}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    config, roster = _load(args)
    month_input = load_month_input(args.month, Path(args.month_input) if args.month_input else None)
    warnings: list[str] = []

    if args.intake:
        month_input, warnings = read_intake(Path(args.intake), roster, config, args.month)
        if args.holiday:
            month_input.public_holidays.update(holidays_from_args(args.holiday))
        if args.save_input:
            save_roster(roster, Path(args.roster) if args.roster else None)
            saved = save_month_input(month_input)
            print(f"saved month input to {saved} and updated the roster from the intake sheet")
    elif args.holiday:
        month_input.public_holidays.update(holidays_from_args(args.holiday))

    plan = build_plan(config, roster, month_input, args.month)
    out_dir = Path(args.out or DEFAULT_OUT) / args.month
    written = write_all(plan, config, roster, out_dir)

    for warning in warnings:
        print(f"[WARNING] intake                {warning}")
    print(f"\nplanned {len(plan.assignments)} tech-days for {args.month}")
    for name, path in written.items():
        print(f"  {name:9} {path}")

    issues = validate(plan, roster, config, month_input)
    print()
    errors = _print_issues(issues)
    if errors:
        print("\nFix the errors above before pushing.")
    return 1 if errors and args.strict else 0


def cmd_validate(args: argparse.Namespace) -> int:
    config, roster = _load(args)
    month_input = load_month_input(args.month, Path(args.month_input) if args.month_input else None)
    plan = build_plan(config, roster, month_input, args.month)
    return 1 if _print_issues(validate(plan, roster, config, month_input)) else 0


# ------------------------------------------------------------------------ S4


def cmd_inspect(args: argparse.Namespace) -> int:
    form_config = load_form_config(Path(args.form_config) if args.form_config else None)
    client = S4Client(form_config, dry_run=True)
    try:
        forms = client.inspect(args.url)
    except Exception as exc:  # noqa: BLE001 - surface any network/TLS problem plainly
        print(f"could not fetch {args.url}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    for form in forms:
        print(f"\nform name={form['name']!r} method={form['method']} action={form['action']!r}")
        for item in form["inputs"]:
            print(f"  input  {item['name']:24} type={item['type']}")
        for select in form["selects"]:
            print(f"  select {select['name']:24} "
                  f"{len(select['options'])} options")
            for option in select["options"][:40]:
                print(f"           {option['value']:>8}  {option['text']}")
    suggestion = suggest_mapping(forms, form_config.get("form_name", "shift"))
    print("\nsuggested field mapping:")
    print(json.dumps(suggestion["fields"], indent=2))
    if args.save:
        form_config.setdefault("fields", {}).update(suggestion["fields"])
        form_config["discovered_select_options"] = suggestion.get("select_options", {})
        path = save_form_config(form_config, Path(args.form_config) if args.form_config else None)
        print(f"\nwrote the mapping into {path}")
        print("Now fill in shift_time_values / category_values / staff_values from the "
              "discovered_select_options block, then re-run with --execute.")
    return 0


def cmd_push(args: argparse.Namespace) -> int:
    payload_path = Path(args.payloads or Path(args.out or DEFAULT_OUT) / args.month / "payloads.jsonl")
    if not payload_path.exists():
        print(f"no payloads at {payload_path}; run `plan` first", file=sys.stderr)
        return 1
    payloads = [json.loads(line) for line in payload_path.read_text().splitlines() if line.strip()]

    if args.execute:
        config, roster = _load(args)
        month_input = load_month_input(args.month)
        plan = build_plan(config, roster, month_input, args.month)
        issues = validate(plan, roster, config, month_input)
        errors, _ = summarise(issues)
        if errors:
            print(f"refusing to push: {errors} validation error(s). Run "
                  f"`validate --month {args.month}` to see them.", file=sys.stderr)
            return 1

    client = S4Client(load_form_config(Path(args.form_config) if args.form_config else None),
                      dry_run=not args.execute)
    try:
        results = client.push(payloads, limit=args.limit)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    failures = [r for r in results if not r.ok]
    for result in results if args.verbose else failures:
        marker = "ok " if result.ok else "FAIL"
        print(f"{marker} {result.payload['tech_id']:14} {result.payload['start_date']} → "
              f"{result.payload['end_date']:12} {result.payload['shift_time']:18} {result.detail}")
    mode = "would post" if not args.execute else "posted"
    print(f"\n{mode} {len(results)} S4 form submission(s), {len(failures)} failure(s)")
    if not args.execute:
        print("This was a dry run. Re-run with --execute to write to S4.")
    return 1 if failures else 0


# ----------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="s4autofill",
        description="Plan the S4 monthly shift roster and push it into S4.",
    )
    parser.add_argument("--version", action="version", version=f"s4autofill {__version__}")
    parser.add_argument("--roster", help=f"roster JSON (default {CONFIG_DIR / 'roster.json'})")
    parser.add_argument("--shifts", help=f"slot config JSON (default {CONFIG_DIR / 'shifts.json'})")
    sub = parser.add_subparsers(dest="command", required=True)

    roster_parser = sub.add_parser("roster", help="add, remove and edit techs")
    roster_sub = roster_parser.add_subparsers(dest="roster_command", required=True)

    p = roster_sub.add_parser("list", help="show the roster")
    p.add_argument("--division", choices=["SA", "SM", "UNASSIGNED"])
    p.add_argument("--all", action="store_true", help="include inactive techs")
    p.set_defaults(func=cmd_roster_list)

    p = roster_sub.add_parser("add", help="add a tech who joined the team")
    p.add_argument("tech_id")
    p.add_argument("--division", required=True, choices=["SA", "SM", "UNASSIGNED"])
    p.add_argument("--email")
    p.add_argument("--display-name")
    p.add_argument("--fixed-off", nargs="*", metavar="WEEKDAY")
    p.add_argument("--fixed-slot")
    p.add_argument("--prefer", nargs="*", metavar="SLOT_ID")
    p.add_argument("--tag", nargs="*")
    p.add_argument("--joined", metavar="YYYY-MM-DD")
    p.add_argument("--submitted-at", metavar="ISO8601",
                   help="when they submitted preferences; earlier wins a contested slot")
    p.add_argument("--note")
    p.set_defaults(func=cmd_roster_add)

    p = roster_sub.add_parser("remove", help="mark a tech as left (or delete them outright)")
    p.add_argument("tech_id")
    p.add_argument("--left", metavar="YYYY-MM-DD", help="last day + 1; they are off from this date")
    p.add_argument("--hard", action="store_true",
                   help="delete the row entirely instead of deactivating it")
    p.set_defaults(func=cmd_roster_remove)

    p = roster_sub.add_parser("set", help="change one tech's settings")
    p.add_argument("tech_id")
    p.add_argument("--division", choices=["SA", "SM", "UNASSIGNED"])
    p.add_argument("--email")
    p.add_argument("--fixed-off", nargs="*", metavar="WEEKDAY")
    p.add_argument("--fixed-slot")
    p.add_argument("--prefer", nargs="*", metavar="SLOT_ID")
    p.add_argument("--avoid", nargs="*", metavar="SLOT_ID")
    p.add_argument("--submitted-at", metavar="ISO8601")
    p.add_argument("--flexy-start", metavar="HH:MM")
    p.add_argument("--max-nights", type=int)
    p.add_argument("--active", choices=["yes", "no"])
    p.add_argument("--no-night-before-off", choices=["yes", "no"])
    p.add_argument("--note")
    p.set_defaults(func=cmd_roster_set)

    p = sub.add_parser("intake", help="generate the sheet that asks everyone their offs/CL/PH")
    p.add_argument("--month", required=True, metavar="YYYY-MM")
    p.add_argument("--out")
    p.add_argument("--all", action="store_true", help="include inactive techs")
    p.set_defaults(func=cmd_intake)

    p = sub.add_parser("import-form",
                       help="read the team's off-request form export (.xlsx or .csv)")
    p.add_argument("file")
    p.add_argument("--month", required=True, metavar="YYYY-MM")
    p.add_argument("--leave-category", default="CL",
                   help="category for the CL/ML/PV column, which does not distinguish them "
                        "(default: CL)")
    p.add_argument("--apply-notes", action="store_true",
                   help="also apply the constraints found in the free-text notes")
    p.add_argument("--fewer-nights-cap", type=int, default=4,
                   help="monthly night cap for people who asked for fewer (default: 4)")
    p.add_argument("--save", action="store_true", help="write the result to disk")
    p.set_defaults(func=cmd_import_form)

    p = sub.add_parser("plan", help="build next month's roster")
    p.add_argument("--month", required=True, metavar="YYYY-MM")
    p.add_argument("--intake", help="the filled-in intake CSV")
    p.add_argument("--month-input", help="a saved month input JSON to use instead")
    p.add_argument("--holiday", nargs="*", metavar="YYYY-MM-DD=Name")
    p.add_argument("--save-input", action="store_true",
                   help="write the intake back into the roster and config/months/")
    p.add_argument("--out")
    p.add_argument("--strict", action="store_true", help="exit non-zero on validation errors")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("validate", help="re-check a month against the rules")
    p.add_argument("--month", required=True, metavar="YYYY-MM")
    p.add_argument("--month-input")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("inspect", help="read S4's real form field names off a page")
    p.add_argument("--url", required=True)
    p.add_argument("--form-config")
    p.add_argument("--save", action="store_true", help="write what it finds into s4_form.json")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("push", help="send a planned month to S4 (dry run unless --execute)")
    p.add_argument("--month", required=True, metavar="YYYY-MM")
    p.add_argument("--payloads")
    p.add_argument("--form-config")
    p.add_argument("--out")
    p.add_argument("--limit", type=int, help="only send the first N submissions")
    p.add_argument("--execute", action="store_true", help="actually write to S4")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=cmd_push)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "month", None):
        parse_month(args.month)  # fail early on a bad month
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

"""The scheduler.

Shape of a month, in order:

  1. Days off        - fixed weekday pattern, then dated leave from the intake sheet.
  2. Quota leave     - the CL / PH / PV counts people gave, placed on days the
                       roster can actually spare.
  3. Extra offs      - when someone asked for more off days than their fixed
                       pattern gives, placed so they break up long working runs.
  4. Dedicated slots - sijin / sherin / bittu.eg style permanent shift owners.
  5. Daily fill      - coverage minimums first, then targets, choosing people by
                       preference and then by FIFO queue position.
  6. Flexy           - whoever is left over, exactly as S4 shows them.

The FIFO queue is the fairness mechanism: it starts in preference-submission
order, and a tech only goes to the back of it once they are actually given a
shift they asked for. Someone who keeps getting filler shifts keeps their place
at the front and wins the next contested slot.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from .model import MonthInput, Roster, ShiftConfig, Slot, Tech
from .monthcal import month_days, parse_hhmm, parse_month, shift_window, weekday_name

NEUTRAL_RANK = 99  # preference rank for a tech who never asked for this slot


@dataclass
class DayAssignment:
    date: dt.date
    tech_id: str
    category: str               # W / ITW / OFF / CL / PH / ...
    slot_id: str | None = None  # None on a non-working day
    source: str = ""            # why the scheduler put them here
    start: str | None = None    # clock start; Flexy gets a per-person time

    @property
    def is_working(self) -> bool:
        return self.slot_id is not None


@dataclass
class Shortfall:
    date: dt.date
    slot_id: str
    needed: int
    got: int
    division: str | None = None

    def describe(self) -> str:
        who = f" ({self.division})" if self.division else ""
        return f"{self.date.isoformat()} {self.slot_id}{who}: need {self.needed}, got {self.got}"


@dataclass
class Plan:
    month: str
    year: int
    mon: int
    days: list[dt.date]
    assignments: list[DayAssignment]
    shortfalls: list[Shortfall] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def by_date(self) -> dict[dt.date, list[DayAssignment]]:
        out: dict[dt.date, list[DayAssignment]] = {d: [] for d in self.days}
        for a in self.assignments:
            out[a.date].append(a)
        return out

    def by_tech(self) -> dict[str, list[DayAssignment]]:
        out: dict[str, list[DayAssignment]] = {}
        for a in self.assignments:
            out.setdefault(a.tech_id, []).append(a)
        for rows in out.values():
            rows.sort(key=lambda a: a.date)
        return out

    def working_runs(self, tech_id: str) -> list[int]:
        """Lengths of consecutive working-day runs, for the max-run check."""
        runs, current = [], 0
        for a in self.by_tech().get(tech_id, []):
            if a.is_working:
                current += 1
            elif current:
                runs.append(current)
                current = 0
        if current:
            runs.append(current)
        return runs


class _TechState:
    """Per-tech scheduling state for one month."""

    def __init__(self, tech: Tech, fifo_pos: int) -> None:
        self.tech = tech
        self.fifo_pos = fifo_pos
        self.day_category: dict[dt.date, str] = {}     # non-working days and ITW/NB overrides
        self.assigned: dict[dt.date, str] = {}         # date -> slot id
        self.nights = 0
        self.band_counts: dict[str, int] = {}
        self.last_working_day: dt.date | None = None
        self.last_slot: str | None = None
        self.last_end: dt.datetime | None = None       # when their last shift actually ended
        self.starts: dict[dt.date, str] = {}           # date -> clock start actually used
        self.current_run = 0                           # days already on last_slot
        self.source_of: dict[dt.date, str] = {}        # date -> why they got that slot
        self.rotated_from: int | None = None           # queue slot before the last rotation

    def pref_rank(self, slot_id: str) -> int:
        prefs = self.tech.preferences
        return prefs.index(slot_id) if slot_id in prefs else NEUTRAL_RANK

    def wants(self, slot_id: str) -> bool:
        return slot_id in self.tech.preferences


class Scheduler:
    def __init__(self, config: ShiftConfig, roster: Roster, month_input: MonthInput) -> None:
        self.config = config
        self.roster = roster
        self.input = month_input
        self.rules = config.rules
        self.warnings: list[str] = []

    # ---------------------------------------------------------------- helpers

    def _slot_end(self, day: dt.date, slot: Slot) -> dt.datetime:
        return shift_window(day, slot.start, slot.duration_min)[1]

    def _slot_start(self, day: dt.date, slot: Slot) -> dt.datetime:
        return shift_window(day, slot.start, slot.duration_min)[0]

    @property
    def _rest(self) -> dt.timedelta:
        return dt.timedelta(hours=self.rules.min_rest_hours_between_shifts)

    def _rested(self, state: _TechState, day: dt.date, slot: Slot) -> bool:
        """Enough hours between the end of the last shift and the start of this one."""
        if state.last_end is None:
            return True
        return self._slot_start(day, slot) - state.last_end >= self._rest

    def _flexy_start(self, state: _TechState, day: dt.date) -> str:
        """Flexy is a self-chosen 8h window, so push it past the rest gap
        instead of refusing the day — S4 stores a per-person time here."""
        preferred = state.tech.flexy_start or self.rules.flexy_default_start
        begin = dt.datetime.combine(day, parse_hhmm(preferred))
        if state.last_end is not None:
            earliest = state.last_end + self._rest
            if begin < earliest:
                begin = earliest
                if begin.minute or begin.second:  # round up to a whole hour
                    begin = begin.replace(minute=0, second=0) + dt.timedelta(hours=1)
        if begin.date() > day or begin.hour >= 23:
            begin = dt.datetime.combine(day, dt.time(23, 0))
        return f"{begin.hour:02d}:{begin.minute:02d}"

    def _night_budget(self, tech: Tech) -> int:
        limit = tech.max_nights_per_month
        return self.rules.max_nights_per_month_default if limit is None else limit

    def _consecutive_nights(self, state: _TechState, day: dt.date) -> int:
        count, cursor = 0, day - dt.timedelta(days=1)
        while True:
            slot_id = state.assigned.get(cursor)
            if slot_id is None or not self.config.slot(slot_id).is_night:
                return count
            count += 1
            cursor -= dt.timedelta(days=1)

    def _eligible(self, state: _TechState, day: dt.date, slot: Slot) -> bool:
        if day in state.assigned or day in state.day_category and state.day_category[day] in self.config.leave_categories:
            return False
        if not state.tech.employed_on(day) or not state.tech.active:
            return False
        if slot.id in state.tech.avoid_slots:
            return False
        if slot.dedicated and state.tech.id not in slot.dedicated:
            return False
        if not self._rested(state, day, slot):
            return False
        if slot.is_night:
            if state.nights >= self._night_budget(state.tech):
                return False
            if self._consecutive_nights(state, day) >= self.rules.max_consecutive_nights:
                return False
            if self._night_lands_before_off(state, day):
                return False
        return True

    def _night_lands_before_off(self, state: _TechState, day: dt.date) -> bool:
        """A night shift the evening before a day off eats most of that day.

        People ask for this explicitly ('no night shift before off days',
        'please avoid scheduling offs immediately after night shifts'), so it
        is opt-in per tech rather than a blanket rule.
        """
        if not state.tech.no_night_before_off:
            return False
        tomorrow = state.day_category.get(day + dt.timedelta(days=1))
        return tomorrow in self.config.leave_categories

    def _early_slots(self) -> list[Slot]:
        return [s for s in self.config.assignable if s.min > 0 and s.band in {"morning", "day"}]

    def _early_need(self, states: dict[str, _TechState], day: dt.date) -> int:
        need = 0
        for slot in self._early_slots():
            if slot.dedicated:
                continue
            need = need + slot.min
        return need

    def _available(self, state: _TechState, day: dt.date) -> bool:
        return (state.tech.active and state.tech.employed_on(day)
                and state.day_category.get(day) not in self.config.leave_categories)

    def _early_capable(self, state: _TechState, day: dt.date,
                       assume_end: dt.datetime | None = None) -> bool:
        """Could this tech take one of tomorrow's early slots?"""
        if not self._available(state, day):
            return False
        end = assume_end if assume_end is not None else state.last_end
        if end is None:
            return True
        latest = max(
            (self._slot_start(day, slot) for slot in self._early_slots() if not slot.dedicated),
            default=None,
        )
        return latest is None or latest - end >= self._rest

    def _early_needs(self, day: dt.date) -> list[tuple[Slot, str | None, int]]:
        needs: list[tuple[Slot, str | None, int]] = []
        for slot in self._early_slots():
            if slot.dedicated:
                continue
            for division, count in sorted(slot.division_min.items()):
                needs.append((slot, division, count))
            needs.append((slot, None, slot.min))
        return needs

    def _early_cover_survives(self, states: dict[str, _TechState], day: dt.date,
                              candidate: _TechState, slot: Slot) -> bool:
        """Would putting this person on this shift leave tomorrow morning uncovered?

        Evening and night shifts eat the people who are rested enough to open
        the next day, and a division floor makes that worse: it is no help that
        somebody is free tomorrow morning if the slot needs an SA and they are
        not one.
        """
        if candidate.tech.fixed_slot:
            return True
        tomorrow = day + dt.timedelta(days=1)
        if self._early_capable(candidate, tomorrow, assume_end=self._slot_end(day, slot)):
            return True  # they can still open tomorrow themselves
        for _slot, division, count in self._early_needs(tomorrow):
            if count <= 0:
                continue
            if division is not None and candidate.tech.division != division:
                continue
            others = sum(
                1 for s in states.values()
                if s.tech.id != candidate.tech.id and not s.tech.fixed_slot
                and (division is None or s.tech.division == division)
                and self._early_capable(s, tomorrow)
            )
            if others < count:
                return False
        return True

    def _sort_key(self, state: _TechState, slot: Slot) -> tuple:
        sticky = 0 if (
            state.last_slot == slot.id
            and state.current_run < self.rules.stickiness_block_days
        ) else 1
        return (
            state.pref_rank(slot.id),              # people who asked for it come first
            sticky,                                # then keep continuity within a block
            state.fifo_pos,                        # then queue order (first in, first served)
            state.band_counts.get(slot.band, 0),   # then whoever has had this band least
            state.tech.id,                         # deterministic tie-break
        )

    def _place(self, state: _TechState, day: dt.date, slot: Slot, source: str,
               queue: list[str]) -> None:
        start = self._flexy_start(state, day) if slot.is_flexy else slot.start
        state.assigned[day] = slot.id
        state.starts[day] = start
        state.last_end = (dt.datetime.combine(day, parse_hhmm(start))
                          + dt.timedelta(minutes=slot.duration_min))
        state.band_counts[slot.band] = state.band_counts.get(slot.band, 0) + 1
        if slot.is_night:
            state.nights += 1
        state.current_run = state.current_run + 1 if state.last_slot == slot.id else 1
        state.last_slot = slot.id
        state.last_working_day = day
        state.source_of[day] = source
        # Served: a tech who got a shift they actually asked for goes to the back
        # of the queue. Filler shifts do not cost them their place.
        if state.wants(slot.id):
            state.rotated_from = queue.index(state.tech.id)
            queue.remove(state.tech.id)
            queue.append(state.tech.id)
        else:
            state.rotated_from = None

    def _snapshot(self, states: dict[str, _TechState]) -> dict[str, tuple]:
        """Each tech's state as it stood before today, so a move can be undone."""
        return {
            tid: (s.last_end, s.last_slot, s.last_working_day, s.current_run,
                  s.nights, dict(s.band_counts))
            for tid, s in states.items()
        }

    def _unplace(self, state: _TechState, day: dt.date, snapshot: dict[str, tuple],
                 queue: list[str]) -> None:
        (state.last_end, state.last_slot, state.last_working_day, state.current_run,
         state.nights, state.band_counts) = snapshot[state.tech.id]
        state.assigned.pop(day, None)
        state.starts.pop(day, None)
        state.source_of.pop(day, None)
        if state.rotated_from is not None:
            queue.remove(state.tech.id)
            queue.insert(min(state.rotated_from, len(queue)), state.tech.id)
            state.rotated_from = None

    def _can_take_over(self, state: _TechState, day: dt.date, slot: Slot,
                       snapshot: dict[str, tuple]) -> bool:
        """Could this tech do `slot` today if we moved them off what they have?"""
        last_end, _, _, _, nights_before, _ = snapshot[state.tech.id]
        if slot.id in state.tech.avoid_slots:
            return False
        if slot.dedicated and state.tech.id not in slot.dedicated:
            return False
        if last_end is not None and self._slot_start(day, slot) - last_end < self._rest:
            return False
        if slot.is_night:
            if nights_before >= self._night_budget(state.tech):
                return False
            if self._consecutive_nights(state, day) >= self.rules.max_consecutive_nights:
                return False
            if self._night_lands_before_off(state, day):
                return False
        return True

    def _can_spare(self, states: dict[str, _TechState], filled: dict[str, list[str]],
                   slot: Slot, tech: Tech) -> tuple[bool, str | None]:
        """Can this slot lose this person? If not, which division must replace them?"""
        if slot.is_flexy:
            return True, None
        needed = slot.division_min.get(tech.division, 0)
        short_on_division = False
        if needed:
            have = sum(1 for t in filled[slot.id] if states[t].tech.division == tech.division)
            short_on_division = have <= needed
        if len(filled[slot.id]) > slot.min and not short_on_division:
            return True, None
        return False, tech.division if short_on_division else None

    def _steal_into(self, states: dict[str, _TechState], day: dt.date, slot: Slot,
                    filled: dict[str, list[str]], queue: list[str],
                    snapshot: dict[str, tuple], division: str | None = None,
                    visited: set[str] | None = None) -> bool:
        """Find somebody for this seat, moving people around the day if needed.

        A single swap is not enough. On a day where every person is already on a
        slot, the only way to fill a seat is a chain: move A off their slot into
        this one, then backfill A's slot with B, and so on. That is an
        augmenting path, and without it a day that has a perfectly good
        assignment still comes out short.

        Nobody's day off is touched — this only rearranges who works what.
        """
        visited = set() if visited is None else visited
        if slot.id in visited:
            return False
        visited.add(slot.id)

        for tech_id in list(queue):
            state = states[tech_id]
            if division is not None and state.tech.division != division:
                continue
            if state.tech.fixed_slot:
                continue
            current = state.assigned.get(day)
            if current == slot.id:
                continue

            if current is None:
                if not self._eligible(state, day, slot):
                    continue
                self._place(state, day, slot, "reassigned", queue)
                filled[slot.id].append(tech_id)
                return True

            donor_slot = self.config.slot(current)
            if donor_slot.dedicated:
                continue
            if not self._can_take_over(state, day, slot, snapshot):
                continue

            spare, must_replace_with = self._can_spare(states, filled, donor_slot, state.tech)
            self._unplace(state, day, snapshot, queue)
            filled[current].remove(tech_id)
            self._place(state, day, slot, "reassigned", queue)
            filled[slot.id].append(tech_id)
            if spare or self._steal_into(states, day, donor_slot, filled, queue,
                                         snapshot, must_replace_with, visited):
                return True

            # That chain went nowhere — put them back exactly as they were.
            self._unplace(state, day, snapshot, queue)
            filled[slot.id].remove(tech_id)
            self._place(state, day, donor_slot, "restored", queue)
            filled[current].append(tech_id)
        return False

    def _early_needs(self, day: dt.date) -> list[tuple[Slot, str | None, int]]:
        needs: list[tuple[Slot, str | None, int]] = []
        for slot in self._early_slots():
            if slot.dedicated:
                continue
            for division, count in sorted(slot.division_min.items()):
                needs.append((slot, division, count))
            needs.append((slot, None, slot.min))
        return needs

    def _early_cover_survives(self, states: dict[str, _TechState], day: dt.date,
                              candidate: _TechState, slot: Slot) -> bool:
        """Would putting this person on this shift leave tomorrow morning uncovered?

        Evening and night shifts eat the people who are rested enough to open
        the next day, and a division floor makes that worse: it is no help that
        somebody is free tomorrow morning if the slot needs an SA and they are
        not one.
        """
        if candidate.tech.fixed_slot:
            return True
        tomorrow = day + dt.timedelta(days=1)
        if self._early_capable(candidate, tomorrow, assume_end=self._slot_end(day, slot)):
            return True  # they can still open tomorrow themselves
        for _slot, division, count in self._early_needs(tomorrow):
            if count <= 0:
                continue
            if division is not None and candidate.tech.division != division:
                continue
            others = sum(
                1 for s in states.values()
                if s.tech.id != candidate.tech.id and not s.tech.fixed_slot
                and (division is None or s.tech.division == division)
                and self._early_capable(s, tomorrow)
            )
            if others < count:
                return False
        return True

    def _sort_key(self, state: _TechState, slot: Slot) -> tuple:
        sticky = 0 if (
            state.last_slot == slot.id
            and state.current_run < self.rules.stickiness_block_days
        ) else 1
        return (
            state.pref_rank(slot.id),              # people who asked for it come first
            sticky,                                # then keep continuity within a block
            state.fifo_pos,                        # then queue order (first in, first served)
            state.band_counts.get(slot.band, 0),   # then whoever has had this band least
            state.tech.id,                         # deterministic tie-break
        )

    def _place(self, state: _TechState, day: dt.date, slot: Slot, source: str,
               queue: list[str]) -> None:
        start = self._flexy_start(state, day) if slot.is_flexy else slot.start
        state.assigned[day] = slot.id
        state.starts[day] = start
        state.last_end = (dt.datetime.combine(day, parse_hhmm(start))
                          + dt.timedelta(minutes=slot.duration_min))
        state.band_counts[slot.band] = state.band_counts.get(slot.band, 0) + 1
        if slot.is_night:
            state.nights += 1
        state.current_run = state.current_run + 1 if state.last_slot == slot.id else 1
        state.last_slot = slot.id
        state.last_working_day = day
        state.source_of[day] = source
        # Served: a tech who got a shift they actually asked for goes to the back
        # of the queue. Filler shifts do not cost them their place.
        if state.wants(slot.id):
            state.rotated_from = queue.index(state.tech.id)
            queue.remove(state.tech.id)
            queue.append(state.tech.id)
        else:
            state.rotated_from = None

    def _snapshot(self, states: dict[str, _TechState]) -> dict[str, tuple]:
        """Each tech's state as it stood before today, so a move can be undone."""
        return {
            tid: (s.last_end, s.last_slot, s.last_working_day, s.current_run,
                  s.nights, dict(s.band_counts))
            for tid, s in states.items()
        }

    def _unplace(self, state: _TechState, day: dt.date, snapshot: dict[str, tuple],
                 queue: list[str]) -> None:
        (state.last_end, state.last_slot, state.last_working_day, state.current_run,
         state.nights, state.band_counts) = snapshot[state.tech.id]
        state.assigned.pop(day, None)
        state.starts.pop(day, None)
        state.source_of.pop(day, None)
        if state.rotated_from is not None:
            queue.remove(state.tech.id)
            queue.insert(min(state.rotated_from, len(queue)), state.tech.id)
            state.rotated_from = None

    def _can_take_over(self, state: _TechState, day: dt.date, slot: Slot,
                       snapshot: dict[str, tuple]) -> bool:
        """Could this tech do `slot` today if we moved them off what they have?"""
        last_end, _, _, _, nights_before, _ = snapshot[state.tech.id]
        if slot.id in state.tech.avoid_slots:
            return False
        if slot.dedicated and state.tech.id not in slot.dedicated:
            return False
        if last_end is not None and self._slot_start(day, slot) - last_end < self._rest:
            return False
        if slot.is_night:
            if nights_before >= self._night_budget(state.tech):
                return False
            if self._consecutive_nights(state, day) >= self.rules.max_consecutive_nights:
                return False
            if self._night_lands_before_off(state, day):
                return False
        return True

    def _steal_into(self, states: dict[str, _TechState], day: dt.date, slot: Slot,
                    filled: dict[str, list[str]], queue: list[str],
                    snapshot: dict[str, tuple], division: str | None = None) -> bool:
        """Move somebody off a slot that can spare them onto one that is short.

        Thin days - a Sunday, where most of the team is off - can leave a
        minimum unfilled purely because the only people left worked the night
        before. Shuffling within the day fixes that without touching anyone's
        days off.
        """
        for donor_id in list(queue):
            state = states[donor_id]
            donor_slot_id = state.assigned.get(day)
            if donor_slot_id is None or donor_slot_id == slot.id:
                continue
            if division is not None and state.tech.division != division:
                continue
            if state.tech.fixed_slot:
                continue  # dedicated owners stay on their own slot
            donor_slot = self.config.slot(donor_slot_id)
            if donor_slot.dedicated:
                continue
            if not donor_slot.is_flexy:
                if len(filled[donor_slot_id]) <= donor_slot.min:
                    continue
                needed = donor_slot.division_min.get(state.tech.division, 0)
                if needed:
                    have = sum(1 for t in filled[donor_slot_id]
                               if states[t].tech.division == state.tech.division)
                    if have <= needed:
                        continue
            if not self._can_take_over(state, day, slot, snapshot):
                continue
            self._unplace(state, day, snapshot, queue)
            filled[donor_slot_id].remove(donor_id)
            self._place(state, day, slot, "reassigned", queue)
            filled[slot.id].append(donor_id)
            return True
        return False

    # ------------------------------------------------------- non-working days

    def _apply_fixed_and_dated(self, states: dict[str, _TechState], days: list[dt.date]) -> None:
        leave_categories = set(self.config.leave_categories)
        for state in states.values():
            tech = state.tech
            off_indexes = tech.fixed_off_indexes
            for day in days:
                if not tech.employed_on(day):
                    state.day_category[day] = "OFF"
                elif day.weekday() in off_indexes:
                    state.day_category[day] = "OFF"
            for iso, category in self.input.leave.get(tech.id, {}).items():
                day = dt.date.fromisoformat(iso)
                if day not in days:
                    continue
                existing = state.day_category.get(day)
                if existing == "OFF" and category == "OFF":
                    continue  # they asked for a day they already have off
                if existing == "OFF" and category in leave_categories:
                    self.warnings.append(
                        f"{tech.id}: {iso} is already a fixed off ({weekday_name(day)}); "
                        f"the {category} on that date was not counted."
                    )
                    continue
                state.day_category[day] = category

    def _revocable_off(self, state: _TechState, day: dt.date) -> bool:
        """An off we may take back: a request, not a standing arrangement.

        Fixed weekday offs and the ones people marked unavoidable on the form
        are never touched.
        """
        if state.day_category.get(day) != "OFF":
            return False
        if day.weekday() in state.tech.fixed_off_indexes:
            return False
        return day.isoformat() not in self.input.unavoidable.get(state.tech.id, [])

    def _available_count(self, states: dict[str, _TechState], day: dt.date) -> int:
        return sum(1 for s in states.values() if self._available(s, day))

    def _arbitrate_off_requests(self, states: dict[str, _TechState],
                                days: list[dt.date]) -> None:
        """Settle over-subscribed days off, first in first out.

        People ask for the same popular days. When more offs are requested than
        the roster can cover, the ones who asked first keep theirs and the
        latest requests are handed back — the same queue that settles who gets
        a shift they wanted. Fixed offs and anything marked unavoidable are
        never taken back.
        """
        if not self.rules.arbitrate_off_requests:
            return
        floor = sum(slot.min for slot in self.config.assignable)
        # Last to ask is first to lose it.
        latest_first = sorted(states.values(), key=lambda s: s.fifo_pos, reverse=True)
        for day in days:
            short = floor - self._available_count(states, day)
            if short <= 0:
                continue
            for state in latest_first:
                if short <= 0:
                    break
                if not self._revocable_off(state, day):
                    continue
                del state.day_category[day]
                short -= 1
                self.warnings.append(
                    f"{state.tech.id}: off request for {day.isoformat()} "
                    f"({weekday_name(day)}) not granted — the day was short of people and "
                    f"they were #{state.fifo_pos + 1} in the queue."
                )
            if short > 0:
                self.warnings.append(
                    f"roster: {day.isoformat()} ({weekday_name(day)}) is {short} short of the "
                    f"{floor}-person floor even after handing back every revocable off request. "
                    f"Someone's fixed off or an unavoidable request has to move."
                )

    def _slack(self, states: dict[str, _TechState], day: dt.date) -> int:
        """Spare bodies on a day: available people minus the coverage floor."""
        available = sum(
            1 for s in states.values()
            if s.tech.active and s.tech.employed_on(day)
            and s.day_category.get(day) not in self.config.leave_categories
        )
        floor = sum(slot.min for slot in self.config.assignable)
        return available - floor

    def _free_days(self, state: _TechState, days: list[dt.date]) -> list[dt.date]:
        return [
            d for d in days
            if d not in state.day_category and state.tech.employed_on(d)
        ]

    def _nearest_off_distance(self, state: _TechState, day: dt.date, days: list[dt.date]) -> int:
        offs = [d for d, c in state.day_category.items() if c in self.config.leave_categories]
        if not offs:
            return len(days)
        return min(abs((day - d).days) for d in offs)

    def _place_quota_leave(self, states: dict[str, _TechState], days: list[dt.date]) -> None:
        """Spend the CL / PH / PV counts people gave on the intake sheet."""
        holidays = sorted(dt.date.fromisoformat(d) for d in self.input.public_holidays)
        adjacent = self.rules.quota_leave_placement == "adjacent_to_off"
        for tech_id, targets in sorted(self.input.targets.items()):
            state = states.get(tech_id)
            if state is None:
                continue
            for category, count in sorted(targets.items()):
                if category == "off_days" or count <= 0:
                    continue
                pool = [d for d in holidays if d in days] if category == "PH" else days
                for _ in range(count):
                    candidates = [d for d in self._free_days(state, days) if d in pool]
                    if not candidates:
                        self.warnings.append(
                            f"{tech_id}: could not place {category} — no free day left"
                            + (" among the declared public holidays." if category == "PH" else ".")
                        )
                        break
                    # A leave day next to an existing off makes a longer break,
                    # which is what people actually ask for.
                    best = min(candidates, key=lambda d: (
                        self._nearest_off_distance(state, d, days) if adjacent
                        else -self._nearest_off_distance(state, d, days),
                        -self._slack(states, d),
                        d,
                    ))
                    state.day_category[best] = category

    def _place_extra_offs(self, states: dict[str, _TechState], days: list[dt.date]) -> None:
        """Honour 'total off days' higher than the fixed weekday pattern gives."""
        for tech_id, targets in sorted(self.input.targets.items()):
            state = states.get(tech_id)
            if state is None:
                continue
            wanted = targets.get("off_days", 0)
            have = sum(1 for c in state.day_category.values() if c == "OFF")
            for _ in range(max(0, wanted - have)):
                candidates = self._free_days(state, days)
                if not candidates:
                    self.warnings.append(f"{tech_id}: could not place an extra off — no free day left.")
                    break
                best = min(candidates, key=lambda d: (
                    -self._nearest_off_distance(state, d, days),  # spread them out
                    -self._slack(states, d),                      # on a day we can spare them
                    d,
                ))
                state.day_category[best] = "OFF"

    # ------------------------------------------------------------ daily fill

    def _fill_slot(self, states: dict[str, _TechState], day: dt.date, slot: Slot,
                   filled: dict[str, list[str]], want: int, queue: list[str],
                   division: str | None, source: str) -> None:
        """Top a slot up to `want` people, optionally only from one division."""
        while len(filled[slot.id]) < want:
            pool = [
                states[tid] for tid in queue
                if (division is None or states[tid].tech.division == division)
                and self._eligible(states[tid], day, slot)
            ]
            if not pool:
                return
            if not self._reserve_ok(states, day, filled, queue, len(pool)):
                return
            safe = [s for s in pool if self._early_cover_survives(states, day, s, slot)]
            if not safe:
                return
            chosen = min(safe, key=lambda s: self._sort_key(s, slot))
            self._place(chosen, day, slot, source, queue)
            filled[slot.id].append(chosen.tech.id)

    def _reserve_ok(self, states: dict[str, _TechState], day: dt.date,
                    filled: dict[str, list[str]], queue: list[str], pool_size: int) -> bool:
        """Never spend the last body on a target when a minimum is still unmet."""
        unmet = sum(
            max(0, slot.min - len(filled[slot.id])) for slot in self.config.assignable
        )
        free = sum(1 for tid in queue if day not in states[tid].assigned)
        return free - 1 >= unmet or pool_size > unmet

    def _open_needs(self, states: dict[str, _TechState], filled: dict[str, list[str]],
                    ordered: list[Slot], skip: set) -> list[tuple[Slot, str | None, int]]:
        """Every coverage minimum still unmet, division ones included."""
        needs: list[tuple[Slot, str | None, int]] = []
        for slot in ordered:
            for division, count in sorted(slot.division_min.items()):
                have = sum(1 for t in filled[slot.id] if states[t].tech.division == division)
                if have < count and (slot.id, division) not in skip:
                    needs.append((slot, division, count - have))
            unmet = slot.min - len(filled[slot.id])
            if unmet > 0 and (slot.id, None) not in skip:
                needs.append((slot, None, unmet))
        return needs

    def _fill_minimums(self, states: dict[str, _TechState], day: dt.date,
                       filled: dict[str, list[str]], queue: list[str],
                       snapshot: dict[str, tuple], ordered: list[Slot]) -> None:
        """Fill coverage floors most-constrained-slot-first.

        Going band by band starves thin days: the evening pass takes the last
        people who are also the only ones rested enough for the morning. So
        each round finds the seat with the fewest eligible bodies and fills
        that one, which is what a human scheduler does by eye.
        """
        position = {slot.id: i for i, slot in enumerate(ordered)}
        skip: set[tuple[str, str | None]] = set()
        while True:
            needs = self._open_needs(states, filled, ordered, skip)
            if not needs:
                return
            scored = []
            for slot, division, unmet in needs:
                pool = [
                    states[tid] for tid in queue
                    if (division is None or states[tid].tech.division == division)
                    and self._eligible(states[tid], day, slot)
                ]
                scored.append((len(pool), -unmet, position[slot.id], slot.id, slot, division, pool))
            scored.sort(key=lambda row: row[:4])
            *_, slot, division, pool = scored[0]
            if pool:
                safe = [s for s in pool if self._early_cover_survives(states, day, s, slot)]
                chosen = min(safe or pool, key=lambda s: self._sort_key(s, slot))
                self._place(chosen, day, slot,
                            "minimum" if division is None else "division-min", queue)
                filled[slot.id].append(chosen.tech.id)
            elif not self._steal_into(states, day, slot, filled, queue, snapshot, division):
                skip.add((slot.id, division))

    def _capable_count(self, states: dict[str, _TechState], day: dt.date,
                       division: str | None) -> int:
        return sum(
            1 for s in states.values()
            if not s.tech.fixed_slot
            and (division is None or s.tech.division == division)
            and self._early_capable(s, day)
        )

    def _pull_forward(self, states: dict[str, _TechState], day: dt.date,
                      filled: dict[str, list[str]], queue: list[str],
                      snapshot: dict[str, tuple], division: str | None,
                      tomorrow: dt.date) -> bool:
        """Move somebody from a late shift today onto an earlier one.

        Whoever works late tonight cannot open tomorrow. When that would leave
        the morning uncovered, swapping one person onto an earlier shift today
        fixes it, and costs nobody a day off.
        """
        for donor_id in list(queue):
            state = states[donor_id]
            if state.tech.fixed_slot or not self._available(state, tomorrow):
                continue
            if division is not None and state.tech.division != division:
                continue
            if self._early_capable(state, tomorrow):
                continue
            donor_slot_id = state.assigned.get(day)
            if donor_slot_id is None:
                continue
            donor_slot = self.config.slot(donor_slot_id)
            if donor_slot.dedicated:
                continue
            if not donor_slot.is_flexy:
                if len(filled[donor_slot_id]) <= donor_slot.min:
                    continue
                needed = donor_slot.division_min.get(state.tech.division, 0)
                if needed:
                    have = sum(1 for x in filled[donor_slot_id]
                               if states[x].tech.division == state.tech.division)
                    if have <= needed:
                        continue
            for target in self._early_slots():
                if target.id == donor_slot_id or target.dedicated:
                    continue
                if len(filled[target.id]) >= target.max:
                    continue
                if not self._can_take_over(state, day, target, snapshot):
                    continue
                if not self._early_capable(state, tomorrow,
                                           assume_end=self._slot_end(day, target)):
                    continue
                self._unplace(state, day, snapshot, queue)
                filled[donor_slot_id].remove(donor_id)
                self._place(state, day, target, "pulled-forward", queue)
                filled[target.id].append(donor_id)
                return True
        return False

    def _protect_next_morning(self, states: dict[str, _TechState], day: dt.date,
                              filled: dict[str, list[str]], queue: list[str],
                              snapshot: dict[str, tuple]) -> None:
        tomorrow = day + dt.timedelta(days=1)
        for _slot, division, count in self._early_needs(tomorrow):
            if count <= 0:
                continue
            while self._capable_count(states, tomorrow, division) < count:
                if not self._pull_forward(states, day, filled, queue, snapshot,
                                          division, tomorrow):
                    break

    def _fill_day(self, states: dict[str, _TechState], day: dt.date, queue: list[str]) -> list[Shortfall]:
        filled: dict[str, list[str]] = {slot.id: [] for slot in self.config.slots}
        shortfalls: list[Shortfall] = []
        snapshot = self._snapshot(states)

        # 1. Dedicated shift owners keep their slot every working day.
        for slot in self.config.assignable:
            for tech_id in slot.dedicated:
                state = states.get(tech_id)
                if state and self._eligible(state, day, slot):
                    self._place(state, day, slot, "dedicated", queue)
                    filled[slot.id].append(tech_id)

        bands = {band: i for i, band in enumerate(self.rules.fill_order)}
        ordered = sorted(
            self.config.assignable,
            key=lambda s: (bands.get(s.band, len(bands)), -s.min, -s.target, s.id),
        )

        # 2. Coverage minimums, division quotas included.
        self._fill_minimums(states, day, filled, queue, snapshot, ordered)

        # 4. Top up towards the target headcount.
        for slot in ordered:
            self._fill_slot(states, day, slot, filled, min(slot.target, slot.max), queue, None, "target")

        # 5. Spread whoever is left over across the slots that can still take
        #    them, one at a time so it stays balanced. Without this everybody
        #    surplus to target lands in Flexy, which is not how the sheet reads.
        if self.rules.spill_to_max:
            spill_bands = {band: i for i, band in enumerate(self.rules.spill_order)}
            spill_order = sorted(
                self.config.assignable,
                key=lambda s: (spill_bands.get(s.band, len(spill_bands)), -s.max, s.id),
            )
            progressed = True
            while progressed:
                progressed = False
                for slot in spill_order:
                    if len(filled[slot.id]) >= slot.max:
                        continue
                    before = len(filled[slot.id])
                    self._fill_slot(states, day, slot, filled, before + 1, queue, None, "spill")
                    progressed = progressed or len(filled[slot.id]) > before

        # 6. Anyone still standing goes to Flexy, which is what S4 does.
        flexy = self.config.flexy
        for tech_id in list(queue):
            state = states[tech_id]
            if day in state.assigned:
                continue
            if state.day_category.get(day) in self.config.leave_categories:
                continue
            if not (state.tech.active and state.tech.employed_on(day)):
                continue
            self._place(state, day, flexy, "flexy", queue)
            filled[flexy.id].append(tech_id)

        # 7. Make sure tonight's shifts have not eaten tomorrow's morning.
        self._protect_next_morning(states, day, filled, queue, snapshot)

        # 8. Last look: anything still under its minimum gets one more attempt
        #    at a reshuffle, now that target and spill have put spare people on
        #    slots we are allowed to take them off. Whatever survives this is a
        #    genuine shortage of people and is reported, not hidden.
        for slot in ordered:
            for division, count in sorted(slot.division_min.items()):
                have = sum(1 for t in filled[slot.id] if states[t].tech.division == division)
                while have < count and self._steal_into(states, day, slot, filled, queue,
                                                        snapshot, division):
                    have = sum(1 for t in filled[slot.id] if states[t].tech.division == division)
                if have < count:
                    shortfalls.append(Shortfall(day, slot.id, count, have, division))
            while len(filled[slot.id]) < slot.min and self._steal_into(
                    states, day, slot, filled, queue, snapshot):
                pass
            if len(filled[slot.id]) < slot.min:
                shortfalls.append(Shortfall(day, slot.id, slot.min, len(filled[slot.id])))
        return shortfalls

    # ------------------------------------------------------------------ build

    def build(self, month: str) -> Plan:
        year, mon = parse_month(month)
        days = month_days(year, mon)
        techs = [t for t in self.roster.techs if t.active]
        order = sorted(techs, key=lambda t: (t.prefs_submitted_at, t.id))
        states = {t.id: _TechState(t, i) for i, t in enumerate(order)}
        queue = [t.id for t in order]

        self._apply_fixed_and_dated(states, days)
        self._arbitrate_off_requests(states, days)
        self._place_quota_leave(states, days)
        self._place_extra_offs(states, days)

        shortfalls: list[Shortfall] = []
        for day in days:
            shortfalls.extend(self._fill_day(states, day, queue))

        assignments: list[DayAssignment] = []
        for state in states.values():
            for day in days:
                slot_id = state.assigned.get(day)
                if slot_id:
                    category = state.day_category.get(day, "W")
                    if category in self.config.leave_categories:
                        category = "W"
                    assignments.append(DayAssignment(
                        day, state.tech.id, category, slot_id,
                        state.source_of.get(day, "assigned"), state.starts.get(day)))
                else:
                    category = state.day_category.get(day, "OFF")
                    assignments.append(DayAssignment(day, state.tech.id, category, None, "off"))
        assignments.sort(key=lambda a: (a.date, a.tech_id))

        plan = Plan(month=month, year=year, mon=mon, days=days,
                    assignments=assignments, shortfalls=shortfalls,
                    warnings=list(self.warnings))
        return plan


def build_plan(config: ShiftConfig, roster: Roster, month_input: MonthInput, month: str) -> Plan:
    return Scheduler(config, roster, month_input).build(month)


__all__ = ["Scheduler", "Plan", "DayAssignment", "Shortfall", "build_plan"]

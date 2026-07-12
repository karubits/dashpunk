"""Upcoming events from a published ICS calendar feed (e.g. Outlook/O365).

Stdlib + python-dateutil only: dateutil.tz.tzical resolves the feed's own
VTIMEZONE definitions (Outlook uses Windows timezone names), dateutil.rrule
expands recurring events. Handles EXDATE and RECURRENCE-ID overrides."""

import io
import re
import threading
import time
import urllib.request
from datetime import date, datetime, time as dtime, timedelta, timezone

from dateutil import rrule as du_rrule
from dateutil import tz as du_tz

_UNESCAPE = {"\\n": " ", "\\N": " ", "\\,": ",", "\\;": ";", "\\\\": "\\"}


def _unescape(text):
    return re.sub(r"\\[nN,;\\]", lambda m: _UNESCAPE[m.group(0)], text)


def _unfold(ics):
    return re.sub(r"\r?\n[ \t]", "", ics.replace("\r\n", "\n"))


def _parse_prop(line):
    """'DTSTART;TZID=X:2026...' -> (name, {param: value}, value)"""
    head, _, value = line.partition(":")
    parts = head.split(";")
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.upper()] = v
    return parts[0].upper(), params, value


class CalendarFeed:
    def __init__(self, cfg):
        self.url = cfg.get("ics_url", "")
        self.refresh = max(60, float(cfg.get("refresh_minutes", 5)) * 60)
        self.lookahead = int(cfg.get("lookahead_days", 7))
        self.max_events = int(cfg.get("max_events", 12))
        self.ignore = [p.lower() for p in cfg.get("ignore", [])]
        self.lock = threading.Lock()
        self.occurrences = []  # [{title, location, start, end, allDay}], start/end epoch
        self.error = None
        self.updated = None
        if self.url:
            threading.Thread(target=self._loop, daemon=True).start()

    # -- fetch loop ------------------------------------------------------------

    def _loop(self):
        while True:
            try:
                req = urllib.request.Request(
                    self.url, headers={"User-Agent": "dashpunk"}
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    ics = resp.read().decode("utf-8", "replace")
                occ = self._parse(ics)
                with self.lock:
                    self.occurrences = occ
                    self.error = None
                    self.updated = time.time()
            except Exception as e:
                with self.lock:
                    self.error = f"{type(e).__name__}: {e}"
                print(f"[calendar] fetch failed: {e}")
            time.sleep(self.refresh)

    # -- parsing ---------------------------------------------------------------

    def _parse(self, ics):
        content = _unfold(ics)
        try:
            tzical = du_tz.tzical(io.StringIO(content))
        except Exception:
            tzical = None
        local_tz = du_tz.tzlocal()

        def get_tz(tzid):
            tzi = None
            if tzical:
                try:
                    tzi = tzical.get(tzid)  # returns None for unknown TZIDs
                except Exception:
                    tzi = None
            return tzi or du_tz.gettz(tzid) or local_tz

        def parse_dt(params, value):
            """Return (datetime aware, all_day)."""
            if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
                d = datetime.strptime(value, "%Y%m%d").date()
                return datetime.combine(d, dtime(0, 0), tzinfo=local_tz), True
            if value.endswith("Z"):
                return (
                    datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(
                        tzinfo=timezone.utc
                    ),
                    False,
                )
            dt = datetime.strptime(value, "%Y%m%dT%H%M%S")
            tzid = params.get("TZID")
            return dt.replace(tzinfo=get_tz(tzid) if tzid else local_tz), False

        # -- collect raw events
        events = []
        for block in re.findall(
            r"BEGIN:VEVENT\n(.*?)\nEND:VEVENT", content, re.S
        ):
            ev = {"exdates": set()}
            for line in block.split("\n"):
                if not line or ":" not in line:
                    continue
                name, params, value = _parse_prop(line)
                try:
                    if name == "DTSTART":
                        ev["start"], ev["allDay"] = parse_dt(params, value)
                    elif name == "DTEND":
                        ev["end"], _ = parse_dt(params, value)
                    elif name == "SUMMARY":
                        ev["title"] = _unescape(value).strip()
                    elif name == "LOCATION":
                        ev["location"] = _unescape(value).strip()
                    elif name == "RRULE":
                        ev["rrule"] = value
                    elif name == "EXDATE":
                        for v in value.split(","):
                            dt, _ = parse_dt(params, v)
                            ev["exdates"].add(dt.timestamp())
                    elif name == "RECURRENCE-ID":
                        dt, _ = parse_dt(params, value)
                        ev["recurrence_id"] = dt.timestamp()
                    elif name == "UID":
                        ev["uid"] = value
                    elif name == "STATUS":
                        ev["status"] = value.upper()
                except (ValueError, OverflowError):
                    continue
            if "start" in ev:
                events.append(ev)

        # -- expand into occurrences within the window
        now = datetime.now(timezone.utc)
        win_start = now - timedelta(days=1)
        win_end = now + timedelta(days=self.lookahead)

        overridden = set()  # (uid, original start ts) instances replaced/moved
        for ev in events:
            if "recurrence_id" in ev:
                overridden.add((ev.get("uid"), round(ev["recurrence_id"])))

        occ = []

        def emit(ev, start, end):
            if ev.get("status") == "CANCELLED":
                return
            title = (ev.get("title") or "").lower()
            if any(p in title for p in self.ignore):
                return
            if end < win_start or start > win_end:
                return
            occ.append({
                "title": ev.get("title") or "(untitled)",
                "location": ev.get("location") or "",
                "start": start.timestamp(),
                "end": end.timestamp(),
                "allDay": bool(ev.get("allDay")),
            })

        for ev in events:
            start = ev["start"]
            duration = (ev["end"] - start) if "end" in ev else timedelta(hours=1)
            if "rrule" in ev and "recurrence_id" not in ev:
                try:
                    rule = du_rrule.rrulestr(ev["rrule"], dtstart=start)
                    hits = rule.between(win_start, win_end, inc=True)
                except (ValueError, TypeError) as e:
                    print(f"[calendar] rrule skipped ({e})")
                    continue
                for hit in hits:
                    ts = round(hit.timestamp())
                    if ts in {round(x) for x in ev["exdates"]}:
                        continue
                    if (ev.get("uid"), ts) in overridden:
                        continue  # replaced by a RECURRENCE-ID override event
                    emit(ev, hit, hit + duration)
            else:
                emit(ev, start, start + duration)

        occ.sort(key=lambda o: o["start"])
        return occ

    # -- API -------------------------------------------------------------------

    def read(self):
        if not self.url:
            return None
        now = time.time()
        with self.lock:
            upcoming = [o for o in self.occurrences if o["end"] > now]
            return {
                "events": upcoming[: self.max_events],
                "error": self.error,
                "updated": self.updated,
            }

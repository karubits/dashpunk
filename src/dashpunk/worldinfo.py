"""World cities: weather (OpenWeather) + public holidays (Nager.Date).

Clocks are rendered client-side from the IANA timezone; this module only
supplies the slow-moving data. Nager.Date is used for holidays because it
covers US/JP/NL and ~100 more countries with no API key."""

import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

OW_URL = ("https://api.openweathermap.org/data/2.5/weather"
          "?q={q}&appid={key}&units=metric")
OW_FC_URL = ("https://api.openweathermap.org/data/2.5/forecast"
             "?q={q}&appid={key}&units=metric")
HOL_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/{cc}"

WEATHER_REFRESH = 600        # 10 min
HOLIDAY_REFRESH = 12 * 3600  # 12 h


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "dashpunk"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _daily_forecast(data, tzname, days=4):
    """Aggregate OpenWeather's 3-hourly forecast into per-day min/max plus a
    representative (nearest-to-13:00) daytime icon, in the city's timezone."""
    try:
        tzi = ZoneInfo(tzname)
    except Exception:
        tzi = None
    buckets = {}
    for item in data.get("list", []):
        try:
            dt = datetime.fromtimestamp(item["dt"], tzi)
            rec = buckets.setdefault(dt.date(), {"temps": [], "icons": []})
            rec["temps"].append(item["main"]["temp"])
            rec["icons"].append((abs(dt.hour - 13), item["weather"][0]["icon"]))
        except (KeyError, IndexError, ValueError):
            continue
    today = datetime.now(tzi).date()
    out = []
    for d in sorted(buckets):
        if d <= today:
            continue
        rec = buckets[d]
        out.append({
            "date": d.isoformat(),
            "min": min(rec["temps"]),
            "max": max(rec["temps"]),
            "icon": min(rec["icons"])[1].replace("n", "d"),
        })
    return out[:days]


class WorldInfo:
    def __init__(self, cfg):
        self.key = cfg.get("openweather_api_key", "")
        self.cities = cfg.get("cities", [])
        self.lock = threading.Lock()
        self.weather = {}   # city name -> dict
        self.holidays = {}  # country code -> [raw holiday dicts]
        if self.cities:
            threading.Thread(target=self._weather_loop, daemon=True).start()
            threading.Thread(target=self._holiday_loop, daemon=True).start()

    # -- fetch loops -----------------------------------------------------------

    def _weather_loop(self):
        while True:
            if self.key:
                for c in self.cities:
                    try:
                        d = _get_json(OW_URL.format(
                            q=urllib.parse.quote(c.get("query", c["name"])),
                            key=self.key))
                        w = {
                            "temp": d["main"]["temp"],
                            "feels": d["main"]["feels_like"],
                            "desc": d["weather"][0]["description"],
                            "icon": d["weather"][0]["icon"],
                            "humidity": d["main"]["humidity"],
                            "windMs": (d.get("wind") or {}).get("speed"),
                        }
                        try:
                            fc = _get_json(OW_FC_URL.format(
                                q=urllib.parse.quote(c.get("query", c["name"])),
                                key=self.key))
                            w["forecast"] = _daily_forecast(fc, c["tz"])
                        except Exception as e:
                            print(f"[world] forecast {c['name']}: {e}")
                            w["forecast"] = []
                        with self.lock:
                            self.weather[c["name"]] = w
                    except Exception as e:
                        print(f"[world] weather {c['name']}: {e}")
            time.sleep(WEATHER_REFRESH)

    def _holiday_loop(self):
        while True:
            now = datetime.now()
            years = sorted({now.year, (now + timedelta(days=30)).year})
            for cc in {c["country"] for c in self.cities}:
                try:
                    items = []
                    for y in years:
                        items += _get_json(HOL_URL.format(year=y, cc=cc)) or []
                    with self.lock:
                        self.holidays[cc] = items
                except Exception as e:
                    print(f"[world] holidays {cc}: {e}")
            time.sleep(HOLIDAY_REFRESH)

    # -- API -------------------------------------------------------------------

    def _city_holidays(self, c):
        """Holidays applying to this city: nationwide, or matching its region
        (e.g. region = 'US-GA' for state holidays)."""
        region = c.get("region")
        out = []
        for h in self.holidays.get(c["country"], []):
            counties = h.get("counties") or []
            if h.get("global") or not counties or (region and region in counties):
                out.append(h)
        return out

    def read(self):
        if not self.cities:
            return None
        cities = []
        with self.lock:
            for c in self.cities:
                try:
                    today = datetime.now(ZoneInfo(c["tz"])).date()
                except Exception:
                    today = date.today()
                holiday_today, next_holiday = None, None
                for h in sorted(self._city_holidays(c), key=lambda x: x["date"]):
                    try:
                        d = date.fromisoformat(h["date"])
                    except ValueError:
                        continue
                    label = h.get("localName") or h.get("name") or "?"
                    if d == today and holiday_today is None:
                        holiday_today = label
                    elif d > today and next_holiday is None:
                        next_holiday = {"name": label, "date": h["date"],
                                        "days": (d - today).days}
                        break
                cities.append({
                    "name": c["name"],
                    "country": c["country"],
                    "tz": c["tz"],
                    "home": bool(c.get("home")),
                    "weather": self.weather.get(c["name"]),
                    "holidayToday": holiday_today,
                    "nextHoliday": next_holiday,
                })
        return {"cities": cities}

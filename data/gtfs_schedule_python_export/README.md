# Route / Direction / Station / Arrival / Dwell export

This is an independent Python export script. It does not modify the website or GTFS ZIP.
Requires Python 3.10+.

## Setup
Place export_gtfs_schedule.py in your viewer folder.
Open a terminal in that folder and install:

    py -m pip install openpyxl tzdata

## Export all rail route/station schedule templates

    py export_gtfs_schedule.py "data/GTFS.zip" --output exports

Results: CSV and formatted/filterable XLSX workbook in exports.
Default scope remains rail-only, matching the existing viewer. To include buses/other modes:

    py export_gtfs_schedule.py "data/GTFS.zip" --output exports_all_modes --include-non-rail

## Export one actual service date

    py export_gtfs_schedule.py "data/GTFS.zip" --date 2026-10-28 --output exports

Choose a date inside your feed's valid service period. Calendar exceptions are applied.
This is a service-date export, not all arrivals occurring on that calendar day.
Times on later dates are explicitly dated. No full-feed all-dates expansion is performed.
Use --overwrite if you intentionally want to replace exports with the same names.
Use python in place of py on systems where that is your Python command.

## Main columns
Route / Direction / Station / Arrival Time / Dwell Minutes.
Direction is the final station of the individual trip, not a compass direction,
headsign, next station, or shared endpoint for an entire route.
Trip/service IDs, dates, raw times, timezone, day offsets, endpoint status, and
boarding/alighting restrictions follow as supporting columns.

## Interpretation
- Default export has one row per trip-stop TEMPLATE, not per actual operating day.
  Different Service IDs can describe similar trips on different dates. Do not sum
  these template rows as daily frequency. Calendar sheets preserve service patterns.
- Default Arrival Time is a 24-hour clock with a separate day offset. A raw 36:48:00
  is clock 12:48:00, day offset 1. Use both fields, or select a service date.
- All displayed times are AGENCY timezone, not station-local. Local timezone metadata
  is informational. No geographic timezone inference is performed.
- With --date, actual agency dates/times respect GTFS noon-minus-12h timing, including DST.
- Dwell is numeric minutes, departure minus arrival at intermediate stops.
  Missing, invalid, and endpoint dwell is blank with a status. Zero is recorded zero.
- Parent-station names are used for Station and Direction where present; actual Stop ID
  and final Direction Stop ID remain. Multiple platform calls are not collapsed.
- Frequency-based templates are retained and clearly flagged, but are not expanded
  into departures. Frequencies are included on a separate sheet.
- Only scheduled calls are exported. Unused stations without matching trips are not.
- XLSX IDs are literal strings. CSV protects leading formula characters with an apostrophe.
- Workbook sheets have filters/frozen headers. Very large results split over sheets.
- No GTFS data is included. Synthetic fixtures are tested; your feed still needs checking.

// content script for the shift schedule to icalendar extension.
// this script runs on pages matching the configured url pattern (the my schedule page)
// and listens for messages from the popup. when triggered, it gathers all shift
// information available in the dom, constructs an icalendar (.ics) file, and
// initiates a download for the user. it sends back a success or error message
// to the popup for ui feedback.

// helper to escape special characters in icalendar text fields. this function
// escapes backslashes, commas, semicolons and newlines according to rfc 5545.
function escapeICalText(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// convert a human-friendly time string (e.g., "9:00 am") into hhmmss format.
function convertTo24Hour(timeStr) {
  const [time, modifier] = timeStr.trim().split(/\s+/);
  let [hours, minutes] = time.split(':').map(Number);
  if (modifier.toUpperCase() === 'PM' && hours < 12) {
    hours += 12;
  }
  if (modifier.toUpperCase() === 'AM' && hours === 12) {
    hours = 0;
  }
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`;
}

// create a unique uid for each event. adp calendar uses a 24‑character
// hexadecimal identifier followed by '@adp-html-to-ics'. we generate 12
// random bytes and convert them to a 24‑digit hex string.
function generateUID() {
  let hex = '';
  // use webcrypto if available; otherwise fall back to math.random().
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    array.forEach((b) => {
      hex += b.toString(16).padStart(2, '0');
    });
  } else {
    for (let i = 0; i < 12; i++) {
      hex += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    }
  }
  return `${hex}@adp-html-to-ics`;
}

// compute the duration in hours between two times (e.g., "9:00 am", "3:00 pm").
// returns a floating point number with two decimals (e.g., 6.00, 6.25).
function computeDurationHours(startTimeStr, endTimeStr) {
  const parse = (t) => {
    const [time, ampm] = t.trim().split(/\s+/);
    let [h, m] = time.split(':').map(Number);
    if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  };
  let startMinutes = parse(startTimeStr);
  let endMinutes = parse(endTimeStr);
  // handle overnight shifts: add 24h if end is earlier than start
  if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60;
  }
  const diff = endMinutes - startMinutes;
  const hours = diff / 60;
  return Math.round(hours * 100) / 100;
}

// fold a long icalendar property line to rfc 5545's recommended 75 octets per line.
// it prepends a space to continuation lines.
function foldLine(name, value) {
  let line = `${name}:${value}`;
  const lines = [];
  while (line.length > 75) {
    lines.push(line.slice(0, 75));
    line = ' ' + line.slice(75);
  }
  lines.push(line);
  return lines.join('\r\n') + '\r\n';
}

// asynchronously collect all shifts and their segments. this function will iterate through
// each visible shift on the page, open its details panel if available, parse any
// sub‑segments within the detailed view, and assemble one event per shift. if
// no segments are found for a shift, it falls back to treating the entire time range
// as a single event, preserving the original behaviour. note that this function
// assumes that opening a shift will reveal its segment details in the dom; if the
// page structure changes and segments are not present in the dom until another
// interaction occurs, this logic may need to be updated.
async function collectShifts() {
  const events = [];
  const timeElements = Array.from(document.querySelectorAll('time.label'));
  for (let i = 0; i < timeElements.length; i++) {
    const timeEl = timeElements[i];
    // determine the date associated with this shift by locating the nearest day <li>.
    const dayLi = timeEl.closest('li[id^="myschedule-day_"]');
    if (!dayLi) continue;
    const dayId = dayLi.getAttribute('id');
    const datePart = dayId ? dayId.split('_')[1] : null;
    if (!datePart) continue;

    // extract top level time range for fallback. remove bracketed duration (e.g., "[6.25]").
    let baseTimeText = timeEl.getAttribute('aria-label') || timeEl.textContent || '';
    baseTimeText = baseTimeText.replace(/\s*\[.*?\]\s*/g, '').trim();
    const baseRangeParts = baseTimeText.split('-');
    const baseStart = baseRangeParts.length > 0 ? baseRangeParts[0].trim() : '';
    const baseEnd = baseRangeParts.length > 1 ? baseRangeParts[1].trim() : '';

    // attempt to open the shift detail panel by clicking the time element. some
    // implementations bind the click to the parent container rather than the time
    // element itself; however, dispatching a click on the time element typically
    // triggers the correct action.
    try {
      timeEl.click();
    } catch (err) {
      // Ignore errors; if click fails, segments will not be collected and fallback will run.
    }

    // wait a short moment for the detailed panel to render. adjust this delay if
    // the page takes longer to respond on slower networks or devices.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // collect any segment rows from the detailed shift panel. when a shift is
    // opened, ukg/adp renders a list of <li> elements with an automation id
    // starting with "myschedule-detailed-shift-segment-". each contains a
    // <time class="props"> element with the segment time range and a
    // <p class="primary-orgpath"> with the org path (or "break" for breaks).
    const segmentListItems = document.querySelectorAll(
      'ng-myschedule-detailed-shift-segments li.info'
    );
    if (segmentListItems && segmentListItems.length > 0) {
      // if detailed segment data is available, consolidate all segments into a single
      // calendar event. the summary is derived from the first segment's org path.
      // the event's start time is the start of the first segment, and the end time
      // is the end of the last segment. the description contains a total hours
      // line and a line for each segment detailing its range and org path.
      const segments = [];
      segmentListItems.forEach((seg) => {
        const segTimeEl = seg.querySelector('time.props');
        if (!segTimeEl) return;
        let segTimeText = segTimeEl.getAttribute('aria-label') || segTimeEl.textContent || '';
        segTimeText = segTimeText.replace(/\s*\[.*?\]\s*/g, '').trim();
        const parts = segTimeText.split('-');
        if (parts.length < 2) return;
        const segStart = parts[0].trim();
        const segEnd = parts[1].trim();
        const locEl = seg.querySelector('p.primary-orgpath');
        let locPath = '';
        if (locEl) locPath = locEl.textContent.trim();
        segments.push({ start: segStart, end: segEnd, locPath });
      });
      if (segments.length > 0) {
        // Determine overall start and end times from the first and last segments.
        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];
        const start24 = convertTo24Hour(firstSeg.start);
        const end24 = convertTo24Hour(lastSeg.end);
        const dtStart = `${datePart.replace(/-/g, '')}T${start24}`;
        const dtEnd = `${datePart.replace(/-/g, '')}T${end24}`;
        // Determine summary from first segment's org path
        let summary = 'MEC Shift';
        if (firstSeg.locPath && !/break/i.test(firstSeg.locPath)) {
          const locParts = firstSeg.locPath.split('/').filter((p) => p.trim().length > 0);
          summary = `MEC Shift - ${locParts[locParts.length - 1].trim()}`;
        } else if (firstSeg.locPath) {
          summary = firstSeg.locPath.trim();
        }
        // Calculate total hours using the full shift range
        let totalDuration = 0;
        if (baseStart && baseEnd) {
          totalDuration = computeDurationHours(baseStart, baseEnd);
        } else {
          // Fallback: sum segment durations
          totalDuration = segments.reduce((sum, s) => {
            return sum + computeDurationHours(s.start, s.end);
          }, 0);
        }
        const totalHoursStr = totalDuration.toFixed(2);
        // Build description: start with first segment org path (if any) then total hours
        let description = '';
        if (firstSeg.locPath) {
          description += `${firstSeg.locPath}`;
        }
        description += '\n';
        description += `Hours: ${totalHoursStr}`;
        description += '\n';
        // Append each segment line
        segments.forEach((s) => {
          const dur = computeDurationHours(s.start, s.end).toFixed(2);
          let line = `${s.start}-${s.end} [${dur}]`;
          if (s.locPath) line += ` ${s.locPath}`;
          description += line + '\n';
        });
        // Remove trailing newline
        description = description.replace(/\n$/, '');
        // Location for the event: use the first segment's org path if not a break
        let eventLocation = '';
        if (firstSeg.locPath && !/break/i.test(firstSeg.locPath)) {
          eventLocation = firstSeg.locPath;
        }
        events.push({
          uid: generateUID(),
          dtStart,
          dtEnd,
          summary,
          location: eventLocation,
          description,
        });
      }
    } else {
      // if no segment details were found, treat the entire time range as a single shift.
      if (!baseStart || !baseEnd) continue;
      const baseStart24 = convertTo24Hour(baseStart);
      const baseEnd24 = convertTo24Hour(baseEnd);
      const dtStart = `${datePart.replace(/-/g, '')}T${baseStart24}`;
      const dtEnd = `${datePart.replace(/-/g, '')}T${baseEnd24}`;
      // determine location from the shift container as before.
      let locPath = '';
      let container = timeEl.closest('.shift-wrapper');
      if (!container) {
        container = timeEl.closest('ng-myschedule-shift');
      }
      if (container) {
        const locEl = container.querySelector('p.primary-orgpath');
        if (locEl) {
          locPath = locEl.textContent.trim();
        }
      }
      let lastSegment = '';
      if (locPath) {
        const parts = locPath.split('/').filter((p) => p.trim().length > 0);
        lastSegment = parts[parts.length - 1].trim();
      }
      const summary = lastSegment ? `MEC Shift - ${lastSegment}` : 'MEC Shift';
      const durationHours = computeDurationHours(baseStart, baseEnd).toFixed(2);
      const timeRange = `${baseStart}-${baseEnd} [${durationHours}]`;
      let description = '';
      if (locPath) {
        description += `${locPath}`;
      }
      description += '\n';
      description += `Hours: ${durationHours}`;
      description += '\n';
      description += `${timeRange}`;
      if (locPath) {
        description += ` ${locPath}`;
      }
      events.push({
        uid: generateUID(),
        dtStart,
        dtEnd,
        summary,
        location: locPath,
        description,
      });
    }
    // attempt to close the detailed panel. the drawer can often be dismissed
    // by sending an escape key event. if that fails, ignore the error and
    // continue with the next shift.
    try {
      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true });
      document.dispatchEvent(escEvent);
    } catch (err) {
      // Silently ignore any errors dispatching the key event.
    }
    // Allow time for the drawer to close before processing the next shift.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return events;
}

// Listener for messages from the extension.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collectShifts') {
    // wrap in an async iife to allow awaiting dom interactions while still
    // returning true immediately to keep the message channel open.
    (async () => {
      try {
        // gather current visible shifts first. since collectShifts returns a promise,
        // await it to retrieve the events array.
        let events = await collectShifts();

        // attempt to load future days by clicking the "load-more-future-days" button if present.
        const loadMoreBtn = document.querySelector(
          'ukg-button[automation-id="load-more-future-days"], button[automation-id="load-more-future-days"]'
        );
        if (loadMoreBtn) {
          loadMoreBtn.click();
          // wait briefly to allow the dom to update with future days. adjust the delay if necessary.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          // collect shifts again now that additional days may be visible.
          const moreEvents = await collectShifts();
          // merge without duplicates (based on start and end times and summary). pre-populate
          // the set with keys from the events already collected.
          const seen = new Set(events.map((ev) => `${ev.dtStart}|${ev.dtEnd}|${ev.summary}`));
          moreEvents.forEach((ev) => {
            const key = `${ev.dtStart}|${ev.dtEnd}|${ev.summary}`;
            if (!seen.has(key)) {
              seen.add(key);
              events.push(ev);
            }
          });
        }

        if (!events || events.length === 0) {
          sendResponse({ success: false, message: 'No shift events found on this page.' });
          return;
        }
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Vancouver';
        let ics = '';
        ics += 'BEGIN:VCALENDAR\r\n';
        ics += 'VERSION:2.0\r\n';
        ics += 'PRODID:-//OpenAI//ADP HTML to ics//EN\r\n';
        ics += 'CALSCALE:GREGORIAN\r\n';
        ics += 'METHOD:PUBLISH\r\n';
        ics += `X-WR-CALNAME:ADP MEC Schedule\r\n`;
        ics += `X-WR-TIMEZONE:${tz}\r\n`;
        const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        events.forEach((ev) => {
          ics += 'BEGIN:VEVENT\r\n';
          ics += `UID:${ev.uid}\r\n`;
          ics += `DTSTAMP:${now}\r\n`;
          ics += `DTSTART;TZID=${tz}:${ev.dtStart}\r\n`;
          ics += `DTEND;TZID=${tz}:${ev.dtEnd}\r\n`;
          // summary
          ics += foldLine('SUMMARY', escapeICalText(ev.summary));
          // location folded
          if (ev.location) {
            ics += foldLine('LOCATION', escapeICalText(ev.location));
          }
          // description with escaped newlines then folded
          if (ev.description) {
            ics += foldLine('DESCRIPTION', escapeICalText(ev.description));
          }
          ics += 'END:VEVENT\r\n';
        });
        ics += 'END:VCALENDAR\r\n';
        // Initiate download
        const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'adp_schedule.ics';
        // Append link to DOM to satisfy Safari security requirements
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        }, 0);
        sendResponse({ success: true });
      } catch (err) {
        console.error(err);
        sendResponse({ success: false, message: 'An error occurred while collecting shift data.' });
      }
    })();
    // Return true to indicate asynchronous response
    return true;
  }
});
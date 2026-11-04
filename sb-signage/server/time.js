// Datas e horários sempre no fuso configurado (SIGNAGE_TZ), nunca no fuso do processo:
// em Docker/VPS o processo costuma rodar em UTC e a agenda sairia 3 h deslocada.
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      weekday: 'short'
    }));
  }
  return formatters.get(timeZone);
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// → { date: 'AAAA-MM-DD', hhmm: 'HH:MM', day: 0..6 }
function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    day: WEEKDAY[parts.weekday]
  };
}

module.exports = { zonedParts };

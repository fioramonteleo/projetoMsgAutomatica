import { TIMEZONE } from '../config/env.js';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Extracts date and time parts strictly in America/Sao_Paulo.
 * Accepts a Date (or timestamp) so callers and tests can evaluate any instant deterministically.
 */
export function getSaoPauloParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = partsFormatter.formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  const hourNum = Number(map.hour);
  const minuteNum = Number(map.minute);
  const secondNum = Number(map.second);
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const timeStr = `${map.hour}:${map.minute}:${map.second}`;
  const shortTimeStr = `${map.hour}:${map.minute}`;

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: hourNum,
    minute: minuteNum,
    second: secondNum,
    minutesOfDay: hourNum * 60 + minuteNum,
    dateStr,
    timeStr,
    shortTimeStr,
    dateBr: `${map.day}/${map.month}/${map.year}`,
    dateTimeBr: `${map.day}/${map.month}/${map.year} ${timeStr}`,
    isoLocal: `${dateStr} ${timeStr}`,
  };
}

export function getReferenceDate(date = new Date()) {
  return getSaoPauloParts(date).dateStr;
}

export function getSaoPauloTimestamp(date = new Date()) {
  return getSaoPauloParts(date).isoLocal;
}

export function isValidTimeFormat(hhmm) {
  return typeof hhmm === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(hhmm.trim());
}

export function parseTimeToMinutes(hhmm) {
  if (!isValidTimeFormat(hhmm)) {
    throw new Error(`Horário inválido: ${hhmm}`);
  }
  const [h, m] = hhmm.trim().split(':').map(Number);
  return h * 60 + m;
}

/**
 * Checks whether the given instant falls inside [horarioInicio, horarioFim).
 * Default Negão Lanches rule: 17:00 to 00:00 => [1020, 1440) in America/Sao_Paulo.
 * At 00:00 (minutesOfDay === 0) the window is immediately closed.
 */
export function isWithinAllowedWindow(horarioInicio = '17:00', horarioFim = '00:00', date = new Date()) {
  const { minutesOfDay } = getSaoPauloParts(date);
  const start = parseTimeToMinutes(horarioInicio);
  let end = parseTimeToMinutes(horarioFim);

  if (end === 0 && start > 0) {
    end = 24 * 60;
  }

  if (start === end) {
    return false;
  }

  if (start < end) {
    return minutesOfDay >= start && minutesOfDay < end;
  }

  // Overnight window (e.g., 18:00 to 02:00)
  return minutesOfDay >= start || minutesOfDay < end;
}

export function getWindowStatusInfo(horarioInicio = '17:00', horarioFim = '00:00', date = new Date()) {
  const parts = getSaoPauloParts(date);
  const isOpen = isWithinAllowedWindow(horarioInicio, horarioFim, date);
  const start = parseTimeToMinutes(horarioInicio);
  let end = parseTimeToMinutes(horarioFim);
  if (end === 0 && start > 0) end = 24 * 60;

  let nextOpenText;
  if (isOpen) {
    nextOpenText = `Aberta agora (encerra às ${horarioFim})`;
  } else if (start < end) {
    if (parts.minutesOfDay < start) {
      nextOpenText = `Hoje às ${horarioInicio}`;
    } else {
      nextOpenText = `Amanhã às ${horarioInicio}`;
    }
  } else {
    // Overnight window currently closed (means between end and start on same day)
    nextOpenText = `Hoje às ${horarioInicio}`;
  }

  return {
    timezone: TIMEZONE,
    currentDate: parts.dateStr,
    currentDateBr: parts.dateBr,
    currentTime: parts.timeStr,
    currentShortTime: parts.shortTimeStr,
    currentDateTimeBr: parts.dateTimeBr,
    isOpen,
    windowStart: horarioInicio,
    windowEnd: horarioFim,
    nextOpenText,
  };
}

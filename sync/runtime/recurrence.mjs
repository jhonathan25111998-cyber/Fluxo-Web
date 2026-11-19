import { isLocalDate, nextMonthlyDate } from '../monthly.mjs';
import { supportedTimeZones } from '../timezones.mjs';

const aliases = {
  daily: 'daily', diaria: 'daily', weekly: 'weekly', semanal: 'weekly',
  monthly: 'monthly', mensal: 'monthly', weekdays: 'weekdays', dias_uteis: 'weekdays'
};
export function cadenceOf(value) {
  const key = String(value).trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[\s-]+/g, '_');
  const cadence = Object.hasOwn(aliases, key) ? aliases[key] : null;
  if (!cadence) throw new RangeError('Recorrência desconhecida. Confira a cópia original.');
  return cadence;
}

export function validTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length > 100
    || !/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
    throw new RangeError('Informe um fuso IANA, como America/Sao_Paulo.');
  }
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: zone }); }
  catch { throw new RangeError('Fuso IANA desconhecido.'); }
  return zone;
}
export function canonicalTimeZone(zone) {
  const canonical=new Intl.DateTimeFormat('en',{timeZone:validTimeZone(zone)}).resolvedOptions().timeZone;
  if(!supportedTimeZones.includes(canonical))throw new RangeError('Fuso válido ainda não suportado para novas configurações nesta versão. O valor anterior foi preservado.');
  return canonical;
}
export function displayTimeZone(zone) {
  try { return {zone:validTimeZone(zone??'America/Sao_Paulo'),problem:null}; }
  catch { return {zone:'America/Sao_Paulo',problem:'Fuso salvo inválido. Datas exibidas em America/Sao_Paulo apenas para consulta; corrija o fuso no perfil da central antes de concluir ou reagendar. Nenhuma data foi alterada.'}; }
}

export function civilToday(zone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimeZone(zone), calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return [values.year.padStart(4, '0'), values.month, values.day].join('-');
}

// UTC is only a calendar arithmetic coordinate here, never a conversion of a local instant.
function calendarDay(date) {
  if (!isLocalDate(date)) throw new RangeError('Data civil inválida.');
  return new Date(date + 'T00:00:00Z');
}
export function nextOccurrence({ cadence, anchorDay, anchorWeekday }, scheduled, completedOn) {
  const rule = cadenceOf(cadence);
  const scheduledDay = calendarDay(scheduled);
  const completionDay = calendarDay(completedOn);
  if (rule === 'monthly') {
    // A ocorrência já selecionada não é recriada, inclusive ao concluir adiantado.
    if (completedOn < scheduled) return nextMonthlyDate(scheduled, anchorDay);
    if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw new RangeError('Referência mensal inválida.');
    let day = anchorDay, candidate;
    do { candidate = completedOn.slice(0, 8) + String(day--).padStart(2, '0'); } while (!isLocalDate(candidate));
    return candidate > completedOn && candidate > scheduled ? candidate : nextMonthlyDate(completedOn, anchorDay);
  }
  const next = calendarDay(rule === 'weekly' && scheduled > completedOn ? scheduled : completedOn);
  if (rule === 'weekly') {
    const weekday = anchorWeekday ?? scheduledDay.getUTCDay();
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new RangeError('Referência semanal inválida.');
    next.setUTCDate(next.getUTCDate() + ((weekday - next.getUTCDay() + 7) % 7 || 7));
  } else next.setUTCDate(next.getUTCDate() + 1);
  if (rule === 'weekdays') {
    while ([0, 6].includes(next.getUTCDay())) next.setUTCDate(next.getUTCDate() + 1);
  }
  const date = next.toISOString().slice(0, 10);
  if (!isLocalDate(date)) throw new RangeError('Data seguinte fora do intervalo.');
  return date;
}

export function occurrenceId(seriesId, ordinal) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(seriesId) || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RangeError('Identificação da série inválida.');
  }
  return seriesId + '-' + ordinal;
}

export function cadenceAt(series, ordinal) {
  let cadence = series.initialCadence ?? series.cadence;
  for (const entry of series.scheduleHistory ?? []) if (entry.fromOrdinal <= ordinal) cadence = entry.cadence;
  return cadence;
}

export function summarizeEvents(records, historical = {}) {
  const seen = new Map(), completions = new Map(), reversed = new Set();
  const confirmed = { focusSeconds: 0, completions: 0, reschedules: 0 };
  for (const { id, kind, data, deleted } of records) {
    if (deleted || !['focus', 'completion', 'reschedule', 'completionReversal'].includes(kind)) continue;
    const key = JSON.stringify([kind, data.date, data.seconds ?? null, data.taskId ?? null, data.completionId ?? null, data.reopenedOn ?? null]);
    if (seen.has(id)) {
      if (seen.get(id) !== key) throw new Error('Evento histórico divergente. Confira as duas versões.');
      continue;
    }
    seen.set(id, key);
    if (kind === 'focus') confirmed.focusSeconds += data.seconds;
    else if (kind === 'completion') completions.set(id, data);
    else if (kind === 'completionReversal') reversed.add(data.completionId);
    else confirmed.reschedules++;
  }
  confirmed.completions = [...completions.keys()].filter(id => !reversed.has(id)).length;
  return { historical: structuredClone(historical), confirmed };
}

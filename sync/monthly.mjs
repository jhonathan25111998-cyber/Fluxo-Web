function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isLocalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

// Contract for the future recurrence command. Deliberately independent of Date and UTC.
export function nextMonthlyDate(currentDate, anchorDay) {
  if (!isLocalDate(currentDate) || !Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError('Data local ou dia de referência inválido.');
  }
  let [year, month] = currentDate.split('-').map(Number);
  if (month === 12) {
    year++;
    month = 1;
  } else {
    month++;
  }
  if (year > 9999) throw new RangeError('Ano fora do intervalo suportado.');
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

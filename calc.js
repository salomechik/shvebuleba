// დღეების დათვლის ფუნქციები (Firebase-ზე დამოუკიდებელი)

export const MONTHS = ['იანვარი','თებერვალი','მარტი','აპრილი','მაისი','ივნისი','ივლისი','აგვისტო','სექტემბერი','ოქტომბერი','ნოემბერი','დეკემბერი'];
export const MONTHS_GEN = ['იანვარი','თებერვალი','მარტი','აპრილი','მაისი','ივნისი','ივლისი','აგვისტო','სექტემბერი','ოქტომბერი','ნოემბერი','დეკემბერი'];
export const WEEKDAYS = ['ორშ','სამ','ოთხ','ხუთ','პარ','შაბ','კვი'];
export const TYPES = { vacation: 'შვებულება', dayoff: 'დეი ოფი' };

const pad = n => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`; // m: 1-12
export function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
export function todayIso() { const t = new Date(); return iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
export function weekday(s) { const { y, m, d } = parseIso(s); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; } // 0=ორშ … 6=კვი
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function addDays(s, n) {
  const { y, m, d } = parseIso(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function fmtDate(s) { const { m, d } = parseIso(s); return `${d} ${MONTHS_GEN[m - 1]}`; }

// მართლმადიდებლური აღდგომა (გრიგორიანული თარიღით)
export function orthodoxEaster(y) {
  const a = y % 4, b = y % 7, c = y % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = iso(y, month, day);
  return addDays(julian, 13); // 1900–2099 სხვაობა 13 დღეა
}

// საქართველოს შრომის კოდექსის 30-ე მუხლით განსაზღვრული უქმე დღეები
export function defaultHolidays(y) {
  const e = orthodoxEaster(y);
  const list = [
    [iso(y, 1, 1), 'ახალი წელი'],
    [iso(y, 1, 2), 'ახალი წელი'],
    [iso(y, 1, 7), 'შობა'],
    [iso(y, 1, 19), 'ნათლისღება'],
    [iso(y, 3, 3), 'დედის დღე'],
    [iso(y, 3, 8), 'ქალთა საერთაშორისო დღე'],
    [iso(y, 4, 9), 'ეროვნული ერთიანობის დღე'],
    [addDays(e, -2), 'დიდი პარასკევი'],
    [addDays(e, -1), 'დიდი შაბათი'],
    [e, 'აღდგომა'],
    [addDays(e, 1), 'აღდგომის ორშაბათი'],
    [iso(y, 5, 9), 'ფაშიზმზე გამარჯვების დღე'],
    [iso(y, 5, 12), 'წმ. ანდრია პირველწოდებულის დღე'],
    [iso(y, 5, 17), 'ოჯახის სიწმინდის დღე'],
    [iso(y, 5, 26), 'დამოუკიდებლობის დღე'],
    [iso(y, 8, 28), 'მარიამობა'],
    [iso(y, 10, 14), 'სვეტიცხოვლობა'],
    [iso(y, 11, 23), 'გიორგობა'],
  ];
  // თუ ორი უქმე ერთ დღეს დაემთხვა (მაგ. აღდგომა და 9 მაისი), ერთად ვწერთ
  const map = new Map();
  for (const [d, n] of list) map.set(d, map.has(d) ? `${map.get(d)} / ${n}` : n);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, name]) => ({ date, name }));
}

// holidays: [{date, name}] → Map
export function holidayMap(list) { return new Map((list || []).map(h => [h.date, h.name])); }

export function isWorkday(s, hMap) { return weekday(s) < 5 && !hMap.has(s); }

export function countWorkdays(dates, hMap) { return dates.filter(d => isWorkday(d, hMap)).length; }

// თარიღების დაყოფა წლების მიხედვით
export function groupByYear(dates) {
  const g = {};
  for (const d of [...dates].sort()) (g[d.slice(0, 4)] ||= []).push(d);
  return g;
}

// ნაშთი: requests — ერთი თანამშრომლის მოთხოვნები, hMapForYear — ამ წლის უქმეები
export function balance(requests, type, year, quota, hMap) {
  let used = 0, pending = 0;
  for (const r of requests) {
    if (r.type !== type || String(r.year) !== String(year)) continue;
    const n = countWorkdays(r.dates || [], hMap);
    if (r.status === 'approved') used += n;
    else if (r.status === 'pending') pending += n;
  }
  return { quota, used, pending, left: quota - used, free: quota - used - pending };
}

// თარიღების მოკლე ჩაწერა: „3–5 მარტი, 10 მარტი“
export function fmtRanges(dates) {
  const s = [...dates].sort();
  const out = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && addDays(s[j], 1) === s[j + 1]) j++;
    const a = parseIso(s[i]), b = parseIso(s[j]);
    if (i === j) out.push(fmtDate(s[i]));
    else if (a.m === b.m) out.push(`${a.d}–${b.d} ${MONTHS_GEN[a.m - 1]}`);
    else out.push(`${fmtDate(s[i])} – ${fmtDate(s[j])}`);
    i = j + 1;
  }
  return out.join(', ');
}

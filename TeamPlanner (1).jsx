import { useState, useEffect, useCallback, useRef } from "react";

// ── Supabase Store ──────────────────────────────────────────
import { supabase } from "./supabase.js";

const store = {
  async get(k) {
    try {
      const { data, error } = await supabase.from("storage").select("value").eq("key", k).maybeSingle();
      if (error) throw error;
      return data ? JSON.parse(data.value) : null;
    } catch(e) { console.error("[store.get]", e); return null; }
  },
  async set(k, v) {
    try {
      const { error } = await supabase.from("storage").upsert({ key: k, value: JSON.stringify(v) }, { onConflict: "key" });
      if (error) throw error;
    } catch(e) { console.error("[store.set]", e); }
  },
  async list(prefix) {
    try {
      const { data, error } = await supabase.from("storage").select("key").like("key", `${prefix}%`);
      if (error) throw error;
      return (data || []).map(r => r.key);
    } catch(e) { console.error("[store.list]", e); return []; }
  },
};

// ── Activity Logger ──────────────────────────────────────────
async function logActivity(user, action, details = {}) {
  if (!user?.name) return;
  try {
    await supabase.from("activity_logs").insert({
      user_name: user.name,
      user_emoji: user.emoji || "👤",
      user_color: user.color || "#A8D8EA",
      action,
      details,
    });
  } catch(e) { console.error("[log]", e); }
}

function parseMinutes(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})[:\.](\d{2})\s*[-–—]\s*(\d{1,2})[:\.](\d{2})/);
  if (!m) return null;
  const s = parseInt(m[1]) * 60 + parseInt(m[2]);
  const e = parseInt(m[3]) * 60 + parseInt(m[4]);
  return e > s ? e - s : null;
}
function fmtMin(min) {
  if (!min && min !== 0) return "—";
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60;
  return h > 0 ? (m > 0 ? `${h}ч ${m}м` : `${h}ч`) : `${m}м`;
}
function getWeekDates(year, week) {
  const jan4 = new Date(year, 0, 4), dow = (jan4.getDay() + 6) % 7;
  const mon = new Date(jan4); mon.setDate(jan4.getDate() - dow + (week - 1) * 7);
  return Array.from({ length: 6 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
}
function getCurrentWeek() {
  const now = new Date(), jan4 = new Date(now.getFullYear(), 0, 4);
  const dow = (jan4.getDay() + 6) % 7;
  const startW1 = new Date(jan4); startW1.setDate(jan4.getDate() - dow);
  return { year: now.getFullYear(), week: Math.max(1, Math.ceil((now - startW1) / (7 * 86400000))) };
}

const DAY_NAMES = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const DAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const EMP_PALETTE = ["#F4B8D1","#A8D8EA","#B8E0C8","#FFD9A8","#C5B8E8","#F9C8C8","#B8E8D8","#FFE0A8","#C8D8F4","#E8C8B8"];
const EMOJIS = ["👤","👩","👨","👩‍💼","👨‍💼","🧑‍💼","🧑","⭐","🌟","💫","🔥","❤️","💚","💙","💜","🎯","📋","✅","🚀","💡","🎨","💼","📊","🎓","👑","🦁","🐱","🦊","🌸","🍀","🌈","⚡","🏆","🌙","☀️","🎪","🦋","🌺","🎬","🧩"];

function mkId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function emptyTask(createdBy = "") { return { id: mkId(), task: "", result: "", priority: "", timeRange: "", plan: "", fact: "", workType: "", done: false, status: "", isFocus: false, fromStrategy: false, taskType: "", sessions: [], timerStart: null, createdAt: new Date().toISOString(), createdBy, updatedAt: new Date().toISOString() }; }

// Module-level drag payload for strategy → day drops
let _stratDrag = null;
function emptyEmpWeek(empId) { return { employeeId: empId, strategy: [], days: Array.from({ length: 6 }, (_, i) => ({ dayIndex: i, schedule: "", dayResult: "", tasks: [], startTime: null, endTime: null, pauseStart: null, pauses: [], rating: null, insights: "", problems: "" })) }; }
function emptyWeek(year, week, emps) { return { id: `${year}-W${week}`, year, week, employees: emps.map(e => emptyEmpWeek(e.id)) }; }

// ── Миграция данных ──────────────────────────────────────────
// При обновлении продукта старые данные дополняются новыми полями
// Существующие значения НИКОГДА не затираются
const DATA_VERSION = 3;

function migrateTask(t) {
  // Дополняем только отсутствующие поля — существующие не трогаем
  return {
    id: t.id || mkId(),
    task: t.task ?? "",
    result: t.result ?? "",
    priority: t.priority ?? "",
    timeRange: t.timeRange ?? "",
    plan: t.plan ?? "",
    fact: t.fact ?? "",
    workType: t.workType ?? "",
    done: t.done ?? false,
    status: t.status ?? (t.done ? "done" : ""),   // ← миграция: done → status
    isFocus: t.isFocus ?? false,
    fromStrategy: t.fromStrategy ?? false,
    taskType: t.taskType ?? "",
    sessions: t.sessions ?? [],
    timerStart: t.timerStart ?? null,
    createdAt: t.createdAt ?? new Date().toISOString(),
    createdBy: t.createdBy ?? "",
    updatedAt: t.updatedAt ?? new Date().toISOString(),
  };
}

function migrateDay(d, di) {
  return {
    dayIndex: d.dayIndex ?? di,
    schedule: d.schedule ?? "",
    dayResult: d.dayResult ?? "",
    tasks: (d.tasks || []).map(migrateTask),
    startTime: d.startTime ?? null,
    endTime: d.endTime ?? null,
    pauseStart: d.pauseStart ?? null,
    pauses: d.pauses ?? [],
    rating: d.rating ?? null,
    insights: d.insights ?? "",
    problems: d.problems ?? "",
  };
}

function migrateEmpWeek(ed) {
  return {
    employeeId: ed.employeeId,
    strategy: (ed.strategy || []).map(g => ({
      id: g.id || mkId(),
      task: g.task ?? "",
      result: g.result ?? "",
      hours: g.hours ?? "",
      priority: g.priority ?? "",
      type: g.type ?? "С",
    })),
    days: Array.from({ length: 6 }, (_, i) => migrateDay(ed.days?.[i] || {}, i)),
  };
}

function migrateWeek(data) {
  if (!data) return data;
  return {
    ...data,
    _v: DATA_VERSION,
    employees: (data.employees || []).map(migrateEmpWeek),
  };
}

function migrateEmps(emps) {
  if (!Array.isArray(emps)) return emps;
  return emps.map(e => ({
    id: e.id,
    name: e.name ?? "",
    color: e.color ?? "#A8D8EA",
    emoji: e.emoji ?? "👤",
    myTz: e.myTz ?? "Europe/Kiev",
    watchTz: e.watchTz ?? "Europe/Kiev",
  }));
}

// Smart time formatter: "10" → "10:00", "10-12" → "10:00-12:00", "1030" → "10:30"
function smartTime(raw) {
  if (!raw?.trim()) return raw;
  const normT = (s) => {
    s = s.trim();
    if (!s) return "";
    // "11" → "11:00", "9" → "09:00"
    if (/^\d{1,2}$/.test(s)) return `${s.padStart(2,"0")}:00`;
    // "930" → "09:30", "1130" → "11:30"
    if (/^\d{3}$/.test(s)) return `0${s[0]}:${s.slice(1)}`;
    if (/^\d{4}$/.test(s)) return `${s.slice(0,2)}:${s.slice(2)}`;
    // "11.30" → "11:30"
    if (/^\d{1,2}\.\d{2}$/.test(s)) return s.replace(".", ":");
    // already "HH:MM" — ensure padded
    if (/^\d{1,2}:\d{2}$/.test(s)) {
      const [h, m] = s.split(":");
      return `${h.padStart(2,"0")}:${m}`;
    }
    return s;
  };
  const sepMatch = raw.match(/\s*[-–—]\s*/);
  if (sepMatch) {
    const idx = raw.search(/[-–—]/);
    const a = raw.slice(0, idx).trim();
    const b = raw.slice(idx + 1).trim();
    const fa = normT(a), fb = normT(b);
    if (fa && fb) return `${fa} - ${fb}`;
    return raw;
  }
  // "11 12" → "11:00 - 12:00"
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 2) return `${normT(parts[0])} - ${normT(parts[1])}`;
  return normT(raw);
}

// Total tracked minutes for a task (completed sessions only, not live)
function taskTrackedMin(task) {
  return (task.sessions || []).reduce((s, p) => s + Math.round((new Date(p.end) - new Date(p.start)) / 60000), 0);
}
function totalPausedMin(day) {
  const done = (day.pauses || []).reduce((s, p) => s + Math.round((new Date(p.end) - new Date(p.start)) / 60000), 0);
  const cur = day.pauseStart ? Math.round((Date.now() - new Date(day.pauseStart)) / 60000) : 0;
  return done + cur;
}

const TIMEZONES = [
  { id: "Europe/Kiev",      label: "🇺🇦 Украина (Киев)",     offset: null },
  { id: "Asia/Makassar",    label: "🇮🇩 Бали (WITA)",        offset: null },
  { id: "Europe/Madrid",    label: "🇪🇸 Испания (Мадрид)",   offset: null },
  { id: "Europe/London",    label: "🇬🇧 Лондон (GMT)",       offset: null },
  { id: "Europe/Moscow",    label: "🇷🇺 Москва",             offset: null },
  { id: "Europe/Warsaw",    label: "🇵🇱 Польша (Варшава)",   offset: null },
  { id: "Europe/Prague",    label: "🇨🇿 Чехия (Прага)",      offset: null },
  { id: "America/New_York", label: "🇺🇸 Нью-Йорк (EST)",    offset: null },
  { id: "America/Chicago",  label: "🇺🇸 Чикаго (CST)",       offset: null },
  { id: "America/Los_Angeles", label: "🇺🇸 Лос-Анджелес",   offset: null },
  { id: "Asia/Dubai",       label: "🇦🇪 Дубай (GST)",        offset: null },
  { id: "Asia/Bangkok",     label: "🇹🇭 Бангкок (ICT)",      offset: null },
  { id: "Asia/Singapore",   label: "🇸🇬 Сингапур (SGT)",     offset: null },
  { id: "Asia/Tokyo",       label: "🇯🇵 Токио (JST)",        offset: null },
  { id: "Australia/Sydney", label: "🇦🇺 Сидней (AEDT)",      offset: null },
];

// Получить текущее время в заданном часовом поясе
function getTzTime(tzId) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tzId, hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, day: "2-digit", month: "2-digit"
    }).formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value || "00";
    return { h: get("hour"), m: get("minute"), s: get("second"), d: get("day"), mo: get("month") };
  } catch { return { h: "00", m: "00", s: "00", d: "01", mo: "01" }; }
}

function getTzLabel(tzId) {
  return TIMEZONES.find(t => t.id === tzId)?.label || tzId;
}

const INIT_EMPS = [
  { id: "e1", name: "Наташа", color: "#F4B8D1", emoji: "👩", myTz: "Asia/Makassar", watchTz: "Europe/Kiev" },
  { id: "e2", name: "Света",  color: "#A8D8EA", emoji: "👩‍💼", myTz: "Europe/Kiev",    watchTz: "Europe/Madrid" }
];
const INIT_WTS = [{ id: "wt1", name: "Клиент" }, { id: "wt2", name: "Коммуникация" }, { id: "wt3", name: "Стратегия" }];

const C = {
  bg: "#F2EFE9", card: "#FFFFFF", dark: "#1A1F36", gold: "#C8922A", goldLight: "#F5E8CE",
  border: "#E2DED6", text: "#1F2937", muted: "#6B7280",
  success: "#059669", danger: "#DC2626", inputBg: "#FAFAF8"
};
const baseInp = { border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 9px", fontSize: 13, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box", background: C.inputBg, color: C.text, transition: "border-color .15s" };
const btnS = (v = "primary") => ({ padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", ...(v === "primary" ? { background: C.gold, color: "#fff" } : v === "ghost" ? { background: "transparent", border: `1px solid ${C.border}`, color: C.muted } : { background: "#FEE2E2", color: C.danger }) });
const cardS = { background: C.card, borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,.07)", padding: 16 };
const thS = { background: "#F9F8F6", fontSize: 11, fontWeight: 600, color: C.muted, padding: "6px 8px", textAlign: "left", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
const tdS = { padding: "4px 6px", fontSize: 12, borderBottom: `1px solid #F5F4F1`, verticalAlign: "middle" };

/* ═══ UKRAINE CLOCK + TIME CONVERTER ══════════════════════ */
/* ═══ PERSONAL CLOCK ══════════════════════════════════════ */
// Каждый сотрудник видит своё время + время наблюдения (настраивается в Настройках)
function PersonalClock({ emps }) {
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [selEmp, setSelEmp] = useState(emps[0]?.id || null);
  const [input, setInput] = useState("");
  const popRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const h = e => { if (popRef.current && !popRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const emp = emps.find(e => e.id === selEmp) || emps[0];
  if (!emp) return null;

  const myTz = emp.myTz || "Europe/Kiev";
  const watchTz = emp.watchTz || "Europe/Kiev";

  const myTime = getTzTime(myTz);
  const watchTime = getTzTime(watchTz);

  // Конвертер: ввод в watchTz → myTz
  const convertTz = (raw) => {
    if (!raw?.trim()) return null;
    const m = raw.match(/^(\d{1,2})[:\.  ]?(\d{0,2})$/);
    if (!m) return null;
    const h = parseInt(m[1]), min = m[2] ? parseInt(m[2].padEnd(2,"0")) : 0;
    if (h > 23 || min > 59) return null;
    // Разница между watchTz и myTz
    const now = new Date();
    const myOff = new Date(now.toLocaleString("en-US", { timeZone: myTz })) - now;
    const watchOff = new Date(now.toLocaleString("en-US", { timeZone: watchTz })) - now;
    const diffMin = Math.round((myOff - watchOff) / 60000);
    const totalMin = h * 60 + min + diffMin;
    const rh = ((totalMin % 1440) + 1440) % 1440;
    return `${String(Math.floor(rh/60)).padStart(2,"0")}:${String(rh%60).padStart(2,"0")}`;
  };

  const myResult = convertTz(input);
  const presets = [9,10,11,12,13,14,15,16,17,18,19,20];

  return (
    <div style={{ position: "relative", flexShrink: 0 }} ref={popRef}>
      <button onClick={() => setOpen(p => !p)}
        style={{ display: "flex", alignItems: "center", gap: 10, background: open ? "rgba(200,146,42,.15)" : "rgba(255,255,255,.07)", border: `1px solid ${open ? "rgba(200,146,42,.4)" : "transparent"}`, borderRadius: 9, padding: "5px 12px", cursor: "pointer", fontFamily: "inherit" }}>

        {/* Мои часы */}
        <div>
          <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: C.gold, letterSpacing: 1, lineHeight: 1 }}>
            {myTime.h}:{myTime.m}<span style={{ color: "#C8A86A", fontSize: 12 }}>:{myTime.s}</span>
          </div>
          <div style={{ fontSize: 9, color: "#6B7280", marginTop: 1 }}>{getTzLabel(myTz).split(" ")[0]} {emp.emoji} {emp.name}</div>
        </div>

        {/* Разделитель */}
        {myTz !== watchTz && <>
          <div style={{ width: 1, height: 28, background: "rgba(255,255,255,.12)" }} />
          {/* Часы наблюдения */}
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: "#9CA3AF", letterSpacing: 1, lineHeight: 1 }}>
              {watchTime.h}:{watchTime.m}
            </div>
            <div style={{ fontSize: 9, color: "#6B7280", marginTop: 1 }}>{getTzLabel(watchTz).split(" ")[0]}</div>
          </div>
        </>}
      </button>

      {open && (
        <div style={{ position: "absolute", top: "110%", right: 0, background: C.dark, border: "1px solid rgba(255,255,255,.15)", borderRadius: 14, width: 310, zIndex: 300, boxShadow: "0 12px 40px rgba(0,0,0,.5)", overflow: "hidden" }}>

          {/* Выбор сотрудника */}
          <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", gap: 6 }}>
            {emps.map(e => (
              <button key={e.id} onClick={() => setSelEmp(e.id)}
                style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: `1px solid ${selEmp === e.id ? e.color : "rgba(255,255,255,.12)"}`, background: selEmp === e.id ? `${e.color}22` : "transparent", color: selEmp === e.id ? "#E8E0D0" : "#6B7280", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: selEmp === e.id ? 700 : 400 }}>
                {e.emoji} {e.name}
              </button>
            ))}
          </div>

          {/* Текущее время двух зон */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#6B7280", marginBottom: 4 }}>{getTzLabel(myTz)}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: C.gold, fontFamily: "monospace" }}>{myTime.h}:{myTime.m}</div>
              <div style={{ fontSize: 10, color: "#6B7280" }}>мое время</div>
            </div>
            <div style={{ color: "#4B5563", fontSize: 20 }}>⇄</div>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#6B7280", marginBottom: 4 }}>{getTzLabel(watchTz)}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#9CA3AF", fontFamily: "monospace" }}>{watchTime.h}:{watchTime.m}</div>
              <div style={{ fontSize: 10, color: "#6B7280" }}>слежу</div>
            </div>
          </div>

          {/* Конвертер */}
          <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
            <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 8 }}>
              Введите время ({getTzLabel(watchTz).replace(/^[^ ]+ /, "")}):
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input value={input} onChange={e => setInput(e.target.value)} autoFocus
                placeholder="15 или 15:30"
                style={{ flex: 1, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 7, padding: "7px 10px", fontSize: 16, fontWeight: 700, color: "#fff", outline: "none", fontFamily: "monospace" }} />
              {myResult && (
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#6B7280" }}>моё время</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: C.gold, fontFamily: "monospace" }}>{myResult}</div>
                </div>
              )}
            </div>
          </div>

          {/* Пресеты */}
          <div style={{ padding: "10px 16px 14px" }}>
            <div style={{ fontSize: 10, color: "#6B7280", marginBottom: 8, fontWeight: 600 }}>
              {getTzLabel(watchTz).replace(/^[^ ]+ /, "")} → {getTzLabel(myTz).replace(/^[^ ]+ /, "")}:
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4 }}>
              {presets.map(h => {
                const my = convertTz(String(h));
                const myH = parseInt(my?.split(":")[0] || "0");
                const isLate = myH >= 22 || myH < 7;
                const isOk = !isLate && myH >= 9;
                const bg = isLate ? "rgba(220,38,38,.18)" : isOk ? "rgba(5,150,105,.15)" : "rgba(245,158,11,.15)";
                const col = isLate ? "#FCA5A5" : isOk ? "#6EE7B7" : "#FCD34D";
                return (
                  <button key={h} onClick={() => setInput(String(h))}
                    style={{ background: bg, border: "none", borderRadius: 7, padding: "5px 3px", cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}
                    onMouseEnter={e => e.currentTarget.style.opacity = ".75"}
                    onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                    <div style={{ fontSize: 10, color: "#9CA3AF" }}>{watchTime.h.slice(0,1) === h.toString()[0] ? "→" : ""}{h}:00</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: col, fontFamily: "monospace" }}>{my}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 9, color: "#6B7280" }}>
              <span>🟢 удобно</span><span>🟡 рано</span><span>🔴 поздно</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default function App() {
  const [tab, setTab] = useState("planner");
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("tp_user") || "null"); } catch { return null; }
  });
  const [onlineUsers, setOnlineUsers] = useState([]);
  const presenceChannel = useRef(null);
  const [cw, setCw] = useState(getCurrentWeek());
  const [emps, setEmps] = useState(INIT_EMPS);
  const [wts, setWts] = useState(INIT_WTS);
  const [wd, setWd] = useState(null);
  const [loading, setLoading] = useState(true);
  const [allKeys, setAllKeys] = useState([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState(() => Math.min(5, Math.max(0, (new Date().getDay() + 6) % 7)));
  const saveTimer = useRef(null);
  const wkey = `week:${cw.year}-${cw.week}`;

  useEffect(() => {
    (async () => {
      const e = migrateEmps(await store.get("cfg:emps")); if (e?.length) setEmps(e);
      const w = await store.get("cfg:wts"); if (w?.length) setWts(w);
      const k = await store.get("cfg:keys"); if (k) setAllKeys(k);
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    (async () => {
      const le = migrateEmps(await store.get("cfg:emps")) || INIT_EMPS;
      const raw = await store.get(wkey);
      const base = raw ? migrateWeek(raw) : emptyWeek(cw.year, cw.week, le);
      const synced = le.map(e => base.employees?.find(x => x.employeeId === e.id) || emptyEmpWeek(e.id));
      setWd({ ...base, employees: synced });
      setLoading(false);
    })();
  }, [wkey]);

  const saveWd = useCallback((data) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      store.set(wkey, data);
      const k = `${cw.year}-W${String(cw.week).padStart(2, "0")}`;
      setAllKeys(prev => {
        if (prev.includes(k)) return prev;
        const u = [...prev, k].sort().reverse();
        store.set("cfg:keys", u); return u;
      });
    }, 400);
  }, [wkey, cw]);

  const updDay = useCallback((empId, di, dd) => {
    setWd(prev => {
      const n = { ...prev, employees: prev.employees.map(e => e.employeeId !== empId ? e : { ...e, days: e.days.map((d, i) => i === di ? { ...d, ...dd } : d) }) };
      saveWd(n); return n;
    });
  }, [saveWd]);

  const updStrat = (empId, strat) => {
    setWd(prev => {
      const n = { ...prev, employees: prev.employees.map(e => e.employeeId === empId ? { ...e, strategy: strat } : e) };
      saveWd(n); return n;
    });
  };

  const saveEmps = useCallback((e) => { setEmps(e); store.set("cfg:emps", e); }, []);
  const saveWts = useCallback((w) => { setWts(w); store.set("cfg:wts", w); }, []);

  // ── Presence ─────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser) return;
    const getDeviceId = () => {
      const s = localStorage.getItem("tp_device_id");
      if (s) return s;
      const fp = [navigator.userAgent, screen.width+"x"+screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone].join("|");
      let h = 0; for (let i=0;i<fp.length;i++){h=((h<<5)-h)+fp.charCodeAt(i);h|=0;}
      const id = "dev_"+Math.abs(h).toString(36);
      localStorage.setItem("tp_device_id", id); return id;
    };
    const deviceId = getDeviceId();
    const ch = supabase.channel("presence:tp", { config: { presence: { key: deviceId } } });
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState();
      const seen = new Set();
      const unique = Object.values(state).map(a=>a[0]).filter(u=>u&&!seen.has(u.userId)&&seen.add(u.userId));
      setOnlineUsers(unique);
    });
    ch.subscribe(async status => {
      if (status === "SUBSCRIBED") await ch.track({ userId: currentUser.id, name: currentUser.name, emoji: currentUser.emoji, color: currentUser.color, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    });
    presenceChannel.current = ch;
    logActivity(currentUser, "открыл приложение");
    return () => supabase.removeChannel(ch);
  }, [currentUser]);

  const [resumePrompt, setResumePrompt] = useState(null);
  const inactivityTimer = useRef(null);
  const heartbeatTimer = useRef(null);
  const INACTIVITY_MS = 5 * 60 * 1000;
  const HB_KEY = "tp_heartbeat";
  const HB_INTERVAL = 8000;   // пишем каждые 8 сек
  const HB_GRACE = 18000;     // активен если < 18 сек назад

  // Heartbeat — пишем метку пока вкладка видна
  useEffect(() => {
    const writeHB = () => {
      if (document.visibilityState === "visible")
        localStorage.setItem(HB_KEY, Date.now().toString());
    };
    writeHB();
    heartbeatTimer.current = setInterval(writeHB, HB_INTERVAL);
    return () => {
      clearInterval(heartbeatTimer.current);
      // Не удаляем ключ — другая вкладка может быть открыта
    };
  }, []);

  // Есть ли активная сессия в другом браузере/вкладке (< 18 сек назад)?
  const isActiveElsewhere = useCallback(() => {
    const hb = localStorage.getItem(HB_KEY);
    if (!hb) return false;
    return Date.now() - parseInt(hb) < HB_GRACE;
  }, []);

  // Найти все активные дни
  const getActiveDays = useCallback(() => {
    if (!wd) return [];
    const today = new Date(); today.setHours(0,0,0,0);
    const todayIdx = (today.getDay() + 6) % 7;
    const result = [];
    wd.employees.forEach(ed => {
      const day = ed.days[todayIdx];
      if (day?.startTime && !day?.endTime && !day?.pauseStart) {
        const emp = emps.find(e => e.id === ed.employeeId);
        if (emp) result.push({ empId: ed.employeeId, di: todayIdx, empName: emp.name, emoji: emp.emoji });
      }
    });
    return result;
  }, [wd, emps]);

  // Авто-пауза при неактивности или скрытии вкладки
  useEffect(() => {
    const autoPause = () => {
      // Не ставим паузу если пользователь активен в другом браузере/вкладке
      if (isActiveElsewhere()) return;
      const active = getActiveDays();
      if (active.length === 0) return;
      active.forEach(({ empId, di }) => {
        updDay(empId, di, { pauseStart: new Date().toISOString() });
      });
      setResumePrompt(active[0]);
    };

    const resetTimer = () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(autoPause, INACTIVITY_MS);
    };

    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        // Небольшая задержка — даём время другой вкладке написать heartbeat
        setTimeout(() => { if (!isActiveElsewhere()) autoPause(); }, 2000);
      } else {
        const today = new Date(); today.setHours(0,0,0,0);
        const todayIdx = (today.getDay() + 6) % 7;
        const paused = [];
        wd?.employees.forEach(ed => {
          const day = ed.days[todayIdx];
          if (day?.startTime && !day?.endTime && day?.pauseStart) {
            const emp = emps.find(e => e.id === ed.employeeId);
            if (emp) paused.push({ empId: ed.employeeId, di: todayIdx, empName: emp.name, emoji: emp.emoji });
          }
        });
        if (paused.length > 0) setResumePrompt(paused[0]);
      }
    };

    const events = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    events.forEach(e => document.addEventListener(e, resetTimer, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    resetTimer();

    return () => {
      events.forEach(e => document.removeEventListener(e, resetTimer));
      document.removeEventListener("visibilitychange", onVisible);
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [getActiveDays, updDay, wd, emps, isActiveElsewhere]);

  const navWeek = (dir) => setCw(p => {
    let { year, week } = p; week += dir;
    if (week < 1) { year--; week = 52; } if (week > 52) { year++; week = 1; }
    return { year, week };
  });

  const goToWeek = (key, targetTab = null) => {
    const [y, wp] = key.split("-W");
    setCw({ year: parseInt(y), week: parseInt(wp) });
    if (targetTab) setTab(targetTab);
    setArchiveOpen(false);
  };

  const dates = getWeekDates(cw.year, cw.week);

  return (
    <div style={{ fontFamily: "'Golos Text','Segoe UI',sans-serif", minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column" }}>
      {!currentUser && <LoginScreen emps={emps} onSelect={emp => { setCurrentUser(emp); localStorage.setItem("tp_user", JSON.stringify(emp)); }} />}
      {currentUser && <>
      <link href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes blink { 0%,100%{opacity:.6} 50%{opacity:.15} }
        * { box-sizing: border-box; }

        /* ── Mobile ≤ 640px ── */
        @media (max-width: 640px) {
          .week-grid { grid-template-columns: 1fr !important; gap: 6px !important; }
          .week-day-headers { display: none !important; }
          .emp-header { font-size: 14px !important; }
          .day-cell { border-radius: 8px !important; }
          .nav-tabs span { display: none; }
          .nav-tabs button { padding: 5px 8px !important; font-size: 11px !important; }
          .header-week-nav { min-width: 130px !important; }
          .header-week-nav .week-dates { font-size: 10px !important; }
          .ua-clock-label { display: none; }
          .analytics-grid { grid-template-columns: 1fr !important; }
          .strategy-table { font-size: 11px !important; }
          .day-table { min-width: 480px !important; }
        }

        /* ── Tablet 641–1024px ── */
        @media (min-width: 641px) and (max-width: 1024px) {
          .week-grid { grid-template-columns: repeat(3,1fr) !important; }
          .week-day-headers { grid-template-columns: repeat(3,1fr) !important; }
          .analytics-grid { grid-template-columns: repeat(2,1fr) !important; }
        }

        /* Scrollable tables on small screens */
        .day-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      `}</style>

      <header style={{ background: C.dark, color: "#fff", padding: "0 20px", display: "flex", alignItems: "center", gap: 14, height: 56, flexShrink: 0, boxShadow: "0 2px 16px rgba(0,0,0,.3)" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.gold, letterSpacing: .3, flexShrink: 0 }}>◈ TeamPlanner</div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.07)", borderRadius: 9, padding: "4px 10px" }}>
          <button onClick={() => navWeek(-1)} style={{ background: "none", border: "none", color: C.gold, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 2px" }}>‹</button>
          <div style={{ textAlign: "center", minWidth: 170 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#E8E0D0" }}>{dates[0].toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} – {dates[5].toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</div>
            <div style={{ fontSize: 10, color: "#6B7280" }}>Неделя {cw.week} · {cw.year}</div>
          </div>
          <button onClick={() => navWeek(1)} style={{ background: "none", border: "none", color: C.gold, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 2px" }}>›</button>
        </div>

        <button onClick={() => setCw(getCurrentWeek())} style={{ background: "rgba(200,146,42,.15)", border: "1px solid rgba(200,146,42,.4)", color: C.gold, borderRadius: 7, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, flexShrink: 0 }}>Сегодня</button>

        <div style={{ position: "relative", flexShrink: 0 }}>
          <button onClick={() => setArchiveOpen(p => !p)} style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.12)", color: "#9CA3AF", borderRadius: 7, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>📁 Архив ({allKeys.length})</button>
          {archiveOpen && (
            <div style={{ position: "absolute", top: "110%", left: 0, background: C.dark, border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, minWidth: 280, maxHeight: 420, overflowY: "auto", zIndex: 200, boxShadow: "0 8px 24px rgba(0,0,0,.4)" }}>
              {allKeys.length === 0
                ? <div style={{ padding: "12px 16px", fontSize: 13, color: "#6B7280" }}>Нет сохранённых недель</div>
                : (() => {
                    // Group by year-month
                    const groups = {};
                    allKeys.forEach(k => {
                      const [y, wp] = k.split("-W");
                      const wdates = getWeekDates(parseInt(y), parseInt(wp));
                      const mo = wdates[0].getMonth();
                      const gk = `${y}-${mo}`;
                      if (!groups[gk]) groups[gk] = { y: parseInt(y), mo, keys: [] };
                      groups[gk].keys.push(k);
                    });
                    const nowM = new Date().getMonth(), nowY = new Date().getFullYear();
                    return Object.entries(groups).sort((a,b) => b[0].localeCompare(a[0])).map(([gk, { y, mo, keys }]) => {
                      const isPast = y < nowY || (y === nowY && mo < nowM);
                      const isCurMo = y === nowY && mo === nowM;
                      return (
                        <div key={gk}>
                          <div style={{ padding: "8px 16px 4px", display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: isCurMo ? C.gold : isPast ? "#9CA3AF" : "#D0C8B8", letterSpacing: .5 }}>
                              {MONTH_RU[mo]?.toUpperCase() || mo} {y}
                            </span>
                            {isPast && <span style={{ fontSize: 9, background: "rgba(156,163,175,.2)", color: "#9CA3AF", borderRadius: 4, padding: "1px 5px" }}>АРХИВ</span>}
                            {isCurMo && <span style={{ fontSize: 9, background: "rgba(200,146,42,.2)", color: C.gold, borderRadius: 4, padding: "1px 5px" }}>ТЕКУЩИЙ</span>}
                          </div>
                          {keys.map(k => {
                            const [ky, wp] = k.split("-W"); const w = parseInt(wp);
                            const d = getWeekDates(parseInt(ky), w);
                            const isCur = k === `${cw.year}-W${String(cw.week).padStart(2, "0")}`;
                            return (
                              <div key={k} style={{ borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                                <button onClick={() => goToWeek(k)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: isCur ? "rgba(200,146,42,.15)" : "none", border: "none", color: isCur ? C.gold : "#D0C8B8", padding: "8px 16px 8px 24px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 600 }}>Неделя {w} {isCur ? "· Текущая" : ""}</div>
                                    <div style={{ fontSize: 10, color: "#6B7280", marginTop: 1 }}>
                                      {d[0].toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} – {d[5].toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                                    </div>
                                  </div>
                                  {isCur && <span style={{ fontSize: 14 }}>👁</span>}
                                </button>
                                {/* Быстрая навигация по разделам */}
                                {!isCur && (
                                  <div style={{ display: "flex", gap: 4, padding: "4px 24px 8px" }}>
                                    {[["planner","📅 Неделя"],["analytics","📊 Аналитика"],["strategy","🎯 Стратегия"],["tasks","📋 Задачи"]].map(([t, l]) => (
                                      <button key={t} onClick={() => goToWeek(k, t)}
                                        style={{ fontSize: 10, background: "rgba(255,255,255,.07)", border: "none", color: "#9CA3AF", borderRadius: 5, padding: "3px 7px", cursor: "pointer", fontFamily: "inherit" }}
                                        onMouseEnter={e => { e.currentTarget.style.background = "rgba(200,146,42,.2)"; e.currentTarget.style.color = C.gold; }}
                                        onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,.07)"; e.currentTarget.style.color = "#9CA3AF"; }}>
                                        {l}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    });
                  })()
              }
            </div>
          )}
        </div>

        {onlineUsers.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.07)", borderRadius: 9, padding: "5px 10px" }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#22C55E", boxShadow: "0 0 6px #22C55E" }} />
            <span style={{ fontSize: 11, color: "#9CA3AF", fontWeight: 600 }}>{onlineUsers.length} онлайн</span>
            <div style={{ display: "flex", gap: 3 }}>
              {onlineUsers.map(u => <span key={u.userId} title={`${u.name} · ${u.timezone||""}`} style={{ fontSize: 16 }}>{u.emoji||"👤"}</span>)}
            </div>
          </div>
        )}
        <PersonalClock emps={emps} />

        <nav className="nav-tabs" style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          {[["planner","📅 Неделя"],["day","📆 День"],["tasks","📋 Задачи"],["logs","📜 Логи"],["calendar","🗓 Календарь"],["strategy","🎯 Стратегия"],["analytics","📊 Аналитика"],["settings","⚙️ Настройки"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ background: tab === k ? "rgba(200,146,42,.15)" : "none", border: `1px solid ${tab === k ? "rgba(200,146,42,.6)" : "transparent"}`, color: tab === k ? C.gold : "#9CA3AF", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 13, fontWeight: 500, fontFamily: "inherit" }}>{l}</button>
          ))}
        </nav>
      </header>

      <main style={{ flex: 1, overflow: "auto", padding: 16 }} onClick={() => archiveOpen && setArchiveOpen(false)}>
        {/* Баннер архивной недели */}
        {(() => {
          const curKey = `${cw.year}-W${String(cw.week).padStart(2,"0")}`;
          const nowW = getCurrentWeek();
          const isArchive = cw.year !== nowW.year || cw.week !== nowW.week;
          if (!isArchive) return null;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#1E1A10", border: `1px solid rgba(200,146,42,.3)`, borderRadius: 10, padding: "8px 16px", marginBottom: 12 }}>
              <span style={{ fontSize: 16 }}>📁</span>
              <span style={{ fontSize: 13, color: "#E8D8A0", fontWeight: 600 }}>
                Архив · Неделя {cw.week}, {cw.year} · {dates[0].toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} – {dates[5].toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}
              </span>
              <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
                {[["planner","📅 Неделя"],["analytics","📊 Аналитика"],["strategy","🎯 Стратегия"],["tasks","📋 Задачи"]].map(([t,l]) => (
                  <button key={t} onClick={() => setTab(t)}
                    style={{ fontSize: 11, background: tab === t ? "rgba(200,146,42,.25)" : "rgba(255,255,255,.06)", border: `1px solid ${tab === t ? "rgba(200,146,42,.5)" : "transparent"}`, color: tab === t ? C.gold : "#9CA3AF", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", fontWeight: tab === t ? 700 : 400 }}>
                    {l}
                  </button>
                ))}
              </div>
              <button onClick={() => { const w = getCurrentWeek(); setCw(w); }}
                style={{ marginLeft: "auto", fontSize: 11, background: "rgba(200,146,42,.15)", border: "1px solid rgba(200,146,42,.4)", color: C.gold, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                ← Вернуться к текущей
              </button>
            </div>
          );
        })()}
        {loading ? (
          <div style={{ textAlign: "center", padding: 80, color: C.muted }}>⏳ Загрузка...</div>
        ) : !wd ? null : tab === "planner" ? (
          <WeekInline wd={wd} emps={emps} wts={wts} dates={dates} onUpdDay={updDay} onEmpsUpdate={saveEmps} onUpdStrat={updStrat} />
        ) : tab === "day" ? (
          <DayView wd={wd} emps={emps} wts={wts} dates={dates} selectedDay={selectedDay} onSelectDay={setSelectedDay} onUpdDay={updDay} />
        ) : tab === "tasks" ? (
          <TasksView wd={wd} emps={emps} wts={wts} dates={dates} allKeys={allKeys} cw={cw} />
        ) : tab === "calendar" ? (
          <CalendarView wd={wd} emps={emps} wts={wts} allKeys={allKeys} cw={cw} />
        ) : tab === "strategy" ? (
          <StrategyView wd={wd} emps={emps} onUpdateStrategy={updStrat} />
        ) : tab === "logs" ? (
          <LogsView currentUser={currentUser} emps={emps} />
        ) : tab === "analytics" ? (
          <Analytics wd={wd} emps={emps} wts={wts} dates={dates} cw={cw} />
        ) : (
          <SettingsView emps={emps} wts={wts} onEmps={saveEmps} onWts={saveWts} />
        )}
      </main>

      {/* Баннер: возобновить рабочий день после паузы */}
      {resumePrompt && (
        <ResumePrompt
          empName={resumePrompt.empName}
          emoji={resumePrompt.emoji}
          onResume={() => {
            const { empId, di } = resumePrompt;
            setWd(prev => {
              if (!prev) return prev;
              const ed = prev.employees.find(e => e.employeeId === empId);
              const day = ed?.days[di];
              if (!day) return prev;
              const pauses = [...(day.pauses || []), { start: day.pauseStart, end: new Date().toISOString() }];
              const n = { ...prev, employees: prev.employees.map(e => e.employeeId !== empId ? e : { ...e, days: e.days.map((d, i) => i === di ? { ...d, pauseStart: null, pauses } : d) }) };
              saveWd(n); return n;
            });
            setResumePrompt(null);
          }}
          onDismiss={() => setResumePrompt(null)} />
      )}
    </>
    </div>
  );
}


/* ═══ LOGIN SCREEN ══════════════════════════════════════════ */
function LoginScreen({ emps, onSelect }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: C.dark, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, flexDirection: "column", gap: 24 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 800, color: C.gold }}>◈ TeamPlanner</div>
        <div style={{ fontSize: 14, color: "#6B7280", marginTop: 6 }}>Выберите кто вы</div>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
        {emps.map(emp => (
          <button key={emp.id} onClick={() => onSelect(emp)}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "24px 32px", background: "rgba(255,255,255,.07)", border: "2px solid rgba(255,255,255,.12)", borderRadius: 16, cursor: "pointer", fontFamily: "inherit", transition: "all .2s", minWidth: 140 }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = emp.color; e.currentTarget.style.transform = "scale(1.05)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,.12)"; e.currentTarget.style.transform = "scale(1)"; }}>
            <span style={{ fontSize: 48 }}>{emp.emoji || "👤"}</span>
            <div style={{ width: 32, height: 4, borderRadius: 2, background: emp.color }} />
            <span style={{ fontSize: 16, fontWeight: 700, color: "#E8E0D0" }}>{emp.name}</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#374151" }}>Выбор сохранится в браузере</div>
    </div>
  );
}

/* ═══ LOGS VIEW ═════════════════════════════════════════════ */
function LogsView({ currentUser, emps }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterUser, setFilterUser] = useState("all");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("activity_logs").select("*").order("created_at", { ascending: false }).limit(500);
      setLogs(data || []); setLoading(false);
    })();
    const ch = supabase.channel("logs-rt").on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_logs" }, p => {
      setLogs(prev => [p.new, ...prev].slice(0, 500));
    }).subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  const fmtDT = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const actionLabels = { "открыл приложение":"🔑 Вход", "начал день":"▶ Начал день", "завершил день":"⏹ Завершил", "запустил таймер":"⏱ Таймер ▶", "остановил таймер":"⏱ Таймер ⏹" };
  const uniqueUsers = [...new Set(logs.map(l => l.user_name))];
  const filtered = logs.filter(l => filterUser === "all" || l.user_name === filterUser);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...cardS, padding: "12px 18px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.dark }}>📜 Логи активности</div>
        <span style={{ fontSize: 12, color: C.muted }}>{filtered.length} записей</span>
        <select value={filterUser} onChange={e => setFilterUser(e.target.value)} style={{ ...baseInp, width: "auto", fontSize: 12, padding: "4px 8px", marginLeft: "auto" }}>
          <option value="all">Все пользователи</option>
          {uniqueUsers.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      <div style={{ background: C.card, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
        {loading ? <div style={{ textAlign: "center", padding: 40, color: C.muted }}>⏳ Загрузка...</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={{ ...thS, width: 150 }}>Время</th>
              <th style={{ ...thS, width: 140 }}>Пользователь</th>
              <th style={{ ...thS, width: 180 }}>Действие</th>
              <th style={thS}>Детали</th>
            </tr></thead>
            <tbody>
              {filtered.map(log => (
                <tr key={log.id} onMouseEnter={e => e.currentTarget.style.background="#FEFDFB"} onMouseLeave={e => e.currentTarget.style.background="#fff"}>
                  <td style={{ ...tdS, fontSize: 11, color: C.muted, fontFamily: "monospace" }}>{fmtDT(log.created_at)}</td>
                  <td style={tdS}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: log.user_color || C.muted }} />
                      <span style={{ fontSize: 14 }}>{log.user_emoji || "👤"}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{log.user_name}</span>
                    </div>
                  </td>
                  <td style={tdS}><span style={{ fontSize: 12, background: "#F5F4F1", borderRadius: 6, padding: "2px 8px" }}>{actionLabels[log.action] || log.action}</span></td>
                  <td style={{ ...tdS, fontSize: 11, color: C.muted }}>{log.details && Object.keys(log.details).length > 0 ? Object.entries(log.details).map(([k,v])=>`${k}: ${v}`).join(" · ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ═══ RESUME PROMPT BANNER ═════════════════════════════════ */
function ResumePrompt({ empName, emoji, onResume, onDismiss }) {
  const [visible, setVisible] = useState(true);
  const [blink, setBlink] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setBlink(p => !p), 600);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      zIndex: 3000, display: "flex", alignItems: "center", gap: 14,
      background: C.dark, border: `2px solid ${blink ? C.gold : "rgba(200,146,42,.3)"}`,
      borderRadius: 16, padding: "14px 20px",
      boxShadow: `0 8px 32px rgba(0,0,0,.4), 0 0 0 ${blink ? 4 : 0}px rgba(200,146,42,.15)`,
      transition: "border-color .3s, box-shadow .3s", minWidth: 320, maxWidth: "90vw"
    }}>
      <span style={{ fontSize: 28 }}>{emoji || "👤"}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#E8E0D0" }}>
          ▶ Продолжить рабочий день?
        </div>
        <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>
          {empName} · день был поставлен на паузу из-за неактивности
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button onClick={onDismiss}
          style={{ background: "rgba(255,255,255,.08)", border: "none", color: "#9CA3AF", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
          Позже
        </button>
        <button onClick={onResume}
          style={{ background: C.gold, border: "none", color: "#fff", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
          ▶ Да, запустить
        </button>
      </div>
    </div>
  );
}
function WeekInline({ wd, emps, wts, dates, onUpdDay, onEmpsUpdate, onUpdStrat }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [endDayModal, setEndDayModal] = useState(null);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const handleDrop = (ti) => {
    if (dragIdx === null || dragIdx === ti) { setDragIdx(null); setDragOverIdx(null); return; }
    const n = [...emps]; const [m] = n.splice(dragIdx, 1); n.splice(ti, 0, m);
    onEmpsUpdate(n); setDragIdx(null); setDragOverIdx(null);
  };

  return (
    <div>
      {/* Sticky day headers */}
      <div style={{ position: "sticky", top: -16, zIndex: 20, background: C.bg, paddingTop: 4, paddingBottom: 8 }}>
        <div className="week-day-headers" style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8 }}>
          {dates.map((date, i) => {
            const isToday = date.getTime() === today.getTime();
            return (
              <div key={i} style={{
                background: isToday ? "linear-gradient(135deg, #FFF8E8 0%, #FFF3D0 100%)" : C.card,
                borderRadius: 9, padding: "8px 12px", textAlign: "center",
                border: isToday ? `2px solid ${C.gold}` : `1px solid ${C.border}`,
                boxShadow: isToday ? `0 2px 12px rgba(200,146,42,.2)` : "none"
              }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: isToday ? "#8B5E10" : C.text }}>{DAY_NAMES[i]}</div>
                <div style={{ fontSize: 10, color: isToday ? C.gold : C.muted, marginTop: 1, fontWeight: isToday ? 600 : 400 }}>
                  {isToday && <span style={{ marginRight: 3 }}>●</span>}{date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {emps.map((emp, empIdx) => {
        const ed = wd.employees.find(e => e.employeeId === emp.id);
        const strat = ed?.strategy || [];
        const isDT = dragOverIdx === empIdx && dragIdx !== empIdx;
        return (
          <div key={emp.id}
            onDragEnter={e => { if (_stratDrag) return; e.preventDefault(); setDragOverIdx(empIdx); }}
            onDragOver={e => { if (_stratDrag) return; e.preventDefault(); }}
            onDrop={() => { if (_stratDrag) return; handleDrop(empIdx); }}
            onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
            style={{ marginBottom: 16, opacity: dragIdx === empIdx ? .3 : 1, outline: isDT ? `2px dashed ${C.gold}` : "none", borderRadius: 12, transition: "opacity .2s" }}>

            <EmpHeader emp={emp} emps={emps} onUpdate={onEmpsUpdate} onDragStart={() => setDragIdx(empIdx)} />

            {/* Strategy panel for this employee */}
            {strat.length > 0 && (
              <StrategyPanel emp={emp} strat={strat} wd={wd}
                onUpdate={(s) => onUpdStrat(emp.id, s)} />
            )}

            <div className="week-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8 }}>
              {Array.from({ length: 6 }, (_, di) => {
                const dayData = ed?.days[di] || { dayIndex: di, schedule: "", dayResult: "", tasks: [], startTime: null, endTime: null };
                return (
                  <DayCell key={di} dayData={dayData} wts={wts} empColor={emp.color} date={dates[di]}
                    onUpdate={(dd) => onUpdDay(emp.id, di, dd)}
                    onStartDay={() => onUpdDay(emp.id, di, { ...dayData, startTime: new Date().toISOString() })}
                    onTogglePause={() => {
                      const dd = dayData;
                      if (dd.pauseStart) {
                        const pauses = [...(dd.pauses || []), { start: dd.pauseStart, end: new Date().toISOString() }];
                        onUpdDay(emp.id, di, { ...dd, pauseStart: null, pauses });
                      } else {
                        onUpdDay(emp.id, di, { ...dd, pauseStart: new Date().toISOString() });
                      }
                    }}
                    onOpenEndDay={() => setEndDayModal({ empId: emp.id, di, dayData: ed?.days[di] || dayData })} />
                );
              })}
            </div>
          </div>
        );
      })}

      {endDayModal && (
        <EndDayModal
          dayData={endDayModal.dayData}
          emp={emps.find(e => e.id === endDayModal.empId)}
          date={dates[endDayModal.di]}
          onClose={() => setEndDayModal(null)}
          onSave={(fields) => {
            const dd = endDayModal.dayData;
            onUpdDay(endDayModal.empId, endDayModal.di, { ...dd, ...fields, endTime: new Date().toISOString() });
            setEndDayModal(null);
          }} />
      )}
    </div>
  );
}

/* ═══ END DAY MODAL ═════════════════════════════════════════ */
function EndDayModal({ dayData, emp, date, onClose, onSave }) {
  const [rating, setRating] = useState(dayData?.rating || 0);
  const [insights, setInsights] = useState(dayData?.insights || "");
  const [problems, setProblems] = useState(dayData?.problems || "");
  const started = dayData?.startTime ? new Date(dayData.startTime) : null;
  const now = new Date();
  const gross = started ? Math.round((now - started) / 60000) : null;
  const paused = totalPausedMin(dayData || {});
  const worked = gross !== null ? gross - paused : null;
  const doneCnt = (dayData?.tasks || []).filter(t => t.done).length;
  const totalT = (dayData?.tasks || []).length;

  const ratingLabels = ["","😞 Плохо","😕 Слабо","😐 Нормально","🙂 Хорошо","🤩 Отлично!"];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(10,15,30,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 20, width: "min(560px,96vw)", overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,.35)" }}>

        {/* Header */}
        <div style={{ background: `linear-gradient(135deg, ${emp?.color || "#F5E8CE"} 0%, #FFF8E8 100%)`, padding: "20px 24px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 28 }}>{emp?.emoji || "👤"}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: "#1F2937" }}>Итог дня — {emp?.name}</div>
              <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>
                {date?.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
              {started && <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.success }}>{worked !== null ? fmtMin(worked) : "—"}</div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>ОТРАБОТАНО</div>
              </div>}
              {paused > 0 && <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#B07820" }}>{fmtMin(paused)}</div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>ПЕРЕРЫВЫ</div>
              </div>}
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>{doneCnt}/{totalT}</div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>ЗАДАЧ</div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Rating */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 10 }}>
              Оцените свой день
              {rating > 0 && <span style={{ marginLeft: 8, fontSize: 12, color: C.muted, fontWeight: 400 }}>{ratingLabels[Math.min(rating, 5)]}</span>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[1,2,3,4,5,6,7,8,9,10].map(n => (
                <button key={n} onClick={() => setRating(n)} style={{
                  width: 38, height: 38, borderRadius: 10, border: `2px solid ${rating >= n ? C.gold : C.border}`,
                  background: rating >= n ? C.goldLight : C.inputBg, color: rating >= n ? "#7D5A20" : C.muted,
                  fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", transition: "all .15s"
                }}>{n}</button>
              ))}
            </div>
          </div>

          {/* Insights */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 700, color: C.dark, display: "block", marginBottom: 6 }}>
              💡 Инсайты и выводы
            </label>
            <textarea value={insights} onChange={e => setInsights(e.target.value)}
              style={{ ...baseInp, height: 72, resize: "vertical", lineHeight: 1.5, padding: "8px 10px" }}
              onFocus={e => e.currentTarget.style.borderColor = C.gold}
              onBlur={e => e.currentTarget.style.borderColor = C.border}
              placeholder="Что понял? Какие открытия сделал?" />
          </div>

          {/* Problems */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 700, color: C.dark, display: "block", marginBottom: 6 }}>
              🔧 Проблемы и решения
            </label>
            <textarea value={problems} onChange={e => setProblems(e.target.value)}
              style={{ ...baseInp, height: 72, resize: "vertical", lineHeight: 1.5, padding: "8px 10px" }}
              onFocus={e => e.currentTarget.style.borderColor = C.gold}
              onBlur={e => e.currentTarget.style.borderColor = C.border}
              placeholder="С чем столкнулся? Как решал или планируешь решить?" />
          </div>
        </div>

        <div style={{ padding: "14px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 10, background: "#FAFAF8" }}>
          <button onClick={onClose} style={btnS("ghost")}>Отмена</button>
          <button onClick={() => onSave({ rating, insights, problems })}
            style={{ ...btnS("primary"), display: "flex", alignItems: "center", gap: 6 }}>
            ⏹ Завершить день
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══ STRATEGY PANEL (inline in week view) ══════════════════ */
function StrategyPanel({ emp, strat, onUpdate, wd }) {
  const [open, setOpen] = useState(true);

  // Проверяем: задача из стратегии уже выполнена в каком-то дне?
  const getDayStatus = (g) => {
    if (!wd) return null;
    const ed = wd.employees.find(e => e.employeeId === emp.id);
    if (!ed) return null;
    for (const day of ed.days) {
      const match = day.tasks.find(t => t.fromStrategy && t.task === g.task);
      if (match) return match.status || (match.done ? "done" : "progress");
    }
    return null;
  };

  const doneCount = strat.filter(g => getDayStatus(g) === "done").length;

  return (
    <div style={{ marginBottom: 6, background: C.goldLight, border: `1px solid rgba(200,146,42,.3)`, borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(p => !p)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
        <span style={{ fontSize: 14 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#7D5A20" }}>🎯 Стратегия {emp.name}</span>
        <span style={{ fontSize: 11, color: "#A07830", marginLeft: 4 }}>{doneCount}/{strat.length} выполнено</span>
        <span style={{ fontSize: 10, color: "#B08840", marginLeft: "auto" }}>← перетащите в день</span>
      </button>
      {open && (
        <div style={{ padding: "4px 12px 8px", display: "flex", flexWrap: "wrap", gap: 5 }}>
          {strat.filter(g => getDayStatus(g) !== "done").map(g => {
            const dayStatus = getDayStatus(g);
            const isDone = dayStatus === "done";
            const inProgress = dayStatus === "progress";
            return (
              <div key={g.id} draggable={!isDone}
                onDragStart={(e) => {
                  if (isDone) { e.preventDefault(); return; }
                  _stratDrag = { task: g.task, result: g.result, plan: g.hours ? String(Math.round(parseFloat(g.hours) * 60)) : "", priority: g.priority, isFocus: true, fromStrategy: true };
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => { _stratDrag = null; }}
                style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
                  background: isDone ? "rgba(5,150,105,.12)" : inProgress ? "rgba(217,119,6,.1)" : "#fff",
                  borderRadius: 8,
                  border: isDone ? `1px solid rgba(5,150,105,.4)` : inProgress ? `1px solid rgba(217,119,6,.4)` : `1px solid rgba(200,146,42,.4)`,
                  cursor: isDone ? "default" : "grab",
                  fontSize: 12, color: isDone ? C.success : "#1F2937",
                  boxShadow: "0 1px 3px rgba(0,0,0,.08)", userSelect: "none",
                  opacity: isDone ? .8 : 1,
                  textDecoration: isDone ? "line-through" : "none",
                }}>
                {isDone && <span style={{ fontSize: 11, flexShrink: 0 }}>✓</span>}
                {inProgress && <span style={{ fontSize: 11, flexShrink: 0 }}>◑</span>}
                {g.priority && <span style={{ fontWeight: 700, color: isDone ? C.success : C.gold, fontSize: 11 }}>{g.priority}.</span>}
                <span style={{ fontWeight: 600 }}>{g.task || "—"}</span>
                {g.hours && <span style={{ fontSize: 10, color: C.muted }}>({g.hours}ч)</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══ EMPLOYEE HEADER ══════════════════════════════════════ */
function EmpHeader({ emp, emps, onUpdate, onDragStart }) {
  const [editName, setEditName] = useState(false);
  const [nameVal, setNameVal] = useState(emp.name);
  const [showEmoji, setShowEmoji] = useState(false);
  const emojiRef = useRef(null);

  const updEmp = (ch) => onUpdate(emps.map(e => e.id === emp.id ? { ...e, ...ch } : e));

  useEffect(() => {
    const h = (e) => { if (emojiRef.current && !emojiRef.current.contains(e.target)) setShowEmoji(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div draggable onDragStart={onDragStart}
      style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "7px 14px", background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, userSelect: "none" }}>

      <div style={{ cursor: "grab", color: "#C0BAB0", fontSize: 16, flexShrink: 0, lineHeight: 1 }} title="Перетащить для сортировки">⠿</div>

      <div style={{ width: 5, height: 26, borderRadius: 3, background: emp.color, flexShrink: 0 }} />

      {/* Emoji picker */}
      <div style={{ position: "relative", flexShrink: 0 }} ref={emojiRef}>
        <button onClick={() => setShowEmoji(p => !p)}
          style={{ background: showEmoji ? C.goldLight : "none", border: `1px solid ${showEmoji ? C.gold : "transparent"}`, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 5px", borderRadius: 7, transition: "all .15s" }}
          title="Выбрать иконку">{emp.emoji || "👤"}</button>
        {showEmoji && (
          <div style={{ position: "absolute", top: "110%", left: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "10px 12px", display: "flex", flexWrap: "wrap", width: 240, gap: 2, zIndex: 100, boxShadow: "0 8px 28px rgba(0,0,0,.15)" }}>
            <div style={{ width: "100%", fontSize: 10, color: C.muted, fontWeight: 600, marginBottom: 5, letterSpacing: .5 }}>ИКОНКА СОТРУДНИКА</div>
            {EMOJIS.map(e => (
              <button key={e} onClick={() => { updEmp({ emoji: e }); setShowEmoji(false); }}
                style={{ background: emp.emoji === e ? C.goldLight : "none", border: emp.emoji === e ? `1px solid ${C.gold}` : "1px solid transparent", cursor: "pointer", fontSize: 18, padding: "4px 5px", borderRadius: 6 }}
                onMouseEnter={ev => { if (emp.emoji !== e) ev.currentTarget.style.background = "#F5F4F1"; }}
                onMouseLeave={ev => { if (emp.emoji !== e) ev.currentTarget.style.background = "none"; }}>{e}</button>
            ))}
          </div>
        )}
      </div>

      {/* Name */}
      {editName ? (
        <input value={nameVal} autoFocus onChange={e => setNameVal(e.target.value)}
          onBlur={() => { updEmp({ name: nameVal.trim() || emp.name }); setEditName(false); }}
          onKeyDown={e => e.key === "Enter" && e.target.blur()}
          style={{ ...baseInp, fontWeight: 700, fontSize: 15, flex: 1, borderColor: C.gold }} />
      ) : (
        <span onClick={() => { setNameVal(emp.name); setEditName(true); }}
          title="Нажмите, чтобы изменить имя"
          style={{ fontWeight: 700, fontSize: 15, cursor: "text", flex: 1, color: C.dark }}>{emp.name}</span>
      )}

      {/* Color */}
      <label title="Изменить цвет" style={{ flexShrink: 0, cursor: "pointer" }}>
        <div style={{ width: 24, height: 24, borderRadius: 7, background: emp.color, border: "2px solid rgba(0,0,0,.1)", position: "relative", overflow: "hidden" }}>
          <input type="color" value={emp.color} onChange={e => updEmp({ color: e.target.value })}
            style={{ position: "absolute", inset: -6, opacity: 0, cursor: "pointer", width: "300%", height: "300%" }} />
        </div>
      </label>
    </div>
  );
}

/* ═══ DAY CELL ═════════════════════════════════════════════ */
function DayCell({ dayData, wts, empColor, onUpdate, date, onStartDay, onOpenEndDay, onTogglePause }) {
  const tasks = dayData?.tasks || [];
  const updF = (f, v) => onUpdate({ ...dayData, [f]: v });
  const [dragTaskIdx, setDragTaskIdx] = useState(null);
  const [dragOverTaskIdx, setDragOverTaskIdx] = useState(null);
  const [stratDragOver, setStratDragOver] = useState(false);

  const today0 = new Date(); today0.setHours(0,0,0,0);
  const isToday = date && date.getTime() === today0.getTime();
  const started = !!dayData?.startTime;
  const ended = !!dayData?.endTime;

  const addTask = (afterIdx = tasks.length - 1) => {
    const nt = emptyTask();
    const arr = [...tasks.slice(0, afterIdx + 1), nt, ...tasks.slice(afterIdx + 1)];
    onUpdate({ ...dayData, tasks: arr });
  };

  const updTask = (updated) => onUpdate({ ...dayData, tasks: tasks.map(t => t.id === updated.id ? updated : t) });
  const rmTask = (id) => onUpdate({ ...dayData, tasks: tasks.filter(t => t.id !== id) });

  // После сортировки — пересчитываем приоритет по позиции
  const renumber = (arr) => arr.map((t, i) => ({ ...t, priority: String(i + 1) }));

  const handleTaskDrop = (toIdx) => {
    if (_stratDrag) {
      const newTask = { ...emptyTask(), ...(_stratDrag), id: mkId() };
      const arr = renumber([...tasks.slice(0, toIdx + 1), newTask, ...tasks.slice(toIdx + 1)]);
      onUpdate({ ...dayData, tasks: arr });
      _stratDrag = null; setStratDragOver(false); return;
    }
    if (dragTaskIdx === null || dragTaskIdx === toIdx) { setDragTaskIdx(null); setDragOverTaskIdx(null); return; }
    const arr = [...tasks]; const [m] = arr.splice(dragTaskIdx, 1); arr.splice(toIdx, 0, m);
    onUpdate({ ...dayData, tasks: renumber(arr) }); setDragTaskIdx(null); setDragOverTaskIdx(null);
  };

  // Drop on cell body (adds to end)
  const handleCellDrop = (e) => {
    e.preventDefault();
    if (!_stratDrag) return;
    const newTask = { ...emptyTask(), ...(_stratDrag), id: mkId() };
    onUpdate({ ...dayData, tasks: [...tasks, newTask] });
    _stratDrag = null; setStratDragOver(false);
  };

  const totalFact = tasks.reduce((s, t) => { const m = parseMinutes(t.timeRange); return s + (m ?? parseInt(t.fact) || 0); }, 0);
  const doneCnt = tasks.filter(t => t.done).length;

  return (
    <div style={{ background: C.card, borderRadius: 10, overflow: "hidden", border: `1px solid ${stratDragOver ? C.gold : C.border}`, boxShadow: stratDragOver ? `0 0 0 3px rgba(200,146,42,.2)` : "none", transition: "border-color .15s, box-shadow .15s" }}
      onDragOver={e => { e.preventDefault(); if (_stratDrag) setStratDragOver(true); }}
      onDragLeave={() => setStratDragOver(false)}
      onDrop={handleCellDrop}>
      <div style={{ height: 3, background: empColor }} />
      <div style={{ padding: "8px 10px" }}>

        <input value={dayData?.dayResult || ""} onChange={e => updF("dayResult", e.target.value)}
          style={{ ...baseInp, fontSize: 11, fontWeight: 600, padding: "3px 6px", marginBottom: 3 }}
          onFocus={e => e.currentTarget.style.borderColor = C.gold}
          onBlur={e => e.currentTarget.style.borderColor = C.border}
          placeholder="🎯 Результат дня" />

        {tasks.length > 0 && (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 4, fontSize: 10 }}>
              <span style={{ color: doneCnt > 0 ? C.success : C.muted }}>{doneCnt}/{tasks.length} задач</span>
              {totalFact > 0 && <span style={{ color: C.success }}>· ⏱{fmtMin(totalFact)}</span>}
            </div>
            <div style={{ height: 1, background: "#F0EDE8", marginBottom: 4 }} />
          </>
        )}

        {tasks.map((task, i) => (
          <InlineTask key={task.id} task={task} wts={wts}
            isNew={!task.task && i === tasks.length - 1}
            isDragOver={dragOverTaskIdx === i && dragTaskIdx !== i}
            onChange={updTask}
            onDelete={() => rmTask(task.id)}
            onAddBelow={() => addTask(i)}
            onDragStart={() => setDragTaskIdx(i)}
            onDragOver={(e) => { e.preventDefault(); setDragOverTaskIdx(i); }}
            onDrop={() => handleTaskDrop(i)}
            onDragLeave={() => setDragOverTaskIdx(p => p === i ? null : p)} />
        ))}

        <button onClick={() => addTask()}
          style={{ fontSize: 11, color: "#B0ABA4", background: "none", border: "none", cursor: "pointer", padding: "3px 0", fontFamily: "inherit", display: "block", marginTop: 2 }}
          onMouseEnter={e => e.currentTarget.style.color = C.gold}
          onMouseLeave={e => e.currentTarget.style.color = "#B0ABA4"}>+ задача</button>

        {/* Start / End / Pause day */}
        <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid #F0EDE8` }}>
          {!started ? (
            <button onClick={onStartDay}
              style={{ width: "100%", fontSize: 10, fontWeight: 600, color: C.success, background: "rgba(5,150,105,.07)", border: `1px solid rgba(5,150,105,.2)`, borderRadius: 6, padding: "3px 0", cursor: "pointer", fontFamily: "inherit" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(5,150,105,.14)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(5,150,105,.07)"}>
              ▶ Начать день
            </button>
          ) : !ended ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 9, fontWeight: 600, textAlign: "center", color: dayData.pauseStart ? "#B07820" : C.success }}>
                {dayData.pauseStart
                  ? `⏸ Пауза с ${new Date(dayData.pauseStart).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
                  : `● Начат ${new Date(dayData.startTime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`}
              </div>
              <div style={{ display: "flex", gap: 3 }}>
                <button onClick={onTogglePause}
                  style={{ flex: 1, fontSize: 9, fontWeight: 600, color: "#8B6010", background: "rgba(200,146,42,.08)", border: `1px solid rgba(200,146,42,.25)`, borderRadius: 6, padding: "3px 0", cursor: "pointer", fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(200,146,42,.16)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(200,146,42,.08)"}>
                  {dayData.pauseStart ? "▶ Продолжить" : "⏸ Пауза"}
                </button>
                <button onClick={onOpenEndDay}
                  style={{ flex: 1, fontSize: 9, fontWeight: 600, color: "#B05010", background: "rgba(220,100,20,.07)", border: `1px solid rgba(220,100,20,.25)`, borderRadius: 6, padding: "3px 0", cursor: "pointer", fontFamily: "inherit" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(220,100,20,.14)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(220,100,20,.07)"}>
                  ⏹ Завершить
                </button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 9, color: C.muted, textAlign: "center", lineHeight: 1.6 }}>
              <span style={{ color: C.success }}>▶ {new Date(dayData.startTime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
              {" · "}
              <span style={{ color: "#B05010" }}>⏹ {new Date(dayData.endTime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
              {dayData.rating && <span style={{ marginLeft: 4 }}>{"⭐".repeat(Math.min(dayData.rating, 5))}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══ TASK TIMER ════════════════════════════════════════════ */
// Форматирует живое время с секундами: "45с" / "12м 30с" / "1ч 5м"
function fmtLive(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

function TaskTimer({ task, onChange }) {
  const [now, setNow] = useState(Date.now());
  const running = !!task.timerStart;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Время завершённых сессий (в миллисекундах для точности)
  const completedMs = (task.sessions || []).reduce(
    (s, p) => s + (new Date(p.end) - new Date(p.start)), 0
  );
  // Живое время текущей сессии
  const liveMs = running ? now - new Date(task.timerStart) : 0;
  const totalMs = completedMs + liveMs;
  const totalMin = Math.round(totalMs / 60000);

  const toggle = () => {
    if (!running) {
      // ▶ Старт — если задача не начата, переводим в «В работе»
      const now = new Date();
      const patch = { timerStart: now.toISOString() };
      if (!task.status || task.status === "") patch.status = "progress";
      // Если хронометраж ещё не заполнен — ставим время начала
      if (!task.timeRange || task.timeRange.trim() === "") {
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        patch.timeRange = `${hh}:${mm}`;
      }
      onChange({ ...task, ...patch });
    } else {
      // ■ Стоп — сохраняем сессию, дописываем конец в хронометраж
      const session = { start: task.timerStart, end: new Date().toISOString() };
      const sessions = [...(task.sessions || []), session];
      const newTotalMin = Math.round(
        sessions.reduce((s, p) => s + (new Date(p.end) - new Date(p.start)), 0) / 60000
      );
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      // Дописать конец к хронометражу если начало было записано
      let newRange = task.timeRange || "";
      if (newRange && !newRange.includes("-") && !newRange.includes("–")) {
        newRange = `${newRange} - ${hh}:${mm}`;
      }
      onChange({
        ...task,
        timerStart: null,
        sessions,
        fact: String(newTotalMin),
        plan: task.plan && parseInt(task.plan) > 0 ? task.plan : String(newTotalMin),
        timeRange: newRange,
      });
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
      <button onClick={toggle}
        title={running
          ? `⏹ Стоп · сессия ${fmtLive(liveMs)}, всего ${fmtMin(totalMin)}`
          : totalMin > 0 ? `▶ Продолжить · накоплено ${fmtMin(totalMin)}` : "▶ Запустить таймер"}
        style={{
          width: 20, height: 20, borderRadius: "50%",
          border: `2px solid ${running ? C.danger : C.success}`,
          background: running ? "rgba(220,38,38,.12)" : "rgba(5,150,105,.1)",
          color: running ? C.danger : C.success,
          fontSize: 8, fontWeight: 900, cursor: "pointer", padding: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "inherit", flexShrink: 0,
          boxShadow: running ? `0 0 0 3px rgba(220,38,38,.15)` : "none",
          transition: "all .2s"
        }}
        onMouseEnter={e => e.currentTarget.style.transform = "scale(1.18)"}
        onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
        {running ? "■" : "▶"}
      </button>

      {/* Живое время текущей сессии — обновляется каждую секунду */}
      {running && (
        <span style={{ fontSize: 10, color: C.danger, fontWeight: 700, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", minWidth: 38 }}>
          {fmtLive(liveMs)}
        </span>
      )}
      {/* Накопленное время (когда не идёт) */}
      {!running && totalMin > 0 && (
        <span style={{ fontSize: 9, color: C.success, fontWeight: 600, whiteSpace: "nowrap", minWidth: 26 }}>
          {fmtMin(totalMin)}
        </span>
      )}
    </div>
  );
}

/* ═══ STATUS BUTTON ════════════════════════════════════════ */
// status cycle: "" (не начато) → "progress" (в работе) → "done" (завершено) → ""
const STATUS_CFG = {
  "":         { icon: "○", color: "#C8C4BE", bg: "transparent", border: "#D8D4CE", title: "Не начато" },
  "progress": { icon: "◑", color: "#D97706", bg: "rgba(217,119,6,.08)", border: "rgba(217,119,6,.4)", title: "В работе" },
  "done":     { icon: "✓", color: C.success, bg: "rgba(5,150,105,.08)", border: "rgba(5,150,105,.4)", title: "Завершено" },
};
function cycleStatus(cur) { return cur === "" ? "progress" : cur === "progress" ? "done" : ""; }

function StatusButton({ status, onChange, size = 14 }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG[""];
  return (
    <button onClick={() => onChange(cycleStatus(status))} title={cfg.title}
      style={{ width: size, height: size, borderRadius: "50%", border: `1.5px solid ${cfg.border}`, background: cfg.bg, color: cfg.color, fontSize: size * .7, fontWeight: 700, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit", flexShrink: 0, lineHeight: 1 }}>
      {cfg.icon}
    </button>
  );
}

/* ═══ INLINE TASK ══════════════════════════════════════════ */
// taskType cycle: "" → "С" (стратегическая) → "Т" (тактическая) → ""
const TASK_TYPE_CFG = {
  "С": { label: "С", bg: "#FFF3D0", color: "#8B5E10", border: "rgba(200,146,42,.5)", title: "Стратегическая" },
  "Т": { label: "Т", bg: "#EFF6FF", color: "#1D4ED8", border: "rgba(59,130,246,.4)", title: "Тактическая" },
};
function cycleTaskType(cur) { return cur === "" ? "С" : cur === "С" ? "Т" : ""; }

function InlineTask({ task, wts, onChange, onDelete, onAddBelow, isNew, isDragOver, onDragStart, onDragOver, onDrop, onDragLeave }) {
  const [, rerender] = useState(0);
  // Live-обновление пока таймер идёт
  useEffect(() => {
    if (!task.timerStart) return;
    const id = setInterval(() => rerender(p => p + 1), 1000);
    return () => clearInterval(id);
  }, [task.timerStart]);

  const sessionMin = taskTrackedMin(task);
  const liveMin = task.timerStart ? Math.round((Date.now() - new Date(task.timerStart)) / 60000) : 0;
  const trackedMin = sessionMin + liveMin;
  const planMin = parseMinutes(task.timeRange) ?? (task.plan ? parseInt(task.plan) || 0 : 0);
  // Факт: если трекали — накопленное время; если нет — план (по умолчанию)
  const factMins = trackedMin > 0 ? trackedMin : planMin > 0 ? planMin : null;
  const factIsTracked = trackedMin > 0; // true = реальный факт, false = по умолчанию из плана
  const upd = (f, v) => {
    const u = { ...task, [f]: v };
    if (f === "timeRange") {
      const m = parseMinutes(v);
      if (m !== null) { u.fact = String(m); u.plan = String(m); }
    }
    if (f === "status") u.done = v === "done";
    onChange(u);
  };
  const status = task.status || (task.done ? "done" : "");

  const tt = TASK_TYPE_CFG[task.taskType];
  const isFocusBorder = task.isFocus ? { borderLeft: `3px solid ${C.gold}`, paddingLeft: 3 } : {};

  return (
    <div draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave}
      style={{ marginBottom: 5, paddingBottom: 5, borderBottom: `1px solid #F2F0EC`,
        borderTop: isDragOver ? `2px dashed ${C.gold}` : "2px solid transparent",
        opacity: isDragOver ? .6 : 1,
        background: task.taskType === "С" ? "rgba(200,146,42,.04)" : task.taskType === "Т" ? "rgba(59,130,246,.03)" : "none",
        ...isFocusBorder }}>

      {/* Строка 1: ручка · тип · чекбокс · П · задача · ⭐ · × */}
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <span style={{ cursor: "grab", color: "#C8C4BE", fontSize: 11, flexShrink: 0, lineHeight: 1, userSelect: "none" }}>⠿</span>

        {/* Task type badge — click to cycle */}
        <button onClick={() => upd("taskType", cycleTaskType(task.taskType))}
          title={tt ? `${tt.title} — нажмите для смены типа` : "Нажмите чтобы указать тип: С (стратегическая) или Т (тактическая)"}
          style={{ width: 16, height: 16, borderRadius: 4, border: tt ? `1px solid ${tt.border}` : `1px dashed #D8D4CE`, background: tt ? tt.bg : "transparent", color: tt ? tt.color : "#C8C4BE", fontSize: 9, fontWeight: 700, cursor: "pointer", padding: 0, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
          {tt ? tt.label : "·"}
        </button>

        <StatusButton status={status} onChange={v => upd("status", v)} size={13} />

        <input value={task.priority} onChange={e => upd("priority", e.target.value)}
          style={{ width: 16, fontSize: 10, fontWeight: 700, color: C.gold, border: "none", background: "transparent", textAlign: "center", padding: 0, outline: "none", fontFamily: "inherit", flexShrink: 0 }}
          maxLength={2} placeholder="П" title="Приоритет" />

        <input value={task.task} onChange={e => upd("task", e.target.value)} autoFocus={isNew}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onAddBelow(); } }}
          style={{ flex: 1, fontSize: 12, border: "none", background: "transparent",
            color: status === "done" ? "#9CA3AF" : C.text,
            textDecoration: status === "done" ? "line-through" : "none",
            fontWeight: task.isFocus || task.taskType === "С" ? 700 : 400,
            padding: "1px 0", outline: "none", fontFamily: "inherit", minWidth: 0 }}
          placeholder="Задача..." />

        {task.isFocus && <span style={{ fontSize: 9, flexShrink: 0, opacity: .8 }} title="Фокус из стратегии">⭐</span>}
        <button onClick={onDelete}
          style={{ background: "none", border: "none", color: "#D8D4CE", cursor: "pointer", fontSize: 14, padding: "0 1px", flexShrink: 0, lineHeight: 1 }}
          onMouseEnter={e => e.currentTarget.style.color = C.danger}
          onMouseLeave={e => e.currentTarget.style.color = "#D8D4CE"}>×</button>
      </div>

      {/* Строка 2: ▶ таймер · хронометраж · одно поле времени · [тип работы] */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 20, marginTop: 2 }}>
        <TaskTimer task={task} onChange={onChange} />
        <input value={task.timeRange} onChange={e => upd("timeRange", e.target.value)}
          style={{ width: 70, fontSize: 10, border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 5px", background: C.inputBg, fontFamily: "inherit", color: C.text, outline: "none", transition: "border-color .15s" }}
          onFocus={e => e.currentTarget.style.borderColor = C.gold}
          onBlur={e => { e.currentTarget.style.borderColor = C.border; const f = smartTime(task.timeRange); if (f !== task.timeRange) upd("timeRange", f); }}
          placeholder="10-12" />
        {/* Одно поле времени: трекер приоритетнее хронометража */}
        {factMins !== null && factMins > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
            color: factIsTracked ? C.success : C.muted,
            padding: "1px 5px", borderRadius: 4,
            background: factIsTracked ? "rgba(5,150,105,.08)" : "transparent"
          }}>
            ⏱ {fmtMin(factMins)}
          </span>
        )}
        <div style={{ marginLeft: "auto", flexShrink: 0, position: "relative" }}>
          <WorkTypePill value={task.workType} wts={wts} onChange={v => upd("workType", v)} />
        </div>
      </div>

      {/* Строка 3: результат — полная ширина */}
      <div style={{ marginLeft: 20, marginTop: 2 }}>
        <input value={task.result || ""} onChange={e => upd("result", e.target.value)}
          style={{ width: "100%", fontSize: 10, border: "1px solid transparent", borderRadius: 4, padding: "2px 4px", background: "transparent", fontFamily: "inherit", color: C.muted, outline: "none", boxSizing: "border-box", transition: "all .15s" }}
          onFocus={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.inputBg; }}
          onBlur={e => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.background = "transparent"; }}
          placeholder="Результат задачи..." />
      </div>
    </div>
  );
}

/* Work type compact pill — colored dot + 2-letter abbrev, click to pick */
const WT_COLORS = ["#F4B8D1","#A8D8EA","#B8E0C8","#FFD9A8","#C5B8E8","#F9C8C8","#B8E8D8","#FFE0A8"];
function WorkTypePill({ value, wts, onChange }) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const dropRef = useRef(null);
  const wt = wts.find(w => w.id === value);
  const color = wt ? WT_COLORS[wts.indexOf(wt) % WT_COLORS.length] : null;
  const abbr = wt ? wt.name.slice(0, 2) : null;

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen(p => !p);
  };

  useEffect(() => {
    const h = e => {
      if (open && dropRef.current && !dropRef.current.contains(e.target) && !btnRef.current?.contains(e.target))
        setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <>
      <button ref={btnRef} onClick={handleToggle} title={wt ? wt.name : "Выбрать тип работы"}
        style={{ display: "flex", alignItems: "center", gap: 3, padding: "2px 6px", borderRadius: 10,
          border: `1px solid ${color ? "rgba(0,0,0,.1)" : C.border}`,
          background: color || "transparent", cursor: "pointer", fontFamily: "inherit", transition: "opacity .15s" }}
        onMouseEnter={e => e.currentTarget.style.opacity = ".7"}
        onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
        {wt
          ? <span style={{ fontSize: 9, fontWeight: 700, color: "#1F2937", whiteSpace: "nowrap" }}>{abbr}</span>
          : <span style={{ fontSize: 9, color: "#C8C4BE" }}>тип</span>}
      </button>

      {open && (
        <div ref={dropRef} style={{
          position: "fixed", top: dropPos.top, right: dropPos.right,
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
          zIndex: 9999, minWidth: 160, maxHeight: 240, overflowY: "auto",
          boxShadow: "0 8px 24px rgba(0,0,0,.15)"
        }}>
          <button onClick={() => { onChange(""); setOpen(false); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
              background: !value ? "#F5F4F1" : "none", border: "none", borderBottom: `1px solid ${C.border}`,
              fontSize: 12, color: C.muted, cursor: "pointer", fontFamily: "inherit" }}>
            — без типа
          </button>
          {wts.map((w, i) => (
            <button key={w.id} onClick={() => { onChange(w.id); setOpen(false); }}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
                padding: "8px 12px", background: value === w.id ? "#F5F4F1" : "none",
                border: "none", borderBottom: `1px solid #F5F4F1`,
                fontSize: 12, color: C.text, cursor: "pointer", fontFamily: "inherit" }}
              onMouseEnter={e => e.currentTarget.style.background = "#F5F4F1"}
              onMouseLeave={e => e.currentTarget.style.background = value === w.id ? "#F5F4F1" : "none"}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: WT_COLORS[i % WT_COLORS.length], flexShrink: 0 }} />
              {w.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* ═══ DAY VIEW ══════════════════════════════════════════════ */
function DayView({ wd, emps, wts, dates, selectedDay, onSelectDay, onUpdDay }) {
  const date = dates[selectedDay];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (
    <div>
      <div style={{ ...cardS, padding: "12px 18px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => onSelectDay(Math.max(0, selectedDay - 1))}
          style={{ ...btnS("ghost"), padding: "6px 14px", fontSize: 18, lineHeight: 1 }}>‹</button>
        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 20, color: C.dark }}>{DAY_NAMES[selectedDay]}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
        <button onClick={() => onSelectDay(Math.min(5, selectedDay + 1))}
          style={{ ...btnS("ghost"), padding: "6px 14px", fontSize: 18, lineHeight: 1 }}>›</button>
        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {dates.map((d, i) => {
            const isTod = d.getTime() === today.getTime();
            const isSel = i === selectedDay;
            return (
              <button key={i} onClick={() => onSelectDay(i)} style={{
                padding: "5px 10px", borderRadius: 7,
                border: isSel ? `2px solid ${C.gold}` : `1px solid ${C.border}`,
                background: isSel ? C.goldLight : isTod ? "#FFF8E8" : C.card,
                color: isSel ? C.gold : isTod ? "#8B5E10" : C.text,
                cursor: "pointer", fontSize: 12, fontWeight: isSel || isTod ? 700 : 500, fontFamily: "inherit", textAlign: "center",
                boxShadow: isTod && !isSel ? `0 0 0 2px rgba(200,146,42,.3)` : "none"
              }}>
                <div>{DAY_SHORT[i]}</div>
                <div style={{ fontSize: 9, opacity: .7 }}>{d.getDate()}</div>
              </button>
            );
          })}
        </div>
      </div>
      {emps.map(emp => {
        const ed = wd.employees.find(e => e.employeeId === emp.id);
        const dayData = ed?.days[selectedDay] || { dayIndex: selectedDay, schedule: "", dayResult: "", tasks: [] };
        return <DayViewEmployee key={emp.id} emp={emp} dayData={dayData} wts={wts} onUpdate={(dd) => onUpdDay(emp.id, selectedDay, dd)} />;
      })}
    </div>
  );
}

function DayViewEmployee({ emp, dayData, wts, onUpdate }) {
  const tasks = dayData?.tasks || [];
  const updF = (f, v) => onUpdate({ ...dayData, [f]: v });
  const [dragTaskIdx, setDragTaskIdx] = useState(null);
  const [dragOverTaskIdx, setDragOverTaskIdx] = useState(null);
  const addTask = (afterIdx = tasks.length - 1) => {
    const nt = emptyTask();
    onUpdate({ ...dayData, tasks: [...tasks.slice(0, afterIdx + 1), nt, ...tasks.slice(afterIdx + 1)] });
  };
  const updTask = (updated) => onUpdate({ ...dayData, tasks: tasks.map(t => t.id === updated.id ? updated : t) });
  const rmTask = (id) => onUpdate({ ...dayData, tasks: tasks.filter(t => t.id !== id) });
  const handleTaskDrop = (toIdx) => {
    if (dragTaskIdx === null || dragTaskIdx === toIdx) { setDragTaskIdx(null); setDragOverTaskIdx(null); return; }
    const arr = [...tasks]; const [m] = arr.splice(dragTaskIdx, 1); arr.splice(toIdx, 0, m);
    const renumbered = arr.map((t, i) => ({ ...t, priority: String(i + 1) }));
    onUpdate({ ...dayData, tasks: renumbered }); setDragTaskIdx(null); setDragOverTaskIdx(null);
  };

  const doneCnt = tasks.filter(t => t.done).length;
  const totalFact = tasks.reduce((s, t) => { const m = parseMinutes(t.timeRange); return s + (m ?? parseInt(t.fact) || 0); }, 0);
  const totalPlan = tasks.reduce((s, t) => s + (parseInt(t.plan) || 0), 0);

  return (
    <div style={{ background: C.card, borderRadius: 14, overflow: "hidden", marginBottom: 18, border: `1px solid ${C.border}`, boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>
      {/* Header strip */}
      <div style={{ background: emp.color, padding: "12px 18px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 26, lineHeight: 1 }}>{emp.emoji || "👤"}</span>
        <span style={{ fontWeight: 700, fontSize: 17, color: "#1F2937" }}>{emp.name}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>Сколько сделано: {doneCnt}/{tasks.length}</span>
          {tasks.length > 0 && (
            <div style={{ width: 80, height: 6, background: "rgba(0,0,0,.12)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${tasks.length > 0 ? Math.round(doneCnt / tasks.length * 100) : 0}%`, background: "#059669", borderRadius: 3 }} />
            </div>
          )}
        </div>
      </div>

      {/* Результат дня */}
      <div style={{ padding: "8px 18px", background: "#FDFCFB", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.muted, whiteSpace: "nowrap" }}>🎯 Результат дня:</span>
        <input value={dayData?.dayResult || ""} onChange={e => updF("dayResult", e.target.value)}
          style={{ ...baseInp, fontSize: 12, padding: "4px 8px" }}
          onFocus={e => e.currentTarget.style.borderColor = C.gold}
          onBlur={e => e.currentTarget.style.borderColor = C.border}
          placeholder="Какой итог должен быть сегодня?" />
      </div>

      {/* Tasks table */}
      <div className="day-table-wrap" style={{ overflowX: "auto" }}>
        <table className="day-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
          <thead>
            <tr>
              <th style={{ ...thS, width: 24, textAlign: "center" }}></th>
              <th style={{ ...thS, width: 32, textAlign: "center" }}>✓</th>
              <th style={{ ...thS, width: 32, textAlign: "center" }}>П</th>
              <th style={{ ...thS, minWidth: 180 }}>Задача</th>
              <th style={{ ...thS, width: 44, textAlign: "center" }}>▶</th>
              <th style={{ ...thS, width: 110 }}>Хронометраж</th>
              <th style={{ ...thS, width: 80, textAlign: "center" }}>⏱ Время</th>
              <th style={{ ...thS, width: 120 }}>Тип работы</th>
              <th style={{ ...thS, minWidth: 120 }}>Результат</th>
              <th style={{ ...thS, width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr><td colSpan={10} style={{ ...tdS, textAlign: "center", color: C.muted, padding: "28px 0", fontSize: 13 }}>Задач нет — нажмите «+ задача» ниже</td></tr>
            )}
            {tasks.map((t, i) => (
              <DayTaskRow key={t.id} task={t} wts={wts} onChange={updTask} onDelete={() => rmTask(t.id)} onAddBelow={() => addTask(i)}
                isDragOver={dragOverTaskIdx === i && dragTaskIdx !== i}
                onDragStart={() => setDragTaskIdx(i)}
                onDragOver={(e) => { e.preventDefault(); setDragOverTaskIdx(i); }}
                onDrop={() => handleTaskDrop(i)}
                onDragLeave={() => setDragOverTaskIdx(p => p === i ? null : p)} />
            ))}
          </tbody>
          {tasks.length > 0 && (
            <tfoot>
              <tr style={{ background: "#F9F8F6" }}>
                <td colSpan={5} style={{ ...tdS, fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: .3, padding: "7px 8px" }}>ИТОГО</td>
                <td style={{ ...tdS, textAlign: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: C.success }}>{totalFact > 0 ? fmtMin(totalFact) : "—"}</span>
                </td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div style={{ padding: "10px 18px", borderTop: tasks.length > 0 ? `1px solid ${C.border}` : "none" }}>
        <button onClick={() => addTask()}
          style={{ fontSize: 12, color: C.muted, background: "none", border: `1px dashed ${C.border}`, borderRadius: 7, cursor: "pointer", padding: "5px 16px", fontFamily: "inherit", width: "100%", transition: "all .15s" }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.color = C.gold; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted; }}>
          + задача
        </button>
      </div>
    </div>
  );
}

function DayTaskRow({ task, wts, onChange, onDelete, onAddBelow, isDragOver, onDragStart, onDragOver, onDrop, onDragLeave }) {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!task.timerStart) return;
    const id = setInterval(() => rerender(p => p + 1), 1000);
    return () => clearInterval(id);
  }, [task.timerStart]);

  const sessionMin = taskTrackedMin(task);
  const liveMin = task.timerStart ? Math.round((Date.now() - new Date(task.timerStart)) / 60000) : 0;
  const trackedMin = sessionMin + liveMin;
  const planMin = parseMinutes(task.timeRange) ?? (task.plan ? parseInt(task.plan) || 0 : 0);
  const factMins = trackedMin > 0 ? trackedMin : planMin > 0 ? planMin : null;
  const factIsTracked = trackedMin > 0;
  const upd = (f, v) => {
    const u = { ...task, [f]: v };
    if (f === "timeRange") {
      const m = parseMinutes(v);
      if (m !== null) { u.fact = String(m); u.plan = String(m); }
    }
    if (f === "status") u.done = v === "done";
    onChange(u);
  };
  const status = task.status || (task.done ? "done" : "");
  const focusBg = task.taskType === "С" ? "rgba(200,146,42,.05)" : task.taskType === "Т" ? "rgba(59,130,246,.03)" : task.isFocus ? "rgba(200,146,42,.04)" : (status === "done" ? "#FAFAF8" : "#fff");
  return (
    <tr draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave}
      style={{ background: focusBg, borderTop: isDragOver ? `2px dashed ${C.gold}` : "none", borderLeft: task.taskType === "С" ? `3px solid ${C.gold}` : task.taskType === "Т" ? `3px solid #3B82F6` : task.isFocus ? `3px solid ${C.gold}` : "none", opacity: isDragOver ? .6 : 1 }}
      onMouseEnter={e => { e.currentTarget.style.background = task.taskType === "С" ? "rgba(200,146,42,.09)" : task.taskType === "Т" ? "rgba(59,130,246,.07)" : "#FEFDFB"; }}
      onMouseLeave={e => { e.currentTarget.style.background = focusBg; }}>
      <td style={{ ...tdS, textAlign: "center", cursor: "grab", color: "#C8C4BE", fontSize: 12, userSelect: "none" }} title="Перетащить">⠿</td>
      <td style={{ ...tdS, textAlign: "center" }}>
        <StatusButton status={status} onChange={v => upd("status", v)} size={16} />
      </td>
      <td style={{ ...tdS, textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 3, justifyContent: "center" }}>
          {/* Task type badge */}
          <button onClick={() => upd("taskType", cycleTaskType(task.taskType))}
            title={TASK_TYPE_CFG[task.taskType] ? `${TASK_TYPE_CFG[task.taskType].title} — нажмите для смены` : "Тип задачи"}
            style={{ width: 18, height: 18, borderRadius: 4, border: TASK_TYPE_CFG[task.taskType] ? `1px solid ${TASK_TYPE_CFG[task.taskType].border}` : `1px dashed #D8D4CE`, background: TASK_TYPE_CFG[task.taskType] ? TASK_TYPE_CFG[task.taskType].bg : "transparent", color: TASK_TYPE_CFG[task.taskType] ? TASK_TYPE_CFG[task.taskType].color : "#C8C4BE", fontSize: 9, fontWeight: 700, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
            {TASK_TYPE_CFG[task.taskType] ? TASK_TYPE_CFG[task.taskType].label : "·"}
          </button>
          <input value={task.priority} onChange={e => upd("priority", e.target.value)} style={{ width: 22, fontSize: 12, fontWeight: 700, color: C.gold, border: "none", background: "transparent", textAlign: "center", padding: 0, outline: "none", fontFamily: "inherit" }} maxLength={2} placeholder="—" />
        </div>
      </td>
      <td style={tdS}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {task.isFocus && <span style={{ fontSize: 12, flexShrink: 0 }} title="Фокус-задача из стратегии">⭐</span>}
          <input value={task.task} onChange={e => upd("task", e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onAddBelow(); } }}
            style={{ ...baseInp, border: "none", background: "transparent", fontSize: 13, textDecoration: status === "done" ? "line-through" : "none", color: status === "done" ? C.muted : C.text, fontWeight: task.taskType === "С" || task.isFocus ? 700 : 400, padding: "2px 0", transition: "all .1s", flex: 1 }}
            onFocus={e => { e.currentTarget.style.border = `1px solid ${C.border}`; e.currentTarget.style.background = C.inputBg; e.currentTarget.style.padding = "2px 8px"; e.currentTarget.style.borderRadius = "5px"; }}
            onBlur={e => { e.currentTarget.style.border = "none"; e.currentTarget.style.background = "transparent"; e.currentTarget.style.padding = "2px 0"; }}
            placeholder="Задача..." />
        </div>
      </td>
      <td style={{ ...tdS, textAlign: "center" }}>
        <TaskTimer task={task} onChange={onChange} />
      </td>
      <td style={tdS}>
        <input value={task.timeRange} onChange={e => upd("timeRange", e.target.value)} style={{ ...baseInp, fontSize: 12, padding: "3px 7px" }}
          onFocus={e => e.currentTarget.style.borderColor = C.gold}
          onBlur={e => { e.currentTarget.style.borderColor = C.border; const f = smartTime(task.timeRange); if (f !== task.timeRange) upd("timeRange", f); }}
          placeholder="10-12" />
      </td>
      <td style={{ ...tdS, textAlign: "center" }}>
        <span style={{
          fontWeight: factIsTracked ? 700 : 500,
          fontSize: 13,
          color: factIsTracked ? C.success : factMins ? C.muted : "#D1D5DB",
          background: factIsTracked ? "rgba(5,150,105,.08)" : "transparent",
          borderRadius: 4, padding: factIsTracked ? "1px 5px" : "0"
        }}>
          {factMins ? fmtMin(factMins) : "—"}
        </span>
      </td>
      <td style={{ ...tdS, textAlign: "center" }}>
        <WorkTypePill value={task.workType} wts={wts} onChange={v => upd("workType", v)} />
      </td>
      <td style={tdS}>
        <input value={task.result || ""} onChange={e => upd("result", e.target.value)} style={{ ...baseInp, fontSize: 12, padding: "3px 7px" }}
          onFocus={e => e.currentTarget.style.borderColor = C.gold} onBlur={e => e.currentTarget.style.borderColor = C.border}
          placeholder="Результат задачи" />
      </td>
      <td style={{ ...tdS, textAlign: "center" }}>
        <button onClick={onDelete} style={{ background: "none", border: "none", color: "#D8D4CE", cursor: "pointer", fontSize: 15, padding: "0 2px", lineHeight: 1 }}
          onMouseEnter={e => e.currentTarget.style.color = C.danger} onMouseLeave={e => e.currentTarget.style.color = "#D8D4CE"}>×</button>
      </td>
    </tr>
  );
}

/* ═══ TASKS VIEW ════════════════════════════════════════════ */
function TasksView({ wd, emps, wts }) {
  const COLS_DEFAULT = [
    { id: "emp",       label: "Исполнитель",          w: 130, editable: false },
    { id: "task",      label: "Задача",                w: 220, editable: true  },
    { id: "time",      label: "⏱ Время",              w: 90,  editable: false },
    { id: "workType",  label: "Вид задачи",            w: 120, editable: true  },
    { id: "updatedAt", label: "Последнее изменение",   w: 155, editable: false },
    { id: "taskType",  label: "С / Т",                w: 70,  editable: true  },
    { id: "status",    label: "Статус",                w: 110, editable: true  },
    { id: "createdAt", label: "Создана",               w: 130, editable: false },
    { id: "createdBy", label: "Кто создал",            w: 110, editable: false },
  ];

  const [filter, setFilter] = useState("active");
  const [sortCol, setSortCol] = useState("createdAt");
  const [sortDir, setSortDir] = useState("desc");
  const [filterEmp, setFilterEmp] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterTaskType, setFilterTaskType] = useState("all");
  const [hoveredSession, setHoveredSession] = useState(null);
  const [cols, setCols] = useState(COLS_DEFAULT);
  const [dragColIdx, setDragColIdx] = useState(null);
  const [dragOverColIdx, setDragOverColIdx] = useState(null);
  const [editCell, setEditCell] = useState(null); // { rowKey, colId }
  const [editVal, setEditVal] = useState("");
  const [tasks, setTasks] = useState([]);

  // Build flat task list from wd
  useEffect(() => {
    if (!wd) return;
    const list = [];
    wd.employees.forEach(ed => {
      const emp = emps.find(e => e.id === ed.employeeId);
      if (!emp) return;
      ed.days.forEach((day, di) => {
        day.tasks.forEach(t => {
          if (!t.task && !t.result) return;
          const lastSession = (t.sessions || []).slice(-1)[0];
          const trackedMin = (t.sessions || []).reduce((s, p) => s + Math.round((new Date(p.end) - new Date(p.start)) / 60000), 0);
          const planMin = parseMinutes(t.timeRange) ?? (t.plan ? parseInt(t.plan) || 0 : 0);
          list.push({ ...t, emp, empId: ed.employeeId, dayIndex: di, lastSession, trackedMin, planMin,
            status: t.status || (t.done ? "done" : ""), rowKey: `${ed.employeeId}-${t.id}` });
        });
      });
    });
    setTasks(list);
  }, [wd, emps]);

  // Filtering
  let rows = tasks.filter(t => {
    if (filter === "done" && t.status !== "done") return false;
    if (filter === "active" && t.status === "done") return false;
    if (filterEmp !== "all" && t.emp.id !== filterEmp) return false;
    if (filterType !== "all" && t.workType !== filterType) return false;
    if (filterStatus !== "all" && t.status !== filterStatus) return false;
    if (filterTaskType !== "all" && t.taskType !== filterTaskType) return false;
    return true;
  });

  // Sorting
  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };
  rows = [...rows].sort((a, b) => {
    const vals = {
      emp: [a.emp.name, b.emp.name],
      task: [a.task, b.task],
      time: [a.trackedMin || a.planMin, b.trackedMin || b.planMin],
      workType: [wts.find(w => w.id === a.workType)?.name || "", wts.find(w => w.id === b.workType)?.name || ""],
      updatedAt: [a.lastSession?.end || a.updatedAt || "", b.lastSession?.end || b.updatedAt || ""],
      taskType: [a.taskType, b.taskType],
      status: [a.status, b.status],
      createdAt: [a.createdAt || "", b.createdAt || ""],
      createdBy: [a.createdBy || a.emp.name, b.createdBy || b.emp.name],
    };
    const [va, vb] = vals[sortCol] || ["", ""];
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  // Column drag
  const handleColDragOver = (idx) => { if (dragColIdx !== null) setDragOverColIdx(idx); };
  const handleColDrop = (idx) => {
    if (dragColIdx === null || dragColIdx === idx) { setDragColIdx(null); setDragOverColIdx(null); return; }
    const arr = [...cols]; const [m] = arr.splice(dragColIdx, 1); arr.splice(idx, 0, m);
    setCols(arr); setDragColIdx(null); setDragOverColIdx(null);
  };

  // Cell edit: start
  const startEdit = (rowKey, colId, currentVal) => {
    const col = cols.find(c => c.id === colId);
    if (!col?.editable) return;
    setEditCell({ rowKey, colId });
    setEditVal(String(currentVal ?? ""));
  };

  // Cell edit: commit
  const commitEdit = () => {
    if (!editCell) return;
    const { rowKey, colId } = editCell;
    setTasks(prev => prev.map(t => {
      if (t.rowKey !== rowKey) return t;
      const updates = {};
      if (colId === "task") updates.task = editVal;
      if (colId === "workType") updates.workType = editVal;
      if (colId === "taskType") updates.taskType = editVal;
      if (colId === "status") { updates.status = editVal; updates.done = editVal === "done"; }
      return { ...t, ...updates };
    }));
    setEditCell(null);
  };

  const fmtDateTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + " " +
           d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };

  const statusLabel = { "": "Не начато", "progress": "В работе", "done": "Завершено" };
  const statusColor = { "": C.muted, "progress": "#D97706", "done": C.success };

  const renderCell = (t, colId) => {
    const isEditing = editCell?.rowKey === t.rowKey && editCell?.colId === colId;
    const wt = wts.find(w => w.id === t.workType);
    const timeVal = t.trackedMin > 0 ? t.trackedMin : t.planMin;
    const isTracked = t.trackedMin > 0;
    const col = cols.find(c => c.id === colId);

    // Editing state - show input
    if (isEditing) {
      if (colId === "status") {
        return (
          <select autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
            onBlur={commitEdit}
            style={{ ...baseInp, fontSize: 12, padding: "3px 6px", cursor: "pointer" }}>
            <option value="">Не начато</option>
            <option value="progress">В работе</option>
            <option value="done">Завершено</option>
          </select>
        );
      }
      if (colId === "taskType") {
        return (
          <select autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
            onBlur={commitEdit}
            style={{ ...baseInp, fontSize: 12, padding: "3px 6px" }}>
            <option value="">—</option>
            <option value="С">С — Стратегическая</option>
            <option value="Т">Т — Тактическая</option>
          </select>
        );
      }
      if (colId === "workType") {
        return (
          <select autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
            onBlur={commitEdit}
            style={{ ...baseInp, fontSize: 12, padding: "3px 6px" }}>
            <option value="">—</option>
            {wts.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        );
      }
      return (
        <input autoFocus value={editVal}
          onChange={e => setEditVal(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditCell(null); }}
          style={{ ...baseInp, fontSize: 12, padding: "3px 7px" }} />
      );
    }

    switch (colId) {
      case "emp":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: t.emp.color, flexShrink: 0 }} />
            <span style={{ fontSize: 14 }}>{t.emp.emoji}</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t.emp.name}</span>
          </div>
        );
      case "task":
        return (
          <div>
            <div style={{ fontSize: 13, color: t.status === "done" ? C.muted : C.text, textDecoration: t.status === "done" ? "line-through" : "none", fontWeight: t.taskType === "С" ? 700 : 400 }}>
              {t.priority && <span style={{ color: C.gold, fontWeight: 700, marginRight: 4 }}>{t.priority}.</span>}
              {t.task || "—"}
            </div>
            {t.result && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>→ {t.result}</div>}
          </div>
        );
      case "time":
        return <span style={{ fontSize: 13, fontWeight: isTracked ? 700 : 400, color: isTracked ? C.success : C.muted }}>{timeVal > 0 ? fmtMin(timeVal) : "—"}</span>;
      case "workType":
        return wt ? <span style={{ fontSize: 11, background: "#F5F4F1", borderRadius: 6, padding: "2px 8px" }}>{wt.name}</span> : <span style={{ color: C.muted }}>—</span>;
      case "updatedAt": {
        const lastUpdated = t.lastSession?.end || t.updatedAt;
        return (
          <div onMouseEnter={() => t.sessions?.length > 0 && setHoveredSession({ id: t.rowKey, sessions: t.sessions, trackedMin: t.trackedMin })}
            onMouseLeave={() => setHoveredSession(null)}
            style={{ fontSize: 11, color: C.muted, cursor: t.sessions?.length > 0 ? "help" : "default", display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
            {lastUpdated ? fmtDateTime(lastUpdated) : "—"}
            {t.sessions?.length > 0 && <span style={{ fontSize: 10, color: C.gold }}>●</span>}
            {hoveredSession?.id === t.rowKey && (
              <div style={{ position: "absolute", left: 0, top: "100%", background: C.dark, border: "1px solid rgba(255,255,255,.15)", borderRadius: 10, padding: "10px 14px", zIndex: 200, minWidth: 240, boxShadow: "0 8px 24px rgba(0,0,0,.4)", pointerEvents: "none" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.gold, marginBottom: 6 }}>⏱ Сессии · итого {fmtMin(hoveredSession.trackedMin)}</div>
                {hoveredSession.sessions.map((s, i) => {
                  const dur = Math.round((new Date(s.end) - new Date(s.start)) / 60000);
                  return <div key={i} style={{ fontSize: 10, color: "#D0C8B8", marginBottom: 3, display: "flex", gap: 8 }}>
                    <span>{fmtDateTime(s.start)}</span><span style={{ color: "#6B7280" }}>→</span>
                    <span>{new Date(s.end).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span style={{ color: C.success, fontWeight: 600 }}>{fmtMin(dur)}</span>
                  </div>;
                })}
              </div>
            )}
          </div>
        );
      }
      case "taskType":
        return t.taskType
          ? <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: t.taskType === "С" ? "#FFF3D0" : "#EFF6FF", color: t.taskType === "С" ? "#8B5E10" : "#1D4ED8" }}>{t.taskType}</span>
          : <span style={{ color: C.muted, fontSize: 11 }}>—</span>;
      case "status":
        return (
          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 10px", borderRadius: 20, background: t.status === "done" ? "rgba(5,150,105,.1)" : t.status === "progress" ? "rgba(217,119,6,.1)" : "rgba(107,114,128,.08)", color: statusColor[t.status || ""] }}>
            {t.status === "done" ? "✓ " : t.status === "progress" ? "◑ " : "○ "}{statusLabel[t.status || ""]}
          </span>
        );
      case "createdAt":
        return <span style={{ fontSize: 11, color: C.muted }}>{fmtDateTime(t.createdAt)}</span>;
      case "createdBy":
        return <div style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontSize: 13 }}>{t.emp.emoji}</span><span style={{ fontSize: 11, color: C.muted }}>{t.createdBy || t.emp.name}</span></div>;
      default: return null;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header + filters */}
      <div style={{ ...cardS, padding: "12px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.dark }}>📋 Задачи</div>
          <div style={{ display: "flex", background: "#F2EFE9", borderRadius: 9, padding: 3, border: `1px solid ${C.border}` }}>
            {[["active","В работе"],["done","Завершённые"]].map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)}
                style={{ padding: "5px 14px", borderRadius: 7, border: "none", background: filter === v ? C.card : "none", color: filter === v ? C.dark : C.muted, fontWeight: filter === v ? 700 : 400, fontSize: 12, cursor: "pointer", fontFamily: "inherit", boxShadow: filter === v ? "0 1px 4px rgba(0,0,0,.1)" : "none" }}>{l}</button>
            ))}
          </div>
          <span style={{ fontSize: 12, color: C.muted }}>{rows.length} задач</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={filterEmp} onChange={e => setFilterEmp(e.target.value)} style={{ ...baseInp, width: "auto", fontSize: 12, padding: "4px 8px" }}>
              <option value="all">Все сотрудники</option>
              {emps.map(emp => <option key={emp.id} value={emp.id}>{emp.emoji} {emp.name}</option>)}
            </select>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...baseInp, width: "auto", fontSize: 12, padding: "4px 8px" }}>
              <option value="all">Все типы работы</option>
              {wts.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select value={filterTaskType} onChange={e => setFilterTaskType(e.target.value)} style={{ ...baseInp, width: "auto", fontSize: 12, padding: "4px 8px" }}>
              <option value="all">С и Т</option>
              <option value="С">Стратегические</option>
              <option value="Т">Тактические</option>
              <option value="">Обычные</option>
            </select>
            {filter === "active" && (
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...baseInp, width: "auto", fontSize: 12, padding: "4px 8px" }}>
                <option value="all">Все статусы</option>
                <option value="">Не начато</option>
                <option value="progress">В работе</option>
              </select>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          💡 Перетащите заголовок колонки для изменения порядка · Нажмите на ячейку для редактирования
        </div>
      </div>

      {/* Table */}
      <div style={{ background: C.card, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}`, boxShadow: "0 1px 4px rgba(0,0,0,.07)" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
            <thead>
              <tr>
                {cols.map((col, ci) => (
                  <th key={col.id}
                    draggable
                    onDragStart={() => setDragColIdx(ci)}
                    onDragOver={e => { e.preventDefault(); handleColDragOver(ci); }}
                    onDrop={() => handleColDrop(ci)}
                    onDragEnd={() => { setDragColIdx(null); setDragOverColIdx(null); }}
                    onClick={() => toggleSort(col.id)}
                    style={{ ...thS, width: col.w, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", background: dragOverColIdx === ci ? C.goldLight : "#F9F8F6", borderLeft: dragOverColIdx === ci ? `2px solid ${C.gold}` : "none", transition: "background .15s" }}
                    onMouseEnter={e => { if (dragColIdx === null) e.currentTarget.style.background = "#F0EDE8"; }}
                    onMouseLeave={e => { if (dragColIdx === null) e.currentTarget.style.background = dragOverColIdx === ci ? C.goldLight : "#F9F8F6"; }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 10, color: "#C8C4BE", cursor: "grab" }}>⠿</span>
                      {col.label}
                      {col.editable && <span style={{ fontSize: 9, color: "#C8C4BE" }}>✎</span>}
                      <span style={{ color: C.gold, fontSize: 10 }}>{sortCol === col.id ? (sortDir === "asc" ? "↑" : "↓") : ""}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={cols.length} style={{ ...tdS, textAlign: "center", color: C.muted, padding: "40px 0", fontSize: 14 }}>
                  {filter === "done" ? "Завершённых задач нет" : "Активных задач нет"}
                </td></tr>
              )}
              {rows.map(t => (
                <tr key={t.rowKey}
                  style={{ background: t.status === "done" ? "#FAFAF8" : t.taskType === "С" ? "rgba(200,146,42,.03)" : "#fff", borderLeft: t.taskType === "С" ? `3px solid ${C.gold}` : t.taskType === "Т" ? "3px solid #3B82F6" : "none" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#FEFDFB"}
                  onMouseLeave={e => { e.currentTarget.style.background = t.status === "done" ? "#FAFAF8" : t.taskType === "С" ? "rgba(200,146,42,.03)" : "#fff"; }}>
                  {cols.map(col => (
                    <td key={col.id}
                      onClick={() => col.editable && startEdit(t.rowKey, col.id, col.id === "workType" ? t.workType : col.id === "taskType" ? t.taskType : col.id === "status" ? t.status : col.id === "task" ? t.task : "")}
                      style={{ ...tdS, cursor: col.editable ? "cell" : "default", background: editCell?.rowKey === t.rowKey && editCell?.colId === col.id ? C.goldLight : "transparent" }}>
                      {renderCell(t, col.id)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ═══ STRATEGY ══════════════════════════════════════════════ */
function StrategyView({ wd, emps, onUpdateStrategy }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...cardS, padding: "12px 18px" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.dark }}>🎯 Стратегия и тактика недели</div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>Стратегические цели и тактические задачи на неделю</div>
      </div>
      {emps.map(emp => {
        const ed = wd.employees.find(e => e.employeeId === emp.id);
        const strat = ed?.strategy || [];
        const addG = () => onUpdateStrategy(emp.id, [...strat, { id: mkId(), task: "", result: "", hours: "", priority: "", type: "С" }]);
        const updG = (id, f, v) => onUpdateStrategy(emp.id, strat.map(g => g.id === id ? { ...g, [f]: v } : g));
        const rmG = (id) => onUpdateStrategy(emp.id, strat.filter(g => g.id !== id));
        const totalH = strat.reduce((s, g) => s + (parseFloat(g.hours) || 0), 0);
        const stratCount = strat.filter(g => g.type !== "Т").length;
        const tactCount  = strat.filter(g => g.type === "Т").length;
        return (
          <div key={emp.id} style={{ ...cardS, borderLeft: `4px solid ${emp.color}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 24 }}>{emp.emoji || "👤"}</span>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.dark }}>{emp.name}</div>
              <div style={{ display: "flex", gap: 6, marginLeft: 4 }}>
                {stratCount > 0 && <span style={{ fontSize: 11, background: "#FFF3D0", color: "#8B5E10", border: "1px solid rgba(200,146,42,.4)", borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>С {stratCount}</span>}
                {tactCount > 0  && <span style={{ fontSize: 11, background: "#EFF6FF", color: "#1D4ED8", border: "1px solid rgba(59,130,246,.3)", borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>Т {tactCount}</span>}
              </div>
              {totalH > 0 && <div style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>{totalH}ч</div>}
            </div>
            {strat.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
                <thead><tr>
                  <th style={{ ...thS, width: 46, textAlign: "center" }}>Тип</th>
                  <th style={{ ...thS, width: 32 }}>П</th>
                  <th style={thS}>Задача / цель</th>
                  <th style={thS}>Ожидаемый результат</th>
                  <th style={{ ...thS, width: 75 }}>Часы</th>
                  <th style={{ ...thS, width: 28 }}></th>
                </tr></thead>
                <tbody>
                  {strat.map(g => {
                    const isStrat = g.type !== "Т";
                    const rowBg = isStrat ? "rgba(200,146,42,.03)" : "rgba(59,130,246,.03)";
                    const borderL = isStrat ? `3px solid ${C.gold}` : "3px solid #3B82F6";
                    return (
                      <tr key={g.id} style={{ background: rowBg, borderLeft: borderL }}>
                        <td style={{ ...tdS, textAlign: "center" }}>
                          <button onClick={() => updG(g.id, "type", g.type === "Т" ? "С" : "Т")}
                            style={{ padding: "3px 8px", borderRadius: 6, border: isStrat ? "1px solid rgba(200,146,42,.5)" : "1px solid rgba(59,130,246,.4)", background: isStrat ? "#FFF3D0" : "#EFF6FF", color: isStrat ? "#8B5E10" : "#1D4ED8", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                            {isStrat ? "С" : "Т"}
                          </button>
                        </td>
                        <td style={tdS}><input value={g.priority} onChange={e => updG(g.id, "priority", e.target.value)} style={{ ...baseInp, width: 30, textAlign: "center", padding: 4, fontWeight: 700, color: C.gold }} maxLength={2} /></td>
                        <td style={tdS}><input value={g.task} onChange={e => updG(g.id, "task", e.target.value)} style={{ ...baseInp, fontWeight: isStrat ? 600 : 400 }} placeholder={isStrat ? "Стратегическая цель" : "Тактическая задача"} /></td>
                        <td style={tdS}><input value={g.result} onChange={e => updG(g.id, "result", e.target.value)} style={baseInp} placeholder="Ожидаемый результат" /></td>
                        <td style={tdS}><input value={g.hours} onChange={e => updG(g.id, "hours", e.target.value)} style={{ ...baseInp, textAlign: "center" }} type="number" step="0.5" placeholder="8" /></td>
                        <td style={tdS}><button onClick={() => rmG(g.id)} style={{ background: "none", border: "none", color: "#E5A0A0", cursor: "pointer", fontSize: 14 }}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={addG} style={{ ...btnS("ghost"), fontSize: 12, padding: "5px 14px", borderColor: "rgba(200,146,42,.4)", color: "#8B5E10" }}>+ Стратегическая</button>
              <button onClick={() => onUpdateStrategy(emp.id, [...strat, { id: mkId(), task: "", result: "", hours: "", priority: "", type: "Т" }])}
                style={{ ...btnS("ghost"), fontSize: 12, padding: "5px 14px", borderColor: "rgba(59,130,246,.4)", color: "#1D4ED8" }}>+ Тактическая</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══ ANALYTICS ════════════════════════════════════════════ */
function Analytics({ wd, emps, wts, dates, cw }) {
  const ratingEmoji = ["","😞","😕","😐","🙂","🙂","😊","😊","🤩","🤩","🤩"];

  const stats = emps.map(emp => {
    const ed = wd.employees.find(e => e.employeeId === emp.id);
    let totalFact = 0, totalPlan = 0, done = 0, total = 0;
    const wtBreak = {}, dayFact = Array(6).fill(0);
    let totalWorkMin = 0, workDays = 0;
    const ratings = [], allInsights = [], allProblems = [];

    ed?.days.forEach((day, di) => {
      // Task stats
      day.tasks.forEach(t => {
        total++; if (t.done) done++;
        totalPlan += parseInt(t.plan) || 0;
        const m = parseMinutes(t.timeRange) ?? parseInt(t.fact) || 0;
        totalFact += m; dayFact[di] += m;
        if (t.workType && m > 0) wtBreak[t.workType] = (wtBreak[t.workType] || 0) + m;
      });
      // Work time from start/end
      if (day.startTime && day.endTime) {
        const mins = Math.round((new Date(day.endTime) - new Date(day.startTime)) / 60000);
        if (mins > 0) { totalWorkMin += mins; workDays++; }
      }
      // Rating & insights
      if (day.rating) ratings.push({ di, rating: day.rating, date: dates[di] });
      if (day.insights?.trim()) allInsights.push({ di, text: day.insights.trim(), date: dates[di], rating: day.rating });
      if (day.problems?.trim()) allProblems.push({ di, text: day.problems.trim(), date: dates[di] });
    });

    const avgRating = ratings.length ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1) : null;
    const prod = totalPlan > 0 ? Math.round((totalFact / totalPlan) * 100) : null;
    return { emp, totalFact, totalPlan, done, total, wtBreak, dayFact, prod, totalWorkMin, workDays, avgRating, ratings, allInsights, allProblems };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Header */}
      <div style={{ ...cardS, padding: "12px 18px" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.dark }}>📊 Аналитика · Неделя {cw.week}</div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>
          {dates[0].toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} — {dates[5].toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>

      {/* Per-employee cards */}
      {stats.map(st => (
        <div key={st.emp.id} style={{ ...cardS, borderLeft: `4px solid ${st.emp.color}`, display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Employee header */}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 28 }}>{st.emp.emoji || "👤"}</span>
            <div style={{ fontWeight: 700, fontSize: 16, color: C.dark }}>{st.emp.name}</div>
            {st.avgRating && (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, background: "#FFF8E8", borderRadius: 20, padding: "4px 12px", border: `1px solid rgba(200,146,42,.3)` }}>
                <span style={{ fontSize: 18 }}>{ratingEmoji[Math.round(parseFloat(st.avgRating))]}</span>
                <span style={{ fontWeight: 700, fontSize: 16, color: "#8B5E10" }}>{st.avgRating}</span>
                <span style={{ fontSize: 11, color: C.muted }}>/ 10 ср. оценка</span>
              </div>
            )}
          </div>

          {/* Metrics grid */}
      <div className="analytics-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            {[
              { l: "Время (задачи)", v: st.totalFact > 0 ? fmtMin(st.totalFact) : "—", c: C.success, icon: "⏱" },
              { l: "Рабочих часов", v: st.totalWorkMin > 0 ? fmtMin(st.totalWorkMin) : "—", c: "#0284C7", icon: "🕐" },
              { l: "Задачи", v: `${st.done} / ${st.total}`, c: C.gold, icon: "✅" },
              { l: "Продуктивность", v: st.prod !== null ? `${st.prod}%` : "—", c: !st.prod ? C.muted : st.prod >= 80 ? C.success : st.prod >= 50 ? "#F59E0B" : C.danger, icon: "📈" },
            ].map(({ l, v, c, icon }) => (
              <div key={l} style={{ background: "#F9F8F6", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 16, marginBottom: 4 }}>{icon}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{v}</div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, marginTop: 2 }}>{l.toUpperCase()}</div>
              </div>
            ))}
          </div>

          {/* Productivity bar */}
          {st.prod !== null && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
                <span>Продуктивность (факт / план)</span><span>{st.prod}%</span>
              </div>
              <div style={{ height: 7, background: "#EFEDE9", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(st.prod, 100)}%`, background: st.prod >= 80 ? C.success : st.prod >= 50 ? "#F59E0B" : C.danger, borderRadius: 4, transition: "width .5s" }} />
              </div>
            </div>
          )}

          {/* Оценки по дням */}
          {st.ratings.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 8 }}>ОЦЕНКИ ПО ДНЯМ</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {st.ratings.map(({ di, rating, date }) => (
                  <div key={di} style={{ display: "flex", flexDirection: "column", alignItems: "center", background: "#F9F8F6", borderRadius: 8, padding: "6px 10px", minWidth: 52 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>
                      {date?.toLocaleDateString("ru-RU", { weekday: "short" })}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: rating >= 8 ? C.success : rating >= 5 ? "#F59E0B" : C.danger }}>{rating}</div>
                    <div style={{ fontSize: 14 }}>{ratingEmoji[Math.min(rating, 10)]}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Типы работы */}
          {Object.keys(st.wtBreak).length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 8 }}>ТИПЫ РАБОТЫ</div>
              {Object.entries(st.wtBreak).sort((a, b) => b[1] - a[1]).map(([id, mins]) => {
                const wt = wts.find(w => w.id === id);
                const pct = st.totalFact > 0 ? Math.round((mins / st.totalFact) * 100) : 0;
                return (
                  <div key={id} style={{ marginBottom: 7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                      <span>{wt?.name || id}</span><span style={{ color: C.muted }}>{fmtMin(mins)} · {pct}%</span>
                    </div>
                    <div style={{ height: 5, background: "#EFEDE9", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: st.emp.color, borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Инсайты недели */}
          {st.allInsights.length > 0 && (
            <div style={{ background: "#FFFBEF", borderRadius: 10, padding: "12px 14px", border: `1px solid rgba(200,146,42,.2)` }}>
              <div style={{ fontSize: 11, color: "#8B5E10", fontWeight: 700, marginBottom: 8 }}>💡 ИНСАЙТЫ НЕДЕЛИ</div>
              {st.allInsights.map(({ di, text, date, rating }) => (
                <div key={di} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid rgba(200,146,42,.15)` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#8B5E10" }}>
                      {date?.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric" })}
                    </span>
                    {rating && <span style={{ fontSize: 11, color: C.muted }}>{ratingEmoji[Math.min(rating,10)]} {rating}/10</span>}
                  </div>
                  <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{text}</div>
                </div>
              ))}
            </div>
          )}

          {/* Проблемы недели */}
          {st.allProblems.length > 0 && (
            <div style={{ background: "#FEF9F9", borderRadius: 10, padding: "12px 14px", border: `1px solid rgba(220,38,38,.12)` }}>
              <div style={{ fontSize: 11, color: "#991B1B", fontWeight: 700, marginBottom: 8 }}>🔧 ПРОБЛЕМЫ И РЕШЕНИЯ</div>
              {st.allProblems.map(({ di, text, date }) => (
                <div key={di} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid rgba(220,38,38,.1)` }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#991B1B", marginBottom: 4 }}>
                    {date?.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric" })}
                  </div>
                  <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Hours by day table */}
      <div style={cardS}>
        <div style={{ fontWeight: 600, fontSize: 14, color: C.dark, marginBottom: 12 }}>⏱ Часы по дням (из хронометража задач)</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={thS}>Сотрудник</th>
            {DAY_SHORT.map((d, i) => <th key={i} style={{ ...thS, textAlign: "center", width: 80 }}>{d}<br /><span style={{ fontWeight: 400, color: "#9CA3AF" }}>{dates[i].toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span></th>)}
            <th style={{ ...thS, textAlign: "center", width: 90 }}>Итого</th>
          </tr></thead>
          <tbody>
            {stats.map(st => (
              <tr key={st.emp.id}>
                <td style={{ ...tdS, fontWeight: 600 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>{st.emp.emoji || "👤"}</span>{st.emp.name}
                  </div>
                </td>
                {st.dayFact.map((m, i) => (
                  <td key={i} style={{ ...tdS, textAlign: "center", color: m > 0 ? C.success : "#D1D5DB", fontWeight: m > 0 ? 600 : 400 }}>
                    {m > 0 ? fmtMin(m) : "—"}
                  </td>
                ))}
                <td style={{ ...tdS, textAlign: "center", fontWeight: 700, color: C.dark }}>{st.totalFact > 0 ? fmtMin(st.totalFact) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══ CALENDAR VIEW ═════════════════════════════════════════ */
const MONTH_RU = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const CAL_S = 7, CAL_E = 22, HR_H = 58; // grid 7:00–22:00, 58px per hour

function tPos(timeRange) {
  const m = timeRange?.match(/(\d{1,2})[:\.](\d{2})\s*[-–—]\s*(\d{1,2})[:\.](\d{2})/);
  if (!m) return null;
  const s = parseInt(m[1]) * 60 + parseInt(m[2]);
  const e = parseInt(m[3]) * 60 + parseInt(m[4]);
  if (e <= s) return null;
  const gS = CAL_S * 60, gE = CAL_E * 60;
  if (e <= gS || s >= gE) return null;
  const top = (Math.max(s, gS) - gS) / 60 * HR_H;
  const bot = (Math.min(e, gE) - gS) / 60 * HR_H;
  return { top, height: Math.max(bot - top, 24) };
}

function CalendarView({ wd, emps, wts, allKeys, cw }) {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [calView, setCalView] = useState("month");
  const [viewDate, setViewDate] = useState(today0);
  const [filterEmp, setFilterEmp] = useState("all");

  // weekCache keyed by "YYYY-WWW"; current week ALWAYS comes from live `wd` prop
  const currentWeekKey = `${cw.year}-W${String(cw.week).padStart(2, "0")}`;
  const [archiveCache, setArchiveCache] = useState({});      // only past/other weeks from storage
  const [loadingKeys, setLoadingKeys] = useState(new Set()); // prevent duplicate fetches

  // Merge live wd with archive, always preferring live for current week
  const weekCache = wd ? { ...archiveCache, [currentWeekKey]: wd } : archiveCache;

  // Load archive weeks (skip current week — always use live wd)
  useEffect(() => {
    const needed = allKeys.filter(k => {
      if (k === currentWeekKey) return false; // skip — we have it live
      if (archiveCache[k] !== undefined) return false; // already loaded
      if (loadingKeys.has(k)) return false; // already fetching
      const [ky, kw] = k.split("-W");
      const wds = getWeekDates(parseInt(ky), parseInt(kw));
      if (calView === "month") {
        const y = viewDate.getFullYear(), mo = viewDate.getMonth();
        return wds.some(d => d.getFullYear() === y && d.getMonth() === mo);
      }
      const dow = (viewDate.getDay() + 6) % 7;
      const mon = new Date(viewDate); mon.setDate(viewDate.getDate() - dow);
      const sat = new Date(mon); sat.setDate(mon.getDate() + 5);
      return wds.some(d => d >= mon && d <= sat);
    });
    if (needed.length === 0) return;
    setLoadingKeys(prev => new Set([...prev, ...needed]));
    needed.forEach(async k => {
      const [ky, kw] = k.split("-W");
      const raw = await store.get(`week:${ky}-${parseInt(kw)}`);
      setArchiveCache(p => ({ ...p, [k]: raw ? migrateWeek(raw) : raw }));
    });
  }, [calView, viewDate.toDateString(), allKeys.join(","), currentWeekKey]);

  const getDateTasks = (date) => {
    const result = { tasks: [], dayResult: "" };
    Object.entries(weekCache).forEach(([key, wdata]) => {
      if (!wdata) return;
      const [ky, kw] = key.split("-W");
      const wds = getWeekDates(parseInt(ky), parseInt(kw));
      wds.forEach((d, di) => {
        if (d.toDateString() !== date.toDateString()) return;
        wdata.employees.forEach(ed => {
          if (filterEmp !== "all" && ed.employeeId !== filterEmp) return;
          const emp = emps.find(e => e.id === ed.employeeId);
          if (!emp) return;
          const day = ed.days[di];
          if (!day) return;
          if (day.dayResult && !result.dayResult) result.dayResult = day.dayResult;
          // Only include tasks with actual content
          day.tasks.filter(t => t.task || t.result || t.timeRange).forEach(t => result.tasks.push({ ...t, emp }));
        });
      });
    });
    return result;
  };

  const navigate = (dir) => {
    setViewDate(prev => {
      const d = new Date(prev);
      if (calView === "day") d.setDate(d.getDate() + dir);
      else if (calView === "week") d.setDate(d.getDate() + dir * 7);
      else { d.setMonth(d.getMonth() + dir); d.setDate(1); }
      return d;
    });
  };

  const navTitle = () => {
    if (calView === "month") return `${MONTH_RU[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
    if (calView === "week") {
      const dow = (viewDate.getDay() + 6) % 7;
      const mon = new Date(viewDate); mon.setDate(viewDate.getDate() - dow);
      const sat = new Date(mon); sat.setDate(mon.getDate() + 5);
      return `${mon.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})} – ${sat.toLocaleDateString("ru-RU",{day:"numeric",month:"short",year:"numeric"})}`;
    }
    return viewDate.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  };

  const empPills = (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {[{ id: "all", name: "Все", color: C.border, emoji: "" }, ...emps].map(e => {
        const sel = filterEmp === e.id;
        return (
          <button key={e.id} onClick={() => setFilterEmp(sel && e.id !== "all" ? "all" : e.id)}
            style={{ padding: "4px 11px", borderRadius: 20, border: `1px solid ${sel ? (e.color === C.border ? C.gold : e.color) : C.border}`, background: sel ? (e.color === C.border ? C.goldLight : e.color) : "none", color: sel ? (e.color === C.border ? C.gold : "#1F2937") : C.muted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: sel ? 700 : 400, display: "flex", alignItems: "center", gap: 4 }}>
            {e.emoji && <span style={{ fontSize: 13 }}>{e.emoji}</span>}{e.name}
          </button>
        );
      })}
    </div>
  );

  return (
    <div>
      {/* Top bar */}
      <div style={{ ...cardS, padding: "10px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {/* View switcher */}
        <div style={{ display: "flex", background: "#F2EFE9", borderRadius: 9, padding: 3, gap: 1, border: `1px solid ${C.border}` }}>
          {[["day","День"],["week","Неделя"],["month","Месяц"]].map(([v, l]) => (
            <button key={v} onClick={() => setCalView(v)}
              style={{ padding: "5px 16px", borderRadius: 7, border: "none", background: calView === v ? C.card : "none", color: calView === v ? C.dark : C.muted, fontWeight: calView === v ? 700 : 400, fontSize: 13, cursor: "pointer", fontFamily: "inherit", boxShadow: calView === v ? "0 1px 4px rgba(0,0,0,.1)" : "none", transition: "all .15s" }}>{l}</button>
          ))}
        </div>

        <button onClick={() => navigate(-1)} style={{ ...btnS("ghost"), padding: "5px 11px", fontSize: 18, lineHeight: 1 }}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 14, color: C.dark, minWidth: 180, textAlign: "center" }}>{navTitle()}</div>
        <button onClick={() => navigate(1)} style={{ ...btnS("ghost"), padding: "5px 11px", fontSize: 18, lineHeight: 1 }}>›</button>
        <button onClick={() => setViewDate(today0)} style={{ ...btnS("ghost"), fontSize: 12, padding: "5px 12px" }}>Сегодня</button>

        <div style={{ marginLeft: "auto" }}>{empPills}</div>
      </div>

      {calView === "month" && <CalMonth viewDate={viewDate} getDateTasks={getDateTasks} today0={today0} wts={wts} />}
      {calView === "week" && <CalWeek viewDate={viewDate} getDateTasks={getDateTasks} today0={today0} wts={wts} />}
      {calView === "day"  && <CalDay  viewDate={viewDate} getDateTasks={getDateTasks} today0={today0} wts={wts} />}

      {filterEmp === "all" && emps.length > 0 && (
        <div style={{ ...cardS, marginTop: 12, padding: "10px 16px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>ЛЕГЕНДА:</span>
          {emps.map(emp => (
            <div key={emp.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: emp.color }} />
              <span style={{ fontSize: 12, color: C.text }}>{emp.emoji} {emp.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* — Month grid ——————————————————————————————————————————————— */
function CalMonth({ viewDate, getDateTasks, today0, wts }) {
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  const dim = new Date(y, m + 1, 0).getDate();
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const endPad = (7 - (startDow + dim) % 7) % 7;

  return (
    <div style={{ background: C.card, borderRadius: 14, overflow: "hidden", border: `1px solid ${C.border}`, boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", background: "#F9F8F6", borderBottom: `1px solid ${C.border}` }}>
        {["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map((d, i) => (
          <div key={d} style={{ padding: "8px 0", textAlign: "center", fontSize: 12, fontWeight: 600, color: i >= 5 ? C.muted : C.text }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}>
        {Array.from({ length: startDow }, (_, i) => <div key={`p${i}`} style={{ minHeight: 100, background: "#FAFAF8", borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }} />)}
        {Array.from({ length: dim }, (_, idx) => {
          const dn = idx + 1;
          const date = new Date(y, m, dn);
          const isWe = date.getDay() === 0 || date.getDay() === 6;
          const isTod = date.getTime() === today0.getTime();
          const { tasks, dayResult } = getDateTasks(date);
          const done = tasks.filter(t => t.done).length;
          return (
            <div key={dn} style={{ minHeight: 100, padding: "6px 8px", borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, background: isTod ? "#FFFBEF" : isWe ? "#FAFAF8" : "#fff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                {isTod
                  ? <div style={{ width: 24, height: 24, borderRadius: "50%", background: C.gold, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{dn}</div>
                  : <span style={{ fontSize: 13, fontWeight: 600, color: isWe ? C.muted : C.dark }}>{dn}</span>}
                {tasks.length > 0 && <span style={{ fontSize: 9, color: done === tasks.length ? C.success : C.muted }}>{done}/{tasks.length}</span>}
              </div>
              {tasks.slice(0, 4).map((t, ti) => {
                const wtIdx = t.workType ? wts?.findIndex(w => w.id === t.workType) : -1;
                const wtColor = wtIdx >= 0 ? WT_COLORS[wtIdx % WT_COLORS.length] : null;
                return (
                  <div key={ti} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 2, overflow: "hidden" }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: t.emp.color, flexShrink: 0 }} />
                    {wtColor && <div style={{ width: 5, height: 5, borderRadius: "50%", background: wtColor, flexShrink: 0, opacity: .85 }} />}
                    {t.taskType === "С" && <span style={{ fontSize: 7, fontWeight: 700, color: "#8B5E10", flexShrink: 0 }}>С</span>}
                    {t.taskType === "Т" && <span style={{ fontSize: 7, fontWeight: 700, color: "#1D4ED8", flexShrink: 0 }}>Т</span>}
                    <span style={{ fontSize: 10, color: t.done ? C.muted : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textDecoration: t.done ? "line-through" : "none" }}>
                      {t.priority ? `${t.priority}. ` : ""}{t.task || "—"}
                    </span>
                  </div>
                );
              })}
              {tasks.length > 4 && <div style={{ fontSize: 9, color: C.muted }}>+{tasks.length - 4} ещё</div>}
              {dayResult && <div style={{ marginTop: 3, fontSize: 9, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🎯 {dayResult}</div>}
            </div>
          );
        })}
        {Array.from({ length: endPad }, (_, i) => <div key={`e${i}`} style={{ minHeight: 100, background: "#FAFAF8", borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }} />)}
      </div>
    </div>
  );
}

/* — Week timeline ———————————————————————————————————————————— */
function CalWeek({ viewDate, getDateTasks, today0, wts }) {
  const hours = Array.from({ length: CAL_E - CAL_S }, (_, i) => CAL_S + i);
  const dow = (viewDate.getDay() + 6) % 7;
  const mon = new Date(viewDate); mon.setDate(viewDate.getDate() - dow);
  const days = Array.from({ length: 6 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });

  return (
    <div style={{ background: C.card, borderRadius: 14, overflow: "hidden", border: `1px solid ${C.border}`, boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>
      {/* Day headers */}
      <div style={{ display: "grid", gridTemplateColumns: "52px repeat(6,1fr)", background: "#F9F8F6", borderBottom: `1px solid ${C.border}` }}>
        <div />
        {days.map((d, i) => {
          const isTod = d.getTime() === today0.getTime();
          return (
            <div key={i} style={{ padding: "8px 0", textAlign: "center", borderLeft: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{DAY_SHORT[i]}</div>
              {isTod
                ? <div style={{ width: 28, height: 28, borderRadius: "50%", background: C.gold, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, margin: "2px auto 0" }}>{d.getDate()}</div>
                : <div style={{ fontSize: 16, fontWeight: 600, color: isTod ? "#8B5E10" : C.dark, marginTop: 2 }}>{d.getDate()}</div>}
            </div>
          );
        })}
      </div>

      {/* Scrollable grid */}
      <div style={{ overflowY: "auto", maxHeight: 580, display: "flex" }}>
        {/* Hour labels */}
        <div style={{ width: 52, flexShrink: 0, borderRight: `1px solid ${C.border}` }}>
          {hours.map(h => (
            <div key={h} style={{ height: HR_H, borderBottom: `1px solid #F0EDE8`, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingRight: 8, paddingTop: 3 }}>
              <span style={{ fontSize: 10, color: C.muted }}>{h}:00</span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        {days.map((date, di) => {
          const { tasks } = getDateTasks(date);
          const positioned = tasks.map(t => ({ t, pos: tPos(t.timeRange) })).filter(x => x.pos);
          const floating  = tasks.filter(t => !tPos(t.timeRange));
          const isTod = date.getTime() === today0.getTime();

          return (
            <div key={di} style={{ flex: 1, borderLeft: `1px solid ${C.border}`, position: "relative", minWidth: 0, background: isTod ? "#FFFDF7" : "#fff" }}>
              {hours.map(h => (
                <div key={h} style={{ height: HR_H, borderBottom: `1px solid #F0EDE8`, boxSizing: "border-box" }}>
                  {h % 2 === 0 && <div style={{ height: 1, background: C.border, marginTop: HR_H / 2 }} />}
                </div>
              ))}
              {positioned.map(({ t, pos }, ti) => {
                const wtIdx = t.workType ? wts?.findIndex(w => w.id === t.workType) : -1;
                const wtColor = wtIdx >= 0 ? WT_COLORS[wtIdx % WT_COLORS.length] : null;
                return (
                  <div key={ti} style={{ position: "absolute", left: 2, right: 2, top: pos.top, height: pos.height, background: t.emp.color, borderRadius: 5, padding: "2px 5px", overflow: "hidden", border: "1px solid rgba(0,0,0,.08)", opacity: t.done ? .55 : 1, zIndex: 1, cursor: "default", borderLeft: wtColor ? `3px solid ${wtColor}` : undefined }}>
                    <div style={{ fontSize: 10, fontWeight: t.taskType === "С" ? 700 : 600, color: "#1F2937", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.taskType ? <span style={{ fontSize: 8, fontWeight: 700, marginRight: 2, color: t.taskType === "С" ? "#8B5E10" : "#1D4ED8" }}>{t.taskType}</span> : null}
                      {t.priority ? `${t.priority}. ` : ""}{t.task || "—"}
                    </div>
                    {pos.height > 30 && <div style={{ fontSize: 9, color: "#374151", opacity: .8 }}>{t.timeRange}</div>}
                    {pos.height > 44 && <div style={{ fontSize: 9, color: "#374151" }}>{t.emp.emoji} {t.emp.name}</div>}
                  </div>
                );
              })}
              {floating.length > 0 && (
                <div style={{ position: "absolute", top: 2, right: 3, background: "rgba(0,0,0,.08)", borderRadius: 4, padding: "1px 4px", fontSize: 9, color: C.muted }}>{floating.length}↑</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* — Day timeline ————————————————————————————————————————————— */
function CalDay({ viewDate, getDateTasks, today0, wts }) {
  const hours = Array.from({ length: CAL_E - CAL_S }, (_, i) => CAL_S + i);
  const { tasks, dayResult } = getDateTasks(viewDate);
  const isTod = viewDate.getTime() === today0.getTime();

  const positioned = tasks.map(t => ({ t, pos: tPos(t.timeRange) })).filter(x => x.pos);
  const floating   = tasks.filter(t => !tPos(t.timeRange));

  // Group overlapping timed tasks into columns
  const cols = [];
  positioned.forEach(({ t, pos }) => {
    let placed = false;
    for (const col of cols) {
      const last = col[col.length - 1];
      if (last.pos.top + last.pos.height <= pos.top) { col.push({ t, pos }); placed = true; break; }
    }
    if (!placed) cols.push([{ t, pos }]);
  });
  const nCols = Math.max(cols.length, 1);
  const doneCnt = tasks.filter(t => t.done).length;

  return (
    <div style={{ background: C.card, borderRadius: 14, overflow: "hidden", border: `1px solid ${C.border}`, boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>

      {/* Day header */}
      <div style={{ padding: "14px 20px", background: isTod ? "#FFFBEF" : "#F9F8F6", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: isTod ? C.gold : C.dark, textTransform: "capitalize" }}>
            {viewDate.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
          </div>
          {dayResult && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>🎯 {dayResult}</div>}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.dark }}>{tasks.length}</div>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>ЗАДАЧ</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.success }}>{doneCnt}</div>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>ГОТОВО</div>
          </div>
        </div>
      </div>

      {/* Empty state */}
      {tasks.length === 0 && (
        <div style={{ padding: "40px 0", textAlign: "center", color: C.muted }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Задач на этот день нет</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Перейдите во вкладку «Неделя» или «День» чтобы добавить задачи</div>
        </div>
      )}

      {/* Floating tasks — displayed as cards ABOVE the timeline */}
      {floating.length > 0 && (
        <div style={{ padding: "12px 20px", background: "#FDFCFB", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: .5, marginBottom: 8 }}>БЕЗ ХРОНОМЕТРАЖА — {floating.length} задач</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {floating.map((t, i) => {
              const wtIdx = t.workType ? wts?.findIndex(w => w.id === t.workType) : -1;
              const wtColor = wtIdx >= 0 ? WT_COLORS[wtIdx % WT_COLORS.length] : null;
              const wtName = wtIdx >= 0 ? wts[wtIdx]?.name : null;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#fff", borderRadius: 8, border: `1px solid ${C.border}`, borderLeft: `4px solid ${wtColor || t.emp.color}`, opacity: t.done ? .6 : 1 }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", background: t.done ? C.success : C.border, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {t.done && <span style={{ fontSize: 10, color: "#fff" }}>✓</span>}
                  </div>
                  {t.taskType && <span style={{ fontSize: 10, fontWeight: 700, color: t.taskType === "С" ? "#8B5E10" : "#1D4ED8", background: t.taskType === "С" ? "#FFF3D0" : "#EFF6FF", borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>{t.taskType}</span>}
                  {t.priority && <span style={{ fontWeight: 700, color: C.gold, fontSize: 12, flexShrink: 0 }}>{t.priority}.</span>}
                  <span style={{ fontSize: 13, color: t.done ? C.muted : C.text, textDecoration: t.done ? "line-through" : "none", fontWeight: t.taskType === "С" ? 700 : 400, flex: 1 }}>{t.task || "—"}</span>
                  <span style={{ fontSize: 12, color: "#1F2937", background: t.emp.color, borderRadius: 5, padding: "2px 8px", flexShrink: 0 }}>{t.emp.emoji} {t.emp.name}</span>
                  {wtColor && <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: wtColor }} /><span style={{ fontSize: 10, color: C.muted }}>{wtName}</span></div>}
                  {t.result && <span style={{ fontSize: 11, color: C.muted, flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>→ {t.result}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Timeline (only if timed tasks exist) */}
      {(positioned.length > 0 || tasks.length === 0) && tasks.length > 0 && (
        <div style={{ overflowY: "auto", maxHeight: 580, display: "flex" }}>
          {/* Hour labels */}
          <div style={{ width: 60, flexShrink: 0, borderRight: `1px solid ${C.border}` }}>
            {hours.map(h => (
              <div key={h} style={{ height: HR_H, borderBottom: `1px solid #F0EDE8`, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingRight: 10, paddingTop: 3 }}>
                <span style={{ fontSize: 11, color: C.muted }}>{h}:00</span>
              </div>
            ))}
          </div>

          {/* Task area */}
          <div style={{ flex: 1, position: "relative", background: isTod ? "#FFFDF7" : "#fff" }}>
            {hours.map(h => (
              <div key={h} style={{ height: HR_H, borderBottom: `1px solid #F0EDE8`, boxSizing: "border-box" }}>
                <div style={{ height: 1, background: h % 2 === 0 ? C.border : "transparent", marginTop: HR_H / 2 }} />
              </div>
            ))}

            {positioned.length === 0 && (
              <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: C.muted, fontSize: 12, textAlign: "center", pointerEvents: "none" }}>
                Задачи с хронометражем появятся здесь
              </div>
            )}

            {cols.map((col, ci) =>
              col.map(({ t, pos }, ti) => {
                const wtIdx = t.workType ? wts?.findIndex(w => w.id === t.workType) : -1;
                const wtColor = wtIdx >= 0 ? WT_COLORS[wtIdx % WT_COLORS.length] : null;
                return (
                  <div key={`${ci}-${ti}`} style={{
                    position: "absolute",
                    left: `calc(${ci / nCols * 100}% + 4px)`,
                    width: `calc(${100 / nCols}% - 8px)`,
                    top: pos.top, height: pos.height,
                    background: t.emp.color, borderRadius: 8,
                    padding: "5px 10px", overflow: "hidden",
                    border: "1px solid rgba(0,0,0,.09)",
                    borderLeft: wtColor ? `4px solid ${wtColor}` : "1px solid rgba(0,0,0,.09)",
                    opacity: t.done ? .55 : 1, zIndex: 1, boxSizing: "border-box",
                    boxShadow: "0 2px 6px rgba(0,0,0,.08)"
                  }}>
                    <div style={{ fontWeight: t.taskType === "С" ? 700 : 600, fontSize: 12, color: "#1F2937", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.taskType ? <span style={{ fontSize: 8, fontWeight: 700, marginRight: 3, color: t.taskType === "С" ? "#8B5E10" : "#1D4ED8" }}>{t.taskType}</span> : null}
                      {t.priority ? `${t.priority}. ` : ""}{t.task || "—"}
                    </div>
                    {pos.height > 32 && <div style={{ fontSize: 10, color: "#374151", marginTop: 1 }}>{t.timeRange}</div>}
                    {pos.height > 46 && <div style={{ fontSize: 10, color: "#374151", marginTop: 1 }}>{t.emp.emoji} {t.emp.name}</div>}
                    {pos.height > 62 && t.result && <div style={{ fontSize: 10, color: "#374151", marginTop: 2, opacity: .85 }}>→ {t.result}</div>}
                  </div>
                );
              })
            )}

            {/* Current time line */}
            {isTod && (() => {
              const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
              const top = (nowMins - CAL_S * 60) / 60 * HR_H;
              if (top < 0 || top > (CAL_E - CAL_S) * HR_H) return null;
              return (
                <div style={{ position: "absolute", left: 0, right: 0, top, height: 2, background: C.danger, zIndex: 5 }}>
                  <div style={{ position: "absolute", left: -4, top: -4, width: 10, height: 10, borderRadius: "50%", background: C.danger }} />
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ SETTINGS ══════════════════════════════════════════════ */
function SettingsView({ emps, wts, onEmps, onWts }) {
  const [es, setEs] = useState(emps);
  const [ws, setWs] = useState(wts);
  const [newE, setNewE] = useState(""), [newW, setNewW] = useState("");
  const [dragIdx, setDragIdx] = useState(null), [dragOverIdx, setDragOverIdx] = useState(null);

  const saveE = (arr) => { setEs(arr); onEmps(arr); };
  const saveW = (arr) => { setWs(arr); onWts(arr); };

  const addEmp = () => {
    if (!newE.trim()) return;
    saveE([...es, { id: mkId(), name: newE.trim(), color: EMP_PALETTE[es.length % EMP_PALETTE.length], emoji: "👤" }]);
    setNewE("");
  };

  const dropEmp = (ti) => {
    if (dragIdx === null || dragIdx === ti) { setDragIdx(null); return; }
    const n = [...es]; const [m] = n.splice(dragIdx, 1); n.splice(ti, 0, m);
    saveE(n); setDragIdx(null); setDragOverIdx(null);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 860 }}>
      <div style={cardS}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.dark, marginBottom: 6 }}>👥 Сотрудники</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>Перетащите строку для изменения порядка. Иконки и цвет меняются прямо в Неделе (шапка сотрудника).</div>
        {es.map((e, i) => (
          <div key={e.id} draggable onDragStart={() => setDragIdx(i)}
            onDragOver={ev => { ev.preventDefault(); setDragOverIdx(i); }}
            onDrop={() => dropEmp(i)} onDragLeave={() => setDragOverIdx(null)}
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "7px 10px", background: dragOverIdx === i ? C.goldLight : "#F9F8F6", borderRadius: 9, border: `1px solid ${dragOverIdx === i ? C.gold : "transparent"}`, cursor: "default", transition: "all .15s" }}>
            <span style={{ cursor: "grab", color: "#C0BAB0", fontSize: 14 }}>⠿</span>
            <span style={{ fontSize: 18 }}>{e.emoji || "👤"}</span>
            <input value={e.name} onChange={ev => saveE(es.map(x => x.id === e.id ? { ...x, name: ev.target.value } : x))}
              style={{ ...baseInp, flex: 1, background: "transparent", border: "none", fontWeight: 600, padding: "2px 0" }} />
            <div style={{ width: 20, height: 20, borderRadius: 5, background: e.color, flexShrink: 0, border: "2px solid rgba(0,0,0,.08)" }} />
            <button onClick={() => saveE(es.filter(x => x.id !== e.id))} style={{ background: "none", border: "none", color: "#E5A0A0", cursor: "pointer", fontSize: 16, padding: 2 }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input value={newE} onChange={e => setNewE(e.target.value)} onKeyDown={e => e.key === "Enter" && addEmp()} style={{ ...baseInp, flex: 1 }} placeholder="Имя нового сотрудника" />
          <button onClick={addEmp} style={btnS("primary")}>+ Добавить</button>
        </div>
      </div>

      <div style={cardS}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.dark, marginBottom: 14 }}>🏷️ Типы работы</div>
        {ws.map(w => (
          <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "7px 10px", background: "#F9F8F6", borderRadius: 9 }}>
            <input value={w.name} onChange={e => saveW(ws.map(x => x.id === w.id ? { ...x, name: e.target.value } : x))}
              style={{ ...baseInp, flex: 1, background: "transparent", border: "none", fontWeight: 500, padding: "2px 0" }} />
            <button onClick={() => saveW(ws.filter(x => x.id !== w.id))} style={{ background: "none", border: "none", color: "#E5A0A0", cursor: "pointer", fontSize: 16, padding: 2 }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input value={newW} onChange={e => setNewW(e.target.value)} onKeyDown={e => e.key === "Enter" && (() => { if (!newW.trim()) return; saveW([...ws, { id: mkId(), name: newW.trim() }]); setNewW(""); })()} style={{ ...baseInp, flex: 1 }} placeholder="Название типа работы" />
          <button onClick={() => { if (!newW.trim()) return; saveW([...ws, { id: mkId(), name: newW.trim() }]); setNewW(""); }} style={btnS("primary")}>+ Добавить</button>
        </div>
        <div style={{ marginTop: 16, padding: 12, background: "#F5E8CE", borderRadius: 9, fontSize: 12, color: "#7D5A20", lineHeight: 1.6 }}>
          💡 Типы выбираются для каждой задачи в Неделе. Аналитика покажет распределение времени по типам.
        </div>
      </div>

      <div style={{ ...cardS, gridColumn: "1 / -1" }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.dark, marginBottom: 10 }}>📌 Быстрые подсказки</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, fontSize: 13, color: C.text, lineHeight: 1.8 }}>
          <div><b>Ввод задач</b><br />Кликните в ячейку дня → пишите сразу. <b>Enter</b> = новая задача ниже. <b>×</b> = удалить задачу.</div>
          <div><b>Хронометраж</b><br />Введите «10:00-12:00» → Факт считается автоматически (2ч). Отображается зелёным рядом.</div>
          <div><b>Сотрудники</b><br />Перетащите ⠿ для сортировки. Кликните имя — редактировать. Кликните иконку — поменять эмодзи. Цветной квадрат — выбрать цвет.</div>
        </div>
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths } from "date-fns";
import { supabase } from "./supabase";

/*
 * LifeLog – 本機 + Supabase 混合版
 * ------------------------------------------------------------
 * 未登入：使用 localStorage（lifelog_v6）
 * 已登入：自動切換成 Supabase（讀寫雲端）
 * 
 * Supabase 資料表（建議在 SQL Editor 貼我提供的 schema）：
 * - days(date, wake_time, mood, goal, review, user_id)
 * - entries(date, start_t, end_t, granularity, category, note_text, user_id)
 * - notes(text, last_used, user_id)
 */

// ===== CONFIG =====
const STORAGE_KEY = "lifelog_v6";
const CATEGORIES = [
  { key: "productivity", label: "Productivity", color: "#CBEBAD" },
  { key: "investment",  label: "Investment",  color: "#ADEAEB" },
  { key: "consumption", label: "Consumption", color: "#CCADEB" },
  { key: "waste",       label: "Waste",       color: "#FF0002" },
];
const MOODS = ["😄","🙂","😐","🙁","😫","🤒","🤩","😴","🤯","😠"];

// ===== TPE (+08:00) helpers =====
const pad = (n)=> n.toString().padStart(2,"0");
const TPE_OFFSET = "+08:00";
function todayStr(){
  const now = new Date(Date.now() + 8*3600*1000);
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
}
function isoTPE(dateStr, h, m=0, s=0){ return `${dateStr}T${pad(h)}:${pad(m)}:${pad(s)}${TPE_OFFSET}`; }
function addDaysStr(dateStr, d){
  const [y,m,dd] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, dd + d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`;
}
function hhmmFromISO(iso){ return iso.slice(11,16); }
function dateFromISO(iso){ return iso.slice(0,10); }
function addMinutesISO(iso, mins){
  let d = dateFromISO(iso);
  let h = parseInt(iso.slice(11,13),10);
  let m = parseInt(iso.slice(14,16),10);
  let total = h*60 + m + mins;
  while (total < 0) { d = addDaysStr(d, -1); total += 1440; }
  while (total >= 1440) { d = addDaysStr(d, 1); total -= 1440; }
  const nh = Math.floor(total/60), nm = total%60;
  return isoTPE(d, nh, nm, 0);
}
function minutesBetween(aISO, bISO){ return Math.max(0, Math.round((new Date(bISO) - new Date(aISO))/60000)); }

// ===== 時段產生 =====
function getBigBlocksTPE(dateStr){
  const next = addDaysStr(dateStr, 1);
  return [
    { label: "06:00–12:00", startISO: isoTPE(dateStr, 6,0),  endISO: isoTPE(dateStr,12,0) },
    { label: "12:00–18:00", startISO: isoTPE(dateStr,12,0),  endISO: isoTPE(dateStr,18,0) },
    { label: "18:00–00:00", startISO: isoTPE(dateStr,18,0),  endISO: isoTPE(next,   0,0) }, // 跨至翌日 00:00
    { label: "00:00–06:00", startISO: isoTPE(dateStr, 0,0),  endISO: isoTPE(dateStr, 6,0) },
  ];
}
function hoursInBlockISO(block){
  const out = []; let cur = block.startISO;
  while (cur !== block.endISO){
    const nxt = addMinutesISO(cur, 60);
    out.push({ label: `${hhmmFromISO(cur).slice(0,2)}:00–${hhmmFromISO(nxt).slice(0,2)}:00`, startISO: cur, endISO: nxt });
    cur = nxt;
  }
  return out;
}
function quartersInHourISO(h){
  const out = []; let cur = h.startISO;
  for (let i=0;i<4;i++){ const nxt = addMinutesISO(cur, 15); out.push({ label: `${hhmmFromISO(cur)}–${hhmmFromISO(nxt)}`, startISO: cur, endISO: nxt }); cur = nxt; }
  return out;
}

// ===== 聚合 =====
function groupMinutesByCategory(entries){
  const agg = { productivity:0, investment:0, consumption:0, waste:0 };
  for (const e of entries) agg[e.category] += minutesBetween(e.start, e.end);
  return agg;
}
function categoriesInRange(entries, startISO, endISO){
  const s = new Date(startISO).getTime(), e = new Date(endISO).getTime();
  const set = new Set();
  for (const r of entries){
    const rs = new Date(r.start).getTime(), re = new Date(r.end).getTime();
    if (Math.max(s, rs) < Math.min(e, re)) set.add(r.category);
  }
  return [...set];
}

// ===== PERSISTENCE：本機 + Supabase =====
function defaultTemplates(){ return { productivity:[], investment:[], consumption:[], waste:[] }; }
function sanitizeTemplates(t){
  const base = defaultTemplates();
  if (!t) return base;
  for (const k of Object.keys(base)) base[k] = Array.isArray(t[k]) ? [...new Set(t[k].filter(Boolean))] : [];
  return base;
}
function loadLocal(){
  const raw = localStorage.getItem(STORAGE_KEY);
  let data = { days:[], entries:[], notes:[], templates: defaultTemplates() };
  if (!raw) return data;
  try{
    const parsed = JSON.parse(raw);
    data.days = parsed.days || [];
    data.entries = parsed.entries || [];
    data.notes = parsed.notes || [];
    data.templates = sanitizeTemplates(parsed.templates);
    return data;
  }catch{ return data; }
}
function saveLocal(state){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

// === Supabase helpers ===
async function pullFromSupabase(){
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const [days, entries, notes] = await Promise.all([
    supabase.from("days").select("*").order("date", { ascending: true }).then(r=>r.data??[]),
    supabase.from("entries").select("*").order("start_t", { ascending: true }).then(r=>r.data??[]),
    supabase.from("notes").select("*").order("last_used", { ascending: false }).then(r=>r.data??[]),
  ]);
  return {
    days: days.map(d => ({ id: d.id, date: d.date, wakeTime: d.wake_time, mood: d.mood, goal: d.goal, review: d.review })),
    entries: entries.map(e => ({
      id: e.id, date: e.date, start: e.start_t, end: e.end_t,
      granularity: e.granularity, category: e.category, noteText: e.note_text,
    })),
    notes: notes.map(n => ({ text: n.text, lastUsed: n.last_used })),
    templates: defaultTemplates(), // 模板暫存在本機；要搬雲端再說
  };
}

// ===== 小元件 =====
const Card = (p)=> <div className={"rounded-2xl shadow-sm border border-gray-200 bg-white p-4 "+(p.className||"")}>{p.children}</div>;
const Button = ({ className="", variant="default", children, ...rest }) => {
  const base = "px-3 py-2 rounded-xl border text-sm transition active:scale-[0.99]";
  const styles = variant === "primary"
    ? "bg-black text-white border-black hover:bg-black/90"
    : "bg-white border-gray-300 hover:bg-gray-100";
  return <button className={`${base} ${styles} ${className}`} {...rest}>{children}</button>;
};

const Chip = ({ active=false, children, onClick })=> (
  <button onClick={onClick} className={`text-xs px-2 py-1 rounded-full border ${active?"bg-black text-white":"bg-white hover:bg-gray-100"}`}>{children}</button>
);

// ===== App =====
export default function App(){
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("today");
  const [state, setState] = useState(loadLocal); // 先用本機起始
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [rangeKey, setRangeKey] = useState("today");
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);

  // Auth 監聽：登入後自動拉雲端資料覆蓋本機（僅資料，不動 templates）
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, sess) => {
      setUser(sess?.user ?? null);
      if (sess?.user) {
        const remote = await pullFromSupabase();
        if (remote) setState(s => ({ ...s, ...remote }));
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // 本機持久化（未登入時生效；登入時只是鏡像一份在本機，方便離線查看）
  useEffect(()=>saveLocal(state), [state]);

  const showToast = (msg="已順利紀錄")=>{ setToast(msg); setTimeout(()=>setToast(null), 2000); };

  const dayMeta = useMemo(()=> getOrCreateDay(state, selectedDate, setState), [state, selectedDate]);
  const dayEntries = useMemo(()=> state.entries.filter(e=>e.date===selectedDate), [state.entries, selectedDate]);

  const rangeDates = useMemo(()=>{
    const span = rangeKey==="today"?1 : rangeKey==="3d"?3 : rangeKey==="7d"?7 : 30;
    const arr=[]; for(let i=span-1;i>=0;i--){ arr.push(addDaysStr(selectedDate, -i)); }
    return arr;
  }, [selectedDate, rangeKey]);
  const entriesInRange = useMemo(()=> state.entries.filter(e=>rangeDates.includes(e.date)), [state.entries, rangeDates]);

  // templates（常用項目，先放本機）
  const addTemplate = (cat,text)=> setState(s=>{ const t={...s.templates}; if(!t[cat]) t[cat]=[]; if(text && !t[cat].includes(text)) t[cat]=[...t[cat], text]; return {...s, templates:t}; });
  const removeTemplate = (cat,text)=> setState(s=>{ const t={...s.templates}; t[cat]=(t[cat]||[]).filter(x=>x!==text); return {...s, templates:t}; });

  // 匯出 / 匯入（僅本機）
  const exportJSON = ()=>{
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "lifelog.json"; a.click(); URL.revokeObjectURL(url);
  };
  const importJSON = (file)=>{
    const r = new FileReader();
    r.onload = ()=>{
      try{
        const obj = JSON.parse(String(r.result));
        setState({
          days: obj.days||[], entries: obj.entries||[], notes: obj.notes||[], templates: sanitizeTemplates(obj.templates)
        });
        showToast("已匯入資料");
      }catch{ showToast("匯入失敗"); }
    };
    r.readAsText(file);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 text-gray-900 relative">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <header className="flex items-center justify-between gap-3 mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">LifeLog</h1>
          <nav className="flex gap-2">
            <Button variant={tab==="today"?"primary":"default"} onClick={()=>setTab("today")}>今日</Button>
            <Button variant={tab==="stats"?"primary":"default"} onClick={()=>setTab("stats")}>統計</Button>
            <Button variant={tab==="calendar"?"primary":"default"} onClick={()=>setTab("calendar")}>月曆</Button>
          </nav>

          {/* 右上角：登入/登出 */}
          <div className="flex items-center gap-2">
            {user ? (
              <>
                <span className="text-sm text-gray-600">已登入</span>
                <Button onClick={()=> supabase.auth.signOut()}>登出</Button>
              </>
            ) : <LoginBox/>}
          </div>
        </header>

        <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
          <input type="date" value={selectedDate} onChange={e=>setSelectedDate(e.target.value)} className="border rounded-xl px-3 py-2"/>
          <div className="text-sm text-gray-600">目前日期（台北）：{selectedDate}</div>
          <div className="flex-1"/>
          <div className="flex gap-2">
            <Button onClick={exportJSON}>匯出</Button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={e=>{const f=e.target.files?.[0]; if(f) importJSON(f); e.currentTarget.value="";}}/>
            <Button onClick={()=>fileRef.current?.click()}>匯入</Button>
            <Button onClick={()=>{ localStorage.removeItem(STORAGE_KEY); setState({days:[], entries:[], notes:[], templates: defaultTemplates()}); }}>清空本機資料</Button>
          </div>
        </div>

        {tab==="today" && (
          <TodayScreen
            dayMeta={dayMeta}
            setDayMeta={(dm)=>updateDayMeta(user, state, setState, dm)}
            entries={dayEntries}
            addEntry={(e)=>addEntry(user, state, setState, e)}
            removeEntry={(id)=>removeEntry(user, state, setState, id)}
            notes={state.notes}
            upsertNote={(t)=>upsertNote(user, state, setState, t)}
            selectedDate={selectedDate}
            templates={state.templates}
            addTemplate={addTemplate}
            removeTemplate={removeTemplate}
            showToast={showToast}
          />
        )}

        {tab==="stats" && (
          <StatsScreen entriesInRange={entriesInRange} rangeKey={rangeKey} setRangeKey={setRangeKey}/>
        )}

        {tab==="calendar" && (
          <CalendarScreen
            user={user}
            state={state}
            setState={setState}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            templates={state.templates}
            addTemplate={addTemplate}
            removeTemplate={removeTemplate}
            showToast={showToast}
          />
        )}

        <footer className="mt-10 text-xs text-gray-500">
          <p>提示：未登入時資料儲存在本機（localStorage）；登入後自動切換雲端（Supabase）。</p>
        </footer>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-black text-white text-sm px-3 py-2 rounded-xl shadow">{toast}</div>
      )}
    </div>
  );
}

// ===== LoginBox（Email/Password 最小可用） =====
function LoginBox() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [isSignup, setIsSignup] = useState(false);

  const submit = async () => {
    if (!email || !pw) return alert("請輸入 Email 與密碼");
    if (isSignup) {
      const { data, error } = await supabase.auth.signUp({ email, password: pw });
      if (error) return alert(error.message);
      // 若你的 Supabase 有開「Email 確認」，這裡會寄信給你；否則會直接建立帳號
      alert("註冊成功！如果有開啟信箱驗證，請到信箱點擊確認連結。");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
      if (error) return alert(error.message);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input className="border rounded-xl px-2 py-1 text-sm" placeholder="Email"
             value={email} onChange={e=>setEmail(e.target.value)} />
      <input className="border rounded-xl px-2 py-1 text-sm" placeholder="Password" type="password"
             value={pw} onChange={e=>setPw(e.target.value)} />
      <Button onClick={submit}>{isSignup ? "註冊" : "登入"}</Button>
      <button className="text-xs underline" onClick={()=>setIsSignup(s=>!s)}>
        {isSignup ? "改用登入" : "我要註冊"}
      </button>
    </div>
  );
}


// ===== Screens（沿用你的 UI） =====
function TodayScreen({ dayMeta, setDayMeta, entries, addEntry, removeEntry, notes, upsertNote, selectedDate, templates, addTemplate, removeTemplate, showToast }){
  const [focusRange, setFocusRange] = useState(null);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <DayMetaForm dayMeta={dayMeta} setDayMeta={setDayMeta}/>
        <TimeHierarchy
          dateStr={selectedDate}
          dayEntries={entries}
          addEntry={addEntry}
          upsertNote={upsertNote}
          templates={templates}
          addTemplate={addTemplate}
          removeTemplate={removeTemplate}
          showToast={showToast}
          focusRange={focusRange}
          setFocusRange={setFocusRange}
        />
        <Card>
          <div className="font-medium mb-2">已紀錄</div>
          {entries.length===0 && <div className="text-sm text-gray-500">尚無紀錄</div>}
          <div className="space-y-2">
            {entries.map(e=> (
              <div key={e.id} className="flex items-center justify-between gap-2 border rounded-xl p-2">
                <div className="text-sm">
                  <span className="font-medium" style={{color: CATEGORIES.find(c=>c.key===e.category)?.color}}>
                    {CATEGORIES.find(c=>c.key===e.category)?.label}
                  </span>
                  <span className="ml-2 text-gray-600">{hhmmFromISO(e.start)}–{hhmmFromISO(e.end)}</span>
                  <span className="ml-2 text-xs text-gray-500">{e.granularity}</span>
                  {e.noteText && <span className="ml-2 text-gray-700">• {e.noteText}</span>}
                  <span className="ml-2 text-gray-500">({minutesBetween(e.start,e.end)} 分)</span>
                </div>
                <Button onClick={()=>removeEntry(e.id)}>刪除</Button>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="lg:col-span-1 space-y-4">
        <Card>
          <div className="font-medium mb-2">常用項目（依分類）</div>
          <TemplatesManager templates={templates} addTemplate={addTemplate} removeTemplate={removeTemplate}/>
        </Card>
        <Card>
          <div className="font-medium mb-2">當日圓餅圖</div>
          <MiniPie entries={entries}/>
          <div className="mt-2 flex gap-2">
            {focusRange && <Button onClick={()=>setFocusRange(null)}>清除高亮</Button>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function StatsScreen({ entriesInRange, rangeKey, setRangeKey }){
  const data = useMemo(()=>{
    const agg = groupMinutesByCategory(entriesInRange);
    return CATEGORIES.map(c=>({ name:c.label, value: agg[c.key], color:c.color }));
  }, [entriesInRange]);
  const totalMin = data.reduce((s,d)=>s+d.value,0);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="font-medium">篩選</div>
          <div className="flex gap-2">
            {( ["today","3d","7d","30d"]).map(k=> (
              <Chip key={k} active={rangeKey===k} onClick={()=>setRangeKey(k)}>
                {k==="today"?"當天":k==="3d"?"最近3天":k==="7d"?"最近一週":"最近一個月"}
              </Chip>
            ))}
          </div>
        </div>
        <div className="text-sm text-gray-600 mb-2">總時數：{(totalMin/60).toFixed(1)} 小時</div>
        <div className="h-[clamp(260px,50vw,400px)]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={70} outerRadius={130}>
                {data.map((d,i)=>(<Cell key={i} fill={d.color}/>))}
              </Pie>
              <Legend/>
              <Tooltip formatter={(v)=>`${v} 分`}/>
            </PieChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <div className="font-medium mb-2">明細</div>
        <div className="space-y-2 text-sm">
          {data.map(d=> (
            <div key={d.name} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-sm" style={{background:d.color}}/>
                <span>{d.name}</span>
              </div>
              <div>{d.value} 分（{((d.value/Math.max(1,totalMin))*100).toFixed(1)}%）</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function CalendarScreen({ user, state, setState, selectedDate, setSelectedDate, templates, addTemplate, removeTemplate, showToast }) {
  const base = new Date(`${selectedDate}T00:00:00`);
  const start = startOfMonth(base);
  const end   = endOfMonth(base);
  const monthDays  = eachDayOfInterval({ start, end });

  const firstWeekday = start.getDay(); // 0=Sun
  const leadingNulls = Array(firstWeekday).fill(null);
  const cells = [...leadingNulls, ...monthDays];
  const trailing = (7 - (cells.length % 7)) % 7;
  for(let i=0;i<trailing;i++) cells.push(null);

  const [drillDate, setDrillDate] = useState(format(base, "yyyy-MM-dd"));
  const drillEntries = useMemo(()=> state.entries.filter(e=>e.date===drillDate), [state.entries, drillDate]);
  const drillDayMeta = useMemo(()=> getOrCreateDay(state, drillDate, setState), [state, drillDate]);

  const [focusRange, setFocusRange] = useState(null);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <div className="lg:col-span-7">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="font-medium">月曆</div>
            <div className="flex gap-2">
              <Button onClick={()=>{ const prev=new Date(addMonths(base,-1)); const s=format(prev,"yyyy-MM-dd"); setSelectedDate(s); setDrillDate(s); }}>上個月</Button>
              <Button onClick={()=>{ const next=new Date(addMonths(base, 1)); const s=format(next,"yyyy-MM-dd"); setSelectedDate(s); setDrillDate(s); }}>下個月</Button>
            </div>
          </div>
          <div className="grid grid-cols-7 text-[11px] text-gray-500 mb-2">
            {["日","一","二","三","四","五","六"].map(w=> (<div key={w} className="text-center">{w}</div>))}
          </div>
          <div className="grid grid-cols-7 gap-2">
            {cells.map((d,idx)=>{
              if(!d) return <div key={`null-${idx}`} className="rounded-xl border p-1 opacity-30" style={{height:78}}/>;
              const dateStr = format(d, "yyyy-MM-dd");
              const entries = state.entries.filter(e=>e.date===dateStr);
              const bg = dayCellPieBG(entries);
              return (
                <button key={dateStr} onClick={()=>{setDrillDate(dateStr); setFocusRange(null);}} className={`rounded-xl border p-1 flex flex-col ${drillDate===dateStr?"ring-2 ring-black":""}`}
                        style={{height:78}}>
                  <div className="text-[10px] text-right text-gray-500">{format(d, "d")}</div>
                  <div className="rounded-lg" style={{height:56, background:bg}}/>
                </button>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="lg:col-span-5 space-y-4">
        <Card>
          <div className="font-medium mb-2">當日檢視</div>
          <div className="text-sm text-gray-600 mb-2">{drillDate}</div>
          <MiniPie entries={drillEntries}/>
          <div className="mt-3">
            <DaySummaryChips dateStr={drillDate} entries={drillEntries} focusRange={focusRange} setFocusRange={setFocusRange}/>
          </div>
        </Card>

        <DayMetaForm dayMeta={drillDayMeta} setDayMeta={(dm)=>updateDayMeta(user, state, setState, dm)}/>
        <TimeHierarchy
          dateStr={drillDate}
          dayEntries={drillEntries}
          addEntry={(e)=>addEntry(user, state, setState, e)}
          upsertNote={(t)=>upsertNote(user, state, setState, t)}
          templates={templates}
          addTemplate={addTemplate}
          removeTemplate={removeTemplate}
          showToast={showToast}
          focusRange={focusRange}
          setFocusRange={setFocusRange}
        />

        <Card>
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">在「今日」頁開啟此日</div>
            <Button onClick={()=>setSelectedDate(drillDate)}>切換到此日期</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ===== Reusable parts =====
function DayMetaForm({ dayMeta, setDayMeta }){
  const [draft, setDraft] = useState(dayMeta);
  const composingRef = useRef(false);
  const saveTimer = useRef(null);

  // 切換日期時帶入新的初始值
  useEffect(()=>{ setDraft(dayMeta); }, [dayMeta.id, dayMeta.date]);

  const scheduleSave = (next) => {
    clearTimeout(saveTimer.current);
    // 組字中就先不存；結束後或 blur 再存
    if (composingRef.current) return;
    saveTimer.current = setTimeout(()=> setDayMeta(next), 400);
  };

  const onField = (key) => (e) => {
    const val = e.target.value;
    const next = { ...draft, [key]: val };
    setDraft(next);
    scheduleSave(next);
  };

  const onBlurSave = () => {
    clearTimeout(saveTimer.current);
    setDayMeta(draft);
  };

  const onCompStart = () => { composingRef.current = true; };
  const onCompEnd = (key) => (e) => {
    composingRef.current = false;
    const val = e.target.value;
    const next = { ...draft, [key]: val };
    setDraft(next);
    // 中文組字完成立刻存
    setDayMeta(next);
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="text-lg font-medium">{draft.date}</div>
        <Button onClick={()=>{
          const now = new Date();
          const next = { ...draft, wakeTime: `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}` };
          setDraft(next);
          setDayMeta(next); // 點按鈕立即存
        }}>記錄起床時間</Button>
      </div>
      <div className="mt-3 text-sm text-gray-600">起床時間：{draft.wakeTime ?? "尚未記錄"}</div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="font-medium">心情</div>
        <div className="flex gap-1 flex-wrap">
          {MOODS.map(m=> (
            <Chip key={m} active={draft.mood===m} onClick={()=>{
              const next = { ...draft, mood:m };
              setDraft(next);
              setDayMeta(next);
            }}>{m}</Chip>
          ))}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="font-medium mb-1">今日目標</div>
          <input
            className="w-full border rounded-xl px-3 py-2"
            value={draft.goal ?? ""}
            onChange={onField("goal")}
            onBlur={onBlurSave}
            onCompositionStart={onCompStart}
            onCompositionEnd={onCompEnd("goal")}
            placeholder="今天最想完成的事…"
          />
        </div>
        <div>
          <div className="font-medium mb-1">今日評語</div>
          <input
            className="w-full border rounded-xl px-3 py-2"
            value={draft.review ?? ""}
            onChange={onField("review")}
            onBlur={onBlurSave}
            onCompositionStart={onCompStart}
            onCompositionEnd={onCompEnd("review")}
            placeholder="一句話描述今天…"
          />
        </div>
      </div>
    </Card>
  );
}


function MiniPie({ entries }){
  const data = useMemo(()=>{
    const agg = groupMinutesByCategory(entries);
    return CATEGORIES.map(c=>({ name:c.label, value: agg[c.key], color:c.color }));
  }, [entries]);
  const has = data.some(d=>d.value>0);
  return (
    <div style={{ height: "clamp(220px, 50vw, 340px)" }}>
      {has ? (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={120}>
              {data.map((d,i)=>(<Cell key={i} fill={d.color}/>))}
            </Pie>
            <Tooltip formatter={(v)=>`${v} 分`}/>
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-full grid place-items-center text-sm text-gray-500">尚無資料</div>
      )}
    </div>
  );
}

function TimeHierarchy({ dateStr, dayEntries, addEntry, upsertNote, templates, addTemplate, removeTemplate, showToast, focusRange, setFocusRange }){
  const [expandedBig, setExpandedBig] = useState(null);
  const [expandedHour, setExpandedHour] = useState(null);
  const bigs = getBigBlocksTPE(dateStr);

  return (
    <Card>
      <div className="font-medium mb-2">時間紀錄</div>
      <div className="space-y-3">
        {bigs.map((b,i)=>{
          const cats = categoriesInRange(dayEntries, b.startISO, b.endISO);
          const dim = focusRange && !(Math.max(new Date(focusRange.startISO), new Date(b.startISO)) < Math.min(new Date(focusRange.endISO), new Date(b.endISO)));
          return (
            <div key={i} className={`border rounded-xl p-3 ${dim?"opacity-40":""}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <button className="font-medium" onClick={()=>setFocusRange({startISO:b.startISO,endISO:b.endISO})}>{b.label}</button>
                  {cats.length>0 && (
                    <div className="flex gap-1 flex-wrap">
                      {cats.map(k=>{ const c=CATEGORIES.find(x=>x.key===k); return (
                        <span key={k} className="text-[11px] px-2 py-0.5 rounded-full border" style={{borderColor:c.color, color:c.color}}>{c.label}</span>
                      ); })}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <QuickAddButton
                    slotLabel={b.label}
                    startISO={b.startISO}
                    endISO={b.endISO}
                    granularity="big"
                    addEntry={addEntry}
                    upsertNote={upsertNote}
                    templates={templates}
                    addTemplate={addTemplate}
                    removeTemplate={removeTemplate}
                    onSuccess={showToast}
                  />
                  <Button onClick={()=>setExpandedBig(prev=>prev===i?null:i)}>{expandedBig===i?"收合":"展開時段"}</Button>
                </div>
              </div>

              {expandedBig===i && (
                <div className="mt-3 space-y-2">
                  {hoursInBlockISO(b).map(h=> {
                    const dimH = focusRange && !(Math.max(new Date(focusRange.startISO), new Date(h.startISO)) < Math.min(new Date(focusRange.endISO), new Date(h.endISO)));
                    return (
                    <div key={h.label} className={`border rounded-xl p-2 ${dimH?"opacity-40": ""}`}>
                      <div className="flex items-center justify-between">
                        <div className="text-sm flex items-center gap-2">
                          <button onClick={()=>setFocusRange({startISO:h.startISO,endISO:h.endISO})}>{h.label}</button>
                          {(() => {
                            const _cats = categoriesInRange(dayEntries, h.startISO, h.endISO);
                            return _cats.length>0 ? (
                              <div className="flex gap-1 flex-wrap">
                                {_cats.map(k => {
                                  const c = CATEGORIES.find(x=>x.key===k);
                                  return <span key={k} className="text-[11px] px-2 py-0.5 rounded-full border" style={{borderColor:c.color, color:c.color}}>{c.label}</span>;
                                })}
                              </div>
                            ) : null;
                          })()}
                        </div>
                        <div className="flex gap-2">
                          <QuickAddButton
                            slotLabel={h.label}
                            startISO={h.startISO}
                            endISO={h.endISO}
                            granularity="hour"
                            addEntry={addEntry}
                            upsertNote={upsertNote}
                            templates={templates}
                            addTemplate={addTemplate}
                            removeTemplate={removeTemplate}
                            onSuccess={showToast}
                          />
                          <Button onClick={()=>setExpandedHour(prev=>prev===h.label?null:h.label)}>{expandedHour===h.label?"收合15分鐘":"15分鐘"}</Button>
                        </div>
                      </div>

                      {expandedHour===h.label && (
                        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                          {quartersInHourISO(h).map(q=> {
                            const dimQ = focusRange && !(Math.max(new Date(focusRange.startISO), new Date(q.startISO)) < Math.min(new Date(focusRange.endISO), new Date(q.endISO)));
                            return (
                            <div key={q.label} className={`border rounded-xl p-2 ${dimQ?"opacity-40":""}`}>
                              <div className="flex items-center justify-between">
                                <div className="text-xs text-gray-600 flex items-center gap-2">
                                  <button onClick={()=>setFocusRange({startISO:q.startISO,endISO:q.endISO})}>{q.label}</button>
                                  {(() => {
                                    const _cats = categoriesInRange(dayEntries, q.startISO, q.endISO);
                                    return _cats.length>0 ? (
                                      <div className="flex gap-1 flex-wrap">
                                        {_cats.map(k => {
                                          const c = CATEGORIES.find(x=>x.key===k);
                                          return <span key={k} className="text-[10px] px-2 py-0.5 rounded-full border" style={{borderColor:c.color, color:c.color}}>{c.label}</span>;
                                        })}
                                      </div>
                                    ) : null;
                                  })()}
                                </div>
                                <QuickAddButton
                                  slotLabel={q.label}
                                  startISO={q.startISO}
                                  endISO={q.endISO}
                                  granularity="quarter"
                                  addEntry={addEntry}
                                  upsertNote={upsertNote}
                                  templates={templates}
                                  addTemplate={addTemplate}
                                  removeTemplate={removeTemplate}
                                  onSuccess={showToast}
                                />
                              </div>
                            </div>
                          );})}
                        </div>
                      )}
                    </div>
                  );})}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {focusRange && (
        <div className="mt-2"><Button onClick={()=>setFocusRange(null)}>清除高亮</Button></div>
      )}
    </Card>
  );
}

function QuickAddButton({ slotLabel, startISO, endISO, granularity, addEntry, upsertNote, templates, addTemplate, removeTemplate, onSuccess }){
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState("productivity");
  const [note, setNote] = useState("");
  const tpl = templates?.[cat] || [];

  return (
    <div className="relative">
      <Button onClick={()=>setOpen(o=>!o)}>新增紀錄</Button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 z-10 bg-white border rounded-xl shadow-xl p-3 space-y-3">
          <div className="text-xs text-gray-500">紀錄時段：<span className="font-medium text-gray-700">{slotLabel}</span></div>

          <div className="text-sm">選擇分類</div>
          <div className="grid grid-cols-2 gap-2">
            {CATEGORIES.map(c=> (
              <button key={c.key} onClick={()=>setCat(c.key)} className={`border rounded-lg p-2 text-left ${cat===c.key?"ring-2 ring-black":""}`}>
                <div className="text-sm font-medium" style={{color:c.color}}>{c.label}</div>
              </button>
            ))}
          </div>

          <div className="text-sm">此分類常用項目</div>
          <div className="flex gap-1 flex-wrap max-h-28 overflow-auto">
            {tpl.length===0 && <div className="text-xs text-gray-500">尚無常用項目</div>}
            {tpl.map(t=> (
              <div key={t} className="flex items-center gap-1 border rounded-full px-2 py-1 text-xs bg-gray-50">
                <button onClick={()=>setNote(t)}>{t}</button>
                <button className="text-gray-400" title="刪除" onClick={()=>removeTemplate(cat, t)}>✕</button>
              </div>
            ))}
          </div>

          <div className="text-sm">細項描述</div>
          <input value={note} onChange={e=>setNote(e.target.value)} className="w-full border rounded-lg px-2 py-1" placeholder="例如：學習 ChatGPT 用法"/>

          <div className="flex items-center justify-between">
            <button className="text-xs underline" onClick={()=>{ if(note.trim()) addTemplate(cat, note.trim()); }}>將此內容存為常用</button>
            <div className="flex gap-2">
              <Button onClick={()=>setOpen(false)}>取消</Button>
              <Button variant="primary" onClick={()=>{
                addEntry({ start:startISO, end:endISO, granularity, category:cat, noteText: note || undefined });
                if (note.trim()) upsertNote(note.trim());
                setNote(""); setOpen(false); onSuccess && onSuccess();
              }}>加入</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TemplatesManager({ templates, addTemplate, removeTemplate }){
  const [active, setActive] = useState("productivity");
  const [val, setVal] = useState("");
  const list = templates?.[active] || [];
  return (
    <div>
      <div className="flex gap-2 mb-2">
        {CATEGORIES.map(c=> (<Chip key={c.key} active={active===c.key} onClick={()=>setActive(c.key)}>{c.label}</Chip>))}
      </div>
      <div className="flex gap-2">
        <input className="flex-1 border rounded-xl px-3 py-2" value={val} onChange={e=>setVal(e.target.value)} placeholder="新增此分類常用項目"/>
        <Button className="bg-black text-white" onClick={()=>{ if (val.trim()) { addTemplate(active, val.trim()); setVal(""); } }}>加入</Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {list.length===0 && <div className="text-xs text-gray-500">尚無項目</div>}
        {list.map(t=> (
          <span key={t} className="text-xs border rounded-full px-2 py-1 bg-gray-50 flex items-center gap-2">
            {t}
            <button className="text-gray-400" title="刪除" onClick={()=>removeTemplate(active, t)}>✕</button>
          </span>
        ))}
      </div>
    </div>
  );
}

function DaySummaryChips({ dateStr, entries, focusRange, setFocusRange }){
  const blocks = getBigBlocksTPE(dateStr);
  const [openBig, setOpenBig] = useState({});
  const [openHour, setOpenHour] = useState({});
  const toggleBig = (lbl)=> setOpenBig(s=>({ ...s, [lbl]: !s[lbl] }));
  const toggleHour = (b,h)=> setOpenHour(s=>({ ...s, [`${b}|${h}`]: !s[`${b}|${h}`] }));
  const inRange = (startISO,endISO)=> !focusRange || (Math.max(new Date(focusRange.startISO), new Date(startISO)) < Math.min(new Date(focusRange.endISO), new Date(endISO)));

  return (
    <div className="space-y-2 max-h-[420px] overflow-auto">
      {blocks.map(b=>{
        const bCats = categoriesInRange(entries, b.startISO, b.endISO);
        const dimB = !inRange(b.startISO,b.endISO);
        const hours = hoursInBlockISO(b);
        const hoursWithData = hours.filter(h => categoriesInRange(entries,h.startISO,h.endISO).length>0).length;
        const quartersWithData = hours.reduce((sum,h)=> sum + quartersInHourISO(h).filter(q=>categoriesInRange(entries,q.startISO,q.endISO).length>0).length, 0);
        return (
          <div key={b.label} className={`space-y-1 ${dimB?"opacity-40":""}`}>
            <div className="flex items-center gap-2 text-sm">
              <button className="text-left text-gray-700 w-24" onClick={()=>{ setFocusRange({startISO:b.startISO,endISO:b.endISO}); toggleBig(b.label); }}>
                {b.label}
              </button>
              {bCats.length===0 ? <span className="text-xs text-gray-400">尚未記錄</span> : (
                <div className="flex gap-1 flex-wrap">
                  {bCats.map(k=>{ const c=CATEGORIES.find(x=>x.key===k); return (
                    <span key={k} className="text-[11px] px-2 py-0.5 rounded-full border" style={{borderColor:c.color, color:c.color}}>{c.label}</span>
                  ); })}
                </div>
              )}
              <span className="ml-auto text-[10px] text-gray-500">{hoursWithData} 小時 / {quartersWithData} 個 15m</span>
              <Button onClick={()=>toggleBig(b.label)}>{openBig[b.label]?"收合":"展開"}</Button>
            </div>

            {openBig[b.label] && hours.map(h=>{
              const hCats = categoriesInRange(entries, h.startISO, h.endISO);
              if (hCats.length===0) return null;
              const key = `${b.label}|${h.label}`;
              const dimH = !inRange(h.startISO,h.endISO);
              return (
                <div key={h.label} className={`pl-6 flex items-center gap-2 text-[13px] ${dimH?"opacity-40":""}`}>
                  <button className="text-left text-gray-700 w-24" onClick={()=>{ setFocusRange({startISO:h.startISO,endISO:h.endISO}); toggleHour(b.label,h.label); }}>{h.label}</button>
                  <div className="flex gap-1 flex-wrap">
                    {hCats.map(k=>{ const c=CATEGORIES.find(x=>x.key===k); return (
                      <span key={k} className="text-[10px] px-2 py-0.5 rounded-full border" style={{borderColor:c.color, color:c.color}}>{c.label}</span>
                    ); })}
                  </div>
                  <Button className="ml-auto" onClick={()=>toggleHour(b.label,h.label)}>{openHour[key]?"收合15m":"展開15m"}</Button>
                </div>
              );
            })}

            {openBig[b.label] && hoursInBlockISO(b).map(h => (
              openHour[`${b.label}|${h.label}`] ? (
                quartersInHourISO(h).map(q=>{
                  const qCats = categoriesInRange(entries, q.startISO, q.endISO);
                  if (qCats.length===0) return null;
                  const dimQ = !inRange(q.startISO,q.endISO);
                  return (
                    <div key={`${b.label}-${h.label}-${q.label}`} className={`pl-12 flex items-center gap-2 text-[12px] ${dimQ?"opacity-40":""}`}>
                      <button className="text-left text-gray-700 w-24" onClick={()=>setFocusRange({startISO:q.startISO,endISO:q.endISO})}>{q.label}</button>
                      <div className="flex gap-1 flex-wrap">
                        {qCats.map(k=>{ const c=CATEGORIES.find(x=>x.key===k); return (
                          <span key={k} className="text-[10px] px-2 py-0.5 rounded-full border" style={{borderColor:c.color, color:c.color}}>{c.label}</span>
                        ); })}
                      </div>
                    </div>
                  );
                })
              ) : null
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ===== State helpers：本機 & 雲端兩套路徑 =====
function uid(prefix="id"){ return `${prefix}_${Math.random().toString(36).slice(2,9)}`; }

function getOrCreateDay(state, dateStr, setState){
  let day = state.days.find(d=>d.date===dateStr);
  if(!day){ day = { id: uid("day"), date: dateStr, wakeTime: null, mood: null, goal: "", review: "" }; setState(s=>({...s, days:[...s.days, day]})); }
  return day;
}

async function updateDayMeta(user, state, setState, newDay){
  if (!user) {
    // 本機模式：照舊
    setState(s=>({ ...s, days: s.days.map(d=>d.id===newDay.id? newDay : d) }));
    return;
  }

  // 雲端模式：不要帶 id，交給資料庫生 UUID；用 (user_id, date) 做 upsert
  const payload = {
    user_id: user.id,
    date: newDay.date,
    wake_time: newDay.wakeTime ?? null,
    mood: newDay.mood ?? null,
    goal: newDay.goal ?? null,
    review: newDay.review ?? null,
  };

  const { data, error } = await supabase
    .from("days")
    .upsert(payload, { onConflict: "user_id,date" })
    .select()
    .single();

  if (error) {
    alert(error.message);
    return;
  }

  // 用資料庫回傳的 UUID 蓋掉本機臨時 id，保持 state 內一致
  const fixed = { ...newDay, id: data.id };
  setState(s => ({
    ...s,
    days: s.days.map(d => d.date === fixed.date ? fixed : d)
  }));
}


async function addEntry(user, state, setState, { start, end, granularity, category, noteText }){
  const dateStr = dateFromISO(start);
  if (!user) { // 本機
    const e = { id: uid("e"), date: dateStr, start, end, granularity, category, noteText: noteText ?? null };
    setState(s=>({ ...s, entries: [...s.entries, e] }));
    return;
  }
  // 雲端
  const { data, error } = await supabase
    .from("entries")
    .insert({
      user_id: user.id, date: dateStr,
      start_t: start, end_t: end,
      granularity, category, note_text: noteText ?? null
    })
    .select()
    .single();
  if (error) return alert(error.message);
  const e = { id: data.id, date: data.date, start: data.start_t, end: data.end_t, granularity: data.granularity, category: data.category, noteText: data.note_text };
  setState(s=>({ ...s, entries: [...s.entries, e] }));
}

async function removeEntry(user, state, setState, id){
  if (!user) {
    setState(s=>({ ...s, entries: s.entries.filter(e=>e.id!==id) }));
    return;
  }
  const { error } = await supabase.from("entries").delete().eq("id", id);
  if (error) return alert(error.message);
  setState(s=>({ ...s, entries: s.entries.filter(e=>e.id!==id) }));
}

async function upsertNote(user, state, setState, text){
  const now = new Date().toISOString();
  if (!user) {
    const ex = state.notes.find(n=>n.text===text);
    if (ex) setState(s=>({ ...s, notes: s.notes.map(n=>n.text===text? { ...n, lastUsed: now } : n) }));
    else setState(s=>({ ...s, notes: [...s.notes, { text, lastUsed: now }] }));
    return;
  }
  const { data, error } = await supabase
    .from("notes")
    .upsert({ user_id: user.id, text, last_used: now }, { onConflict: "user_id,text" })
    .select()
    .single();
  if (error) return alert(error.message);
  const ex = state.notes.find(n=>n.text===text);
  if (ex) setState(s=>({ ...s, notes: s.notes.map(n=>n.text===text? { ...n, lastUsed: data.last_used } : n) }));
  else setState(s=>({ ...s, notes: [...s.notes, { text, lastUsed: data.last_used }] }));
}

// ===== 永遠畫出小圓餅背景 =====
function dayCellPieBG(entries){
  const agg = groupMinutesByCategory(entries);
  const total = Object.values(agg).reduce((s,v)=>s+v,0);
  if (!total) return "repeating-conic-gradient(#e5e7eb 0 10deg, #fff 10deg 20deg)";
  let cur = 0, stops=[];
  for (const c of CATEGORIES){
    const deg = (agg[c.key] / total) * 360;
    if (deg>0){ stops.push(`${c.color} ${cur}deg ${cur+deg}deg`); cur += deg; }
  }
  return `conic-gradient(${stops.join(",")})`;
}

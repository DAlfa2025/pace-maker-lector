import { useState, useEffect, useCallback, Fragment } from "react";
import { ComposedChart, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Cell, Line, LabelList } from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────
const OPS = [
  { key:1,  label:"Op1",  station:"GUSSET 6",     stationFull:"GUSSET 6 (18)",    std:733 },
  { key:2,  label:"Op2",  station:"GUSSET 5",     stationFull:"GUSSET 5 (17)",    std:847 },
  { key:3,  label:"Op3",  station:"GUSSET 4",     stationFull:"GUSSET 4 (16)",    std:828 },
  { key:4,  label:"Op4",  station:"GUSSET 3",     stationFull:"GUSSET 3 (15)",    std:790 },
  { key:5,  label:"Op5",  station:"GUSSET 2",     stationFull:"GUSSET 2 (14)",    std:796 },
  { key:6,  label:"Op6",  station:"GUSSET 1",     stationFull:"GUSSET 1 (13)",    std:834 },
  { key:7,  label:"Op7",  station:"GUSSET 0",     stationFull:"GUSSET 0 (11)",    std:788 },
  { key:8,  label:"Op8",  station:"A FRAME",      stationFull:"A FRAME (8)",       std:859 },
  { key:9,  label:"Op9",  station:"DASH SUB",     stationFull:"DASH SUB (6)",     std:754 },
  { key:10, label:"Op10", station:"DASH FINAL",   stationFull:"DASH FINAL (7)",   std:845 },
  { key:11, label:"Op11", station:"GUSSET 0.5",   stationFull:"GUSSET 0.5 (12)",  std:799 },
  { key:12, label:"Op12", station:"FRONT FINAL",  stationFull:"FRONT FINAL (5)",  std:823 },
  { key:13, label:"Op13", station:"FINAL LH",     stationFull:"FINAL LH (10)",    std:765 },
  { key:14, label:"Op14", station:"FINAL RH",     stationFull:"FINAL RH (9)",     std:774 },
  { key:15, label:"Op15", station:"FRONT B WELD", stationFull:"FRONT B WELD (4)", std:828 },
  { key:16, label:"Op16", station:"CROSS/AXLE",   stationFull:"CROSS/AXLE (1)",   std:764 },
  { key:17, label:"Op17", station:"REAR FINAL",   stationFull:"REAR FINAL (3)",   std:886 },
  { key:18, label:"Op18", station:"SEAT SUB",     stationFull:"SEAT SUB (2)",     std:822 },
];
const CT = 886;
const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const OP_COLS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18];

// ─── Supabase REST helpers ─────────────────────────────────────────────────────
const sbRequest = async (sbUrl, sbKey, path, method = "GET", body = null, extra = {}) => {
  const res = await fetch(`${sbUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      "Content-Type": "application/json",
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status}: ${txt}`);
  }
  return method === "GET" ? res.json() : null;
};

const sbLoad = (url, key, turno) =>
  sbRequest(url, key, `/production_data?select=*&turno=eq.${turno}&order=date.asc`);

const sbUpsert = (url, key, rows) =>
  sbRequest(url, key, "/production_data", "POST", rows, {
    Prefer: "resolution=merge-duplicates",
  });

// ── Supabase Storage helpers ──────────────────────────────────────────────────
const BUCKET = "csv-files";

const sbUploadFile = async (url, key, path, text) => {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "text/csv",
      "x-upsert": "true",
    },
    body: text,
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json();
};

const sbListFiles = async (url, key, prefix) => {
  const res = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix, limit: 200, sortBy: { column:"created_at", order:"desc" } }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json();
};

const sbDownloadFile = async (url, key, path) => {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error("No se pudo descargar el archivo");
  return res.text();
};

const sbDeleteFile = async (url, key, path) => {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
};

// Save CSV file metadata to csv_files table
const sbSaveFileMeta = (url, key, meta) =>
  sbRequest(url, key, "/csv_files", "POST", [meta], { Prefer: "resolution=merge-duplicates" });

const sbLoadFileMeta = (url, key) =>
  sbRequest(url, key, "/csv_files?select=*&order=uploaded_at.desc");

// Convert DB row → internal daily format
const rowToDay = (r) => ({
  date: r.date,
  avgs: Object.fromEntries(OP_COLS.map(k => [k, r[`op${k}`] || 0])),
  cycle_count: r.cycle_count,
});

// Convert internal daily format → DB row
const dayToRow = (day, turno) => ({
  date: day.date,
  turno,
  ...Object.fromEntries(OP_COLS.map(k => [`op${k}`, day.avgs[k] || null])),
  cycle_count: day.cycleCount || null,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtS = (s) => {
  if (!s || s <= 0) return "—";
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
};
// dispT: seconds by default, mm:ss when asMs=true
const dispT = (v, asMs = false) => {
  if (!v || v <= 0) return "—";
  return asMs ? fmtS(v) : v + "s";
};
const barFill = (v, std, grp) => {
  if (!v || v <= 0) return "#d1d5db";
  if (v > CT)  return grp === "A" ? "#dc2626" : "#f87171";
  if (v > std) return grp === "A" ? "#d97706" : "#f59e0b";
  return grp === "A" ? "#0d9488" : "#2563eb";
};
const opAvg = (days, opKey) => {
  const vals = days.map(d => d.avgs[opKey]).filter(v => v > 0);
  return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
};

// ─── CSV Parsing (GT2K Logger) ─────────────────────────────────────────────────
function parseGT2K(text) {
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":") || !/^\d{4}\/\d{2}\/\d{2}/.test(line)) continue;
    const ci = line.indexOf(",");
    if (ci < 0) continue;
    const [y, mo, dd] = line.slice(0,10).split("/");
    const v = line.slice(ci+1).split(",").map(s => Number(s.trim()));
    const w = {};
    if (v.length > 6) w[1] = v[5]*60 + v[6];
    for (let n=2; n<=20; n++) {
      const b = 9+(n-2)*6;
      if (b+3 < v.length) w[n] = v[b+2]*60 + v[b+3];
    }
    records.push({ date:`${y}-${mo}-${dd}`, w });
  }
  return records;
}
function toDailyAvg(records) {
  const map = {};
  for (const r of records) {
    if (!map[r.date]) map[r.date] = { date:r.date, s:{}, c:{} };
    for (const [k,val] of Object.entries(r.w)) {
      if (val>60 && val<5400) {
        map[r.date].s[k] = (map[r.date].s[k]||0)+val;
        map[r.date].c[k] = (map[r.date].c[k]||0)+1;
      }
    }
  }
  return Object.values(map).map(d => {
    const avgs = {};
    for (const k of Object.keys(d.s)) avgs[k] = Math.round(d.s[k]/d.c[k]);
    const counts = Object.values(d.c);
    const cycleCount = counts.length ? Math.round(counts.reduce((a,b)=>a+b,0)/counts.length) : 0;
    return { date:d.date, avgs, cycleCount };
  }).sort((a,b) => a.date.localeCompare(b.date));
}

// ─── Style tokens ─────────────────────────────────────────────────────────────
const S = {
  TH: { padding:"7px 14px", textAlign:"left", fontWeight:600, fontSize:11,
    borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap", color:"#6b7280",
    background:"#f9fafb", letterSpacing:"0.04em", textTransform:"uppercase" },
  TD: { padding:"7px 14px", fontSize:12.5, borderBottom:"1px solid #f3f4f6" },
  card: { background:"#fff", borderRadius:12, border:"1px solid #e5e7eb", overflow:"hidden" },
  chip: (active, color) => ({
    padding:"5px 16px", fontSize:12, borderRadius:20, cursor:"pointer", border:"none",
    background:active ? color : "#f3f4f6", color:active ? "#fff" : "#6b7280",
    fontWeight:active ? 600 : 400, transition:"all .15s",
  }),
};
const CC = { grid:"#f3f4f6", axis:"#9ca3af" };

// ─── SupabaseSetup ────────────────────────────────────────────────────────────
function SupabaseSetup({ onSave }) {
  const [url, setUrl] = useState("https://bqqprsfgovincwpigfmh.supabase.co");
  const [key, setKey] = useState("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxcXByc2Znb3ZpbmN3cGlnZm1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTA5NjQsImV4cCI6MjA5NTU2Njk2NH0.pd6Rfh1qFcVjZ3fO1aPPl_gihHGt8VGnphNtrACitxM");
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState(null);

  const handleSave = async () => {
    if (!url.trim() || !key.trim()) { setErr("Completa ambos campos"); return; }
    setTesting(true); setErr(null);
    try {
      await sbRequest(url.trim(), key.trim(), "/production_data?select=date&limit=1");
      onSave(url.trim(), key.trim());
    } catch(e) {
      setErr(`No se pudo conectar: ${e.message}`);
    }
    setTesting(false);
  };

  return (
    <div style={{ minHeight:400, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ ...S.card, padding:32, maxWidth:460, width:"100%" }}>
        <div style={{ display:"flex", gap:6, marginBottom:20, alignItems:"center" }}>
          <div style={{ width:10,height:10,borderRadius:"50%",background:"#0d9488" }}/>
          <div style={{ width:10,height:10,borderRadius:"50%",background:"#2563eb" }}/>
          <span style={{ fontSize:15,fontWeight:700,color:"#111827",marginLeft:4 }}>PACE MAKER</span>
        </div>
        <div style={{ fontSize:13,fontWeight:600,color:"#111827",marginBottom:4 }}>Conexión a Supabase</div>
        <div style={{ fontSize:12,color:"#6b7280",marginBottom:20,lineHeight:1.6 }}>
          Ingresa las credenciales de tu proyecto Supabase para habilitar el almacenamiento compartido.
        </div>
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,fontWeight:600,color:"#374151",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.04em" }}>
            URL del proyecto
          </div>
          <input value={url} onChange={e=>setUrl(e.target.value)}
            placeholder="https://xxxxxxxxxxxx.supabase.co"
            style={{ width:"100%",padding:"8px 12px",borderRadius:8,border:"1px solid #d1d5db",fontSize:13,
              fontFamily:"monospace",boxSizing:"border-box",color:"#111827",background:"#fff" }}/>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,fontWeight:600,color:"#374151",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.04em" }}>
            Anon/Public Key
          </div>
          <input value={key} onChange={e=>setKey(e.target.value)} type="password"
            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
            style={{ width:"100%",padding:"8px 12px",borderRadius:8,border:"1px solid #d1d5db",fontSize:12,
              fontFamily:"monospace",boxSizing:"border-box",color:"#111827",background:"#fff" }}/>
        </div>
        {err && (
          <div style={{ background:"#fef2f2",color:"#dc2626",padding:"8px 12px",borderRadius:8,fontSize:12,marginBottom:12 }}>
            {err}
          </div>
        )}
        <button onClick={handleSave} disabled={testing}
          style={{ width:"100%",padding:"10px",background:testing?"#6b7280":"#0d9488",color:"#fff",
            border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:testing?"not-allowed":"pointer" }}>
          {testing ? "Verificando conexión…" : "Conectar y guardar"}
        </button>
        <div style={{ marginTop:12,fontSize:11,color:"#9ca3af",lineHeight:1.6 }}>
          Credenciales en <b>Settings → API</b> de tu proyecto Supabase.
          La anon key es pública por diseño.
        </div>
      </div>
    </div>
  );
}

// ─── DropZone ─────────────────────────────────────────────────────────────────
function DropZone({ label, color, accentLight, statuses, hasData, onFiles, onClear }) {
  const [drag, setDrag] = useState(false);
  const handleDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const files = Array.from(e.dataTransfer.files).filter(f => /\.csv$/i.test(f.name));
    if (files.length) onFiles(files);
  };
  return (
    <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
      onDrop={handleDrop}
      style={{ border:`2px dashed ${drag?color:"#d1d5db"}`,borderRadius:12,padding:18,
        transition:"all .2s",background:drag?accentLight:"#fafafa" }}>
      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
        <div style={{ width:8,height:8,borderRadius:"50%",background:color }}/>
        <span style={{ fontSize:13,fontWeight:600,color:"#374151" }}>{label}</span>
        {hasData && <button onClick={onClear} style={{ marginLeft:"auto",fontSize:11,background:"none",border:"none",cursor:"pointer",color:"#9ca3af",padding:0 }}>Limpiar datos</button>}
      </div>
      <label style={{ display:"flex",alignItems:"center",gap:10,cursor:"pointer" }}>
        <input type="file" accept=".csv,.CSV" multiple style={{ display:"none" }}
          onChange={e=>{
            const files = Array.from(e.target.files);
            if (files.length) { onFiles(files); e.target.value=""; }
          }}/>
        <div style={{ padding:"7px 18px",background:color,color:"#fff",borderRadius:8,fontSize:12.5,fontWeight:600 }}>
          📂 Seleccionar CSV(s)
        </div>
        <span style={{ fontSize:12,color:"#9ca3af" }}>o arrastra varios archivos aquí</span>
      </label>
      {/* Status list for multiple files */}
      {statuses && statuses.length > 0 && (
        <div style={{ marginTop:10,display:"flex",flexDirection:"column",gap:4 }}>
          {statuses.map((s,i) => (
            <div key={i} style={{ fontSize:11.5,
              color:s.startsWith("✅")?"#059669":s.startsWith("⏳")?"#d97706":"#dc2626",
              background:s.startsWith("✅")?"#ecfdf5":s.startsWith("⏳")?"#fffbeb":"#fef2f2",
              padding:"5px 10px",borderRadius:6 }}>{s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── KpiCard ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,
      padding:"14px 16px",borderLeft:`3px solid ${color}` }}>
      <div style={{ fontSize:11,color:"#9ca3af",fontWeight:600,textTransform:"uppercase",
        letterSpacing:"0.05em",marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:22,fontWeight:700,color:"#111827" }}>{value}</div>
      {sub && <div style={{ fontSize:11,color:"#6b7280",marginTop:2 }}>{sub}</div>}
    </div>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────
function EmptyState({ msg="Sube archivos CSV para comenzar" }) {
  return (
    <div style={{ textAlign:"center",padding:"60px 0",color:"#9ca3af" }}>
      <div style={{ fontSize:36,marginBottom:10 }}>📊</div>
      <div style={{ fontSize:14,fontWeight:500 }}>{msg}</div>
    </div>
  );
}

// ─── ExcelStyleChart ──────────────────────────────────────────────────────────
// Matches the Excel chart: bars for avg, green line for std, red line for CT
function ExcelStyleChart({ data, grpKey, grpLabel, barColor, showTable = true }) {
  const [asMs, setAsMs] = useState(false);

  const chartData = data.map(d => ({
    name: d.stationFull || d.op,
    avg: d[grpKey] || 0,
    std: d.std,
    ct: CT,
  }));

  const w = Math.max(820, chartData.length * 68);
  const tickFmt = v => asMs ? fmtS(v) : v + "s";

  return (
    <div>
      {/* Format toggle */}
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:8 }}>
        <button onClick={() => setAsMs(v => !v)} style={{
          padding:"4px 12px", fontSize:11, borderRadius:20, border:"1px solid #d1d5db",
          background: asMs ? "#111827" : "#f9fafb", color: asMs ? "#fff" : "#6b7280",
          cursor:"pointer", fontWeight:600, transition:"all .15s",
        }}>
          {asMs ? "⏱ mm:ss" : "⏱ segundos"} — click para cambiar
        </button>
      </div>

      {/* CT badge shown outside chart */}
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
        <div style={{ width:28, height:3, background:"#b91c1c", borderRadius:2 }}/>
        <span style={{ fontSize:11, color:"#b91c1c", fontWeight:700 }}>
          Cycle time = {dispT(CT, asMs)}
        </span>
        <div style={{ width:28, height:3, background:"#16a34a", borderRadius:2, marginLeft:8 }}/>
        <span style={{ fontSize:11, color:"#16a34a", fontWeight:700 }}>
          Standard time (variable por operación)
        </span>
      </div>

      <div style={{ overflowX:"auto" }}>
        <ComposedChart width={w} height={360} data={chartData}
          margin={{ top:14, right:20, left:10, bottom:60 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CC.grid}/>
          <XAxis dataKey="name"
            tick={{ fontSize:10, fill:CC.axis }}
            angle={-35} textAnchor="end" interval={0} height={70}/>
          <YAxis
            domain={[0, d => Math.ceil(d * 1.15 / 100) * 100]}
            tickFormatter={tickFmt}
            tick={{ fontSize:11, fill:CC.axis }} width={54}/>
          <Tooltip
            formatter={(v, name) => {
              const sec = v + "s";
              const ms  = fmtS(v);
              const both = asMs ? ms : `${sec}  (${ms})`;
              if (name === "avg") return [both, grpLabel];
              if (name === "std") return [both, "Standard time"];
              if (name === "ct")  return [asMs ? ms : sec, "Cycle time"];
              return [v, name];
            }}
            contentStyle={{ background:"#fff", border:"1px solid #e5e7eb", borderRadius:8, fontSize:12 }}/>
          <Legend
            payload={[
              { value: grpLabel,        type:"square", color: barColor },
              { value: "Standard time", type:"line",   color: "#16a34a" },
              { value: "Cycle time",    type:"line",   color: "#b91c1c" },
            ]}
            wrapperStyle={{ fontSize:12, paddingTop:8 }}/>

          {/* Bars — label at bottom inside bar */}
          <Bar dataKey="avg" name="avg" fill={barColor} radius={[2,2,0,0]} maxBarSize={32}>
            <LabelList dataKey="avg"
              position="insideBottom"
              offset={6}
              formatter={v => v > 0 ? dispT(v, asMs) : ""}
              style={{ fontSize:10, fontWeight:700, fill:"#fff" }}/>
          </Bar>

          {/* Line — Standard time: label only on first and last point */}
          <Line type="linear" dataKey="std" name="std"
            stroke="#16a34a" strokeWidth={2.5}
            dot={{ r:4, fill:"#16a34a", stroke:"#fff", strokeWidth:1 }}>
            <LabelList dataKey="std"
              position="top"
              formatter={(v, entry, index) => {
                const total = chartData.length;
                return (index === 0 || index === total - 1) ? dispT(v, asMs) : "";
              }}
              style={{ fontSize:9, fill:"#16a34a", fontWeight:700 }}/>
          </Line>

          {/* Line — Cycle time: NO labels (shown in badge above) */}
          <Line type="linear" dataKey="ct" name="ct"
            stroke="#b91c1c" strokeWidth={2.5}
            dot={false}
            label={false}/>
        </ComposedChart>
      </div>

      {/* Data table below chart — same as Excel "show data table" */}
      {showTable && (
        <div style={{ overflowX:"auto", marginTop:0 }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
            <thead>
              <tr>
                <td style={{ padding:"4px 8px", background:"#f9fafb", fontWeight:700,
                  fontSize:10, color:"#6b7280", border:"1px solid #e5e7eb", minWidth:100 }}/>
                {chartData.map(d => (
                  <td key={d.name} style={{ padding:"4px 6px", background:"#f9fafb",
                    fontSize:10, color:"#374151", border:"1px solid #e5e7eb",
                    textAlign:"center", fontWeight:600, whiteSpace:"nowrap" }}>
                    {d.name}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Row: Real time average */}
              <tr>
                <td style={{ padding:"4px 8px", fontWeight:700, fontSize:10,
                  color: barColor, border:"1px solid #e5e7eb", whiteSpace:"nowrap",
                  background:"#fff" }}>
                  Real time avg
                </td>
                {chartData.map(d => {
                  const c = d.avg > CT ? "#b91c1c" : d.avg > d.std ? "#d97706" : d.avg > 0 ? "#059669" : "#9ca3af";
                  return (
                    <td key={d.name} style={{ padding:"4px 6px", textAlign:"center",
                      border:"1px solid #e5e7eb", color:c, fontWeight:700, background:"#fff" }}>
                      {d.avg > 0 ? dispT(d.avg, asMs) : "—"}
                    </td>
                  );
                })}
              </tr>
              {/* Row: Standard time */}
              <tr>
                <td style={{ padding:"4px 8px", fontWeight:700, fontSize:10,
                  color:"#16a34a", border:"1px solid #e5e7eb", whiteSpace:"nowrap",
                  background:"#fafafa" }}>
                  Standard time
                </td>
                {chartData.map(d => (
                  <td key={d.name} style={{ padding:"4px 6px", textAlign:"center",
                    border:"1px solid #e5e7eb", color:"#16a34a", background:"#fafafa" }}>
                    {dispT(d.std, asMs)}
                  </td>
                ))}
              </tr>
              {/* Row: Cycle time */}
              <tr>
                <td style={{ padding:"4px 8px", fontWeight:700, fontSize:10,
                  color:"#b91c1c", border:"1px solid #e5e7eb", whiteSpace:"nowrap",
                  background:"#fff" }}>
                  Cycle time
                </td>
                {chartData.map(d => (
                  <td key={d.name} style={{ padding:"4px 6px", textAlign:"center",
                    border:"1px solid #e5e7eb", color:"#b91c1c", fontWeight:700,
                    background:"#fff" }}>
                    {dispT(CT, asMs)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── DashChart ────────────────────────────────────────────────────────────────
function DashChart({ data }) {
  const [activeGrp, setActiveGrp] = useState("A");
  const grpLabel = activeGrp === "A" ? "Real time avg — Grupo A" : "Real time avg — Grupo B";
  const barColor = activeGrp === "A" ? "#2563eb" : "#0d9488";
  return (
    <div>
      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
        {[["A","Grupo A — Turno 1","#2563eb"],["B","Grupo B — Turno 2","#0d9488"]].map(([g,l,c])=>(
          <button key={g} onClick={()=>setActiveGrp(g)} style={S.chip(activeGrp===g,c)}>{l}</button>
        ))}
      </div>
      <ExcelStyleChart data={data} grpKey={activeGrp} grpLabel={grpLabel} barColor={barColor}/>
    </div>
  );
}

// ─── MonthlyDetail ────────────────────────────────────────────────────────────
function MonthlyDetail({ month, dataA, dataB }) {
  const [grp,    setGrp]    = useState("A");
  const [showTot, setShowTot] = useState(false); // toggle total-seconds row
  const [asMs,    setAsMs]    = useState(false);  // toggle seconds/mm:ss in table

  const days = (grp==="A"?dataA:dataB).filter(d=>d.date.startsWith(month));
  const mLabel = MONTHS[parseInt(month.split("-")[1])-1]+" "+month.split("-")[0];
  const color  = grp==="A"?"#0d9488":"#2563eb";

  const monthAvg   = OPS.reduce((acc,op)=>{ acc[op.key]=opAvg(days,op.key); return acc; },{});
  const dailyData  = days.map(d=>{
    const vals=OPS.map(op=>d.avgs[op.key]||0).filter(v=>v>0);
    return {date:d.date.slice(5),avg:vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):0};
  });
  const totalCycles = days.reduce((a,d)=>a+(d.cycle_count||0),0);

  // Total seconds per op per day = avg × cycle_count (best approximation from stored data)
  const dayTotals = (d) => {
    const n = d.cycle_count || 0;
    if (!n) return null;
    const t = {};
    OPS.forEach(op => { t[op.key] = d.avgs[op.key] ? d.avgs[op.key] * n : 0; });
    return t;
  };

  // Month totals per op
  const monthTotal = OPS.reduce((acc,op) => {
    acc[op.key] = days.reduce((s,d) => {
      const n = d.cycle_count || 0;
      return s + (d.avgs[op.key] && n ? d.avgs[op.key] * n : 0);
    }, 0);
    return acc;
  }, {});

  const hasCycleCount = days.some(d => d.cycle_count > 0);
  const fmt = v => v > 0 ? dispT(v, asMs) : "—";

  return (
    <div>
      <div style={{ display:"flex",gap:6,marginBottom:16 }}>
        {[["A","Grupo A — Turno 1","#0d9488"],["B","Grupo B — Turno 2","#2563eb"]].map(([g,l,c])=>(
          <button key={g} onClick={()=>setGrp(g)} style={S.chip(grp===g,c)}>{l}</button>
        ))}
      </div>
      {days.length===0 ? <EmptyState msg={`No hay datos de Grupo ${grp} para ${mLabel}`}/> : (
        <>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16 }}>
            <KpiCard label="Días registrados" value={days.length} color={color}/>
            <KpiCard label="Ciclos totales" value={totalCycles||"—"} sub="piezas producidas" color={color}/>
            <KpiCard label="Promedio global" value={fmtS(Math.round(OPS.map(op=>monthAvg[op.key]).filter(v=>v>0).reduce((a,b,_,arr)=>a+b/arr.length,0)))} color={color}/>
            <KpiCard label="Cycle time ref." value={`${CT}s`} sub="14:46" color="#9ca3af"/>
          </div>

          <div style={{ ...S.card,padding:16,marginBottom:14 }}>
            <div style={{ fontSize:13,fontWeight:600,color:"#111827",marginBottom:12 }}>
              Promedio diario — {mLabel}
            </div>
            <div style={{ overflowX:"auto" }}>
              <BarChart width={Math.max(480,days.length*54)} height={200} data={dailyData}
                margin={{ top:8,right:16,left:0,bottom:28 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CC.grid}/>
                <XAxis dataKey="date" tick={{ fontSize:10,fill:CC.axis }} angle={-30} textAnchor="end" height={36}/>
                <YAxis tickFormatter={fmtS} tick={{ fontSize:10,fill:CC.axis }} width={54}/>
                <Tooltip formatter={v=>[fmtS(v),"Promedio del día"]}
                  contentStyle={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,fontSize:12 }}/>
                <ReferenceLine y={CT} stroke="#b91c1c" strokeDasharray="5 3" strokeWidth={1.5}/>
                <Bar dataKey="avg" radius={[4,4,0,0]}>
                  {dailyData.map((e,i)=><Cell key={i} fill={e.avg>CT?"#dc2626":e.avg>840?"#d97706":color}/>)}
                </Bar>
              </BarChart>
            </div>
          </div>

          <div style={{ ...S.card,padding:16,marginBottom:14 }}>
            <div style={{ fontSize:13,fontWeight:600,color:"#111827",marginBottom:12 }}>
              Promedio mensual por operación — {mLabel} · Grupo {grp}
            </div>
            <ExcelStyleChart
              data={OPS.map(op=>({ op:op.label, stationFull:op.stationFull, A:grp==="A"?monthAvg[op.key]||0:0, B:grp==="B"?monthAvg[op.key]||0:0, std:op.std }))}
              grpKey={grp}
              grpLabel={`Real time avg — Grupo ${grp}`}
              barColor={grp==="A"?"#2563eb":"#0d9488"}
            />
          </div>

          {/* ── Daily detail table ── */}
          <div style={S.card}>
            {/* Table header toolbar */}
            <div style={{ padding:"12px 16px", borderBottom:"1px solid #e5e7eb",
              display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <span style={{ fontSize:13,fontWeight:600,color:"#111827" }}>
                Detalle diario — {mLabel}
              </span>
              <span style={{ fontSize:11,fontWeight:400,color:"#9ca3af" }}>
                🟢 bajo std · 🟡 sobre std · 🔴 sobre CT
              </span>
              <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
                {/* Seconds total toggle — only show if cycle_count data exists */}
                {hasCycleCount && (
                  <button onClick={()=>setShowTot(v=>!v)} style={{
                    padding:"4px 12px", fontSize:11, borderRadius:20,
                    border:"1px solid #d1d5db", cursor:"pointer", fontWeight:600,
                    background: showTot ? "#7c3aed" : "#f9fafb",
                    color: showTot ? "#fff" : "#6b7280",
                    transition:"all .15s",
                  }}>
                    {showTot ? "✕ Ocultar totales" : "Σ Mostrar seg. totales"}
                  </button>
                )}
                {/* mm:ss toggle */}
                <button onClick={()=>setAsMs(v=>!v)} style={{
                  padding:"4px 12px", fontSize:11, borderRadius:20,
                  border:"1px solid #d1d5db", cursor:"pointer", fontWeight:600,
                  background: asMs ? "#111827" : "#f9fafb",
                  color: asMs ? "#fff" : "#6b7280",
                  transition:"all .15s",
                }}>
                  {asMs ? "⏱ mm:ss" : "⏱ segundos"}
                </button>
              </div>
            </div>

            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%",borderCollapse:"collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...S.TH,position:"sticky",left:0,zIndex:2 }}>Fecha</th>
                    {OPS.map(op=><th key={op.key} style={S.TH}>{op.label}</th>)}
                  </tr>
                  <tr>
                    <th style={{ ...S.TH,fontSize:10,color:"#9ca3af",position:"sticky",left:0,zIndex:2,fontStyle:"italic" }}>
                      Std →
                    </th>
                    {OPS.map(op=>(
                      <th key={op.key} style={{ ...S.TH,fontSize:10,color:"#9ca3af",fontStyle:"italic" }}>
                        {fmt(op.std)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days.map((d,i)=>{
                    const bg = i%2===0?"#fff":"#fafafa";
                    const tot = showTot ? dayTotals(d) : null;
                    return (
                      <Fragment key={d.date}>
                        {/* ── Average row ── */}
                        <tr style={{ background:bg }}>
                          <td style={{ ...S.TD,fontWeight:600,color:"#374151",position:"sticky",left:0,background:bg,
                            borderBottom: showTot && tot ? "none" : undefined }}>
                            {d.date.slice(5)}
                            {d.cycle_count > 0 && (
                              <div style={{ fontSize:10,color:"#9ca3af",fontWeight:400 }}>
                                n={d.cycle_count}
                              </div>
                            )}
                          </td>
                          {OPS.map(op=>{
                            const v=d.avgs[op.key]||0;
                            const c=v>CT?"#b91c1c":v>op.std?"#d97706":v>0?"#059669":"#d1d5db";
                            return (
                              <td key={op.key} style={{ ...S.TD,color:c,fontWeight:v>CT?700:400,
                                borderBottom: showTot && tot ? "none" : undefined }}>
                                {fmt(v)}
                              </td>
                            );
                          })}
                        </tr>
                        {/* ── Total seconds sub-row ── */}
                        {showTot && tot && (
                          <tr style={{ background: i%2===0?"#faf5ff":"#f5f0ff" }}>
                            <td style={{ ...S.TD,fontSize:10,color:"#7c3aed",fontStyle:"italic",
                              fontWeight:600,position:"sticky",left:0,
                              background:i%2===0?"#faf5ff":"#f5f0ff",paddingTop:2,paddingBottom:4 }}>
                              Σ total
                            </td>
                            {OPS.map(op=>{
                              const tv = tot[op.key] || 0;
                              return (
                                <td key={op.key} style={{ ...S.TD,fontSize:10,color:"#7c3aed",
                                  fontStyle:"italic",paddingTop:2,paddingBottom:4 }}>
                                  {tv > 0 ? dispT(tv, asMs) : "—"}
                                </td>
                              );
                            })}
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}

                  {/* ── Monthly average row ── */}
                  <tr style={{ background:"#f0fdf4",borderTop:"2px solid #d1fae5" }}>
                    <td style={{ ...S.TD,fontWeight:700,color:"#059669",position:"sticky",left:0,background:"#f0fdf4" }}>
                      Prom.
                    </td>
                    {OPS.map(op=>{
                      const v=monthAvg[op.key]||0;
                      const c=v>CT?"#b91c1c":v>op.std?"#d97706":v>0?"#059669":"#d1d5db";
                      return <td key={op.key} style={{ ...S.TD,fontWeight:700,color:c }}>{fmt(v)}</td>;
                    })}
                  </tr>

                  {/* ── Monthly total seconds row (only if showTot & data exists) ── */}
                  {showTot && hasCycleCount && (
                    <tr style={{ background:"#ede9fe",borderTop:"1px solid #ddd6fe" }}>
                      <td style={{ ...S.TD,fontWeight:700,color:"#7c3aed",fontSize:11,
                        position:"sticky",left:0,background:"#ede9fe" }}>
                        Σ mes
                      </td>
                      {OPS.map(op=>{
                        const tv = monthTotal[op.key] || 0;
                        return (
                          <td key={op.key} style={{ ...S.TD,fontSize:11,color:"#7c3aed",fontWeight:700 }}>
                            {tv > 0 ? dispT(tv, asMs) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  )}

                  {/* ── Std row ── */}
                  <tr style={{ background:"#f9fafb" }}>
                    <td style={{ ...S.TD,fontWeight:600,color:"#9ca3af",fontSize:11,position:"sticky",left:0,background:"#f9fafb" }}>
                      Std.
                    </td>
                    {OPS.map(op=><td key={op.key} style={{ ...S.TD,color:"#16a34a",fontSize:11 }}>{fmt(op.std)}</td>)}
                  </tr>

                  {/* ── CT row ── */}
                  <tr style={{ background:"#fef2f2" }}>
                    <td style={{ ...S.TD,fontWeight:600,color:"#b91c1c",fontSize:11,position:"sticky",left:0,background:"#fef2f2" }}>
                      CT
                    </td>
                    {OPS.map(op=><td key={op.key} style={{ ...S.TD,color:"#b91c1c",fontSize:11 }}>{fmt(CT)}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Historial ────────────────────────────────────────────────────────────────
function Historial({ dataA, dataB }) {
  const [expandedMonth, setExpanded] = useState(null);
  if (!dataA.length && !dataB.length) return <EmptyState/>;
  const months = [...new Set([...dataA,...dataB].map(d=>d.date.slice(0,7)))].sort();
  const summary = months.map(m => {
    const dA=dataA.filter(d=>d.date.startsWith(m));
    const dB=dataB.filter(d=>d.date.startsWith(m));
    const avgsA=OPS.map(op=>opAvg(dA,op.key)).filter(v=>v>0);
    const avgsB=OPS.map(op=>opAvg(dB,op.key)).filter(v=>v>0);
    return {
      m, label:MONTHS[parseInt(m.split("-")[1])-1]+" "+m.split("-")[0],
      short:MONTHS[parseInt(m.split("-")[1])-1].slice(0,3)+"'"+m.slice(2,4),
      avgA:avgsA.length?Math.round(avgsA.reduce((a,b)=>a+b,0)/avgsA.length):0,
      avgB:avgsB.length?Math.round(avgsB.reduce((a,b)=>a+b,0)/avgsB.length):0,
      daysA:dA.length, daysB:dB.length,
      cyclesA:dA.reduce((a,d)=>a+(d.cycle_count||0),0),
      cyclesB:dB.reduce((a,d)=>a+(d.cycle_count||0),0),
      opDetails:OPS.map(op=>({ op:op.label,std:op.std,A:opAvg(dA,op.key),B:opAvg(dB,op.key) })),
    };
  });

  return (
    <div>
      <div style={{ ...S.card,padding:16,marginBottom:16 }}>
        <div style={{ fontSize:13,fontWeight:600,color:"#111827",marginBottom:12 }}>
          Tendencia mensual — promedio global de operaciones
        </div>
        <div style={{ overflowX:"auto" }}>
          <BarChart width={Math.max(500,months.length*100)} height={240}
            data={summary.map(s=>({mes:s.short,A:s.avgA,B:s.avgB}))}
            margin={{ top:10,right:20,left:0,bottom:10 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CC.grid}/>
            <XAxis dataKey="mes" tick={{ fontSize:11,fill:CC.axis }}/>
            <YAxis tickFormatter={fmtS} tick={{ fontSize:11,fill:CC.axis }} width={54}/>
            <Tooltip formatter={(v,n)=>[fmtS(v),n==="A"?"Grupo A":"Grupo B"]}
              contentStyle={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,fontSize:12 }}/>
            <Legend formatter={v=>v==="A"?"Grupo A (Turno 1)":"Grupo B (Turno 2)"} wrapperStyle={{ fontSize:12 }}/>
            <ReferenceLine y={CT} stroke="#b91c1c" strokeDasharray="5 3" strokeWidth={1.5}
              label={{ value:"CT",position:"insideTopRight",fontSize:10,fill:"#b91c1c" }}/>
            <Bar dataKey="A" fill="#0d9488" name="A" radius={[4,4,0,0]} maxBarSize={36}/>
            <Bar dataKey="B" fill="#2563eb" name="B" radius={[4,4,0,0]} maxBarSize={36}/>
          </BarChart>
        </div>
      </div>

      <div style={S.card}>
        <div style={{ padding:"12px 16px",fontSize:13,fontWeight:600,color:"#111827",borderBottom:"1px solid #e5e7eb" }}>
          Historial mensual completo — clic en fila para expandir
        </div>
        <table style={{ width:"100%",borderCollapse:"collapse" }}>
          <thead>
            <tr>
              {["","Mes","Días A","Días B","Ciclos A","Ciclos B","Prom. A","Prom. B","Δ CT (A)","Δ CT (B)"].map(h=>(
                <th key={h} style={S.TH}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.map((s,i)=>{
              const isExp=expandedMonth===s.m;
              return (
                <Fragment key={s.m}>
                  <tr onClick={()=>setExpanded(isExp?null:s.m)}
                    style={{ background:isExp?"#f0fdf4":i%2===0?"#fff":"#fafafa",cursor:"pointer" }}>
                    <td style={{ ...S.TD,width:28,paddingRight:0 }}>
                      <span style={{ fontSize:10,color:"#9ca3af" }}>{isExp?"▼":"▶"}</span>
                    </td>
                    <td style={{ ...S.TD,fontWeight:600,color:"#111827" }}>{s.label}</td>
                    <td style={S.TD}>{s.daysA||"—"}</td>
                    <td style={S.TD}>{s.daysB||"—"}</td>
                    <td style={S.TD}>{s.cyclesA||"—"}</td>
                    <td style={S.TD}>{s.cyclesB||"—"}</td>
                    <td style={{ ...S.TD,color:s.avgA>CT?"#dc2626":s.avgA>840?"#d97706":"#059669",fontWeight:600 }}>{fmtS(s.avgA)}</td>
                    <td style={{ ...S.TD,color:s.avgB>CT?"#dc2626":s.avgB>840?"#d97706":"#2563eb",fontWeight:600 }}>{fmtS(s.avgB)}</td>
                    <td style={{ ...S.TD,fontSize:12,color:s.avgA?(s.avgA-CT>0?"#dc2626":"#059669"):"#9ca3af" }}>
                      {s.avgA?`${s.avgA-CT>0?"+":""}${s.avgA-CT}s`:"—"}
                    </td>
                    <td style={{ ...S.TD,fontSize:12,color:s.avgB?(s.avgB-CT>0?"#dc2626":"#059669"):"#9ca3af" }}>
                      {s.avgB?`${s.avgB-CT>0?"+":""}${s.avgB-CT}s`:"—"}
                    </td>
                  </tr>
                  {isExp && (
                    <tr key={`${s.m}-detail`}>
                      <td colSpan={10} style={{ padding:0,background:"#f8fafc" }}>
                        <div style={{ padding:"12px 20px 16px" }}>
                          <div style={{ fontSize:12,fontWeight:600,color:"#374151",marginBottom:8 }}>
                            Detalle por operación — {s.label}
                          </div>
                          <div style={{ overflowX:"auto" }}>
                            <table style={{ width:"100%",borderCollapse:"collapse" }}>
                              <thead>
                                <tr>{["Op","Estación","Grupo A","Grupo B","Promedio","Std.","Δ vs Std."].map(h=>(
                                  <th key={h} style={{ ...S.TH,fontSize:10,background:"#f1f5f9" }}>{h}</th>
                                ))}</tr>
                              </thead>
                              <tbody>
                                {s.opDetails.map((op,oi)=>{
                                  const comb=op.A&&op.B?Math.round((op.A+op.B)/2):(op.A||op.B);
                                  const diff=comb?comb-op.std:null;
                                  return (
                                    <tr key={op.op} style={{ background:oi%2===0?"#fff":"#f9fafb" }}>
                                      <td style={{ ...S.TD,fontWeight:600,fontSize:11 }}>{op.op}</td>
                                      <td style={{ ...S.TD,color:"#6b7280",fontSize:10 }}>{OPS.find(o=>o.label===op.op)?.stationFull}</td>
                                      <td style={{ ...S.TD,color:barFill(op.A,op.std,"A"),fontWeight:500 }}>{fmtS(op.A)}</td>
                                      <td style={{ ...S.TD,color:barFill(op.B,op.std,"B"),fontWeight:500 }}>{fmtS(op.B)}</td>
                                      <td style={{ ...S.TD,fontWeight:700 }}>{fmtS(comb)}</td>
                                      <td style={{ ...S.TD,color:"#9ca3af" }}>{fmtS(op.std)}</td>
                                      <td style={{ ...S.TD,color:diff===null?"#9ca3af":diff>0?"#dc2626":"#059669",fontWeight:600 }}>
                                        {diff===null?"—":`${diff>0?"+":""}${diff}s`}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── FileManager ─────────────────────────────────────────────────────────────
function FileManager({ sbCreds, onReprocess }) {
  const [files, setFiles]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDel]    = useState(null);
  const [reloading, setRelo]  = useState(null);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const meta = await sbLoadFileMeta(sbCreds.url, sbCreds.key);
      setFiles(meta || []);
    } catch(e) {
      console.error("FileManager load error:", e);
    }
    setLoading(false);
  };

  useEffect(() => { loadFiles(); }, []);

  const handleDownload = async (f) => {
    try {
      const text = await sbDownloadFile(sbCreds.url, sbCreds.key, f.file_path);
      const blob = new Blob([text], { type:"text/csv" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = f.filename; a.click();
      URL.revokeObjectURL(url);
    } catch(e) { alert("Error al descargar: " + e.message); }
  };

  const handleDelete = async (f) => {
    if (!confirm(`¿Eliminar "${f.filename}" del almacenamiento?`)) return;
    setDel(f.id);
    try {
      await sbDeleteFile(sbCreds.url, sbCreds.key, f.file_path);
      await sbRequest(sbCreds.url, sbCreds.key, `/csv_files?id=eq.${f.id}`, "DELETE");
      await loadFiles();
    } catch(e) { alert("Error al eliminar: " + e.message); }
    setDel(null);
  };

  const handleReprocess = async (f) => {
    setRelo(f.id);
    try {
      const text = await sbDownloadFile(sbCreds.url, sbCreds.key, f.file_path);
      await onReprocess(text, f.turno, f.filename);
    } catch(e) { alert("Error al reprocesar: " + e.message); }
    setRelo(null);
  };

  const filesA = files.filter(f => f.turno === "A");
  const filesB = files.filter(f => f.turno === "B");

  const FileTable = ({ rows, color }) => (
    <table style={{ width:"100%", borderCollapse:"collapse" }}>
      <thead>
        <tr>
          {["Archivo","Fecha desde","Fecha hasta","Ciclos","Días","Subido","Acciones"].map(h => (
            <th key={h} style={S.TH}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={7} style={{ ...S.TD,textAlign:"center",color:"#9ca3af",padding:20 }}>
            Sin archivos almacenados
          </td></tr>
        ) : rows.map((f,i) => (
          <tr key={f.id} style={{ background:i%2===0?"#fff":"#fafafa" }}>
            <td style={{ ...S.TD,fontWeight:600,fontSize:12,maxWidth:200 }}>
              <div style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}
                title={f.filename}>
                📄 {f.filename}
              </div>
            </td>
            <td style={{ ...S.TD,fontSize:11,color:"#6b7280" }}>{f.date_from || "—"}</td>
            <td style={{ ...S.TD,fontSize:11,color:"#6b7280" }}>{f.date_to   || "—"}</td>
            <td style={{ ...S.TD,fontSize:12 }}>{f.records_count || "—"}</td>
            <td style={{ ...S.TD,fontSize:12 }}>{f.days_count || "—"}</td>
            <td style={{ ...S.TD,fontSize:11,color:"#9ca3af" }}>
              {new Date(f.uploaded_at).toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"2-digit"})}
            </td>
            <td style={{ ...S.TD }}>
              <div style={{ display:"flex",gap:6 }}>
                <button onClick={()=>handleReprocess(f)} disabled={reloading===f.id}
                  title="Reprocesar y actualizar datos"
                  style={{ padding:"3px 10px",fontSize:11,borderRadius:6,border:`1px solid ${color}`,
                    color,background:"transparent",cursor:"pointer",fontWeight:600 }}>
                  {reloading===f.id?"…":"↺ Proc."}
                </button>
                <button onClick={()=>handleDownload(f)}
                  title="Descargar CSV original"
                  style={{ padding:"3px 10px",fontSize:11,borderRadius:6,border:"1px solid #d1d5db",
                    color:"#374151",background:"transparent",cursor:"pointer" }}>
                  ↓
                </button>
                <button onClick={()=>handleDelete(f)} disabled={deleting===f.id}
                  title="Eliminar del almacenamiento"
                  style={{ padding:"3px 10px",fontSize:11,borderRadius:6,border:"1px solid #fca5a5",
                    color:"#dc2626",background:"transparent",cursor:"pointer" }}>
                  {deleting===f.id?"…":"✕"}
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div>
      <div style={{ display:"flex",alignItems:"center",marginBottom:16,gap:10 }}>
        <div style={{ fontSize:13,fontWeight:600,color:"#111827" }}>Archivos CSV almacenados</div>
        <button onClick={loadFiles} disabled={loading}
          style={{ fontSize:11,padding:"4px 12px",borderRadius:20,border:"1px solid #d1d5db",
            background:"#fff",cursor:"pointer",color:"#6b7280" }}>
          {loading ? "Cargando…" : "↻ Actualizar"}
        </button>
        <div style={{ marginLeft:"auto",fontSize:11,color:"#9ca3af" }}>
          {files.length} archivo(s) · {filesA.length} Grupo A · {filesB.length} Grupo B
        </div>
      </div>

      <div style={{ ...S.card,marginBottom:14 }}>
        <div style={{ padding:"10px 16px",background:"#f0fdfa",borderBottom:"1px solid #d1fae5",
          fontSize:12,fontWeight:700,color:"#0d9488" }}>
          ● Grupo A — Turno 1 ({filesA.length} archivos)
        </div>
        <div style={{ overflowX:"auto" }}><FileTable rows={filesA} color="#0d9488"/></div>
      </div>

      <div style={S.card}>
        <div style={{ padding:"10px 16px",background:"#eff6ff",borderBottom:"1px solid #bfdbfe",
          fontSize:12,fontWeight:700,color:"#2563eb" }}>
          ● Grupo B — Turno 2 ({filesB.length} archivos)
        </div>
        <div style={{ overflowX:"auto" }}><FileTable rows={filesB} color="#2563eb"/></div>
      </div>

      <div style={{ marginTop:10,fontSize:11,color:"#9ca3af",lineHeight:1.6 }}>
        Los archivos CSV se almacenan en Supabase Storage (bucket <code>csv-files</code>).
        Puedes reprocesarlos en cualquier momento para actualizar los promedios en la base de datos.
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const SB_URL = "https://bqqprsfgovincwpigfmh.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxcXByc2Znb3ZpbmN3cGlnZm1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTA5NjQsImV4cCI6MjA5NTU2Njk2NH0.pd6Rfh1qFcVjZ3fO1aPPl_gihHGt8VGnphNtrACitxM";
  const [sbCreds, setSbCreds]   = useState({ url: SB_URL, key: SB_KEY });
  const [tab, setTab]           = useState("dashboard");
  const [dataA, setDataA]       = useState([]);
  const [dataB, setDataB]       = useState([]);
  const [filterMonth, setFM]    = useState("Todos");
  const [detailMonth, setDM]    = useState("");
  const [status, setStatus]     = useState({ A:[], B:[] });
  const [loading, setLoading]   = useState(false);
  const [dbLoading, setDbLoad]  = useState(false);
  const [showUpload, setShowUp] = useState(true);
  const [connStatus, setConn]   = useState("idle");



  // Load data from Supabase when credentials are set
  useEffect(() => {
    if (!sbCreds) return;
    (async () => {
      setDbLoad(true); setConn("connecting");
      try {
        const [rowsA, rowsB] = await Promise.all([
          sbLoad(sbCreds.url, sbCreds.key, "A"),
          sbLoad(sbCreds.url, sbCreds.key, "B"),
        ]);
        setDataA(rowsA.map(rowToDay));
        setDataB(rowsB.map(rowToDay));
        setConn("connected");
      } catch(e) {
        setConn("error");
        console.error("Supabase load error:", e);
      }
      setDbLoad(false);
    })();
  }, [sbCreds]);



  // Process text content directly (used by FileManager reprocess)
  const processCSVText = useCallback(async (text, grp, filename) => {
    const records = parseGT2K(text);
    if (!records.length) throw new Error("No se encontraron registros válidos");
    const daily = toDailyAvg(records);
    const rows = daily.map(d => dayToRow(d, grp));
    await sbUpsert(sbCreds.url, sbCreds.key, rows);
    const fresh = await sbLoad(sbCreds.url, sbCreds.key, grp);
    const converted = fresh.map(rowToDay);
    if (grp==="A") setDataA(converted); else setDataB(converted);
    return { records: records.length, days: daily.length, daily };
  }, [sbCreds]);

  const handleFiles = useCallback(async (files, grp) => {
    if (!sbCreds) return;
    setLoading(true);
    // Initialize statuses as pending
    setStatus(s => ({ ...s, [grp]: files.map(f => `⏳ ${f.name} — procesando…`) }));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await file.text();
        const { records, days, daily } = await processCSVText(text, grp, file.name);

        // Upload raw CSV to Supabase Storage
        const ts = new Date().toISOString().slice(0,10);
        const path = `${grp}/${ts}_${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
        try {
          await sbUploadFile(sbCreds.url, sbCreds.key, path, text);
          // Save metadata
          const dates = daily.map(d => d.date).sort();
          await sbSaveFileMeta(sbCreds.url, sbCreds.key, {
            filename: file.name,
            turno: grp,
            file_path: path,
            records_count: records,
            days_count: days,
            date_from: dates[0] || null,
            date_to: dates[dates.length-1] || null,
          });
        } catch(storErr) {
          console.warn("Storage upload failed (bucket may not exist):", storErr.message);
        }

        setStatus(s => {
          const arr = [...(s[grp] || [])];
          arr[i] = `✅ ${file.name} — ${records} ciclos · ${days} días`;
          return { ...s, [grp]: arr };
        });
      } catch(e) {
        setStatus(s => {
          const arr = [...(s[grp] || [])];
          arr[i] = `❌ ${file.name} — ${e.message}`;
          return { ...s, [grp]: arr };
        });
      }
    }
    setLoading(false);
  }, [sbCreds, processCSVText]);

  const handleClear = async (grp) => {
    if (!sbCreds) return;
    try {
      await sbRequest(sbCreds.url, sbCreds.key,
        `/production_data?turno=eq.${grp}`, "DELETE");
      if (grp==="A") setDataA([]); else setDataB([]);
      setStatus(s=>({...s,[grp]:null}));
    } catch(e) {
      alert(`Error al limpiar: ${e.message}`);
    }
  };

  const allMonths = [...new Set([...dataA,...dataB].map(d=>d.date.slice(0,7)))].sort();
  const filterData = (data, m) => m==="Todos"?data:data.filter(d=>d.date.startsWith(m));
  const hasAny = dataA.length||dataB.length;
  const mLabel = filterMonth==="Todos"?"Todos los meses"
    :MONTHS[parseInt(filterMonth.split("-")[1])-1]+" "+filterMonth.split("-")[0];

  const dashData = OPS.map(op=>{
    const A=opAvg(filterData(dataA,filterMonth),op.key);
    const B=opAvg(filterData(dataB,filterMonth),op.key);
    const combined=A&&B?Math.round((A+B)/2):A||B;
    return { op:op.label,stationFull:op.stationFull,A,B,combined,std:op.std };
  });
  const validA=dashData.filter(d=>d.A>0);
  const validB=dashData.filter(d=>d.B>0);
  const globalAvgA=validA.length?Math.round(validA.reduce((s,d)=>s+d.A,0)/validA.length):0;
  const globalAvgB=validB.length?Math.round(validB.reduce((s,d)=>s+d.B,0)/validB.length):0;
  const overCT_A=validA.filter(d=>d.A>CT).length;
  const overCT_B=validB.filter(d=>d.B>CT).length;

  const connDot = { connected:"#10b981", connecting:"#f59e0b", error:"#b91c1c", idle:"#9ca3af" }[connStatus];
  const connLabel = { connected:"Conectado", connecting:"Cargando…", error:"Error de conexión", idle:"" }[connStatus];

  return (
    <div style={{ fontFamily:"'DM Sans','Segoe UI',sans-serif",background:"#f8fafc",minHeight:"100vh",color:"#111827" }}>
      {/* Header */}
      <div style={{ background:"#fff",borderBottom:"1px solid #e5e7eb",position:"sticky",top:0,zIndex:10 }}>
        <div style={{ padding:"0 20px" }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,padding:"14px 0 10px" }}>
            <div style={{ display:"flex",gap:3 }}>
              <div style={{ width:8,height:8,borderRadius:"50%",background:"#0d9488" }}/>
              <div style={{ width:8,height:8,borderRadius:"50%",background:"#2563eb" }}/>
            </div>
            <span style={{ fontSize:15,fontWeight:700,color:"#111827",letterSpacing:"-0.01em" }}>PACE MAKER</span>
            <span style={{ fontSize:12,color:"#9ca3af",marginLeft:2 }}>Control de Producción</span>
            <div style={{ marginLeft:"auto",display:"flex",alignItems:"center",gap:8 }}>
              {(loading||dbLoading) && <span style={{ fontSize:12,color:"#6b7280",background:"#f3f4f6",padding:"3px 10px",borderRadius:20 }}>⏳ {dbLoading?"Cargando datos…":"Procesando…"}</span>}
              <div style={{ display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#6b7280" }}>
                <div style={{ width:7,height:7,borderRadius:"50%",background:connDot }}/>
                {connLabel}
              </div>
              <button onClick={()=>{ window.location.reload(); }}
                style={{ fontSize:11,background:"none",border:"none",cursor:"pointer",color:"#9ca3af",padding:"2px 6px" }}>
                Recargar
              </button>
            </div>
          </div>
          <div style={{ display:"flex",gap:0 }}>
            {[["dashboard","📊  Dashboard"],["mensual","📅  Por Mes"],["historial","🗂  Historial"],["archivos","📁  Archivos"]].map(([k,l])=>(
              <button key={k} onClick={()=>setTab(k)} style={{
                padding:"8px 20px",fontSize:13,border:"none",cursor:"pointer",background:"transparent",
                color:tab===k?"#0d9488":"#6b7280",fontWeight:tab===k?700:400,
                borderBottom:tab===k?"2.5px solid #0d9488":"2.5px solid transparent",
                transition:"all .15s",
              }}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding:"16px 20px",maxWidth:1200,margin:"0 auto" }}>
        {/* Upload panel */}
        <div style={{ ...S.card,marginBottom:16 }}>
          <button onClick={()=>setShowUp(v=>!v)} style={{
            width:"100%",padding:"12px 16px",background:"transparent",border:"none",
            cursor:"pointer",display:"flex",alignItems:"center",gap:8,
            color:"#374151",fontSize:13,fontWeight:600,textAlign:"left",
          }}>
            <i className={`ti ti-${showUpload?"chevron-down":"chevron-right"}`} aria-hidden="true" style={{ color:"#9ca3af" }}/>
            Cargar archivos CSV del GT2K Logger
            <div style={{ marginLeft:"auto",display:"flex",gap:14,fontSize:12,fontWeight:400 }}>
              {dataA.length>0 && <span style={{ color:"#0d9488",background:"#f0fdfa",padding:"2px 8px",borderRadius:10 }}>● A: {dataA.length} días</span>}
              {dataB.length>0 && <span style={{ color:"#2563eb",background:"#eff6ff",padding:"2px 8px",borderRadius:10 }}>● B: {dataB.length} días</span>}
              {!dataA.length&&!dataB.length&&<span style={{ color:"#9ca3af" }}>Sin datos en BD</span>}
            </div>
          </button>
          {showUpload && (
            <div style={{ padding:"0 16px 16px",borderTop:"1px solid #f3f4f6" }}>
              <div style={{ paddingTop:14,display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
                <DropZone label="Grupo A — Turno 1" color="#0d9488" accentLight="#f0fdfa"
                  statuses={status.A} hasData={dataA.length>0}
                  onFiles={fs=>handleFiles(fs,"A")} onClear={()=>handleClear("A")}/>
                <DropZone label="Grupo B — Turno 2" color="#2563eb" accentLight="#eff6ff"
                  statuses={status.B} hasData={dataB.length>0}
                  onFiles={fs=>handleFiles(fs,"B")} onClear={()=>handleClear("B")}/>
              </div>
              <div style={{ marginTop:10,fontSize:11,color:"#9ca3af" }}>
                Los datos se guardan en Supabase y son accesibles desde cualquier dispositivo conectado.
              </div>
            </div>
          )}
        </div>

        {/* DASHBOARD */}
        {tab==="dashboard" && (
          <div>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:16 }}>
              <span style={{ fontSize:12,color:"#6b7280",fontWeight:500 }}>Mes:</span>
              <select value={filterMonth} onChange={e=>setFM(e.target.value)}
                style={{ padding:"6px 12px",borderRadius:8,border:"1px solid #d1d5db",fontSize:13,background:"#fff",color:"#111827",fontFamily:"inherit" }}>
                <option value="Todos">Todos los meses</option>
                {allMonths.map(m=><option key={m} value={m}>{MONTHS[parseInt(m.split("-")[1])-1]} {m.split("-")[0]}</option>)}
              </select>
              <span style={{ fontSize:13,fontWeight:600,color:"#374151" }}>{mLabel}</span>
            </div>
            {hasAny ? (
              <>
                <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16 }}>
                  <KpiCard label="Prom. global Grupo A" value={fmtS(globalAvgA)} sub={`vs CT: ${globalAvgA?globalAvgA-CT+"s":"—"}`} color="#0d9488"/>
                  <KpiCard label="Prom. global Grupo B" value={fmtS(globalAvgB)} sub={`vs CT: ${globalAvgB?globalAvgB-CT+"s":"—"}`} color="#2563eb"/>
                  <KpiCard label="Ops sobre CT · Grp A" value={overCT_A} sub={`de ${validA.length} operaciones`} color={overCT_A>0?"#b91c1c":"#059669"}/>
                  <KpiCard label="Ops sobre CT · Grp B" value={overCT_B} sub={`de ${validB.length} operaciones`} color={overCT_B>0?"#b91c1c":"#059669"}/>
                </div>
                <div style={{ ...S.card,padding:16,marginBottom:14 }}>
                  <div style={{ fontSize:13,fontWeight:600,color:"#111827",marginBottom:4 }}>
                    PACEMAKER DATA — Tiempo promedio por operación
                  </div>
                  <div style={{ fontSize:11,color:"#9ca3af",marginBottom:12 }}>
                    {mLabel} · 🟢 bajo std &nbsp; 🟡 sobre std &nbsp; 🔴 sobre cycle time
                  </div>
                  <DashChart data={dashData}/>
                </div>
                <div style={S.card}>
                  <div style={{ padding:"12px 16px",fontSize:13,fontWeight:600,color:"#111827",borderBottom:"1px solid #e5e7eb" }}>
                    Tabla de KPIs — {mLabel}
                  </div>
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%",borderCollapse:"collapse" }}>
                      <thead>
                        <tr>{["Op","Estación","Grupo A","Grupo B","Promedio","Std.","CT","Δ vs Std."].map(h=>(
                          <th key={h} style={S.TH}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {dashData.map((row,i)=>{
                          const diff=row.combined>0?row.combined-row.std:null;
                          return (
                            <tr key={row.op} style={{ background:i%2===0?"#fff":"#fafafa" }}>
                              <td style={{ ...S.TD,fontWeight:700 }}>{row.op}</td>
                              <td style={{ ...S.TD,fontSize:11,color:"#6b7280" }}>{row.stationFull}</td>
                              <td style={{ ...S.TD,color:barFill(row.A,row.std,"A"),fontWeight:row.A>CT?700:500 }}>{fmtS(row.A)}</td>
                              <td style={{ ...S.TD,color:barFill(row.B,row.std,"B"),fontWeight:row.B>CT?700:500 }}>{fmtS(row.B)}</td>
                              <td style={{ ...S.TD,fontWeight:700,color:"#111827" }}>{fmtS(row.combined)}</td>
                              <td style={{ ...S.TD,color:"#6b7280" }}>{fmtS(row.std)}</td>
                              <td style={{ ...S.TD,color:"#9ca3af" }}>{fmtS(CT)}</td>
                              <td style={{ ...S.TD,fontWeight:700,color:diff===null?"#9ca3af":diff>0?"#dc2626":"#059669" }}>
                                {diff===null?"—":`${diff>0?"+":""}${diff}s`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : <EmptyState/>}
          </div>
        )}

        {/* POR MES */}
        {tab==="mensual" && (
          <div>
            <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:16 }}>
              <select value={detailMonth} onChange={e=>setDM(e.target.value)}
                style={{ padding:"6px 12px",borderRadius:8,border:"1px solid #d1d5db",fontSize:13,background:"#fff",color:"#111827",fontFamily:"inherit" }}>
                <option value="">— Selecciona un mes —</option>
                {allMonths.map(m=><option key={m} value={m}>{MONTHS[parseInt(m.split("-")[1])-1]} {m.split("-")[0]}</option>)}
              </select>
            </div>
            {detailMonth
              ? <MonthlyDetail month={detailMonth} dataA={dataA} dataB={dataB}/>
              : <EmptyState msg="Selecciona un mes para ver el detalle diario"/>}
          </div>
        )}

        {/* HISTORIAL */}
        {tab==="historial" && <Historial dataA={dataA} dataB={dataB}/>}

        {/* ARCHIVOS */}
        {tab==="archivos" && (
          <FileManager sbCreds={sbCreds} onReprocess={async (text, grp, name) => {
            await processCSVText(text, grp, name);
          }}/>
        )}
      </div>
    </div>
  );
}

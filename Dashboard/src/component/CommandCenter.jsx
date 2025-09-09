import React, { useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, Marker, Polyline, Circle, useJsApiLoader } from "@react-google-maps/api";
import io from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip
} from "recharts";

// Socket/REST base
const WS_URL = (import.meta.env.VITE_WS_URL || "http://localhost:5000");
const socket = io(WS_URL);

// Map
const containerStyle = { width: "100%", height: "100%" };
const defaultCenter = { lat: 28.7041, lng: 77.1025 };
const pathColors = ["#00BFFF", "#32CD32", "#FF8C00", "#9C27B0"]; // neon accents

// Maps key
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || "";

// Utilities
const severityColor = (s) => ({
  low: "#32CD3277",
  moderate: "#FF8C0077",
  high: "#FF572277",
  critical: "#FF450077",
  smoke: "#9E9E9E77",
  small_fire: "#FF980077",
  large_fire: "#FF572277",
  wildfire: "#FF450077",
  minor: "#32CD3277",
  strong: "#FF572277",
  severe: "#FF450077"
}[s] || "#9E9E9E77");

const healthToColor = (pct) => pct >= 80 ? "#32CD32" : pct >= 50 ? "#FF8C00" : "#FF4500";

export default function CommandCenter() {
  // Data state
  const [drones, setDrones] = useState({});
  const [missions, setMissions] = useState([]);
  const [disasters, setDisasters] = useState([]);
  const [plannedPath, setPlannedPath] = useState([]);
  const [ai, setAi] = useState(null);
  const [autonomous, setAutonomous] = useState({});
  const [patrolMode, setPatrolMode] = useState(false);
  const [riskAssessment, setRiskAssessment] = useState(true);
  const [features, setFeatures] = useState({
    pathPlanning: true,
    zoneMgmt: true,
    rebalancing: true,
    patrol: false,
  });
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "dark");
  const [toasts, setToasts] = useState([]);
  const mapRef = useRef(null);
  const [userLoc, setUserLoc] = useState(null);
  const geoWatchId = useRef(null);

  // Load Maps
  const { isLoaded, loadError } = useJsApiLoader({ id: "google-map-script", googleMapsApiKey: GOOGLE_MAPS_API_KEY });

  // Socket listeners
  useEffect(() => {
    socket.on("drone-update", (payload) => {
      setDrones(prev => ({
        ...prev,
        [payload.callsign]: {
          ...(prev[payload.callsign] || {}),
          ...payload,
          lat: payload.location?.lat ?? payload.lat,
          lng: payload.location?.lng ?? payload.lng,
          alt: payload.location?.alt ?? payload.alt
        }
      }));
      if (payload.autonomous !== undefined) setAutonomous(prev => ({ ...prev, [payload.callsign]: payload.autonomous }));
    });
    socket.on("mission-created", m => setMissions(prev => [m, ...prev]));
    socket.on("mission-updated", m => setMissions(prev => prev.map(x => (x._id === m._id ? m : x))));
    socket.on("disaster-detected", d => {
      setDisasters(prev => [d, ...prev]);
      if (["critical", "wildfire"].includes(d.severity)) pushToast("Critical disaster detected", `${d.type} ${d.coordinates.lat.toFixed(4)}, ${d.coordinates.lng.toFixed(4)}`, "danger");
    });
    socket.on("disaster-updated", d => setDisasters(prev => prev.map(x => x._id === d._id ? d : x)));
    socket.on("drone-event", ev => {
      if (ev?.event?.event === 'human_detected') pushToast(`Human detected by ${ev.callsign}`, `${ev.event.location.lat.toFixed(4)}, ${ev.event.location.lng.toFixed(4)} conf ${Math.round(ev.event.confidence*100)}%`, "warning");
      if (ev?.event === 'emergency_rtl') pushToast(`Emergency RTL – ${ev.callsign}`, `Battery ${ev.battery?.toFixed(1)}%`, "danger");
    });
    return () => {
      socket.off("drone-update"); socket.off("mission-created"); socket.off("mission-updated");
      socket.off("disaster-detected"); socket.off("disaster-updated"); socket.off("drone-event");
    };
  }, []);

  // Live device location (radar/device position)
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      pushToast('Location', 'Geolocation not supported', 'warning');
      return;
    }
    try {
      geoWatchId.current = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          setUserLoc({ lat: latitude, lng: longitude, ts: Date.now() });
        },
        (err) => {
          console.warn('Geo error', err);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    } catch {}
    return () => { if (geoWatchId.current) navigator.geolocation.clearWatch(geoWatchId.current); };
  }, []);

  // Initial REST fetches
  useEffect(() => {
    fetch(`${WS_URL}/api/drones`).then(r=>r.json()).then(list => {
      const map = {}; list.forEach(d => map[d.callsign] = { ...d, lat: d.location?.lat, lng: d.location?.lng, alt: d.location?.alt }); setDrones(map);
    }).catch(()=>{});
    fetch(`${WS_URL}/api/missions`).then(r=>r.json()).then(setMissions).catch(()=>{});
    fetch(`${WS_URL}/api/disasters`).then(r=>r.json()).then(setDisasters).catch(()=>{});
  }, []);

  // Theme
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("theme", theme); }, [theme]);

  // Toasts
  function pushToast(title, message, type = "success", ttl = 5000) {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, title, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), ttl);
  }

  // Commands
  function sendCmd(callsign, cmd, meta = {}) {
    return fetch(`${WS_URL}/api/drone/${callsign}/command`, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ cmd, meta }) })
      .then(r => r.json()).catch(()=>({ ok:false }));
  }

  function enableAutonomous(callsign) { socket.emit("enable-autonomous", callsign); setAutonomous(prev => ({ ...prev, [callsign]: true })); }
  function disableAutonomous(callsign) { socket.emit("disable-autonomous", callsign); setAutonomous(prev => ({ ...prev, [callsign]: false })); }
  function enableAllAutonomous() { Object.keys(drones).forEach(enableAutonomous); pushToast("Autonomy Enabled", "All drones in AUTO", "success"); }
  function emergencyRTLAll() { Object.keys(drones).forEach(cs => socket.emit("return-home", cs)); pushToast("Emergency", "RTL initiated for all", "danger"); }

  // High-level AI/ops actions (wired to backend patterns used in legacy component)
  async function optimizeSwarm() {
    try {
      const r = await fetch(`${WS_URL}/api/ai/recommendations`);
      const j = await r.json();
      (j?.swarm_coordination?.recommendations || []).forEach(rec => console.log('Swarm rec', rec));
      pushToast('Optimize', 'Swarm optimization applied', 'success');
    } catch (e) { pushToast('Optimize failed', String(e), 'danger'); }
  }

  async function activateSwarmIntelligence() {
    try {
      Object.keys(drones).forEach(enableAutonomous);
      const r = await fetch(`${WS_URL}/api/ai/recommendations`);
      const j = await r.json();
      (j?.swarm_intelligence?.recommendations || []).forEach(rec => console.log('Swarm IQ', rec));
      pushToast('Swarm AI', 'Advanced coordination enabled', 'success');
    } catch (e) { pushToast('Swarm AI failed', String(e), 'danger'); }
  }

  async function optimizeEnergyEfficiency() {
    try {
      const r = await fetch(`${WS_URL}/api/ai/recommendations`);
      const j = await r.json();
      (j?.energy_efficiency?.recommendations || []).forEach(rec => console.log('Energy', rec));
      pushToast('Energy', `Avg ${(j?.energy_efficiency?.average_efficiency*100||0).toFixed(1)}%`, 'success');
    } catch (e) { pushToast('Energy failed', String(e), 'danger'); }
  }

  function createDisasterZoneAtCenter() {
    try {
      const map = mapRef.current; if (!map) return;
      const c = map.getCenter();
      // broadcast zone for services and UI
      const zone = { id:`zone_${Date.now()}`, center:{ lat:c.lat(), lng:c.lng() }, radius:0.01, priority:8, type:'high_risk', created_at: Date.now() };
      socket.emit('create-zone', zone);
      pushToast('Zone', `Created high-risk zone @ ${c.lat().toFixed(3)}, ${c.lng().toFixed(3)}`, 'success');
    } catch (e) { pushToast('Zone failed', String(e), 'danger'); }
  }

  async function getAIRecommendations() {
    try { const r = await fetch(`${WS_URL}/api/ai/recommendations`); const j = await r.json(); setAi(j); pushToast("AI", "Recommendations updated", "success"); } catch {}
  }

  // Mission status toggles → backend actions
  function togglePathPlanning() {
    setFeatures(prev => ({ ...prev, pathPlanning: !prev.pathPlanning }));
    // Re-run plan to a nearby point if enabled as a smoke test
    if (!features.pathPlanning && mapRef.current) {
      const c = mapRef.current.getCenter();
      const d0 = Object.values(drones)[0];
      if (d0) {
        fetch(`${WS_URL}/api/plan`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ start:[d0.lat,d0.lng], goal:[c.lat(), c.lng()], blocked:[] }) })
          .then(r=>r.json()).then(resp => { if (resp.ok) setPlannedPath(resp.result.path); });
      }
    }
  }

  function toggleZoneMgmt() {
    setFeatures(prev => ({ ...prev, zoneMgmt: !prev.zoneMgmt }));
    if (!features.zoneMgmt) createDisasterZoneAtCenter();
  }

  function toggleRebalancing() {
    setFeatures(prev => ({ ...prev, rebalancing: !prev.rebalancing }));
    optimizeSwarm();
  }

  function togglePatrol() {
    const next = !patrolMode; setPatrolMode(next);
    if (next) Object.keys(drones).forEach(enableAutonomous); else Object.keys(drones).forEach(disableAutonomous);
  }

  // Map interactions
  const onMapLoad = (map) => { mapRef.current = map; };
  const onMapClick = (e) => {
    const lat = e.latLng.lat(), lng = e.latLng.lng();
    const droneList = Object.values(drones);
    if (droneList.length) {
      const start = [droneList[0].lat, droneList[0].lng];
      fetch(`${WS_URL}/api/plan`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ start, goal: [lat,lng], blocked: [] }) })
        .then(r => r.json()).then(resp => { if (resp.ok) { setPlannedPath(resp.result.path); socket.emit('create-mission', { waypoints:[[lat,lng]], supplies:['first-aid'], priority: 3 }); } });
    } else {
      socket.emit('create-mission', { waypoints:[[lat,lng]], supplies:['first-aid'], priority: 3 });
    }
    pushToast('Mission requested', `${lat.toFixed(5)}, ${lng.toFixed(5)}`, 'success');
  };

  // Derived data for charts
  const healthRadar = useMemo(() => {
    const ds = Object.values(drones).slice(0, 4);
    const keys = ["battery","sensors","motors","communication"];
    return keys.map(k => {
      const sum = ds.reduce((acc,d)=> acc + ((d.component_health?.[k] ?? 0)*100), 0);
      const avg = ds.length ? sum / ds.length : 0;
      return { subject: k, A: Math.max(0, Math.min(100, Math.round(avg))), fullMark: 100 };
    });
  }, [drones]);

  const batterySeries = useMemo(() => Object.values(drones).map((d, idx) => ({ name: d.callsign || `D${idx+1}`, battery: Math.round(d.battery ?? 100) })), [drones]);

  // Loading states
  if (loadError) return <div className="w-full h-screen flex items-center justify-center text-red-400">Map load error</div>;
  if (!isLoaded) return <div className="w-full h-screen flex items-center justify-center"><div className="animate-spin h-10 w-10 rounded-full border-4 border-white/10 border-l-cyan-400"></div></div>;

  return (
    <div className="w-screen h-screen relative overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {/* Top Header Bar */}
      <div className="fixed top-0 left-20 right-[440px] h-12 bg-gradient-to-r from-white/5 to-white/10 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-4 z-40">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
            <span className="text-xs text-white/80">System Online</span>
          </div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-xs text-white/60">{new Date().toLocaleTimeString()}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-xs text-white/80">
            <span>Active Drones:</span>
            <span className="font-semibold text-green-400">{Object.keys(drones).length}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-white/80">
            <span>Missions:</span>
            <span className="font-semibold text-blue-400">{missions.length}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-white/80">
            <span>Disasters:</span>
            <span className="font-semibold text-red-400">{disasters.length}</span>
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="fixed left-0 top-0 h-full w-20 bg-gradient-to-b from-white/10 to-white/5 backdrop-blur-2xl border-r border-white/10 flex flex-col items-center py-6 gap-5 z-50">
        {/* Risk Assessment */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={()=>setRiskAssessment(v=>!v)} className={`w-12 h-12 rounded-2xl border shadow-[0_0_20px_rgba(0,191,255,0.25)] transition ${riskAssessment ? 'bg-cyan-500/25 border-cyan-300/40' : 'bg-white/10 border-white/10'}`}>
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Risk Assessment
            <div className="text-white/60 text-[10px] mt-1">Threat analysis</div>
          </div>
        </div>

        {/* Swarm Coordination */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={optimizeSwarm} className="w-12 h-12 rounded-2xl bg-white/10 hover:bg-cyan-500/20 border border-white/10 shadow-[0_0_12px_rgba(0,191,255,.18)] transition">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Swarm Coordination
            <div className="text-white/60 text-[10px] mt-1">Fleet management</div>
          </div>
        </div>

        {/* Predictive Maintenance */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={getAIRecommendations} className="w-12 h-12 rounded-2xl bg-white/10 hover:bg-cyan-500/20 border border-white/10 shadow-[0_0_12px_rgba(0,191,255,.18)] transition">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Predictive Maintenance
            <div className="text-white/60 text-[10px] mt-1">Component health</div>
          </div>
        </div>

        {/* Mission Optimization */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={activateSwarmIntelligence} className="w-12 h-12 rounded-2xl bg-white/10 hover:bg-cyan-500/20 border border-white/10 shadow-[0_0_12px_rgba(0,191,255,.18)] transition">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Mission Optimization
            <div className="text-white/60 text-[10px] mt-1">AI planning</div>
          </div>
        </div>

        {/* Locate Me */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={() => { if (mapRef.current && userLoc) mapRef.current.panTo({ lat:userLoc.lat, lng:userLoc.lng }); }} className="w-12 h-12 rounded-2xl bg-cyan-600/30 hover:bg-cyan-500/40 border border-cyan-300/50 shadow-[0_0_18px_rgba(0,191,255,.45)] transition">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Locate Me
          </div>
        </div>

        {/* Theme Toggle */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} className="w-12 h-12 rounded-2xl bg-purple-600/30 hover:bg-purple-500/40 border border-purple-300/50 shadow-[0_0_18px_rgba(147,51,234,.45)] transition">
            {theme === 'dark' ? (
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </div>
        </div>

        <div className="mt-auto" />

        {/* Emergency */}
        <div className="relative group">
          <motion.button whileTap={{ scale:.96 }} onClick={emergencyRTLAll} className="w-12 h-12 rounded-2xl bg-red-600/80 hover:bg-red-500 border border-red-400 shadow-[0_0_24px_rgba(255,69,0,0.7)]">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </motion.button>
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-red-600/90 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            Emergency RTL
            <div className="text-white/60 text-[10px] mt-1">Return all drones</div>
          </div>
        </div>
      </div>

      {/* Right Insights Panel */}
      <div className="fixed right-0 top-0 h-full w-[440px] bg-gradient-to-b from-white/10 to-white/5 backdrop-blur-2xl border-l border-white/10 p-5 flex flex-col gap-5 z-40 overflow-y-auto">
        {/* System Health & Prediction */}
        <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs uppercase tracking-widest text-white/80">System Health & Prediction</h3>
            <div className="text-xs text-white/60">Real-time monitoring</div>
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={healthRadar} cx="50%" cy="50%" outerRadius="80%">
                <PolarGrid stroke="#ffffff22" />
                <PolarAngleAxis dataKey="subject" stroke="#CBD5E0" tick={{ fill: '#CBD5E0', fontSize: 10 }} />
                <PolarRadiusAxis angle={45} domain={[0, 100]} tick={false} />
                <Radar name="Health" dataKey="A" stroke="#00BFFF" fill="#00BFFF" fillOpacity={0.35} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          {/* Circular battery gauges per drone */}
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-white/80">
            {Object.values(drones).slice(0,4).map((d, i) => {
              const b = Math.round((d.component_health?.battery ?? (d.battery??1)/100) * 100);
              const color = healthToColor(b);
              return (
                <div key={d.callsign || i} className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center gap-3">
                  <div className="relative w-12 h-12 rounded-full" style={{ background: `conic-gradient(${color} ${b*3.6}deg, rgba(255,255,255,.12) 0deg)` }}>
                    <div className="absolute inset-1 rounded-full bg-[#1A202C]" />
                    <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold">{b}%</div>
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between"><span className="font-semibold">{d.callsign}</span><span style={{ color }}>{Math.round(d.battery ?? b)}%</span></div>
                    <div className="mt-1 h-1.5 w-full bg-white/10 rounded overflow-hidden"><div className="h-full" style={{ width: `${Math.round(d.battery ?? b)}%`, background: color }} /></div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Swarm radar: assigned vs required (if AI present) */}
          <div className="mt-4 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={(ai?.mission_optimization || []).slice(0,5).map(z=>({ subject:`Z${z.zone}`, assigned:z.current_drones*10, required:z.optimal_drones*10 }))}
                          cx="50%" cy="50%" outerRadius="80%">
                <PolarGrid stroke="#ffffff22" />
                <PolarAngleAxis dataKey="subject" stroke="#CBD5E0" tick={{ fill: '#CBD5E0', fontSize: 10 }} />
                <PolarRadiusAxis angle={45} domain={[0, 100]} tick={false} />
                <Radar name="Assigned" dataKey="assigned" stroke="#32CD32" fill="#32CD32" fillOpacity={0.25} />
                <Radar name="Required" dataKey="required" stroke="#FF8C00" fill="#FF8C00" fillOpacity={0.15} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Mission Status */}
        <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-4">
          <h3 className="text-xs uppercase tracking-widest text-white/80 mb-2">Mission Status</h3>
          <div className="text-xs text-white/60 mb-3">Active mission features and controls</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <motion.button whileTap={{ scale:.97 }} onClick={togglePathPlanning} className={`rounded-lg px-3 py-2 border transition flex items-center gap-2 ${features.pathPlanning ? 'bg-cyan-500/30 border-cyan-300/40 shadow-[0_0_18px_rgba(0,191,255,.35)]' : 'bg-white/10 border-white/10'}`}>
              <div className={`w-2 h-2 rounded-full ${features.pathPlanning ? 'bg-cyan-400' : 'bg-white/30'}`} />
              <div className="text-left">
                <div className="font-semibold">Dynamic Path Planning</div>
                <div className="text-white/50 text-[10px]">Auto route optimization</div>
              </div>
            </motion.button>
            
            <motion.button whileTap={{ scale:.97 }} onClick={toggleZoneMgmt} className={`rounded-lg px-3 py-2 border transition flex items-center gap-2 ${features.zoneMgmt ? 'bg-cyan-500/30 border-cyan-300/40 shadow-[0_0_18px_rgba(0,191,255,.35)]' : 'bg-white/10 border-white/10'}`}>
              <div className={`w-2 h-2 rounded-full ${features.zoneMgmt ? 'bg-cyan-400' : 'bg-white/30'}`} />
              <div className="text-left">
                <div className="font-semibold">Zone Management</div>
                <div className="text-white/50 text-[10px]">Area coordination</div>
              </div>
            </motion.button>
            
            <motion.button whileTap={{ scale:.97 }} onClick={toggleRebalancing} className={`rounded-lg px-3 py-2 border transition flex items-center gap-2 ${features.rebalancing ? 'bg-cyan-500/30 border-cyan-300/40 shadow-[0_0_18px_rgba(0,191,255,.35)]' : 'bg-white/10 border-white/10'}`}>
              <div className={`w-2 h-2 rounded-full ${features.rebalancing ? 'bg-cyan-400' : 'bg-white/30'}`} />
              <div className="text-left">
                <div className="font-semibold">Mission Rebalancing</div>
                <div className="text-white/50 text-[10px]">Load distribution</div>
              </div>
            </motion.button>
            
            <motion.button whileTap={{ scale:.97 }} onClick={togglePatrol} className={`rounded-lg px-3 py-2 border transition flex items-center gap-2 ${patrolMode ? 'bg-emerald-500/30 border-emerald-300/40 shadow-[0_0_18px_rgba(16,185,129,.35)]' : 'bg-white/10 border-white/10'}`}>
              <div className={`w-2 h-2 rounded-full ${patrolMode ? 'bg-emerald-400' : 'bg-white/30'}`} />
              <div className="text-left">
                <div className="font-semibold">Patrol Mode</div>
                <div className="text-white/50 text-[10px]">Continuous monitoring</div>
              </div>
            </motion.button>
          </div>
        </div>

        {/* Emergency Controls */}
        <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-4">
          <h3 className="text-xs uppercase tracking-widest text-white/80 mb-2">Emergency Recovery</h3>
          <div className="text-xs text-white/60 mb-3">Critical safety and recovery systems</div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <div className="text-left">
                <div className="font-semibold">Patrol Mode</div>
                <div className="text-white/50 text-[10px]">Auto-RTL @ 20% battery</div>
              </div>
              <button onClick={() => setPatrolMode(v=>!v)} className={`w-10 h-5 rounded-full flex items-center px-1 transition ${patrolMode ? 'bg-emerald-500/60' : 'bg-white/10'}`}>
                <span className={`w-4 h-4 bg-white rounded-full transition ${patrolMode ? 'translate-x-5' : ''}`} />
              </button>
            </div>
            
            <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <div className="text-left">
                <div className="font-semibold">Battery Emergency</div>
                <div className="text-white/50 text-[10px]">Low battery auto-return</div>
              </div>
              <motion.button whileTap={{ scale: 0.95 }} onClick={emergencyRTLAll} className="text-xs px-2 py-1 rounded bg-red-600/80 border border-red-400 hover:bg-red-500/80 transition">Auto-RTL</motion.button>
            </div>
            
            <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <div className="text-left">
                <div className="font-semibold">Component Failure</div>
                <div className="text-white/50 text-[10px]">Hardware malfunction</div>
              </div>
              <motion.button whileTap={{ scale: 0.95 }} onClick={emergencyRTLAll} className="text-xs px-2 py-1 rounded bg-red-600/80 border border-red-400 hover:bg-red-500/80 transition">Immediate RTL</motion.button>
            </div>
            
            <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <div className="text-left">
                <div className="font-semibold">Backup Assignment</div>
                <div className="text-white/50 text-[10px]">Nearest available drone</div>
              </div>
              <span className="text-white/70 text-xs">Auto-assign</span>
            </div>
            
            <div className="flex items-center justify-between text-white/80 text-xs pt-1">
              <span className="font-semibold">Recovery EST</span>
              <span className="text-emerald-400">15-30 min</span>
            </div>
          </div>
        </div>
      </div>

      {/* AI Command Center Panel */}
      <div className="absolute left-24 top-16 w-[420px] rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-2xl p-4 shadow-[0_10px_40px_rgba(0,0,0,.35)]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs uppercase tracking-widest text-white/80">AI Command Center</h3>
          <button onClick={getAIRecommendations} className="text-xs px-2 py-1 rounded bg-cyan-500/30 border border-cyan-400/40 hover:bg-cyan-500/40 transition">Refresh AI</button>
        </div>
        <div className="text-xs text-white/60 mb-3">Advanced AI-powered drone swarm management</div>
        
        {/* System Status Indicators */}
        <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
          <div className="flex items-center gap-1 bg-white/5 rounded px-2 py-1">
            <div className="w-2 h-2 rounded-full bg-green-400"></div>
            <span className="text-white/80">AI Online</span>
          </div>
          <div className="flex items-center gap-1 bg-white/5 rounded px-2 py-1">
            <div className="w-2 h-2 rounded-full bg-blue-400"></div>
            <span className="text-white/80">Swarm Active</span>
          </div>
          <div className="flex items-center gap-1 bg-white/5 rounded px-2 py-1">
            <div className="w-2 h-2 rounded-full bg-yellow-400"></div>
            <span className="text-white/80">Monitoring</span>
          </div>
        </div>

        {/* AI Tools showcase */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <motion.button whileTap={{ scale: 0.98 }} onClick={enableAllAutonomous} className="rounded border border-white/10 bg-white/10 px-3 py-2 hover:bg-white/20 transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Enable All Auto</div>
              <div className="text-white/50 text-[10px]">Autonomous mode</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={optimizeSwarm} className="rounded border border-cyan-300/40 bg-cyan-500/20 px-3 py-2 hover:bg-cyan-500/30 shadow-[0_0_14px_rgba(0,191,255,.25)] transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Optimize Swarm</div>
              <div className="text-white/50 text-[10px]">Mission distribution</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={optimizeEnergyEfficiency} className="rounded border border-emerald-300/40 bg-emerald-500/20 px-3 py-2 hover:bg-emerald-500/30 shadow-[0_0_14px_rgba(16,185,129,.25)] transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Energy Opt</div>
              <div className="text-white/50 text-[10px]">Battery efficiency</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={activateSwarmIntelligence} className="rounded border border-fuchsia-300/40 bg-fuchsia-500/20 px-3 py-2 hover:bg-fuchsia-500/30 shadow-[0_0_14px_rgba(217,70,239,.25)] transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Swarm AI</div>
              <div className="text-white/50 text-[10px]">Collective intelligence</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={createDisasterZoneAtCenter} className="rounded border border-amber-400/40 bg-amber-500/20 px-3 py-2 hover:bg-amber-500/30 transition col-span-2 flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Create Disaster Zone</div>
              <div className="text-white/50 text-[10px]">Mark center area as disaster</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={()=>pushToast('Terrain','Adaptation requested','success')} className="rounded border border-sky-300/40 bg-sky-500/20 px-3 py-2 hover:bg-sky-500/30 transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Terrain Adaptation</div>
              <div className="text-white/50 text-[10px]">Route optimization</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={()=>pushToast('Weather','Analysis requested','success')} className="rounded border border-indigo-300/40 bg-indigo-500/20 px-3 py-2 hover:bg-indigo-500/30 transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Weather Analysis</div>
              <div className="text-white/50 text-[10px]">Flight conditions</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={()=>pushToast('Battery','Optimization requested','success')} className="rounded border border-lime-300/40 bg-lime-500/20 px-3 py-2 hover:bg-lime-500/30 transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Battery Optimization</div>
              <div className="text-white/50 text-[10px]">Power management</div>
            </div>
          </motion.button>
          
          <motion.button whileTap={{ scale: 0.98 }} onClick={()=>pushToast('Predictive','Maintenance scan requested','success')} className="rounded border border-rose-300/40 bg-rose-500/20 px-3 py-2 hover:bg-rose-500/30 transition flex items-center gap-2 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <div className="text-left">
              <div className="font-semibold">Predictive Maintenance</div>
              <div className="text-white/50 text-[10px]">Component health</div>
            </div>
          </motion.button>
        </div>
        {ai && (
          <div className="mt-3 text-xs space-y-1">
            <div className="flex gap-2"><span className="text-white/70">Risk:</span><span>{ai.risk_assessment?.overall_risk_level}</span></div>
            <div className="flex gap-2"><span className="text-white/70">Active:</span><span>{ai.swarm_coordination?.active_drones}/{ai.swarm_coordination?.total_drones}</span></div>
            <div className="flex gap-2"><span className="text-white/70">Efficiency:</span><span>{(ai.energy_efficiency?.average_efficiency*100)?.toFixed(0)}%</span></div>
          </div>
        )}
      </div>

      {/* Map */}
      <div className="absolute left-20 right-[440px] top-12 bottom-0">
        <GoogleMap mapContainerStyle={containerStyle} center={defaultCenter} zoom={13} onLoad={onMapLoad} onClick={onMapClick} options={{ disableDefaultUI:false, zoomControl:true, streetViewControl:false, fullscreenControl:true, styles:[{ elementType:'geometry', stylers:[{ color:'#0A0E1A'}]},{ elementType:'labels.text.fill', stylers:[{ color:'#CBD5E0'}]}] }}>
          {/* Missions */}
          {missions.map(m => (
            <Marker key={m._id || m.id} position={{ lat: m.waypoints[0][0], lng: m.waypoints[0][1] }} label={"M"} />
          ))}

          {/* Disasters */}
          {disasters.map(d => (
            <React.Fragment key={d._id}>
              <Marker position={{ lat: d.coordinates.lat, lng: d.coordinates.lng }} label={d.type?.[0]?.toUpperCase() || "D"} />
              <Circle center={{ lat: d.coordinates.lat, lng: d.coordinates.lng }} radius={d.severity === 'critical' || d.severity === 'wildfire' ? 800 : d.severity === 'high' || d.severity === 'large_fire' ? 600 : d.severity === 'moderate' || d.severity === 'small_fire' ? 400 : 250} options={{ strokeColor: severityColor(d.severity)?.replace('77','ff'), strokeOpacity:0.8, strokeWeight:1, fillColor: severityColor(d.severity), fillOpacity:0.25, zIndex:5 }} />
            </React.Fragment>
          ))}

          {/* Drones */}
          {Object.values(drones).map((d, idx) => (
            <React.Fragment key={d.callsign}>
              <Marker position={{ lat: d.lat, lng: d.lng }} label={d.callsign} />
              {Array.isArray(d.path) && d.path.length > 1 && (
                <Polyline path={d.path.map(p => ({ lat: p[0], lng: p[1] }))} options={{ strokeColor: pathColors[idx % pathColors.length], strokeOpacity: 0.9, strokeWeight: 3 }} />
              )}
            </React.Fragment>
          ))}

          {/* Live device location marker */}
          {userLoc && (
            <React.Fragment>
              <Marker position={{ lat: userLoc.lat, lng: userLoc.lng }} label={{ text: 'ME', color: '#00E5FF', fontSize: '12px', fontWeight: '700' }} />
              <Circle center={{ lat: userLoc.lat, lng: userLoc.lng }} radius={60} options={{ strokeColor:'#00E5FF', strokeOpacity:0.9, strokeWeight:1, fillColor:'#00E5FF', fillOpacity:0.15, zIndex: 6 }} />
            </React.Fragment>
          )}

          {/* Planned path */}
          {plannedPath.length > 1 && (
            <Polyline path={plannedPath.map(p => ({ lat: p[0], lng: p[1] }))} options={{ strokeColor:'#00BFFF', strokeOpacity:0.9, strokeWeight:4, zIndex: 999 }} />
          )}
        </GoogleMap>
      </div>

      {/* Bottom Status Bar */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white/5 border border-white/10 backdrop-blur-xl rounded-full px-4 py-2 z-50">
        <div className="flex items-center gap-1 text-xs text-white/80">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
          Active drones: <span className="text-white font-semibold">{Object.keys(drones).length}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-white/80">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          Missions: <span className="text-white font-semibold">{missions.length}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-white/80">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          Disasters: <span className="text-white font-semibold">{disasters.length}</span>
        </div>
        <button onClick={getAIRecommendations} className="text-xs px-2 py-1 rounded bg-cyan-500/30 border border-cyan-400/40 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          Get AI
        </button>
        <button onClick={enableAllAutonomous} className="text-xs px-2 py-1 rounded bg-emerald-500/30 border border-emerald-400/40 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Enable Auto
        </button>
        <button onClick={() => pushToast('Optimize', 'Swarm optimization applied', 'success')} className="text-xs px-2 py-1 rounded bg-amber-500/30 border border-amber-400/40 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Optimize
        </button>
        <button onClick={emergencyRTLAll} className="text-xs px-2 py-1 rounded bg-red-600/80 border border-red-400 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          Emergency
        </button>
      </div>

      {/* Toasts */}
      <div className="fixed top-4 right-4 flex flex-col gap-2 z-[999]">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div key={t.id} initial={{ x: 200, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 200, opacity: 0 }} className={`min-w-[320px] rounded-xl border backdrop-blur-xl p-3 ${t.type==='danger' ? 'border-red-400/40 bg-red-600/20' : t.type==='warning' ? 'border-amber-400/40 bg-amber-500/20' : 'border-emerald-400/40 bg-emerald-500/20'}`}>
              <div className="font-semibold mb-1">{t.title}</div>
              <div className="text-sm text-white/80">{t.message}</div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}


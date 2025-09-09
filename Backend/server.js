import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import bodyParser from 'body-parser';
import mqtt from 'mqtt';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Mission from './models/Missions.js';
import Drone from './models/Drone.js';
import EventModel from './models/Event.js';
import NoFlyZone from './models/NoflyZone.js';
import Disaster from './models/Disaster.js';
import fetch from 'node-fetch';

dotenv.config();

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/sih';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const BATTERY_FAILSAFE = parseFloat(process.env.BATTERY_FAILSAFE || '20');
const MIN_BATTERY_ASSIGN = parseFloat(process.env.MIN_BATTERY_ASSIGN || '35');
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || null;
const PLANNER_URL = process.env.PLANNER_URL || 'http://localhost:8000';

await mongoose.connect(MONGO_URI).catch(err => { console.error('Mongo conn err', err); process.exit(1); });
console.log('MongoDB connected');

const app = express();
app.use(cors());
app.use(bodyParser.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// MQTT client
const mqttClient = mqtt.connect(MQTT_URL);
// Command tracking and simple per-drone rate limiting
const pendingAcks = new Map(); // cmdId -> { resolve, reject, timeout }
const lastCommandAt = new Map(); // callsign -> timestamp
const MIN_COMMAND_INTERVAL_MS = 200;
mqttClient.on('connect', () => {
  console.log('MQTT connected to', MQTT_URL);
  mqttClient.subscribe('drone/+/telemetry');
  mqttClient.subscribe('drone/+/event');
  mqttClient.subscribe('drone/+/ack');
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    if (topic.match(/^drone\/[^\/]+\/telemetry$/)) {
      const callsign = topic.split('/')[1];
      // upsert drone
      const update = {
        callsign,
        battery: payload.battery ?? 100,
        mode: payload.mode ?? 'IDLE',
        lastSeen: new Date(),
        location: { lat: payload.lat ?? 0, lng: payload.lng ?? 0, alt: payload.alt ?? 0 },
      };
      // push to path array (bounded to last 200)
      const drone = await Drone.findOneAndUpdate({ callsign }, {
        $set: update,
        $push: { path: { $each: [ [update.location.lat, update.location.lng] ], $slice: -200 } }
      }, { upsert: true, new: true });

      // battery failsafe
      if (drone.battery <= BATTERY_FAILSAFE && drone.mode !== 'RTL') {
        console.log(`Battery low for ${callsign} (${drone.battery}). Issuing RTL & reassign...`);
        mqttClient.publish(`drone/${callsign}/command`, JSON.stringify({ cmd: 'rtl' }));
        await Drone.updateOne({ callsign }, { $set: { mode: 'RTL' } });
        // reassign any active mission assigned to this drone
        const active = await Mission.findOne({ assignedTo: callsign, status: 'active' });
        if (active) {
          active.assignedTo = null;
          active.status = 'queued';
          await active.save();
          await tryAssignQueuedMissions();
          io.emit('mission-updated', active);
        }
      }

      io.emit('drone-update', drone);
    }

    if (topic.match(/^drone\/[^\/]+\/event$/)) {
      const callsign = topic.split('/')[1];
      const ev = new EventModel({ type: payload.event || 'unknown', payload, source: callsign });
      await ev.save();
      io.emit('drone-event', { callsign, event: payload });
      // Human detection -> auto-create rescue mission and assign
      if ((payload.event === 'human_detected') && payload.location) {
        try {
          const m = new Mission({
            name: 'Rescue - human detected',
            waypoints: [[payload.location.lat, payload.location.lng]],
            supplies: ['first_aid','water','blanket'],
            priority: 1,
            metadata: { source: 'ai', confidence: payload.confidence, image: payload.image }
          });
          await m.save();
          io.emit('mission-created', m);
          await tryAssignQueuedMissions();
        } catch (e) { console.error('rescue mission create err', e); }
      }
    }

    // Command acknowledgements from bridge
    if (topic.match(/^drone\/[^\/]+\/ack$/)) {
      const cmdId = payload?.cmdId;
      if (cmdId && pendingAcks.has(cmdId)) {
        const entry = pendingAcks.get(cmdId);
        clearTimeout(entry.timeout);
        pendingAcks.delete(cmdId);
        entry.resolve({ ok: true, status: payload.status || 'ACK' });
      }
    }
  } catch (e) {
    console.error('MQTT msg parse error', e);
  }
});

// Simple in-memory queue order by priority (lower number = higher priority)
async function tryAssignQueuedMissions() {
  // find highest priority queued mission
  const m = await Mission.findOne({ status: 'queued' }).sort({ priority: 1, createdAt: 1 }).exec();
  if (!m) return;
  // choose best drone
  const drone = await chooseBestAvailableDrone();
  if (!drone) return;
  // assign
  m.assignedTo = drone.callsign;
  m.status = 'active';
  await m.save();
  // publish to mqtt
  mqttClient.publish(`mission/${m._id}/assign`, JSON.stringify(m));
  io.emit('mission-updated', m);
  console.log('Assigned mission', m._id, 'to', drone.callsign);
  // try assign next one (recursive)
  setImmediate(tryAssignQueuedMissions);
}

async function chooseBestAvailableDrone() {
  // available drones: battery >= MIN_BATTERY_ASSIGN, mode !== RTL and not currently assigned active mission
  const drones = await Drone.find({ battery: { $gte: MIN_BATTERY_ASSIGN }, mode: { $ne: 'RTL' } }).exec();
  if (!drones || drones.length === 0) return null;
  // exclude drones that are currently assigned active mission
  const busy = await Mission.find({ status: 'active' }).distinct('assignedTo').exec();
  const candidates = drones.filter(d => !busy.includes(d.callsign));
  if (!candidates.length) return null;
  // pick highest battery
  candidates.sort((a,b) => b.battery - a.battery);
  return candidates[0];
}

// REST APIs

// Create mission
app.post('/api/missions', async (req, res) => {
  const { name, waypoints, supplies = [], priority = 5, metadata = {} } = req.body;
  if (!waypoints || !Array.isArray(waypoints) || waypoints.length === 0) return res.status(400).json({ ok:false, msg:'waypoints required' });
  const m = new Mission({ name, waypoints, supplies, priority, metadata });
  await m.save();
  await tryAssignQueuedMissions();
  io.emit('mission-created', m);
  return res.json({ ok:true, mission: m });
});

// Force assign
app.post('/api/missions/:id/assign', async (req, res) => {
  const id = req.params.id;
  const { callsign } = req.body;
  const mission = await Mission.findById(id).exec();
  if (!mission) return res.status(404).json({ ok:false, msg:'mission not found' });
  mission.assignedTo = callsign;
  mission.status = 'active';
  await mission.save();
  mqttClient.publish(`mission/${mission._id}/assign`, JSON.stringify(mission));
  io.emit('mission-updated', mission);
  return res.json({ ok:true, mission });
});

// list missions
app.get('/api/missions', async (req,res) => {
  const ms = await Mission.find().sort({ createdAt: -1 }).limit(200).exec();
  res.json(ms);
});

// list drones
app.get('/api/drones', async (req,res) => {
  const ds = await Drone.find().exec();
  res.json(ds);
});

// drone direct command (rest)
app.post('/api/drone/:callsign/command', async (req,res) => {
  try {
    const { callsign } = req.params;
    const { cmd, meta } = req.body;
    // rate limit per drone
    const now = Date.now();
    const last = lastCommandAt.get(callsign) || 0;
    if (now - last < MIN_COMMAND_INTERVAL_MS) {
      return res.status(429).json({ ok:false, msg:'rate_limited' });
    }
    lastCommandAt.set(callsign, now);

    const cmdId = `${callsign}_${now}_${Math.floor(Math.random()*1e6)}`;
    const payload = { cmdId, cmd, meta };
    const awaitAck = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingAcks.delete(cmdId);
        reject(new Error('ack_timeout'));
      }, 3000);
      pendingAcks.set(cmdId, { resolve, reject, timeout });
    });
    mqttClient.publish(`drone/${callsign}/command`, JSON.stringify(payload));
    await awaitAck;
    return res.json({ ok:true, cmdId });
  } catch (e) {
    return res.status(500).json({ ok:false, err:e.toString() });
  }
});

// analyze image -> calls AI microservice (if present)
app.post('/api/analyze-image', async (req,res) => {
  const { imageUrl, coordinates } = req.body;
  try {
    if (!AI_SERVICE_URL) return res.json({ ok:true, result: { label:'unknown', confidence:0.5 } });
    const r = await fetch(`${AI_SERVICE_URL}/analyze-url`, { 
      method: 'POST', 
      body: JSON.stringify({ imageUrl, coordinates }), 
      headers: { 'Content-Type':'application/json' } 
    });
    const json = await r.json();
    return res.json({ ok:true, result: json });
  } catch (e) {
    return res.status(500).json({ ok:false, err: e.toString() });
  }
});

// Enhanced disaster detection endpoint
app.post('/api/detect-disaster', async (req, res) => {
  const { imageUrl, coordinates, droneCallsign } = req.body;
  try {
    if (!AI_SERVICE_URL) {
      return res.status(503).json({ ok: false, msg: 'AI service not available' });
    }
    
    const response = await fetch(`${AI_SERVICE_URL}/analyze-url`, {
      method: 'POST',
      body: JSON.stringify({ imageUrl, coordinates }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`AI service error: ${response.status}`);
    }
    
    const detection = await response.json();
    
    // Create disaster record
    const disaster = new Disaster({
      type: detection.label,
      severity: detection.severity,
      confidence: detection.confidence,
      coordinates: {
        lat: detection.coordinates[0],
        lng: detection.coordinates[1]
      },
      description: detection.description,
      recommendedActions: detection.recommended_actions,
      imageUrl: imageUrl,
      assignedDrones: droneCallsign ? [droneCallsign] : []
    });
    
    await disaster.save();
    
    // Emit real-time update
    io.emit('disaster-detected', disaster);
    
    // Auto-assign nearby drone if available
    if (!droneCallsign) {
      const nearbyDrone = await findNearestAvailableDrone(disaster.coordinates.lat, disaster.coordinates.lng);
      if (nearbyDrone) {
        disaster.assignedDrones.push(nearbyDrone.callsign);
        await disaster.save();
        
        // Create emergency mission
        const emergencyMission = new Mission({
          name: `Emergency Response - ${disaster.type}`,
          waypoints: [[disaster.coordinates.lat, disaster.coordinates.lng]],
          supplies: getEmergencySupplies(disaster.type),
          priority: 1, // Highest priority
          assignedTo: nearbyDrone.callsign,
          status: 'active',
          metadata: { disasterId: disaster._id, type: 'emergency' }
        });
        
        await emergencyMission.save();
        io.emit('mission-created', emergencyMission);
      }
    }
    
    return res.json({ ok: true, disaster });
  } catch (e) {
    console.error('Disaster detection error:', e);
    return res.status(500).json({ ok: false, err: e.toString() });
  }
});

// Proxy text classification to AI service
app.post('/api/classify-text', async (req, res) => {
  try {
    if (!AI_SERVICE_URL) return res.status(503).json({ ok:false, msg:'AI service not available' });
    const r = await fetch(`${AI_SERVICE_URL}/classify-text`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(req.body)
    });
    const json = await r.json();
    return res.json({ ok:true, result: json });
  } catch (e) {
    return res.status(500).json({ ok:false, err: e.toString() });
  }
});

// Proxy object detection to AI service (file upload)
app.post('/api/detect-objects', async (req, res) => {
  try {
    if (!AI_SERVICE_URL) return res.status(503).json({ ok:false, msg:'AI service not available' });
    // For brevity, expect frontend to send URL and backend refetches or use form-data in future
    return res.status(501).json({ ok:false, msg:'Use /api/analyze-image or AI /detect-objects with multipart form-data' });
  } catch (e) {
    return res.status(500).json({ ok:false, err: e.toString() });
  }
});

// Get all disasters
app.get('/api/disasters', async (req, res) => {
  const disasters = await Disaster.find().sort({ detectedAt: -1 }).limit(100).exec();
  res.json(disasters);
});

// Update disaster status
app.put('/api/disasters/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const disaster = await Disaster.findById(id);
  if (!disaster) return res.status(404).json({ ok: false, msg: 'Disaster not found' });
  
  disaster.status = status;
  if (status === 'resolved') {
    disaster.resolvedAt = new Date();
  }
  
  await disaster.save();
  io.emit('disaster-updated', disaster);
  
  return res.json({ ok: true, disaster });
});

// Proxy to planner service
app.post('/api/plan', async (req, res) => {
  try {
    const r = await fetch(`${PLANNER_URL}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const json = await r.json();
    if (!r.ok) return res.status(400).json({ ok:false, err: json.detail || 'plan failed' });
    return res.json({ ok:true, result: json });
  } catch (e) {
    return res.status(500).json({ ok:false, err: e.toString() });
  }
});

// Reactive obstacle avoidance
app.post('/api/avoid', async (req, res) => {
  try {
    const r = await fetch(`${PLANNER_URL}/avoid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const json = await r.json();
    if (!r.ok) return res.status(400).json({ ok:false, err: json.detail || 'avoid failed' });
    // If sidestep recommended, publish a micro-adjust command to drone
    const { callsign, new_heading, command } = { callsign:req.body.callsign, ...json };
    if (command === 'sidestep' && callsign) {
      mqttClient.publish(`drone/${callsign}/command`, JSON.stringify({ cmd:'adjust_heading', meta:{ heading:new_heading } }));
    }
    return res.json({ ok:true, result: json });
  } catch (e) {
    return res.status(500).json({ ok:false, err: e.toString() });
  }
});

// Helper functions
async function findNearestAvailableDrone(lat, lng) {
  const drones = await Drone.find({ 
    battery: { $gte: MIN_BATTERY_ASSIGN }, 
    mode: { $ne: 'RTL' } 
  }).exec();
  
  if (!drones.length) return null;
  
  // Simple distance calculation (in production, use proper geospatial queries)
  let nearest = null;
  let minDistance = Infinity;
  
  for (const drone of drones) {
    const distance = Math.sqrt(
      Math.pow(drone.location.lat - lat, 2) + Math.pow(drone.location.lng - lng, 2)
    );
    if (distance < minDistance) {
      minDistance = distance;
      nearest = drone;
    }
  }
  
  return nearest;
}

function getEmergencySupplies(disasterType) {
  const supplies = {
    'flood': ['life_vests', 'rescue_ropes', 'first_aid', 'water_purification'],
    'fire': ['fire_extinguishers', 'fire_blankets', 'first_aid', 'oxygen_masks'],
    'earthquake': ['search_rescue_equipment', 'first_aid', 'emergency_blankets', 'water'],
    'landslide': ['shovels', 'first_aid', 'emergency_blankets', 'rescue_ropes'],
    'other': ['first_aid', 'emergency_blankets', 'water', 'communication_equipment']
  };
  
  return supplies[disasterType] || supplies['other'];
}

// add nofly zone
app.post('/api/nofly', async (req,res) => {
  const { name, polygon } = req.body;
  if (!polygon || !Array.isArray(polygon)) return res.status(400).json({ ok:false, msg:'polygon required' });
  const nf = new NoFlyZone({ name, polygon });
  await nf.save();
  res.json({ ok:true, zone: nf });
});

// get events
app.get('/api/events', async (req,res) => {
  const ev = await EventModel.find().sort({ createdAt: -1 }).limit(200).exec();
  res.json(ev);
});

// websocket actions
io.on('connection', (socket) => {
  console.log('WS connected', socket.id);

  socket.on('create-mission', async (payload) => {
    // payload: { name, waypoints, supplies, priority }
    const m = new Mission(payload);
    await m.save();
    await tryAssignQueuedMissions();
    io.emit('mission-created', m);
  });

  // Emergency and autonomy controls mapped to MQTT bridge
  socket.on('return-home', (callsign) => {
    if (!callsign) return;
    const cmdId = `${callsign}_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
    mqttClient.publish(`drone/${callsign}/command`, JSON.stringify({ cmdId, cmd: 'rtl' }));
  });

  socket.on('enable-autonomous', (callsign) => {
    if (!callsign) return;
    const cmdId = `${callsign}_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
    mqttClient.publish(`drone/${callsign}/command`, JSON.stringify({ cmdId, cmd: 'set_mode', meta: { mode: 'AUTO' } }));
  });

  socket.on('disable-autonomous', (callsign) => {
    if (!callsign) return;
    const cmdId = `${callsign}_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
    mqttClient.publish(`drone/${callsign}/command`, JSON.stringify({ cmdId, cmd: 'set_mode', meta: { mode: 'LOITER' } }));
  });

  socket.on('assign-zone', ({ droneId, zoneId, priority }) => {
    if (!droneId || !zoneId) return;
    mqttClient.publish(`drone/${droneId}/command`, JSON.stringify({ cmd: 'assign_zone', meta: { zoneId, priority } }));
  });

  socket.on('create-zone', (zone) => {
    mqttClient.publish('zones/create', JSON.stringify(zone));
    io.emit('zone-created', zone);
  });

  socket.on('disconnect', ()=> console.log('WS disconnect', socket.id));
});

// Start server and also trigger queue worker
server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
setInterval(tryAssignQueuedMissions, 5000); // safety - periodically try to assign

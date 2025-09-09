import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import mqtt from "mqtt";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ✅ Store latest drone telemetry and AI data
let droneTelemetry = {};
let disasterZones = {};
let aiPredictions = {};

// Connect to MQTT broker (configurable; fallback to localhost)
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.hivemq.com";
const MQTT_PORT = process.env.MQTT_PORT ? Number(process.env.MQTT_PORT) : undefined;
const client = mqtt.connect(MQTT_URL, MQTT_PORT ? { port: MQTT_PORT } : {});

client.on("connect", () => {
  console.log(" MQTT connected");
  client.subscribe("drone/+/telemetry");
  client.subscribe("drone/+/event");
  client.subscribe("disaster/+/prediction");
});

client.on("message", (topic, message) => {
  try {
    if (topic.includes("telemetry")) {
      const payload = JSON.parse(message.toString());
      droneTelemetry[payload.callsign] = payload;

      // forward to frontend via socket.io too
      io.emit("drone-update", payload);
    } else if (topic.includes("event")) {
      const payload = JSON.parse(message.toString());
      console.log(`📡 Event: ${payload.event} from ${topic}`);
      io.emit("drone-event", payload);
    } else if (topic.includes("disaster") && topic.includes("prediction")) {
      const payload = JSON.parse(message.toString());
      aiPredictions[payload.zone_id] = payload;
      io.emit("disaster-prediction", payload);
    }
  } catch (err) {
    console.error("MQTT parse error:", err);
  }
});

// REST: return latest telemetry of all drones
app.get("/api/drone/location", (req, res) => {
  res.json(droneTelemetry);
});

// REST: return disaster zones and AI predictions
app.get("/api/disaster/zones", (req, res) => {
  res.json({
    zones: disasterZones,
    predictions: aiPredictions,
    timestamp: Date.now()
  });
});

// REST: create disaster zone
app.post("/api/disaster/zone", (req, res) => {
  const { zone_id, center, radius, priority, type } = req.body;
  disasterZones[zone_id] = {
    id: zone_id,
    center,
    radius,
    priority,
    type,
    created_at: Date.now()
  };
  
  // Notify all clients
  io.emit("zone-created", disasterZones[zone_id]);
  res.json({ success: true, zone: disasterZones[zone_id] });
});

// REST: get AI recommendations
app.get("/api/ai/recommendations", (req, res) => {
  const recommendations = generateAIRecommendations();
  res.json(recommendations);
});

function generateAIRecommendations() {
  const drones = Object.values(droneTelemetry);
  const zones = Object.values(disasterZones);
  
  return {
    optimal_deployment: calculateOptimalDeployment(drones, zones),
    battery_management: analyzeBatteryStatus(drones),
    risk_assessment: assessOverallRisk(zones),
    autonomous_actions: suggestAutonomousActions(drones, zones),
    swarm_coordination: analyzeSwarmCoordination(drones),
    predictive_maintenance: generateMaintenancePredictions(drones),
    auto_recovery: generateRecoveryPlans(drones),
    mission_optimization: optimizeMissionPlans(drones, zones),
    // Advanced AI features
    weather_analysis: analyzeWeatherConditions(drones),
    terrain_optimization: optimizeTerrainNavigation(drones),
    energy_efficiency: analyzeEnergyEfficiency(drones),
    swarm_intelligence: analyzeSwarmIntelligence(drones),
    mission_prioritization: prioritizeMissions(drones, zones),
    emergency_protocols: generateEmergencyProtocols(drones)
  };
}

function calculateOptimalDeployment(drones, zones) {
  // AI algorithm to determine optimal drone positioning
  const recommendations = [];
  
  zones.forEach(zone => {
    const availableDrones = drones.filter(d => d.mode === 'IDLE' && d.battery > 30);
    if (availableDrones.length > 0) {
      recommendations.push({
        zone_id: zone.id,
        recommended_drones: availableDrones.slice(0, 2).map(d => d.callsign),
        priority: zone.priority,
        reasoning: "High priority zone requires immediate coverage"
      });
    }
  });
  
  return recommendations;
}

function analyzeBatteryStatus(drones) {
  const lowBattery = drones.filter(d => d.battery < 30);
  const criticalBattery = drones.filter(d => d.battery < 20);
  
  return {
    low_battery_count: lowBattery.length,
    critical_battery_count: criticalBattery.length,
    recommendations: criticalBattery.length > 0 ? 
      ["Immediate RTL required for critical battery drones"] : 
      ["Battery levels normal"]
  };
}

function assessOverallRisk(zones) {
  const highRiskZones = zones.filter(z => z.priority > 7);
  return {
    total_zones: zones.length,
    high_risk_zones: highRiskZones.length,
    overall_risk_level: highRiskZones.length > 0 ? "HIGH" : "MODERATE"
  };
}

function suggestAutonomousActions(drones, zones) {
  const actions = [];
  
  // Suggest enabling autonomous mode for idle drones in high-risk areas
  const idleDrones = drones.filter(d => d.mode === 'IDLE' && !d.autonomous);
  if (idleDrones.length > 0 && zones.some(z => z.priority > 7)) {
    actions.push({
      type: "enable_autonomous",
      drones: idleDrones.map(d => d.callsign),
      reason: "High-risk zones detected, autonomous mode recommended"
    });
  }
  
  return actions;
}

function analyzeSwarmCoordination(drones) {
  const swarmAnalysis = {
    total_drones: drones.length,
    active_drones: drones.filter(d => d.mode !== 'IDLE').length,
    coordination_score: 0,
    recommendations: []
  };
  
  // Calculate coordination score based on distribution
  const positions = drones.map(d => ({ lat: d.lat, lng: d.lng }));
  const avgDistance = calculateAverageDistance(positions);
  swarmAnalysis.coordination_score = Math.min(1, avgDistance / 0.01); // Normalize
  
  // Suggest coordination improvements
  if (swarmAnalysis.coordination_score < 0.5) {
    swarmAnalysis.recommendations.push("Drones too clustered - spread out for better coverage");
  }
  
  return swarmAnalysis;
}

function generateMaintenancePredictions(drones) {
  const predictions = [];
  
  drones.forEach(drone => {
    const healthScore = calculateHealthScore(drone);
    if (healthScore < 0.7) {
      predictions.push({
        drone: drone.callsign,
        issue: "Component degradation detected",
        severity: healthScore < 0.5 ? "critical" : "warning",
        recommended_action: "Schedule maintenance",
        estimated_failure_time: "2-5 hours"
      });
    }
  });
  
  return predictions;
}

function generateRecoveryPlans(drones) {
  const recoveryPlans = [];
  
  drones.forEach(drone => {
    if (drone.battery < 20 || drone.mode === 'RTL') {
      recoveryPlans.push({
        drone: drone.callsign,
        issue: drone.battery < 20 ? "Low battery" : "Emergency RTL",
        recovery_plan: "Return to base and recharge",
        estimated_recovery_time: "15-30 minutes",
        backup_drone: findNearestAvailableDrone(drone, drones)
      });
    }
  });
  
  return recoveryPlans;
}

function optimizeMissionPlans(drones, zones) {
  const optimizations = [];
  
  zones.forEach(zone => {
    const assignedDrones = drones.filter(d => d.zone === zone.id);
    const optimalCount = Math.ceil(zone.priority / 3); // 1 drone per 3 priority points
    
    if (assignedDrones.length < optimalCount) {
      optimizations.push({
        zone: zone.id,
        current_drones: assignedDrones.length,
        optimal_drones: optimalCount,
        recommendation: `Assign ${optimalCount - assignedDrones.length} more drones to ${zone.id}`
      });
    }
  });
  
  return optimizations;
}

// Helper functions
function calculateAverageDistance(positions) {
  if (positions.length < 2) return 0;
  
  let totalDistance = 0;
  let count = 0;
  
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dist = Math.sqrt(
        Math.pow(positions[i].lat - positions[j].lat, 2) +
        Math.pow(positions[i].lng - positions[j].lng, 2)
      );
      totalDistance += dist;
      count++;
    }
  }
  
  return count > 0 ? totalDistance / count : 0;
}

function calculateHealthScore(drone) {
  // Simulate health score based on battery, mode, and other factors
  let score = 1.0;
  
  if (drone.battery < 30) score -= 0.3;
  if (drone.battery < 15) score -= 0.4;
  if (drone.mode === 'RTL') score -= 0.2;
  if (drone.emergency_rtl) score -= 0.3;
  
  return Math.max(0, score);
}

function findNearestAvailableDrone(targetDrone, allDrones) {
  const available = allDrones.filter(d => 
    d.callsign !== targetDrone.callsign && 
    d.mode === 'IDLE' && 
    d.battery > 50
  );
  
  if (available.length === 0) return null;
  
  let nearest = available[0];
  let minDistance = calculateDistance(targetDrone, nearest);
  
  available.forEach(drone => {
    const distance = calculateDistance(targetDrone, drone);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = drone;
    }
  });
  
  return nearest.callsign;
}

function calculateDistance(drone1, drone2) {
  return Math.sqrt(
    Math.pow(drone1.lat - drone2.lat, 2) +
    Math.pow(drone1.lng - drone2.lng, 2)
  );
}

// Advanced AI Analytics Functions
function analyzeWeatherConditions(drones) {
  const weatherAnalysis = {
    current_conditions: "optimal", // Simulated weather
    wind_speed: Math.random() * 20, // 0-20 m/s
    visibility: Math.random() * 10 + 5, // 5-15 km
    temperature: Math.random() * 30 + 10, // 10-40°C
    recommendations: []
  };
  
  // Weather-based recommendations
  if (weatherAnalysis.wind_speed > 15) {
    weatherAnalysis.recommendations.push("High wind detected - reduce flight altitude");
    weatherAnalysis.current_conditions = "challenging";
  }
  
  if (weatherAnalysis.visibility < 8) {
    weatherAnalysis.recommendations.push("Low visibility - activate enhanced sensors");
    weatherAnalysis.current_conditions = "poor";
  }
  
  return weatherAnalysis;
}

function optimizeTerrainNavigation(drones) {
  const terrainOptimization = {
    terrain_complexity: "moderate",
    elevation_changes: Math.random() * 500, // 0-500m
    obstacles_detected: Math.floor(Math.random() * 5),
    optimal_altitude: 120,
    recommendations: []
  };
  
  // Terrain-based optimization
  if (terrainOptimization.elevation_changes > 300) {
    terrainOptimization.terrain_complexity = "complex";
    terrainOptimization.optimal_altitude = 150;
    terrainOptimization.recommendations.push("Complex terrain - increase altitude for safety");
  }
  
  if (terrainOptimization.obstacles_detected > 3) {
    terrainOptimization.recommendations.push("Multiple obstacles detected - activate collision avoidance");
  }
  
  return terrainOptimization;
}

function analyzeEnergyEfficiency(drones) {
  const energyAnalysis = {
    total_energy_consumption: 0,
    average_efficiency: 0,
    energy_waste: 0,
    recommendations: []
  };
  
  let totalEfficiency = 0;
  let lowEfficiencyDrones = 0;
  
  drones.forEach(drone => {
    const efficiency = drone.energy_efficiency || 1.0;
    totalEfficiency += efficiency;
    
    if (efficiency < 0.8) {
      lowEfficiencyDrones++;
      energyAnalysis.recommendations.push(`${drone.callsign}: Low energy efficiency - optimize flight parameters`);
    }
  });
  
  energyAnalysis.average_efficiency = totalEfficiency / drones.length;
  energyAnalysis.energy_waste = (1 - energyAnalysis.average_efficiency) * 100;
  
  if (energyAnalysis.average_efficiency < 0.85) {
    energyAnalysis.recommendations.push("Overall swarm efficiency low - implement energy optimization");
  }
  
  return energyAnalysis;
}

function analyzeSwarmIntelligence(drones) {
  const swarmIntelligence = {
    collective_decision_score: 0,
    communication_quality: 0,
    coordination_efficiency: 0,
    swarm_health: 0,
    recommendations: []
  };
  
  // Analyze collective decision making
  const autonomousDrones = drones.filter(d => d.autonomous);
  swarmIntelligence.collective_decision_score = autonomousDrones.length / drones.length;
  
  // Analyze communication quality
  const healthyCommDrones = drones.filter(d => d.component_health?.communication > 0.8);
  swarmIntelligence.communication_quality = healthyCommDrones.length / drones.length;
  
  // Analyze coordination efficiency
  const activeDrones = drones.filter(d => d.mode !== 'IDLE');
  swarmIntelligence.coordination_efficiency = activeDrones.length / drones.length;
  
  // Overall swarm health
  swarmIntelligence.swarm_health = (
    swarmIntelligence.collective_decision_score +
    swarmIntelligence.communication_quality +
    swarmIntelligence.coordination_efficiency
  ) / 3;
  
  // Generate recommendations
  if (swarmIntelligence.communication_quality < 0.7) {
    swarmIntelligence.recommendations.push("Communication quality degraded - check mesh network");
  }
  
  if (swarmIntelligence.coordination_efficiency < 0.6) {
    swarmIntelligence.recommendations.push("Low coordination efficiency - optimize swarm formation");
  }
  
  return swarmIntelligence;
}

function prioritizeMissions(drones, zones) {
  const missionPriorities = {
    critical_missions: [],
    high_priority_missions: [],
    medium_priority_missions: [],
    low_priority_missions: [],
    recommendations: []
  };
  
  // Categorize missions by priority
  zones.forEach(zone => {
    const assignedDrones = drones.filter(d => d.zone === zone.id);
    const mission = {
      zone_id: zone.id,
      priority: zone.priority,
      assigned_drones: assignedDrones.length,
      required_drones: Math.ceil(zone.priority / 3)
    };
    
    if (zone.priority >= 8) {
      missionPriorities.critical_missions.push(mission);
    } else if (zone.priority >= 6) {
      missionPriorities.high_priority_missions.push(mission);
    } else if (zone.priority >= 4) {
      missionPriorities.medium_priority_missions.push(mission);
    } else {
      missionPriorities.low_priority_missions.push(mission);
    }
  });
  
  // Generate prioritization recommendations
  if (missionPriorities.critical_missions.length > 0) {
    missionPriorities.recommendations.push("CRITICAL missions detected - deploy all available resources");
  }
  
  const understaffedMissions = [...missionPriorities.critical_missions, ...missionPriorities.high_priority_missions]
    .filter(m => m.assigned_drones < m.required_drones);
  
  if (understaffedMissions.length > 0) {
    missionPriorities.recommendations.push(`${understaffedMissions.length} missions understaffed - reassign drones`);
  }
  
  return missionPriorities;
}

function generateEmergencyProtocols(drones) {
  const emergencyProtocols = {
    active_emergencies: [],
    emergency_level: "normal",
    protocols_activated: [],
    recommendations: []
  };
  
  // Check for emergency conditions
  drones.forEach(drone => {
    if (drone.battery < 15) {
      emergencyProtocols.active_emergencies.push({
        drone: drone.callsign,
        type: "battery_emergency",
        severity: "critical",
        action: "immediate_rtl"
      });
    }
    
    if (drone.emergency_rtl) {
      emergencyProtocols.active_emergencies.push({
        drone: drone.callsign,
        type: "emergency_rtl",
        severity: "high",
        action: "monitor_return"
      });
    }
    
    if (drone.component_health) {
      Object.entries(drone.component_health).forEach(([component, health]) => {
        if (health < 0.5) {
          emergencyProtocols.active_emergencies.push({
            drone: drone.callsign,
            type: "component_failure",
            component: component,
            severity: "critical",
            action: "immediate_maintenance"
          });
        }
      });
    }
  });
  
  // Determine overall emergency level
  const criticalEmergencies = emergencyProtocols.active_emergencies.filter(e => e.severity === "critical");
  if (criticalEmergencies.length > 0) {
    emergencyProtocols.emergency_level = "critical";
    emergencyProtocols.protocols_activated.push("emergency_response_protocol");
  } else if (emergencyProtocols.active_emergencies.length > 0) {
    emergencyProtocols.emergency_level = "elevated";
    emergencyProtocols.protocols_activated.push("heightened_monitoring");
  }
  
  // Generate emergency recommendations
  if (emergencyProtocols.emergency_level === "critical") {
    emergencyProtocols.recommendations.push("CRITICAL EMERGENCY - Activate all emergency protocols");
  }
  
  if (criticalEmergencies.length > 2) {
    emergencyProtocols.recommendations.push("Multiple critical emergencies - consider emergency landing");
  }
  
  return emergencyProtocols;
}

server.listen(5000, () => {
  console.log("🚀 Server running on port 5000");
});

// Socket.io: accept frontend control commands and forward to MQTT
io.on("connection", (socket) => {
  console.log("🔌 Frontend connected", socket.id);

  // Generic command handler: { droneId, cmd }
  socket.on("command", ({ droneId, cmd }) => {
    try {
      if (!droneId || !cmd) return;
      const topic = `drone/${droneId}/command`;
      client.publish(topic, JSON.stringify({ cmd }));
      console.log("➡️ MQTT command", topic, cmd);
    } catch (e) {
      console.error("command emit error", e);
    }
  });

  // Basic drone controls
  socket.on("start-drone", (droneId) => {
    if (!droneId) return;
    const topic = `drone/${droneId}/command`;
    client.publish(topic, JSON.stringify({ cmd: "takeoff" }));
    console.log("➡️ MQTT takeoff", topic);
  });

  socket.on("return-home", (droneId) => {
    if (!droneId) return;
    const topic = `drone/${droneId}/command`;
    client.publish(topic, JSON.stringify({ cmd: "rtl" }));
    console.log("➡️ MQTT rtl", topic);
  });

  socket.on("drop-cargo", ({ droneId, anchor }) => {
    if (!droneId) return;
    if (anchor && typeof anchor.lat === "number" && typeof anchor.lng === "number") {
      const adjusted = {
        lat: anchor.lat + 0.00009, // ~10m north
        lng: anchor.lng + 0.00000
      };
      io.emit("pre-drop-adjust", { droneId, target: adjusted });
    }
    const topic = `drone/${droneId}/command`;
    client.publish(topic, JSON.stringify({ cmd: "drop" }));
    console.log("➡️ MQTT drop", topic);
  });

  // AI/ML controls
  socket.on("enable-autonomous", (droneId) => {
    if (!droneId) return;
    const topic = `drone/${droneId}/command`;
    client.publish(topic, JSON.stringify({ cmd: "autonomous_on" }));
    console.log("➡️ MQTT autonomous_on", topic);
  });

  socket.on("disable-autonomous", (droneId) => {
    if (!droneId) return;
    const topic = `drone/${droneId}/command`;
    client.publish(topic, JSON.stringify({ cmd: "autonomous_off" }));
    console.log("➡️ MQTT autonomous_off", topic);
  });

  socket.on("assign-zone", ({ droneId, zoneId, priority }) => {
    if (!droneId) return;
    const topic = `drone/${droneId}/command`;
    client.publish(topic, JSON.stringify({ 
      cmd: "assign_zone", 
      zone: zoneId, 
      priority: priority || 5 
    }));
    console.log("➡️ MQTT assign_zone", topic, zoneId);
  });

  // Mission assignment
  socket.on("assign-mission", (mission) => {
    try {
      if (!mission || !Array.isArray(mission.waypoints) || mission.waypoints.length === 0) return;
      const topic = `mission/demo/assign`;
      client.publish(topic, JSON.stringify({ waypoints: mission.waypoints }));
      console.log("➡️ MQTT mission assign", topic, mission.waypoints[0]);
    } catch (e) {
      console.error("assign-mission error", e);
    }
  });

  // Zone management
  socket.on("create-zone", (zoneData) => {
    const zoneId = zoneData.id || `zone_${Date.now()}`;
    disasterZones[zoneId] = {
      ...zoneData,
      id: zoneId,
      created_at: Date.now()
    };
    io.emit("zone-created", disasterZones[zoneId]);
    console.log("➡️ Zone created", zoneId);
  });

  socket.on("disconnect", () => {
    console.log("🔌 Frontend disconnected", socket.id);
  });
});

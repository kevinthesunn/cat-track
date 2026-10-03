// Telemetry simulator: streams machine sensor readings; out-of-range readings become
// telemetry observations that flow through the same memory pipeline as voice reports.
import { q, nowIso } from './db.js';
import { publish } from './events.js';
import { ingestReport } from './pipeline.js';

const METRICS = {
  'Off-Highway Truck': [['coolant_temp', '°C', 88, 6, 104], ['payload', 't', 82, 8, null], ['speed', 'km/h', 28, 9, null]],
  'Hydraulic Excavator': [['hyd_oil_temp', '°C', 72, 7, 95], ['engine_load', '%', 64, 14, null], ['coolant_temp', '°C', 85, 5, 104]],
  'Track-Type Dozer': [['coolant_temp', '°C', 86, 5, 104], ['engine_load', '%', 70, 12, null]],
  'Wheel Loader': [['trans_oil_temp', '°C', 80, 7, 110], ['coolant_temp', '°C', 86, 5, 104]],
  'Motor Grader': [['coolant_temp', '°C', 84, 5, 104], ['engine_load', '%', 52, 12, null]],
};

const ANOMALY_TEXT = {
  coolant_temp: (v, t) => `Telemetry anomaly: high coolant temperature ${v}°C (threshold ${t}°C), CID 110 FMI 15 logged.`,
  hyd_oil_temp: (v, t) => `Telemetry anomaly: hydraulic oil running hot at ${v}°C (threshold ${t}°C), hydraulic system overheating warning.`,
  trans_oil_temp: (v, t) => `Telemetry anomaly: transmission oil high temp ${v}°C (threshold ${t}°C), transmission warning.`,
};

let timer = null;
let tick = 0;
const lastAnomaly = new Map();

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

async function step() {
  tick++;
  const assets = q.all(`SELECT a.*, s.climate FROM assets a LEFT JOIN sites s ON s.id = a.site_id WHERE a.status <> 'down'`);
  if (!assets.length) return;
  const at = nowIso();
  const readings = [];
  const hotAssets = assets.filter((x) => /hot/i.test(x.climate || ''));
  const spikeAsset = tick % 6 === 0 && hotAssets.length ? hotAssets[(tick / 6) % hotAssets.length] : null;
  let spiked = false;
  for (const a of assets) {
    const hot = /hot/i.test(a.climate || '') ? 4 : 0;
    for (const [metric, unit, base, spread, threshold] of METRICS[a.family] || []) {
      let value = base + gauss() * spread + (threshold ? hot : 0);
      // Every 6th tick push one hot-site machine over a threshold so the pipeline has something to catch.
      if (threshold && spikeAsset && a.id === spikeAsset.id && !spiked) {
        value = threshold + 2 + Math.random() * 5;
        spiked = true;
      }
      value = Math.round(value * 10) / 10;
      readings.push({ asset_id: a.id, metric, value, unit, threshold });
      q.run('INSERT INTO telemetry (asset_id, metric, value, unit, created_at) VALUES (?, ?, ?, ?, ?)', a.id, metric, value, unit, at);
    }
    q.run('UPDATE assets SET smu_hours = smu_hours + 0.05, fuel_pct = MAX(5, fuel_pct - 0.2) WHERE id = ?', a.id);
  }
  publish('telemetry', { at, readings });
  for (const r of readings) {
    if (!r.threshold || r.value <= r.threshold) continue;
    const key = `${r.asset_id}|${r.metric}`;
    if (Date.now() - (lastAnomaly.get(key) || 0) < 5 * 60 * 1000) continue; // de-duplicate per machine+metric
    lastAnomaly.set(key, Date.now());
    const text = (ANOMALY_TEXT[r.metric] || ((v, t) => `Telemetry anomaly: ${r.metric} ${v}${r.unit} over threshold ${t}${r.unit}.`))(Math.round(r.value), r.threshold);
    try {
      await ingestReport({ assetId: r.asset_id, source: 'telemetry', text, forceRules: true });
    } catch (err) { console.warn('[telemetry] ingest failed:', err.message); }
  }
  q.run(`DELETE FROM telemetry WHERE created_at < ?`, new Date(Date.now() - 6 * 3600 * 1000).toISOString());
}

export function setTelemetry(on, intervalMs = 5000) {
  if (on && !timer) {
    timer = setInterval(() => { step().catch((e) => console.warn('[telemetry]', e.message)); }, intervalMs);
    step().catch(() => {});
  } else if (!on && timer) {
    clearInterval(timer); timer = null;
  }
  publish('telemetry-status', { on: Boolean(timer) });
  return Boolean(timer);
}

export const telemetryOn = () => Boolean(timer);

export function latestTelemetry() {
  return q.all(`SELECT t.asset_id, t.metric, t.value, t.unit, t.created_at FROM telemetry t
    JOIN (SELECT asset_id, metric, MAX(id) AS mid FROM telemetry GROUP BY asset_id, metric) x ON x.mid = t.id`);
}

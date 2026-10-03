// Demo fleet + 4 months of history, replayed through the real pipeline so the knowledge graph,
// engineering cases and machine memory are built exactly as they would be from live data.
// All people, serials and history are fictional demo data.
import { q, nowIso } from './db.js';
import { ingestReport } from './pipeline.js';
import { recomputeAssetState } from './memory.js';
import { upsertNode, upsertEdge, nodeId } from './graph.js';

const DAY = 86400000;
const ago = (days, hour = 10) => {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, (days * 37) % 60, 0, 0);
  return d.toISOString();
};

const SITES = [
  ['S1', 'Riverside Highway Expansion', 'Peoria, IL', 'Temperate, wet spring', 40.69, -89.59],
  ['S2', 'North Ridge Quarry', 'Tucson, AZ', 'Hot & dusty (40°C+ summer)', 32.22, -110.97],
  ['S3', 'Harbor Logistics Park', 'Houston, TX', 'Hot, humid, frequent rain', 29.76, -95.37],
];

const PEOPLE = [
  ['p-maria', 'Maria Santos', 'operator', 'S1', null], ['p-jake', 'Jake Thompson', 'operator', 'S1', null],
  ['p-luis', 'Luis Romero', 'operator', 'S2', null], ['p-dana', 'Dana Whitfield', 'operator', 'S2', null],
  ['p-ahmed', 'Ahmed Khan', 'operator', 'S3', null],
  ['p-priya', 'Priya Patel', 'technician', 'S1', 'Field service'], ['p-tom', 'Tom Becker', 'technician', 'S2', 'Field service'],
  ['p-grace', 'Grace Liu', 'technician', 'S3', 'Field service'],
  ['p-rachel', 'Rachel Kim', 'site_manager', 'S1', null], ['p-marcus', 'Marcus Lee', 'site_manager', 'S2', null],
  ['p-nina', 'Nina Alvarez', 'site_manager', 'S3', null],
  ['p-omar', 'Omar Haddad', 'safety_officer', null, 'HSE'],
  ['p-olivia', 'Olivia Grant', 'fleet_manager', null, 'Fleet'],
  ['p-sam', 'Dr. Sam Okafor', 'cat_engineer', null, 'Hydraulics'], ['p-elena', 'Elena Ruiz', 'cat_engineer', null, 'Powertrain & cooling'],
];

// id, model, family, serial, site, year, hours, fuel, lastServiceDaysAgo, lastServiceHours, operator
const ASSETS = [
  ['EX-0412', 'Cat 336', 'Hydraulic Excavator', 'DKX03412', 'S1', 2022, 6240, 64, 21, 5990, 'p-maria'],
  ['EX-0519', 'Cat 320', 'Hydraulic Excavator', 'JFE10519', 'S1', 2023, 3110, 81, 26, 3000, 'p-maria'],
  ['DZ-0107', 'Cat D6', 'Track-Type Dozer', 'GTR00107', 'S1', 2021, 7880, 47, 45, 7520, 'p-jake'],
  ['MG-0058', 'Cat 140', 'Motor Grader', 'N9K00058', 'S1', 2020, 9420, 72, 15, 9100, 'p-jake'],
  ['EX-0388', 'Cat 336', 'Hydraulic Excavator', 'DKX02388', 'S2', 2021, 8150, 58, 60, 7700, 'p-luis'],
  ['HT-0761', 'Cat 777', 'Off-Highway Truck', 'TRX10761', 'S2', 2019, 14300, 39, 39, 13950, 'p-dana'],
  ['HT-0764', 'Cat 777', 'Off-Highway Truck', 'TRX10764', 'S2', 2020, 12050, 66, 80, 11550, 'p-luis'],
  ['WL-0233', 'Cat 950', 'Wheel Loader', 'M5W00233', 'S2', 2022, 5400, 70, 29, 5150, 'p-dana'],
  ['DZ-0145', 'Cat D8', 'Track-Type Dozer', 'FMC00145', 'S2', 2020, 10200, 55, 50, 9800, 'p-luis'],
  ['EX-0601', 'Cat 336', 'Hydraulic Excavator', 'DKX04601', 'S3', 2023, 2870, 77, 120, 2500, 'p-ahmed'],
  ['WL-0241', 'Cat 966', 'Wheel Loader', 'L8S00241', 'S3', 2021, 6900, 61, 70, 6450, 'p-ahmed'],
];

// daysAgo, asset, person, source, text
const HISTORY = [
  [120, 'EX-0601', 'p-grace', 'inspection', 'New machine delivered and commissioned, operator walkthrough completed.'],
  [80, 'HT-0761', 'p-tom', 'repair', 'PM 500 hour service completed, oil and filters changed, fluid samples sent.'],
  [70, 'EX-0412', 'p-maria', 'inspection', 'Daily walkaround complete, all good, greased the bucket pins.'],
  [62, 'EX-0388', 'p-luis', 'voice', 'Hydraulic oil leaking from the hose at the boom foot, looks like the hose is rubbing on the frame bracket.'],
  [60, 'EX-0388', 'p-tom', 'repair', 'Replaced chafed boom hose like for like and added a clamp at the boom foot bracket.'],
  [55, 'HT-0761', 'p-dana', 'voice', 'Coolant temperature warning on the grade, engine running hot. 108 degrees F out and very dusty.'],
  [48, 'DZ-0107', 'p-jake', 'voice', 'Squealing noise from the front idler on the left track, worse in the mud.'],
  [45, 'DZ-0107', 'p-priya', 'repair', 'Adjusted track tension and greased the idler, noise reduced.'],
  [41, 'HT-0764', 'p-luis', 'voice', 'Engine overheating again on the grade, code CID 110 FMI 15 came up. Radiator looks packed with dust.'],
  [39, 'HT-0761', 'p-tom', 'repair', 'Blew out radiator and cooler cores, replaced fan belt, coolant topped up.'],
  [34, 'EX-0412', 'p-maria', 'voice', 'Seeing oil seeping at the boom hose near the boom foot, small drip after the shift.'],
  [30, 'WL-0233', 'p-dana', 'voice', 'Brakes feel soft when loaded on the ramp, takes longer to stop.'],
  [29, 'WL-0233', 'p-tom', 'repair', 'Bled brake system and replaced worn brake pads, tested OK.'],
  [27, 'EX-0519', 'p-maria', 'voice', 'DEF warning light came on and the engine went into derate, lost power digging.'],
  [26, 'EX-0519', 'p-priya', 'repair', 'Replaced DEF sensor and cleared codes, regen completed.'],
  [25, 'HT-0764', null, 'telemetry', 'Telemetry anomaly: high coolant temperature 109°C (threshold 104°C), CID 110 FMI 15 logged. Ambient 41°C.'],
  [21, 'EX-0601', 'p-ahmed', 'voice', 'Boom hose is leaking again where it rubs against the frame, oil all over the cylinder. Hot day today.'],
  [20, 'EX-0519', 'p-jake', 'voice', 'Soft ground near the trench edge on the north side, bucket almost slid in. Need to keep machines back.'],
  [18, 'DZ-0145', 'p-luis', 'voice', 'Ripper cylinder drifting down slowly, small seep at the rod seal.'],
  [16, 'MG-0058', 'p-jake', 'voice', 'Moldboard cutting edge is worn down, about time to flip it.'],
  [15, 'MG-0058', 'p-priya', 'repair', 'Flipped moldboard cutting edge and replaced end bits.'],
  [15, 'WL-0241', 'p-ahmed', 'voice', 'Transmission shifting hard between 2nd and 3rd gear, clunk when it shifts.'],
  [12, 'HT-0764', 'p-dana', 'voice', 'Coolant temp climbing into the red by mid afternoon, really hot day, 112 F. Had to idle it down.'],
  [10, 'HT-0764', 'p-dana', 'voice', 'Near miss at the blind corner on the haul road, a pickup pulled out in front of my truck. Need a spotter there.'],
  [9, 'EX-0412', 'p-jake', 'voice', 'Boom hose leaking bad at the foot, spraying a fine mist under load. Shut it down.'],
  [8, 'EX-0412', 'p-priya', 'repair', 'Replaced boom hose, re-routed it away from the frame bracket and installed abrasion sleeve.'],
  [7, 'WL-0233', 'p-dana', 'voice', 'Cab AC blowing warm air, really hot afternoon in the cab.'],
  [6, 'DZ-0107', 'p-maria', 'voice', 'Left track idler grinding again and the track looks loose.'],
  [4, 'EX-0388', 'p-luis', 'voice', 'Swing is slow to respond and there is a whine from the hydraulic pump once the oil heats up.'],
  [3, 'HT-0761', 'p-luis', 'voice', 'Engine running hot again pulling loaded up the ramp, CID 110 FMI 15 active. Dusty as usual.'],
  [2, 'WL-0241', 'p-ahmed', 'voice', 'Transmission still shifting hard, now slipping out of gear on the ramp after the rain.'],
  [1, 'EX-0601', 'p-ahmed', 'voice', 'Backup alarm not working on the excavator, ground crew working close by.'],
];

// model, component, symptom, title, steps, source, author, success, fail
const FIXES = [
  ['Cat 336', 'Hydraulic hose', 'Leak', 'Re-route boom-foot hose clear of frame bracket + abrasion sleeve and P-clamp', 'Relieve hydraulic pressure → replace damaged hose → re-route clear of the frame bracket → fit abrasion sleeve and P-clamp → run and check for leaks at full stroke.', 'field', 'Priya Patel', 4, 1],
  ['Cat 336', 'Hydraulic hose', 'Leak', 'Replace boom hose like-for-like', 'Replace the leaking hose with the same routing.', 'field', 'Tom Becker', 1, 3],
  ['Cat 777', 'Cooling system', 'Overheating', 'Clean radiator & cooler cores every 250 h (100 h at dusty sites); verify fan drive speed', 'Blow out radiator, ATAAC and oil cooler cores from the fan side → check fan belt and fan drive speed against spec → verify coolant concentration and level.', 'engineering', 'Elena Ruiz', 5, 1],
  ['Cat D6', 'Idlers & rollers', 'Abnormal noise', 'Set track tension to spec and inspect idler bearings/seals', 'Measure sag → adjust tension → inspect front idler for seal leakage and bearing play.', 'field', 'Priya Patel', 2, 1],
  ['Cat 320', 'Aftertreatment (DPF/DEF)', 'Engine derate', 'Check DEF quality, replace DEF/NOx sensor, run forced regen', 'Test DEF concentration → inspect sensor connector → replace sensor if out of range → clear codes and run a parked regen.', 'field', 'Priya Patel', 3, 0],
  ['Cat 950', 'Brakes', null, 'Bleed brake circuit and inspect pads/discs', 'Bleed service brake circuit → measure pad thickness → replace worn pads → road test loaded on grade.', 'field', 'Tom Becker', 2, 0],
  [null, 'Cab & HVAC', 'Not cooling / no airflow', 'Clean cab air filters and condenser; check refrigerant charge', 'Replace fresh/recirc filters → wash condenser → check refrigerant pressures.', 'field', 'Tom Becker', 3, 1],
  ['Cat 966', 'Transmission', 'Erratic operation', 'Check transmission oil level/condition and run clutch calibration with Cat ET', 'Check oil level hot → sample for contamination → run transmission clutch calibration.', 'field', 'Grace Liu', 1, 0],
];

export function needsSeed() {
  return q.get('SELECT COUNT(*) AS n FROM assets').n === 0;
}

export async function seed() {
  const t0 = Date.now();
  for (const s of SITES) q.run('INSERT INTO sites (id, name, location, climate, lat, lng) VALUES (?, ?, ?, ?, ?, ?)', ...s);
  for (const p of PEOPLE) q.run('INSERT INTO people (id, name, role, site_id, specialty) VALUES (?, ?, ?, ?, ?)', ...p);
  for (const [id, model, family, serial, site, year, hours, fuel, svcDays, svcHours, op] of ASSETS) {
    q.run(`INSERT INTO assets (id, model, family, serial, site_id, year, smu_hours, fuel_pct, status, health, last_service_at, last_service_hours, commissioned_at, operator_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'operational', 95, ?, ?, ?, ?, ?)`,
      id, model, family, serial, site, year, hours, fuel, ago(svcDays), svcHours, `${year}-03-15T12:00:00.000Z`, op, nowIso());
    const siteRow = q.get('SELECT * FROM sites WHERE id = ?', site);
    const a = upsertNode('asset', id, id, { model, family }, null, ago(150));
    const m = upsertNode('model', model, model, { family }, null, ago(150));
    const sNode = upsertNode('site', site, siteRow.name, { location: siteRow.location }, null, ago(150));
    upsertEdge(a, m, 'INSTANCE_OF', null, ago(150));
    upsertEdge(a, sNode, 'LOCATED_AT', null, ago(150));
  }
  for (const [model, component, symptom, title, steps, source, author, success, fail] of FIXES) {
    q.run(`INSERT INTO fixes (model, component, symptom, title, steps, source, author, success, fail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      model, component, symptom, title, steps, source, author, success, fail, ago(90));
  }

  for (const [days, assetId, personId, source, text] of HISTORY) {
    await ingestReport({ assetId, personId, source, text, createdAt: ago(days, 8 + (days % 9)), forceRules: true, silent: true });
  }

  // Close out history: alerts older than a week, or followed by a repair on the same machine, are resolved.
  const alerts = q.all('SELECT * FROM alerts');
  for (const a of alerts) {
    const repaired = a.asset_id && q.get(`SELECT id FROM reports WHERE asset_id = ? AND category = 'maintenance' AND created_at > ?`, a.asset_id, a.created_at);
    const ageDays = (Date.now() - new Date(a.created_at).getTime()) / DAY;
    if (repaired || ageDays > 7) {
      q.run(`UPDATE alerts SET status = 'resolved', updated_at = ? WHERE id = ?`, a.created_at, a.id);
      q.run(`UPDATE action_items SET status = 'done', done_at = ? WHERE alert_id = ?`, a.created_at, a.id);
    } else if (ageDays > 3) {
      q.run(`UPDATE alerts SET status = 'ack', ack_by = 'p-marcus' WHERE id = ?`, a.id);
    }
  }

  // Engineering has already been working two of the fleet patterns.
  const hoseCase = q.get(`SELECT * FROM eng_cases WHERE case_key = 'Cat 336|Hydraulic hose'`);
  if (hoseCase) {
    q.run(`UPDATE eng_cases SET status = 'investigating', engineer = 'Dr. Sam Okafor', root_cause = 'Suspected hose chafing on boom-foot frame bracket; routing clearance under review' WHERE id = ?`, hoseCase.id);
  }
  const coolCase = q.get(`SELECT * FROM eng_cases WHERE case_key = 'Cat 777|Cooling system'`);
  if (coolCase) {
    const fix = q.get(`SELECT id, title FROM fixes WHERE model = 'Cat 777' AND component = 'Cooling system'`);
    q.run(`UPDATE eng_cases SET status = 'quick_fix_issued', engineer = 'Elena Ruiz', quick_fix = ? WHERE id = ?`, fix.title, coolCase.id);
    q.run('UPDATE fixes SET case_id = ? WHERE id = ?', coolCase.id, fix.id);
    const f = upsertNode('fix', String(fix.id), fix.title.slice(0, 40), { fixId: fix.id, source: 'engineering' }, null, ago(30));
    upsertEdge(f, nodeId('case', String(coolCase.id)), 'RESOLVES', null, ago(30));
    upsertEdge(f, nodeId('model', 'Cat 777'), 'APPLIES_TO', null, ago(30));
    upsertEdge(f, nodeId('component', 'Cooling system'), 'REPAIRS', null, ago(30));
  }
  for (const fix of q.all("SELECT * FROM fixes WHERE source = 'field'")) {
    const f = upsertNode('fix', String(fix.id), fix.title.slice(0, 40), { fixId: fix.id, source: 'field' }, null, ago(60));
    if (fix.component) upsertEdge(f, nodeId('component', fix.component), 'REPAIRS', null, ago(60));
    if (fix.model) upsertEdge(f, nodeId('model', fix.model), 'APPLIES_TO', null, ago(60));
  }

  for (const a of ASSETS) recomputeAssetState(a[0]);
  console.log(`[seed] demo fleet seeded: ${ASSETS.length} machines, ${HISTORY.length} history entries in ${Date.now() - t0} ms`);
}

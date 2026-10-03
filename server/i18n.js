// Language support for everything the server writes itself: detecting the language of a field
// note, the rule engine's own sentences, and the canonical vocabulary names. Entity keys stay
// canonical English everywhere (the graph is shared); only the words people read change.

import { fold } from './vocab.js';

export const LANGS = ['en', 'es', 'hi'];
const NAMES = { en: 'English', es: 'Spanish', hi: 'Hindi' };

export const normalizeLang = (code) => {
  const c = String(code || '').toLowerCase().split(/[-_,;]/)[0].trim();
  return LANGS.includes(c) ? c : null;
};
export const langName = (lang) => NAMES[normalizeLang(lang) || 'en'];
export { fold };

const DEVANAGARI_RE = /[\u0900-\u097F]/;
const ES_DIACRITIC_RE = /[ñ¿¡áéíóúü]/i;
const ES_WORDS = /\b(el|la|los|las|del|esta|estan|está|están|hay|que|por|con|para|una|muy|mas|otra|vez|desde|ayer|hoy|maquina|fuga|fugando|manguera|motor|caliente|calentando|ruido|frenos?|aceite|necesito|necesitamos|tecnico|mecanico|reporte|borra|borrar|elimina|eliminar|arregle|arreglado|cambie|cambiado|reemplace|hacer|debo|puedo|hago|cuando|donde|como|cual|sigue|todavia|otra vez|de nuevo|rampa|cucharon|pluma|oruga|orugas|codigo|alarma|cabina|izquierda|derecha|hidraulico|hidraulica|goteando|chorreando|mantenimiento|servicio|tierra|suelo|blando|zanja)\b/g;
const HI_STRONG = /\b(hai|hain|raha|rahi|rahe|nahi|nahin|kya|karo|karein|karu|karun|diya|gaya|gayi|chahiye|bhejo|bhej|bulao|theek|thik|kharab|bahut|abhi|phir|awaaz|awaz|garam|chal|chalu|band|hatao|mitao|kaise|kab|kahan|kaun|kyun|zyada|thoda|wala|wali|sahi|galat|dekho|dekhna|lagta|lag)\b/g;
const HI_WEAK = /\b(ho|se|ka|ki|ke|me|mein|aur|bhi|kar|par|ko|ne|ye|yeh|woh|wo|hum|main|mujhe|tel|pani|machine|leak)\b/g;
const EN_WORDS = /\b(the|is|are|and|on|from|it|was|with|this|that|has|have|need|please|when|what|should|again|still|getting|worse|today|out|here)\b/g;

const count = (text, re) => new Set(text.match(re) || []).size;

/**
 * Work out which language a field note is in. Script wins outright (Devanagari → hi); otherwise
 * Spanish and Roman-script Hindi are scored on marker words, and the client's hint breaks ties.
 */
export function detectLang(rawText, hint = null) {
  const raw = String(rawText || '');
  if (DEVANAGARI_RE.test(raw)) return 'hi';
  const text = fold(raw);
  const h = normalizeLang(hint);
  if (!text.trim()) return h || 'en';
  const es = count(text, ES_WORDS) + (ES_DIACRITIC_RE.test(raw) ? 2 : 0);
  const hiStrong = count(text, HI_STRONG);
  const hi = hiStrong ? hiStrong + count(text, HI_WEAK) : 0;
  const en = count(text, EN_WORDS);
  if (es >= 2 && es > hi && es >= en) return 'es';
  if (hi >= 2 && hi > es && hi >= en) return 'hi';
  if (h && h !== 'en') {
    // The operator chose this language; a short note without clear markers keeps it unless the note is plainly English.
    if (en >= 3 && es < 2 && hi < 2) return 'en';
    return h;
  }
  return 'en';
}

/* --------------------------------- vocabulary names --------------------------------- */

const VOCAB = {
  es: {
    'Hydraulic hose': 'Manguera hidráulica', 'Boom cylinder': 'Cilindro de la pluma', 'Stick cylinder': 'Cilindro del brazo', 'Bucket & linkage': 'Cucharón y varillaje',
    'Hydraulic pump': 'Bomba hidráulica', 'Swing drive': 'Mando de giro', 'Quick coupler': 'Acoplador rápido', 'Cooling system': 'Sistema de enfriamiento', 'Turbocharger': 'Turbocargador',
    'Aftertreatment (DPF/DEF)': 'Postratamiento (DPF/DEF)', 'Fuel system': 'Sistema de combustible', 'Air intake & filter': 'Admisión de aire y filtro', 'Engine oil system': 'Sistema de aceite del motor',
    'Engine': 'Motor', 'Transmission': 'Transmisión', 'Torque converter': 'Convertidor de par', 'Final drive': 'Mando final', 'Axle & differential': 'Eje y diferencial',
    'Track & undercarriage': 'Orugas y tren de rodaje', 'Idlers & rollers': 'Ruedas guía y rodillos', 'Brakes': 'Frenos', 'Tires': 'Neumáticos', 'Steering': 'Dirección',
    'Electrical system': 'Sistema eléctrico', 'Sensors & display': 'Sensores y pantalla', 'Lights': 'Luces', 'Cab & HVAC': 'Cabina y aire acondicionado', 'Operator controls': 'Controles del operador',
    'Blade': 'Hoja', 'Ripper': 'Desgarrador', 'Ground engaging tools': 'Herramientas de corte (GET)', 'Frame & structure': 'Bastidor y estructura', 'Dump body & hoist': 'Caja de volteo y levante', 'Hydraulic system': 'Sistema hidráulico',
    'Leak': 'Fuga', 'Overheating': 'Sobrecalentamiento', 'Abnormal noise': 'Ruido anormal', 'Vibration': 'Vibración', 'Smoke': 'Humo', 'Engine derate': 'Reducción de potencia (derate)',
    'Loss of power': 'Pérdida de potencia', 'No-start': 'No arranca', 'Warning / fault code': 'Alarma / código de falla', 'Crack / damage': 'Grieta / daño', 'Wear': 'Desgaste',
    'Low pressure': 'Baja presión', 'Low fluid level': 'Nivel de fluido bajo', 'Erratic operation': 'Funcionamiento errático', 'Spongy / weak braking': 'Frenado esponjoso / débil',
    'Not cooling / no airflow': 'No enfría / sin flujo de aire', 'Fluid contamination': 'Contaminación del fluido', 'Burning smell': 'Olor a quemado', 'Electrical fault': 'Falla eléctrica',
    'High ambient heat': 'Calor ambiental alto', 'Wet / muddy ground': 'Terreno mojado / lodoso', 'Dusty': 'Polvo', 'Cold weather': 'Clima frío', 'Night shift': 'Turno de noche',
    'Steep grade': 'Pendiente pronunciada', 'Rocky terrain': 'Terreno rocoso', 'Heavy load / long shift': 'Carga pesada / turno largo', 'Soft ground': 'Terreno blando',
    'Loss of machine control': 'Pérdida de control de la máquina', 'Fire risk': 'Riesgo de incendio', 'Injury': 'Lesión', 'Ground instability': 'Inestabilidad del terreno', 'Near miss': 'Casi accidente',
    'Pedestrian interaction': 'Personal a pie cerca', 'Utility strike risk': 'Riesgo de golpear servicios enterrados', 'Missing safety equipment': 'Falta equipo de seguridad', 'Slip / trip / fall': 'Resbalón / tropiezo / caída', 'Fume exposure': 'Exposición a humos',
    'Critical': 'Crítico', 'High': 'Alto', 'Medium': 'Medio', 'Low': 'Bajo', critical: 'crítico', high: 'alto', medium: 'medio', low: 'bajo',
    open: 'abierto', closed: 'cerrado', resolved: 'resuelto', ack: 'visto', repair: 'reparación', withdrawn: 'retirado', logged: 'registrado', solved: 'resuelto', 'open, seen': 'abierto, visto',
    'Operator': 'Operador', 'Technician': 'Técnico', 'Site manager': 'Jefe de obra', 'Safety officer': 'Encargado de seguridad', 'Fleet manager': 'Gerente de flota', 'CAT engineer': 'Ingeniero de CAT',
    machine: 'la máquina', 'the machine': 'la máquina', 'reported issue': 'el problema reportado', drivetrain: 'el tren de fuerza', problems: 'problemas',
  },
  hi: {
    'Hydraulic hose': 'हाइड्रोलिक होज़', 'Boom cylinder': 'बूम सिलेंडर', 'Stick cylinder': 'स्टिक सिलेंडर', 'Bucket & linkage': 'बकेट और लिंकेज',
    'Hydraulic pump': 'हाइड्रोलिक पंप', 'Swing drive': 'स्विंग ड्राइव', 'Quick coupler': 'क्विक कपलर', 'Cooling system': 'कूलिंग सिस्टम', 'Turbocharger': 'टर्बोचार्जर',
    'Aftertreatment (DPF/DEF)': 'आफ्टरट्रीटमेंट (DPF/DEF)', 'Fuel system': 'फ्यूल सिस्टम', 'Air intake & filter': 'एयर इनटेक और फ़िल्टर', 'Engine oil system': 'इंजन ऑयल सिस्टम',
    'Engine': 'इंजन', 'Transmission': 'ट्रांसमिशन', 'Torque converter': 'टॉर्क कन्वर्टर', 'Final drive': 'फाइनल ड्राइव', 'Axle & differential': 'एक्सल और डिफरेंशियल',
    'Track & undercarriage': 'ट्रैक और अंडरकैरिज', 'Idlers & rollers': 'आइडलर और रोलर', 'Brakes': 'ब्रेक', 'Tires': 'टायर', 'Steering': 'स्टीयरिंग',
    'Electrical system': 'इलेक्ट्रिकल सिस्टम', 'Sensors & display': 'सेंसर और डिस्प्ले', 'Lights': 'लाइटें', 'Cab & HVAC': 'केबिन और एसी', 'Operator controls': 'ऑपरेटर कंट्रोल',
    'Blade': 'ब्लेड', 'Ripper': 'रिपर', 'Ground engaging tools': 'ग्राउंड एंगेजिंग टूल्स (GET)', 'Frame & structure': 'फ्रेम और स्ट्रक्चर', 'Dump body & hoist': 'डंप बॉडी और होइस्ट', 'Hydraulic system': 'हाइड्रोलिक सिस्टम',
    'Leak': 'रिसाव (लीक)', 'Overheating': 'ओवरहीटिंग', 'Abnormal noise': 'असामान्य आवाज़', 'Vibration': 'कंपन', 'Smoke': 'धुआँ', 'Engine derate': 'इंजन डीरेट (पावर कम)',
    'Loss of power': 'पावर की कमी', 'No-start': 'स्टार्ट नहीं हो रहा', 'Warning / fault code': 'चेतावनी / फॉल्ट कोड', 'Crack / damage': 'दरार / नुकसान', 'Wear': 'घिसाव',
    'Low pressure': 'कम प्रेशर', 'Low fluid level': 'फ्लूइड लेवल कम', 'Erratic operation': 'अनियमित संचालन', 'Spongy / weak braking': 'ढीला / कमज़ोर ब्रेक',
    'Not cooling / no airflow': 'ठंडा नहीं कर रहा / हवा नहीं', 'Fluid contamination': 'फ्लूइड में गंदगी', 'Burning smell': 'जलने की गंध', 'Electrical fault': 'इलेक्ट्रिकल खराबी',
    'High ambient heat': 'तेज़ गर्मी', 'Wet / muddy ground': 'गीली / कीचड़ वाली ज़मीन', 'Dusty': 'धूल', 'Cold weather': 'ठंडा मौसम', 'Night shift': 'रात की शिफ्ट',
    'Steep grade': 'तीखी चढ़ाई', 'Rocky terrain': 'पथरीली ज़मीन', 'Heavy load / long shift': 'भारी लोड / लंबी शिफ्ट', 'Soft ground': 'नरम ज़मीन',
    'Loss of machine control': 'मशीन पर नियंत्रण खोना', 'Fire risk': 'आग का खतरा', 'Injury': 'चोट', 'Ground instability': 'ज़मीन अस्थिर', 'Near miss': 'बाल-बाल बचे',
    'Pedestrian interaction': 'पैदल लोग पास में', 'Utility strike risk': 'ज़मीन के नीचे लाइन टकराने का खतरा', 'Missing safety equipment': 'सुरक्षा उपकरण गायब', 'Slip / trip / fall': 'फिसलना / ठोकर / गिरना', 'Fume exposure': 'धुएँ का संपर्क',
    'Critical': 'गंभीर', 'High': 'उच्च', 'Medium': 'मध्यम', 'Low': 'कम', critical: 'गंभीर', high: 'उच्च', medium: 'मध्यम', low: 'कम',
    open: 'खुला', closed: 'बंद', resolved: 'हल हो गया', ack: 'देखा गया', repair: 'मरम्मत', withdrawn: 'वापस लिया', logged: 'दर्ज', solved: 'हल हो गया', 'open, seen': 'खुला, देखा गया',
    'Operator': 'ऑपरेटर', 'Technician': 'टेक्नीशियन', 'Site manager': 'साइट मैनेजर', 'Safety officer': 'सेफ्टी ऑफिसर', 'Fleet manager': 'फ्लीट मैनेजर', 'CAT engineer': 'CAT इंजीनियर',
    machine: 'मशीन', 'the machine': 'मशीन', 'reported issue': 'बताई गई समस्या', drivetrain: 'ड्राइवट्रेन', problems: 'समस्याओं',
  },
};

/** A canonical vocabulary name (component, symptom, condition, hazard, severity, role) in the given language. */
export function vocabName(lang, name) {
  const l = normalizeLang(lang);
  if (!l || l === 'en' || name == null) return name;
  return VOCAB[l][name] ?? name;
}
export const vocabTable = (lang) => VOCAB[normalizeLang(lang)] || {};

/* ------------------------------ the rule engine's sentences ------------------------------ */

const PHRASES = {
  es: {
    // extract.js — action items
    'Stop operation, lower implements to the ground and tag out {asset}': 'Detener la operación, bajar los implementos al suelo y bloquear/etiquetar {asset}',
    'Limit {asset} to light duty until a technician inspects it': 'Limitar {asset} a trabajo liviano hasta que un técnico la revise',
    'Inspect {part} for {problem} on {asset}': 'Revisar {part} por {problem} en {asset}',
    'Place spill containment under the machine; check fluid level before restart': 'Colocar contención de derrames bajo la máquina; revisar el nivel de fluido antes de arrancar',
    'Idle 3–5 min to cool down, then shut off; check coolant level and blow out radiator/cooler cores': 'Dejar en ralentí 3–5 min para enfriar y luego apagar; revisar el nivel de refrigerante y soplar los panales del radiador/enfriadores',
    'Check {part} for loose, worn or failing parts': 'Revisar {part} por piezas sueltas, desgastadas o fallando',
    'Pull the active/logged fault codes with Cat ET and attach to the work order': 'Descargar los códigos de falla activos/registrados con Cat ET y adjuntarlos a la orden de trabajo',
    'Perform crack/weld inspection before the machine returns to production': 'Inspeccionar grietas/soldaduras antes de que la máquina vuelva a producción',
    'Stop work in the affected area and account for all personnel': 'Detener el trabajo en el área afectada y verificar que todo el personal esté a salvo',
    'Establish an exclusion zone / barricade around the hazard': 'Establecer una zona de exclusión / barricada alrededor del peligro',
    'Assign a dedicated spotter at this location': 'Asignar un señalero dedicado en este punto',
    'Call for a utility locate before any further digging': 'Solicitar la localización de servicios enterrados antes de seguir excavando',
    'Keep machines back from the edge; request a geotechnical check': 'Mantener las máquinas alejadas del borde; solicitar una revisión geotécnica',
    'Provide first aid and notify the site safety officer immediately': 'Dar primeros auxilios y avisar de inmediato al encargado de seguridad',
    'Document the hazard and brief the crew at the next toolbox talk': 'Documentar el peligro e informar a la cuadrilla en la próxima charla de seguridad',
    'Review and schedule: {text}': 'Revisar y programar: {text}',
    // extract.js — operator guidance
    "Thanks — logged to this machine's memory. No action needed right now.": 'Gracias — quedó registrado en la memoria de esta máquina. No hace falta hacer nada por ahora.',
    'Stop safely now. Lower all implements, set the parking brake, shut down and move away from the hazard. Your site lead and technician have been alerted.': 'Deténgase con seguridad ahora. Baje todos los implementos, ponga el freno de estacionamiento, apague y aléjese del peligro. Ya se avisó a su jefe de obra y al técnico.',
    'Do not keep working with an active hydraulic leak — pressurised oil can cause injection injuries. Lower the boom, shut down and wait for the technician.': 'No siga trabajando con una fuga hidráulica activa — el aceite a presión puede causar lesiones por inyección. Baje la pluma, apague y espere al técnico.',
    'Reduce load and let the machine idle to cool before shutting down. Never open a hot radiator cap. A technician has been notified.': 'Reduzca la carga y deje la máquina en ralentí para que enfríe antes de apagar. Nunca abra la tapa del radiador caliente. Ya se avisó a un técnico.',
    'Keep to light duty and watch the gauges. A technician has been notified and the site crew alerted.': 'Trabaje liviano y vigile los indicadores. Ya se avisó a un técnico y a la cuadrilla.',
    'Noted. Keep an eye on it this shift and report if it gets worse.': 'Anotado. Vigílelo durante el turno y reporte si empeora.',
    'Stay clear of the hazard and keep others away. Your site manager has been alerted.': 'Manténgase lejos del peligro y no deje que otros se acerquen. Ya se avisó a su jefe de obra.',
    'Service record: {text}': 'Registro de servicio: {text}',
    '{problem} — {part}': '{problem} — {part}',
    '{hazard}: {text}': '{hazard}: {text}',
    // troubleshoot.js
    '{problem} at the {part}': '{problem} en {part}',
    'This is already open on {id} as “{title}” (opened {opened}, {tasks} pending). Your report has been added to it; tell the technician if it has got worse since.': 'Esto ya está abierto en {id} como “{title}” (abierto el {opened}, {tasks} pendientes). Su reporte se agregó ahí; avise al técnico si ha empeorado.',
    '1 task': '1 tarea', '{n} tasks': '{n} tareas',
    'The same problem on {id} was solved on {date} by: {how}. Tell the technician.': 'El mismo problema en {id} se resolvió el {date} así: {how}. Dígaselo al técnico.',
    'Ask the technician to try what worked before on {model}: {title} (worked {worked} of {total} times).': 'Pida al técnico que pruebe lo que funcionó antes en {model}: {title} (funcionó {worked} de {total} veces).',
    'CAT Engineering has a quick fix out for {model} {part}: {fix}.': 'Ingeniería de CAT publicó una solución rápida para {part} de {model}: {fix}.',
    '{title} ({type}, applies to {models}): {excerpt}': '{title} ({type}, aplica a {models}): {excerpt}',
    'Stop if anything looks unsafe, keep to light duty and watch the gauges. The right people on site have been told.': 'Deténgase si algo parece inseguro, trabaje liviano y vigile los indicadores. Ya se avisó a las personas indicadas en la obra.',
    '{date} ({n}d ago): {title} — {severity}, {status}{solved}.': '{date} (hace {n} d): {title} — {severity}, {status}{solved}.',
    '; solved by {how}': '; resuelto así: {how}',
    '{part} comes up in {n} reports on {id}{problem}.{condition}': '{part} aparece en {n} reportes de {id}{problem}.{condition}',
    '; {problem} in {m}': '; {problem} en {m}',
    ' Most often under {condition}.': ' Casi siempre con {condition}.',
    '{code} has been raised on {id} before: {dates}.': '{code} ya se ha presentado en {id}: {dates}.',
    'On this machine, {date}: {how}': 'En esta máquina, {date}: {how}',
    '{title} ({source}, worked {worked} of {total} times on {model})': '{title} ({source}, funcionó {worked} de {total} veces en {model})',
    'CAT Engineering': 'Ingeniería de CAT', 'learned in the field': 'aprendido en campo',
    '{machine} ({model}), {date}: {how}': '{machine} ({model}), {date}: {how}',
    'No earlier report of {what} on {id}; this is the first.': 'No hay reportes anteriores de {what} en {id}; este es el primero.',
    '{code} has not been seen on {id} before.': '{code} no se había visto antes en {id}.',
    'No fix on record yet for {part} {problem} on {model}.': 'Aún no hay una solución registrada para {problem} en {part} de {model}.',
    // agent.js
    'Done — added an action item for **{id}** at {site}.': 'Listo — se agregó una tarea para **{id}** en {site}.',
    '**Latest:**': '**Lo último:**', '**Best known fix:** {title} ({pct}% field success)': '**Mejor solución conocida:** {title} ({pct}% de éxito en campo)',
    'I can answer from the fleet memory. Try: "What\'s wrong with EX-0412?", "Which machines are down?", "Any overheating on the 777s?", or "Show engineering cases". (Configure an AI provider in .env for full natural-language answers.)': 'Puedo responder desde la memoria de la flota. Pruebe: "¿Qué le pasa a EX-0412?", "¿Qué máquinas están paradas?", "¿Hay sobrecalentamiento en los 777?" o "Muestra los casos de ingeniería". (Configure un proveedor de IA en .env para respuestas completas en lenguaje natural.)',
    'Ask me anything about your machines.': 'Pregúnteme lo que quiera sobre sus máquinas.',
    // pipeline.js — what was done with the report
    'Closed the open issue “{title}”, with its tasks.': 'Se cerró el problema abierto “{title}”, con sus tareas.',
    'Saved “{fix}” as a known fix for {model}.': 'Se guardó “{fix}” como solución conocida para {model}.',
    'Which issue did you fix?': '¿Qué problema arregló?',
    '{id} has {n} open issues — pick the one you fixed so it can be closed.': '{id} tiene {n} problemas abiertos — elija el que arregló para cerrarlo.',
    'No open issue on {id} to close — saved as a repair record.': 'No hay ningún problema abierto en {id} que cerrar — se guardó como registro de reparación.',
    'Added this to the open issue “{title}” instead of opening a new one.': 'Se agregó al problema abierto “{title}” en vez de abrir uno nuevo.',
    'No matching open issue, so this was filed as a new one.': 'No hay un problema abierto que coincida, así que se registró como uno nuevo.',
    'Withdrew your earlier report “{summary}” and removed it from its alerts and engineering case.': 'Se retiró su reporte anterior “{summary}” y se quitó de sus alertas y del caso de ingeniería.',
    'Couldn’t tell which earlier report this corrects, so nothing was withdrawn.': 'No se pudo saber qué reporte anterior corrige esto, así que no se retiró nada.',
    'Asked the {who} for: {what}': 'Se pidió al {who}: {what}',
    'Tell the technician what worked before: {fix}.': 'Dígale al técnico lo que funcionó antes: {fix}.',
    'Stop if anything looks unsafe, then describe the problem in a report so the right person is alerted.': 'Deténgase si algo parece inseguro y luego describa el problema en un reporte para que se avise a la persona indicada.',
    'Delete these {n} reports?': '¿Eliminar estos {n} reportes?',
    'That matches {n} reports on {id}. Nothing is deleted until you confirm.': 'Eso coincide con {n} reportes de {id}. No se elimina nada hasta que confirme.',
    '{id} has nothing on record to delete.': '{id} no tiene nada registrado que eliminar.',
    'Which report should be deleted?': '¿Qué reporte se debe eliminar?',
    'More than one report on {id} fits. Pick the one to delete.': 'Más de un reporte de {id} coincide. Elija el que quiere eliminar.',
    'Couldn’t tell which report on {id} you meant. Pick it below, or say it again with the part or the day.': 'No se pudo saber a qué reporte de {id} se refiere. Elíjalo abajo o repítalo mencionando la pieza o el día.',
    // history.js — deletion effects
    'Deleted “{summary}”, reported by {name}.': 'Se eliminó “{summary}”, reportado por {name}.',
    'Deleted “{summary}”.': 'Se eliminó “{summary}”.',
    'Closed its alert “{title}” and {tasks}.': 'Se cerró su alerta “{title}” y {tasks}.',
    'Closed its alert “{title}”.': 'Se cerró su alerta “{title}”.',
    '1 open task': '1 tarea abierta', '{n} open tasks': '{n} tareas abiertas',
    'Reopened “{title}”: the repair that closed it is no longer on record.': 'Se reabrió “{title}”: la reparación que lo cerró ya no está registrada.',
    'Forgot the known fix “{title}” that was learned from it.': 'Se olvidó la solución conocida “{title}” que se aprendió de él.',
    'Took it out of CAT Engineering case #{id}, now {reports}.': 'Se quitó del caso #{id} de Ingeniería de CAT, que ahora tiene {reports}.',
    '1 report': '1 reporte', '{n} reports': '{n} reportes',
    'CAT Engineering case #{id} existed only because of this report, so it was removed.': 'El caso #{id} de Ingeniería de CAT existía solo por este reporte, así que se eliminó.',
    'CAT Engineering case #{id} had no reports left, so it was closed.': 'El caso #{id} de Ingeniería de CAT se quedó sin reportes, así que se cerró.',
    'Took {links} out of the knowledge graph, plus {facts} nothing else mentioned.': 'Se quitaron {links} del grafo de conocimiento, más {facts} que nadie más mencionó.',
    'Took {links} out of the knowledge graph.': 'Se quitaron {links} del grafo de conocimiento.',
    '1 link': '1 enlace', '{n} links': '{n} enlaces', '1 fact': '1 dato', '{n} facts': '{n} datos',
    // agent.js — offline answers
    '**{n} open CAT Engineering cases:**': '**{n} casos abiertos de Ingeniería de CAT:**',
    '- **#{id} {title}** — {n} reports, {priority}, {status}{fix}': '- **#{id} {title}** — {n} reportes, {priority}, {status}{fix}',
    ' · quick fix: {fix}': ' · solución rápida: {fix}',
    '**{n} machines tracked — {bad} need attention:**': '**{n} máquinas en seguimiento — {bad} necesitan atención:**',
    '- **{id}** ({model}, {site}) — {status}, health {health}, {alerts} open alert(s)': '- **{id}** ({model}, {site}) — {status}, salud {health}, {alerts} alerta(s) abierta(s)',
    '- Everything is operational.': '- Todo está operativo.',
    '**From the product library:**': '**De la biblioteca de productos:**',
    '**{id} has 1 related memory entry:**': '**{id} tiene 1 registro relacionado en memoria:**',
    '**{id} has {n} related memory entries:**': '**{id} tiene {n} registros relacionados en memoria:**',
    'No related reports on {id}.': 'No hay reportes relacionados en {id}.',
    '**{id} · {model}** at {site} — {status}, health {health}/100, {hours} SMU h.': '**{id} · {model}** en {site} — {status}, salud {health}/100, {hours} h de horómetro.',
    '**What it remembers:**': '**Lo que recuerda:**',
    '**Found {n} related reports across the fleet:**': '**Se encontraron {n} reportes relacionados en la flota:**',
    'Nothing in memory matches that yet.': 'Todavía no hay nada en la memoria que coincida.',
    operational: 'operativa', attention: 'necesita atención', down: 'parada',
  },
  hi: {
    'Stop operation, lower implements to the ground and tag out {asset}': 'काम रोकें, इम्प्लीमेंट ज़मीन पर रखें और {asset} को टैग-आउट करें',
    'Limit {asset} to light duty until a technician inspects it': 'जब तक टेक्नीशियन जाँच न करे, {asset} से सिर्फ़ हल्का काम लें',
    'Inspect {part} for {problem} on {asset}': '{asset} पर {part} में {problem} की जाँच करें',
    'Place spill containment under the machine; check fluid level before restart': 'मशीन के नीचे स्पिल ट्रे रखें; दोबारा चालू करने से पहले फ्लूइड लेवल जाँचें',
    'Idle 3–5 min to cool down, then shut off; check coolant level and blow out radiator/cooler cores': '3–5 मिनट आइडल पर ठंडा होने दें, फिर बंद करें; कूलेंट लेवल जाँचें और रेडिएटर/कूलर कोर को हवा से साफ़ करें',
    'Check {part} for loose, worn or failing parts': '{part} में ढीले, घिसे या खराब हो रहे पुर्ज़े जाँचें',
    'Pull the active/logged fault codes with Cat ET and attach to the work order': 'Cat ET से एक्टिव/लॉग्ड फॉल्ट कोड निकालें और वर्क ऑर्डर में लगाएँ',
    'Perform crack/weld inspection before the machine returns to production': 'मशीन को काम पर वापस भेजने से पहले दरार/वेल्ड की जाँच करें',
    'Stop work in the affected area and account for all personnel': 'प्रभावित क्षेत्र में काम रोकें और सभी कर्मियों की गिनती करें',
    'Establish an exclusion zone / barricade around the hazard': 'खतरे के चारों ओर बैरिकेड लगाकर क्षेत्र बंद करें',
    'Assign a dedicated spotter at this location': 'इस जगह पर एक समर्पित स्पॉटर तैनात करें',
    'Call for a utility locate before any further digging': 'आगे खुदाई से पहले भूमिगत लाइनों की पहचान करवाएँ',
    'Keep machines back from the edge; request a geotechnical check': 'मशीनों को किनारे से दूर रखें; जियोटेक्निकल जाँच करवाएँ',
    'Provide first aid and notify the site safety officer immediately': 'प्राथमिक उपचार दें और तुरंत साइट सेफ्टी ऑफिसर को बताएँ',
    'Document the hazard and brief the crew at the next toolbox talk': 'खतरे को दर्ज करें और अगली टूलबॉक्स मीटिंग में टीम को बताएँ',
    'Review and schedule: {text}': 'समीक्षा करके शेड्यूल करें: {text}',
    "Thanks — logged to this machine's memory. No action needed right now.": 'धन्यवाद — इस मशीन की मेमोरी में दर्ज हो गया। अभी कुछ करने की ज़रूरत नहीं।',
    'Stop safely now. Lower all implements, set the parking brake, shut down and move away from the hazard. Your site lead and technician have been alerted.': 'अभी सुरक्षित तरीके से रुकें। सभी इम्प्लीमेंट नीचे रखें, पार्किंग ब्रेक लगाएँ, मशीन बंद करें और खतरे से दूर हटें। आपके साइट मैनेजर और टेक्नीशियन को सूचना दे दी गई है।',
    'Do not keep working with an active hydraulic leak — pressurised oil can cause injection injuries. Lower the boom, shut down and wait for the technician.': 'हाइड्रोलिक लीक के साथ काम जारी न रखें — प्रेशर वाला तेल चोट पहुँचा सकता है। बूम नीचे करें, मशीन बंद करें और टेक्नीशियन का इंतज़ार करें।',
    'Reduce load and let the machine idle to cool before shutting down. Never open a hot radiator cap. A technician has been notified.': 'लोड कम करें और बंद करने से पहले मशीन को आइडल पर ठंडा होने दें। गरम रेडिएटर कैप कभी न खोलें। टेक्नीशियन को सूचना दे दी गई है।',
    'Keep to light duty and watch the gauges. A technician has been notified and the site crew alerted.': 'सिर्फ़ हल्का काम करें और गेज पर नज़र रखें। टेक्नीशियन और साइट टीम को सूचना दे दी गई है।',
    'Noted. Keep an eye on it this shift and report if it gets worse.': 'नोट कर लिया। इस शिफ्ट में नज़र रखें और बिगड़े तो बताएँ।',
    'Stay clear of the hazard and keep others away. Your site manager has been alerted.': 'खतरे से दूर रहें और दूसरों को भी दूर रखें। आपके साइट मैनेजर को सूचना दे दी गई है।',
    'Service record: {text}': 'सर्विस रिकॉर्ड: {text}',
    '{problem} — {part}': '{part} — {problem}',
    '{hazard}: {text}': '{hazard}: {text}',
    '{problem} at the {part}': '{part} में {problem}',
    'This is already open on {id} as “{title}” (opened {opened}, {tasks} pending). Your report has been added to it; tell the technician if it has got worse since.': 'यह {id} पर पहले से “{title}” के रूप में खुला है ({opened} को खुला, {tasks} बाकी)। आपकी रिपोर्ट उसमें जोड़ दी गई; अगर हालत बिगड़ी है तो टेक्नीशियन को बताएँ।',
    '1 task': '1 काम', '{n} tasks': '{n} काम',
    'The same problem on {id} was solved on {date} by: {how}. Tell the technician.': '{id} पर यही समस्या {date} को ऐसे ठीक हुई थी: {how}। टेक्नीशियन को बताएँ।',
    'Ask the technician to try what worked before on {model}: {title} (worked {worked} of {total} times).': 'टेक्नीशियन से कहें कि {model} पर पहले काम आया तरीका आज़माएँ: {title} ({total} में से {worked} बार काम आया)।',
    'CAT Engineering has a quick fix out for {model} {part}: {fix}.': 'CAT इंजीनियरिंग ने {model} के {part} के लिए क्विक फिक्स जारी किया है: {fix}।',
    '{title} ({type}, applies to {models}): {excerpt}': '{title} ({type}, {models} पर लागू): {excerpt}',
    'Stop if anything looks unsafe, keep to light duty and watch the gauges. The right people on site have been told.': 'कुछ भी असुरक्षित लगे तो रुक जाएँ, हल्का काम करें और गेज पर नज़र रखें। साइट पर सही लोगों को बता दिया गया है।',
    '{date} ({n}d ago): {title} — {severity}, {status}{solved}.': '{date} ({n} दिन पहले): {title} — {severity}, {status}{solved}।',
    '; solved by {how}': '; ऐसे ठीक हुआ: {how}',
    '{part} comes up in {n} reports on {id}{problem}.{condition}': '{id} की {n} रिपोर्टों में {part} आया है{problem}।{condition}',
    '; {problem} in {m}': '; {m} में {problem}',
    ' Most often under {condition}.': ' ज़्यादातर {condition} में।',
    '{code} has been raised on {id} before: {dates}.': '{code} पहले भी {id} पर आ चुका है: {dates}।',
    'On this machine, {date}: {how}': 'इसी मशीन पर, {date}: {how}',
    '{title} ({source}, worked {worked} of {total} times on {model})': '{title} ({source}, {model} पर {total} में से {worked} बार काम आया)',
    'CAT Engineering': 'CAT इंजीनियरिंग', 'learned in the field': 'फील्ड में सीखा',
    '{machine} ({model}), {date}: {how}': '{machine} ({model}), {date}: {how}',
    'No earlier report of {what} on {id}; this is the first.': '{id} पर {what} की पहले कोई रिपोर्ट नहीं; यह पहली है।',
    '{code} has not been seen on {id} before.': '{code} पहले {id} पर नहीं देखा गया।',
    'No fix on record yet for {part} {problem} on {model}.': '{model} के {part} में {problem} के लिए अभी कोई फिक्स दर्ज नहीं।',
    'Done — added an action item for **{id}** at {site}.': 'हो गया — {site} पर **{id}** के लिए एक काम जोड़ दिया।',
    '**Latest:**': '**ताज़ा:**', '**Best known fix:** {title} ({pct}% field success)': '**सबसे अच्छा ज्ञात फिक्स:** {title} ({pct}% फील्ड सफलता)',
    'I can answer from the fleet memory. Try: "What\'s wrong with EX-0412?", "Which machines are down?", "Any overheating on the 777s?", or "Show engineering cases". (Configure an AI provider in .env for full natural-language answers.)': 'मैं फ्लीट मेमोरी से जवाब दे सकता हूँ। पूछें: "EX-0412 में क्या खराबी है?", "कौन सी मशीनें बंद हैं?", "777 में ओवरहीटिंग है?" या "इंजीनियरिंग केस दिखाओ"। (पूरे जवाबों के लिए .env में AI प्रोवाइडर सेट करें।)',
    'Ask me anything about your machines.': 'अपनी मशीनों के बारे में कुछ भी पूछें।',
    // pipeline.js
    'Closed the open issue “{title}”, with its tasks.': 'खुली समस्या “{title}” उसके कामों सहित बंद कर दी।',
    'Saved “{fix}” as a known fix for {model}.': '“{fix}” को {model} के लिए ज्ञात फिक्स के रूप में सेव किया।',
    'Which issue did you fix?': 'आपने कौन सी समस्या ठीक की?',
    '{id} has {n} open issues — pick the one you fixed so it can be closed.': '{id} पर {n} समस्याएँ खुली हैं — जो आपने ठीक की उसे चुनें ताकि उसे बंद किया जा सके।',
    'No open issue on {id} to close — saved as a repair record.': '{id} पर बंद करने के लिए कोई खुली समस्या नहीं — मरम्मत रिकॉर्ड के रूप में सेव किया।',
    'Added this to the open issue “{title}” instead of opening a new one.': 'नई समस्या खोलने के बजाय इसे खुली समस्या “{title}” में जोड़ दिया।',
    'No matching open issue, so this was filed as a new one.': 'कोई मेल खाती खुली समस्या नहीं मिली, इसलिए इसे नई समस्या के रूप में दर्ज किया।',
    'Withdrew your earlier report “{summary}” and removed it from its alerts and engineering case.': 'आपकी पिछली रिपोर्ट “{summary}” वापस ली और उसे उसके अलर्ट व इंजीनियरिंग केस से हटा दिया।',
    'Couldn’t tell which earlier report this corrects, so nothing was withdrawn.': 'समझ नहीं आया कि यह किस पिछली रिपोर्ट को सुधारती है, इसलिए कुछ वापस नहीं लिया।',
    'Asked the {who} for: {what}': '{who} से कहा: {what}',
    'Tell the technician what worked before: {fix}.': 'टेक्नीशियन को बताएँ कि पहले क्या काम आया था: {fix}।',
    'Stop if anything looks unsafe, then describe the problem in a report so the right person is alerted.': 'कुछ असुरक्षित लगे तो रुक जाएँ, फिर रिपोर्ट में समस्या बताएँ ताकि सही व्यक्ति को सूचना मिले।',
    'Delete these {n} reports?': 'ये {n} रिपोर्टें हटाएँ?',
    'That matches {n} reports on {id}. Nothing is deleted until you confirm.': 'यह {id} की {n} रिपोर्टों से मेल खाता है। आपकी पुष्टि के बिना कुछ नहीं हटेगा।',
    '{id} has nothing on record to delete.': '{id} पर हटाने के लिए कोई रिकॉर्ड नहीं है।',
    'Which report should be deleted?': 'कौन सी रिपोर्ट हटानी है?',
    'More than one report on {id} fits. Pick the one to delete.': '{id} की एक से ज़्यादा रिपोर्टें मेल खाती हैं। जिसे हटाना है उसे चुनें।',
    'Couldn’t tell which report on {id} you meant. Pick it below, or say it again with the part or the day.': 'समझ नहीं आया कि {id} की किस रिपोर्ट की बात है। नीचे से चुनें, या पुर्ज़े या दिन के साथ दोबारा बोलें।',
    // history.js
    'Deleted “{summary}”, reported by {name}.': '“{summary}” हटाई, जिसे {name} ने रिपोर्ट किया था।',
    'Deleted “{summary}”.': '“{summary}” हटाई।',
    'Closed its alert “{title}” and {tasks}.': 'उसका अलर्ट “{title}” और {tasks} बंद किए।',
    'Closed its alert “{title}”.': 'उसका अलर्ट “{title}” बंद किया।',
    '1 open task': '1 खुला काम', '{n} open tasks': '{n} खुले काम',
    'Reopened “{title}”: the repair that closed it is no longer on record.': '“{title}” फिर से खोला: जिस मरम्मत ने इसे बंद किया था वह अब रिकॉर्ड में नहीं है।',
    'Forgot the known fix “{title}” that was learned from it.': 'इससे सीखा गया ज्ञात फिक्स “{title}” हटा दिया।',
    'Took it out of CAT Engineering case #{id}, now {reports}.': 'इसे CAT इंजीनियरिंग केस #{id} से निकाला, अब उसमें {reports}।',
    '1 report': '1 रिपोर्ट', '{n} reports': '{n} रिपोर्टें',
    'CAT Engineering case #{id} existed only because of this report, so it was removed.': 'CAT इंजीनियरिंग केस #{id} सिर्फ़ इसी रिपोर्ट की वजह से था, इसलिए उसे हटा दिया।',
    'CAT Engineering case #{id} had no reports left, so it was closed.': 'CAT इंजीनियरिंग केस #{id} में कोई रिपोर्ट नहीं बची, इसलिए उसे बंद कर दिया।',
    'Took {links} out of the knowledge graph, plus {facts} nothing else mentioned.': 'नॉलेज ग्राफ से {links} हटाए, साथ ही {facts} जिनका और कहीं ज़िक्र नहीं था।',
    'Took {links} out of the knowledge graph.': 'नॉलेज ग्राफ से {links} हटाए।',
    '1 link': '1 लिंक', '{n} links': '{n} लिंक', '1 fact': '1 तथ्य', '{n} facts': '{n} तथ्य',
    // agent.js
    '**{n} open CAT Engineering cases:**': '**CAT इंजीनियरिंग के {n} खुले केस:**',
    '- **#{id} {title}** — {n} reports, {priority}, {status}{fix}': '- **#{id} {title}** — {n} रिपोर्टें, {priority}, {status}{fix}',
    ' · quick fix: {fix}': ' · क्विक फिक्स: {fix}',
    '**{n} machines tracked — {bad} need attention:**': '**{n} मशीनें ट्रैक में — {bad} पर ध्यान चाहिए:**',
    '- **{id}** ({model}, {site}) — {status}, health {health}, {alerts} open alert(s)': '- **{id}** ({model}, {site}) — {status}, सेहत {health}, {alerts} खुले अलर्ट',
    '- Everything is operational.': '- सब कुछ चल रहा है।',
    '**From the product library:**': '**प्रोडक्ट लाइब्रेरी से:**',
    '**{id} has 1 related memory entry:**': '**{id} की मेमोरी में 1 संबंधित रिकॉर्ड है:**',
    '**{id} has {n} related memory entries:**': '**{id} की मेमोरी में {n} संबंधित रिकॉर्ड हैं:**',
    'No related reports on {id}.': '{id} पर कोई संबंधित रिपोर्ट नहीं।',
    '**{id} · {model}** at {site} — {status}, health {health}/100, {hours} SMU h.': '**{id} · {model}**, {site} पर — {status}, सेहत {health}/100, {hours} घंटे SMU।',
    '**What it remembers:**': '**यह याद रखती है:**',
    '**Found {n} related reports across the fleet:**': '**फ्लीट में {n} संबंधित रिपोर्टें मिलीं:**',
    'Nothing in memory matches that yet.': 'मेमोरी में अभी इससे मेल खाता कुछ नहीं है।',
    operational: 'चालू', attention: 'ध्यान चाहिए', down: 'बंद',
  },
};

const interpolate = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : String(s));

/** A sentence of the rule engine's in the given language; English is the key and the fallback. */
export function t(lang, key, vars) {
  const l = normalizeLang(lang);
  const hit = l && l !== 'en' ? PHRASES[l][key] : null;
  return interpolate(hit ?? key, vars);
}

/** A translator bound to one language: tt(key, vars) and tt.v(name) for vocabulary. */
export function translator(lang) {
  const l = normalizeLang(lang) || 'en';
  const fn = (key, vars) => t(l, key, vars);
  fn.lang = l;
  fn.v = (name) => vocabName(l, name);
  fn.lower = (name) => { const v = vocabName(l, name); return l === 'en' ? String(v || '').toLowerCase() : v; };
  return fn;
}

/** Whisper language code + a vocabulary prompt in that language. */
export const STT = {
  en: { code: 'en', prompt: 'Caterpillar job-site report. Hydraulic hose, boom cylinder, stick cylinder, swing drive, idler, final drive, undercarriage, ripper, DEF, DPF, turbo, coolant, CID 110 FMI 15, SPN, fault code, derate.' },
  es: { code: 'es', prompt: 'Reporte de obra Caterpillar. Manguera hidráulica, cilindro de la pluma, cilindro del brazo, mando de giro, rueda guía, mando final, tren de rodaje, desgarrador, DEF, DPF, turbo, refrigerante, CID 110 FMI 15, SPN, código de falla, derate.' },
  hi: { code: 'hi', prompt: 'Caterpillar साइट रिपोर्ट। हाइड्रोलिक होज़, बूम सिलेंडर, स्टिक सिलेंडर, स्विंग ड्राइव, आइडलर, फाइनल ड्राइव, अंडरकैरिज, रिपर, DEF, DPF, टर्बो, कूलेंट, CID 110 FMI 15, SPN, फॉल्ट कोड, डीरेट।' },
};

// Shared vocabulary that keeps the knowledge graph consistent no matter whether a report was
// understood by Claude or by the offline rule engine. Every free-text entity is snapped to a
// canonical name here before it becomes a graph node.
//
// Each entry matches English (`re`), Spanish (`es`) and Hindi (`hi`: Devanagari and Roman-script
// Hinglish). Text is passed through fold() first: lower-case, Latin accents stripped, Devanagari
// nukta stripped — so Spanish patterns are written without accents and Hindi ones without nukta
// (जमीन not ज़मीन). The canonical `name` stays English: it is the graph node's identity.

/** Lower-case and strip Latin diacritics + Devanagari nukta so one pattern matches every spelling. */
export const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f\u093C]/g, '');

export const COMPONENTS = [
  { name: 'Hydraulic hose', system: 'Hydraulics', re: /\bhoses?\b|hydraulic lines?/, es: /manguera|latiguillo|linea hidraulica/, hi: /होज|पाइप|हाइड्रोलिक (लाइन|पाइप)|\bhoj\b|\bpipe\b|hydraulic (line|pipe)/ },
  { name: 'Boom cylinder', system: 'Hydraulics', re: /\bboom\b/, es: /\bpluma\b|aguilon/, hi: /बूम/ },
  { name: 'Stick cylinder', system: 'Hydraulics', re: /\bstick\b|\barm cylinder/, es: /\bbrazo\b|balancin/, hi: /स्टिक|आर्म सिलेंडर/ },
  { name: 'Bucket & linkage', system: 'Implements', re: /\bbucket\b|linkage|\bpins?\b|bushings?/, es: /cucharon|\bbalde\b|cuchara\b|varillaje|pasador|\bbujes?\b/, hi: /बकेट|बाल्टी|लिंकेज|(?<![\u0900-\u097F])पिन(?![\u0900-\u097F])|बुश|\bbalti\b|\bbush/ },
  { name: 'Hydraulic pump', system: 'Hydraulics', re: /hydraulic pump|main pump|implement pump/, es: /bomba hidraulica|bomba principal/, hi: /हाइड्रोलिक पंप|मेन पंप/ },
  { name: 'Swing drive', system: 'Hydraulics', re: /\bswing\b/, es: /\bgiro\b|rotacion de la torre/, hi: /स्विंग|घुमाव|ghumav|ghoom/ },
  { name: 'Quick coupler', system: 'Implements', re: /coupler/, es: /acoplador|enganche rapido/, hi: /कपलर/ },
  { name: 'Cooling system', system: 'Engine', re: /coolant|radiator|water pump|\bfans?\b|thermostat|oil cooler/, es: /refrigerante|anticongelante|radiador|bomba de agua|ventilador|termostato|enfriador/, hi: /कूलेंट|रेडिएटर|वाटर पंप|पंखा|फैन|थर्मोस्टेट|pankha|\bcooler\b/ },
  { name: 'Turbocharger', system: 'Engine', re: /turbo/, es: /turbo/, hi: /टर्बो/ },
  { name: 'Aftertreatment (DPF/DEF)', system: 'Engine', re: /\bdpf\b|\bdef\b|aftertreatment|\bregen|diesel exhaust fluid|particulate/, es: /postratamiento|regeneracion|\burea\b|filtro de particulas/, hi: /डीपीएफ|डीईएफ|(?<![\u0900-\u097F])डेफ(?![\u0900-\u097F])|यूरिया|\burea\b/ },
  { name: 'Fuel system', system: 'Engine', re: /fuel (pump|filter|line|injector|leak|system)|injectors?/, es: /combustible|\bdiesel\b|inyector(es)?|bomba de (combustible|inyeccion)/, hi: /फ्यूल|डीजल|इंजेक्टर|\bdiesel\b|\bfuel\b|tel ki (line|pump)/ },
  { name: 'Air intake & filter', system: 'Engine', re: /air (filter|cleaner|intake)/, es: /filtro de aire|admision/, hi: /एयर फिल्टर|हवा का फिल्टर|\bintake\b/ },
  { name: 'Engine oil system', system: 'Engine', re: /engine oil|oil pressure/, es: /aceite (del )?motor|presion de aceite/, hi: /इंजन ऑयल|इंजन का तेल|ऑयल प्रेशर|engine ka tel/ },
  { name: 'Engine', system: 'Engine', re: /\bengine\b|\bmotor\b/, es: /\bmotor\b/, hi: /इंजन|मोटर/ },
  { name: 'Transmission', system: 'Powertrain', re: /transmission|gearbox|\bgears?\b|shifting|shifts? (hard|rough|late|slow|harsh)/, es: /transmision|caja de cambios|cambios? (duros?|bruscos?)|velocidades/, hi: /ट्रांसमिशन|गियर|गेयर/ },
  { name: 'Torque converter', system: 'Powertrain', re: /torque converter/, es: /convertidor/, hi: /टॉर्क कन्वर्टर/ },
  { name: 'Final drive', system: 'Powertrain', re: /final drive/, es: /mandos? finales?/, hi: /फाइनल ड्राइव/ },
  { name: 'Axle & differential', system: 'Powertrain', re: /\baxles?\b|differential/, es: /\bejes?\b|diferencial/, hi: /एक्सल|डिफरेंशियल/ },
  { name: 'Track & undercarriage', system: 'Undercarriage', re: /\btracks?\b|undercarriage|track chain|track shoes?|track tension/, es: /orugas?\b|\bcadenas?\b|tren de rodaje|zapatas?\b|tension de (la )?oruga|carriles/, hi: /ट्रैक|अंडरकैरिज|(?<![\u0900-\u097F])चेन(?![\u0900-\u097F])|पटरी|\bchain\b|\bpatri\b/ },
  { name: 'Idlers & rollers', system: 'Undercarriage', re: /idlers?|rollers?\b|sprockets?/, es: /ruedas? guia|rodillos?|ruedas? (tensora|loca)|rueda motriz|\bcoronas?\b/, hi: /आइडलर|रोलर|स्प्रोकेट/ },
  { name: 'Brakes', system: 'Powertrain', re: /\bbrakes?\b|braking/, es: /\bfrenos?\b|frenad/, hi: /ब्रेक/ },
  { name: 'Tires', system: 'Chassis', re: /\btires?\b|\btyres?\b|\bflat\b/, es: /neumaticos?|\bllantas?\b|\bgomas?\b|ponchad|pinchad/, hi: /टायर|पंचर|puncture|panchar/ },
  { name: 'Steering', system: 'Chassis', re: /steering/, es: /direccion|volante/, hi: /स्टीयरिंग/ },
  { name: 'Electrical system', system: 'Electrical', re: /batter(y|ies)|alternator|wiring|electrical|\bfuses?\b|\bstarter\b|harness/, es: /bateria|alternador|cableado|electric|fusible|arrancador|\barnes\b/, hi: /बैटरी|अल्टरनेटर|वायरिंग|इलेक्ट्रिक|फ्यूज|स्टार्टर|हार्नेस|\bbijli\b/ },
  { name: 'Sensors & display', system: 'Electrical', re: /sensors?|display|monitor\b|cameras?|gauges?|screen/, es: /sensor|pantalla|monitor|camara|medidor|indicador/, hi: /सेंसर|डिस्प्ले|मॉनिटर|कैमरा|(?<![\u0900-\u097F])गेज(?![\u0900-\u097F])|स्क्रीन/ },
  { name: 'Lights', system: 'Electrical', re: /(?<!warning )(?<!engine )(?<!check )\blights?\b|beacon|headlights?/, es: /\bluz\b|\bluces\b|\bfaros?\b|baliza|torreta/, hi: /(?<!वार्निंग )(?<!चेतावनी )लाइट|हेडलाइट|बीकन|बत्ती|\bbatti\b/ },
  { name: 'Cab & HVAC', system: 'Cab', re: /\bcab\b|air condition|\ba\/c\b|\bhvac\b|heater|\bseat\b|\bdoors?\b|window|wipers?/, es: /cabina|aire acondicionado|calefaccion|asiento|puertas?\b|ventana|limpiaparabrisas|\bvidrio\b/, hi: /केबिन|(?<![\u0900-\u097F])कैब(?![\u0900-\u097F])|(?<![\u0900-\u097F])एसी(?![\u0900-\u097F])|हीटर|(?<![\u0900-\u097F])सीट(?![\u0900-\u097F])|दरवाजा|खिडकी|वाइपर|\bcabin\b|\bac\b|darwaza|khidki/ },
  { name: 'Operator controls', system: 'Cab', re: /joysticks?|pedals?|levers?\b/, es: /joystick|palanca|pedal|mandos? de control|\bcontroles\b/, hi: /जॉयस्टिक|पेडल|लीवर/ },
  { name: 'Blade', system: 'Implements', re: /\bblade\b|moldboard/, es: /\bhoja\b|cuchilla\b|vertedera/, hi: /ब्लेड/ },
  { name: 'Ripper', system: 'Implements', re: /ripper/, es: /desgarrador|escarificador/, hi: /रिपर/ },
  { name: 'Ground engaging tools', system: 'Implements', re: /\bteeth\b|\btooth\b|cutting edge|end bits?/, es: /\bdientes?\b|borde de corte|cuchillas? de corte|\bpuntas?\b/, hi: /दांत|कटिंग एज|\bdaant\b/ },
  { name: 'Frame & structure', system: 'Structure', re: /\bframe\b|\bwelds?\b|chassis|structur/, es: /bastidor|chasis|soldadura|estructur/, hi: /फ्रेम|वेल्ड|चेसिस/ },
  { name: 'Dump body & hoist', system: 'Implements', re: /dump body|truck bed|\bhoist\b/, es: /caja de volteo|\btolva\b|volquete|\blevante\b|caja del camion/, hi: /डंप बॉडी|(?<![\u0900-\u097F])बॉडी(?![\u0900-\u097F])|होइस्ट/ },
  { name: 'Hydraulic system', system: 'Hydraulics', re: /hydraulic/, es: /hidraulic/, hi: /हाइड्रोलिक/ },
];

export const SYMPTOMS = [
  { name: 'Leak', re: /leak|seep|\bdrip|spray(ing|ed)?\b|weep|puddle/, es: /\bfuga|gote|derram|chorre|escurr|charco|perdida de aceite|rezum|mancha de aceite/, hi: /लीक|(?<![\u0900-\u097F])रिस|टपक|बह रह|चू रह|\bris raha|\btapak|\bbah raha|\bchu raha/ },
  { name: 'Overheating', re: /overheat|running hot|runs hot|run hot|too hot|high (coolant |oil |engine |hydraulic )?temp|temp(erature)? (is )?(high|rising|spik|climb|warning)|boil/, es: /recalent|sobrecalent|calentando|muy caliente|temperatura (alta|subiendo|elevada)|se calienta|hirviendo|hierve/, hi: /ओवरहीट|गरम|गर्म(?!ी)|तापमान|\bgaram|\bgarm\b|temperature (zyada|high|badh)|heat ho/ },
  { name: 'Abnormal noise', re: /nois|grind|squeal|squeak|knock|clunk|rattl|whin(e|ing)|\bbang|screech|clank|chatter/, es: /\bruido|rechin|chirri|golpete|traque|zumb|chill|crujid|\bgolpe\b|chasquid/, hi: /आवाज|(?<![\u0900-\u097F])शोर(?![\u0900-\u097F])|खडखड|घिसने की|\bawaa?z\b|\bshor\b|khatkhat|khadkhad|ghis(ne|ti) ki/ },
  { name: 'Vibration', re: /vibrat|shak(e|ing|y)|wobbl/, es: /vibra|tiembl|tembl|bambole/, hi: /कंपन|वाइब्रेशन|हिल रह|कांप|hil raha|\bkaa?mp/ },
  { name: 'Smoke', re: /smok/, es: /\bhumo\b|humea/, hi: /धुआ|धुंआ|\bdhua/ },
  { name: 'Engine derate', re: /derat/, es: /modo (de )?proteccion|se limita la potencia/, hi: /डीरेट/ },
  { name: 'Loss of power', re: /loss of power|lost power|low power|no power\b|sluggish|bogg|\bweak|underpower|lacks? power|slow (to )?respon|responding slow(ly)?|slow (hydraulic|cycle|swing|lift)|sluggish hydraulic/, es: /sin fuerza|sin potencia|falta de (fuerza|potencia)|poca (fuerza|potencia)|\blent[oa]\b|se ahoga|no jala|no tira|\bdebil\b|responde lento/, hi: /पावर (कम|नहीं)|ताकत नहीं|जोर नहीं|धीमा|सुस्त|power (kam|nahi)|taakat nahi|zor nahi|dheema|dhima|\bsust\b|slow (ho|chal)/ },
  { name: 'No-start', re: /won'?t start|no[- ]start|not starting|doesn'?t start|fails? to start|dead battery|won'?t crank/, es: /no arranca|no prende|no enciende|no da marcha|bateria muerta|no gira/, hi: /स्टार्ट नहीं|चालू नहीं|नहीं चल रह|बैटरी डाउन|start nahi|chalu nahi|nahi chal rah|battery (down|dead)|crank nahi/ },
  { name: 'Warning / fault code', re: /warning|alarm|\bfault|error code|check engine|\bcodes?\b|\bcid\b|\bfmi\b|\bspn\b/, es: /alarma|advertencia|codigo|\bfalla\b|testigo|luz de (motor|falla|advertencia)/, hi: /चेतावनी|वार्निंग|अलार्म|(?<![\u0900-\u097F])कोड(?![\u0900-\u097F])|फॉल्ट|(?<![\u0900-\u097F])एरर(?![\u0900-\u097F])/ },
  { name: 'Crack / damage', re: /crack|\bbroke|broken|\bbent\b|damag|\btear\b|\btorn\b|snapp|split|\bdent/, es: /grieta|fisura|rajad|\brot[oa]\b|quebrad|dobl|\bdan[oa]|rasgad|partid|abollad/, hi: /दरार|टूट|(?<![\u0900-\u097F])फट|(?<![\u0900-\u097F])मुड|नुकसान|खराब हो गय|daraar|\btoot|\bphat|\bmud gay|nuksan/ },
  { name: 'Wear', re: /\bwear|\bworn|bald|\bthin(ning)?\b/, es: /desgast|gastad|\blis[oa]\b|delgad/, hi: /घिस|\bghis/ },
  { name: 'Low pressure', re: /low pressure|pressure (drop|low|loss)|lost pressure|losing pressure/, es: /baja presion|presion baja|sin presion|perdida de presion|pierde presion/, hi: /प्रेशर कम|कम प्रेशर|प्रेशर नहीं|pressure (kam|nahi)|kam pressure/ },
  { name: 'Low fluid level', re: /low (oil|coolant|fluid|level)|level (is )?low|top(ped)? (up|off)/, es: /nivel bajo|bajo nivel|poco (aceite|refrigerante)|falta (aceite|refrigerante|liquido)|rellen/, hi: /लेवल कम|कम लेवल|तेल कम|कूलेंट कम|level kam|kam level|tel kam|coolant kam/ },
  { name: 'Erratic operation', re: /erratic|jerk|intermittent|unresponsive|sticking|\bstuck\b|drift|\blag|slipp|shifting hard|hard shift|harsh shift/, es: /erratic|brinca|a tirones|intermitente|no responde|se traba|trabad|atascad|atorad|se pega|se va sol[oa]|se desvia|retard|patina|cambios? (duros?|bruscos?)/, hi: /(?<![\u0900-\u097F])अटक|झटक|रुक-रुक|रुक रुक|(?<![\u0900-\u097F])जाम(?![\u0900-\u097F])|(?<![\u0900-\u097F])फंस|\batak|\bjhatk|ruk ruk|\bjaam\b|\bjam\b|\bphas|\bphans/ },
  { name: 'Spongy / weak braking', re: /spongy|feels? soft|soft pedal|takes longer to stop|won'?t hold|brakes? (are |feel )?weak/, es: /esponjos|pedal (suave|blando)|frena poco|no frena bien|tarda en frenar|no (se )?sostiene|frenos? (debiles?|flojos?)/, hi: /ब्रेक (कमजोर|ढीला|नहीं लग)|पेडल (नरम|ढीला)|brake (kamzor|dheela|nahi lag|weak|soft)|pedal (naram|dheela)/ },
  { name: 'Not cooling / no airflow', re: /blowing (warm|hot)|not cooling|no air ?flow|weak air/, es: /no enfria|aire caliente|sin (flujo de )?aire|poco aire/, hi: /ठंडा नहीं|एसी नहीं|हवा नहीं|thanda nahi|ac nahi|hawa nahi/ },
  { name: 'Fluid contamination', re: /contamina|milky|metal (shavings|particles|flakes)|debris in/, es: /contamina|lechoso|limadura|particulas? (de )?metal|viruta|basura en/, hi: /गंदगी|गंदा तेल|दूधिया|धातु के कण|gandagi|ganda tel|doodhiya|metal (ke )?kan/ },
  { name: 'Burning smell', re: /smell|burning|\bodou?r/, es: /\bolor\b|huele|quemad|quemando/, hi: /जलने की|बदबू|(?<![\u0900-\u097F])गंध(?![\u0900-\u097F])|jalne ki|badbu|\bgandh\b|\bbu aa/ },
  { name: 'Electrical fault', re: /flicker|short(ed|ing)? out|won'?t (turn|power) on|no power to|\bdead\b/, es: /parpade|corto ?circuito|sin corriente|no hay corriente|\bmuert[oa]\b/, hi: /झपक|शॉर्ट|बंद हो गई|करंट नहीं|jhapak|band ho gayi|current nahi/ },
];

export const CONDITIONS = [
  { name: 'High ambient heat', re: /hot (day|weather|afternoon|out|conditions)|\bheat\b|heatwave|scorch|swelter|\b(9[5-9]|1[0-2]\d)\s?°?\s?(f|degrees f)\b|\b(3[5-9]|4\d)\s?°?\s?(c|degrees c)\b/, es: /dia caluroso|mucho calor|hace calor|\bcalor\b|ola de calor|sofocante|bajo el sol/, hi: /गर्मी|(?<![\u0900-\u097F])लू(?![\u0900-\u097F])|धूप|\bgarmi\b|\bloo\b|\bdhoop\b|bahut garam din/ },
  { name: 'Wet / muddy ground', re: /\brain|\bwet\b|\bmud|flood|standing water/, es: /lluvi|mojad|\blodo|\bbarro\b|\bfango\b|inund|agua estancada|encharcad/, hi: /बारिश|गीला|गीली|कीचड|पानी भरा|baa?rish|geel[ai]\b|kee?chad|pani bhara/ },
  { name: 'Dusty', re: /\bdust/, es: /\bpolv/, hi: /धूल|\bdhoo?l\b/ },
  { name: 'Cold weather', re: /cold (start|morning|weather|snap)|freez|\bsnow|\bice\b|\bicy\b|frost/, es: /\bfrio\b|helad|congel|nieve|\bhielo\b|escarcha/, hi: /(?<![\u0900-\u097F])ठंड(?![\u0900-\u097F])|सर्दी|बर्फ|कोहरा|(?<![\u0900-\u097F])पाला(?![\u0900-\u097F])|\bthand\b|\bsardi\b|\bbarf\b|\bkohra\b/ },
  { name: 'Night shift', re: /\bnight|\bdark\b/, es: /\bnoche\b|turno nocturno|oscur/, hi: /(?<![\u0900-\u097F])रात(?![\u0900-\u097F])|नाइट शिफ्ट|अंधेरा|\braat\b|andhera/ },
  { name: 'Steep grade', re: /\bslope|\bgrade\b|incline|\bhill|\bramp\b|\bclimb\b|uphill/, es: /pendiente|\bcuesta\b|subida|\brampa\b|\bloma\b|inclinacion|bajada|\btalud\b/, hi: /चढाई|ढलान|रैंप|पहाडी|उतराई|chadhai|dhalaa?n|\brampa?\b|pahadi|utrai/ },
  { name: 'Rocky terrain', re: /\brock|boulder|shot rock|blast/, es: /\broca|rocos|piedra|pedregos|voladura|escombro/, hi: /पत्थर|चट्टान|पथरीली|ब्लास्ट|patthar|chattan|pathrili/ },
  { name: 'Heavy load / long shift', re: /heavy load|overload|full load|max(imum)? load|long shift|double shift|continuous|all day/, es: /carga pesada|sobrecarga|carga completa|carga maxima|turno largo|doble turno|todo el dia|continuo/, hi: /भारी लोड|ओवरलोड|फुल लोड|लंबी शिफ्ट|डबल शिफ्ट|पूरा दिन|bhari load|lambi shift|poora din|pura din/ },
  { name: 'Soft ground', re: /soft ground|unstable ground|sinking|soft soil/, es: /terreno (blando|suave|inestable|flojo)|suelo (blando|suave|inestable|flojo)|se hunde|hundiendo/, hi: /नरम जमीन|(?<![\u0900-\u097F])धंस|दलदल|naram zamee?n|naram jamee?n|\bdhans|daldal/ },
];

export const HAZARDS = [
  { name: 'Loss of machine control', critical: true, re: /brake fail|no brakes|brakes? (went|gave) out|can'?t stop|couldn'?t stop|runaway|steering (loss|fail)|lost steering|rolled/, es: /sin frenos|fallaron los frenos|falla de frenos|no (pude|puedo|podia) (parar|frenar|detener)|se fue sol[oa]|se me fue|sin direccion|se volco|volcad|fuera de control/, hi: /ब्रेक फेल|ब्रेक नहीं लग|रुक नहीं|नियंत्रण खो|कंट्रोल नहीं|(?<![\u0900-\u097F])पलट|brake fail|brake nahi lag|ruk nahi|control nahi|\bpalat/ },
  { name: 'Fire risk', critical: true, re: /\bfire\b|\bflames?\b/, es: /incendio|\bfuego\b|\bllamas?\b|se prendio|se quema\b/, hi: /आग(?![\u093E-\u094D])|(?<![\u0900-\u097F])लपट|\baag\b|\blapat/ },
  { name: 'Injury', critical: true, re: /injur|\bhurt\b|bleed|first aid|ambulance/, es: /lesion|herid|lastim|sangr|primeros auxilios|ambulancia|accidentad/, hi: /(?<![\u0900-\u097F])चोट(?![\u0900-\u097F])|घायल|(?<![\u0900-\u097F])खून(?![\u0900-\u097F])|प्राथमिक उपचार|एम्बुलेंस|\bchot\b|ghayal|\bkhoon\b/ },
  { name: 'Ground instability', re: /soft ground|unstable|trench|excavation edge|collapse|cave[- ]?in|edge of the (cut|pit)/, es: /terreno (blando|inestable)|suelo (blando|inestable)|\bzanja\b|borde de (la )?excavacion|derrumb|desplom|hundimiento|talud inestable/, hi: /जमीन (धंस|अस्थिर)|(?<![\u0900-\u097F])खाई(?![\u0900-\u097F])|गड्ढे का किनारा|(?<![\u0900-\u097F])ढह|भूस्खलन|zamee?n (dhans|asthir)|\bkhai\b|gaddhe ka kinara|\bdhah/ },
  { name: 'Near miss', re: /near miss|almost (hit|struck)|nearly (hit|struck)|close call/, es: /casi (choco|golpeo|atropello|cae|se cae)|por poco|casi accidente|\bcuasi/, hi: /बाल-बाल|बाल बाल|लगते-लगते|टकराते-टकराते|baal baal|lagte lagte|takrate takrate/ },
  { name: 'Pedestrian interaction', re: /spotter|blind spot|pedestrian|people walking|workers? on foot|ground crew|someone walk/, es: /senalero|punto ciego|peaton|gente caminando|personal a pie|cuadrilla (a pie|en el suelo)|alguien camin/, hi: /स्पॉटर|पैदल|मजदूर पास|लोग चल रहे|ब्लाइंड स्पॉट|\bpaidal\b|log chal rahe|mazdoor paas/ },
  { name: 'Utility strike risk', re: /power lines?|overhead lines?|gas line|water main|buried (cable|line)|utility/, es: /lineas? (electricas?|de alta tension|aereas?)|cables? (electricos?|enterrados?|aereos?)|tuberia de gas|linea de gas|toma de agua|servicios enterrados/, hi: /बिजली की (लाइन|तार)|बिजली के तार|ओवरहेड लाइन|गैस लाइन|पानी की लाइन|दबी हुई केबल|bijli ki (line|taar)|pani ki line|dabi (hui )?cable/ },
  { name: 'Missing safety equipment', re: /seat ?belt|\brops\b|guard (is )?missing|missing guard|fire extinguisher|backup alarm/, es: /cinturon|sin guarda|falta (la )?guarda|protector (falta|roto)|extintor|alarma de (reversa|retroceso)/, hi: /सीट बेल्ट|रोप्स|गार्ड (नहीं|गायब)|अग्निशामक|बैकअप अलार्म|रिवर्स हॉर्न|guard (nahi|gayab)|agnishamak|reverse horn/ },
  { name: 'Slip / trip / fall', re: /slipped (on|and|off)|\bslip (on|and)\b|\btripped\b|\bfell\b|fall (from|off|hazard)|ladder|handrail|grab handle/, es: /resbal|tropez|tropie|me cai|se cayo|\bcaida\b|escalera|pasamanos|agarradera/, hi: /फिसल|ठोकर|गिर गय|गिरने|सीढी|हैंडरेल|\bphisal|\bthokar|gir gay[ai]|\bgirne|seedhi/ },
  { name: 'Fume exposure', re: /fumes|exhaust in (the )?cab|carbon monoxide/, es: /humos? (en|dentro de) la cabina|gases? (de escape|en la cabina)|monoxido|olor a escape|se mete el humo/, hi: /केबिन में धुआ|धुआ केबिन|कार्बन मोनोऑक्साइड|cabin mei?n dhua|dhua cabin/ },
];

/** Does a vocabulary entry match this (folded) text in any language? */
export const matches = (v, text) => v.re.test(text) || (v.es ? v.es.test(text) : false) || (v.hi ? v.hi.test(text) : false);

export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const CATEGORIES = ['mechanical', 'safety', 'maintenance', 'operational', 'observation'];
export const ROLES = ['operator', 'technician', 'site_manager', 'safety_officer', 'fleet_manager'];
export const sevRank = (s) => Math.max(0, SEVERITIES.indexOf(s));

const titleCase = (s) => String(s).trim().replace(/\s+/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** Snap a free-text entity (e.g. from Claude) to the closest canonical vocabulary entry. */
export function canonical(list, raw) {
  const text = fold(raw).trim();
  if (!text) return null;
  const exact = list.find((v) => v.name.toLowerCase() === text);
  if (exact) return exact.name;
  const hit = list.find((v) => matches(v, text));
  return hit ? hit.name : titleCase(raw);
}

export const componentSystem = (name) => COMPONENTS.find((c) => c.name === name)?.system || 'General';

/** Canonical names matched anywhere in the text (any language; the text is folded here). */
export function matchAll(list, text) {
  const f = fold(text);
  return list.filter((v) => matches(v, f)).map((v) => v.name);
}

const FAULT_RE = /\b(CID\s?\d{1,4}(?:\s?FMI\s?\d{1,2})?|SPN\s?\d{1,6}(?:\s?FMI\s?\d{1,2})?|E\d{3,4}(?:-\d)?|[PCBU]\d{4})\b/gi;
export function extractFaultCodes(text) {
  const codes = new Set();
  for (const m of String(text).matchAll(FAULT_RE)) {
    codes.add(m[1].toUpperCase().replace(/\s+/g, ' ').replace(/(CID|SPN|FMI)(\d)/g, '$1 $2'));
  }
  for (const m of String(text).matchAll(/\b(?:fault |error )?code\s+(\d{2,4})\b/gi)) codes.add(`CODE ${m[1]}`);
  return [...codes];
}

export const normalizeCode = (c) => String(c).toUpperCase().trim().replace(/\s+/g, ' ').replace(/(CID|SPN|FMI)(\d)/g, '$1 $2');

/* ------------------------------ job-site issue types ------------------------------ */
// What kind of occurrence a report is, for the map: one icon per type, independent of urgency.
export const ISSUE_TYPES = {
  hazard: 'Safety hazard',
  malfunction: 'Malfunction',
  mechanical: 'Wear & damage',
  weather: 'Weather & ground',
  logistics: 'Logistics',
  maintenance: 'Repair & service',
  note: 'Note or question',
};
const MALFUNCTION_SYMPTOMS = new Set(['Overheating', 'Engine derate', 'Loss of power', 'No-start', 'Warning / fault code', 'Low pressure', 'Erratic operation', 'Spongy / weak braking', 'Not cooling / no airflow', 'Electrical fault', 'Smoke', 'Burning smell']);
const MECHANICAL_SYMPTOMS = new Set(['Leak', 'Abnormal noise', 'Vibration', 'Crack / damage', 'Wear', 'Low fluid level', 'Fluid contamination']);
const CONTROL_PARTS = new Set(['Electrical system', 'Sensors & display', 'Operator controls', 'Lights']);
const CRITICAL_HAZARDS = new Set(HAZARDS.filter((h) => h.critical).map((h) => h.name));
const WEATHER_CONDITIONS = new Set(['High ambient heat', 'Wet / muddy ground', 'Dusty', 'Cold weather', 'Soft ground']);
const WEATHER_RE = /\b(rain(ing|ed)?|storms?|wind(y)?|lightning|heat ?wave|flood(ed|ing)?|fog(gy)?|snow(ing)?|ic(e|y)|mud(dy)?|dust storm|visibility|weather|wash ?out|washed out|puddl)/;
const LOGISTICS_RE = /\b(fuel (truck|delivery|run)|deliver(y|ies|ed)?|parts? (on order|arriv|delay|shortage)|schedul|delay(ed)?|waiting (on|for)|crew|permit|survey|materials?|traffic|staging|loading area|lowboy|transport|shift change|road (closed|blocked)|out of fuel|need(s)? (a |more )?(fuel|parts|operator|spotter))/;

/** Classify a report (row with category, severity, source, raw_text and extraction) into an ISSUE_TYPES key. */
export function issueClass(r) {
  const ex = (typeof r.extraction === 'string' ? (() => { try { return JSON.parse(r.extraction); } catch { return {}; } })() : r.extraction) || {};
  const text = String(r.raw_text || '').toLowerCase();
  const comps = ex.components || []; const syms = ex.symptoms || []; const hazards = ex.safety_hazards || [];
  if (ISSUE_TYPES[ex.issue_override]) return ex.issue_override; // someone set it by hand in the report log
  if (r.category === 'maintenance' || ex.intent === 'resolved') return 'maintenance';
  // A machine fault becomes a safety hazard only when people are clearly at risk right now (a
  // critical hazard on a critical report); otherwise the part and problem say more.
  if (r.category === 'safety' || (hazards.length && (!comps.length || (r.severity === 'critical' && hazards.some((h) => CRITICAL_HAZARDS.has(h)))))) return 'hazard';
  if (!comps.length && !syms.length) {
    if (r.severity === 'critical') return 'hazard'; // critical with no machine part: people or the site are at risk
    if (LOGISTICS_RE.test(text) || ex.intent === 'request_help') return 'logistics';
    if (WEATHER_RE.test(text) || (ex.conditions || []).some((c) => WEATHER_CONDITIONS.has(c))) return 'weather';
    if (r.category === 'operational') return 'logistics';
    return 'note';
  }
  // A part named without anything wrong with it ("fuel truck hasn't shown up") is about supply, not the machine.
  if (!syms.length && !(ex.fault_codes || []).length && (LOGISTICS_RE.test(text) || ex.intent === 'request_help')) return 'logistics';
  const primary = syms.find((s) => s !== 'Warning / fault code') || syms[0];
  if (MECHANICAL_SYMPTOMS.has(primary)) return 'mechanical';
  if (MALFUNCTION_SYMPTOMS.has(primary) || r.source === 'telemetry' || (ex.fault_codes || []).length || comps.some((c) => CONTROL_PARTS.has(c))) return 'malfunction';
  return 'mechanical';
}

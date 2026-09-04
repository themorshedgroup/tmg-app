    const { useState, useEffect, useRef, useMemo } = React;

    function useIsWide(){ const [w,setW]=useState(()=> (typeof window!=='undefined' && window.matchMedia('(min-width:769px)').matches)); useEffect(()=>{ const m=window.matchMedia('(min-width:769px)'); const h=e=>setW(e.matches); m.addEventListener ? m.addEventListener('change',h) : m.addListener(h); return ()=> m.removeEventListener ? m.removeEventListener('change',h) : m.removeListener(h); },[]); return w; }

    // ─── Design tokens (TMG Brand) ───────────────────────────────────
    const C = {
      bg:           '#FCFBF8',
      surface:      '#FFFFFF',
      surfaceHover: '#F3EBDA',
      border:       '#E4DFD4',
      navy:         '#001A4A',
      navyHover:    '#0A2552',
      gold:         '#AD832F',
      goldSoft:     '#C9A45A',
      textPrimary:  '#001A4A',
      textSecondary:'#6B6B6B',
      textMuted:    '#9B9380',
      red:          '#C0392B',
      green:        '#1E6B40',
      amber:        '#B07A00',
      navBg:        '#001A4A',
      fontSans:     "-apple-system, BlinkMacSystemFont, 'Jost', 'Helvetica Neue', Arial, sans-serif",
      fontDisplay:  "'Cormorant Garamond', Georgia, serif",
    };

    const SUPABASE_ANON = 'sb_publishable_Jg-roLg8M-BZJ7dBfjEeig_HIdniPaV';
    function authToken() { return window.SupabaseAuth?._state?.session?.access_token || SUPABASE_ANON; }

    // ─── Per-tool access config ───────────────────────────────────────
    const ACCESS_APPS = [
      { id: 'chat',      label: 'AI Chat',           icon: 'ti-sparkles' },
      { id: 'teamchat',  label: 'Team Chat',         icon: 'ti-message' },
      { id: 'calls',     label: 'Calls',             icon: 'ti-phone' },
      { id: 'kpis',      label: 'KPIs',              icon: 'ti-chart-bar' },
      { id: 'deals',     label: 'Deals',             icon: 'ti-currency-dollar' },
      { id: 'drives',    label: 'Shared Drives',     icon: 'ti-folders' },
      { id: 'directory', label: 'Company Directory', icon: 'ti-users' },
      { id: 'sffu',      label: 'SFFU',              icon: 'ti-messages' },
    ];
    const ACCESS_ROLES = [
      { id: 'operations', label: 'Operations' },
      { id: 'agent',      label: 'Sales Agent' },
      { id: 'tc',         label: 'Transaction Coordinator' },
    ];
    // Operations defaults to ON for every tool (preserving its old all-access),
    // but is now editable per-tool like Sales Agent / Transaction Coordinator.
    const DEFAULT_ACCESS = {
      chat: ['operations', 'agent', 'tc'], teamchat: ['operations', 'agent', 'tc'],
      calls: ['operations', 'agent'], kpis: ['operations', 'agent'], deals: ['operations', 'agent'],
      drives: ['operations', 'agent', 'tc'], directory: ['operations', 'agent', 'tc'], sffu: ['operations', 'tc'],
    };
    // Fill any missing/invalid apps with defaults; keep only configurable roles.
    function normalizeAccess(cfg) {
      const valid = (r) => r === 'operations' || r === 'agent' || r === 'tc';
      // A config saved before Operations was configurable lists no 'operations'
      // anywhere → backfill it ON for every tool (preserve its old always-on access).
      const legacy = cfg && !ACCESS_APPS.some(a => Array.isArray(cfg[a.id]) && cfg[a.id].includes('operations'));
      const out = {};
      ACCESS_APPS.forEach(a => {
        let v = ((cfg && Array.isArray(cfg[a.id])) ? cfg[a.id] : DEFAULT_ACCESS[a.id]) || [];
        v = v.filter(valid);
        if (legacy && !v.includes('operations')) v = ['operations', ...v];
        out[a.id] = v;
      });
      return out;
    }

    // ─── Access / status labels + role helpers ────────────────────────
    const COUNTRIES = [{"c":"AF","n":"Afghanistan"},{"c":"AX","n":"Åland Islands"},{"c":"AL","n":"Albania"},{"c":"DZ","n":"Algeria"},{"c":"AS","n":"American Samoa"},{"c":"AD","n":"Andorra"},{"c":"AO","n":"Angola"},{"c":"AI","n":"Anguilla"},{"c":"AQ","n":"Antarctica"},{"c":"AG","n":"Antigua and Barbuda"},{"c":"AR","n":"Argentina"},{"c":"AM","n":"Armenia"},{"c":"AW","n":"Aruba"},{"c":"AU","n":"Australia"},{"c":"AT","n":"Austria"},{"c":"AZ","n":"Azerbaijan"},{"c":"BS","n":"Bahamas"},{"c":"BH","n":"Bahrain"},{"c":"BD","n":"Bangladesh"},{"c":"BB","n":"Barbados"},{"c":"BY","n":"Belarus"},{"c":"BE","n":"Belgium"},{"c":"BZ","n":"Belize"},{"c":"BJ","n":"Benin"},{"c":"BM","n":"Bermuda"},{"c":"BT","n":"Bhutan"},{"c":"BO","n":"Bolivia"},{"c":"BA","n":"Bosnia and Herzegovina"},{"c":"BW","n":"Botswana"},{"c":"BR","n":"Brazil"},{"c":"IO","n":"British Indian Ocean Territory"},{"c":"BN","n":"Brunei"},{"c":"BG","n":"Bulgaria"},{"c":"BF","n":"Burkina Faso"},{"c":"BI","n":"Burundi"},{"c":"CV","n":"Cabo Verde"},{"c":"KH","n":"Cambodia"},{"c":"CM","n":"Cameroon"},{"c":"CA","n":"Canada"},{"c":"BQ","n":"Caribbean Netherlands"},{"c":"KY","n":"Cayman Islands"},{"c":"CF","n":"Central African Republic"},{"c":"TD","n":"Chad"},{"c":"CL","n":"Chile"},{"c":"CN","n":"China"},{"c":"CX","n":"Christmas Island"},{"c":"CC","n":"Cocos Islands"},{"c":"CO","n":"Colombia"},{"c":"KM","n":"Comoros"},{"c":"CK","n":"Cook Islands"},{"c":"CR","n":"Costa Rica"},{"c":"HR","n":"Croatia"},{"c":"CU","n":"Cuba"},{"c":"CW","n":"Curaçao"},{"c":"CY","n":"Cyprus"},{"c":"CZ","n":"Czechia"},{"c":"CD","n":"Democratic Republic of the Congo"},{"c":"DK","n":"Denmark"},{"c":"DJ","n":"Djibouti"},{"c":"DM","n":"Dominica"},{"c":"DO","n":"Dominican Republic"},{"c":"EC","n":"Ecuador"},{"c":"EG","n":"Egypt"},{"c":"SV","n":"El Salvador"},{"c":"GQ","n":"Equatorial Guinea"},{"c":"ER","n":"Eritrea"},{"c":"EE","n":"Estonia"},{"c":"SZ","n":"Eswatini"},{"c":"ET","n":"Ethiopia"},{"c":"FK","n":"Falkland Islands"},{"c":"FO","n":"Faroe Islands"},{"c":"FJ","n":"Fiji"},{"c":"FI","n":"Finland"},{"c":"FR","n":"France"},{"c":"GF","n":"French Guiana"},{"c":"PF","n":"French Polynesia"},{"c":"TF","n":"French Southern Territories"},{"c":"GA","n":"Gabon"},{"c":"GM","n":"Gambia"},{"c":"GE","n":"Georgia"},{"c":"DE","n":"Germany"},{"c":"GH","n":"Ghana"},{"c":"GI","n":"Gibraltar"},{"c":"GR","n":"Greece"},{"c":"GL","n":"Greenland"},{"c":"GD","n":"Grenada"},{"c":"GP","n":"Guadeloupe"},{"c":"GU","n":"Guam"},{"c":"GT","n":"Guatemala"},{"c":"GG","n":"Guernsey"},{"c":"GN","n":"Guinea"},{"c":"GW","n":"Guinea-Bissau"},{"c":"GY","n":"Guyana"},{"c":"HT","n":"Haiti"},{"c":"VA","n":"Holy See"},{"c":"HN","n":"Honduras"},{"c":"HK","n":"Hong Kong"},{"c":"HU","n":"Hungary"},{"c":"IS","n":"Iceland"},{"c":"IN","n":"India"},{"c":"ID","n":"Indonesia"},{"c":"IR","n":"Iran"},{"c":"IQ","n":"Iraq"},{"c":"IE","n":"Ireland"},{"c":"IM","n":"Isle of Man"},{"c":"IL","n":"Israel"},{"c":"IT","n":"Italy"},{"c":"CI","n":"Ivory Coast"},{"c":"JM","n":"Jamaica"},{"c":"JP","n":"Japan"},{"c":"JE","n":"Jersey"},{"c":"JO","n":"Jordan"},{"c":"KZ","n":"Kazakhstan"},{"c":"KE","n":"Kenya"},{"c":"KI","n":"Kiribati"},{"c":"KW","n":"Kuwait"},{"c":"KG","n":"Kyrgyzstan"},{"c":"LA","n":"Laos"},{"c":"LV","n":"Latvia"},{"c":"LB","n":"Lebanon"},{"c":"LS","n":"Lesotho"},{"c":"LR","n":"Liberia"},{"c":"LY","n":"Libya"},{"c":"LI","n":"Liechtenstein"},{"c":"LT","n":"Lithuania"},{"c":"LU","n":"Luxembourg"},{"c":"MO","n":"Macao"},{"c":"MG","n":"Madagascar"},{"c":"MW","n":"Malawi"},{"c":"MY","n":"Malaysia"},{"c":"MV","n":"Maldives"},{"c":"ML","n":"Mali"},{"c":"MT","n":"Malta"},{"c":"MH","n":"Marshall Islands"},{"c":"MQ","n":"Martinique"},{"c":"MR","n":"Mauritania"},{"c":"MU","n":"Mauritius"},{"c":"YT","n":"Mayotte"},{"c":"MX","n":"Mexico"},{"c":"FM","n":"Micronesia"},{"c":"MD","n":"Moldova"},{"c":"MC","n":"Monaco"},{"c":"MN","n":"Mongolia"},{"c":"ME","n":"Montenegro"},{"c":"MS","n":"Montserrat"},{"c":"MA","n":"Morocco"},{"c":"MZ","n":"Mozambique"},{"c":"MM","n":"Myanmar"},{"c":"NA","n":"Namibia"},{"c":"NR","n":"Nauru"},{"c":"NP","n":"Nepal"},{"c":"NL","n":"Netherlands"},{"c":"NC","n":"New Caledonia"},{"c":"NZ","n":"New Zealand"},{"c":"NI","n":"Nicaragua"},{"c":"NE","n":"Niger"},{"c":"NG","n":"Nigeria"},{"c":"NU","n":"Niue"},{"c":"NF","n":"Norfolk Island"},{"c":"KP","n":"North Korea"},{"c":"MK","n":"North Macedonia"},{"c":"MP","n":"Northern Mariana Islands"},{"c":"NO","n":"Norway"},{"c":"OM","n":"Oman"},{"c":"PK","n":"Pakistan"},{"c":"PW","n":"Palau"},{"c":"PS","n":"Palestine"},{"c":"PA","n":"Panama"},{"c":"PG","n":"Papua New Guinea"},{"c":"PY","n":"Paraguay"},{"c":"PE","n":"Peru"},{"c":"PH","n":"Philippines"},{"c":"PN","n":"Pitcairn"},{"c":"PL","n":"Poland"},{"c":"PT","n":"Portugal"},{"c":"PR","n":"Puerto Rico"},{"c":"QA","n":"Qatar"},{"c":"CG","n":"Republic of the Congo"},{"c":"RE","n":"Réunion"},{"c":"RO","n":"Romania"},{"c":"RU","n":"Russia"},{"c":"RW","n":"Rwanda"},{"c":"BL","n":"Saint Barthélemy"},{"c":"SH","n":"Saint Helena, Ascension and Tristan da Cunha"},{"c":"KN","n":"Saint Kitts and Nevis"},{"c":"LC","n":"Saint Lucia"},{"c":"MF","n":"Saint Martin"},{"c":"PM","n":"Saint Pierre and Miquelon"},{"c":"VC","n":"Saint Vincent and the Grenadines"},{"c":"WS","n":"Samoa"},{"c":"SM","n":"San Marino"},{"c":"ST","n":"Sao Tome and Principe"},{"c":"SA","n":"Saudi Arabia"},{"c":"SN","n":"Senegal"},{"c":"RS","n":"Serbia"},{"c":"SC","n":"Seychelles"},{"c":"SL","n":"Sierra Leone"},{"c":"SG","n":"Singapore"},{"c":"SX","n":"Sint Maarten"},{"c":"SK","n":"Slovakia"},{"c":"SI","n":"Slovenia"},{"c":"SB","n":"Solomon Islands"},{"c":"SO","n":"Somalia"},{"c":"ZA","n":"South Africa"},{"c":"GS","n":"South Georgia and the South Sandwich Islands"},{"c":"KR","n":"South Korea"},{"c":"SS","n":"South Sudan"},{"c":"ES","n":"Spain"},{"c":"LK","n":"Sri Lanka"},{"c":"SD","n":"Sudan"},{"c":"SR","n":"Suriname"},{"c":"SJ","n":"Svalbard and Jan Mayen"},{"c":"SE","n":"Sweden"},{"c":"CH","n":"Switzerland"},{"c":"SY","n":"Syria"},{"c":"TW","n":"Taiwan"},{"c":"TJ","n":"Tajikistan"},{"c":"TZ","n":"Tanzania"},{"c":"TH","n":"Thailand"},{"c":"TL","n":"Timor-Leste"},{"c":"TG","n":"Togo"},{"c":"TK","n":"Tokelau"},{"c":"TO","n":"Tonga"},{"c":"TT","n":"Trinidad and Tobago"},{"c":"TN","n":"Tunisia"},{"c":"TR","n":"Türkiye"},{"c":"TM","n":"Turkmenistan"},{"c":"TC","n":"Turks and Caicos Islands"},{"c":"TV","n":"Tuvalu"},{"c":"UG","n":"Uganda"},{"c":"UA","n":"Ukraine"},{"c":"AE","n":"United Arab Emirates"},{"c":"GB","n":"United Kingdom"},{"c":"UM","n":"United States Minor Outlying Islands"},{"c":"US","n":"United States of America"},{"c":"UY","n":"Uruguay"},{"c":"UZ","n":"Uzbekistan"},{"c":"VU","n":"Vanuatu"},{"c":"VE","n":"Venezuela"},{"c":"VN","n":"Vietnam"},{"c":"VG","n":"Virgin Islands (UK)"},{"c":"VI","n":"Virgin Islands (US)"},{"c":"WF","n":"Wallis and Futuna"},{"c":"EH","n":"Western Sahara"},{"c":"YE","n":"Yemen"},{"c":"ZM","n":"Zambia"},{"c":"ZW","n":"Zimbabwe"}];
    const COUNTRY_TZ = {"AD":["Europe/Andorra"],"AE":["Asia/Dubai"],"AF":["Asia/Kabul"],"AG":["America/Puerto_Rico"],"AI":["America/Puerto_Rico"],"AL":["Europe/Tirane"],"AM":["Asia/Yerevan"],"AO":["Africa/Lagos"],"AQ":["Antarctica/Casey","Antarctica/Davis","Antarctica/Mawson","Antarctica/Palmer","Antarctica/Rothera","Antarctica/Troll","Antarctica/Vostok","Asia/Riyadh","Asia/Singapore","Pacific/Auckland","Pacific/Port_Moresby"],"AR":["America/Argentina/Buenos_Aires","America/Argentina/Catamarca","America/Argentina/Cordoba","America/Argentina/Jujuy","America/Argentina/La_Rioja","America/Argentina/Mendoza","America/Argentina/Rio_Gallegos","America/Argentina/Salta","America/Argentina/San_Juan","America/Argentina/San_Luis","America/Argentina/Tucuman","America/Argentina/Ushuaia"],"AS":["Pacific/Pago_Pago"],"AT":["Europe/Vienna"],"AU":["Antarctica/Macquarie","Asia/Tokyo","Australia/Adelaide","Australia/Brisbane","Australia/Broken_Hill","Australia/Darwin","Australia/Eucla","Australia/Hobart","Australia/Lindeman","Australia/Lord_Howe","Australia/Melbourne","Australia/Perth","Australia/Sydney"],"AW":["America/Puerto_Rico"],"AX":["Europe/Helsinki"],"AZ":["Asia/Baku"],"BA":["Europe/Belgrade"],"BB":["America/Barbados"],"BD":["Asia/Dhaka"],"BE":["Europe/Brussels"],"BF":["Africa/Abidjan"],"BG":["Europe/Sofia"],"BH":["Asia/Qatar"],"BI":["Africa/Maputo"],"BJ":["Africa/Lagos"],"BL":["America/Puerto_Rico"],"BM":["Atlantic/Bermuda"],"BN":["Asia/Kuching"],"BO":["America/La_Paz"],"BQ":["America/Puerto_Rico"],"BR":["America/Araguaina","America/Bahia","America/Belem","America/Boa_Vista","America/Campo_Grande","America/Cuiaba","America/Eirunepe","America/Fortaleza","America/Maceio","America/Manaus","America/Noronha","America/Porto_Velho","America/Recife","America/Rio_Branco","America/Santarem","America/Sao_Paulo"],"BS":["America/Toronto"],"BT":["Asia/Thimphu"],"BW":["Africa/Maputo"],"BY":["Europe/Minsk"],"BZ":["America/Belize"],"CA":["America/Cambridge_Bay","America/Dawson","America/Dawson_Creek","America/Edmonton","America/Fort_Nelson","America/Glace_Bay","America/Goose_Bay","America/Halifax","America/Inuvik","America/Iqaluit","America/Moncton","America/Panama","America/Phoenix","America/Puerto_Rico","America/Rankin_Inlet","America/Regina","America/Resolute","America/St_Johns","America/Swift_Current","America/Toronto","America/Vancouver","America/Whitehorse","America/Winnipeg"],"CC":["Asia/Yangon"],"CD":["Africa/Lagos","Africa/Maputo"],"CF":["Africa/Lagos"],"CG":["Africa/Lagos"],"CH":["Europe/Zurich"],"CI":["Africa/Abidjan"],"CK":["Pacific/Rarotonga"],"CL":["America/Coyhaique","America/Punta_Arenas","America/Santiago","Pacific/Easter"],"CM":["Africa/Lagos"],"CN":["Asia/Shanghai","Asia/Urumqi"],"CO":["America/Bogota"],"CR":["America/Costa_Rica"],"CU":["America/Havana"],"CV":["Atlantic/Cape_Verde"],"CW":["America/Puerto_Rico"],"CX":["Asia/Bangkok"],"CY":["Asia/Famagusta","Asia/Nicosia"],"CZ":["Europe/Prague"],"DE":["Europe/Berlin","Europe/Zurich"],"DJ":["Africa/Nairobi"],"DK":["Europe/Berlin"],"DM":["America/Puerto_Rico"],"DO":["America/Santo_Domingo"],"DZ":["Africa/Algiers"],"EC":["America/Guayaquil","Pacific/Galapagos"],"EE":["Europe/Tallinn"],"EG":["Africa/Cairo"],"EH":["Africa/El_Aaiun"],"ER":["Africa/Nairobi"],"ES":["Africa/Ceuta","Atlantic/Canary","Europe/Madrid"],"ET":["Africa/Nairobi"],"FI":["Europe/Helsinki"],"FJ":["Pacific/Fiji"],"FK":["Atlantic/Stanley"],"FM":["Pacific/Guadalcanal","Pacific/Kosrae","Pacific/Port_Moresby"],"FO":["Atlantic/Faroe"],"FR":["Europe/Paris"],"GA":["Africa/Lagos"],"GB":["Europe/London"],"GD":["America/Puerto_Rico"],"GE":["Asia/Tbilisi"],"GF":["America/Cayenne"],"GG":["Europe/London"],"GH":["Africa/Abidjan"],"GI":["Europe/Gibraltar"],"GL":["America/Danmarkshavn","America/Nuuk","America/Scoresbysund","America/Thule"],"GM":["Africa/Abidjan"],"GN":["Africa/Abidjan"],"GP":["America/Puerto_Rico"],"GQ":["Africa/Lagos"],"GR":["Europe/Athens"],"GS":["Atlantic/South_Georgia"],"GT":["America/Guatemala"],"GU":["Pacific/Guam"],"GW":["Africa/Bissau"],"GY":["America/Guyana"],"HK":["Asia/Hong_Kong"],"HN":["America/Tegucigalpa"],"HR":["Europe/Belgrade"],"HT":["America/Port-au-Prince"],"HU":["Europe/Budapest"],"ID":["Asia/Jakarta","Asia/Jayapura","Asia/Makassar","Asia/Pontianak"],"IE":["Europe/Dublin"],"IL":["Asia/Jerusalem"],"IM":["Europe/London"],"IN":["Asia/Kolkata"],"IO":["Indian/Chagos"],"IQ":["Asia/Baghdad"],"IR":["Asia/Tehran"],"IS":["Africa/Abidjan"],"IT":["Europe/Rome"],"JE":["Europe/London"],"JM":["America/Jamaica"],"JO":["Asia/Amman"],"JP":["Asia/Tokyo"],"KE":["Africa/Nairobi"],"KG":["Asia/Bishkek"],"KH":["Asia/Bangkok"],"KI":["Pacific/Kanton","Pacific/Kiritimati","Pacific/Tarawa"],"KM":["Africa/Nairobi"],"KN":["America/Puerto_Rico"],"KP":["Asia/Pyongyang"],"KR":["Asia/Seoul"],"KW":["Asia/Riyadh"],"KY":["America/Panama"],"KZ":["Asia/Almaty","Asia/Aqtau","Asia/Aqtobe","Asia/Atyrau","Asia/Oral","Asia/Qostanay","Asia/Qyzylorda"],"LA":["Asia/Bangkok"],"LB":["Asia/Beirut"],"LC":["America/Puerto_Rico"],"LI":["Europe/Zurich"],"LK":["Asia/Colombo"],"LR":["Africa/Monrovia"],"LS":["Africa/Johannesburg"],"LT":["Europe/Vilnius"],"LU":["Europe/Brussels"],"LV":["Europe/Riga"],"LY":["Africa/Tripoli"],"MA":["Africa/Casablanca"],"MC":["Europe/Paris"],"MD":["Europe/Chisinau"],"ME":["Europe/Belgrade"],"MF":["America/Puerto_Rico"],"MG":["Africa/Nairobi"],"MH":["Pacific/Kwajalein","Pacific/Tarawa"],"MK":["Europe/Belgrade"],"ML":["Africa/Abidjan"],"MM":["Asia/Yangon"],"MN":["Asia/Hovd","Asia/Ulaanbaatar"],"MO":["Asia/Macau"],"MP":["Pacific/Guam"],"MQ":["America/Martinique"],"MR":["Africa/Abidjan"],"MS":["America/Puerto_Rico"],"MT":["Europe/Malta"],"MU":["Indian/Mauritius"],"MV":["Indian/Maldives"],"MW":["Africa/Maputo"],"MX":["America/Bahia_Banderas","America/Cancun","America/Chihuahua","America/Ciudad_Juarez","America/Hermosillo","America/Matamoros","America/Mazatlan","America/Merida","America/Mexico_City","America/Monterrey","America/Ojinaga","America/Tijuana"],"MY":["Asia/Kuching","Asia/Singapore"],"MZ":["Africa/Maputo"],"NA":["Africa/Windhoek"],"NC":["Pacific/Noumea"],"NE":["Africa/Lagos"],"NF":["Pacific/Norfolk"],"NG":["Africa/Lagos"],"NI":["America/Managua"],"NL":["Europe/Brussels"],"NO":["Europe/Berlin"],"NP":["Asia/Kathmandu"],"NR":["Pacific/Nauru"],"NU":["Pacific/Niue"],"NZ":["Pacific/Auckland","Pacific/Chatham"],"OM":["Asia/Dubai"],"PA":["America/Panama"],"PE":["America/Lima"],"PF":["Pacific/Gambier","Pacific/Marquesas","Pacific/Tahiti"],"PG":["Pacific/Bougainville","Pacific/Port_Moresby"],"PH":["Asia/Manila"],"PK":["Asia/Karachi"],"PL":["Europe/Warsaw"],"PM":["America/Miquelon"],"PN":["Pacific/Pitcairn"],"PR":["America/Puerto_Rico"],"PS":["Asia/Gaza","Asia/Hebron"],"PT":["Atlantic/Azores","Atlantic/Madeira","Europe/Lisbon"],"PW":["Pacific/Palau"],"PY":["America/Asuncion"],"QA":["Asia/Qatar"],"RE":["Asia/Dubai"],"RO":["Europe/Bucharest"],"RS":["Europe/Belgrade"],"RU":["Asia/Anadyr","Asia/Barnaul","Asia/Chita","Asia/Irkutsk","Asia/Kamchatka","Asia/Khandyga","Asia/Krasnoyarsk","Asia/Magadan","Asia/Novokuznetsk","Asia/Novosibirsk","Asia/Omsk","Asia/Sakhalin","Asia/Srednekolymsk","Asia/Tomsk","Asia/Ust-Nera","Asia/Vladivostok","Asia/Yakutsk","Asia/Yekaterinburg","Europe/Astrakhan","Europe/Kaliningrad","Europe/Kirov","Europe/Moscow","Europe/Samara","Europe/Saratov","Europe/Simferopol","Europe/Ulyanovsk","Europe/Volgograd"],"RW":["Africa/Maputo"],"SA":["Asia/Riyadh"],"SB":["Pacific/Guadalcanal"],"SC":["Asia/Dubai"],"SD":["Africa/Khartoum"],"SE":["Europe/Berlin"],"SG":["Asia/Singapore"],"SH":["Africa/Abidjan"],"SI":["Europe/Belgrade"],"SJ":["Europe/Berlin"],"SK":["Europe/Prague"],"SL":["Africa/Abidjan"],"SM":["Europe/Rome"],"SN":["Africa/Abidjan"],"SO":["Africa/Nairobi"],"SR":["America/Paramaribo"],"SS":["Africa/Juba"],"ST":["Africa/Sao_Tome"],"SV":["America/El_Salvador"],"SX":["America/Puerto_Rico"],"SY":["Asia/Damascus"],"SZ":["Africa/Johannesburg"],"TC":["America/Grand_Turk"],"TD":["Africa/Ndjamena"],"TF":["Asia/Dubai","Indian/Maldives"],"TG":["Africa/Abidjan"],"TH":["Asia/Bangkok"],"TJ":["Asia/Dushanbe"],"TK":["Pacific/Fakaofo"],"TL":["Asia/Dili"],"TM":["Asia/Ashgabat"],"TN":["Africa/Tunis"],"TO":["Pacific/Tongatapu"],"TR":["Europe/Istanbul"],"TT":["America/Puerto_Rico"],"TV":["Pacific/Tarawa"],"TW":["Asia/Taipei"],"TZ":["Africa/Nairobi"],"UA":["Europe/Kyiv","Europe/Simferopol"],"UG":["Africa/Nairobi"],"UM":["Pacific/Pago_Pago","Pacific/Tarawa"],"US":["America/Adak","America/Anchorage","America/Boise","America/Chicago","America/Denver","America/Detroit","America/Indiana/Indianapolis","America/Indiana/Knox","America/Indiana/Marengo","America/Indiana/Petersburg","America/Indiana/Tell_City","America/Indiana/Vevay","America/Indiana/Vincennes","America/Indiana/Winamac","America/Juneau","America/Kentucky/Louisville","America/Kentucky/Monticello","America/Los_Angeles","America/Menominee","America/Metlakatla","America/New_York","America/Nome","America/North_Dakota/Beulah","America/North_Dakota/Center","America/North_Dakota/New_Salem","America/Phoenix","America/Sitka","America/Yakutat","Pacific/Honolulu"],"UY":["America/Montevideo"],"UZ":["Asia/Samarkand","Asia/Tashkent"],"VA":["Europe/Rome"],"VC":["America/Puerto_Rico"],"VE":["America/Caracas"],"VG":["America/Puerto_Rico"],"VI":["America/Puerto_Rico"],"VN":["Asia/Bangkok","Asia/Ho_Chi_Minh"],"VU":["Pacific/Efate"],"WF":["Pacific/Tarawa"],"WS":["Pacific/Apia"],"YE":["Asia/Riyadh"],"YT":["Africa/Nairobi"],"ZA":["Africa/Johannesburg"],"ZM":["Africa/Maputo"],"ZW":["Africa/Maputo"]};
    const tzCity = (z) => (z || '').split('/').pop().replace(/_/g, ' ');
    const localTimeIn = (z) => { try { return new Date().toLocaleTimeString('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
    const PETS = [
      { k: 'dog', label: 'Dog', e: '🐶' }, { k: 'cat', label: 'Cat', e: '🐱' }, { k: 'bird', label: 'Bird', e: '🐦' },
      { k: 'fish', label: 'Fish', e: '🐠' }, { k: 'rabbit', label: 'Rabbit', e: '🐰' }, { k: 'hamster', label: 'Hamster', e: '🐹' },
      { k: 'turtle', label: 'Turtle', e: '🐢' }, { k: 'reptile', label: 'Reptile', e: '🦎' }, { k: 'horse', label: 'Horse', e: '🐴' },
    ];
    const petLabel = (k) => { const p = PETS.find(x => x.k === k); return p ? (p.e + ' ' + p.label) : k; };

    const ACCESS_LABEL = { admin: 'Admin', operations: 'Operations', agent: 'Sales Agent', tc: 'Transaction Coordinator', pending: 'Pending' };
    const STATUS_LABEL = { active: 'Active', pending: 'Pending', disabled: 'Disabled' };
    // Access is a LIST of roles (Postgres text[]). Helpers are backward-compatible with old single-string values.
    const toRoles = (a) => (Array.isArray(a) ? a : (a ? [a] : [])).filter(r => r && r !== 'pending');
    const hasAdmin = (a) => toRoles(a).some(r => r === 'admin' || r === 'operations');
    const accessLabel = (a) => { const r = toRoles(a); return r.length ? r.map(x => ACCESS_LABEL[x] || x).join(' · ') : 'Pending'; };
    // Apps this user may open. null = everything (admins, or no role set).
    // Otherwise a Set of app ids; 'more' + 'settings' are always available separately.
    function allowedAppSet(a, cfg) {
      const roles = toRoles(a);
      if (!roles.length) return null;                    // no roles → all (fallback)
      if (roles.some(r => r === 'admin')) return null;   // admins → all (operations is configurable)
      const set = new Set();
      ACCESS_APPS.forEach(app => {
        const appRoles = (cfg && Array.isArray(cfg[app.id])) ? cfg[app.id] : (DEFAULT_ACCESS[app.id] || []);
        if (roles.some(r => appRoles.includes(r))) set.add(app.id);
      });
      return set;
    }

    // ─── Contact link helpers ─────────────────────────────────────────
    const telHref  = (v) => 'tel:' + String(v).replace(/[^\d+]/g, '');
    const mailHref = (v) => 'mailto:' + String(v).trim();
    function contactLink(label, value) {
      if (!value) return value;
      if (label === 'Phone') return <a href={telHref(value)} style={{ color: 'inherit', textDecoration: 'none' }}>{value}</a>;
      if (label === 'Email') return <a href={mailHref(value)} style={{ color: 'inherit', textDecoration: 'none' }}>{value}</a>;
      return value;
    }

    // ─── Attachment helpers (module-level, reusable for a future voice-message feature) ──
    const ATTACH_BUCKET = 'chat-attachments';
    const ATTACH_MAX_BYTES = 25 * 1024 * 1024; // ~25MB per file
    const _signedUrlCache = new Map();          // storage_path → signed url (https) | object url (dev)
    // Dev-mode object/preview URLs keyed by fake storage_path (so signedUrl() can resolve them on localhost).
    const _devAttachUrls = {};
    // Seed the dev fixture image so localhost renders an inline attachment without real Storage.
    _devAttachUrls['dev/sample-floorplan.svg'] = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150" viewBox="0 0 220 150">' +
      '<rect width="220" height="150" fill="#F3EBDA"/>' +
      '<rect x="12" y="12" width="120" height="90" fill="none" stroke="#AD832F" stroke-width="2"/>' +
      '<rect x="132" y="12" width="76" height="44" fill="none" stroke="#AD832F" stroke-width="2"/>' +
      '<rect x="132" y="56" width="76" height="46" fill="none" stroke="#AD832F" stroke-width="2"/>' +
      '<line x1="12" y1="102" x2="208" y2="102" stroke="#001A4A" stroke-width="2"/>' +
      '<text x="110" y="132" font-family="Jost,sans-serif" font-size="13" fill="#001A4A" text-anchor="middle">Sample Floor Plan</text>' +
      '</svg>'
    );
    // Dev fixture voice note: a tiny silent WAV so the <audio> player + "AI transcript" caption are testable on localhost.
    _devAttachUrls['dev/sample-voice.wav'] = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
    // Strip path separators / unsafe chars so the storage key stays well-formed.
    function sanitizeFileName(name) {
      return String(name || 'file').replace(/[\/\\]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_').slice(0, 120) || 'file';
    }
    function humanFileSize(bytes) {
      const b = Number(bytes) || 0;
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
      return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    }
    function isImageMime(m) { return /^image\//.test(String(m || '')); }
    function isAudioMime(m) { return /^audio\//.test(String(m || '')); }
    // Decode an image File to grab natural width/height (best-effort; resolves nulls on failure).
    function imageDims(file) {
      return new Promise((resolve) => {
        if (!isImageMime(file.type) || typeof URL === 'undefined' || !URL.createObjectURL) { resolve({ width: null, height: null }); return; }
        try {
          const url = URL.createObjectURL(file); const img = new Image();
          img.onload = () => { resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null }); URL.revokeObjectURL(url); };
          img.onerror = () => { resolve({ width: null, height: null }); URL.revokeObjectURL(url); };
          img.src = url;
        } catch (e) { resolve({ width: null, height: null }); }
      });
    }

    // ─── ChatDB (Supabase + localhost dev fixture) ────────────────────
    const ChatDB = {
      client() { return window.SupabaseAuth?._client || null; },
      uid() { return window.SupabaseAuth?._state?.session?.user?.id || (this.client() ? null : 'dev-user-id'); },
      _ws: null,
      _devData: null,
      _devRead: {},

      _dev() {
        if (this._devData) return this._devData;
        const now = Date.now();
        const ago = (ms) => new Date(now - ms).toISOString();
        this._devData = {
          channels: [
            { id: 'devc1', name: 'general',    type: 'public',  topic: 'Company-wide announcements', is_archived: false },
            { id: 'devc2', name: 'deals',      type: 'public',  topic: 'Active listings & offers',   is_archived: false },
            { id: 'devc3', name: 'leadership', type: 'private', topic: 'Owners only',                 is_archived: false },
          ],
          conversations: [
            { id: 'devd1', type: 'dm',       title: null,      memberIds: ['dev-user-id', 'dev-tarek'] },
            { id: 'devg1', type: 'group_dm', title: 'Ops Team', memberIds: ['dev-user-id', 'dev-tarek', 'dev-alex'] },
          ],
          messages: {
            devc1: [
              { id: 'm1', channel_id: 'devc1', author_id: 'dev-tarek',    content: 'Welcome to the new Chat! 🎉 Notes at https://themorshedgroup.com', created_at: ago(3600000), reactions: [{ emoji: '🎉', user_id: 'dev-user-id' }, { emoji: '🎉', user_id: 'dev-alex' }], reply_count: 2, attachments: [{ id: 'devatt1', message_id: 'm1', storage_path: 'dev/sample-floorplan.svg', file_name: 'floorplan.svg', mime_type: 'image/svg+xml', file_size: 4200, width: 220, height: 150 }] },
              { id: 'm2', channel_id: 'devc1', author_id: 'dev-user-id',  content: 'Looks great. @Tarek can you review the #deals pipeline?', created_at: ago(1800000), reactions: [], reply_count: 0 },
              { id: 'm3', channel_id: 'devc1', author_id: 'dev-tarek',    content: 'XSS test: <img src=x onerror=alert(1)> <script>alert(1)<\/script> javascript:alert(1)', created_at: ago(600000), edited_at: ago(300000), reactions: [], reply_count: 0 },
              { id: 'm4', channel_id: 'devc1', author_id: 'dev-tarek',    content: 'Hey team, quick voice note — the buyer wants to push closing to Friday, let me know if that works.', created_at: ago(240000), reactions: [], reply_count: 0, attachments: [{ id: 'devatt2', message_id: 'm4', storage_path: 'dev/sample-voice.wav', file_name: 'voice-note.wav', mime_type: 'audio/wav', file_size: 18000 }] },
              { id: 'm5', channel_id: 'devc1', author_id: 'dev-user-id',  content: '', created_at: ago(120000), reactions: [], reply_count: 0, attachments: [{ id: 'devatt3', message_id: 'm5', storage_path: 'dev/sample-voice.wav', file_name: 'voice-note.wav', mime_type: 'audio/wav', file_size: 12000 }] },
            ],
            devd1: [
              { id: 'd1', conversation_id: 'devd1', author_id: 'dev-tarek', content: 'Hey — got a sec to sync on Forest Hill?', created_at: ago(900000), reactions: [], reply_count: 0 },
            ],
          },
          threads: {
            m1: [
              { id: 'mt1', channel_id: 'devc1', thread_parent_id: 'm1', author_id: 'dev-user-id', content: 'Love it 🙌', created_at: ago(3500000), reactions: [] },
              { id: 'mt2', channel_id: 'devc1', thread_parent_id: 'm1', author_id: 'dev-alex',     content: 'Finally!', created_at: ago(3400000), reactions: [] },
            ],
          },
        };
        return this._devData;
      },

      async loadRoster() {
        if (!this.client()) return [
          { id: 'dev-user-id', first_name: 'Symon', last_name: 'Yongco',  avatar_url: '', access: ['admin'],      away: false, status_emoji: '',   status_text: '',              last_seen_at: new Date().toISOString() },
          { id: 'dev-tarek',   first_name: 'Tarek', last_name: 'Morshed', avatar_url: '', access: ['admin'],      away: false, status_emoji: '🏝️', status_text: 'On a showing', last_seen_at: new Date().toISOString() },
          { id: 'dev-alex',    first_name: 'Alex',  last_name: 'Rivera',  avatar_url: '', access: ['operations'], away: true,  status_emoji: '',   status_text: '',              last_seen_at: new Date(Date.now() - 3600000).toISOString() },
          { id: 'dev-brett',   first_name: 'Brett', last_name: 'Cole',    avatar_url: '', access: ['agent'],      away: false, status_emoji: '☕', status_text: 'Coffee run',   last_seen_at: new Date().toISOString() },
        ];
        try { return await ProfileDB.loadAll(); } catch (e) { return []; }
      },

      async defaultWorkspaceId() {
        if (this._ws) return this._ws;
        if (!this.client()) { this._ws = 'dev-ws'; return this._ws; }
        const { data } = await this.client().from('chat_workspaces').select('id').limit(1).maybeSingle();
        this._ws = data?.id || null;
        return this._ws;
      },

      _mapChannel(r) { return { id: r.id, name: r.name, topic: r.topic || '', type: r.type, is_archived: !!r.is_archived }; },

      async listChannels() {
        if (!this.client()) return this._dev().channels.slice();
        const { data, error } = await this.client().from('chat_channels').select('*')
          .eq('is_archived', false).order('name', { ascending: true });
        if (error) { console.error('[ChatDB] listChannels:', error.message); return []; }
        return (data || []).map(this._mapChannel);
      },

      async listConversations() {
        if (!this.client()) return this._dev().conversations.slice();
        const me = this.uid();
        const { data: mine, error: e1 } = await this.client().from('chat_conversation_members')
          .select('conversation_id').eq('user_id', me);
        if (e1) { console.error('[ChatDB] convs:', e1.message); return []; }
        const ids = (mine || []).map(r => r.conversation_id);
        if (!ids.length) return [];
        const { data: convs } = await this.client().from('chat_conversations').select('*').in('id', ids);
        const { data: mems } = await this.client().from('chat_conversation_members')
          .select('conversation_id,user_id').in('conversation_id', ids);
        const byConv = {};
        (mems || []).forEach(m => { (byConv[m.conversation_id] = byConv[m.conversation_id] || []).push(m.user_id); });
        return (convs || []).map(c => ({ id: c.id, type: c.type, title: c.title || null, memberIds: byConv[c.id] || [] }));
      },

      _scopeCol(scope) { return scope.kind === 'channel' ? 'channel_id' : 'conversation_id'; },

      async loadMessages(scope, opts = {}) {
        const limit = opts.limit || 60;
        if (!this.client()) return (this._dev().messages[scope.id] || []).slice();
        const col = this._scopeCol(scope);
        const { data, error } = await this.client().from('chat_messages').select('*')
          .eq(col, scope.id).is('thread_parent_id', null)
          .order('created_at', { ascending: true }).limit(limit);
        if (error) { console.error('[ChatDB] loadMessages:', error.message); return []; }
        const msgs = data || [];
        if (msgs.length) await this._enrich(scope, msgs);
        return msgs;
      },

      // attach reactions[] and reply_count to a set of messages
      async _enrich(scope, msgs) {
        const col = this._scopeCol(scope);
        const ids = msgs.map(m => m.id);
        const { data: rx } = await this.client().from('chat_message_reactions').select('message_id,emoji,user_id').in('message_id', ids);
        const rxBy = {}; (rx || []).forEach(r => { (rxBy[r.message_id] = rxBy[r.message_id] || []).push({ emoji: r.emoji, user_id: r.user_id }); });
        const { data: rep } = await this.client().from('chat_messages').select('thread_parent_id').eq(col, scope.id).not('thread_parent_id', 'is', null).in('thread_parent_id', ids);
        const repBy = {}; (rep || []).forEach(r => { repBy[r.thread_parent_id] = (repBy[r.thread_parent_id] || 0) + 1; });
        const byAtt = await this.loadAttachments(ids);
        msgs.forEach(m => { m.reactions = rxBy[m.id] || []; m.reply_count = repBy[m.id] || 0; m.attachments = byAtt[m.id] || []; });
      },

      async threadReplies(scope, parentId) {
        if (!this.client()) return (this._dev().threads[parentId] || []).slice();
        const { data, error } = await this.client().from('chat_messages').select('*')
          .eq('thread_parent_id', parentId).order('created_at', { ascending: true });
        if (error) { console.error('[ChatDB] threadReplies:', error.message); return []; }
        const msgs = data || [];
        if (msgs.length) await this._enrich(scope, msgs);
        return msgs;
      },

      async sendMessage(scope, { content, clientId, threadParentId }) {
        if (!this.client()) {
          const d = this._dev();
          const row = { id: 'dev-' + (clientId || Date.now()), author_id: this.uid(), content, client_id: clientId, created_at: new Date().toISOString(), reactions: [], reply_count: 0,
            channel_id: scope.kind === 'channel' ? scope.id : null, conversation_id: scope.kind === 'conversation' ? scope.id : null, thread_parent_id: threadParentId || null };
          if (threadParentId) { (d.threads[threadParentId] = d.threads[threadParentId] || []).push(row); const pm = (d.messages[scope.id] || []).find(m => m.id === threadParentId); if (pm) pm.reply_count = (pm.reply_count || 0) + 1; }
          else (d.messages[scope.id] = d.messages[scope.id] || []).push(row);
          return row;
        }
        const ws = await this.defaultWorkspaceId();
        const base = { workspace_id: ws, author_id: this.uid(), content, client_id: clientId || null, thread_parent_id: threadParentId || null };
        if (scope.kind === 'channel') base.channel_id = scope.id; else base.conversation_id = scope.id;
        const { data, error } = await this.client().from('chat_messages').insert(base).select().single();
        if (error) { console.error('[ChatDB] send:', error.message); throw error; }
        return data;
      },

      // ── Attachments substrate (reused later for voice messages) ──────
      // Upload a File to private Storage; returns the meta row to insert into chat_message_attachments.
      // Dev-mode (no client): stash an object URL and return a fake storage_path so the UI is fully testable.
      async uploadAttachment(scope, file) {
        const dims = await imageDims(file);
        if (!this.client()) {
          const fakePath = 'dev/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()) + '-' + sanitizeFileName(file.name);
          const previewUrl = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : '';
          _devAttachUrls[fakePath] = previewUrl;
          return { storage_path: fakePath, file_name: file.name, mime_type: file.type || 'application/octet-stream', file_size: file.size, width: dims.width, height: dims.height, previewUrl };
        }
        const uid = this.uid();
        const path = `${uid}/chat-${scope.id}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
        const { error } = await this.client().storage.from(ATTACH_BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (error) { console.error('[ChatDB] uploadAttachment:', error.message); throw error; }
        return { storage_path: path, file_name: file.name, mime_type: file.type || 'application/octet-stream', file_size: file.size, width: dims.width, height: dims.height };
      },

      // Insert the attachment row for a (real) message id. RLS gates insert to the message author.
      async addAttachmentRow(messageId, meta) {
        const row = { message_id: messageId, storage_path: meta.storage_path, file_name: meta.file_name, mime_type: meta.mime_type, file_size: meta.file_size, width: meta.width ?? null, height: meta.height ?? null };
        if (!this.client()) {
          const d = this._dev(); const rec = { id: 'devatt-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()), ...row };
          const push = (m) => { if (m.id === messageId) m.attachments = [...(m.attachments || []), rec]; };
          Object.keys(d.messages).forEach(k => d.messages[k].forEach(push));
          Object.keys(d.threads).forEach(k => d.threads[k].forEach(push));
          return rec;
        }
        const { data, error } = await this.client().from('chat_message_attachments').insert(row).select().single();
        if (error) { console.error('[ChatDB] addAttachmentRow:', error.message); throw error; }
        return data;
      },

      // Resolve (and cache) a signed URL for a private-bucket object. Dev-mode → the stored object/preview URL.
      async signedUrl(storagePath) {
        if (!storagePath) return '';
        if (_signedUrlCache.has(storagePath)) return _signedUrlCache.get(storagePath);
        if (!this.client()) { const u = _devAttachUrls[storagePath] || ''; if (u) _signedUrlCache.set(storagePath, u); return u; }
        const { data, error } = await this.client().storage.from(ATTACH_BUCKET).createSignedUrl(storagePath, 3600);
        if (error || !data?.signedUrl) { console.error('[ChatDB] signedUrl:', error && error.message); return ''; }
        _signedUrlCache.set(storagePath, data.signedUrl);
        return data.signedUrl;
      },

      // Bulk-load attachment rows for a set of message ids → { [message_id]: [rows] }.
      async loadAttachments(messageIds) {
        const ids = (messageIds || []).filter(Boolean);
        const out = {};
        if (!ids.length) return out;
        if (!this.client()) {
          const d = this._dev();
          const scan = (m) => { if (ids.includes(m.id) && (m.attachments || []).length) out[m.id] = m.attachments.slice(); };
          Object.keys(d.messages).forEach(k => d.messages[k].forEach(scan));
          Object.keys(d.threads).forEach(k => d.threads[k].forEach(scan));
          return out;
        }
        const { data, error } = await this.client().from('chat_message_attachments').select('*').in('message_id', ids);
        if (error) { console.error('[ChatDB] loadAttachments:', error.message); return out; }
        (data || []).forEach(r => { (out[r.message_id] = out[r.message_id] || []).push(r); });
        return out;
      },

      // Voice-note transcription via the deployed chat-transcribe edge function.
      // POST { storage_path, cleanup:true } with the user's access token; returns the transcript ('' on any failure).
      async transcribe(storagePath) {
        if (!storagePath) return '';
        if (!this.client()) return ''; // dev/preview: no real transcription
        try {
          const token = window.SupabaseAuth?._state?.session?.access_token;
          const res = await fetch('https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/chat-transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || SUPABASE_ANON), 'apikey': SUPABASE_ANON },
            body: JSON.stringify({ storage_path: storagePath, cleanup: true }),
          });
          if (!res.ok) { console.error('[ChatDB] transcribe HTTP', res.status); return ''; }
          const data = await res.json().catch(() => ({}));
          if (data && data.error) { console.error('[ChatDB] transcribe:', data.error); return ''; }
          return (data && data.transcript) || '';
        } catch (e) { console.error('[ChatDB] transcribe:', e && e.message); return ''; }
      },

      async editMessage(id, content) {
        if (!this.client()) {
          const d = this._dev(); const stamp = new Date().toISOString();
          Object.keys(d.messages).forEach(k => d.messages[k].forEach(m => { if (m.id === id) { m.content = content; m.edited_at = stamp; } }));
          Object.keys(d.threads).forEach(k => d.threads[k].forEach(m => { if (m.id === id) { m.content = content; m.edited_at = stamp; } }));
          return;
        }
        const { error } = await this.client().from('chat_messages').update({ content, edited_at: new Date().toISOString() }).eq('id', id);
        if (error) { console.error('[ChatDB] edit:', error.message); throw error; }
      },

      async react(messageId, emoji) {
        if (!this.client()) return;
        const { error } = await this.client().from('chat_message_reactions').insert({ message_id: messageId, user_id: this.uid(), emoji });
        if (error && error.code !== '23505') console.error('[ChatDB] react:', error.message);
      },
      async unreact(messageId, emoji) {
        if (!this.client()) return;
        const { error } = await this.client().from('chat_message_reactions').delete().eq('message_id', messageId).eq('user_id', this.uid()).eq('emoji', emoji);
        if (error) console.error('[ChatDB] unreact:', error.message);
      },

      async insertMentions(messageId, mentions) {
        if (!this.client() || !mentions.length) return;
        const rows = mentions.map(m => ({ message_id: messageId, mention_type: m.type, mentioned_user_id: m.userId || null, mentioned_channel_id: m.channelId || null }));
        const { error } = await this.client().from('chat_mentions').insert(rows);
        if (error) console.error('[ChatDB] mentions:', error.message);
      },

      async markRead(scope, lastMessageId) {
        if (!this.client()) { this._devRead[scope.id] = Date.now(); return; }
        const tbl = scope.kind === 'channel' ? 'chat_channel_members' : 'chat_conversation_members';
        const col = scope.kind === 'channel' ? 'channel_id' : 'conversation_id';
        const patch = { last_read_at: new Date().toISOString() };
        if (lastMessageId && !String(lastMessageId).startsWith('tmp-')) patch.last_read_message_id = lastMessageId;
        const { error } = await this.client().from(tbl).update(patch).eq(col, scope.id).eq('user_id', this.uid());
        if (error) console.error('[ChatDB] markRead:', error.message);
      },

      // Other members' read state (for sent/delivered/seen ticks). Reuses last_read_at — no schema change.
      async loadMemberReads(scope) {
        if (!this.client()) {
          // Dev: seed a "seen" read for the DM peer (last_read_at = now) so the green seen tick can be demoed.
          const cv = (this._dev().conversations || []).find(c => c.id === scope.id);
          if (cv && cv.type === 'dm') {
            const peer = cv.memberIds.find(id => id !== this.uid());
            if (peer) return [{ user_id: peer, last_read_at: new Date().toISOString(), last_read_message_id: null }];
          }
          return [];
        }
        const tbl = scope.kind === 'channel' ? 'chat_channel_members' : 'chat_conversation_members';
        const col = scope.kind === 'channel' ? 'channel_id' : 'conversation_id';
        const { data, error } = await this.client().from(tbl)
          .select('user_id,last_read_at,last_read_message_id').eq(col, scope.id);
        if (error) { console.error('[ChatDB] loadMemberReads:', error.message); return []; }
        return data || [];
      },

      // Realtime UPDATE stream on the member table for this scope (read-receipt changes).
      subscribeMemberReads(scope, onUpdate) {
        const c = this.client(); if (!c || !scope) return null;
        const tbl = scope.kind === 'channel' ? 'chat_channel_members' : 'chat_conversation_members';
        const col = scope.kind === 'channel' ? 'channel_id' : 'conversation_id';
        const ch = c.channel('chatreads:' + scope.kind + ':' + scope.id)
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: tbl, filter: col + '=eq.' + scope.id }, (p) => onUpdate && onUpdate(p.new))
          .subscribe();
        return ch;
      },

      // { total, mentions, byScope: { id: {unread, mentions} } } — polled (privacy-safe; no global stream)
      async unreadSummary() {
        if (!this.client()) {
          const d = this._dev(); const byScope = {}; let total = 0, mentions = 0; const me = this.uid();
          const scan = (id, msgs) => { const since = this._devRead[id] || 0; const u = (msgs || []).filter(m => m.author_id !== me && new Date(m.created_at).getTime() > since).length; if (u) { byScope[id] = { unread: u, mentions: 0 }; total += u; } };
          d.channels.forEach(c => scan(c.id, d.messages[c.id]));
          d.conversations.forEach(c => scan(c.id, d.messages[c.id]));
          return { total, mentions, byScope };
        }
        const me = this.uid();
        const out = { total: 0, mentions: 0, byScope: {} };
        try {
          const cm = await this.client().from('chat_channel_members').select('channel_id,last_read_at').eq('user_id', me);
          const vm = await this.client().from('chat_conversation_members').select('conversation_id,last_read_at').eq('user_id', me);
          const scopes = [].concat((cm.data || []).map(r => ({ kind: 'channel', id: r.channel_id, col: 'channel_id', since: r.last_read_at })),
                                   (vm.data || []).map(r => ({ kind: 'conversation', id: r.conversation_id, col: 'conversation_id', since: r.last_read_at })));
          await Promise.all(scopes.map(async s => {
            let q = this.client().from('chat_messages').select('id', { count: 'exact', head: true }).eq(s.col, s.id).neq('author_id', me);
            if (s.since) q = q.gt('created_at', s.since);
            const { count } = await q;
            if (count) { out.byScope[s.id] = { unread: count, mentions: 0 }; out.total += count; }
          }));
          // unread mentions of me (best-effort: mentions whose message is newer than that scope's last_read)
          const sinceById = {}; scopes.forEach(s => { sinceById[s.id] = s.since ? new Date(s.since).getTime() : 0; });
          const { data: mn } = await this.client().from('chat_mentions')
            .select('message:chat_messages(channel_id,conversation_id,created_at,author_id)').eq('mentioned_user_id', me).limit(200);
          (mn || []).forEach(r => { const m = r.message; if (!m || m.author_id === me) return; const sid = m.channel_id || m.conversation_id; const t = new Date(m.created_at).getTime(); if (t > (sinceById[sid] || 0)) { out.mentions++; if (out.byScope[sid]) out.byScope[sid].mentions++; } });
        } catch (e) { console.error('[ChatDB] unreadSummary:', e.message || e); }
        return out;
      },

      async createChannel({ name, type, topic }) {
        if (!this.client()) { const ch = { id: 'devc-' + Date.now(), name, type: type || 'public', topic: topic || '', is_archived: false }; this._dev().channels.push(ch); return ch; }
        const ws = await this.defaultWorkspaceId();
        const { data, error } = await this.client().from('chat_channels')
          .insert({ workspace_id: ws, name, type: type || 'public', topic: topic || null, created_by: this.uid() }).select().single();
        if (error) { console.error('[ChatDB] createChannel:', error.message); throw error; }
        const { error: me } = await this.client().from('chat_channel_members')
          .insert({ channel_id: data.id, user_id: this.uid(), role: 'owner' });
        if (me && me.code !== '23505') console.error('[ChatDB] owner member:', me.message);
        return this._mapChannel(data);
      },

      async joinChannel(channelId) {
        if (!this.client()) return;
        const { error } = await this.client().from('chat_channel_members')
          .insert({ channel_id: channelId, user_id: this.uid(), role: 'member' });
        if (error && error.code !== '23505') console.error('[ChatDB] join:', error.message);
      },
      async leaveChannel(channelId) {
        if (!this.client()) return;
        const { error } = await this.client().from('chat_channel_members')
          .delete().eq('channel_id', channelId).eq('user_id', this.uid());
        if (error) console.error('[ChatDB] leave:', error.message);
      },

      async createDM(otherId) {
        if (!this.client()) { const cv = { id: 'devd-' + Date.now(), type: 'dm', title: null, memberIds: [this.uid(), otherId] }; this._dev().conversations.push(cv); return cv; }
        const me = this.uid();
        const existing = (await this.listConversations()).find(cv => cv.type === 'dm'
          && cv.memberIds.length === 2 && cv.memberIds.includes(me) && cv.memberIds.includes(otherId));
        if (existing) return existing;
        const ws = await this.defaultWorkspaceId();
        const { data: conv, error } = await this.client().from('chat_conversations')
          .insert({ workspace_id: ws, type: 'dm', created_by: me }).select().single();
        if (error) { console.error('[ChatDB] createDM:', error.message); throw error; }
        const { error: me2 } = await this.client().from('chat_conversation_members')
          .insert([{ conversation_id: conv.id, user_id: me }, { conversation_id: conv.id, user_id: otherId }]);
        if (me2) console.error('[ChatDB] dm members:', me2.message);
        return { id: conv.id, type: 'dm', title: null, memberIds: [me, otherId] };
      },

      async createGroupDM(userIds, title) {
        const me = this.uid();
        const members = Array.from(new Set([me, ...userIds]));
        if (!this.client()) { const cv = { id: 'devg-' + Date.now(), type: 'group_dm', title: title || null, memberIds: members }; this._dev().conversations.push(cv); return cv; }
        const ws = await this.defaultWorkspaceId();
        const { data: conv, error } = await this.client().from('chat_conversations')
          .insert({ workspace_id: ws, type: 'group_dm', title: title || null, created_by: me }).select().single();
        if (error) { console.error('[ChatDB] createGroupDM:', error.message); throw error; }
        const { error: me2 } = await this.client().from('chat_conversation_members')
          .insert(members.map(u => ({ conversation_id: conv.id, user_id: u })));
        if (me2) console.error('[ChatDB] group members:', me2.message);
        return { id: conv.id, type: 'group_dm', title: title || null, memberIds: members };
      },

      // Realtime: one open scope's message + reaction streams (RLS-filtered by the client JWT).
      subscribeScope(scope, { onInsert, onUpdate, onReaction }) {
        const c = this.client(); if (!c || !scope) return null;
        const col = this._scopeCol(scope);
        const ch = c.channel('chat:' + scope.kind + ':' + scope.id)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: col + '=eq.' + scope.id }, (p) => onInsert && onInsert(p.new))
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: col + '=eq.' + scope.id }, (p) => onUpdate && onUpdate(p.new))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_message_reactions' }, (p) => onReaction && onReaction(p))
          .subscribe();
        return ch;
      },
      unsubscribe(ch) { const c = this.client(); if (ch && c) c.removeChannel(ch); },
    };

    // Parse @Name / @channel / @here / #channel out of composed text → mention rows for chat_mentions.

    // ─── Mention parsing + XSS-safe message renderer ──────────────────
    function parseChatMentions(text, scope, roster, channels) {
      const out = []; const seen = {};
      let m; const MEN = /(^|[\s.,!?])@([A-Za-z0-9._-]+)/g;
      while ((m = MEN.exec(text))) {
        const h = m[2].toLowerCase();
        if (h === 'here') { if (!seen.here) { out.push({ type: 'here' }); seen.here = 1; } continue; }
        if (h === 'channel') { if (!seen.channel && scope.kind === 'channel') { out.push({ type: 'channel', channelId: scope.id }); seen.channel = 1; } continue; }
        const p = (roster || []).find(u => (u.first_name || '').toLowerCase() === h || (((u.first_name || '') + (u.last_name || '')).toLowerCase()) === h);
        if (p && !seen['u' + p.id]) { out.push({ type: 'user', userId: p.id }); seen['u' + p.id] = 1; }
      }
      return out;
    }

    // XSS-safe message renderer → React nodes (text auto-escaped; <a> only for http/https;
    // @mention and #channel become styled chips). NEVER uses dangerouslySetInnerHTML.
    function chatSafeHref(raw) {
      try { const u = new URL(raw); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null; }
      catch (e) { return null; }
    }
    function renderMessageContent(text, ctx) {
      ctx = ctx || {};
      const s = String(text == null ? '' : text);
      const matches = [];
      let m;
      const URL_RE = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]/g;
      while ((m = URL_RE.exec(s))) matches.push({ start: m.index, end: m.index + m[0].length, type: 'url', text: m[0] });
      const MEN_RE = /@\[([0-9a-fA-F-]{36})\]|@([A-Za-z0-9._-]+)/g;
      while ((m = MEN_RE.exec(s))) matches.push({ start: m.index, end: m.index + m[0].length, type: 'mention', id: m[1] || null, handle: m[2] || null });
      const CH_RE = /(^|[\s.,!?])#([a-z0-9][a-z0-9-]*)/g;
      while ((m = CH_RE.exec(s))) { const st = m.index + (m[1] || '').length; matches.push({ start: st, end: st + 1 + m[2].length, type: 'channel', name: m[2] }); }
      // Markdown-ish formatting (precedence follows push order via the overlap guard):
      const CODE_RE = /`([^`\n]+)`/g;
      while ((m = CODE_RE.exec(s))) matches.push({ start: m.index, end: m.index + m[0].length, type: 'code', inner: m[1] });
      const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
      while ((m = LINK_RE.exec(s))) matches.push({ start: m.index, end: m.index + m[0].length, type: 'mdlink', inner: m[1], url: m[2] });
      const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
      while ((m = BOLD_RE.exec(s))) matches.push({ start: m.index, end: m.index + m[0].length, type: 'bold', inner: m[1] });
      const ITAL_RE = /(?:^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g;
      while ((m = ITAL_RE.exec(s))) { const st = s.indexOf('_', m.index); matches.push({ start: st, end: st + 2 + m[1].length, type: 'italic', inner: m[1] }); }
      matches.sort((a, b) => a.start - b.start);
      const out = []; let idx = 0, key = 0, lastEnd = 0;
      const chip = ctx.chipColor || (ctx.dark ? '#C9A45A' : '#AD832F');
      const link = ctx.linkColor || (ctx.dark ? '#7FB2FF' : '#2F6FE0');
      for (let i = 0; i < matches.length; i++) {
        const t = matches[i];
        if (t.start < lastEnd) continue;
        if (t.start > idx) out.push(s.slice(idx, t.start));
        if (t.type === 'url') {
          const href = chatSafeHref(t.text);
          out.push(href
            ? React.createElement('a', { key: key++, href, target: '_blank', rel: 'noopener noreferrer', style: { color: link, textDecoration: 'underline', wordBreak: 'break-all' } }, t.text)
            : t.text);
        } else if (t.type === 'mention') {
          let nm = (t.id && ctx.byId && ctx.byId[t.id]) ? ctx.byId[t.id] : null;
          out.push(React.createElement('span', { key: key++, style: { color: chip, fontWeight: 600 } }, '@' + (nm || t.handle || 'unknown')));
        } else if (t.type === 'channel') {
          out.push(React.createElement('span', { key: key++, style: { color: chip, fontWeight: 600 } }, '#' + t.name));
        } else if (t.type === 'code') {
          out.push(React.createElement('span', { key: key++, style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '0.92em', background: ctx.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,26,74,0.08)', padding: '1px 5px', borderRadius: 5 } }, t.inner));
        } else if (t.type === 'mdlink') {
          const href = chatSafeHref(t.url);
          out.push(href
            ? React.createElement('a', { key: key++, href, target: '_blank', rel: 'noopener noreferrer', style: { color: link, textDecoration: 'underline', wordBreak: 'break-all' } }, t.inner)
            : s.slice(t.start, t.end));
        } else if (t.type === 'bold') {
          out.push(React.createElement('span', { key: key++, style: { fontWeight: 700 } }, renderMessageContent(t.inner, ctx)));
        } else if (t.type === 'italic') {
          out.push(React.createElement('span', { key: key++, style: { fontStyle: 'italic' } }, renderMessageContent(t.inner, ctx)));
        }
        idx = t.end; lastEnd = t.end;
      }
      if (idx < s.length) out.push(s.slice(idx));
      return out;
    }

    // ─── Profiles / access ───────────────────────────────────────────
    // Per-tool access: which configurable roles can open each tool/app.
    // Admins are always on. Operations is a configurable role like the others.
    // Editable in Admin → Tab Access, persisted in app_access (see app-access.sql).

    // ─── ProfileDB (profiles table) ───────────────────────────────────
    const ProfileDB = {
      client() { return window.SupabaseAuth?._client || null; },
      uid() { return window.SupabaseAuth?._state?.session?.user?.id || null; },

      // Returns the user's profile; auto-creates a pending one on first sign-in. Fail-open (null) on error.
      async ensureProfile(user) {
        if (!this.client()) return null;
        try {
          const { data, error } = await this.client().from('profiles').select('*').eq('id', user.id).maybeSingle();
          if (error) { console.error('[ProfileDB] load:', error.message); return null; }
          if (data) return data;
          const full = (user.user_metadata?.full_name || '').trim();
          const parts = full.split(' ');
          const first = parts.shift() || null;
          const last = parts.join(' ') || null;
          const { data: ins, error: e2 } = await this.client().from('profiles').insert({
            id: user.id, email: user.email, first_name: first, last_name: last,
            avatar_url: user.user_metadata?.avatar_url || null,
          }).select().single();
          if (e2) { console.error('[ProfileDB] create:', e2.message); return null; }
          return ins;
        } catch (e) { console.error('[ProfileDB] ensure:', e); return null; }
      },

      async loadAll() {
        if (!this.client()) return [];
        const { data, error } = await this.client().from('profiles').select('*').order('created_at', { ascending: true });
        if (error) { console.error('[ProfileDB] loadAll:', error.message); return []; }
        return data || [];
      },

      async updateMine(fields) {
        if (!this.client()) return;
        const m = { first_name: fields.first_name || null, last_name: fields.last_name || null, phone: fields.phone || null };
        ['country', 'timezone', 'dob', 'pets'].forEach(k => { if (fields[k] !== undefined) m[k] = fields[k] || null; });
        const { error } = await this.client().from('profiles').update(m).eq('id', this.uid());
        if (error) { console.error('[ProfileDB] updateMine:', error.message); throw error; }
      },

      // Presence/status (own profile). touchPresence = the "I'm online" heartbeat.
      async touchPresence() {
        if (!this.client()) return;
        try { await this.client().from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', this.uid()); } catch (e) {}
      },
      async setPresence(fields) {   // { away?, status_text?, status_emoji? }
        if (!this.client()) return;
        const { error } = await this.client().from('profiles').update(fields).eq('id', this.uid());
        if (error) console.error('[ProfileDB] setPresence:', error.message);
      },

      async adminUpdate(id, fields) {
        if (!this.client()) return;
        const mapped = {};
        ['employee_id', 'title', 'reports_to', 'assigned_tc', 'access', 'status', 'hire_date'].forEach(k => { if (fields[k] !== undefined) mapped[k] = fields[k] || null; });
        const { error } = await this.client().from('profiles').update(mapped).eq('id', id);
        if (error) { console.error('[ProfileDB] adminUpdate:', error.message); throw error; }
      },
    };


    // ─── Directory seed + roster builder + profile view ───────────────
    const DIRECTORY_EXCLUDE = ['cassandra clemons', 'cassie clemons'];
    const TEAM = [
      { id: 'tarek', name: 'Tarek Morshed', title: 'Chief Realty Officer',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2023/01/tarek-morshed-headshot.jpg',
        badge: { label: 'Principal', lightBg: '#001A4A', lightFg: '#C9A45A', darkBg: '#C9A45A', darkFg: '#001A4A' },
        employeeId: '', reportsTo: '', phone: '', email: '', location: '', timezone: '', pets: '' },
      { id: 'symon', name: 'Symon Yongco', title: 'Operations Manager',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2025/01/Hidenori-Symon-Yongco-headshot.jpg',
        badge: { label: 'Admin', lightBg: '#F3EBDA', lightFg: '#AD832F', darkBg: 'rgba(173,131,47,0.2)', darkFg: '#C9A45A' },
        employeeId: 'TMG-03', reportsTo: '', phone: '(512) 643-6688', email: 'manager@themorshedgroup.com', location: 'Manila, Philippines', timezone: 'Asia/Manila', pets: '🐶 Dog' },
      { id: 'brad', name: 'Brad Baker', title: 'Real Estate Professional',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2023/01/Brad-Baker-headshot-1.jpg',
        badge: null, employeeId: '', reportsTo: '', phone: '', email: '', location: '', timezone: '', pets: '' },
      { id: 'brett', name: 'Brett Silverman', title: 'Commercial Advisor',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2025/09/Brett-Silverman-headshot.jpg',
        badge: null, employeeId: '', reportsTo: '', phone: '', email: '', location: '', timezone: '', pets: '' },
      { id: 'kyle', name: 'Kyle Baird', title: 'Real Estate Professional',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Kyle-Baird-headshot.jpg',
        badge: null, employeeId: '', reportsTo: '', phone: '', email: '', location: '', timezone: '', pets: '' },
      { id: 'alexandra', name: 'Alexandra Machado', title: 'Transaction Coordinator',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2025/04/Alexandra-Machado-headshot.jpg',
        badge: null, employeeId: '', reportsTo: '', phone: '', email: '', location: '', timezone: '', pets: '' },
      { id: 'luciana', name: 'Luciana Pilco', title: 'Executive Assistant',
        photo: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Luciana-Pilco-headshot.jpg',
        badge: null, employeeId: '', reportsTo: '', phone: '', email: '', location: '', timezone: '', pets: '' },
    ];

    // Avatar with an initials fallback when no photo/account-avatar exists.

    function Avatar({ photo, name, size }) {
      if (photo) return <img src={photo} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
      return <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.navy, color: C.goldSoft, fontFamily: "'Jost', sans-serif", fontWeight: 600, fontSize: Math.round(size * 0.4) }}>{(name || '?').trim().charAt(0).toUpperCase()}</div>;
    }

    // Inline image attachment: resolves a (private-bucket) signed URL on mount, shows a placeholder
    // while loading, then a rounded thumbnail that opens full-size in a new tab. Falls back to a
    // staged previewUrl (optimistic/dev) before any signed URL is available.
    function AttachmentImage({ att, dark }) {
      const [url, setUrl] = useState(att.previewUrl || '');
      const [err, setErr] = useState(false);
      useEffect(() => {
        let active = true;
        ChatDB.signedUrl(att.storage_path).then(u => { if (active && u) setUrl(u); }).catch(() => {});
        return () => { active = false; };
      }, [att.storage_path]);
      const ph = dark ? '#0A1730' : '#F3EBDA', phBord = dark ? '#152545' : '#E4DFD4', phCol = dark ? 'rgba(255,255,255,0.4)' : '#8A8676';
      if (err || (!url && !att.previewUrl)) {
        if (err) return (
          <div style={{ maxWidth: 220, padding: '10px 12px', borderRadius: 10, background: ph, border: `1px solid ${phBord}`, color: phCol, fontFamily: "'Jost', sans-serif", fontSize: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-photo-off" style={{ fontSize: 14 }} />{att.file_name || 'Image unavailable'}
          </div>
        );
        return <div style={{ width: 160, height: 110, borderRadius: 10, background: ph, border: `1px solid ${phBord}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: phCol }}><i className="ti ti-photo" style={{ fontSize: 22 }} /></div>;
      }
      return (
        <img src={url} alt={att.file_name || 'attachment'} onError={() => setErr(true)}
          onClick={() => { const u = url || att.previewUrl; if (u) window.open(u, '_blank', 'noopener,noreferrer'); }}
          style={{ maxWidth: 220, maxHeight: 240, width: 'auto', height: 'auto', borderRadius: 10, cursor: 'pointer', display: 'block', objectFit: 'cover', border: `1px solid ${phBord}` }} />
      );
    }

    // Compact inline audio player for voice-note attachments. Resolves a signed (or dev object) URL on mount.
    function AttachmentAudio({ att, dark }) {
      const [url, setUrl] = useState(att.previewUrl || '');
      useEffect(() => {
        let active = true;
        if (!att.previewUrl) ChatDB.signedUrl(att.storage_path).then(u => { if (active && u) setUrl(u); }).catch(() => {});
        return () => { active = false; };
      }, [att.storage_path]);
      const bord = dark ? '#152545' : '#E4DFD4', bg = dark ? '#0A1730' : '#fff', col = dark ? 'rgba(255,255,255,0.5)' : '#8A8676';
      if (!url) {
        return (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: 240, maxWidth: '100%', padding: '8px 10px', borderRadius: 12, background: bg, border: `1px solid ${bord}`, color: col, fontFamily: "'Jost', sans-serif", fontSize: 10 }}>
            <i className="ti ti-microphone" style={{ fontSize: 15 }} />Voice message
          </div>
        );
      }
      return (
        <audio controls preload="metadata" src={url} aria-label="Voice message"
          style={{ width: 240, maxWidth: '100%', height: 36, borderRadius: 12, display: 'block' }} />
      );
    }

    // Merge live Supabase profiles OVER the curated TEAM seed (see note above).
    function buildRoster(profiles) {
      profiles = profiles || [];
      const fullName = (p) => (((p.first_name || '') + ' ' + (p.last_name || '')).trim());
      const petsText = (v) => Array.isArray(v) ? v.map(petLabel).join('  ') : (v || '');
      const locationText = (p) => {
        if (!p) return '';
        const c = COUNTRIES.find(x => x.c === p.country);
        const cn = c ? c.n : (p.country || '');
        const city = p.timezone ? tzCity(p.timezone) : '';
        return [city, cn].filter(Boolean).join(', ');
      };
      const byId = {}, byName = {}, byEmail = {};
      profiles.forEach(p => {
        byId[p.id] = p;
        const nm = fullName(p).toLowerCase(); if (nm) byName[nm] = p;
        if (p.email) byEmail[p.email.toLowerCase()] = p;
      });
      const reportsName = (id) => { const m = id ? byId[id] : null; return m ? (fullName(m) || m.email || '') : ''; };
      const used = new Set();

      // Curated seed (fixed order), each enriched by its matching live profile.
      const seeded = TEAM.map(s => {
        const live = (s.email && byEmail[s.email.toLowerCase()]) || byName[s.name.toLowerCase()] || null;
        if (live) used.add(live.id);
        return {
          id: s.id, name: s.name,
          title: s.title || (live && live.title) || '',
          photo: s.photo || (live && live.avatar_url) || '',
          badge: s.badge,
          employeeId: (live && live.employee_id) || s.employeeId || '',
          reportsTo: (live && reportsName(live.reports_to)) || s.reportsTo || '',
          phone: (live && live.phone) || s.phone || '',
          email: (live && live.email) || s.email || '',
          location: (live && locationText(live)) || s.location || '',
          timezone: (live && live.timezone) || s.timezone || '',
          pets: (live && live.pets && live.pets.length ? petsText(live.pets) : '') || s.pets || '',
        };
      });

      // New sign-ups not already in the curated seed (active accounts only).
      const extras = profiles
        .filter(p => !used.has(p.id) && p.status === 'active' && (fullName(p) || p.email) && !DIRECTORY_EXCLUDE.includes(fullName(p).trim().toLowerCase()))
        .map(p => ({
          id: p.id, name: fullName(p) || p.email,
          title: p.title || '',
          photo: p.avatar_url || '',
          badge: hasAdmin(p.access) ? { label: 'Admin', lightBg: '#F3EBDA', lightFg: '#AD832F', darkBg: 'rgba(173,131,47,0.2)', darkFg: '#C9A45A' } : null,
          employeeId: p.employee_id || '',
          reportsTo: reportsName(p.reports_to),
          phone: p.phone || '',
          email: p.email || '',
          location: locationText(p),
          timezone: p.timezone || '',
          pets: petsText(p.pets),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return seeded.concat(extras);
    }

    function ProfileView({ person, dark, onBack }) {
      const J = "'Jost', sans-serif";
      const p = person;
      const ink   = dark ? '#fff' : '#001A4A';
      const role  = dark ? 'rgba(255,255,255,0.4)' : '#9A958A';
      const keyC  = dark ? 'rgba(255,255,255,0.4)' : '#9A958A';
      const valC  = dark ? '#fff' : '#001A4A';
      const muted = dark ? 'rgba(255,255,255,0.4)' : '#9A958A';
      const bord  = dark ? '#0D1E3A' : '#F0EBE3';
      const rows = [
        ['Employee ID', p.employeeId],
        ['Title', p.title],
        ['Reports to', p.reportsTo],
        ['Phone', p.phone],
        ['Email', p.email],
        ['Location', p.location],
        ['Local time', p.timezone ? localTimeIn(p.timezone) : ''],
        ['Pets', p.pets],
      ];
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ padding: '11px 14px 0', display: 'flex', alignItems: 'center', gap: 9 }}>
            <button onClick={onBack} aria-label="Back to directory" style={{ background: 'none', border: 'none', padding: 0, display: 'flex', alignItems: 'center', cursor: 'pointer', color: ink }}>
              <i className="ti ti-chevron-left" style={{ fontSize: 18 }} />
            </button>
            <span style={{ fontFamily: J, fontSize: 13, fontWeight: 600, color: ink }}>Directory</span>
          </div>
          {/* Profile header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13, padding: '16px 16px 14px' }}>
            <Avatar photo={p.photo} name={p.name} size={60} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: J, fontSize: 16, fontWeight: 600, lineHeight: 1.1, color: ink }}>{p.name}</div>
              <div style={{ fontFamily: J, fontSize: 10, marginTop: 3, color: role }}>{p.title}</div>
            </div>
            {p.badge && <span style={{ flexShrink: 0, fontFamily: J, fontSize: 7, letterSpacing: '0.12em', fontWeight: 600, textTransform: 'uppercase', padding: '3px 9px', borderRadius: 11, background: dark ? p.badge.darkBg : p.badge.lightBg, color: dark ? p.badge.darkFg : p.badge.lightFg }}>{p.badge.label}</span>}
          </div>
          {/* Field rows */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {rows.map((r, idx) => {
              const empty = !r[1];
              const isEmail = r[0] === 'Email';
              return (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 16px', borderBottom: `1px solid ${bord}`, gap: 12 }}>
                  <span style={{ fontFamily: J, fontSize: 10, color: keyC, flexShrink: 0 }}>{r[0]}</span>
                  <span style={{ fontFamily: J, fontSize: isEmail ? 8.5 : 10, fontWeight: 600, textAlign: 'right', color: empty ? muted : valC, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{empty ? '—' : contactLink(r[0], r[1])}</span>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    // ─── Team Chat components ─────────────────────────────────────────
    const TCHAT_PHOTOS = {
      tarek:   'https://themorshedgroup.com/wp-content/uploads/2023/01/tarek-morshed-headshot.jpg',
      symon:   'https://themorshedgroup.com/wp-content/uploads/2025/01/Hidenori-Symon-Yongco-headshot.jpg',
      brad:    'https://themorshedgroup.com/wp-content/uploads/2023/01/Brad-Baker-headshot-1.jpg',
      brett:   'https://themorshedgroup.com/wp-content/uploads/2025/09/Brett-Silverman-headshot.jpg',
      kyle:    'https://themorshedgroup.com/wp-content/uploads/2026/02/Kyle-Baird-headshot.jpg',
      alex:    'https://themorshedgroup.com/wp-content/uploads/2025/04/Alexandra-Machado-headshot.jpg',
      luciana: 'https://themorshedgroup.com/wp-content/uploads/2026/02/Luciana-Pilco-headshot.jpg',
    };

    // ─── Team Chat ("Chat") — real, realtime, backed by ChatDB ───────
    const CHAT_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '🔥', '👀', '✅'];
    // Flat palette for the composer emoji picker (insert into the input). Distinct from CHAT_EMOJIS (reactions).
    const COMPOSER_EMOJIS = [
      '😀', '😄', '😅', '😂', '🙂', '😉', '😊', '😍', '😎', '🤔', '😴', '😢',
      '😭', '😡', '🥳', '😬', '👍', '👎', '👏', '🙌', '🙏', '👌', '🤙', '💪',
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '🎉', '✅', '⭐', '💡', '📌',
    ];

    function NewChannelModal({ dark, isAdmin, onClose, onCreated }) {
      const J = "'Jost', sans-serif";
      const panelBg = dark ? '#0A1730' : '#FFFFFF', txt = dark ? '#fff' : '#001A4A', sub = dark ? 'rgba(255,255,255,0.55)' : '#6B6B6B', bord = dark ? '#152545' : '#E4DFD4', inpBg = dark ? '#06101F' : '#F3EBDA';
      const [name, setName] = useState(''); const [type, setType] = useState(isAdmin ? 'public' : 'private'); const [topic, setTopic] = useState(''); const [busy, setBusy] = useState(false);
      const inp = { width: '100%', padding: '10px 12px', background: inpBg, border: `1px solid ${bord}`, borderRadius: 10, color: dark ? '#fff' : '#001A4A', fontSize: '0.85rem', outline: 'none', fontFamily: J, boxSizing: 'border-box' };
      const create = async () => {
        const nm = name.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
        if (!nm) { alert('Give the channel a name.'); return; }
        setBusy(true);
        try { const ch = await ChatDB.createChannel({ name: nm, type, topic: topic.trim() }); onCreated(ch); }
        catch (e) { alert('Could not create channel: ' + (e.message || e)); } finally { setBusy(false); }
      };
      const tBtn = (val, label, icon, disabled) => (
        <button onClick={() => !disabled && setType(val)} disabled={disabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: J, fontSize: '0.8rem', fontWeight: 600, border: `1px solid ${type === val ? (dark ? '#C9A45A' : '#AD832F') : bord}`, background: type === val ? (dark ? 'rgba(173,131,47,0.18)' : '#F3EBDA') : 'transparent', color: disabled ? (dark ? 'rgba(255,255,255,0.25)' : '#B4B2A9') : (type === val ? (dark ? '#C9A45A' : '#AD832F') : txt) }}>
          <i className={`ti ${icon}`} style={{ fontSize: 15 }} />{label}
        </button>
      );
      return (
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,13,38,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, background: panelBg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '18px 18px calc(20px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ flex: 1, fontFamily: J, fontSize: '1rem', fontWeight: 600, color: txt }}>New channel</div>
              <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: sub, fontSize: 20, display: 'flex' }}><i className="ti ti-x" /></button>
            </div>
            <div style={{ fontSize: '0.62rem', letterSpacing: '0.05em', color: sub, fontWeight: 600, marginBottom: 5, fontFamily: J }}>NAME</div>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. listings" style={{ ...inp, marginBottom: 12 }} />
            <div style={{ display: 'flex', gap: 8, marginBottom: type === 'public' && !isAdmin ? 6 : 12 }}>
              {tBtn('public', 'Public', 'ti-hash', !isAdmin)}
              {tBtn('private', 'Private', 'ti-lock', false)}
            </div>
            {!isAdmin && <div style={{ fontSize: '0.68rem', color: sub, marginBottom: 12, fontFamily: J }}>Only admins can create public channels. You can create a private one.</div>}
            <div style={{ fontSize: '0.62rem', letterSpacing: '0.05em', color: sub, fontWeight: 600, marginBottom: 5, fontFamily: J }}>TOPIC <span style={{ fontWeight: 400 }}>(optional)</span></div>
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="What's this channel about?" style={{ ...inp, marginBottom: 16 }} />
            <button onClick={create} disabled={busy} style={{ width: '100%', padding: 12, background: dark ? '#AD832F' : '#001A4A', color: '#fff', border: 'none', borderRadius: 12, fontSize: '0.9rem', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: J }}>{busy ? 'Creating…' : 'Create channel'}</button>
          </div>
        </div>
      );
    }

    function NewDMModal({ dark, roster, me, onClose, onCreated }) {
      const J = "'Jost', sans-serif";
      const panelBg = dark ? '#0A1730' : '#FFFFFF', txt = dark ? '#fff' : '#001A4A', sub = dark ? 'rgba(255,255,255,0.55)' : '#6B6B6B', bord = dark ? '#152545' : '#E4DFD4', inpBg = dark ? '#06101F' : '#F3EBDA';
      const [q, setQ] = useState(''); const [picked, setPicked] = useState([]); const [busy, setBusy] = useState(false);
      const nameOf = (p) => (((p.first_name || '') + ' ' + (p.last_name || '')).trim()) || p.email || 'Member';
      const people = roster.filter(p => p.id !== me);
      const ql = q.trim().toLowerCase();
      const shown = people.filter(p => !ql || nameOf(p).toLowerCase().includes(ql) || (p.email || '').toLowerCase().includes(ql));
      const toggle = (id) => setPicked(ps => ps.includes(id) ? ps.filter(x => x !== id) : [...ps, id]);
      const start = async () => {
        if (!picked.length || busy) return; setBusy(true);
        try { const cv = picked.length === 1 ? await ChatDB.createDM(picked[0]) : await ChatDB.createGroupDM(picked); onCreated(cv); }
        catch (e) { alert('Could not start chat: ' + (e.message || e)); } finally { setBusy(false); }
      };
      return (
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,13,38,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, background: panelBg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '18px 18px calc(16px + env(safe-area-inset-bottom))', maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ flex: 1, fontFamily: J, fontSize: '1rem', fontWeight: 600, color: txt }}>New message</div>
              <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: sub, fontSize: 20, display: 'flex' }}><i className="ti ti-x" /></button>
            </div>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…" style={{ width: '100%', padding: '10px 12px', background: inpBg, border: `1px solid ${bord}`, borderRadius: 10, color: dark ? '#fff' : '#001A4A', fontSize: '0.85rem', outline: 'none', fontFamily: J, boxSizing: 'border-box', marginBottom: 10 }} />
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 80 }}>
              {shown.length === 0 && <div style={{ fontFamily: J, fontSize: '0.8rem', color: sub, textAlign: 'center', padding: 20 }}>No people found.</div>}
              {shown.map(p => {
                const on = picked.includes(p.id);
                return (
                  <div key={p.id} onClick={() => toggle(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', cursor: 'pointer', borderRadius: 10, background: on ? (dark ? 'rgba(173,131,47,0.12)' : '#F3EBDA') : 'transparent' }}>
                    <Avatar photo={p.avatar_url} name={nameOf(p)} size={34} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: J, fontSize: '0.85rem', fontWeight: 500, color: txt, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nameOf(p)}</div>
                      {p.title && <div style={{ fontFamily: J, fontSize: '0.7rem', color: sub }}>{p.title}</div>}
                    </div>
                    <i className={`ti ${on ? 'ti-circle-check-filled' : 'ti-circle'}`} style={{ fontSize: 20, color: on ? (dark ? '#C9A45A' : '#AD832F') : (dark ? 'rgba(255,255,255,0.2)' : '#D8D2C6') }} />
                  </div>
                );
              })}
            </div>
            <button onClick={start} disabled={!picked.length || busy} style={{ width: '100%', padding: 12, marginTop: 10, background: picked.length ? (dark ? '#AD832F' : '#001A4A') : (dark ? '#1A2A45' : '#C9CDD6'), color: '#fff', border: 'none', borderRadius: 12, fontSize: '0.9rem', fontWeight: 600, cursor: picked.length ? 'pointer' : 'not-allowed', fontFamily: J }}>{busy ? 'Starting…' : (picked.length > 1 ? `Start group chat (${picked.length})` : 'Start chat')}</button>
          </div>
        </div>
      );
    }

    function ChatConversation({ dark, scope, me, roster, channels, rosterById, nameOf, photoOf, awayOf, statusOf, showBack, onBack, onRead }) {
      const J = "'Jost', sans-serif";
      const barBg = dark ? '#070F1E' : '#FFFFFF', barBord = dark ? '#0D1E3A' : '#F0EBE3', msgBg = dark ? '#070F1E' : '#FCFBF8';
      const backCol = dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,26,74,0.4)', titleCol = dark ? '#fff' : '#001A4A', subCol = dark ? 'rgba(255,255,255,0.4)' : '#6B6B6B';
      const theirBg = dark ? '#0A1E44' : '#FFFFFF', theirCol = dark ? '#fff' : '#001A4A', theirBord = dark ? 'none' : '1px solid #E4DFD4';
      const mineBg = dark ? '#AD832F' : '#001A4A', timeCol = dark ? 'rgba(255,255,255,0.3)' : '#B4B2A9', senderGold = dark ? '#C9A45A' : '#AD832F';
      const inBarBg = dark ? '#070F1E' : '#F5F0E8', inBarBord = dark ? '#0D1E3A' : '#E0D8CC', inFieldBg = dark ? '#0A1730' : '#FFFFFF', inFieldBord = dark ? '#152545' : '#E0D8CC', sendBg = dark ? '#AD832F' : '#001A4A';
      const reactBg = dark ? 'rgba(173,131,47,0.15)' : '#F3EBDA', reactBord = dark ? '#152545' : '#E4DFD4', reactMineBd = dark ? '#C9A45A' : '#AD832F';
      const isGroup = scope.kind === 'channel' || (scope.conv && scope.conv.type === 'group_dm');
      const peerId = (scope.kind === 'conversation' && scope.conv && scope.conv.type === 'dm') ? scope.conv.memberIds.find(id => id !== me) : null;

      const [messages, setMessages] = useState([]); const [loading, setLoading] = useState(true);
      const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [menu, setMenu] = useState(null);
      const [emojiPicker, setEmojiPicker] = useState(null); // 'main' | 'thread' | null
      const [actionFor, setActionFor] = useState(null); const [editId, setEditId] = useState(null); const [editText, setEditText] = useState('');
      const [hoverId, setHoverId] = useState(null); const [memberReads, setMemberReads] = useState([]);
      const isTouch = typeof window !== 'undefined' && 'ontouchstart' in window;
      const [thread, setThread] = useState(null); const [threadMsgs, setThreadMsgs] = useState([]); const [threadText, setThreadText] = useState(''); const [tSending, setTSending] = useState(false);
      const [pending, setPending] = useState([]); // staged attachments: { id, file, meta, status, previewUrl }
      const fileRef = useRef(null);
      // ── Voice-message recording ──
      const canRecord = typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
      const [rec, setRec] = useState(null);          // null | 'recording' | 'processing'
      const [recSecs, setRecSecs] = useState(0);
      const [recError, setRecError] = useState('');  // soft inline message (e.g. permission denied)
      const mediaRef = useRef(null);                 // active MediaRecorder
      const streamRef = useRef(null);                // active MediaStream (to stop tracks)
      const chunksRef = useRef([]);                  // recorded Blob chunks
      const recTimerRef = useRef(null);              // 1s tick interval
      const recMimeRef = useRef('');                 // chosen recorder mimeType
      const voiceUrlsRef = useRef([]);               // object URLs to revoke on unmount
      const listRef = useRef(null); const composerRef = useRef(null); const threadComposerRef = useRef(null); const threadRef = useRef(null);
      const prevMsgCount = useRef(0);
      threadRef.current = thread;
      const scrollDown = () => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; };
      const nearBottom = () => { const el = listRef.current; if (!el) return true; return (el.scrollHeight - el.scrollTop - el.clientHeight) < 80; };
      const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
      const byIdNames = {}; Object.keys(rosterById).forEach(id => { byIdNames[id] = nameOf(id); });
      const ctxFor = (mine) => mine ? { dark, byId: byIdNames, chipColor: '#fff', linkColor: '#fff' } : { dark, byId: byIdNames };

      const dedupeAdd = (prev, row) => prev.some(x => (row.client_id && x.client_id === row.client_id) || x.id === row.id)
        ? prev.map(x => ((row.client_id && x.client_id === row.client_id) || x.id === row.id) ? { ...x, ...row } : x) : [...prev, row];
      const applyReaction = (list, p) => {
        const r = (p.new && p.new.message_id) ? p.new : p.old; if (!r || !r.message_id) return list;
        return list.map(mm => {
          if (mm.id !== r.message_id) return mm;
          let rx = mm.reactions || [];
          if (p.eventType === 'DELETE') rx = rx.filter(x => !(x.emoji === r.emoji && x.user_id === r.user_id));
          else if (!rx.some(x => x.emoji === r.emoji && x.user_id === r.user_id)) rx = [...rx, { emoji: r.emoji, user_id: r.user_id }];
          return { ...mm, reactions: rx };
        });
      };

      useEffect(() => {
        let active = true; setLoading(true); setMemberReads([]);
        ChatDB.loadMessages(scope).then(ms => { if (active) { setMessages(ms); setLoading(false); setTimeout(scrollDown, 40); ChatDB.markRead(scope, ms.length ? ms[ms.length - 1].id : null).then(() => onRead && onRead()); } });
        ChatDB.loadMemberReads(scope).then(rows => { if (active) setMemberReads((rows || []).filter(r => r.user_id !== me)); });
        const upsertRead = (row) => setMemberReads(prev => {
          if (!row || row.user_id === me) return prev;
          const i = prev.findIndex(r => r.user_id === row.user_id);
          const next = { user_id: row.user_id, last_read_at: row.last_read_at, last_read_message_id: row.last_read_message_id };
          if (i < 0) return [...prev, next];
          const copy = prev.slice(); copy[i] = { ...copy[i], ...next }; return copy;
        });
        const readCh = ChatDB.subscribeMemberReads(scope, upsertRead);
        const ch = ChatDB.subscribeScope(scope, {
          onInsert: (row) => {
            // Attachments live in a separate table, so realtime delivers the message row without them.
            // For messages that aren't my own optimistic echo, fetch + patch attachments so images appear live.
            const isMine = row.author_id === me;
            const patchAttachments = () => {
              if (isMine) return; // my own row already carries its (optimistic→real) attachments
              ChatDB.loadAttachments([row.id]).then(byId => {
                const atts = byId[row.id] || []; if (!atts.length) return;
                const apply = (l) => l.map(x => x.id === row.id ? { ...x, attachments: atts } : x);
                setMessages(apply); setThreadMsgs(apply);
              });
            };
            if (row.thread_parent_id) {
              setMessages(prev => prev.map(x => x.id === row.thread_parent_id ? { ...x, reply_count: (x.reply_count || 0) + 1 } : x));
              if (threadRef.current && threadRef.current.id === row.thread_parent_id) { setThreadMsgs(prev => dedupeAdd(prev, row)); patchAttachments(); }
            } else {
              setMessages(prev => dedupeAdd(prev, row));
              patchAttachments();
              ChatDB.markRead(scope, row.id).then(() => onRead && onRead());
            }
          },
          onUpdate: (row) => { setMessages(prev => prev.map(x => x.id === row.id ? { ...x, ...row } : x)); setThreadMsgs(prev => prev.map(x => x.id === row.id ? { ...x, ...row } : x)); },
          onReaction: (p) => { setMessages(prev => applyReaction(prev, p)); setThreadMsgs(prev => applyReaction(prev, p)); },
        });
        return () => { active = false; ChatDB.unsubscribe(ch); ChatDB.unsubscribe(readCh); };
      }, [scope.id]);
      // Auto-scroll only when MAIN messages grow AND the user is already near the bottom.
      // Skips yanking the view when an inline thread expands mid-list or a reply arrives in an open thread.
      useEffect(() => {
        const grew = messages.length > prevMsgCount.current;
        prevMsgCount.current = messages.length;
        if (grew && nearBottom()) scrollDown();
      }, [messages.length]);

      const doSend = async (body, threadParentId, clear, setBusy, staged) => {
        // Only upload "ready" attachments; drop ones still uploading or errored.
        const ready = (staged || []).filter(p => p.status === 'ready' && p.meta);
        if (!body.trim() && !ready.length) return;
        const clientId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c' + Date.now() + Math.round(performance.now()));
        // Optimistic attachments render immediately from the already-staged preview/meta.
        const optimisticAtt = ready.map(p => ({ id: 'tmpatt-' + p.id, message_id: 'tmp-' + clientId, ...p.meta }));
        const optimistic = { id: 'tmp-' + clientId, author_id: me, content: body, client_id: clientId, created_at: new Date().toISOString(), reactions: [], reply_count: 0, attachments: optimisticAtt, _pending: true, thread_parent_id: threadParentId || null };
        if (threadParentId) setThreadMsgs(prev => [...prev, optimistic]); else setMessages(prev => [...prev, optimistic]);
        clear(); setBusy(true);
        try {
          // RLS: insert the message FIRST so the real row id exists, THEN attach rows (insert gated to author).
          const row = await ChatDB.sendMessage(scope, { content: body, clientId, threadParentId });
          const mentions = parseChatMentions(body, scope, roster, channels);
          if (mentions.length && row.id) ChatDB.insertMentions(row.id, mentions);
          let attachments = [];
          for (const p of ready) {
            try { const ar = await ChatDB.addAttachmentRow(row.id, p.meta); attachments.push(ar); }
            catch (e) { /* keep the optimistic preview so the user still sees their file */ attachments.push({ id: 'tmpatt-' + p.id, message_id: row.id, ...p.meta }); }
          }
          const merged = { ...row, reactions: [], attachments };
          if (threadParentId) { setThreadMsgs(prev => prev.map(x => x.client_id === clientId ? merged : x)); setMessages(prev => prev.map(x => x.id === threadParentId ? { ...x, reply_count: (x.reply_count || 0) + 1 } : x)); }
          else setMessages(prev => prev.map(x => x.client_id === clientId ? merged : x));
        } catch (e) {
          const mark = (l) => l.map(x => x.client_id === clientId ? { ...x, _pending: false, _failed: true } : x);
          if (threadParentId) setThreadMsgs(mark); else setMessages(mark);
        } finally { setBusy(false); setTimeout(scrollDown, 40); }
      };
      const send = () => doSend(text, null, () => { setText(''); setPending([]); }, setSending, pending);
      const sendThread = () => doSend(threadText, thread && thread.id, () => { setThreadText(''); setPending([]); }, setTSending, pending);
      const onKey = (fn) => (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); } };

      // Allowed upload types: images + common docs (others rejected). Cap each at ATTACH_MAX_BYTES.
      const okType = (f) => isImageMime(f.type) || /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-|text\/|application\/zip|application\/json|application\/octet-stream)/.test(f.type || '') || /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|key|pages|numbers)$/i.test(f.name || '');
      const openFilePicker = () => { if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } };
      const onPickFiles = async (e) => {
        const files = Array.from((e.target && e.target.files) || []);
        if (e.target) e.target.value = '';
        for (const file of files) {
          if (file.size > ATTACH_MAX_BYTES) { alert(`"${file.name}" is too large (max 25 MB).`); continue; }
          if (!okType(file)) { alert(`"${file.name}" — that file type isn't supported.`); continue; }
          const id = (crypto.randomUUID ? crypto.randomUUID() : ('a' + Date.now() + Math.random()));
          const previewUrl = isImageMime(file.type) && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : '';
          setPending(prev => [...prev, { id, file, meta: null, status: 'uploading', previewUrl }]);
          try {
            const meta = await ChatDB.uploadAttachment(scope, file);
            setPending(prev => prev.map(p => p.id === id ? { ...p, meta, status: 'ready', previewUrl: p.previewUrl || meta.previewUrl || '' } : p));
          } catch (err) {
            setPending(prev => prev.map(p => p.id === id ? { ...p, status: 'error' } : p));
          }
        }
      };
      const removePending = (id) => setPending(prev => prev.filter(p => p.id !== id));

      // ── Voice messages ──────────────────────────────────────────────
      // Pick a MediaRecorder mime the browser actually supports (iOS Safari → mp4 only).
      const pickRecMime = () => {
        const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
          for (const c of cands) { if (MediaRecorder.isTypeSupported(c)) return c; }
        }
        return ''; // let the browser choose its default
      };
      const extForMime = (m) => /mp4|m4a|aac/i.test(m) ? 'm4a' : (/ogg/i.test(m) ? 'ogg' : 'webm');
      const clearRecTimer = () => { if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; } };
      const stopTracks = () => { if (streamRef.current) { try { streamRef.current.getTracks().forEach(t => t.stop()); } catch (e) {} streamRef.current = null; } };
      const resetRec = () => { clearRecTimer(); setRecSecs(0); setRec(null); mediaRef.current = null; chunksRef.current = []; };

      const startRecording = async () => {
        if (!canRecord || rec) return;
        setRecError('');
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { setRecError('Microphone access was blocked. Enable it in your browser settings to send a voice message.'); return; }
        try {
          streamRef.current = stream;
          const mime = pickRecMime(); recMimeRef.current = mime;
          const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
          chunksRef.current = [];
          mr.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data); };
          mediaRef.current = mr;
          mr.start();
          setRecSecs(0); setRec('recording');
          clearRecTimer();
          recTimerRef.current = setInterval(() => setRecSecs(s => s + 1), 1000);
        } catch (e) {
          stopTracks(); resetRec();
          setRecError('Could not start recording on this device.');
        }
      };

      const cancelRecording = () => {
        clearRecTimer();
        const mr = mediaRef.current;
        if (mr && mr.state !== 'inactive') { try { mr.onstop = null; mr.stop(); } catch (e) {} }
        stopTracks();
        resetRec();
      };

      // Stop the recorder, build a Blob, upload via the attachment substrate, transcribe, then send.
      const stopAndSend = () => {
        const mr = mediaRef.current;
        if (!mr) { resetRec(); return; }
        clearRecTimer();
        setRec('processing');
        const mime = recMimeRef.current || mr.mimeType || 'audio/webm';
        mr.onstop = async () => {
          stopTracks();
          const blob = new Blob(chunksRef.current, { type: mime });
          chunksRef.current = [];
          if (!blob.size) { resetRec(); return; }
          const ext = extForMime(mime);
          const file = new File([blob], 'voice-' + Date.now() + '.' + ext, { type: mime });
          // Local object URL so the optimistic bubble can play instantly (revoked on unmount).
          let previewUrl = '';
          if (typeof URL !== 'undefined' && URL.createObjectURL) { previewUrl = URL.createObjectURL(blob); voiceUrlsRef.current.push(previewUrl); }
          const aid = (crypto.randomUUID ? crypto.randomUUID() : ('v' + Date.now() + Math.random()));
          try {
            const meta = await ChatDB.uploadAttachment(scope, file);
            meta.previewUrl = previewUrl || meta.previewUrl || '';   // ensure instant playback for my optimistic row
            const transcript = await ChatDB.transcribe(meta.storage_path); // '' → audio-only message
            const staged = [{ id: aid, file, meta, status: 'ready', previewUrl: meta.previewUrl }];
            const inThread = !!(threadRef.current && threadRef.current.id);
            if (inThread) await doSend(transcript, threadRef.current.id, () => {}, () => {}, staged);
            else await doSend(transcript, null, () => {}, () => {}, staged);
          } catch (e) {
            setRecError('Could not send the voice message. Please try again.');
          } finally {
            resetRec();
          }
        };
        try { if (mr.state !== 'inactive') mr.stop(); else mr.onstop(); }
        catch (e) { stopTracks(); resetRec(); }
      };

      // Revoke voice object URLs + tear down any live recording on unmount.
      useEffect(() => () => {
        clearRecTimer();
        if (mediaRef.current && mediaRef.current.state !== 'inactive') { try { mediaRef.current.onstop = null; mediaRef.current.stop(); } catch (e) {} }
        stopTracks();
        voiceUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
        voiceUrlsRef.current = [];
      }, []);

      const fmtRecTime = (s) => { const m = Math.floor(s / 60), ss = s % 60; return m + ':' + String(ss).padStart(2, '0'); };

      // Shared @-mention / #-channel autocomplete. target ('main' | 'thread') tells pickMention which composer to write into.
      const onComposerChangeFor = (target, setVal) => (e) => {
        const val = e.target.value; setVal(val);
        const pos = e.target.selectionStart || val.length;
        const mm = val.slice(0, pos).match(/(^|\s)([@#])([A-Za-z0-9._-]*)$/);
        if (!mm) { setMenu(null); return; }
        const sym = mm[2], qy = mm[3].toLowerCase(), tokenStart = pos - (mm[3].length + 1);
        let items = [];
        if (sym === '@') {
          if (scope.kind === 'channel' && 'channel'.startsWith(qy)) items.push({ label: '@channel', sub: 'Notify the channel', insert: '@channel' });
          if ('here'.startsWith(qy)) items.push({ label: '@here', sub: 'Notify those active', insert: '@here' });
          (roster || []).filter(p => p.id !== me).forEach(p => { const nm = nameOf(p.id); if (!qy || nm.toLowerCase().includes(qy)) items.push({ label: nm, photo: p.avatar_url, insert: '@' + ((p.first_name || nm).replace(/\s+/g, '')) }); });
        } else {
          (channels || []).forEach(c => { if (!qy || c.name.toLowerCase().includes(qy)) items.push({ label: '#' + c.name, insert: '#' + c.name }); });
        }
        if (items.length) setEmojiPicker(null);
        setMenu(items.length ? { items: items.slice(0, 6), tokenStart, pos, target } : null);
      };
      const onComposerChange = onComposerChangeFor('main', setText);
      const onThreadComposerChange = onComposerChangeFor('thread', setThreadText);
      const pickMention = (item) => {
        const inThr = menu && menu.target === 'thread';
        const ref = inThr ? threadComposerRef : composerRef;
        const cur = inThr ? threadText : text;
        const setVal = inThr ? setThreadText : setText;
        const ta = ref.current; const pos = ta ? (ta.selectionStart || cur.length) : cur.length;
        const nt = cur.slice(0, menu.tokenStart) + item.insert + ' ' + cur.slice(pos);
        setVal(nt); setMenu(null);
        setTimeout(() => { if (ta) { ta.focus(); const c = menu.tokenStart + item.insert.length + 1; try { ta.setSelectionRange(c, c); } catch (e) {} } }, 10);
      };
      // Insert an emoji at the caret of the given textarea; keep the picker open (Slack-like).
      const insertEmoji = (em, kRef, setter, val) => {
        const ta = kRef && kRef.current; const v = String(val == null ? '' : val);
        const start = ta ? (ta.selectionStart != null ? ta.selectionStart : v.length) : v.length;
        const end = ta ? (ta.selectionEnd != null ? ta.selectionEnd : start) : start;
        const nt = v.slice(0, start) + em + v.slice(end);
        setter(nt);
        setTimeout(() => { if (ta) { ta.focus(); const c = start + em.length; try { ta.setSelectionRange(c, c); } catch (e) {} } }, 10);
      };
      // Wrap the current selection (or insert a placeholder when empty) with before/after markup.
      const wrapSelection = (kRef, val, setter, before, after, placeholder) => {
        const ta = kRef && kRef.current; const v = String(val == null ? '' : val);
        const start = ta ? (ta.selectionStart != null ? ta.selectionStart : v.length) : v.length;
        const end = ta ? (ta.selectionEnd != null ? ta.selectionEnd : start) : start;
        const sel = v.slice(start, end) || (placeholder || 'text');
        const nt = v.slice(0, start) + before + sel + after + v.slice(end);
        setter(nt);
        // Reselect the inner text so the user can keep typing over it.
        const innerStart = start + before.length; const innerEnd = innerStart + sel.length;
        setTimeout(() => { if (ta) { ta.focus(); try { ta.setSelectionRange(innerStart, innerEnd); } catch (e) {} } }, 10);
      };

      const toggleReaction = (mm, emoji) => {
        const mine = (mm.reactions || []).some(r => r.emoji === emoji && r.user_id === me);
        const upd = (l) => l.map(x => x.id !== mm.id ? x : { ...x, reactions: mine ? (x.reactions || []).filter(r => !(r.emoji === emoji && r.user_id === me)) : [...(x.reactions || []), { emoji, user_id: me }] });
        setMessages(upd); setThreadMsgs(upd);
        if (mine) ChatDB.unreact(mm.id, emoji); else ChatDB.react(mm.id, emoji);
        setActionFor(null);
      };
      const startEdit = (mm) => { setEditId(mm.id); setEditText(mm.content); setActionFor(null); };
      const saveEdit = async () => {
        const body = editText.trim(); const id = editId;
        if (!body) { setEditId(null); return; }
        const upd = (l) => l.map(x => x.id === id ? { ...x, content: body, edited_at: new Date().toISOString() } : x);
        setMessages(upd); setThreadMsgs(upd); setEditId(null);
        try { await ChatDB.editMessage(id, body); } catch (e) { alert('Could not save edit.'); }
      };
      // Toggle the inline thread dock: collapse if this parent is already open, else open it and load replies.
      const openThread = (mm) => {
        setActionFor(null);
        if (threadRef.current && threadRef.current.id === mm.id) { setThread(null); return; }
        setThread(mm); setThreadMsgs([]);
        ChatDB.threadReplies(scope, mm.id).then(setThreadMsgs);
        // Bring the parent row into view and focus the thread composer, replacing the old overlay slide.
        setTimeout(() => {
          const el = document.getElementById('chat-row-' + mm.id);
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          if (threadComposerRef.current) threadComposerRef.current.focus();
        }, 60);
      };

      const groupRx = (rx) => { const g = {}; (rx || []).forEach(r => { (g[r.emoji] = g[r.emoji] || { count: 0, mine: false }); g[r.emoji].count++; if (r.user_id === me) g[r.emoji].mine = true; }); return g; };

      // Read receipt state for one of MY messages: failed | sent (pending) | seen (a member read past it) | delivered.
      const receiptFor = (mm) => {
        if (mm._failed) return 'failed';
        if (mm._pending || String(mm.id).startsWith('tmp')) return 'sent';
        const t = new Date(mm.created_at);
        if (memberReads.some(r => r.user_id !== me && r.last_read_at && new Date(r.last_read_at) >= t)) return 'seen';
        return 'delivered';
      };

      const renderRow = (mm, i, list, inThread) => {
        const mine = mm.author_id === me;
        const prev = list[i - 1];
        const showSender = (isGroup || inThread) && !mine && (!prev || prev.author_id !== mm.author_id);
        const rg = groupRx(mm.reactions);
        const editing = editId === mm.id;
        const canReact = !mm._pending && !mm._failed && !editing;
        const triggerOpacity = isTouch ? 0.4 : (hoverId === mm.id ? 1 : 0);
        const trigCol = dark ? 'rgba(255,255,255,0.55)' : '#8A8676';
        const threadOpen = !inThread && thread && thread.id === mm.id;
        const hasAudioAtt = (mm.attachments || []).some(att => isAudioMime(att.mime_type));
        return (
          <div key={mm.id} id={inThread ? undefined : ('chat-row-' + mm.id)} onMouseEnter={() => setHoverId(mm.id)} onMouseLeave={() => setHoverId(h => h === mm.id ? null : h)} style={{ display: 'flex', flexDirection: 'column', gap: 2, borderRadius: threadOpen ? 10 : 0, background: threadOpen ? (dark ? 'rgba(173,131,47,0.07)' : 'rgba(173,131,47,0.06)') : 'transparent', padding: threadOpen ? '4px 4px 2px' : 0, margin: threadOpen ? '0 -4px' : 0 }}>
            {showSender && <div style={{ fontFamily: J, fontSize: 8, letterSpacing: '0.06em', fontWeight: 600, marginLeft: 28, color: senderGold }}>{nameOf(mm.author_id)}</div>}
            <div style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 6 }}>
              {!mine ? <Avatar photo={photoOf(mm.author_id)} name={nameOf(mm.author_id)} size={22} /> : <div style={{ width: 1 }} />}
              {editing ? (
                <div style={{ maxWidth: '82%', flex: 1 }}>
                  <textarea autoFocus value={editText} onChange={e => setEditText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') setEditId(null); }} rows={2} style={{ width: '100%', resize: 'vertical', borderRadius: 10, padding: '7px 9px', fontFamily: J, fontSize: 11, color: dark ? '#fff' : '#001A4A', background: inFieldBg, border: `1px solid ${inFieldBord}`, outline: 'none', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditId(null)} style={{ fontFamily: J, fontSize: 9, color: subCol, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
                    <button onClick={saveEdit} style={{ fontFamily: J, fontSize: 9, fontWeight: 600, color: senderGold, background: 'none', border: 'none', cursor: 'pointer' }}>Save</button>
                  </div>
                </div>
              ) : (hasAudioAtt && !(mm.content || '').trim()) ? (
                /* Audio-only voice note: skip the empty text bubble (the player renders below). */
                <div style={{ maxWidth: '78%' }} />
              ) : (
                <div onClick={() => setActionFor(actionFor === mm.id ? null : mm.id)} style={{ maxWidth: '78%', padding: '7px 10px', fontFamily: J, fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'pointer', borderRadius: mine ? '12px 12px 3px 12px' : '12px 12px 12px 3px', background: mine ? mineBg : theirBg, color: mine ? '#fff' : theirCol, border: mine ? 'none' : theirBord, opacity: mm._pending ? 0.6 : 1 }}>
                  {hasAudioAtt && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, fontFamily: J, fontSize: 8, letterSpacing: '0.04em', fontWeight: 600, textTransform: 'uppercase', opacity: 0.6 }}>
                      <i className="ti ti-sparkles" style={{ fontSize: 10 }} />AI transcript
                    </div>
                  )}
                  {renderMessageContent(mm.content, ctxFor(mine))}
                  {mm.edited_at && <span style={{ fontSize: 8, opacity: 0.6, marginLeft: 5 }}>(edited)</span>}
                </div>
              )}
              {/* hover react trigger — opens the existing action bar */}
              {canReact && (
                <button type="button" aria-label="React" onClick={(e) => { e.stopPropagation(); setActionFor(actionFor === mm.id ? null : mm.id); }} style={{ width: 22, height: 22, flexShrink: 0, borderRadius: '50%', border: `1px solid ${reactBord}`, background: dark ? '#0A1730' : '#fff', color: trigCol, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, opacity: triggerOpacity, transition: 'opacity 140ms ease' }}><i className="ti ti-mood-plus" style={{ fontSize: 13 }} /></button>
              )}
            </div>
            {/* attachments (images render inline; other files as a chip) — works in threads too */}
            {(mm.attachments || []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, marginLeft: mine ? 0 : 28, marginRight: mine ? 4 : 0, justifyContent: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', alignSelf: mine ? 'flex-end' : 'flex-start' }}>
                {(mm.attachments || []).map(att => isAudioMime(att.mime_type)
                  ? <AttachmentAudio key={att.id || att.storage_path} att={att} dark={dark} />
                  : isImageMime(att.mime_type)
                  ? <AttachmentImage key={att.id || att.storage_path} att={att} dark={dark} />
                  : (
                    <button key={att.id || att.storage_path} type="button" onClick={async () => { const u = att.previewUrl || await ChatDB.signedUrl(att.storage_path); if (u) window.open(u, '_blank', 'noopener,noreferrer'); }}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: 240, padding: '8px 10px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', background: dark ? '#0A1730' : '#fff', border: `1px solid ${reactBord}`, color: dark ? '#fff' : '#001A4A' }}>
                      <i className="ti ti-file" style={{ fontSize: 18, color: senderGold, flexShrink: 0 }} />
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontFamily: J, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{att.file_name || 'File'}</span>
                        <span style={{ fontFamily: J, fontSize: 8, color: subCol }}>{humanFileSize(att.file_size)}</span>
                      </span>
                    </button>
                  ))}
              </div>
            )}
            {/* reactions strip */}
            {Object.keys(rg).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginLeft: mine ? 0 : 28, marginRight: mine ? 4 : 0, justifyContent: mine ? 'flex-end' : 'flex-start', marginTop: 2 }}>
                {Object.keys(rg).map(em => (
                  <button key={em} onClick={() => toggleReaction(mm, em)} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 10, fontFamily: J, fontSize: 10, cursor: 'pointer', background: rg[em].mine ? reactBg : 'transparent', border: `1px solid ${rg[em].mine ? reactMineBd : reactBord}`, color: dark ? '#fff' : '#001A4A' }}>{em} <span style={{ fontSize: 8 }}>{rg[em].count}</span></button>
                ))}
              </div>
            )}
            {/* reply count */}
            {!inThread && mm.reply_count > 0 && (
              <button onClick={() => openThread(mm)} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', marginLeft: mine ? 0 : 28, marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', fontFamily: J, fontSize: 9, fontWeight: 600, color: senderGold }}><i className="ti ti-message-circle" style={{ fontSize: 12 }} />{mm.reply_count} {mm.reply_count === 1 ? 'reply' : 'replies'}</button>
            )}
            {/* action bar */}
            {actionFor === mm.id && !editing && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', alignSelf: mine ? 'flex-end' : 'flex-start', marginLeft: mine ? 0 : 28, marginTop: 4, padding: '3px 5px', borderRadius: 12, background: dark ? '#0A1730' : '#fff', border: `1px solid ${reactBord}`, boxShadow: '0 3px 10px rgba(0,0,0,0.12)' }}>
                {CHAT_EMOJIS.map(em => <button key={em} onClick={() => toggleReaction(mm, em)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '2px 3px', lineHeight: 1 }}>{em}</button>)}
                {!inThread && <button onClick={() => openThread(mm)} aria-label="Reply in thread" style={{ background: 'none', border: 'none', cursor: 'pointer', color: subCol, padding: '2px 4px', display: 'flex' }}><i className="ti ti-message-circle" style={{ fontSize: 15 }} /></button>}
                {mine && <button onClick={() => startEdit(mm)} aria-label="Edit" style={{ background: 'none', border: 'none', cursor: 'pointer', color: subCol, padding: '2px 4px', display: 'flex' }}><i className="ti ti-pencil" style={{ fontSize: 15 }} /></button>}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontFamily: J, fontSize: 7, color: mm._failed ? '#C0392B' : timeCol, justifyContent: mine ? 'flex-end' : 'flex-start', marginLeft: mine ? 0 : 28, marginRight: mine ? 4 : 0 }}>
              <span>{mm._failed ? 'Failed to send' : (mm._pending ? 'Sending…' : fmtTime(mm.created_at))}</span>
              {mine && !mm._failed && (() => {
                const rcpt = receiptFor(mm);
                if (rcpt === 'sent') return <i className="ti ti-check" style={{ fontSize: 10, color: timeCol }} aria-label="Sent" />;
                if (rcpt === 'seen') return <i className="ti ti-checks" style={{ fontSize: 10, color: dark ? '#2FBF6B' : '#1E6B40' }} aria-label="Seen" />;
                return <i className="ti ti-checks" style={{ fontSize: 10, color: timeCol }} aria-label="Delivered" />;
              })()}
            </div>
          </div>
        );
      };

      // Inline thread dock — rendered nested under its parent row in the main list (replaces the old slide-in overlay).
      const renderThreadDock = () => (
        <div style={{ marginLeft: 28, marginTop: 4, marginBottom: 2, background: dark ? 'rgba(173,131,47,0.05)' : 'rgba(173,131,47,0.04)', border: `1px solid ${reactBord}`, borderLeft: `2px solid ${reactMineBd}`, borderRadius: 10, padding: '6px 8px 6px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <button onClick={() => setThread(null)} aria-label="Collapse thread" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: subCol, display: 'flex', alignItems: 'center' }}><i className="ti ti-chevron-down" style={{ fontSize: 14 }} /></button>
            <span style={{ fontFamily: J, fontSize: 8, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600, color: senderGold }}>{threadMsgs.length} {threadMsgs.length === 1 ? 'reply' : 'replies'}</span>
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', WebkitOverflowScrolling: 'touch', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {threadMsgs.length === 0 && <div style={{ fontFamily: J, fontSize: 10, color: subCol, padding: '2px 0' }}>No replies yet — start the thread below.</div>}
            {threadMsgs.map((tm, i) => renderRow(tm, i, threadMsgs, true))}
          </div>
        </div>
      );

      const composer = (val, onChange, onSend, busy, kRef, placeholder, autoMenu, pickerKey) => {
        const iconCol = dark ? 'rgba(255,255,255,0.55)' : '#8A8676';
        const pendingReady = pending.some(p => p.status === 'ready'); // allow sending attachment-only messages
        const fmtBtn = (icon, before, after, ph) => (
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection(kRef, val, kRef === composerRef ? setText : setThreadText, before, after, ph)} aria-label={icon} style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: iconCol, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className={`ti ${icon}`} style={{ fontSize: 14 }} /></button>
        );
        const setterFor = (kRef === composerRef ? setText : setThreadText);
        return (
        <div style={{ flexShrink: 0, borderTop: `1px solid ${inBarBord}`, background: inBarBg, padding: '6px 12px calc(10px + env(safe-area-inset-bottom))', position: 'relative' }}>
          {autoMenu && menu && menu.items.length > 0 && (
            <div style={{ position: 'absolute', left: 12, right: 12, bottom: 'calc(100% - 2px)', background: dark ? '#0A1730' : '#fff', border: `1px solid ${reactBord}`, borderRadius: 12, boxShadow: '0 -4px 16px rgba(0,0,0,0.16)', overflow: 'hidden', maxHeight: 200, overflowY: 'auto', zIndex: 5 }}>
              {menu.items.map((it, k) => (
                <button key={k} onClick={() => pickMention(it)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', borderBottom: k < menu.items.length - 1 ? `1px solid ${dark ? '#152545' : '#F0EBE3'}` : 'none', cursor: 'pointer', textAlign: 'left' }}>
                  {it.photo !== undefined ? <Avatar photo={it.photo} name={it.label} size={22} /> : <i className="ti ti-at" style={{ fontSize: 16, color: senderGold }} />}
                  <span style={{ fontFamily: J, fontSize: 11, fontWeight: 600, color: dark ? '#fff' : '#001A4A' }}>{it.label}</span>
                  {it.sub && <span style={{ fontFamily: J, fontSize: 9, color: subCol, marginLeft: 'auto' }}>{it.sub}</span>}
                </button>
              ))}
            </div>
          )}
          {emojiPicker === pickerKey && (
            <div style={{ position: 'absolute', left: 12, right: 12, bottom: 'calc(100% - 2px)', background: dark ? '#0A1730' : '#fff', border: `1px solid ${reactBord}`, borderRadius: 12, boxShadow: '0 -4px 16px rgba(0,0,0,0.16)', padding: 8, zIndex: 5, display: 'flex', flexWrap: 'wrap', gap: 2, maxHeight: 168, overflowY: 'auto' }}>
              {COMPOSER_EMOJIS.map((em, k) => (
                <button key={k} type="button" onMouseDown={e => e.preventDefault()} onClick={() => insertEmoji(em, kRef, setterFor, val)} aria-label={'Insert ' + em} style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{em}</button>
              ))}
            </div>
          )}
          {/* Formatting toolbar (bold / italic / code / link) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 4 }}>
            {fmtBtn('ti-bold', '**', '**', 'bold')}
            {fmtBtn('ti-italic', '_', '_', 'italic')}
            {fmtBtn('ti-code', '`', '`', 'code')}
            <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection(kRef, val, setterFor, '[', '](url)', 'text')} aria-label="ti-link" style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: iconCol, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-link" style={{ fontSize: 14 }} /></button>
          </div>
          {/* Attachment preview strip (image thumbs / file chips, each removable) */}
          {pending.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {pending.map(p => {
                const img = isImageMime(p.file && p.file.type);
                const uploading = p.status === 'uploading', errored = p.status === 'error';
                return (
                  <div key={p.id} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, padding: img ? 0 : '6px 8px', paddingRight: img ? 0 : 22, borderRadius: 9, background: img ? 'transparent' : (dark ? '#0A1730' : '#fff'), border: `1px solid ${errored ? '#C0392B' : reactBord}`, maxWidth: 200, opacity: uploading ? 0.7 : 1 }}>
                    {img
                      ? <div style={{ position: 'relative', width: 52, height: 52, borderRadius: 9, overflow: 'hidden', border: `1px solid ${reactBord}` }}>
                          {p.previewUrl ? <img src={p.previewUrl} alt={p.file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', background: dark ? '#0A1730' : '#F3EBDA' }} />}
                          {uploading && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,13,38,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13 }}><i className="ti ti-loader-2" style={{ animation: 'tmg-spin 0.8s linear infinite' }} /></div>}
                        </div>
                      : <React.Fragment>
                          <i className={`ti ${errored ? 'ti-alert-triangle' : (uploading ? 'ti-loader-2' : 'ti-file')}`} style={{ fontSize: 16, color: errored ? '#C0392B' : senderGold, flexShrink: 0, animation: uploading ? 'tmg-spin 0.8s linear infinite' : 'none' }} />
                          <span style={{ fontFamily: J, fontSize: 9.5, fontWeight: 600, color: dark ? '#fff' : '#001A4A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.file ? p.file.name : 'File'}</span>
                        </React.Fragment>}
                    <button type="button" onClick={() => removePending(p.id)} aria-label="Remove attachment" style={{ position: 'absolute', top: img ? -6 : '50%', right: -6, transform: img ? 'none' : 'translateY(-50%)', width: 17, height: 17, borderRadius: '50%', border: 'none', cursor: 'pointer', background: dark ? '#1A2A45' : '#001A4A', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }}><i className="ti ti-x" style={{ fontSize: 11 }} /></button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Soft mic-permission / recording error (never throws) */}
          {recError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, padding: '6px 9px', borderRadius: 9, background: dark ? 'rgba(192,57,43,0.14)' : '#FBEAE7', border: `1px solid ${dark ? 'rgba(192,57,43,0.4)' : '#E8C4BE'}`, color: dark ? '#F0A99F' : '#A2342A', fontFamily: J, fontSize: 9.5 }}>
              <i className="ti ti-microphone-off" style={{ fontSize: 13, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{recError}</span>
              <button type="button" onClick={() => setRecError('')} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, display: 'flex' }}><i className="ti ti-x" style={{ fontSize: 12 }} /></button>
            </div>
          )}
          {rec ? (
            /* Recording / processing bar — replaces the input row while a voice note is being captured. */
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, padding: '4px 6px 4px 12px', borderRadius: 17, background: inFieldBg, border: `1px solid ${inFieldBord}` }}>
              {rec === 'processing' ? (
                <React.Fragment>
                  <i className="ti ti-loader-2" style={{ fontSize: 16, color: senderGold, animation: 'tmg-spin 0.8s linear infinite' }} />
                  <span style={{ flex: 1, fontFamily: J, fontSize: 11, fontWeight: 500, color: subCol }}>Transcribing…</span>
                </React.Fragment>
              ) : (
                <React.Fragment>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#C0392B', flexShrink: 0, animation: 'tmg-pulse-ring 1.4s ease infinite' }} />
                  <span style={{ flex: 1, fontFamily: J, fontSize: 12, fontWeight: 600, color: dark ? '#fff' : '#001A4A', fontVariantNumeric: 'tabular-nums' }}>{fmtRecTime(recSecs)}</span>
                  <button type="button" onClick={cancelRecording} aria-label="Cancel recording" title="Cancel" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, background: 'transparent', color: dark ? 'rgba(255,255,255,0.55)' : '#8A8676', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-trash" style={{ fontSize: 17 }} /></button>
                  <button type="button" onClick={stopAndSend} aria-label="Stop and send" title="Send voice message" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, background: sendBg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-check" style={{ fontSize: 16 }} /></button>
                </React.Fragment>
              )}
            </div>
          ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 7 }}>
            {autoMenu && (
              <button type="button" disabled aria-label="Screen recording (coming soon)" title="Screen recording — coming soon" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', flexShrink: 0, cursor: 'not-allowed', color: dark ? 'rgba(255,255,255,0.30)' : '#B4B2A9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-device-desktop" style={{ fontSize: 16 }} /></button>
            )}
            <button type="button" onClick={openFilePicker} aria-label="Attach file" title="Attach a file or image" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', flexShrink: 0, cursor: 'pointer', color: iconCol, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-paperclip" style={{ fontSize: 17 }} /></button>
            <textarea ref={kRef} value={val} onChange={onChange} onKeyDown={onKey(onSend)} rows={1} placeholder={placeholder} aria-label={placeholder} style={{ flex: 1, resize: 'none', maxHeight: 96, minHeight: 34, borderRadius: 17, padding: '8px 12px', fontFamily: J, fontSize: 11, lineHeight: 1.4, color: dark ? '#fff' : '#001A4A', background: inFieldBg, border: `1px solid ${inFieldBord}`, outline: 'none', boxSizing: 'border-box' }} />
            <button type="button" onClick={() => { setMenu(null); setEmojiPicker(p => p === pickerKey ? null : pickerKey); }} aria-label="Emoji" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', flexShrink: 0, cursor: 'pointer', color: emojiPicker === pickerKey ? senderGold : iconCol, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-mood-smile" style={{ fontSize: 18 }} /></button>
            {(() => { const canSend = (val.trim().length > 0 || pendingReady) && !busy;
              // WhatsApp-style: mic when there's nothing to send, Send button otherwise.
              if (!canSend && canRecord) return (
                <button type="button" onClick={startRecording} aria-label="Record voice message" title="Record a voice message" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', flexShrink: 0, background: sendBg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-microphone" style={{ fontSize: 17 }} /></button>
              );
              return (
            <button onClick={onSend} disabled={!canSend} aria-label="Send" style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: canSend ? 'pointer' : 'default', flexShrink: 0, background: canSend ? sendBg : (dark ? '#1A2A45' : '#C9CDD6'), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-arrow-up" style={{ fontSize: 15 }} /></button>
            ); })()}
          </div>
          )}
        </div>
        );
      };

      return (
        <React.Fragment>
          {/* Hidden file input shared by the (single mounted) composer's attach button */}
          <input ref={fileRef} type="file" multiple onChange={onPickFiles} style={{ display: 'none' }} aria-hidden="true"
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip" />
          {(() => {
            const iconCircleBg = dark ? '#0A1730' : '#F5F2EE', iconCircleCol = dark ? '#C9A45A' : '#AD832F';
            const awayCol = dark ? '#E0A93B' : '#B07A00';
            const ps = peerId ? (statusOf ? statusOf(peerId) : null) : null;
            const hasStatus = ps && (ps.status_emoji || ps.status_text);
            let subLine = null, subTint = subCol;
            if (peerId) {
              if (hasStatus) subLine = `${ps.status_emoji || ''} ${ps.status_text || ''}`.trim();
              else { const away = awayOf(peerId); subLine = away ? 'Away' : 'Active'; if (away) subTint = awayCol; }
            } else if (scope.kind === 'channel') {
              subLine = scope.topic || null;
            } else if (scope.conv && scope.conv.type === 'group_dm') {
              subLine = (scope.conv.memberIds.length) + ' members';
            }
            return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderBottom: `1px solid ${barBord}`, background: barBg, flexShrink: 0 }}>
            {showBack && <button onClick={onBack} aria-label="Back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: backCol, display: 'flex', flexShrink: 0 }}><i className="ti ti-chevron-left" style={{ fontSize: 18 }} /></button>}
            {peerId
              ? <div style={{ position: 'relative', flexShrink: 0 }}><Avatar photo={photoOf(peerId)} name={nameOf(peerId)} size={28} /><span style={{ position: 'absolute', bottom: 0, right: 0, width: 9, height: 9, borderRadius: '50%', background: awayOf(peerId) ? '#E0A93B' : '#2FBF6B', border: `2px solid ${barBg}` }} /></div>
              : <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: iconCircleBg, color: iconCircleCol }}><i className={`ti ${scope.kind === 'channel' ? (scope.channel && scope.channel.type === 'private' ? 'ti-lock' : 'ti-hash') : 'ti-users'}`} style={{ fontSize: 14 }} /></div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: J, fontSize: 12, fontWeight: 600, color: titleCol, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{scope.title}</div>
              {subLine ? <div style={{ fontFamily: J, fontSize: 8, color: subTint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subLine}</div> : null}
            </div>
            <button aria-label="Tasks" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: backCol, display: 'flex', flexShrink: 0 }}><i className="ti ti-checklist" style={{ fontSize: 18 }} /></button>
          </div>
            );
          })()}
          <div ref={listRef} onClick={() => { if (actionFor) setActionFor(null); }} style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '12px 12px', display: 'flex', flexDirection: 'column', gap: 8, background: msgBg }}>
            {loading && <div style={{ fontFamily: J, fontSize: 10, color: subCol, textAlign: 'center', padding: 16 }}>Loading…</div>}
            {!loading && messages.length === 0 && <div style={{ fontFamily: J, fontSize: 11, color: subCol, textAlign: 'center', padding: 24 }}>No messages yet. Say hello 👋</div>}
            {messages.map((mm, i) => (
              <React.Fragment key={mm.id}>
                {renderRow(mm, i, messages, false)}
                {thread && thread.id === mm.id && renderThreadDock()}
              </React.Fragment>
            ))}
          </div>
          {/* Single context-aware composer: thread mode when a thread is open, otherwise the normal main composer. */}
          {thread && (
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: dark ? 'rgba(173,131,47,0.08)' : '#F3EBDA', borderTop: `1px solid ${inBarBord}` }}>
              <i className="ti ti-message-circle" style={{ fontSize: 13, color: senderGold }} />
              <span style={{ flex: 1, fontFamily: J, fontSize: 9, fontWeight: 600, color: senderGold }}>Replying in thread</span>
              <button onClick={() => { setThread(null); setTimeout(() => composerRef.current && composerRef.current.focus(), 30); }} aria-label="Exit thread" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: subCol, display: 'flex', alignItems: 'center' }}><i className="ti ti-x" style={{ fontSize: 14 }} /></button>
            </div>
          )}
          {thread
            ? composer(threadText, onThreadComposerChange, sendThread, tSending, threadComposerRef, 'Reply in thread…', true, 'thread')
            : composer(text, onComposerChange, send, sending, composerRef, 'Message ' + scope.title, true, 'main')}
        </React.Fragment>
      );
    }

    function ChatTab({ dark, profile, chatUnread, onRead }) {
      const J = "'Jost', sans-serif";
      const bg = dark ? '#000D26' : '#FCFBF8', headTitle = dark ? '#FFFFFF' : '#001A4A';
      const composeBg = dark ? 'rgba(173,131,47,0.15)' : '#F3EBDA', composeCol = dark ? '#C9A45A' : '#AD832F';
      const searchBg = dark ? '#0A1730' : '#F5F2EE', searchCol = dark ? 'rgba(255,255,255,0.4)' : '#8A8676';
      const rowBord = dark ? '#0D1E3A' : '#F5F2EE', sectionCol = dark ? '#C9A45A' : '#AD832F';
      const nameCol = dark ? '#FFFFFF' : '#001A4A', previewCol = dark ? 'rgba(255,255,255,0.35)' : '#888888';
      const me = (window.SupabaseAuth?._state?.session?.user?.id) || 'dev-user-id';
      const isAdmin = hasAdmin(profile && profile.access);
      const byScope = (chatUnread && chatUnread.byScope) || {};
      const wide = useIsWide();

      const [roster, setRoster] = useState([]); const [channels, setChannels] = useState([]); const [convs, setConvs] = useState([]);
      const [loadingList, setLoadingList] = useState(true);
      const [scope, setScope] = useState(null); const [modal, setModal] = useState(null); const [menu, setMenu] = useState(false); const [q, setQ] = useState('');

      const rosterById = {}; roster.forEach(p => { rosterById[p.id] = p; });
      const nameOf = (id) => { const p = rosterById[id]; return p ? (((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || 'Member') : 'Member'; };
      const photoOf = (id) => { const p = rosterById[id]; return (p && p.avatar_url) || ''; };
      const awayOf = (id) => { const p = rosterById[id]; return !!(p && p.away); };
      const statusOf = (id) => { const p = rosterById[id]; return p ? { status_text: p.status_text || '', status_emoji: p.status_emoji || '' } : { status_text: '', status_emoji: '' }; };
      const convTitle = (cv) => cv.title || (cv.memberIds.filter(id => id !== me).map(nameOf).join(', ')) || 'Direct Message';

      const refresh = () => { setLoadingList(true); Promise.all([ChatDB.loadRoster(), ChatDB.listChannels(), ChatDB.listConversations()]).then(([r, ch, cv]) => { setRoster(r || []); setChannels(ch || []); setConvs(cv || []); setLoadingList(false); }); };
      useEffect(() => { refresh(); }, []);

      const openChannel = async (ch) => { if (ch.type === 'public') { try { await ChatDB.joinChannel(ch.id); } catch (e) {} } setScope({ kind: 'channel', id: ch.id, title: '#' + ch.name, topic: ch.topic, channel: ch }); };
      const openConv = (cv) => setScope({ kind: 'conversation', id: cv.id, title: convTitle(cv), conv: cv });

      const ql = q.trim().toLowerCase();
      const fch = channels.filter(c => !ql || c.name.toLowerCase().includes(ql) || (c.topic || '').toLowerCase().includes(ql));
      const publicCh = fch.filter(c => c.type === 'public'), privateCh = fch.filter(c => c.type === 'private');
      const fcv = convs.filter(c => !ql || convTitle(c).toLowerCase().includes(ql));
      const nothing = !loadingList && !publicCh.length && !privateCh.length && !fcv.length;

      const UnreadDot = ({ id }) => { const u = byScope[id]; if (!u || !u.unread) return null; return <div style={{ minWidth: 16, height: 16, borderRadius: 8, background: '#AD832F', color: '#fff', fontFamily: J, fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', boxShadow: u.mentions ? '0 0 0 1.5px ' + bg + ', 0 0 0 3px #AD832F' : 'none' }}>{u.unread > 9 ? '9+' : u.unread}</div>; };
      const Section = ({ label }) => <div style={{ fontFamily: J, fontSize: 8, letterSpacing: '0.18em', fontWeight: 600, color: sectionCol, padding: '12px 14px 5px' }}>{label}</div>;
      const selBg = dark ? 'rgba(173,131,47,0.12)' : '#F3EBDA';
      const isSel = (id) => wide && scope && scope.id === id;
      const ChannelRow = (c) => (
        <div key={c.id} onClick={() => openChannel(c)} role="button" tabIndex={0} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer', borderBottom: `1px solid ${rowBord}`, background: isSel(c.id) ? selBg : 'transparent' }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dark ? '#0A1730' : '#F5F2EE', color: composeCol }}><i className={`ti ${c.type === 'private' ? 'ti-lock' : 'ti-hash'}`} style={{ fontSize: 16 }} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: J, fontSize: 11, fontWeight: 600, color: nameCol, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
            {c.topic ? <div style={{ fontFamily: J, fontSize: 9, color: previewCol, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{c.topic}</div> : null}
          </div>
          <UnreadDot id={c.id} />
        </div>
      );
      const ConvRow = (cv) => {
        const others = cv.memberIds.filter(id => id !== me); const single = others.length <= 1;
        return (
          <div key={cv.id} onClick={() => openConv(cv)} role="button" tabIndex={0} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer', borderBottom: `1px solid ${rowBord}`, background: isSel(cv.id) ? selBg : 'transparent' }}>
            {single
              ? <div style={{ position: 'relative', flexShrink: 0 }}><Avatar photo={photoOf(others[0])} name={nameOf(others[0])} size={34} />{!awayOf(others[0]) && <span style={{ position: 'absolute', bottom: 0, right: 0, width: 9, height: 9, borderRadius: '50%', background: '#2FBF6B', border: `2px solid ${bg}` }} />}</div>
              : <div style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dark ? '#0A1730' : '#F5F2EE', color: composeCol }}><i className="ti ti-users" style={{ fontSize: 16 }} /></div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: J, fontSize: 11, fontWeight: 600, color: nameCol, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{convTitle(cv)}</div>
              <div style={{ fontFamily: J, fontSize: 9, color: previewCol, marginTop: 1 }}>{cv.type === 'group_dm' ? (cv.memberIds.length + ' members') : 'Direct message'}</div>
            </div>
            <UnreadDot id={cv.id} />
          </div>
        );
      };

      const placeholderCol = dark ? 'rgba(255,255,255,0.3)' : '#B4B2A9';
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: wide ? 'flex' : 'block', flexDirection: wide ? 'row' : undefined }}>
            <div style={wide
              ? { position: 'relative', width: 340, flexShrink: 0, height: '100%', borderRight: `1px solid ${rowBord}`, display: 'flex', flexDirection: 'column', background: bg }
              : { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: bg }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px 8px', flexShrink: 0, position: 'relative' }}>
                <div style={{ fontFamily: J, fontSize: 14, fontWeight: 600, color: headTitle }}>Chat</div>
                <button onClick={() => setMenu(m => !m)} aria-label="New conversation" style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer', background: composeBg, color: composeCol, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="ti ti-edit" style={{ fontSize: 15 }} /></button>
                {menu && (
                  <React.Fragment>
                    <div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                    <div style={{ position: 'absolute', top: 40, right: 14, zIndex: 40, background: dark ? '#0A1730' : '#fff', border: `1px solid ${dark ? '#152545' : '#E4DFD4'}`, borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', overflow: 'hidden', minWidth: 168 }}>
                      <button onClick={() => { setMenu(false); setModal('newdm'); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '11px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: J, fontSize: 12, color: dark ? '#fff' : '#001A4A', textAlign: 'left' }}><i className="ti ti-message-plus" style={{ fontSize: 16, color: composeCol }} />New message</button>
                      <button onClick={() => { setMenu(false); setModal('newchannel'); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '11px 14px', background: 'none', border: 'none', borderTop: `1px solid ${dark ? '#152545' : '#F0EBE3'}`, cursor: 'pointer', fontFamily: J, fontSize: 12, color: dark ? '#fff' : '#001A4A', textAlign: 'left' }}><i className="ti ti-plus" style={{ fontSize: 16, color: composeCol }} />New channel</button>
                    </div>
                  </React.Fragment>
                )}
              </div>
              <div style={{ margin: '0 14px 6px', background: searchBg, borderRadius: 10, padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                <i className="ti ti-search" style={{ fontSize: 14, color: searchCol }} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search channels & people" aria-label="Search" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: J, fontSize: 10, color: dark ? '#fff' : '#001A4A' }} />
              </div>
              <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
                {loadingList && <div style={{ fontFamily: J, fontSize: 10, color: searchCol, textAlign: 'center', padding: 24 }}>Loading…</div>}
                {nothing && <div style={{ fontFamily: J, fontSize: 11, color: previewCol, textAlign: 'center', padding: '32px 24px', lineHeight: 1.6 }}>No conversations yet.<br />Tap <i className="ti ti-edit" style={{ fontSize: 12 }} /> to start a message or create a channel.</div>}
                {(publicCh.length > 0) && <Section label="CHANNELS" />}
                {publicCh.map(ChannelRow)}
                {(privateCh.length > 0) && <Section label="PRIVATE CHANNELS" />}
                {privateCh.map(ChannelRow)}
                {(fcv.length > 0) && <Section label="DIRECT MESSAGES" />}
                {fcv.map(ConvRow)}
                <div style={{ height: 12 }} />
              </div>
            </div>

            <div style={wide
              ? { position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', background: dark ? '#070F1E' : '#FCFBF8', transform: 'none', transition: 'none', boxShadow: 'none', overflow: 'hidden' }
              : { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: dark ? '#070F1E' : '#FCFBF8', transform: scope ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 220ms ease', boxShadow: scope && !dark ? '-10px 0 28px rgba(0,0,0,0.12)' : 'none', pointerEvents: scope ? 'auto' : 'none', overflow: 'hidden' }}>
              {scope
                ? <ChatConversation key={scope.id} dark={dark} scope={scope} me={me} roster={roster} channels={channels} rosterById={rosterById} nameOf={nameOf} photoOf={photoOf} awayOf={awayOf} statusOf={statusOf} showBack={!wide} onBack={() => { setScope(null); onRead && onRead(); }} onRead={onRead} />
                : (wide ? <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: placeholderCol }}><i className="ti ti-messages" style={{ fontSize: 40 }} /><div style={{ fontFamily: J, fontSize: 12, fontWeight: 500 }}>Select a conversation</div></div> : null)}
            </div>
          </div>

          {modal === 'newchannel' && <NewChannelModal dark={dark} isAdmin={isAdmin} onClose={() => setModal(null)} onCreated={(ch) => { setModal(null); refresh(); openChannel(ch); }} />}
          {modal === 'newdm' && <NewDMModal dark={dark} roster={roster} me={me} onClose={() => setModal(null)} onCreated={(cv) => { setModal(null); refresh(); openConv(cv); }} />}
        </div>
      );
    }

    // ─── Mount + auth gate (mirrors crm.html) ─────────────────────────
    (function mount() {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      const dark = document.body.classList.contains('dark');
      const AUTHORIZED_DOMAIN = 'themorshedgroup.com';
      function _showScreen(id) {
        ['login-screen', 'denied-screen', 'pending-screen'].forEach(function (s) { var el = document.getElementById(s); if (el) el.hidden = (s !== id); });
        document.getElementById('auth-overlay').style.display = 'block';
      }
      function showSignin()   { _showScreen('login-screen'); }
      function showRejected() { _showScreen('denied-screen'); }
      function showPending()  { _showScreen('pending-screen'); }
      function hideOverlay()  { document.getElementById('auth-overlay').style.display = 'none'; }

      if (window.TMG_DEV) {
        const devProfile = { email: 'symon@morshedgroup.com', first_name: 'Symon', access: ['admin'], status: 'active' };
        root.render(<div style={{height:'100%'}}><ChatTab dark={dark} profile={devProfile} chatUnread={0} onRead={()=>{}} /></div>);
        hideOverlay();
        return;
      }

      window.SupabaseAuth.onAuthStateChange(async function({ session }) {
        if (!session) { showSignin(); return; }
        const email = (session.user.email || '').toLowerCase();
        if (!email.endsWith('@' + AUTHORIZED_DOMAIN)) { showRejected(); return; }
        const profile = await ProfileDB.ensureProfile(session.user);
        // Same gate semantics as index.html: existing-but-not-active is blocked; missing profile fails open.
        if (profile && profile.status === 'pending') { showPending(); return; }
        if (profile && profile.status && profile.status !== 'active') { showRejected(); return; }
        root.render(<div style={{height:'100%'}}><ChatTab dark={dark} profile={profile} chatUnread={0} onRead={()=>{}} /></div>);
        hideOverlay();
      });
    })();
  
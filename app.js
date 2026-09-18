/* =========================================================
   STORAGE HELPERS
   Three possible backends, checked in this priority order:

   1. "server"  — this device has been pointed at your own backend
      (see server/ folder + the Server Connection screen). Data is
      shared across every device connected to that same server,
      completely independently of Claude.ai.
   2. "shared"  — window.storage (shared=true) exists, meaning this
      is running inside a Claude.ai artifact. Shared across everyone
      viewing that artifact, but only while it's opened through Claude.
   3. "local-fallback" — neither of the above is available, so data
      is saved to this browser's localStorage only (single device).

   Whichever is active, the rest of the app just calls sGet/sSet/
   sDel/sList and doesn't need to know which backend is behind them.
========================================================= */
const HAS_CLAUDE_STORAGE = (typeof window !== 'undefined' && !!window.storage && typeof window.storage.get === 'function');
const LS_PREFIX = 'audit-app-storage::';
const SERVER_CONFIG_KEY = 'audit-app-server-config';

let SERVER_CONFIG = null;
function loadServerConfig(){
  try{
    const raw = localStorage.getItem(SERVER_CONFIG_KEY);
    SERVER_CONFIG = raw ? JSON.parse(raw) : null;
  }catch(e){ SERVER_CONFIG = null; }
  return SERVER_CONFIG;
}
function saveServerConfig(cfg){
  SERVER_CONFIG = cfg;
  try{ localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(cfg)); }catch(e){}
}
function clearServerConfig(){
  SERVER_CONFIG = null;
  try{ localStorage.removeItem(SERVER_CONFIG_KEY); }catch(e){}
}
function hasServerConfig(){ return !!(SERVER_CONFIG && SERVER_CONFIG.apiBase && SERVER_CONFIG.apiKey); }
loadServerConfig();

function currentStorageMode(){
  if(hasServerConfig()) return 'server';
  if(HAS_CLAUDE_STORAGE) return 'shared';
  return 'local-fallback';
}
function currentStorageModeLabel(){
  const m = currentStorageMode();
  if(m==='server') return 'Your own server — fully independent of Claude';
  if(m==='shared') return 'Shared via Claude.ai';
  return 'Local-only (this device only)';
}

async function serverFetch(path, opts){
  const base = SERVER_CONFIG.apiBase.replace(/\/+$/,'');
  const headers = Object.assign({'X-API-Key': SERVER_CONFIG.apiKey}, (opts&&opts.headers)||{});
  return fetch(base+path, Object.assign({}, opts, {headers}));
}

async function sGet(key){
  if(hasServerConfig()){
    try{
      const res = await serverFetch('/api/kv/'+encodeURIComponent(key));
      if(res.status===404) return null;
      if(!res.ok) return null;
      const data = await res.json();
      return data.value ? JSON.parse(data.value) : null;
    }catch(e){ console.error('server get failed', key, e); return null; }
  }
  if(HAS_CLAUDE_STORAGE){
    try{ const r = await window.storage.get(key, true); return r ? JSON.parse(r.value) : null; }
    catch(e){ return null; }
  }
  try{ const raw = localStorage.getItem(LS_PREFIX+key); return raw===null ? null : JSON.parse(raw); }
  catch(e){ return null; }
}
async function sSet(key, value){
  if(hasServerConfig()){
    try{
      const res = await serverFetch('/api/kv/'+encodeURIComponent(key), {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({value: JSON.stringify(value)})
      });
      return res.ok;
    }catch(e){ console.error('server set failed', key, e); return false; }
  }
  if(HAS_CLAUDE_STORAGE){
    try{ await window.storage.set(key, JSON.stringify(value), true); return true; }
    catch(e){ console.error('storage set failed', key, e); return false; }
  }
  try{ localStorage.setItem(LS_PREFIX+key, JSON.stringify(value)); return true; }
  catch(e){ console.error('local storage set failed', key, e); return false; }
}
async function sDel(key){
  if(hasServerConfig()){
    try{ await serverFetch('/api/kv/'+encodeURIComponent(key), {method:'DELETE'}); }catch(e){}
    return;
  }
  if(HAS_CLAUDE_STORAGE){ try{ await window.storage.delete(key, true); }catch(e){} return; }
  try{ localStorage.removeItem(LS_PREFIX+key); }catch(e){}
}
async function sList(prefix){
  if(hasServerConfig()){
    try{
      const res = await serverFetch('/api/kv?prefix='+encodeURIComponent(prefix||''));
      if(!res.ok) return [];
      const data = await res.json();
      return data.keys || [];
    }catch(e){ console.error('server list failed', e); return []; }
  }
  if(HAS_CLAUDE_STORAGE){
    try{ const r = await window.storage.list(prefix, true); return r ? r.keys : []; }
    catch(e){ return []; }
  }
  try{
    const keys = [];
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(k && k.indexOf(LS_PREFIX)===0){
        const bare = k.slice(LS_PREFIX.length);
        if(!prefix || bare.indexOf(prefix)===0) keys.push(bare);
      }
    }
    return keys;
  }catch(e){ return []; }
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* =========================================================
   DEFAULT OPTION SETS (mirrors the "Select" dropdowns used
   throughout the source workbook's Dropdowns sheet)
========================================================= */
const OPTION_SETS = {
  compliance: ['Compliant','Not Compliant','N/a','Unable to verify'],
  yesno: ['Yes','No','N/a','Unable to verify'],
  rating: ['Excellent','Good','Average','Unsatisfactory'],
  document: ['Compliant','N/a','Not Compliant','Not Uploaded','Document Expired!','In Process','Unable to verify']
};
const BAD_VALUES = ['Not Compliant','No','Unsatisfactory','Not Uploaded','Document Expired!'];

/* Admin checklist items can track a document's validity three ways:
   'none'   — no date tracking at all
   'single' — one expiry date (the original behaviour)
   'range'  — a from/to period (e.g. a MIBCO forecast), which can go stale
              a configurable number of days after the range ends, and — if
              the item has an autoAnswer configured — auto-fills the status
              dropdown with a specific sentence (still editable by staff). */
function itemExpiryMode(item){
  if(item.expiryMode) return item.expiryMode;
  return item.hasExpiry===false ? 'none' : 'single'; // legacy boolean fallback
}
function isRangeStale(rangeEndStr, staleAfterDays){
  if(!rangeEndStr) return false;
  const end = new Date(rangeEndStr);
  if(isNaN(end.getTime())) return false;
  const staleDate = new Date(end.getTime() + (staleAfterDays||30)*86400000);
  return new Date() > staleDate;
}
// Pure READ — reflects what's currently stored, honestly. It only
// "recomputes" the specific case where the stored value was itself
// auto-filled by the system (ans.autoFilled === true); anything a person
// has manually chosen from the dropdown is returned exactly as-is, forever,
// even if the dates say it's stale — that's what makes it changeable.
function effectiveAdminStatus(item, ans){
  ans = ans || {};
  if(itemExpiryMode(item)==='range' && item.autoAnswer && ans.autoFilled){
    const stale = isRangeStale(ans.rangeEnd, item.staleAfterDays||30);
    return stale ? item.autoAnswer : '';
  }
  return ans.status || '';
}
// Mutating version, used only at the moments this is genuinely "in use":
// when the Admin tab is opened, and when the forecast dates are edited.
// Only ever touches values that are still auto-filled (or blank) — a value
// a human picked is never overwritten here.
function recomputeAdminAutoAnswer(item, ans){
  if(itemExpiryMode(item)!=='range' || !item.autoAnswer) return false;
  const stale = isRangeStale(ans.rangeEnd, item.staleAfterDays||30);
  if(ans.autoFilled){
    const next = stale ? item.autoAnswer : '';
    if(ans.status !== next){ ans.status = next; ans.autoFilled = !!next; return true; }
    return false;
  }
  if(!ans.status && stale){ ans.status = item.autoAnswer; ans.autoFilled = true; return true; }
  return false;
}
// The dropdown always offers the standard set, plus the item's own
// auto-answer sentence (if it has one and it isn't already in that list),
// so an auto-filled value is always a normal, changeable option.
function adminStatusOptionsFor(item){
  const opts = OPTION_SETS.document.slice();
  if(item.autoAnswer && !opts.includes(item.autoAnswer)) opts.push(item.autoAnswer);
  return opts;
}

/* Brand colour helpers — used to give each brand's generated report its own
   look (accent colour + logo) instead of the app's generic navy/brass theme. */
function hexToRgb(hex){
  if(!hex) return null;
  const c = hex.replace('#','').trim();
  if(c.length!==6 || /[^0-9a-fA-F]/.test(c)) return null;
  return {r:parseInt(c.substr(0,2),16), g:parseInt(c.substr(2,2),16), b:parseInt(c.substr(4,2),16)};
}
function contrastTextColor(hex){
  const rgb = hexToRgb(hex);
  if(!rgb) return '#ffffff';
  const lum = (0.299*rgb.r + 0.587*rgb.g + 0.114*rgb.b)/255;
  return lum > 0.6 ? '#1B2333' : '#ffffff';
}
function tintColor(hex, amount){
  const rgb = hexToRgb(hex);
  if(!rgb) return '#F3E6C8';
  const mix = (ch)=> Math.round(ch + (255-ch)*amount);
  return `rgb(${mix(rgb.r)},${mix(rgb.g)},${mix(rgb.b)})`;
}
function brandColor(bid){
  const b = state.brands.find(x=>x.id===bid);
  return (b && b.color) || '#16233D';
}
function brandLogo(bid){
  const b = state.brands.find(x=>x.id===bid);
  return (b && b.logo) || '';
}


function appliesToReport(item, contexts){
  if(!contexts || !contexts.length) return !(item.brands && item.brands.length);
  return contexts.some(ctx=>{
    const brandOk = !item.brands || item.brands.length===0 || item.brands.includes(ctx.brandId);
    const typeOk = !item.auditTypes || item.auditTypes.length===0 || (ctx.auditType && item.auditTypes.includes(ctx.auditType));
    return brandOk && typeOk;
  });
}
function contextsFor(report, brandIds){
  const ids = brandIds || (report && report.selectedBrands) || [];
  return ids.map(bid=>({
    brandId: bid,
    auditType: (report && report.brandMeta && report.brandMeta[bid] && report.brandMeta[bid].auditType) || ''
  }));
}
function brandNamesFor(ids){
  return (ids||[]).map(id=>{ const b = state.brands.find(x=>x.id===id); return b?b.name:id; });
}

/* =========================================================
   SEED DATA
   A condensed, real starting point pulled from the uploaded
   workbook so the app is usable immediately. Everything below
   is editable from Owner Setup. Questions with no "brands" tag
   are generic and show up for every audited brand; tagged
   questions/items only show up when that brand is selected.
========================================================= */
async function ensureSeeded(){
  const seeded = await sGet('meta:seeded-v4');
  if(seeded) return;

  const brands = [
    {id:'baic', name:'BAIC South Africa', color:'#C8102E', logo:''},
    {id:'byd', name:'BYD South Africa', color:'#00558C', logo:''},
    {id:'chery', name:'Chery & Omoda South Africa', color:'#8A0303', logo:''}
  ];
  await sSet('brands', brands);

  const workshopStructure = {sections:[
    {id:uid(), title:'Section A \u2014 Customer Experience', subsections:[
      {id:uid(), title:'Corporate Identity', questions:[
        {id:uid(), text:'How do you rate the Overall Panel Shop Appearance?', options:OPTION_SETS.rating, comment:true, brands:[], ncWording:{'Unsatisfactory':'The overall panel shop appearance does not meet the required standard and needs improvement.'}},
        {id:uid(), text:'Is the parking area clean and tidy?', options:OPTION_SETS.rating, comment:false, brands:[]},
        {id:uid(), text:'Are there sufficient parking bays (minimum of four)?', options:OPTION_SETS.yesno, comment:false, brands:[], ncWording:{'No':'A minimum of four (4) dedicated customer/visitor parking bays is required.'}},
        {id:uid(), text:'Is BYD signage current and correctly displayed?', options:OPTION_SETS.compliance, comment:true, brands:['byd'], ncWording:{'Not Compliant':'BYD signage is outdated or incorrectly displayed and must be brought in line with current brand guidelines.'}}
      ]},
      {id:uid(), title:'Customer Friendly Areas', questions:[
        {id:uid(), text:'Is there a dedicated front office / reception area to welcome clients upon arrival?', options:OPTION_SETS.yesno, comment:false, brands:[], ncWording:{'No':'A dedicated front office / reception area to welcome clients upon arrival is required.'}},
        {id:uid(), text:'Do Reception Staff, Estimators & Front Office Staff wear name badges (or names on uniform)?', options:OPTION_SETS.yesno, comment:false, brands:[]},
        {id:uid(), text:'Is there suitable, clean seating for a minimum of four (4) Customers?', options:OPTION_SETS.yesno, comment:false, brands:[]}
      ]},
      {id:uid(), title:'Customer Relationship Management', questions:[
        {id:uid(), text:'Does the Body Shop utilise a computer estimating & management system?', options:OPTION_SETS.yesno, comment:true, brands:[]},
        {id:uid(), text:'Is a Comeback Register (returned vehicles) being maintained?', options:OPTION_SETS.yesno, comment:false, brands:[]},
        {id:uid(), text:'Is the reception entrance clearly visible (demarcated) from the customer parking area?', options:OPTION_SETS.yesno, comment:false, brands:[], auditTypes:['Initial']},
        {id:uid(), text:'There should be no vehicles awaiting repairs, write-offs and/or wrecks in the parking area / front of the shop.', options:OPTION_SETS.yesno, comment:true, brands:[], auditTypes:['Renewal']}
      ]}
    ]},
    {id:uid(), title:'Section B \u2014 Administrative, Legislative Compliance & Liability', subsections:[
      {id:uid(), title:'Legislative Compliance', questions:[
        {id:uid(), text:'Is the Body Shop insured for Public Liability, Product Liability / Defective workmanship, Third Party, Motor Traders Internal & External cover?', options:OPTION_SETS.document, comment:true, brands:[], ncWording:{
          'Not Compliant':'Proof showing that the Body Shop is insured for Public Liability, Product Liability / Defective workmanship, Third Party, Motor Traders Internal & External cover is required.',
          'Not Uploaded':'Proof showing that the Body Shop is insured for Public Liability, Product Liability / Defective workmanship, Third Party, Motor Traders Internal & External cover was not provided.',
          'Document Expired!':'The provided insurance policy has expired. Kindly provide an updated policy showing the required cover.',
          'In Process':'Evidence provided that the Body Shop is in the process of obtaining the required insurance cover.',
          'Unable to verify':'Proof of the required insurance cover was unverifiable.'
        }},
        {id:uid(), text:"Is the Company's Tax Status Compliant with the nation's tax collecting authority?", options:OPTION_SETS.document, comment:false, brands:[], ncWording:{
          'Not Compliant':"The company's tax status returned non-compliant in accordance with the provided tax reference.",
          'Not Uploaded':"No document to verify the company's tax status has been provided.",
          'Document Expired!':'The provided tax document has expired. Kindly provide a new document for verification of tax compliance.',
          'In Process':'Tax compliance is in process as per the letter received. Kindly provide proof of compliance once available.',
          'Unable to verify':"We were unable to verify the company's tax compliance. Kindly provide proof of compliance."
        }},
        {id:uid(), text:'Is the MIBCO Certificate of Good Standing valid?', options:OPTION_SETS.document, comment:false, brands:[], ncWording:{
          'Not Compliant':'A valid MIBCO Certificate of Good Standing is required.',
          'Not Uploaded':'A valid MIBCO Certificate of Good Standing was not provided.',
          'Document Expired!':'The provided MIBCO Certificate of Good Standing has expired.',
          'In Process':'MIBCO Certificate of Good Standing is in process as per evidence received.',
          'Unable to verify':'The provided MIBCO Certificate of Good Standing is unverifiable.'
        }}
      ]},
      {id:uid(), title:'Personnel: Training, Skills Transfer & Qualifications', questions:[
        {id:uid(), text:'Are qualified Auto Body Repairers (Panel Beaters) employed?', options:OPTION_SETS.document, comment:false, brands:[], ncWording:{
          'Not Compliant':'No qualified Auto Body Repairer (Panel Beater) is employed.',
          'Not Uploaded':'No proof showing that a qualified Auto Body Repairer (Panel Beater) is employed.',
          'Document Expired!':'Kindly provide updated proof of an employed qualified Auto Body Repairer / Panel Beater.',
          'In Process':'Evidence provided that a staff member is currently obtaining qualification as an Auto Body Repairer / Panel Beater.',
          'Unable to verify':'The provided qualified Auto Body Repairer / Panel Beater certificate is unverifiable.'
        }},
        {id:uid(), text:'Are qualified Spray Painters employed?', options:OPTION_SETS.document, comment:false, brands:[], ncWording:{
          'Not Compliant':'No qualified Spray Painter is employed.',
          'Not Uploaded':'No proof showing that a qualified Spray Painter is employed.',
          'Document Expired!':'Kindly provide an updated certificate of the employed qualified Spray Painter.',
          'In Process':'Evidence provided that a staff member is obtaining the qualified Spray Painter certificate.',
          'Unable to verify':'The provided qualified Spray Painter certificate is unverifiable.'
        }},
        {id:uid(), text:'Are BAIC-approved diagnostic tools available on site?', options:OPTION_SETS.yesno, comment:true, brands:['baic'], ncWording:{'No':'BAIC-approved diagnostic tools were not found on site and are required for this brand.'}}
      ]}
    ]}
  ]};
  await sSet('workshop-structure', workshopStructure);

  const adminChecklist = {categories:[
    {id:uid(), title:'Company Documents', items:[
      {id:uid(), description:'B-BBEE certificate', hasExpiry:true, brands:[], ncWording:{
        'Not Compliant':'A valid B-BBEE certificate / affidavit is required.',
        'Not Uploaded':'A valid B-BBEE certificate / affidavit was not provided.',
        'Document Expired!':'The provided B-BBEE certificate / affidavit has expired.',
        'In Process':'B-BBEE certificate / affidavit is in process as per the letter received.',
        'Unable to verify':'The provided B-BBEE certificate / affidavit was unverifiable.'
      }},
      {id:uid(), description:'Company Registration Document', hasExpiry:false, brands:[], ncWording:{
        'Not Compliant':'A company registration document is required.',
        'Not Uploaded':'Kindly provide a copy of your company registration document.',
        'Document Expired!':'An updated company registration document is required.'
      }},
      {id:uid(), description:'Insurance Policy', hasExpiry:true, brands:[]},
      {id:uid(), description:'MIBCO Certificate of Good Standing', hasExpiry:true, brands:[]},
      {id:uid(), description:'Tax Clearance Certificate', hasExpiry:true, brands:[]},
      {id:uid(), description:"Workman's Compensation Certificate", hasExpiry:true, brands:[], ncWording:{
        'Not Compliant':"A valid Workman's Compensation / RMA (Rand Mutual Assurance) Certificate is required.",
        'Not Uploaded':"A valid Workman's Compensation / RMA (Rand Mutual Assurance) Certificate was not provided.",
        'Document Expired!':"The provided Workman's Compensation / RMA (Rand Mutual Assurance) Certificate has expired."
      }}
    ]},
    {id:uid(), title:'Audit Supporting Documents', items:[
      {id:uid(), description:'Privacy Policy', hasExpiry:false, brands:[], ncWording:{
        'Not Compliant':'The Body Shop must have a privacy policy in place.',
        'Not Uploaded':'A copy of your privacy policy was not provided.',
        'Document Expired!':'Kindly provide an updated version of your privacy policy.'
      }},
      {id:uid(), description:'Written Paint & Workmanship guarantees', hasExpiry:false, brands:[]},
      {id:uid(), description:'Proof of Workshop Capacity Planning', hasExpiry:false, brands:[]}
    ]},
    {id:uid(), title:'Staff Supporting Documents', items:[
      {id:uid(), description:'Copy of First Aid Certificate', hasExpiry:true, brands:[], ncWording:{
        'Not Compliant':'No valid First Aid certificate provided for a full-time employee.',
        'Not Uploaded':'No proof showing that the company has a full-time employee with a valid First Aid certificate.',
        'Document Expired!':'The provided First Aid certificate has expired.'
      }},
      {id:uid(), description:'Copy of Occupational Health & Safety Certificate', hasExpiry:true, brands:[]},
      {id:uid(), description:'Qualified Auto Body Repairer Certificate', hasExpiry:false, brands:[]},
      {id:uid(), description:'BYD EV High-Voltage Certification (Level 3+)', hasExpiry:true, brands:['byd'], ncWording:{
        'Not Compliant':'A staff member with BYD EV High-Voltage Certification (Level 3+) is required on site.',
        'Not Uploaded':'No proof of BYD EV High-Voltage Certification (Level 3+) was provided.',
        'Document Expired!':'The provided BYD EV High-Voltage Certification has expired and must be renewed.'
      }}
    ]},
    {id:uid(), title:'Equipment & Maintenance', items:[
      {id:uid(), description:'Hoist Service Certificate', hasExpiry:true, brands:[], ncWording:{
        'Not Compliant':'The provided Hoist Service Certificate is not compliant.',
        'Not Uploaded':'Proof that the hoist has been serviced is required.',
        'Document Expired!':'The provided Hoist Service Certificate has expired. Kindly upload your latest certificate.'
      }},
      {id:uid(), description:'Spray booth Service', hasExpiry:true, brands:[], ncWording:{
        'Not Compliant':'The provided Spray Booth Service Certificate is not compliant.',
        'Not Uploaded':'Proof that the spray booth has been serviced is required.',
        'Document Expired!':'The provided Spray Booth Service Certificate has expired. Kindly upload your latest certificate.'
      }},
      {id:uid(), description:'Electrical Certificate of Compliance', hasExpiry:true, brands:[], ncWording:{
        'Not Compliant':'No Electrical Certificate of Compliance provided.',
        'Not Uploaded':'Electrical Certificate of Compliance was not provided.',
        'Document Expired!':'Electrical Certificate of Compliance has expired.'
      }}
    ]}
  ]};
  await sSet('admin-checklist', adminChecklist);

  const existingFolders = await sGet('folders');
  if(!existingFolders) await sSet('folders', []);
  const existingIdx = await sGet('reports-index');
  if(!existingIdx) await sSet('reports-index', []);
  await sSet('meta:seeded-v4', true);
}

// Adds a concrete example of the date-range / auto-answer feature without
// touching anything else in the checklist, so it doesn't clobber real
// customizations the way a full reseed bump would.
async function ensureMibcoForecastExample(){
  const done = await sGet('meta:migrated-mibco-forecast-v1');
  if(done) return;
  const checklist = (await sGet('admin-checklist')) || {categories:[]};
  const alreadyThere = checklist.categories.some(cat=>cat.items.some(it=>it.description==='MIBCO Forecast & Statement'));
  if(!alreadyThere){
    let cat = checklist.categories.find(c=>c.title==='Staff Supporting Documents');
    if(!cat){ cat = {id:uid(), title:'Staff Supporting Documents', items:[]}; checklist.categories.push(cat); }
    cat.items.push({
      id:uid(), description:'MIBCO Forecast & Statement',
      expiryMode:'range', staleAfterDays:30, autoAnswer:'Latest MIBCO not provided',
      brands:[], auditTypes:[],
      ncWording:{'Latest MIBCO not provided':'A current MIBCO Forecast & Statement is required — the one on file has gone stale.'}
    });
    await sSet('admin-checklist', checklist);
  }
  await sSet('meta:migrated-mibco-forecast-v1', true);
}

// Marks a couple of the seeded questions as Critical, purely so the feature
// has a visible working example out of the box. Matches by exact text so it
// only touches the original seeded items, and never re-applies once done —
// safe to run alongside any customisations already made in Owner Setup.
async function ensureCriticalExamples(){
  const done = await sGet('meta:migrated-critical-examples-v1');
  if(done) return;

  const ws = (await sGet('workshop-structure')) || {sections:[]};
  let wsChanged = false;
  const criticalWorkshopTexts = [
    'Is the Body Shop insured for Public Liability, Product Liability / Defective workmanship, Third Party, Motor Traders Internal & External cover?',
    'Is the MIBCO Certificate of Good Standing valid?'
  ];
  ws.sections.forEach(sec=>sec.subsections.forEach(sub=>sub.questions.forEach(q=>{
    if(criticalWorkshopTexts.includes(q.text) && !q.critical){ q.critical = true; wsChanged = true; }
  })));
  if(wsChanged) await sSet('workshop-structure', ws);

  const checklist2 = (await sGet('admin-checklist')) || {categories:[]};
  let clChanged = false;
  const criticalChecklistDescriptions = ['MIBCO Certificate of Good Standing'];
  checklist2.categories.forEach(cat=>cat.items.forEach(item=>{
    if(criticalChecklistDescriptions.includes(item.description) && !item.critical){ item.critical = true; clChanged = true; }
  }));
  if(clChanged) await sSet('admin-checklist', checklist2);

  await sSet('meta:migrated-critical-examples-v1', true);
}

/* =========================================================
   APP STATE
========================================================= */
const state = {
  view:'dashboard',       // dashboard | report | admin | help
  reportId:null,
  reportTab:'info',       // info | admin | workshop | trademarks | noncompliance | brandreports | signoff | photos | documents | export
  brands:[],
  workshopStructure:{sections:[]},
  adminChecklist:{categories:[]},
  reportsIndex:[],
  report:null,            // full current report object
  photos:[],
  documents:[],
  ownerUnlocked:false,    // session-only; resets on reload
  ownerTab:'brands',      // brands | workshop | checklist
  folders:[],             // {id, name, createdAt}
  activeFolder:'all'      // 'all' | 'unfiled' | folderId
};

function defaultSignField(){ return {name:'', sig:'', date:''}; }

function emptyReport(){
  const r = {
    id:uid(),
    createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString(),
    info:{
      accountNumber:'', tradingName:'', registeredName:'', physicalAddress:'',
      contactPerson:'', contactPhone:'', contactEmail:'', auditor:'', auditDate:'',
      gpsLat:'', gpsLong:'', ownershipType:'', ownerName:'', ownerEmail:'', ownerCell:'',
      managerName:'', managerEmail:'', managerCell:'', adminContactName:'', adminEmail:'',
      companyRegNumber:'', vatNumber:'', mibcoNumber:'', websiteAddress:'', beeLevel:'',
      recognitionPercent:'', blackOwnedPercent:'', payeRefNo:'', uifRefNo:'', expiryDate:'',
      sheetConfirmed:true
    },
    selectedBrands:[],
    brandMeta:{},            // brandId -> {auditType, categories}
    folderId:null,
    answers:{},            // workshop questionId -> option value
    comments:{},            // workshop questionId -> free text
    adminCompletedBy:'',
    adminAnswers:{}          // checklistItemId -> {status, expiry, rangeStart, rangeEnd, comments}
  };
  ensureReportExtras(r);
  return r;
}

// Fills in any fields missing on older/incomplete report objects so the UI never breaks.
function ensureReportExtras(r){
  r.info = r.info || {};
  const infoDefaults = {
    accountNumber:'', tradingName:'', registeredName:'', physicalAddress:'',
    contactPerson:'', contactPhone:'', contactEmail:'', auditor:'', auditDate:'',
    gpsLat:'', gpsLong:'', ownershipType:'', ownerName:'', ownerEmail:'', ownerCell:'',
    managerName:'', managerEmail:'', managerCell:'', adminContactName:'', adminEmail:'',
    companyRegNumber:'', vatNumber:'', mibcoNumber:'', websiteAddress:'', beeLevel:'',
    recognitionPercent:'', blackOwnedPercent:'', payeRefNo:'', uifRefNo:'', expiryDate:'',
    sheetConfirmed:true
  };
  Object.keys(infoDefaults).forEach(k=>{ if(r.info[k]===undefined) r.info[k]=infoDefaults[k]; });
  r.brandMeta = r.brandMeta || {};
  r.selectedBrands = r.selectedBrands || [];
  r.folderId = r.folderId || null;
  r.answers = r.answers || {};
  r.comments = r.comments || {};
  r.adminCompletedBy = r.adminCompletedBy || '';
  r.adminAnswers = r.adminAnswers || {};
  r.ncNotes = r.ncNotes || {};              // findingKey -> {status, action, dueDate, responsible, textOverride, answerOverride}
  r.manualFindings = r.manualFindings || []; // [{id, text, answer, comment, brands, status, action, responsible, dueDate}]
  r.brandSignoffs = r.brandSignoffs || {};  // brandId -> {option, details, rep}
  r.trademarks = r.trademarks || {};
  r.trademarks.brandStatus = r.trademarks.brandStatus || {};
  r.trademarks.comments = r.trademarks.comments || '';
  r.trademarks.acknowledged = !!r.trademarks.acknowledged;
  r.trademarks.rep = r.trademarks.rep || defaultSignField();
  r.trademarks.witness = r.trademarks.witness || defaultSignField();
  r.signoff = r.signoff || {};
  r.signoff.sectionA = r.signoff.sectionA || {granted:'', rep:defaultSignField(), witness:defaultSignField()};
  r.signoff.sectionA.rep = r.signoff.sectionA.rep || defaultSignField();
  r.signoff.sectionA.witness = r.signoff.sectionA.witness || defaultSignField();
  r.signoff.sectionB = r.signoff.sectionB || {reason:'', rep:defaultSignField(), witness:defaultSignField()};
  r.signoff.sectionB.rep = r.signoff.sectionB.rep || defaultSignField();
  r.signoff.sectionB.witness = r.signoff.sectionB.witness || defaultSignField();
  r.signoff.sectionC = r.signoff.sectionC || {timeArrived:'', timeCommenced:'', timeCompleted:'', witness:defaultSignField()};
  r.signoff.sectionC.witness = r.signoff.sectionC.witness || defaultSignField();
  r.signoff.sectionD = r.signoff.sectionD || {option:'', details:''};
  r.signoff.sectionE = r.signoff.sectionE || {option:'', details:''};
  r.signoff.sectionH = r.signoff.sectionH || {rep:defaultSignField(), witness:defaultSignField()};
  r.signoff.sectionH.rep = r.signoff.sectionH.rep || defaultSignField();
  r.signoff.sectionH.witness = r.signoff.sectionH.witness || defaultSignField();
  return r;
}
function ensureBrandSignoff(r, bid){
  if(!r.brandSignoffs[bid]) r.brandSignoffs[bid] = {option:'', details:'', rep:defaultSignField()};
  if(!r.brandSignoffs[bid].rep) r.brandSignoffs[bid].rep = defaultSignField();
  return r.brandSignoffs[bid];
}

/* =========================================================
   NAV
========================================================= */
const NAV_ITEMS = [
  {id:'dashboard', label:'Reports', icon:'grid'},
  {id:'new', label:'New Report', icon:'plus'},
  {id:'admin', label:'Owner Setup', icon:'lock'},
  {id:'settings', label:'Server Connection', icon:'server'},
  {id:'help', label:'About this app', icon:'info'}
];
const ICONS = {
  grid:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  plus:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  lock:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  info:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  photo:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  doc:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  download:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  trash:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>',
  copy:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  warn:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  server:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="7" rx="1.5"/><rect x="2" y="14" width="20" height="7" rx="1.5"/><path d="M6 6.5h.01M6 17.5h.01"/></svg>'
};

function renderNav(){
  const html = NAV_ITEMS.map(item => `
    <div class="nav-item ${state.view===item.id?'active':''}" data-nav="${item.id}">
      ${ICONS[item.icon]}<span>${item.label}</span>
    </div>`).join('');
  document.getElementById('nav').innerHTML = html;
  document.getElementById('mobile-sheet').innerHTML = html;
  const foot = document.getElementById('sidebar-foot');
  if(foot) foot.textContent = 'Storage: ' + currentStorageModeLabel();
  document.querySelectorAll('[data-nav]').forEach(el=>{
    el.addEventListener('click', ()=>{
      closeMobileMenu();
      if(el.dataset.nav==='new'){ startNewReport(); }
      else { state.view = el.dataset.nav; render(); }
    });
  });
}
function closeMobileMenu(){ document.getElementById('mobile-menu').classList.remove('open'); }
document.getElementById('hamburger').addEventListener('click', ()=>document.getElementById('mobile-menu').classList.add('open'));
document.getElementById('mobile-menu').addEventListener('click', (e)=>{ if(e.target.id==='mobile-menu') closeMobileMenu(); });

/* =========================================================
   TOPBAR
========================================================= */
function setTopbar(title, sub, actionsHtml){
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent = sub || '';
  document.getElementById('topbar-actions').innerHTML = actionsHtml || '';
}

/* =========================================================
   ROUTER / RENDER
========================================================= */
async function render(){
  renderNav();
  if(state.view==='dashboard') await renderDashboard();
  else if(state.view==='admin') await renderOwnerSetup();
  else if(state.view==='report') await renderReport();
  else if(state.view==='settings') renderSettings();
  else if(state.view==='help') renderHelp();
}

/* ---------- DASHBOARD (with folders) ---------- */
async function loadFolders(){
  state.folders = (await sGet('folders')) || [];
}

async function renderDashboard(){
  state.reportsIndex = (await sGet('reports-index')) || [];
  await loadFolders();
  setTopbar('Reports', `${state.reportsIndex.length} saved report${state.reportsIndex.length===1?'':'s'} \u00b7 visible to everyone using this workspace`,
    `<button class="btn btn-primary" id="btn-new-report">${ICONS.plus} New Report</button>`);
  document.getElementById('btn-new-report').addEventListener('click', ()=>startNewReport());

  const c = document.getElementById('content');
  c.innerHTML = `<div id="folder-bar" style="margin-bottom:16px;"></div><div id="report-list-area"></div>`;
  renderFolderBar(document.getElementById('folder-bar'));
  renderReportList(document.getElementById('report-list-area'));
}

function renderFolderBar(el){
  if(!state.folders.some(f=>f.id===state.activeFolder) && !['all','unfiled'].includes(state.activeFolder)){
    state.activeFolder = 'all';
  }
  const counts = {};
  state.reportsIndex.forEach(r=>{ const k = r.folderId || 'unfiled'; counts[k] = (counts[k]||0)+1; });
  const chips = [
    {id:'all', label:'All reports', count:state.reportsIndex.length},
    ...state.folders.map(f=>({id:f.id, label:f.name, count:counts[f.id]||0})),
    {id:'unfiled', label:'Unfiled', count:counts.unfiled||0}
  ];
  el.innerHTML = `
    <div class="tabs" style="margin-bottom:0;border-bottom:none;flex-wrap:wrap;gap:8px;">
      ${chips.map(ch=>`<div class="folder-chip ${state.activeFolder===ch.id?'active':''}" data-folder="${ch.id}">${escapeHtml(ch.label)} <span class="fc-count">${ch.count}</span></div>`).join('')}
      <div class="folder-chip folder-chip-add" id="add-folder-chip">${ICONS.plus} New folder</div>
    </div>
    <div id="folder-new-row" style="display:none;margin-top:10px;gap:8px;">
      <input type="text" id="folder-new-name" placeholder="e.g. September Week 1" style="max-width:260px;padding:8px 11px;border:1px solid var(--line);border-radius:5px;">
      <button class="btn btn-primary btn-sm" id="folder-new-save">Create</button>
      <button class="btn btn-sm" id="folder-new-cancel">Cancel</button>
    </div>
    <div id="folder-manage-row" style="margin-top:10px;"></div>
  `;
  el.querySelectorAll('[data-folder]').forEach(chip=>chip.addEventListener('click', ()=>{
    state.activeFolder = chip.dataset.folder;
    renderFolderBar(el);
    renderReportList(document.getElementById('report-list-area'));
  }));
  const addChip = document.getElementById('add-folder-chip');
  const newRow = document.getElementById('folder-new-row');
  addChip.addEventListener('click', ()=>{
    newRow.style.display = newRow.style.display==='none' ? 'flex' : 'none';
    if(newRow.style.display==='flex') document.getElementById('folder-new-name').focus();
  });
  document.getElementById('folder-new-cancel').addEventListener('click', ()=>{ newRow.style.display='none'; });
  const saveFolder = async ()=>{
    const name = document.getElementById('folder-new-name').value.trim();
    if(!name) return;
    const folder = {id:uid(), name, createdAt:new Date().toISOString()};
    state.folders.push(folder);
    await sSet('folders', state.folders);
    state.activeFolder = folder.id;
    toast('Folder created');
    renderFolderBar(el);
    renderReportList(document.getElementById('report-list-area'));
  };
  document.getElementById('folder-new-save').addEventListener('click', saveFolder);
  document.getElementById('folder-new-name').addEventListener('keydown', (e)=>{ if(e.key==='Enter') saveFolder(); });

  const manageRow = document.getElementById('folder-manage-row');
  const activeFolderObj = state.folders.find(f=>f.id===state.activeFolder);
  if(activeFolderObj){
    manageRow.innerHTML = `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-soft);">
      <span>Managing "${escapeHtml(activeFolderObj.name)}":</span>
      <button class="btn btn-sm" id="folder-rename-btn">Rename</button>
      <button class="btn btn-sm btn-danger" id="folder-delete-btn">${ICONS.trash} Delete folder</button>
    </div>`;
    document.getElementById('folder-rename-btn').addEventListener('click', async ()=>{
      const name = window.prompt('Rename folder', activeFolderObj.name);
      if(!name || !name.trim()) return;
      activeFolderObj.name = name.trim();
      await sSet('folders', state.folders);
      renderFolderBar(el);
      renderReportList(document.getElementById('report-list-area'));
    });
    document.getElementById('folder-delete-btn').addEventListener('click', async ()=>{
      if(!confirm(`Delete the folder "${activeFolderObj.name}"? Reports inside it will become Unfiled, not deleted.`)) return;
      state.folders = state.folders.filter(f=>f.id!==activeFolderObj.id);
      await sSet('folders', state.folders);
      for(const r of state.reportsIndex.filter(x=>x.folderId===activeFolderObj.id)){
        const full = await sGet('report:'+r.id);
        if(full){ full.folderId = null; await sSet('report:'+r.id, full); }
      }
      state.activeFolder = 'all';
      await renderDashboard();
      toast('Folder deleted');
    });
  } else {
    manageRow.innerHTML = '';
  }
}

function renderReportList(c){
  let rows = state.reportsIndex.slice();
  if(state.activeFolder==='unfiled') rows = rows.filter(r=>!r.folderId);
  else if(state.activeFolder!=='all') rows = rows.filter(r=>r.folderId===state.activeFolder);
  rows.sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));

  if(rows.length===0){
    c.innerHTML = `<div class="card"><div class="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
      <h3 style="color:var(--ink-soft);font-weight:600;">No reports here yet</h3>
      <p style="font-size:13px;margin-top:4px;">${state.reportsIndex.length===0 ? 'Start a new audit report to see it here.' : 'Move a report into this folder, or start a new one — it will be filed here automatically.'}</p>
    </div></div>`;
    return;
  }

  c.innerHTML = `<div class="report-grid">${rows.map(r=>{
    const brandNames = (r.brandNames||[]);
    return `<div class="card report-card" data-open="${r.id}">
      <div class="name">${escapeHtml(r.tradingName || 'Untitled report')}</div>
      <div class="meta">${r.auditor?('Auditor: '+escapeHtml(r.auditor)+' \u00b7 '):''}${r.auditDate ? formatDate(r.auditDate) : 'No date set'}</div>
      <div class="chip-row">${brandNames.length ? brandNames.map(n=>`<span class="chip">${escapeHtml(n)}</span>`).join('') : '<span class="chip">No brands selected</span>'}</div>
      <div style="margin-bottom:4px;display:flex;justify-content:space-between;font-size:11.5px;color:var(--ink-soft);"><span>Progress</span><span>${r.progress||0}%</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${r.progress||0}%"></div></div>
      <div class="report-card-actions" style="flex-wrap:wrap;">
        <select data-move="${r.id}" class="btn-sm" style="border:1px solid var(--line);border-radius:5px;padding:6px 8px;font-size:12.5px;" title="Move to folder">
          <option value="" ${!r.folderId?'selected':''}>Unfiled</option>
          ${state.folders.map(f=>`<option value="${f.id}" ${r.folderId===f.id?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-dup="${r.id}">${ICONS.copy} Duplicate</button>
        <button class="btn btn-sm btn-danger" data-del="${r.id}">${ICONS.trash} Delete</button>
      </div>
    </div>`;
  }).join('')}</div>`;

  c.querySelectorAll('[data-open]').forEach(el=>el.addEventListener('click',(e)=>{
    if(e.target.closest('[data-dup]')||e.target.closest('[data-del]')||e.target.closest('[data-move]')) return;
    openReport(el.dataset.open);
  }));
  c.querySelectorAll('[data-move]').forEach(sel=>{
    sel.addEventListener('click', (e)=>e.stopPropagation());
    sel.addEventListener('change', async (e)=>{
      e.stopPropagation();
      const id = sel.dataset.move;
      const full = await sGet('report:'+id);
      if(!full) return;
      full.folderId = sel.value || null;
      await sSet('report:'+id, full);
      await updateReportsIndex(full);
      toast('Report moved');
      await renderDashboard();
    });
  });
  c.querySelectorAll('[data-dup]').forEach(el=>el.addEventListener('click', async (e)=>{
    e.stopPropagation(); await duplicateReport(el.dataset.dup);
  }));
  c.querySelectorAll('[data-del]').forEach(el=>el.addEventListener('click', async (e)=>{
    e.stopPropagation();
    if(confirm('Delete this report permanently? Its photos and documents will also be removed.')){
      await deleteReport(el.dataset.del);
    }
  }));
}

async function startNewReport(){
  const r = emptyReport();
  if(state.activeFolder && !['all','unfiled'].includes(state.activeFolder)){
    r.folderId = state.activeFolder;
  }
  state.report = r;
  state.reportId = r.id;
  state.reportTab = 'info';
  state.photos = [];
  state.documents = [];
  await loadWorkshopData();
  await loadFolders();
  await saveReport(true);
  state.view = 'report';
  render();
}

async function openReport(id){
  const r = await sGet('report:'+id);
  if(!r){ toast('Report not found'); return; }
  ensureReportExtras(r);
  state.report = r;
  state.reportId = id;
  state.reportTab = 'info';
  await loadWorkshopData();
  await loadFiles();
  await loadFolders();
  state.view = 'report';
  render();
}

async function duplicateReport(id){
  const r = await sGet('report:'+id);
  if(!r) return;
  ensureReportExtras(r);
  const copy = JSON.parse(JSON.stringify(r));
  copy.id = uid();
  copy.createdAt = new Date().toISOString();
  copy.updatedAt = copy.createdAt;
  copy.info.tradingName = (copy.info.tradingName||'Untitled') + ' (copy)';
  await sSet('report:'+copy.id, copy);
  await updateReportsIndex(copy);
  toast('Report duplicated');
  render();
}

async function deleteReport(id){
  await sDel('report:'+id);
  const photoKeys = await sList('photo:'+id+':');
  for(const k of photoKeys) await sDel(k);
  const docKeys = await sList('document:'+id+':');
  for(const k of docKeys) await sDel(k);
  let idx = (await sGet('reports-index')) || [];
  idx = idx.filter(x=>x.id!==id);
  await sSet('reports-index', idx);
  toast('Report deleted');
  render();
}

/* Progress across BOTH Admin and Workshop questions that actually apply
   to the brands selected on this report. */
function computeProgress(report){
  let total=0, done=0;
  const ctx = contextsFor(report);
  const ws = state.workshopStructure || {sections:[]};
  ws.sections.forEach(sec=>sec.subsections.forEach(sub=>sub.questions.forEach(q=>{
    if(!appliesToReport(q, ctx)) return;
    total++; if(report.answers[q.id]) done++;
  })));
  (state.adminChecklist.categories||[]).forEach(cat=>cat.items.forEach(item=>{
    if(!appliesToReport(item, ctx)) return;
    total++; if(effectiveAdminStatus(item, report.adminAnswers[item.id])) done++;
  }));
  return total ? Math.round(done/total*100) : 0;
}

async function updateReportsIndex(report){
  let idx = (await sGet('reports-index')) || [];
  idx = idx.filter(x=>x.id!==report.id);
  const brandNames = (report.selectedBrands||[]).map(bid=>{
    const b = state.brands.find(x=>x.id===bid);
    return b ? b.name : bid;
  });
  idx.push({
    id:report.id,
    tradingName:report.info.tradingName,
    auditor:report.info.auditor,
    auditDate:report.info.auditDate,
    updatedAt:report.updatedAt,
    brandNames,
    folderId:report.folderId || null,
    progress: computeProgress(report)
  });
  await sSet('reports-index', idx);
}

let saveTimer=null;
async function saveReport(immediate){
  if(!state.report) return;
  state.report.updatedAt = new Date().toISOString();
  const doSave = async ()=>{
    await sSet('report:'+state.report.id, state.report);
    await updateReportsIndex(state.report);
  };
  if(immediate){ await doSave(); }
  else{
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 500);
  }
}

/* ---------- REPORT EDITOR ---------- */
async function loadWorkshopData(){
  state.brands = (await sGet('brands')) || [];
  state.workshopStructure = (await sGet('workshop-structure')) || {sections:[]};
  state.adminChecklist = (await sGet('admin-checklist')) || {categories:[]};
}
async function loadFiles(){
  const photoKeys = await sList('photo:'+state.reportId+':');
  state.photos = [];
  for(const k of photoKeys){ const p = await sGet(k); if(p) state.photos.push(p); }
  state.photos.sort((a,b)=>a.name.localeCompare(b.name));

  const docKeys = await sList('document:'+state.reportId+':');
  state.documents = [];
  for(const k of docKeys){ const d = await sGet(k); if(d) state.documents.push(d); }
  state.documents.sort((a,b)=>a.name.localeCompare(b.name));
}

async function renderReport(){
  if(!state.brands.length) await loadWorkshopData();
  const r = state.report;
  ensureReportExtras(r);
  const progress = computeProgress(r);

  setTopbar(r.info.tradingName || 'Untitled report', `Last saved ${timeAgo(r.updatedAt)}`,
    `<button class="btn" id="btn-back">\u2190 All reports</button>`);
  document.getElementById('btn-back').addEventListener('click', async ()=>{ await saveReport(true); state.view='dashboard'; render(); });

  const tabs = [
    {id:'info', label:'Info & Brands'},
    {id:'admin', label:'Admin'},
    {id:'workshop', label:'Workshop'},
    {id:'trademarks', label:'Trademarks'},
    {id:'noncompliance', label:'Non-Compliance'},
    {id:'brandreports', label:'Brand Reports'},
    {id:'signoff', label:'Sign-off'},
    {id:'photos', label:'Photos'},
    {id:'documents', label:'Documents'},
    {id:'export', label:'Export / PDF'}
  ];
  const c = document.getElementById('content');
  c.innerHTML = `
    ${reportHeaderStripHtml(r)}
    <div style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--ink-soft);margin-bottom:4px;">
        <span>Admin + Workshop completion</span><span>${progress}%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
    </div>
    <div class="tabs">${tabs.map(t=>`<div class="tab ${state.reportTab===t.id?'active':''}" data-tab="${t.id}">${t.label}</div>`).join('')}</div>
    <div id="tab-content"></div>
  `;
  c.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click', async ()=>{
    await saveReport(true);
    state.reportTab = el.dataset.tab;
    render();
  }));

  const tc = document.getElementById('tab-content');
  if(state.reportTab==='info') renderInfoTab(tc);
  else if(state.reportTab==='admin') renderAdminTab(tc);
  else if(state.reportTab==='workshop') renderWorkshopTab(tc);
  else if(state.reportTab==='trademarks') renderTrademarksTab(tc);
  else if(state.reportTab==='noncompliance') renderNonComplianceTab(tc);
  else if(state.reportTab==='brandreports') renderBrandReportsTab(tc);
  else if(state.reportTab==='signoff') renderSignoffTab(tc);
  else if(state.reportTab==='photos') renderPhotosTab(tc);
  else if(state.reportTab==='documents') renderDocumentsTab(tc);
  else if(state.reportTab==='export') renderExportTab(tc);
}

function reportHeaderStripHtml(r){
  return `<div class="report-header-strip">
    <div><b>Company</b>${escapeHtml(r.info.tradingName||'\u2014')}</div>
    <div><b>Account #</b>${escapeHtml(r.info.accountNumber||'\u2014')}</div>
    <div><b>Address</b>${escapeHtml(r.info.physicalAddress||'\u2014')}</div>
    <div><b>Audit Contact</b>${escapeHtml(r.info.contactPerson||'\u2014')}</div>
    <div><b>Audit Date</b>${r.info.auditDate?formatDate(r.info.auditDate):'\u2014'}</div>
  </div>`;
}

const AUDIT_TYPE_OPTIONS = ['Renewal','Initial','Change of Ownership (COO)','Change of Premises (COP)','Additional (A)','Upgrade (U)'];


function renderInfoTab(container){
  const r = state.report;

  // Field groups mirror the source Excel "Info" sheet, in the same order,
  // just organized into cards instead of one long vertical list.
  const groupAuditBasics = [
    ['auditor','Auditor','text'],
    ['auditDate','Audit Date','date']
  ];
  const groupIdentification = [
    ['accountNumber','Account Number','text'],
    ['tradingName','Company Trading Name','text','(will be used on Certificates)'],
    ['registeredName','Registered Company Name','text'],
    ['companyRegNumber','Company Reg. Number','text'],
    ['vatNumber','VAT Number','text'],
    ['mibcoNumber','MIBCO Number','text'],
    ['websiteAddress','Website Address','text'],
    ['ownershipType','Company / Ownership Type','select','(Private / Franchise / Corporate)',['Private','Franchise','Corporate']]
  ];
  const groupLocation = [
    ['physicalAddress','Physical Address','text'],
    ['gpsLat','GPS Latitude','text'],
    ['gpsLong','GPS Longitude','text']
  ];
  const groupContacts = [
    ['contactPerson','Audit Contact Person','text'],
    ['contactPhone','Telephone Number','tel'],
    ['contactEmail','Preferred E-mail Address','email'],
    ['ownerName','Owner Name','text'],
    ['ownerEmail','Owner E-mail','email'],
    ['ownerCell','Owner Cell Number','tel','Format (XXX XXX XXXX)'],
    ['managerName','Manager Name','text'],
    ['managerEmail','Manager E-mail','email'],
    ['managerCell','Manager Cell Number','tel','Format (XXX XXX XXXX)'],
    ['adminContactName','Admin Contact Name','text'],
    ['adminEmail','Admin E-mail','email']
  ];
  const groupCompliance = [
    ['beeLevel','BEE Level / Status','text'],
    ['recognitionPercent','% Recognition','text'],
    ['blackOwnedPercent','% Black Owned','text'],
    ['payeRefNo','PAYE Ref No','text','Applicable to Hyundai only'],
    ['uifRefNo','UIF Ref No','text','Applicable to Hyundai only'],
    ['expiryDate','Expiry Date','date','(DD/MM/YYYY)']
  ];

  const renderField = ([key,label,type,hint,options]) => {
    if(type==='select'){
      return `<div class="field">
        <label>${label}</label>
        <select data-info="${key}">
          <option value="">Select\u2026</option>
          ${options.map(o=>`<option value="${escapeAttr(o)}" ${r.info[key]===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}
        </select>
        ${hint?`<p class="note">${escapeHtml(hint)}</p>`:''}
      </div>`;
    }
    return `<div class="field">
      <label>${label}</label>
      <input type="${type}" data-info="${key}" value="${escapeAttr(r.info[key]||'')}">
      ${hint?`<p class="note">${escapeHtml(hint)}</p>`:''}
    </div>`;
  };

  container.innerHTML = `
    <div class="card card-pad" style="margin-bottom:18px;">
      <h3 style="margin-bottom:2px;">Audit Initialisation</h3>
      <div class="field" style="max-width:320px;">
        <label>Folder</label>
        <select id="report-folder">
          <option value="" ${!r.folderId?'selected':''}>Unfiled</option>
          ${state.folders.map(f=>`<option value="${f.id}" ${r.folderId===f.id?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}
        </select>
        <p class="note">Group reports by folder, e.g. "September Week 1", to find them faster on the Reports dashboard.</p>
      </div>
      <div class="grid2">${groupAuditBasics.map(renderField).join('')}</div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px;">
      <h3 style="margin-bottom:12px;">Company Identification</h3>
      <div class="grid2">${groupIdentification.map(renderField).join('')}</div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px;">
      <h3 style="margin-bottom:12px;">Location</h3>
      <div class="grid2">${groupLocation.map(renderField).join('')}</div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px;">
      <h3 style="margin-bottom:12px;">Contacts</h3>
      <div class="grid2">${groupContacts.map(renderField).join('')}</div>
    </div>

    <div class="card card-pad" style="margin-bottom:18px;">
      <h3 style="margin-bottom:12px;">Compliance &amp; BEE</h3>
      <div class="grid2">${groupCompliance.map(renderField).join('')}</div>
    </div>

    <div class="card card-pad">
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;">
        <input type="checkbox" id="info-confirmed" ${r.info.sheetConfirmed!==false?'checked':''}>
        <span>I confirm that the information contained in this sheet has been checked by the Bodyshop representative &amp; updated accordingly by the auditor (all changes indicated in blue on the original sheet).</span>
      </label>
    </div>
  `;

  document.getElementById('report-folder').addEventListener('change', (e)=>{
    r.folderId = e.target.value || null;
    saveReport(false);
  });
  document.getElementById('info-confirmed').addEventListener('change', (e)=>{
    r.info.sheetConfirmed = e.target.checked; saveReport(false);
  });
  container.querySelectorAll('[data-info]').forEach(inp=>{
    const evt = inp.tagName==='SELECT' ? 'change' : 'input';
    inp.addEventListener(evt, ()=>{
      r.info[inp.dataset.info] = inp.value;
      saveReport(false);
      document.getElementById('topbar-title').textContent = r.info.tradingName || 'Untitled report';
    });
  });
  renderBrandPicker(document.getElementById('brand-picker'));
}

function ensureBrandMeta(r, bid){
  r.brandMeta = r.brandMeta || {};
  if(!r.brandMeta[bid]) r.brandMeta[bid] = {auditType:'', categories:[]};
  return r.brandMeta[bid];
}

function renderBrandPicker(el){
  const r = state.report;
  r.brandMeta = r.brandMeta || {};
  if(!state.brands.length){
    el.innerHTML = `<p class="note">No brands set up yet. Go to <strong>Owner Setup</strong> to add the first one.</p>`;
    return;
  }
  el.innerHTML = `<div class="brand-picker">${state.brands.map(b=>{
    const checked = r.selectedBrands.includes(b.id);
    const meta = ensureBrandMeta(r, b.id);
    return `<div class="brand-check ${checked?'checked':''}" style="flex-direction:column;align-items:stretch;gap:8px;">
      <label style="display:flex;align-items:center;gap:10px;">
        <input type="checkbox" data-brand="${b.id}" ${checked?'checked':''}>
        <span class="bname">${escapeHtml(b.name)}</span>
      </label>
      ${checked ? `
        <select data-brand-audittype="${b.id}" style="font-size:12.5px;padding:6px 8px;">
          <option value="">Audit type\u2026</option>
          ${AUDIT_TYPE_OPTIONS.map(o=>`<option value="${escapeAttr(o)}" ${meta.auditType===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}
        </select>
        <div class="tag-row">
          ${VEHICLE_CATEGORY_OPTIONS.map(c=>`<span class="tagchip ${meta.categories.includes(c)?'on':''}" data-brand-cat="${b.id}" data-cat-val="${c}">${c}</span>`).join('')}
        </div>
      ` : ''}
    </div>`;
  }).join('')}</div>`;
  el.querySelectorAll('[data-brand]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const bid = cb.dataset.brand;
      if(cb.checked){ if(!r.selectedBrands.includes(bid)) r.selectedBrands.push(bid); ensureBrandMeta(r, bid); }
      else{ r.selectedBrands = r.selectedBrands.filter(x=>x!==bid); }
      saveReport(false);
      renderBrandPicker(el);
    });
  });
  el.querySelectorAll('[data-brand-audittype]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      ensureBrandMeta(r, sel.dataset.brandAudittype).auditType = sel.value;
      saveReport(false);
    });
  });
  el.querySelectorAll('[data-brand-cat]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const meta = ensureBrandMeta(r, chip.dataset.brandCat);
      const val = chip.dataset.catVal;
      const idx = meta.categories.indexOf(val);
      if(idx===-1) meta.categories.push(val); else meta.categories.splice(idx,1);
      saveReport(false);
      renderBrandPicker(el);
    });
  });
}

/* ---------- ADMIN TAB (in-house staff, before the workshop visit) ---------- */
function renderAdminTab(container){
  const r = state.report;
  if(!r.selectedBrands.length){
    container.innerHTML = noBrandsEmptyState();
    return;
  }
  const checklist = state.adminChecklist || {categories:[]};
  const ctx = contextsFor(r);
  const visibleCats = checklist.categories
    .map(cat=>({...cat, items:cat.items.filter(it=>appliesToReport(it, ctx))}))
    .filter(cat=>cat.items.length>0);

  if(!visibleCats.length){
    container.innerHTML = `<div class="help-box"></div>
      <div class="card"><div class="empty"><p style="font-size:13px;">No checklist items apply to the brands selected on this report yet. Add or tag some from Owner Setup.</p></div></div>`;
    return;
  }

  // Re-evaluate any date-range items every time this tab is opened, so a
  // forecast that's quietly gone stale since the last visit is caught "at
  // the current date of using the document" — not just when the dates were
  // first entered. Only touches values that are still system-set (blank or
  // previously auto-filled); anything a person has picked from the dropdown
  // is left exactly as they set it, permanently.
  let changed = false;
  visibleCats.forEach(cat=>cat.items.forEach(item=>{
    const ans = r.adminAnswers[item.id] || {};
    if(recomputeAdminAutoAnswer(item, ans)){
      r.adminAnswers[item.id] = ans;
      changed = true;
    }
  }));
  if(changed) saveReport(false);

  container.innerHTML = `
    <div class="help-box">Only items relevant to ${escapeHtml(brandNamesFor(r.selectedBrands).join(', '))}</div>
    <div class="field" style="max-width:320px;"><label>Admin completed by</label><input type="text" id="admin-by" value="${escapeAttr(r.adminCompletedBy||'')}"></div>
    ${visibleCats.map(cat=>`
      <div class="section-block">
        <div class="section-title">${escapeHtml(cat.title)}</div>
        <div class="subsection">
          ${cat.items.map((item,i)=>{
            const ans = r.adminAnswers[item.id] || {};
            const mode = itemExpiryMode(item);
            const statusOptions = adminStatusOptionsFor(item);
            const stale = mode==='range' && isRangeStale(ans.rangeEnd, item.staleAfterDays||30);
            return `<div class="q-row">
              <div class="q-num">${i+1}</div>
              <div class="q-body">
                <div class="q-text">${item.critical?`<span class="applies-tag" style="background:var(--bad-bg);color:var(--bad);margin-right:6px;">${ICONS.warn} CRITICAL</span>`:''}${escapeHtml(item.description)}${item.brands&&item.brands.length?`<span class="applies-tag" style="margin-left:8px;">${escapeHtml(brandNamesFor(item.brands).join(', '))}</span>`:''}</div>
                <div class="q-controls">
                  <select data-admin-status="${item.id}">
                    <option value="">Select\u2026</option>
                    ${statusOptions.map(o=>`<option value="${escapeAttr(o)}" ${ans.status===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}
                  </select>
                  ${mode==='single' ? `<input type="date" data-admin-expiry="${item.id}" value="${escapeAttr(ans.expiry||'')}" style="max-width:150px;" title="Expiry date">` : ''}
                  ${mode==='range' ? `
                    <span style="font-size:11.5px;color:var(--ink-soft);">Forecast:</span>
                    <input type="date" data-admin-range-start="${item.id}" value="${escapeAttr(ans.rangeStart||'')}" style="max-width:150px;" title="Forecast period start">
                    <span style="font-size:11.5px;color:var(--ink-soft);">to</span>
                    <input type="date" data-admin-range-end="${item.id}" value="${escapeAttr(ans.rangeEnd||'')}" style="max-width:150px;" title="Forecast period end">
                    ${stale ? `<span class="badge badge-bad">Stale</span>` : ''}
                  ` : ''}
                  ${statusBadge(ans.status, ans.status===item.autoAnswer)}
                </div>
                <div class="q-comment"><input type="text" placeholder="Comments / feedback" data-admin-comment="${item.id}" value="${escapeAttr(ans.comments||'')}"></div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `).join('')}
  `;
  document.getElementById('admin-by').addEventListener('input', (e)=>{ r.adminCompletedBy = e.target.value; saveReport(false); });
  container.querySelectorAll('[data-admin-status]').forEach(sel=>sel.addEventListener('change', ()=>{
    const id=sel.dataset.adminStatus; r.adminAnswers[id]=r.adminAnswers[id]||{};
    r.adminAnswers[id].status=sel.value;
    r.adminAnswers[id].autoFilled=false; // a human just chose this — never silently overwrite it again
    saveReport(false);
    const badge = sel.parentElement.querySelector('.badge'); if(badge) badge.outerHTML = statusBadge(sel.value);
  }));
  container.querySelectorAll('[data-admin-expiry]').forEach(inp=>inp.addEventListener('input', ()=>{
    const id=inp.dataset.adminExpiry; r.adminAnswers[id]=r.adminAnswers[id]||{}; r.adminAnswers[id].expiry=inp.value; saveReport(false);
  }));
  container.querySelectorAll('[data-admin-range-start]').forEach(inp=>inp.addEventListener('change', ()=>{
    const id=inp.dataset.adminRangeStart; r.adminAnswers[id]=r.adminAnswers[id]||{}; r.adminAnswers[id].rangeStart=inp.value; saveReport(false);
  }));
  container.querySelectorAll('[data-admin-range-end]').forEach(inp=>inp.addEventListener('change', ()=>{
    const id=inp.dataset.adminRangeEnd;
    const item = findAdminItem(id);
    r.adminAnswers[id]=r.adminAnswers[id]||{};
    r.adminAnswers[id].rangeEnd=inp.value;
    if(item){ recomputeAdminAutoAnswer(item, r.adminAnswers[id]); }
    saveReport(false);
    renderAdminTab(container);
  }));
  container.querySelectorAll('[data-admin-comment]').forEach(inp=>inp.addEventListener('input', ()=>{
    const id=inp.dataset.adminComment; r.adminAnswers[id]=r.adminAnswers[id]||{}; r.adminAnswers[id].comments=inp.value; saveReport(false);
  }));
}

function findAdminItem(itemId){
  for(const cat of (state.adminChecklist.categories||[])){
    const it = cat.items.find(i=>i.id===itemId);
    if(it) return it;
  }
  return null;
}

function noBrandsEmptyState(){
  return `<div class="card"><div class="empty">
    <h3 style="color:var(--ink-soft);font-weight:600;">No brands selected</h3>
    <p style="font-size:13px;margin-top:4px;">Go to the <strong>Info &amp; Brands</strong> tab and tick at least one brand — this page will then show only the questions relevant to it.</p>
  </div></div>`;
}

/* ---------- WORKSHOP TAB (the on-site audit questions, brand-filtered) ---------- */
function renderWorkshopTab(container){
  const r = state.report;
  if(!r.selectedBrands.length){
    container.innerHTML = noBrandsEmptyState();
    return;
  }
  const ws = state.workshopStructure || {sections:[]};
  const ctx = contextsFor(r);
  const visibleSections = ws.sections.map(sec=>({
    ...sec,
    subsections: sec.subsections.map(sub=>({
      ...sub,
      questions: sub.questions.filter(q=>appliesToReport(q, ctx))
    })).filter(sub=>sub.questions.length>0)
  })).filter(sec=>sec.subsections.length>0);

  if(!visibleSections.length){
    container.innerHTML = `<div class="card"><div class="empty"><p style="font-size:13px;">No workshop questions apply to the brands selected on this report yet. Add or tag some from Owner Setup.</p></div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="help-box">Only items relevant to ${escapeHtml(brandNamesFor(r.selectedBrands).join(', '))}</div>
  ` +
    visibleSections.map(sec=>`
    <div class="section-block">
      <div class="section-title">${escapeHtml(sec.title)}</div>
      ${sec.subsections.map(sub=>`
        <div class="subsection">
          <div class="subsection-title">${escapeHtml(sub.title)}</div>
          ${sub.questions.map((q,i)=>`
            <div class="q-row">
              <div class="q-num">${i+1}</div>
              <div class="q-body">
                <div class="q-text">${q.critical?`<span class="applies-tag" style="background:var(--bad-bg);color:var(--bad);margin-right:6px;">${ICONS.warn} CRITICAL</span>`:''}${escapeHtml(q.text)}${q.brands&&q.brands.length?`<span class="applies-tag" style="margin-left:8px;">${escapeHtml(brandNamesFor(q.brands).join(', '))}</span>`:''}</div>
                <div class="q-controls">
                  <select data-answer="${q.id}">
                    <option value="">Select\u2026</option>
                    ${q.options.map(o=>`<option value="${escapeAttr(o)}" ${r.answers[q.id]===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}
                  </select>
                  ${statusBadge(r.answers[q.id])}
                </div>
                ${q.comment !== false ? `<div class="q-comment"><input type="text" placeholder="Comment (optional)" data-comment="${q.id}" value="${escapeAttr(r.comments[q.id]||'')}"></div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `).join('');

  container.querySelectorAll('[data-answer]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      state.report.answers[sel.dataset.answer] = sel.value;
      saveReport(false);
      const badge = sel.parentElement.querySelector('.badge');
      if(badge) badge.outerHTML = statusBadge(sel.value);
    });
  });
  container.querySelectorAll('[data-comment]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      state.report.comments[inp.dataset.comment] = inp.value;
      saveReport(false);
    });
  });
}

function statusBadge(val, forceBad){
  if(!val) return '<span class="badge badge-neutral">Not answered</span>';
  const good = ['Compliant','Yes','Excellent','Good','Granted','Accepted'];
  const bad = ['Not Compliant','No','Unsatisfactory','Not Uploaded','Document Expired!','Declined','Rejected'];
  if(forceBad || bad.includes(val)) return `<span class="badge badge-bad">${escapeHtml(val)}</span>`;
  if(good.includes(val)) return `<span class="badge badge-good">${escapeHtml(val)}</span>`;
  return `<span class="badge badge-neutral">${escapeHtml(val)}</span>`;
}

/* ---------- TRADEMARKS TAB ---------- */
function renderTrademarksTab(container){
  const r = state.report;
  container.innerHTML = `
    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:6px;">Trademark infringement check</h3>
      <p class="note" style="margin-bottom:12px;">Record whether the bodyshop is displaying unauthorised signage, certificates or advertising for any brand — including brands not covered by this audit.</p>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${state.brands.length ? state.brands.map(b=>{
          const val = r.trademarks.brandStatus[b.id] || '';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:5px;gap:10px;flex-wrap:wrap;">
            <span style="font-size:13.5px;font-weight:600;">${escapeHtml(b.name)}</span>
            <select data-tm-brand="${b.id}">
              <option value="">Select\u2026</option>
              ${OPTION_SETS.yesno.map(o=>`<option value="${escapeAttr(o)}" ${val===o?'selected':''}>${escapeHtml(o)}</option>`).join('')}
            </select>
          </div>`;
        }).join('') : '<p class="note">No brands set up yet.</p>'}
      </div>
      <div class="field" style="margin-top:14px;"><label>Comments</label><textarea id="tm-comments">${escapeHtml(r.trademarks.comments||'')}</textarea></div>
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;">
        <input type="checkbox" id="tm-ack" ${r.trademarks.acknowledged?'checked':''}>
        The body shop acknowledges the existence of trademark infringements and has been made aware of the issue
      </label>
    </div>
    <div class="card card-pad">
      <h3 style="margin-bottom:12px;">Sign-off</h3>
      <div class="grid2">
        <div id="tm-rep"></div>
        <div id="tm-wit"></div>
      </div>
    </div>
  `;
  container.querySelectorAll('[data-tm-brand]').forEach(sel=>sel.addEventListener('change', ()=>{
    r.trademarks.brandStatus[sel.dataset.tmBrand] = sel.value; saveReport(false);
  }));
  document.getElementById('tm-comments').addEventListener('input', (e)=>{ r.trademarks.comments = e.target.value; saveReport(false); });
  document.getElementById('tm-ack').addEventListener('change', (e)=>{ r.trademarks.acknowledged = e.target.checked; saveReport(false); });
  mountSignBlock(document.getElementById('tm-rep'), r.trademarks.rep, 'Representative');
  mountSignBlock(document.getElementById('tm-wit'), r.trademarks.witness, 'Witness');
}

/* ---------- NON-COMPLIANCE REPORT (generalized across Admin + Workshop) ---------- */
function getFindingStatus(r, key){ return (r.ncNotes[key] && r.ncNotes[key].status) || 'Open'; }

// scopeBrandIds: which brands this view is for. Defaults to every brand on
// the audit (i.e. the "All Brands" non-compliance view). Pass a single-brand
// array to get that brand's own findings only.
function collectFindings(r, scopeBrandIds){
  const scope = scopeBrandIds || r.selectedBrands;
  const ctx = contextsFor(r, scope);
  const out = [];
  const ws = state.workshopStructure || {sections:[]};
  ws.sections.forEach(sec=>sec.subsections.forEach(sub=>sub.questions.forEach(q=>{
    if(!appliesToReport(q, ctx)) return;
    const ans = r.answers[q.id];
    if(ans && BAD_VALUES.includes(ans)){
      const key = 'w:'+q.id;
      const note = r.ncNotes[key] || {};
      const templateWording = (q.ncWording && q.ncWording[ans]) || '';
      out.push({key, source:'Workshop', section:sec.title, text:q.text,
        wording: note.wordingOverride!==undefined ? note.wordingOverride : (note.textOverride || templateWording),
        answer:note.answerOverride||ans,
        comment:r.comments[q.id]||'', brands:q.brands, status:getFindingStatus(r,key), isManual:false, critical:!!q.critical});
    }
  })));
  (state.adminChecklist.categories||[]).forEach(cat=>cat.items.forEach(item=>{
    if(!appliesToReport(item, ctx)) return;
    const ans = r.adminAnswers[item.id] || {};
    const effStatus = effectiveAdminStatus(item, ans);
    const isBad = BAD_VALUES.includes(effStatus) || (item.autoAnswer && effStatus===item.autoAnswer);
    if(effStatus && isBad){
      const key = 'a:'+item.id;
      const note = r.ncNotes[key] || {};
      const templateWording = (item.ncWording && item.ncWording[effStatus]) || '';
      out.push({key, source:'Admin', section:cat.title, text:item.description,
        wording: note.wordingOverride!==undefined ? note.wordingOverride : (note.textOverride || templateWording),
        answer:note.answerOverride||effStatus,
        comment:ans.comments||'', brands:item.brands, status:getFindingStatus(r,key), isManual:false, critical:!!item.critical});
    }
  }));
  (r.manualFindings||[]).forEach(mf=>{
    if(mf.brands && mf.brands.length && !mf.brands.some(b=>scope.includes(b))) return;
    out.push({key:'m:'+mf.id, source:'Manual', section:'Manually added', text:'', wording:mf.text||'(no description)', answer:mf.answer||'Not Compliant',
      comment:mf.comment||'', brands:mf.brands||[], status:mf.status||'Open', isManual:true, manualId:mf.id,
      action:mf.action||'', responsible:mf.responsible||'', dueDate:mf.dueDate||'', critical:!!mf.critical});
  });
  return out;
}

function renderNonComplianceTab(container){
  const r = state.report;
  if(!r.selectedBrands.length){ container.innerHTML = noBrandsEmptyState(); return; }
  if(!state.ncSubTab || !(state.ncSubTab==='all' || r.selectedBrands.includes(state.ncSubTab))) state.ncSubTab = 'all';

  const subTabsHtml = `<div class="tabs" style="margin-bottom:16px;">
    <div class="tab ${state.ncSubTab==='all'?'active':''}" data-ncsub="all">All Brands</div>
    ${r.selectedBrands.map(bid=>{ const b = state.brands.find(x=>x.id===bid); return `<div class="tab ${state.ncSubTab===bid?'active':''}" data-ncsub="${bid}">${escapeHtml(b?b.name:bid)}</div>`; }).join('')}
  </div>`;

  container.innerHTML = `
    ${subTabsHtml}
    <div id="nc-body"></div>
  `;
  container.querySelectorAll('[data-ncsub]').forEach(t=>t.addEventListener('click', ()=>{
    state.ncSubTab = t.dataset.ncsub;
    renderNonComplianceTab(container);
  }));
  renderNcBody(document.getElementById('nc-body'), state.ncSubTab);
}

function renderNcBody(el, subTab){
  const r = state.report;
  const scope = subTab==='all' ? r.selectedBrands : [subTab];
  const findings = collectFindings(r, scope);
  const STATUS_OPTIONS = ['Open','In Progress','Resolved'];

  el.innerHTML = `
    <div class="stat-row">
      <div class="stat-pill"><div class="n">${findings.length}</div><div class="l">Findings</div></div>
      <div class="stat-pill"><div class="n" style="color:var(--bad);">${findings.filter(f=>f.critical).length}</div><div class="l">Critical</div></div>
      <div class="stat-pill"><div class="n">${findings.filter(f=>f.status==='Open').length}</div><div class="l">Open</div></div>
      <div class="stat-pill"><div class="n">${findings.filter(f=>f.status==='Resolved').length}</div><div class="l">Resolved</div></div>
    </div>
    ${findings.length ? findings.map((f,i)=>{
      const note = r.ncNotes[f.key] || {};
      return `<div class="card card-pad" style="margin-bottom:12px;${f.critical?'border-color:var(--bad);':''}">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <div>
            <span class="badge badge-brass" style="margin-right:6px;">${f.source}</span>
            ${f.critical ? `<span class="badge badge-bad" style="margin-right:6px;">${ICONS.warn} CRITICAL \u2014 fails audit</span>` : ''}
            <span style="font-size:11.5px;color:var(--ink-soft);">${escapeHtml(f.section)}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            ${statusBadge(f.answer, true)}
            ${f.isManual ? `<button class="icon-btn danger" data-nc-delete="${f.manualId}" title="Delete this manual finding">${ICONS.trash}</button>` : ''}
          </div>
        </div>
        ${!f.isManual ? `<p class="note" style="margin-bottom:8px;">Question: ${escapeHtml(f.text)}${f.critical?' (marked critical in Owner Setup)':''}</p>` : ''}
        <div class="field">
          <label>${f.isManual?'Finding':'Non-compliance wording'}</label>
          <input type="text" ${f.isManual?`data-mf-text="${f.manualId}"`:`data-nc-wording="${f.key}"`} value="${escapeAttr(f.wording)}" placeholder="${f.isManual?'What was found':'Specific wording for this failure, e.g. \u201cA valid MIBCO certificate is required\u201d'}">
          ${!f.isManual && !f.wording ? `<p class="note">No custom wording set for "${escapeHtml(f.answer)}" on this question yet \u2014 add one here, or set a reusable default for this question/option in Owner Setup.</p>` : ''}
        </div>
        <div class="grid2">
          <div class="field"><label>Answer</label><input type="text" ${f.isManual?`data-mf-answer="${f.manualId}"`:`data-nc-answer="${f.key}"`} value="${escapeAttr(f.answer)}"></div>
          <div class="field"><label>Status</label>
            <select ${f.isManual?`data-mf-status="${f.manualId}"`:`data-nc-status="${f.key}"`}>
              ${STATUS_OPTIONS.map(s=>`<option value="${s}" ${f.status===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
        ${f.isManual ? `<div class="field"><label>Comment</label><input type="text" data-mf-comment="${f.manualId}" value="${escapeAttr(f.comment||'')}"></div>` :
          (f.comment ? `<div class="note" style="margin-bottom:10px;">Comment: ${escapeHtml(f.comment)}</div>` : '')}
        ${f.isManual ? `<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;margin-bottom:10px;">
          <input type="checkbox" data-mf-critical="${f.manualId}" ${f.critical?'checked':''}> This is a critical failure \u2014 fails the audit for the brand(s) it applies to
        </label>` : ''}
        <div class="note" style="margin-bottom:10px;">${f.brands&&f.brands.length?('Applies to: '+escapeHtml(brandNamesFor(f.brands).join(', '))):'Applies to: all audited brands'}</div>
        <div class="grid2">
          <div class="field"><label>Responsible person</label><input type="text" ${f.isManual?`data-mf-resp="${f.manualId}"`:`data-nc-resp="${f.key}"`} value="${escapeAttr(f.isManual?(getManual(r,f.manualId).responsible||''):(note.responsible||''))}"></div>
          <div class="field"><label>Due date</label><input type="date" ${f.isManual?`data-mf-due="${f.manualId}"`:`data-nc-due="${f.key}"`} value="${escapeAttr(f.isManual?(getManual(r,f.manualId).dueDate||''):(note.dueDate||''))}"></div>
        </div>
        <div class="field"><label>Corrective action required</label><input type="text" ${f.isManual?`data-mf-action="${f.manualId}"`:`data-nc-action="${f.key}"`} value="${escapeAttr(f.isManual?(getManual(r,f.manualId).action||''):(note.action||''))}"></div>
      </div>`;
    }).join('') : `<div class="card"><div class="empty"><p style="font-size:13px;">No non-compliant items in this scope yet.</p></div></div>`}
    <div class="card card-pad" id="nc-add-block">
      <h4 style="margin-bottom:10px;font-size:13.5px;">Add a manual finding</h4>
      <p class="note" style="margin-bottom:10px;">For something noticed on site that isn't tied to a specific Admin or Workshop question.</p>
      <div class="grid2">
        <div class="field"><label>Finding</label><input type="text" id="mf-new-text" placeholder="What was found"></div>
        <div class="field"><label>Answer / severity</label><input type="text" id="mf-new-answer" placeholder="e.g. Not Compliant" value="Not Compliant"></div>
      </div>
      <div class="field"><label>Comment</label><input type="text" id="mf-new-comment"></div>
      <label style="display:flex;gap:7px;align-items:center;font-size:12.5px;margin-bottom:10px;">
        <input type="checkbox" id="mf-new-critical"> This is a critical failure \u2014 fails the audit
      </label>
      <button class="btn btn-brass btn-sm" id="mf-add-btn">${ICONS.plus} Add finding${subTab==='all'?' (all audited brands)':' (this brand only)'}</button>
    </div>
  `;

  el.querySelectorAll('[data-nc-wording]').forEach(inp=>inp.addEventListener('input', ()=>{
    const k=inp.dataset.ncWording; r.ncNotes[k]=r.ncNotes[k]||{}; r.ncNotes[k].wordingOverride=inp.value; saveReport(false);
  }));
  el.querySelectorAll('[data-nc-answer]').forEach(inp=>inp.addEventListener('input', ()=>{
    const k=inp.dataset.ncAnswer; r.ncNotes[k]=r.ncNotes[k]||{}; r.ncNotes[k].answerOverride=inp.value; saveReport(false);
  }));
  el.querySelectorAll('[data-nc-status]').forEach(sel=>sel.addEventListener('change', ()=>{
    const k=sel.dataset.ncStatus; r.ncNotes[k]=r.ncNotes[k]||{}; r.ncNotes[k].status=sel.value; saveReport(false);
  }));
  el.querySelectorAll('[data-nc-action]').forEach(inp=>inp.addEventListener('input', ()=>{
    const k=inp.dataset.ncAction; r.ncNotes[k]=r.ncNotes[k]||{}; r.ncNotes[k].action=inp.value; saveReport(false);
  }));
  el.querySelectorAll('[data-nc-resp]').forEach(inp=>inp.addEventListener('input', ()=>{
    const k=inp.dataset.ncResp; r.ncNotes[k]=r.ncNotes[k]||{}; r.ncNotes[k].responsible=inp.value; saveReport(false);
  }));
  el.querySelectorAll('[data-nc-due]').forEach(inp=>inp.addEventListener('input', ()=>{
    const k=inp.dataset.ncDue; r.ncNotes[k]=r.ncNotes[k]||{}; r.ncNotes[k].dueDate=inp.value; saveReport(false);
  }));

  el.querySelectorAll('[data-mf-text]').forEach(inp=>inp.addEventListener('input', ()=>{ getManual(r,inp.dataset.mfText).text=inp.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-answer]').forEach(inp=>inp.addEventListener('input', ()=>{ getManual(r,inp.dataset.mfAnswer).answer=inp.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-comment]').forEach(inp=>inp.addEventListener('input', ()=>{ getManual(r,inp.dataset.mfComment).comment=inp.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-status]').forEach(sel=>sel.addEventListener('change', ()=>{ getManual(r,sel.dataset.mfStatus).status=sel.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-resp]').forEach(inp=>inp.addEventListener('input', ()=>{ getManual(r,inp.dataset.mfResp).responsible=inp.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-due]').forEach(inp=>inp.addEventListener('input', ()=>{ getManual(r,inp.dataset.mfDue).dueDate=inp.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-action]').forEach(inp=>inp.addEventListener('input', ()=>{ getManual(r,inp.dataset.mfAction).action=inp.value; saveReport(false); }));
  el.querySelectorAll('[data-mf-critical]').forEach(cb=>cb.addEventListener('change', ()=>{ getManual(r,cb.dataset.mfCritical).critical=cb.checked; saveReport(false); }));
  el.querySelectorAll('[data-nc-delete]').forEach(b=>b.addEventListener('click', ()=>{
    if(!confirm('Delete this manually added finding?')) return;
    r.manualFindings = r.manualFindings.filter(mf=>mf.id!==b.dataset.ncDelete);
    saveReport(false);
    renderNcBody(el, subTab);
  }));

  document.getElementById('mf-add-btn').addEventListener('click', ()=>{
    const text = document.getElementById('mf-new-text').value.trim();
    if(!text){ toast('Add a description first'); return; }
    const mf = {
      id:uid(),
      text,
      answer: document.getElementById('mf-new-answer').value.trim() || 'Not Compliant',
      comment: document.getElementById('mf-new-comment').value.trim(),
      critical: document.getElementById('mf-new-critical').checked,
      brands: subTab==='all' ? [] : [subTab],
      status:'Open', action:'', responsible:'', dueDate:''
    };
    r.manualFindings.push(mf);
    saveReport(false);
    renderNcBody(el, subTab);
    toast('Finding added');
  });
}
function getManual(r, id){ return r.manualFindings.find(mf=>mf.id===id) || {}; }

/* ---------- BRAND REPORTS (generated per audited brand, viewable & signable) ---------- */
function brandStats(r, bid){
  let total=0, done=0, compliant=0, nonCompliant=0, criticalFails=[];
  const ctx = contextsFor(r, [bid]);
  const ws = state.workshopStructure || {sections:[]};
  ws.sections.forEach(sec=>sec.subsections.forEach(sub=>sub.questions.forEach(q=>{
    if(!appliesToReport(q, ctx)) return;
    total++;
    const ans = r.answers[q.id];
    if(ans){
      done++;
      if(BAD_VALUES.includes(ans)){ nonCompliant++; if(q.critical) criticalFails.push({text:q.text, answer:ans}); }
      else compliant++;
    }
  })));
  (state.adminChecklist.categories||[]).forEach(cat=>cat.items.forEach(item=>{
    if(!appliesToReport(item, ctx)) return;
    total++;
    const ans = effectiveAdminStatus(item, r.adminAnswers[item.id]);
    if(ans){
      done++;
      if(BAD_VALUES.includes(ans) || ans===item.autoAnswer){ nonCompliant++; if(item.critical) criticalFails.push({text:item.description, answer:ans}); }
      else compliant++;
    }
  }));
  (r.manualFindings||[]).forEach(mf=>{
    if(mf.brands && mf.brands.length && !mf.brands.includes(bid)) return;
    if(mf.critical) criticalFails.push({text:mf.text||'(no description)', answer:mf.answer||'Not Compliant'});
  });
  return {total, done, compliant, nonCompliant, criticalFails, failed: criticalFails.length>0};
}

function renderBrandReportsTab(container){
  const r = state.report;
  if(!r.selectedBrands.length){
    container.innerHTML = noBrandsEmptyState();
    return;
  }
  container.innerHTML = `
    ${r.selectedBrands.map(bid=>{
      const b = state.brands.find(x=>x.id===bid);
      const stats = brandStats(r, bid);
      const findings = collectFindings(r, [bid]);
      const so = ensureBrandSignoff(r, bid);
      const adminTable = buildAdminTableHtml(bid);
      const workshopTable = buildWorkshopTableHtml(bid);
      const color = brandColor(bid);
      const logo = brandLogo(bid);
      const textOn = contrastTextColor(color);
      return `<div class="card" style="margin-bottom:16px;overflow:hidden;">
        <div style="background:${color};color:${textOn};padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:14px;">
            ${logo ? `<img src="${logo}" style="width:44px;height:44px;border-radius:8px;object-fit:contain;background:rgba(255,255,255,.15);">` : `<div style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;">${escapeHtml((b?b.name:'?').slice(0,1))}</div>`}
            <div>
              <div style="font-weight:800;font-size:16px;">${escapeHtml(b?b.name:bid)}</div>
              <div style="font-size:11.5px;opacity:.85;">Brand Report</div>
            </div>
          </div>
          <div style="background:${stats.failed?'var(--bad)':'var(--good)'};color:#fff;font-weight:800;font-size:13px;letter-spacing:.04em;padding:7px 16px;border-radius:99px;">
            ${stats.failed?'FAIL':'PASS'}
          </div>
        </div>
        <div class="card-pad">
        ${stats.failed ? `<div class="help-box" style="background:var(--bad-bg);border-color:#E7B9B4;color:var(--bad);">
          <strong>Fails the audit</strong> \u2014 ${stats.criticalFails.length} critical item${stats.criticalFails.length===1?'':'s'} non-compliant: ${stats.criticalFails.map(cf=>escapeHtml(cf.text)).join('; ')}
        </div>` : ''}
        <div class="stat-row">
          <div class="stat-pill"><div class="n">${stats.done}/${stats.total}</div><div class="l">Answered</div></div>
          <div class="stat-pill"><div class="n" style="color:var(--good);">${stats.compliant}</div><div class="l">Compliant</div></div>
          <div class="stat-pill"><div class="n" style="color:var(--bad);">${stats.nonCompliant}</div><div class="l">Non-compliant</div></div>
        </div>
        ${findings.length ? `<div class="note" style="margin-bottom:10px;">Non-compliant items for this brand: ${findings.map(f=>escapeHtml(f.wording||f.text||f.answer)).join('; ')} — full detail on the Non-Compliance tab.</div>` : `<div class="note" style="margin-bottom:10px;">No non-compliant items for this brand.</div>`}
        <div style="overflow-x:auto;">${adminTable || `<p class="note">No admin items apply to this brand.</p>`}${workshopTable || `<p class="note">No workshop questions apply to this brand.</p>`}</div>
        <div class="field" style="max-width:420px;">
          <label>Report acceptance</label>
          <select data-br-option="${bid}">
            <option value="">Select\u2026</option>
            <option value="accept" ${so.option==='accept'?'selected':''}>Dealer accepts this brand's report as accurate</option>
            <option value="reject" ${so.option==='reject'?'selected':''}>Dealer does not accept — details below</option>
          </select>
        </div>
        <div class="field"><label>Details (if not accepted)</label><textarea data-br-details="${bid}">${escapeHtml(so.details||'')}</textarea></div>
        <div id="br-sign-${bid}" style="max-width:420px;"></div>
        </div>
      </div>`;
    }).join('')}
  `;
  container.querySelectorAll('[data-br-option]').forEach(sel=>sel.addEventListener('change', ()=>{
    ensureBrandSignoff(r, sel.dataset.brOption).option = sel.value; saveReport(false);
  }));
  container.querySelectorAll('[data-br-details]').forEach(ta=>ta.addEventListener('input', ()=>{
    ensureBrandSignoff(r, ta.dataset.brDetails).details = ta.value; saveReport(false);
  }));
  r.selectedBrands.forEach(bid=>{
    const so = ensureBrandSignoff(r, bid);
    mountSignBlock(document.getElementById('br-sign-'+bid), so.rep, 'Dealer representative');
  });
}

/* ---------- SIGN-OFF TAB (overall visit sign-off) ---------- */
function renderSignoffTab(container){
  const r = state.report;
  const so = r.signoff;
  const findingCount = collectFindings(r).length;
  container.innerHTML = `
    <div class="card card-pad" style="margin-bottom:16px;">
      <h3>Section A — Permission to proceed with audit</h3>
      <p class="note" style="margin-bottom:10px;">The dealer representative confirms permission for the audit and access to premises/documentation.</p>
      <select id="soA-granted" style="max-width:280px;margin-bottom:12px;">
        <option value="">Select\u2026</option>
        <option value="Granted" ${so.sectionA.granted==='Granted'?'selected':''}>Permission granted</option>
        <option value="Declined" ${so.sectionA.granted==='Declined'?'selected':''}>Audit declined (complete Section B)</option>
      </select>
      <div class="grid2"><div id="soA-rep"></div><div id="soA-wit"></div></div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;${so.sectionA.granted==='Declined'?'':'display:none;'}" id="soB-block">
      <h3>Section B — Audit declined</h3>
      <p class="note" style="margin-bottom:10px;">Only complete if the audit is being declined. Provide the reason below.</p>
      <div class="field"><textarea id="soB-reason" placeholder="Reason for declining audit">${escapeHtml(so.sectionB.reason||'')}</textarea></div>
      <div class="grid2"><div id="soB-rep"></div><div id="soB-wit"></div></div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Section C — Duration</h3>
      <div class="grid3">
        <div class="field"><label>Time arrived</label><input type="time" id="soC-arrived" value="${escapeAttr(so.sectionC.timeArrived||'')}"></div>
        <div class="field"><label>Time commenced</label><input type="time" id="soC-commenced" value="${escapeAttr(so.sectionC.timeCommenced||'')}"></div>
        <div class="field"><label>Time completed</label><input type="time" id="soC-completed" value="${escapeAttr(so.sectionC.timeCompleted||'')}"></div>
      </div>
      <div id="soC-wit" style="max-width:360px;"></div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Section D — Audit report accuracy</h3>
      <label class="radio-line"><input type="radio" name="soD" value="accept" id="soD-accept" ${so.sectionD.option==='accept'?'checked':''}> I accept that the information contained in this audit report is accurate and correct.</label>
      <label class="radio-line"><input type="radio" name="soD" value="reject" id="soD-reject" ${so.sectionD.option==='reject'?'checked':''}> I do not accept that the information contained in this audit report is accurate and correct.</label>
      <div class="field"><label>If not accepted, details of non-acceptance</label><textarea id="soD-details">${escapeHtml(so.sectionD.details||'')}</textarea></div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Section E — Verification of documents</h3>
      <label class="radio-line"><input type="radio" name="soE" value="consent" id="soE-consent" ${so.sectionE.option==='consent'?'checked':''}> I give consent for verification of documents provided for audit.</label>
      <label class="radio-line"><input type="radio" name="soE" value="object" id="soE-object" ${so.sectionE.option==='object'?'checked':''}> I object to verification of documents provided for audit.</label>
      <div class="field"><label>If objecting, details</label><textarea id="soE-details">${escapeHtml(so.sectionE.details||'')}</textarea></div>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:10px;">Audit Result</h3>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${r.selectedBrands.map(bid=>{
          const b = state.brands.find(x=>x.id===bid);
          const stats = brandStats(r, bid);
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--line);border-radius:6px;flex-wrap:wrap;gap:8px;">
            <span style="font-weight:600;font-size:13.5px;">${escapeHtml(b?b.name:bid)}</span>
            <span style="display:flex;align-items:center;gap:8px;">
              ${stats.failed?`<span class="note" style="margin:0;">${stats.criticalFails.length} critical failure${stats.criticalFails.length===1?'':'s'}</span>`:''}
              <span class="badge" style="background:${stats.failed?'var(--bad)':'var(--good)'};color:#fff;">${stats.failed?'FAIL':'PASS'}</span>
            </span>
          </div>`;
        }).join('')}
      </div>
      <p class="note" style="margin-top:10px;">A brand fails automatically if any question marked Critical in Owner Setup is answered non-compliant — regardless of the overall compliance percentage.</p>
    </div>

    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:6px;">Section F — Non-compliances found</h3>
      <p class="note" style="margin-bottom:10px;">${findingCount} item${findingCount===1?'':'s'} recorded. Full detail, corrective actions and due dates live on the <strong>Non-Compliance</strong> tab — this is the summary for sign-off.</p>
    </div>

    <div class="card card-pad">
      <h3 style="margin-bottom:10px;">Section H — Final sign-off</h3>
      <div class="grid2"><div id="soH-rep"></div><div id="soH-wit"></div></div>
    </div>
  `;
  document.getElementById('soA-granted').addEventListener('change', (e)=>{ so.sectionA.granted=e.target.value; saveReport(false); renderSignoffTab(container); });
  mountSignBlock(document.getElementById('soA-rep'), so.sectionA.rep, 'Representative');
  mountSignBlock(document.getElementById('soA-wit'), so.sectionA.witness, 'Witness');
  if(document.getElementById('soB-reason')){
    document.getElementById('soB-reason').addEventListener('input', (e)=>{ so.sectionB.reason=e.target.value; saveReport(false); });
    mountSignBlock(document.getElementById('soB-rep'), so.sectionB.rep, 'Representative');
    mountSignBlock(document.getElementById('soB-wit'), so.sectionB.witness, 'Witness');
  }
  document.getElementById('soC-arrived').addEventListener('input', e=>{ so.sectionC.timeArrived=e.target.value; saveReport(false); });
  document.getElementById('soC-commenced').addEventListener('input', e=>{ so.sectionC.timeCommenced=e.target.value; saveReport(false); });
  document.getElementById('soC-completed').addEventListener('input', e=>{ so.sectionC.timeCompleted=e.target.value; saveReport(false); });
  mountSignBlock(document.getElementById('soC-wit'), so.sectionC.witness, 'Witness');
  document.getElementById('soD-accept').addEventListener('change', ()=>{ so.sectionD.option='accept'; saveReport(false); });
  document.getElementById('soD-reject').addEventListener('change', ()=>{ so.sectionD.option='reject'; saveReport(false); });
  document.getElementById('soD-details').addEventListener('input', e=>{ so.sectionD.details=e.target.value; saveReport(false); });
  document.getElementById('soE-consent').addEventListener('change', ()=>{ so.sectionE.option='consent'; saveReport(false); });
  document.getElementById('soE-object').addEventListener('change', ()=>{ so.sectionE.option='object'; saveReport(false); });
  document.getElementById('soE-details').addEventListener('input', e=>{ so.sectionE.details=e.target.value; saveReport(false); });
  mountSignBlock(document.getElementById('soH-rep'), so.sectionH.rep, 'Representative');
  mountSignBlock(document.getElementById('soH-wit'), so.sectionH.witness, 'Witness');
}

/* ---------- SIGNATURE PAD (shared by Trademarks, Brand Reports & Sign-off) ---------- */
function mountSignBlock(el, obj, label){
  if(!el) return;
  el.innerHTML = `
    <div class="field"><label>${label} name</label><input type="text" data-sb-name value="${escapeAttr(obj.name||'')}"></div>
    <div class="field"><label>${label} signature</label>
      <div class="sig-wrap"><canvas class="sig-canvas"></canvas></div>
      <button type="button" class="btn btn-sm" data-sb-clear style="margin-top:6px;">Clear signature</button>
    </div>
    <div class="field"><label>Date</label><input type="date" data-sb-date value="${escapeAttr(obj.date||'')}"></div>
  `;
  el.querySelector('[data-sb-name]').addEventListener('input', (e)=>{ obj.name = e.target.value; saveReport(false); });
  el.querySelector('[data-sb-date]').addEventListener('input', (e)=>{ obj.date = e.target.value; saveReport(false); });
  const canvas = el.querySelector('canvas');
  setupSignatureCanvas(canvas, obj);
  el.querySelector('[data-sb-clear]').addEventListener('click', ()=>{
    const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); obj.sig=''; saveReport(false);
  });
}
function setupSignatureCanvas(canvas, obj){
  canvas.width = 380; canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#1B2333'; ctx.lineWidth=2.2; ctx.lineCap='round';
  if(obj.sig){ const img=new Image(); img.onload=()=>ctx.drawImage(img,0,0,canvas.width,canvas.height); img.src=obj.sig; }
  let drawing=false, last=null;
  function pos(e){
    const rect=canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {x:(t.clientX-rect.left)*canvas.width/rect.width, y:(t.clientY-rect.top)*canvas.height/rect.height};
  }
  function start(e){ e.preventDefault(); drawing=true; last=pos(e); }
  function move(e){ if(!drawing) return; e.preventDefault(); const p=pos(e); ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(p.x,p.y); ctx.stroke(); last=p; }
  function end(){ if(!drawing) return; drawing=false; obj.sig = canvas.toDataURL('image/png'); saveReport(false); }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, {passive:false});
  canvas.addEventListener('touchmove', move, {passive:false});
  canvas.addEventListener('touchend', end);
}

/* ---------- PHOTOS ---------- */
function renderPhotosTab(container){
  container.innerHTML = `
    <div class="file-drop" id="photo-drop">
      ${ICONS.photo}
      <p style="margin-top:8px;font-weight:600;color:var(--ink);">Drop audit photos here, or click to choose files</p>
      <p class="note">Images are auto-compressed on upload. Best for on-site condition photos, not raw high-res camera files.</p>
      <input type="file" id="photo-input" accept="image/*" multiple style="display:none;">
    </div>
    <div class="photo-grid" id="photo-grid"></div>
  `;
  const drop = document.getElementById('photo-drop');
  const input = document.getElementById('photo-input');
  drop.addEventListener('click', ()=>input.click());
  ['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.remove('drag');}));
  drop.addEventListener('drop', (e)=>handlePhotoFiles(e.dataTransfer.files));
  input.addEventListener('change', (e)=>handlePhotoFiles(e.target.files));
  renderPhotoGrid();
}

function renderPhotoGrid(){
  const grid = document.getElementById('photo-grid');
  if(!grid) return;
  if(!state.photos.length){ grid.innerHTML = `<p class="note">No photos uploaded for this report yet.</p>`; return; }
  grid.innerHTML = state.photos.map(p=>`
    <div class="photo-item">
      <img src="${p.dataUrl}" alt="${escapeAttr(p.name)}">
      <div class="pmeta">
        <div class="pname" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</div>
        <div class="pactions">
          <button class="icon-btn" data-dl-photo="${p.id}" title="Download">${ICONS.download}</button>
          <button class="icon-btn danger" data-del-photo="${p.id}" title="Delete">${ICONS.trash}</button>
        </div>
      </div>
    </div>`).join('');
  grid.querySelectorAll('[data-dl-photo]').forEach(b=>b.addEventListener('click', ()=>{
    const p = state.photos.find(x=>x.id===b.dataset.dlPhoto);
    downloadDataUrl(p.dataUrl, p.name);
  }));
  grid.querySelectorAll('[data-del-photo]').forEach(b=>b.addEventListener('click', async ()=>{
    const p = state.photos.find(x=>x.id===b.dataset.delPhoto);
    await sDel('photo:'+state.reportId+':'+p.id);
    state.photos = state.photos.filter(x=>x.id!==p.id);
    renderPhotoGrid();
    toast('Photo deleted');
  }));
}

async function handlePhotoFiles(fileList){
  for(const file of Array.from(fileList)){
    if(!file.type.startsWith('image/')) continue;
    try{
      const dataUrl = await compressImage(file, 1400, 0.72);
      const photo = {id:uid(), name:file.name, dataUrl, uploadedAt:new Date().toISOString()};
      const ok = await sSet('photo:'+state.reportId+':'+photo.id, photo);
      if(ok){ state.photos.push(photo); }
      else{ toast('Photo too large to store — try a smaller image'); }
    }catch(e){ console.error(e); toast('Could not process '+file.name); }
  }
  state.photos.sort((a,b)=>a.name.localeCompare(b.name));
  renderPhotoGrid();
}

function compressImage(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    const reader = new FileReader();
    reader.onload = ()=>{ img.src = reader.result; };
    reader.onerror = reject;
    img.onload = ()=>{
      let w = img.width, h = img.height;
      if(w > maxDim || h > maxDim){
        if(w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
        else{ w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- DOCUMENTS ---------- */
function renderDocumentsTab(container){
  container.innerHTML = `
    <div class="file-drop" id="doc-drop">
      ${ICONS.doc}
      <p style="margin-top:8px;font-weight:600;color:var(--ink);">Drop company documents here, or click to choose files</p>
      <p class="note">Certificates, insurance, MIBCO letters, etc. Keep files under ~3MB each for reliable storage.</p>
      <input type="file" id="doc-input" multiple style="display:none;">
    </div>
    <div class="doc-list" id="doc-list"></div>
  `;
  const drop = document.getElementById('doc-drop');
  const input = document.getElementById('doc-input');
  drop.addEventListener('click', ()=>input.click());
  ['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.remove('drag');}));
  drop.addEventListener('drop', (e)=>handleDocFiles(e.dataTransfer.files));
  input.addEventListener('change', (e)=>handleDocFiles(e.target.files));
  renderDocList();
}

function renderDocList(){
  const list = document.getElementById('doc-list');
  if(!list) return;
  if(!state.documents.length){ list.innerHTML = `<p class="note">No documents uploaded for this report yet.</p>`; return; }
  list.innerHTML = state.documents.map(d=>`
    <div class="doc-item">
      <div class="doc-icon">${ICONS.doc}</div>
      <div class="doc-info">
        <div class="doc-name">${escapeHtml(d.name)}</div>
        <div class="doc-meta">${d.mimeType||'file'} \u00b7 ${formatBytes(d.size||0)}</div>
      </div>
      <button class="icon-btn" data-dl-doc="${d.id}" title="Download">${ICONS.download}</button>
      <button class="icon-btn danger" data-del-doc="${d.id}" title="Delete">${ICONS.trash}</button>
    </div>`).join('');
  list.querySelectorAll('[data-dl-doc]').forEach(b=>b.addEventListener('click', ()=>{
    const d = state.documents.find(x=>x.id===b.dataset.dlDoc);
    downloadDataUrl(d.dataUrl, d.name);
  }));
  list.querySelectorAll('[data-del-doc]').forEach(b=>b.addEventListener('click', async ()=>{
    const d = state.documents.find(x=>x.id===b.dataset.delDoc);
    await sDel('document:'+state.reportId+':'+d.id);
    state.documents = state.documents.filter(x=>x.id!==d.id);
    renderDocList();
    toast('Document deleted');
  }));
}

async function handleDocFiles(fileList){
  for(const file of Array.from(fileList)){
    if(file.size > 4.5*1024*1024){ toast(file.name+' is too large (limit ~4.5MB)'); continue; }
    try{
      const dataUrl = await fileToDataUrl(file);
      const doc = {id:uid(), name:file.name, mimeType:file.type, size:file.size, dataUrl, uploadedAt:new Date().toISOString()};
      const ok = await sSet('document:'+state.reportId+':'+doc.id, doc);
      if(ok){ state.documents.push(doc); }
      else{ toast('Could not store '+file.name+' (too large)'); }
    }catch(e){ console.error(e); toast('Could not upload '+file.name); }
  }
  state.documents.sort((a,b)=>a.name.localeCompare(b.name));
  renderDocList();
}
function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---------- EXPORT / PDF ---------- */
function renderExportTab(container){
  const r = state.report;
  const extraPages = [
    {type:'admin', label:'Admin checklist'},
    {type:'workshop', label:'Workshop (all audited brands)'},
    {type:'trademarks', label:'Trademarks'},
    {type:'noncompliance', label:'Non-Compliance report'},
    {type:'signoff', label:'Sign-off sheet'}
  ];
  container.innerHTML = `
    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:6px;">Full report</h3>
      <p class="note" style="margin-bottom:12px;">One PDF containing the info page, admin checklist, workshop results, trademarks, non-compliance report and sign-off sheet.</p>
      <button class="btn btn-primary" id="export-all">${ICONS.download} Download full report PDF</button>
    </div>
    ${r.selectedBrands.length ? `
    <div class="card card-pad" style="margin-bottom:16px;">
      <h3 style="margin-bottom:6px;">Brand reports &amp; brand non-compliance reports</h3>
      <p class="note" style="margin-bottom:12px;">Brand Report is the full Excel-style Admin + Workshop record for that brand; Non-Compliance is just its findings, handy to send a brand manager on its own. Files are named ${'`'}Company_Brand_...pdf${'`'}.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${r.selectedBrands.map(bid=>{
          const b = state.brands.find(x=>x.id===bid);
          const name = b?b.name:bid;
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:6px;flex-wrap:wrap;gap:8px;">
            <span style="font-weight:600;font-size:13.5px;">${escapeHtml(name)}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn btn-sm" data-export-brand="${bid}">${ICONS.download} Brand Report</button>
              <button class="btn btn-sm" data-export-brand-nc="${bid}">${ICONS.download} Non-Compliance</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}
    <div class="card card-pad">
      <h3 style="margin-bottom:6px;">Other pages</h3>
      <p class="note" style="margin-bottom:12px;">Handy when only one page needs to go out — e.g. the non-compliance report on its own, or just the sign-off sheet.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${extraPages.map(p=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:6px;flex-wrap:wrap;gap:8px;">
            <span style="font-weight:600;font-size:13.5px;">${escapeHtml(p.label)}</span>
            <button class="btn btn-sm" data-export-page="${p.type}">${ICONS.download} Download PDF</button>
          </div>`).join('')}
      </div>
    </div>
    <div id="pdf-render-zone" style="position:fixed;left:-9999px;top:-10000px;"></div>
  `;
  document.getElementById('export-all').addEventListener('click', ()=>exportPdf(null));
  container.querySelectorAll('[data-export-brand]').forEach(b=>b.addEventListener('click', ()=>exportPdf({type:'brandreport', id:b.dataset.exportBrand})));
  container.querySelectorAll('[data-export-brand-nc]').forEach(b=>b.addEventListener('click', ()=>exportPdf({type:'noncompliance', id:b.dataset.exportBrandNc})));
  container.querySelectorAll('[data-export-page]').forEach(b=>b.addEventListener('click', ()=>exportPdf({type:b.dataset.exportPage})));
}

function fileSafe(s){ return (s||'untitled').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,''); }

function buildInfoHeaderHtml(){
  const r = state.report;
  return `<div class="letterhead">
      <div>
        <h2>${escapeHtml(r.info.tradingName || 'Untitled Company')}</h2>
        <div class="lh-sub">Approved Body Repair Centre Programme &middot; Audit Report</div>
      </div>
      <div class="lh-sub" style="text-align:right;">
        ${r.info.auditDate ? formatDate(r.info.auditDate) : ''}<br>
        ${escapeHtml(r.info.auditor||'')}
      </div>
    </div>
    <div class="info-grid">
      <div><span>Account Number: </span>${escapeHtml(r.info.accountNumber||'-')}</div>
      <div><span>Registered Name: </span>${escapeHtml(r.info.registeredName||'-')}</div>
      <div><span>Physical Address: </span>${escapeHtml(r.info.physicalAddress||'-')}</div>
      <div><span>Audit Contact Person: </span>${escapeHtml(r.info.contactPerson||'-')}</div>
      <div><span>Audit Date: </span>${r.info.auditDate?formatDate(r.info.auditDate):'-'}</div>
      <div><span>Phone / Email: </span>${escapeHtml(r.info.contactPhone||'-')} ${r.info.contactEmail?('/ '+escapeHtml(r.info.contactEmail)):''}</div>
    </div>`;
}

// A branded letterhead for a single manufacturer's Brand Report — uses that
// brand's own accent colour and logo (set in Owner Setup) instead of the
// app's generic navy/brass, so the document reads as that brand's own.
function buildBrandLetterheadHtml(bid){
  const r = state.report;
  const b = state.brands.find(x=>x.id===bid);
  const color = brandColor(bid);
  const logo = brandLogo(bid);
  const textOn = contrastTextColor(color);
  return `<div class="letterhead" style="border-bottom-color:${color};align-items:center;">
      <div style="display:flex;align-items:center;gap:14px;">
        ${logo ? `<div style="width:56px;height:56px;border-radius:8px;overflow:hidden;flex-shrink:0;background:${color};display:flex;align-items:center;justify-content:center;"><img src="${logo}" style="width:100%;height:100%;object-fit:contain;"></div>` : `<div style="width:56px;height:56px;border-radius:8px;flex-shrink:0;background:${color};color:${textOn};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;">${escapeHtml((b?b.name:'?').slice(0,1))}</div>`}
        <div>
          <h2 style="color:${color};">${escapeHtml(b?b.name:bid)}</h2>
          <div class="lh-sub">Body Repair Centre Programme &middot; Brand Report for ${escapeHtml(r.info.tradingName||'Untitled Company')}</div>
        </div>
      </div>
      <div class="lh-sub" style="text-align:right;">
        ${r.info.auditDate ? formatDate(r.info.auditDate) : ''}<br>
        ${escapeHtml(r.info.auditor||'')}
      </div>
    </div>
    <div class="info-grid">
      <div><span>Company Trading Name: </span>${escapeHtml(r.info.tradingName||'-')}</div>
      <div><span>Account Number: </span>${escapeHtml(r.info.accountNumber||'-')}</div>
      <div><span>Physical Address: </span>${escapeHtml(r.info.physicalAddress||'-')}</div>
      <div><span>Audit Contact Person: </span>${escapeHtml(r.info.contactPerson||'-')}</div>
      <div><span>Audit Date: </span>${r.info.auditDate?formatDate(r.info.auditDate):'-'}</div>
      <div><span>Auditor: </span>${escapeHtml(r.info.auditor||'-')}</div>
    </div>`;
}

function excelAnswerClass(val){
  if(!val) return 'ans-neutral';
  if(BAD_VALUES.includes(val)) return 'ans-bad';
  const good = ['Compliant','Yes','Excellent','Good'];
  if(good.includes(val)) return 'ans-good';
  return 'ans-neutral';
}
function excelTableHead(color){
  const bg = color ? `background:${color};color:${contrastTextColor(color)};` : '';
  return `<thead><tr><th style="width:28px;${bg}">#</th><th style="${bg}">Question</th><th style="width:140px;${bg}">Answer</th><th style="${bg}">Comment</th></tr></thead>`;
}
function buildAdminTableHtml(brandFilter){
  const r = state.report;
  const ctx = contextsFor(r, brandFilter ? [brandFilter] : null);
  const color = brandFilter ? brandColor(brandFilter) : null;
  const checklist = state.adminChecklist || {categories:[]};
  let rows = '';
  let any = false;
  checklist.categories.forEach(cat=>{
    const items = cat.items.filter(it=>appliesToReport(it, ctx));
    if(!items.length) return;
    any = true;
    rows += `<tr class="sec-row"${color?` style="background:${tintColor(color,0.85)};color:${contrastTextColor(tintColor(color,0.85))};"`:''}><td colspan="4"${color?` style="background:${tintColor(color,0.85)};"`:''}>${escapeHtml(cat.title)}</td></tr>`;
    items.forEach((item,i)=>{
      const ans = r.adminAnswers[item.id] || {};
      const status = effectiveAdminStatus(item, ans);
      let comment = ans.comments || '';
      if(ans.expiry) comment += (comment?' \u00b7 ':'') + 'Expiry: '+ans.expiry;
      if(ans.rangeStart || ans.rangeEnd) comment += (comment?' \u00b7 ':'') + 'Forecast: '+(ans.rangeStart||'?')+' to '+(ans.rangeEnd||'?');
      const cellClass = status===item.autoAnswer ? 'ans-bad' : excelAnswerClass(status);
      rows += `<tr><td>${i+1}</td><td>${escapeHtml(item.description)}</td><td class="${cellClass}">${escapeHtml(status||'Not answered')}</td><td>${escapeHtml(comment)}</td></tr>`;
    });
  });
  if(!any) return '';
  return `<h4 style="margin:14px 0 6px;font-size:13px;color:${color||'var(--navy)'};">Admin \u2014 Document Checklist</h4><table class="excel-table">${excelTableHead(color)}<tbody>${rows}</tbody></table>`;
}
function buildWorkshopTableHtml(brandFilter){
  const r = state.report;
  const ctx = contextsFor(r, brandFilter ? [brandFilter] : null);
  const color = brandFilter ? brandColor(brandFilter) : null;
  const ws = state.workshopStructure || {sections:[]};
  let rows = '';
  let any = false;
  ws.sections.forEach(sec=>{
    const subs = sec.subsections.map(sub=>({...sub, questions: sub.questions.filter(q=>appliesToReport(q, ctx))})).filter(sub=>sub.questions.length);
    if(!subs.length) return;
    any = true;
    rows += `<tr class="sec-row"${color?` style="background:${tintColor(color,0.85)};color:${contrastTextColor(tintColor(color,0.85))};"`:''}><td colspan="4"${color?` style="background:${tintColor(color,0.85)};"`:''}>${escapeHtml(sec.title)}</td></tr>`;
    subs.forEach(sub=>{
      rows += `<tr class="sub-row"><td colspan="4">${escapeHtml(sub.title)}</td></tr>`;
      sub.questions.forEach((q,i)=>{
        const ans = r.answers[q.id] || '';
        const cm = r.comments[q.id] || '';
        rows += `<tr><td>${i+1}</td><td>${escapeHtml(q.text)}</td><td class="${excelAnswerClass(ans)}">${escapeHtml(ans||'Not answered')}</td><td>${escapeHtml(cm)}</td></tr>`;
      });
    });
  });
  if(!any) return '';
  return `<h4 style="margin:14px 0 6px;font-size:13px;color:${color||'var(--navy)'};">Workshop \u2014 Audit Results</h4><table class="excel-table">${excelTableHead(color)}<tbody>${rows}</tbody></table>`;
}

function buildAdminHtml(brandFilter){
  const r = state.report;
  const ctx = contextsFor(r, brandFilter ? [brandFilter] : null);
  const checklist = state.adminChecklist || {categories:[]};
  let html = `<h3 style="margin:18px 0 10px;border-bottom:2px solid var(--brass);padding-bottom:6px;">Admin \u2014 Document Checklist</h3>`;
  html += `<div class="note" style="margin-bottom:10px;">Completed by: ${escapeHtml(r.adminCompletedBy||'-')}</div>`;
  checklist.categories.forEach(cat=>{
    const items = cat.items.filter(it=>appliesToReport(it, ctx));
    if(!items.length) return;
    html += `<div class="section-title" style="margin-top:10px;">${escapeHtml(cat.title)}</div><div class="subsection">`;
    items.forEach((item,i)=>{
      const ans = r.adminAnswers[item.id] || {};
      const status = effectiveAdminStatus(item, ans);
      html += `<div class="q-row"><div class="q-num">${i+1}</div><div class="q-body">
        <div class="q-text">${escapeHtml(item.description)}</div>
        <div>${statusBadge(status, status===item.autoAnswer)} ${ans.expiry?('<span class="note">Expiry: '+escapeHtml(ans.expiry)+'</span>'):''} ${(ans.rangeStart||ans.rangeEnd)?('<span class="note">Forecast: '+escapeHtml(ans.rangeStart||'?')+' to '+escapeHtml(ans.rangeEnd||'?')+'</span>'):''}</div>
        ${ans.comments?`<div class="note" style="margin-top:5px;">${escapeHtml(ans.comments)}</div>`:''}
      </div></div>`;
    });
    html += `</div>`;
  });
  return html;
}

function buildWorkshopHtml(brandFilter){
  const r = state.report;
  const ctx = contextsFor(r, brandFilter ? [brandFilter] : null);
  const ws = state.workshopStructure || {sections:[]};
  let html = `<h3 style="margin:18px 0 10px;border-bottom:2px solid var(--brass);padding-bottom:6px;">Workshop \u2014 Audit Results</h3>`;
  ws.sections.forEach(sec=>{
    const subs = sec.subsections.map(sub=>({...sub, questions: sub.questions.filter(q=>appliesToReport(q, ctx))})).filter(sub=>sub.questions.length);
    if(!subs.length) return;
    html += `<div class="section-title" style="margin-top:10px;">${escapeHtml(sec.title)}</div>`;
    subs.forEach(sub=>{
      html += `<div class="subsection"><div class="subsection-title">${escapeHtml(sub.title)}</div>`;
      sub.questions.forEach((q,i)=>{
        const cm = r.comments[q.id] || '';
        html += `<div class="q-row"><div class="q-num">${i+1}</div><div class="q-body">
          <div class="q-text">${escapeHtml(q.text)}</div>
          <div>${statusBadge(r.answers[q.id])}</div>
          ${cm ? `<div class="note" style="margin-top:5px;">Comment: ${escapeHtml(cm)}</div>` : ''}
        </div></div>`;
      });
      html += `</div>`;
    });
  });
  return html;
}

function buildSignPairHtml(rep, wit){
  return `<div class="info-grid" style="margin-top:12px;margin-bottom:6px;">
    <div><span>Representative: </span>${escapeHtml(rep.name||'-')} ${rep.date?'('+escapeHtml(rep.date)+')':''}</div>
    <div><span>Witness: </span>${escapeHtml(wit.name||'-')} ${wit.date?'('+escapeHtml(wit.date)+')':''}</div>
    <div>${rep.sig?`<img src="${rep.sig}" style="height:50px;">`:'<span class="note">No signature captured</span>'}</div>
    <div>${wit.sig?`<img src="${wit.sig}" style="height:50px;">`:'<span class="note">No signature captured</span>'}</div>
  </div>`;
}
function buildSingleSignHtml(person, label){
  return `<div class="info-grid" style="margin-top:10px;">
    <div><span>${label}: </span>${escapeHtml(person.name||'-')} ${person.date?'('+escapeHtml(person.date)+')':''}</div>
    <div>${person.sig?`<img src="${person.sig}" style="height:50px;">`:'<span class="note">No signature captured</span>'}</div>
  </div>`;
}

function buildTrademarksHtml(){
  const r = state.report;
  let html = `<h3 style="margin:18px 0 10px;border-bottom:2px solid var(--brass);padding-bottom:6px;">Trademark Infringement</h3><div class="subsection">`;
  state.brands.forEach((b,i)=>{
    html += `<div class="q-row"><div class="q-num">${i+1}</div><div class="q-body"><div class="q-text">${escapeHtml(b.name)}</div><div>${statusBadge(r.trademarks.brandStatus[b.id])}</div></div></div>`;
  });
  html += `</div>`;
  if(r.trademarks.comments) html += `<div class="note" style="margin:8px 0;">Comments: ${escapeHtml(r.trademarks.comments)}</div>`;
  html += `<p style="font-size:12.5px;margin:10px 0;">${r.trademarks.acknowledged?'\u2611':'\u2610'} The body shop acknowledges the existence of trademark infringements and has been made aware of the issue.</p>`;
  html += buildSignPairHtml(r.trademarks.rep, r.trademarks.witness);
  return html;
}

function buildNonComplianceHtml(brandFilter){
  const r = state.report;
  const findings = collectFindings(r, brandFilter ? [brandFilter] : r.selectedBrands);
  let html = `<h3 style="margin:18px 0 10px;border-bottom:2px solid var(--brass);padding-bottom:6px;">Non-Compliance Report${brandFilter?(' \u2014 '+escapeHtml((state.brands.find(x=>x.id===brandFilter)||{}).name||'')):' \u2014 All Brands'}</h3>`;
  html += `<div class="subsection">`;
  if(findings.length){
    findings.forEach((f,i)=>{
      const note = r.ncNotes[f.key] || {};
      const headline = f.wording || f.text || f.answer;
      html += `<div class="q-row"><div class="q-num">${i+1}</div><div class="q-body">
        <div class="q-text"><span class="badge badge-brass" style="margin-right:6px;">${f.source}</span>${escapeHtml(headline)}</div>
        ${(!f.isManual && f.text && f.wording) ? `<div class="note" style="margin-top:2px;">Question: ${escapeHtml(f.text)}</div>` : ''}
        <div style="margin-top:4px;">${statusBadge(f.answer, true)} <span class="badge badge-neutral" style="margin-left:6px;">${escapeHtml(f.status)}</span></div>
        ${f.comment?`<div class="note" style="margin-top:4px;">${escapeHtml(f.comment)}</div>`:''}
        ${(note.action||f.action)?`<div class="note" style="margin-top:4px;">Corrective action: ${escapeHtml(note.action||f.action||'')}${(note.responsible||f.responsible)?(' \u2014 '+escapeHtml(note.responsible||f.responsible)):''}${(note.dueDate||f.dueDate)?(' \u2014 due '+escapeHtml(note.dueDate||f.dueDate)):''}</div>`:''}
      </div></div>`;
    });
  }else{
    html += `<div class="q-row"><div class="q-body"><div class="note">No non-compliant items recorded.</div></div></div>`;
  }
  html += `</div>`;
  return html;
}

function buildSignoffHtml(){
  const r = state.report;
  const so = r.signoff;
  const findingCount = collectFindings(r).length;
  let html = `<h3 style="margin:18px 0 10px;border-bottom:2px solid var(--brass);padding-bottom:6px;">Audit Sign-off Sheet</h3>`;

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Section A \u2014 Permission to proceed</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body"><div class="q-text">Status: ${escapeHtml(so.sectionA.granted||'Not recorded')}</div>${buildSignPairHtml(so.sectionA.rep, so.sectionA.witness)}</div></div></div>`;

  if(so.sectionA.granted==='Declined'){
    html += `<div class="subsection-title" style="border:1px solid var(--line);">Section B \u2014 Audit declined</div>`;
    html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body"><div class="q-text">Reason: ${escapeHtml(so.sectionB.reason||'-')}</div>${buildSignPairHtml(so.sectionB.rep, so.sectionB.witness)}</div></div></div>`;
  }

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Section C \u2014 Duration</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body"><div class="q-text">Arrived ${escapeHtml(so.sectionC.timeArrived||'-')} \u00b7 Commenced ${escapeHtml(so.sectionC.timeCommenced||'-')} \u00b7 Completed ${escapeHtml(so.sectionC.timeCompleted||'-')}</div>${buildSingleSignHtml(so.sectionC.witness,'Witness')}</div></div></div>`;

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Section D \u2014 Report accuracy</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body"><div class="q-text">${so.sectionD.option==='accept'?'Accepted as accurate and correct':(so.sectionD.option==='reject'?'Not accepted: '+escapeHtml(so.sectionD.details||''):'Not recorded')}</div></div></div></div>`;

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Section E \u2014 Document verification consent</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body"><div class="q-text">${so.sectionE.option==='consent'?'Consent given':(so.sectionE.option==='object'?'Objected: '+escapeHtml(so.sectionE.details||''):'Not recorded')}</div></div></div></div>`;

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Audit Result</div>`;
  html += `<div class="subsection" style="border-top:none;">`;
  r.selectedBrands.forEach((bid,i)=>{
    const b = state.brands.find(x=>x.id===bid);
    const stats = brandStats(r, bid);
    html += `<div class="q-row"><div class="q-num">${i+1}</div><div class="q-body">
      <div class="q-text">${escapeHtml(b?b.name:bid)} \u2014 <span style="color:${stats.failed?'#B3261E':'#2F7D52'};font-weight:800;">${stats.failed?'FAIL':'PASS'}</span></div>
      ${stats.failed?`<div class="note" style="margin-top:4px;">Critical: ${stats.criticalFails.map(cf=>escapeHtml(cf.text)).join('; ')}</div>`:''}
    </div></div>`;
  });
  html += `</div>`;

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Section F \u2014 Non-compliances found</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body"><div class="q-text">${findingCount} item${findingCount===1?'':'s'} recorded \u2014 see the full Non-Compliance Report.</div></div></div></div>`;

  html += `<div class="subsection-title" style="border:1px solid var(--line);">Section H \u2014 Final sign-off</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body">${buildSignPairHtml(so.sectionH.rep, so.sectionH.witness)}</div></div></div>`;

  return html;
}

function buildBrandReportHtml(bid){
  const r = state.report;
  const stats = brandStats(r, bid);
  const so = ensureBrandSignoff(r, bid);
  const color = brandColor(bid);
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">
    <p class="note" style="margin:0;">${stats.done}/${stats.total} items answered \u00b7 ${stats.compliant} compliant \u00b7 ${stats.nonCompliant} non-compliant</p>
    <span style="background:${stats.failed?'#B3261E':'#2F7D52'};color:#fff;font-weight:800;font-size:12px;letter-spacing:.04em;padding:5px 14px;border-radius:99px;">${stats.failed?'FAIL':'PASS'}</span>
  </div>`;
  if(stats.failed){
    html += `<div style="background:#FBEAE8;border:1px solid #E7B9B4;color:#B3261E;border-radius:6px;padding:10px 12px;font-size:12.5px;margin-bottom:12px;"><strong>Fails the audit</strong> \u2014 ${stats.criticalFails.length} critical item${stats.criticalFails.length===1?'':'s'} non-compliant: ${stats.criticalFails.map(cf=>escapeHtml(cf.text)).join('; ')}</div>`;
  }
  html += buildAdminTableHtml(bid);
  html += buildWorkshopTableHtml(bid);
  html += buildNonComplianceHtml(bid);
  html += `<div class="subsection-title" style="border:1px solid var(--line);">Report acceptance</div>`;
  html += `<div class="subsection" style="border-top:none;"><div class="q-row"><div class="q-body">
    <div class="q-text">${so.option==='accept'?'Accepted as accurate and correct':(so.option==='reject'?'Not accepted: '+escapeHtml(so.details||''):'Not recorded')}</div>
    ${buildSingleSignHtml(so.rep, 'Dealer representative')}
  </div></div></div>`;
  return html;
}

function buildPrintHtml(pageSpec){
  const r = state.report;
  const brandLetterheadFor = (pageSpec && pageSpec.id && (pageSpec.type==='brandreport' || pageSpec.type==='noncompliance')) ? pageSpec.id : null;
  let html = `<div class="print-surface">` + (brandLetterheadFor ? buildBrandLetterheadHtml(brandLetterheadFor) : buildInfoHeaderHtml());
  if(!pageSpec){
    html += buildAdminHtml();
    html += buildWorkshopHtml();
    html += buildTrademarksHtml();
    html += buildNonComplianceHtml();
    html += buildSignoffHtml();
  } else if(pageSpec.type==='brandreport'){
    html += buildBrandReportHtml(pageSpec.id);
  } else if(pageSpec.type==='admin'){
    html += buildAdminHtml();
  } else if(pageSpec.type==='workshop'){
    html += buildWorkshopHtml();
  } else if(pageSpec.type==='trademarks'){
    html += buildTrademarksHtml();
  } else if(pageSpec.type==='noncompliance'){
    html += buildNonComplianceHtml(pageSpec.id||null);
  } else if(pageSpec.type==='signoff'){
    html += buildSignoffHtml();
  }
  html += `</div>`;
  return html;
}

async function exportPdf(pageSpec){
  toast('Preparing PDF\u2026');
  await loadWorkshopData();
  const zone = document.getElementById('pdf-render-zone');
  zone.innerHTML = buildPrintHtml(pageSpec);

  await new Promise(res=>setTimeout(res, 60));
  const canvas = await html2canvas(zone, {scale:2, backgroundColor:'#ffffff', windowWidth:800});

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p','pt','a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW;
  const imgH = canvas.height * imgW / canvas.width;
  let heightLeft = imgH;
  let position = 0;
  const imgData = canvas.toDataURL('image/jpeg', 0.92);

  pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
  heightLeft -= pageH;
  while(heightLeft > 0){
    position = heightLeft - imgH;
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
    heightLeft -= pageH;
  }

  const company = fileSafe(state.report.info.tradingName);
  let brandPart = 'Full_Report';
  if(pageSpec){
    if(pageSpec.type==='brandreport') brandPart = fileSafe((state.brands.find(x=>x.id===pageSpec.id)||{}).name) + '_Report';
    else if(pageSpec.type==='admin') brandPart = 'Admin_Checklist';
    else if(pageSpec.type==='workshop') brandPart = 'Workshop';
    else if(pageSpec.type==='trademarks') brandPart = 'Trademarks';
    else if(pageSpec.type==='noncompliance') brandPart = pageSpec.id ? (fileSafe((state.brands.find(x=>x.id===pageSpec.id)||{}).name)+'_Non_Compliance') : 'Non_Compliance_Report';
    else if(pageSpec.type==='signoff') brandPart = 'Signoff_Sheet';
  }
  pdf.save(`${company}_${brandPart}.pdf`);
  toast('PDF downloaded');
}

/* =========================================================
   OWNER SETUP — PIN-gated: brands, workshop questions & admin checklist
========================================================= */
async function renderOwnerSetup(){
  const pinHash = await sGet('meta:owner-pin-hash');
  setTopbar('Owner Setup', 'Brands, the workshop question bank and the admin checklist — restricted to whoever holds the owner PIN.',
    state.ownerUnlocked ? `<button class="btn btn-sm" id="lock-btn">${ICONS.lock} Lock</button>` : '');
  if(document.getElementById('lock-btn')){
    document.getElementById('lock-btn').addEventListener('click', ()=>{ state.ownerUnlocked=false; render(); });
  }

  const c = document.getElementById('content');
  if(!state.ownerUnlocked){
    c.innerHTML = pinHash ? renderPinEntryHtml() : renderPinSetupHtml();
    wireOwnerGate(pinHash);
    return;
  }

  state.brands = (await sGet('brands')) || [];
  c.innerHTML = `
      <div class="tab ${state.ownerTab==='brands'?'active':''}" data-otab="brands">Brands</div>
      <div class="tab ${state.ownerTab==='workshop'?'active':''}" data-otab="workshop">Workshop Questions</div>
      <div class="tab ${state.ownerTab==='checklist'?'active':''}" data-otab="checklist">Admin Checklist</div>
    </div>
    <div id="owner-body"></div>
  `;
  if(!['brands','workshop','checklist'].includes(state.ownerTab)) state.ownerTab='brands';
  c.querySelectorAll('[data-otab]').forEach(t=>t.addEventListener('click', ()=>{ state.ownerTab=t.dataset.otab; renderOwnerSetup(); }));
  const body = document.getElementById('owner-body');
  if(state.ownerTab==='workshop') renderWorkshopEditor(body);
  else if(state.ownerTab==='checklist') renderChecklistEditor(body);
  else renderBrandsEditor(body);
}

function renderPinSetupHtml(){
  return `<div class="card card-pad" style="max-width:420px;">
    <h3 style="margin-bottom:6px;">Set an owner PIN</h3>
    <p class="note" style="margin-bottom:12px;">No owner PIN has been set yet. Choose one now — from then on, only people who know it can add, edit or remove brands, workshop questions or the admin checklist.</p>
    <div class="field"><label>New PIN</label><input type="password" id="pin-new" inputmode="numeric"></div>
    <div class="field"><label>Confirm PIN</label><input type="password" id="pin-confirm" inputmode="numeric"></div>
    <button class="btn btn-primary" id="pin-set-btn">Set PIN &amp; continue</button>
    <p class="note" style="margin-top:10px;">This is a lightweight deterrent suitable for a small trusted team, not real security — anyone using browser dev tools could bypass it. Treat it as a "please don't touch" gate, not a lock. A proper backend with real logins is the right upgrade before this matters for real access control.</p>
  </div>`;
}
function renderPinEntryHtml(){
  return `<div class="card card-pad" style="max-width:360px;">
    <h3 style="margin-bottom:6px;">Owner PIN required</h3>
    <p class="note" style="margin-bottom:12px;">Enter the owner PIN to edit brands, workshop questions or the admin checklist.</p>
    <div class="field"><input type="password" id="pin-entry" inputmode="numeric" placeholder="PIN"></div>
    <button class="btn btn-primary" id="pin-entry-btn">Unlock</button>
    <p class="note" id="pin-error" style="color:var(--bad);margin-top:8px;"></p>
  </div>`;
}
function wireOwnerGate(pinHash){
  if(!pinHash){
    document.getElementById('pin-set-btn').addEventListener('click', async ()=>{
      const a = document.getElementById('pin-new').value;
      const b = document.getElementById('pin-confirm').value;
      if(a.length<4){ toast('Use at least 4 characters'); return; }
      if(a!==b){ toast('PINs do not match'); return; }
      const hash = await sha256(a);
      await sSet('meta:owner-pin-hash', hash);
      state.ownerUnlocked = true;
      toast('Owner PIN set');
      renderOwnerSetup();
    });
  } else {
    document.getElementById('pin-entry-btn').addEventListener('click', async ()=>{
      const val = document.getElementById('pin-entry').value;
      const hash = await sha256(val);
      if(hash===pinHash){ state.ownerUnlocked=true; renderOwnerSetup(); }
      else{ document.getElementById('pin-error').textContent = 'Incorrect PIN.'; }
    });
    document.getElementById('pin-entry').addEventListener('keydown', (e)=>{ if(e.key==='Enter') document.getElementById('pin-entry-btn').click(); });
  }
}

/* ---------- Brands list (add / delete only — questions live in Workshop/Checklist editors) ---------- */
function renderBrandsEditor(el){
  el.innerHTML = `
    <div class="card card-pad">
      <h3 style="margin-bottom:10px;">Brands</h3>
      <p class="note" style="margin-bottom:12px;">Add a brand here, then go tag any brand-specific questions or checklist items to it from the Workshop Questions / Admin Checklist tabs. Set each brand's own accent colour and logo so its generated Brand Report looks like that manufacturer's document, not a generic one. Deleting a brand just removes its tags — shared/generic questions are unaffected.</p>
      <div class="admin-brand-list" id="admin-brand-list"></div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
        <input type="text" id="new-brand-name" placeholder="New brand name, e.g. Honda Motor Southern Africa" style="flex:1;min-width:220px;padding:9px 11px;border:1px solid var(--line);border-radius:5px;">
        <button class="btn btn-primary" id="add-brand-btn">${ICONS.plus} Add brand</button>
      </div>
    </div>
  `;
  renderAdminBrandList();
  document.getElementById('add-brand-btn').addEventListener('click', addBrand);
  document.getElementById('new-brand-name').addEventListener('keydown', (e)=>{ if(e.key==='Enter') addBrand(); });
}

function renderAdminBrandList(){
  const list = document.getElementById('admin-brand-list');
  if(!state.brands.length){ list.innerHTML = `<p class="note">No brands yet — add your first one below.</p>`; return; }
  list.innerHTML = state.brands.map(b=>`
    <div class="admin-brand-row" style="align-items:flex-start;flex-wrap:wrap;">
      <div style="width:34px;height:34px;border-radius:6px;flex-shrink:0;overflow:hidden;background:${escapeAttr(b.color||'#16233D')};display:flex;align-items:center;justify-content:center;">
        ${b.logo ? `<img src="${b.logo}" style="width:100%;height:100%;object-fit:cover;">` : ''}
      </div>
      <input type="text" value="${escapeAttr(b.name)}" data-brand-name="${b.id}" style="flex:1;min-width:160px;border:1px solid var(--line);border-radius:5px;padding:6px 9px;font-weight:600;font-size:13.5px;">
      <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ink-soft);">
        Colour <input type="color" data-brand-color="${b.id}" value="${escapeAttr(b.color||'#16233D')}" style="width:34px;height:28px;border:1px solid var(--line);border-radius:4px;padding:0;">
      </label>
      <button class="btn btn-sm" data-brand-logo-btn="${b.id}">${ICONS.photo} Logo</button>
      <input type="file" accept="image/*" data-brand-logo-input="${b.id}" style="display:none;">
      ${b.logo ? `<button class="btn btn-sm btn-danger" data-brand-logo-clear="${b.id}">Remove logo</button>` : ''}
      <button class="btn btn-sm btn-danger" data-del-brand="${b.id}">${ICONS.trash}</button>
    </div>`).join('');

  list.querySelectorAll('[data-brand-name]').forEach(inp=>inp.addEventListener('input', async ()=>{
    const b = state.brands.find(x=>x.id===inp.dataset.brandName); b.name = inp.value; await sSet('brands', state.brands);
  }));
  list.querySelectorAll('[data-brand-color]').forEach(inp=>inp.addEventListener('input', async ()=>{
    const b = state.brands.find(x=>x.id===inp.dataset.brandColor); b.color = inp.value; await sSet('brands', state.brands);
    renderAdminBrandList();
  }));
  list.querySelectorAll('[data-brand-logo-btn]').forEach(btn=>btn.addEventListener('click', ()=>{
    list.querySelector(`[data-brand-logo-input="${btn.dataset.brandLogoBtn}"]`).click();
  }));
  list.querySelectorAll('[data-brand-logo-input]').forEach(inp=>inp.addEventListener('change', async ()=>{
    const file = inp.files[0]; if(!file) return;
    try{
      const dataUrl = await compressImage(file, 400, 0.85);
      const b = state.brands.find(x=>x.id===inp.dataset.brandLogoInput);
      b.logo = dataUrl;
      await sSet('brands', state.brands);
      renderAdminBrandList();
      toast('Logo updated');
    }catch(e){ toast('Could not read that image'); }
  }));
  list.querySelectorAll('[data-brand-logo-clear]').forEach(btn=>btn.addEventListener('click', async ()=>{
    const b = state.brands.find(x=>x.id===btn.dataset.brandLogoClear); b.logo=''; await sSet('brands', state.brands);
    renderAdminBrandList();
  }));
  list.querySelectorAll('[data-del-brand]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Delete this brand? It will be untagged from any workshop questions or admin checklist items, and removed as an audit option on reports (their saved answers are kept).')) return;
    const id = b.dataset.delBrand;
    state.brands = state.brands.filter(x=>x.id!==id);
    await sSet('brands', state.brands);
    const ws = await sGet('workshop-structure') || {sections:[]};
    ws.sections.forEach(sec=>sec.subsections.forEach(sub=>sub.questions.forEach(q=>{ q.brands = (q.brands||[]).filter(x=>x!==id); })));
    await sSet('workshop-structure', ws);
    const checklist = await sGet('admin-checklist') || {categories:[]};
    checklist.categories.forEach(cat=>cat.items.forEach(it=>{ it.brands = (it.brands||[]).filter(x=>x!==id); }));
    await sSet('admin-checklist', checklist);
    renderAdminBrandList();
    toast('Brand deleted');
  }));
}

const BRAND_COLOR_PALETTE = ['#16233D','#8A0303','#00558C','#1F6F3F','#7A3B12','#5B3A8E','#0E7C7B','#A8791E'];
async function addBrand(){
  const input = document.getElementById('new-brand-name');
  const name = input.value.trim();
  if(!name) return;
  const color = BRAND_COLOR_PALETTE[state.brands.length % BRAND_COLOR_PALETTE.length];
  const brand = {id:uid(), name, color, logo:''};
  state.brands.push(brand);
  await sSet('brands', state.brands);
  input.value='';
  renderAdminBrandList();
  toast('Brand added \u2014 set its real colour/logo above when ready');
}

/* ---------- Brand-tag chip row (shared by Workshop & Checklist editors) ---------- */
function brandTagRowHtml(itemId, selectedIds){
  if(!state.brands.length) return '';
  return `<div class="tag-row" data-tagrow="${itemId}">
    ${!selectedIds || !selectedIds.length ? `<span class="tagchip all">All brands</span>` : ''}
    ${state.brands.map(b=>`<span class="tagchip ${selectedIds&&selectedIds.includes(b.id)?'on':''}" data-tagitem="${itemId}" data-tagbrand="${b.id}">${escapeHtml(b.name)}</span>`).join('')}
  </div>`;
}
function wireBrandTagRow(container, getArrayFn, onChangeFn){
  container.querySelectorAll('[data-tagitem]').forEach(chip=>{
    chip.addEventListener('click', async ()=>{
      const arr = getArrayFn(chip.dataset.tagitem);
      if(!arr) return;
      const bid = chip.dataset.tagbrand;
      const idx = arr.indexOf(bid);
      if(idx===-1) arr.push(bid); else arr.splice(idx,1);
      await onChangeFn();
    });
  });
}

// Initial and Renewal audits genuinely have different questions in the
// source workbook, so questions/items can also be tagged to specific audit
// types the same way they're tagged to brands — untagged = shown for every
// audit type, on any brand.
function auditTypeTagRowHtml(itemId, selectedTypes){
  return `<div class="tag-row" data-attagrow="${itemId}" style="margin-top:4px;">
    ${!selectedTypes || !selectedTypes.length ? `<span class="tagchip all">All audit types</span>` : ''}
    ${AUDIT_TYPE_OPTIONS.map(t=>`<span class="tagchip ${selectedTypes&&selectedTypes.includes(t)?'on':''}" data-atitem="${itemId}" data-atval="${escapeAttr(t)}">${escapeHtml(t)}</span>`).join('')}
  </div>`;
}
function wireAuditTypeTagRow(container, getArrayFn, onChangeFn){
  container.querySelectorAll('[data-atitem]').forEach(chip=>{
    chip.addEventListener('click', async ()=>{
      const arr = getArrayFn(chip.dataset.atitem);
      if(!arr) return;
      const val = chip.dataset.atval;
      const idx = arr.indexOf(val);
      if(idx===-1) arr.push(val); else arr.splice(idx,1);
      await onChangeFn();
    });
  });
}

/* ---------- Non-compliance wording panel (shared by Workshop & Checklist editors) ---------- */
// Lets the owner define the exact sentence used in the Non-Compliance report
// for each "bad" option a question/item can be answered with, instead of the
// findings just showing the raw dropdown value (e.g. "Not Compliant").
function ncWordingPanelHtml(itemId, options, ncWording){
  const badOptions = (options||[]).filter(o=>BAD_VALUES.includes(o));
  if(!badOptions.length) return '';
  const wording = ncWording || {};
  const hasAny = badOptions.some(o=>wording[o]);
  return `<div class="ncw-panel" data-ncw-panel="${itemId}">
    <button type="button" class="btn btn-sm" data-ncw-toggle="${itemId}" style="margin-top:6px;">${hasAny?'\u270e':''} Non-compliance wording${hasAny?'':' (not set)'}</button>
    <div class="ncw-body" data-ncw-body="${itemId}" style="display:none;margin-top:8px;">
      ${badOptions.map(o=>`
        <div class="field" style="margin-bottom:8px;">
          <label>When answered "${escapeHtml(o)}"</label>
          <input type="text" data-ncw-item="${itemId}" data-ncw-option="${escapeAttr(o)}" value="${escapeAttr(wording[o]||'')}" placeholder="Specific sentence shown on the Non-Compliance report">
        </div>
      `).join('')}
    </div>
  </div>`;
}
function wireNcWordingPanel(container, getItemFn, onChangeFn){
  container.querySelectorAll('[data-ncw-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const body = container.querySelector(`[data-ncw-body="${btn.dataset.ncwToggle}"]`);
      if(body) body.style.display = body.style.display==='none' ? 'block' : 'none';
    });
  });
  container.querySelectorAll('[data-ncw-item]').forEach(inp=>{
    inp.addEventListener('input', async ()=>{
      const item = getItemFn(inp.dataset.ncwItem);
      if(!item) return;
      item.ncWording = item.ncWording || {};
      item.ncWording[inp.dataset.ncwOption] = inp.value;
      await onChangeFn();
    });
  });
}

/* ---------- Workshop Questions editor (single generalized bank) ---------- */
async function renderWorkshopEditor(el){
  const st = (await sGet('workshop-structure')) || {sections:[]};
  state.workshopStructure = st;
  el.innerHTML = `
    <div class="card card-pad">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
        <h3>Workshop questions</h3>
        <button class="btn btn-brass btn-sm" id="add-ws-section-btn">${ICONS.plus} Add section</button>
      </div>
      <p class="note" style="margin-bottom:12px;">Click a brand chip under a question to tag it to specific brand(s), and an audit-type chip to tag it to Initial and/or Renewal (etc.) — a question only appears on a report if it matches both. No chips selected on either row = shown for every brand/type.</p>
      <div id="ws-tree"></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:18px 0;">
      <h4 style="margin-bottom:6px;font-size:13.5px;">Bulk import questions from CSV</h4>
      <p class="note" style="margin-bottom:8px;">Format: <code>Section,Subsection,Question,Options,Brands,Audit Types,Critical</code> (Options/Brands/Audit Types each separated by | ; Brands, Audit Types and Critical columns are optional — Critical is Yes/No, leave blank for No).</p>
      <textarea class="csv" id="ws-csv-input" placeholder="Section A - Customer Experience,Corporate Identity,Is signage current?,Compliant|Not Compliant|N/a,BYD South Africa,Initial|Renewal,No"></textarea>
      <button class="btn" id="ws-csv-import-btn" style="margin-top:8px;">Import CSV rows</button>
    </div>
  `;
  renderWsTree(st);
  document.getElementById('add-ws-section-btn').addEventListener('click', async ()=>{
    st.sections.push({id:uid(), title:'New Section', subsections:[]});
    await sSet('workshop-structure', st);
    renderWsTree(st);
  });
  document.getElementById('ws-csv-import-btn').addEventListener('click', ()=>importWorkshopCsv(st));
}

function renderWsTree(st){
  const tree = document.getElementById('ws-tree');
  if(!st.sections.length){ tree.innerHTML = `<p class="note">No sections yet. Add one above, or bulk import a CSV below.</p>`; return; }
  tree.innerHTML = st.sections.map(sec=>`
    <div class="tree-section" data-sec="${sec.id}">
      <div class="tree-head">
        <input type="text" value="${escapeAttr(sec.title)}" data-sec-title="${sec.id}">
        <button class="icon-btn" data-add-sub="${sec.id}" title="Add subsection">${ICONS.plus}</button>
        <button class="icon-btn danger" data-del-sec="${sec.id}" title="Delete section">${ICONS.trash}</button>
      </div>
      ${sec.subsections.map(sub=>`
        <div class="tree-sub" data-sub="${sub.id}">
          <div class="tree-sub-head">
            <input type="text" value="${escapeAttr(sub.title)}" data-sub-title="${sub.id}">
            <button class="icon-btn" data-add-q="${sub.id}" title="Add question">${ICONS.plus}</button>
            <button class="icon-btn danger" data-del-sub="${sub.id}" title="Delete subsection">${ICONS.trash}</button>
          </div>
          ${sub.questions.map(q=>`
            <div class="tree-q" data-q="${q.id}" style="${q.critical?'border-color:var(--bad);':''}">
              <div class="tree-q-row">
                <input type="text" value="${escapeAttr(q.text)}" data-q-text="${q.id}" placeholder="Question text">
                <input type="text" class="opts" value="${escapeAttr(q.options.join('|'))}" data-q-opts="${q.id}" placeholder="Options separated by |" style="max-width:220px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--bad);font-weight:700;white-space:nowrap;" title="Non-compliance on this question fails the audit">
                  <input type="checkbox" data-q-critical="${q.id}" ${q.critical?'checked':''}> Critical
                </label>
                <button class="icon-btn danger" data-del-q="${q.id}" title="Delete question">${ICONS.trash}</button>
              </div>
              ${brandTagRowHtml(q.id, q.brands)}
              ${auditTypeTagRowHtml(q.id, q.auditTypes)}
              ${ncWordingPanelHtml(q.id, q.options, q.ncWording)}
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `).join('');

  const st_ = st;
  function findSec(id){ return st_.sections.find(s=>s.id===id); }
  function findSub(id){ for(const s of st_.sections){ const sub=s.subsections.find(x=>x.id===id); if(sub) return sub; } return null; }
  function findQ(id){ for(const s of st_.sections) for(const sub of s.subsections){ const q = sub.questions.find(x=>x.id===id); if(q) return q; } return null; }
  function findQContainer(id){ for(const s of st_.sections) for(const sub of s.subsections){ if(sub.questions.find(q=>q.id===id)) return sub; } return null; }

  async function persist(){ await sSet('workshop-structure', st_); }

  tree.querySelectorAll('[data-sec-title]').forEach(inp=>inp.addEventListener('input', async ()=>{ findSec(inp.dataset.secTitle).title = inp.value; await persist(); }));
  tree.querySelectorAll('[data-sub-title]').forEach(inp=>inp.addEventListener('input', async ()=>{ findSub(inp.dataset.subTitle).title = inp.value; await persist(); }));
  tree.querySelectorAll('[data-q-text]').forEach(inp=>inp.addEventListener('input', async ()=>{
    findQ(inp.dataset.qText).text = inp.value; await persist();
  }));
  tree.querySelectorAll('[data-q-opts]').forEach(inp=>inp.addEventListener('input', async ()=>{
    findQ(inp.dataset.qOpts).options = inp.value.split('|').map(s=>s.trim()).filter(Boolean); await persist();
  }));
  tree.querySelectorAll('[data-q-critical]').forEach(cb=>cb.addEventListener('change', async ()=>{
    findQ(cb.dataset.qCritical).critical = cb.checked; await persist(); renderWsTree(st_);
  }));
  tree.querySelectorAll('[data-add-sub]').forEach(b=>b.addEventListener('click', async ()=>{
    findSec(b.dataset.addSub).subsections.push({id:uid(), title:'New Subsection', questions:[]});
    await persist(); renderWsTree(st_);
  }));
  tree.querySelectorAll('[data-add-q]').forEach(b=>b.addEventListener('click', async ()=>{
    findSub(b.dataset.addQ).questions.push({id:uid(), text:'New question', options:OPTION_SETS.compliance.slice(), comment:true, brands:[], auditTypes:[], critical:false});
    await persist(); renderWsTree(st_);
  }));
  tree.querySelectorAll('[data-del-sec]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Delete this whole section?')) return;
    st_.sections = st_.sections.filter(s=>s.id!==b.dataset.delSec); await persist(); renderWsTree(st_);
  }));
  tree.querySelectorAll('[data-del-sub]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Delete this subsection and its questions?')) return;
    for(const s of st_.sections){ s.subsections = s.subsections.filter(x=>x.id!==b.dataset.delSub); }
    await persist(); renderWsTree(st_);
  }));
  tree.querySelectorAll('[data-del-q]').forEach(b=>b.addEventListener('click', async ()=>{
    for(const s of st_.sections) for(const sub of s.subsections){ sub.questions = sub.questions.filter(q=>q.id!==b.dataset.delQ); }
    await persist(); renderWsTree(st_);
  }));
  wireBrandTagRow(tree, (qid)=>{ const q=findQ(qid); if(q){ q.brands = q.brands||[]; } return q?q.brands:null; }, async ()=>{ await persist(); renderWsTree(st_); });
  wireAuditTypeTagRow(tree, (qid)=>{ const q=findQ(qid); if(q){ q.auditTypes = q.auditTypes||[]; } return q?q.auditTypes:null; }, async ()=>{ await persist(); renderWsTree(st_); });
  wireNcWordingPanel(tree, (qid)=>findQ(qid), persist);
}

async function importWorkshopCsv(st){
  const raw = document.getElementById('ws-csv-input').value.trim();
  if(!raw){ toast('Paste some CSV rows first'); return; }
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);
  let added = 0;
  lines.forEach(line=>{
    const parts = splitCsvLine(line);
    if(parts.length < 3) return;
    const [secTitle, subTitle, qText, optsRaw, brandsRaw, typesRaw, criticalRaw] = parts;
    let sec = st.sections.find(s=>s.title.toLowerCase()===secTitle.toLowerCase());
    if(!sec){ sec = {id:uid(), title:secTitle, subsections:[]}; st.sections.push(sec); }
    let sub = sec.subsections.find(s=>s.title.toLowerCase()===(subTitle||'').toLowerCase());
    if(!sub){ sub = {id:uid(), title:subTitle||'General', questions:[]}; sec.subsections.push(sub); }
    const options = (optsRaw||'').split('|').map(s=>s.trim()).filter(Boolean);
    const brandNames = (brandsRaw||'').split('|').map(s=>s.trim()).filter(Boolean);
    const brandIds = brandNames.map(n=>{ const b = state.brands.find(x=>x.name.toLowerCase()===n.toLowerCase()); return b?b.id:null; }).filter(Boolean);
    const auditTypes = (typesRaw||'').split('|').map(s=>s.trim()).filter(Boolean)
      .map(t=>AUDIT_TYPE_OPTIONS.find(o=>o.toLowerCase()===t.toLowerCase()) || (AUDIT_TYPE_OPTIONS.find(o=>o.toLowerCase().startsWith(t.toLowerCase())))).filter(Boolean);
    const critical = /^(y|yes|true|1)$/i.test((criticalRaw||'').trim());
    sub.questions.push({id:uid(), text:qText, options: options.length?options:OPTION_SETS.compliance.slice(), comment:true, brands:brandIds, auditTypes, critical});
    added++;
  });
  await sSet('workshop-structure', st);
  document.getElementById('ws-csv-input').value='';
  renderWsTree(st);
  toast(`Imported ${added} question${added===1?'':'s'}`);
}
function splitCsvLine(line){
  // simple CSV split that respects quoted commas
  const out=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ inQ=!inQ; continue; }
    if(ch===',' && !inQ){ out.push(cur); cur=''; continue; }
    cur+=ch;
  }
  out.push(cur);
  return out.map(s=>s.trim());
}

/* ---------- Admin checklist editor (single generalized bank) ---------- */
async function renderChecklistEditor(el){
  const checklist = (await sGet('admin-checklist')) || {categories:[]};
  state.adminChecklist = checklist;
  el.innerHTML = `
    <div class="card card-pad">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
        <h3>Admin document checklist</h3>
        <button class="btn btn-brass btn-sm" id="add-cat-btn">${ICONS.plus} Add category</button>
      </div>
      <p class="note" style="margin-bottom:12px;">This is the template in-house admin staff fill in on the Admin tab of every report, usually before the workshop visit. Tag an item to specific brands and/or audit types the same way as workshop questions — no tags on a row means it applies to every brand / every audit type.</p>
      <div id="checklist-tree"></div>
    </div>
  `;
  renderChecklistTree(checklist);
  document.getElementById('add-cat-btn').addEventListener('click', async ()=>{
    checklist.categories.push({id:uid(), title:'New Category', items:[]});
    await sSet('admin-checklist', checklist);
    renderChecklistTree(checklist);
  });
}
function renderChecklistTree(checklist){
  const tree = document.getElementById('checklist-tree');
  if(!checklist.categories.length){ tree.innerHTML = `<p class="note">No categories yet.</p>`; return; }
  tree.innerHTML = checklist.categories.map(cat=>`
    <div class="tree-section">
      <div class="tree-head">
        <input type="text" value="${escapeAttr(cat.title)}" data-cat-title="${cat.id}">
        <button class="icon-btn" data-add-item="${cat.id}" title="Add document">${ICONS.plus}</button>
        <button class="icon-btn danger" data-del-cat="${cat.id}" title="Delete category">${ICONS.trash}</button>
      </div>
      <div class="tree-sub">
        ${cat.items.map(item=>{
          const mode = itemExpiryMode(item);
          return `
          <div class="tree-q" data-item="${item.id}" style="${item.critical?'border-color:var(--bad);':''}">
            <div class="tree-q-row">
              <input type="text" value="${escapeAttr(item.description)}" data-item-desc="${item.id}" placeholder="Document description">
              <select data-item-expirymode="${item.id}" style="font-size:11.5px;padding:4px 6px;border:1px solid var(--line);border-radius:4px;">
                <option value="none" ${mode==='none'?'selected':''}>No date tracking</option>
                <option value="single" ${mode==='single'?'selected':''}>Single expiry date</option>
                <option value="range" ${mode==='range'?'selected':''}>Date range (e.g. forecast)</option>
              </select>
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--bad);font-weight:700;white-space:nowrap;" title="Non-compliance on this item fails the audit">
                <input type="checkbox" data-item-critical="${item.id}" ${item.critical?'checked':''}> Critical
              </label>
              <button class="icon-btn danger" data-del-item="${item.id}" title="Delete">${ICONS.trash}</button>
            </div>
            ${mode==='range' ? `
              <div class="grid2" style="margin:6px 0;">
                <div class="field" style="margin-bottom:6px;"><label>Stale after (days)</label><input type="number" min="1" data-item-staledays="${item.id}" value="${item.staleAfterDays||30}"></div>
                <div class="field" style="margin-bottom:6px;"><label>Auto-answer when stale</label><input type="text" data-item-autoanswer="${item.id}" value="${escapeAttr(item.autoAnswer||'')}" placeholder="e.g. Latest MIBCO not provided"></div>
              </div>
              <p class="note" style="margin-top:-2px;margin-bottom:6px;">Staff enter the forecast/period's start and end date on the Admin tab. If today is more than the above number of days past the end date, the status dropdown auto-fills with this wording — staff can still change it manually.</p>
            ` : ''}
            ${brandTagRowHtml(item.id, item.brands)}
            ${auditTypeTagRowHtml(item.id, item.auditTypes)}
            ${ncWordingPanelHtml(item.id, OPTION_SETS.document, item.ncWording)}
          </div>
        `;}).join('')}
      </div>
    </div>
  `).join('');
  function findCat(id){ return checklist.categories.find(c=>c.items.find(i=>i.id===id)) || checklist.categories.find(c=>c.id===id); }
  function findItem(id){ for(const c of checklist.categories){ const it=c.items.find(i=>i.id===id); if(it) return it; } return null; }
  async function persist(){ await sSet('admin-checklist', checklist); }
  tree.querySelectorAll('[data-cat-title]').forEach(inp=>inp.addEventListener('input', async ()=>{
    const cat = checklist.categories.find(c=>c.id===inp.dataset.catTitle); cat.title=inp.value; await persist();
  }));
  tree.querySelectorAll('[data-item-desc]').forEach(inp=>inp.addEventListener('input', async ()=>{
    findItem(inp.dataset.itemDesc).description=inp.value; await persist();
  }));
  tree.querySelectorAll('[data-item-expirymode]').forEach(sel=>sel.addEventListener('change', async ()=>{
    const item = findItem(sel.dataset.itemExpirymode);
    item.expiryMode = sel.value;
    delete item.hasExpiry; // fully replaced by expiryMode from here on
    await persist(); renderChecklistTree(checklist);
  }));
  tree.querySelectorAll('[data-item-staledays]').forEach(inp=>inp.addEventListener('input', async ()=>{
    findItem(inp.dataset.itemStaledays).staleAfterDays = parseInt(inp.value,10) || 30; await persist();
  }));
  tree.querySelectorAll('[data-item-autoanswer]').forEach(inp=>inp.addEventListener('input', async ()=>{
    findItem(inp.dataset.itemAutoanswer).autoAnswer = inp.value; await persist();
  }));
  tree.querySelectorAll('[data-item-critical]').forEach(cb=>cb.addEventListener('change', async ()=>{
    findItem(cb.dataset.itemCritical).critical = cb.checked; await persist(); renderChecklistTree(checklist);
  }));
  tree.querySelectorAll('[data-add-item]').forEach(b=>b.addEventListener('click', async ()=>{
    const cat = checklist.categories.find(c=>c.id===b.dataset.addItem);
    cat.items.push({id:uid(), description:'New document', expiryMode:'single', brands:[], auditTypes:[], critical:false}); await persist(); renderChecklistTree(checklist);
  }));
  tree.querySelectorAll('[data-del-cat]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Delete this category and its documents?')) return;
    checklist.categories = checklist.categories.filter(c=>c.id!==b.dataset.delCat); await persist(); renderChecklistTree(checklist);
  }));
  tree.querySelectorAll('[data-del-item]').forEach(b=>b.addEventListener('click', async ()=>{
    checklist.categories.forEach(c=>{ c.items = c.items.filter(i=>i.id!==b.dataset.delItem); });
    await persist(); renderChecklistTree(checklist);
  }));
  wireBrandTagRow(tree, (itemId)=>{ const it=findItem(itemId); if(it){ it.brands = it.brands||[]; } return it?it.brands:null; }, async ()=>{ await persist(); renderChecklistTree(checklist); });
  wireAuditTypeTagRow(tree, (itemId)=>{ const it=findItem(itemId); if(it){ it.auditTypes = it.auditTypes||[]; } return it?it.auditTypes:null; }, async ()=>{ await persist(); renderChecklistTree(checklist); });
  wireNcWordingPanel(tree, (itemId)=>findItem(itemId), persist);
}

/* ---------- HELP ---------- */
/* ---------- SERVER CONNECTION (point this device at your own backend) ---------- */
function renderSettings(){
  loadServerConfig();
  setTopbar('Server Connection', 'Connect this device to your own backend so this app works fully independently of Claude.ai.', '');
  const mode = currentStorageMode();
  const c = document.getElementById('content');
  c.innerHTML = `
    <div class="card card-pad" style="max-width:560px;margin-bottom:16px;">
      <h3 style="margin-bottom:4px;">Current mode</h3>
      <p style="font-size:14px;margin-bottom:14px;"><span class="badge ${mode==='local-fallback'?'badge-bad':'badge-good'}">${escapeHtml(currentStorageModeLabel())}</span></p>
      <div class="field"><label>Server URL</label><input type="text" id="cfg-url" placeholder="https://your-audit-server.onrender.com" value="${escapeAttr(SERVER_CONFIG?SERVER_CONFIG.apiBase:'')}"></div>
      <div class="field"><label>API Key</label><input type="password" id="cfg-key" placeholder="the key set on the server" value="${escapeAttr(SERVER_CONFIG?SERVER_CONFIG.apiKey:'')}"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="cfg-save">${ICONS.server} Connect</button>
        ${SERVER_CONFIG ? `<button class="btn btn-danger" id="cfg-disconnect">Disconnect</button>` : ''}
      </div>
      <p class="note" id="cfg-status" style="margin-top:10px;"></p>
    </div>
    <div class="card card-pad">
      <h3 style="margin-bottom:8px;">Setting up your own server</h3>
      <p class="note" style="margin-bottom:8px;">The <code>server/</code> folder is a small Node.js + SQLite backend (Express, ~100 lines) that speaks the same storage protocol this app already uses. Run it locally with <code>npm install &amp;&amp; npm start</code> to try it, or deploy it somewhere always-on (Railway, Render, Fly.io, or your own VPS/Docker) so your whole team can reach it. Full step-by-step instructions, including free hosting options, are in <code>server/README.md</code>.</p>
      <p class="note">Once it's running, come back here on each device, paste in the Server URL it gives you and the API Key you set, and click Connect. This device will reload and use that server from then on.</p>
    </div>
  `;
  document.getElementById('cfg-save').addEventListener('click', async ()=>{
    const url = document.getElementById('cfg-url').value.trim();
    const key = document.getElementById('cfg-key').value.trim();
    const status = document.getElementById('cfg-status');
    if(!url || !key){ status.textContent = 'Enter both the server URL and API key.'; status.style.color = 'var(--bad)'; return; }
    status.textContent = 'Testing connection\u2026';
    status.style.color = 'var(--ink-soft)';
    try{
      const testRes = await fetch(url.replace(/\/+$/,'')+'/api/kv?prefix=__connection_test__', {headers:{'X-API-Key':key}});
      if(testRes.status===401){ status.textContent = 'Reached the server, but that API key was rejected.'; status.style.color='var(--bad)'; return; }
      if(!testRes.ok){ status.textContent = 'Server responded with an error (status '+testRes.status+').'; status.style.color='var(--bad)'; return; }
    }catch(e){
      status.textContent = 'Could not reach that server. Check the URL, that it is running, and that it allows connections from this device.';
      status.style.color = 'var(--bad)';
      return;
    }
    saveServerConfig({apiBase:url, apiKey:key});
    status.textContent = 'Connected — reloading\u2026';
    status.style.color = 'var(--good)';
    setTimeout(()=>location.reload(), 700);
  });
  if(document.getElementById('cfg-disconnect')){
    document.getElementById('cfg-disconnect').addEventListener('click', ()=>{
      if(!confirm('Disconnect this device from your server? It will fall back to Claude storage (if available) or this browser only.')) return;
      clearServerConfig();
      toast('Disconnected — reloading\u2026');
      setTimeout(()=>location.reload(), 500);
    });
  }
}

function renderHelp(){
  setTopbar('About this app', '', '');
  document.getElementById('content').innerHTML = `
    <div class="card card-pad">
      <h3 style="margin-bottom:10px;">How this fits together</h3>
      <ul style="margin:0 0 14px 18px;padding:0;font-size:13.5px;line-height:1.8;">
        <li><strong>Info &amp; Brands</strong> — company details and which brands this visit covers. Everything downstream filters off this brand list.</li>
        <li><strong>Admin</strong> — in-house staff complete this, typically before the workshop visit: a shared document checklist that only shows items relevant to the selected brands and audit type. Some items can track a date range instead of a single expiry (e.g. a forecast period) and will auto-fill a specific status once that range goes stale — still changeable by hand at any time.</li>
        <li><strong>Workshop</strong> — the on-site audit questions, also shared across brands and filtered the same way. Most questions are generic; some are tagged to a specific brand, and/or to a specific audit type (Initial vs Renewal genuinely have different questions in the source workbook, so a question can be restricted to just one).</li>
        <li><strong>Trademarks</strong> — infringement check across every brand you work with, not just the ones on this audit.</li>
        <li><strong>Non-Compliance</strong> — a single generalized report auto-built from every "not compliant"-type answer in Admin and Workshop, with space to log a corrective action, owner and due date per item.</li>
        <li><strong>Brand Reports</strong> — generated per audited brand from the Admin + Workshop answers that apply to it, with its own accept/reject decision and signature — this is what gets shown to and signed by the dealer, one manufacturer at a time.</li>
        <li><strong>Sign-off</strong> — the overall visit sign-off: permission to audit, duration, general report acceptance, document verification consent and final sign-off.</li>
        <li><strong>Photos &amp; Documents</strong> — per-report repositories for on-site photos and supporting paperwork.</li>
        <li><strong>Export</strong> — a full combined PDF, or standalone PDFs per brand report, admin checklist, workshop results, trademarks, non-compliance report or sign-off sheet.</li>
      </ul>
      <h3 style="margin-bottom:8px;">Owner Setup</h3>
      <p style="font-size:13.5px;margin-bottom:8px;">Brands, the Workshop question bank and the Admin checklist are shared, single lists — not duplicated per brand — and can only be edited from Owner Setup, which is locked behind a PIN. Tag a question or checklist item to one or more brands and/or audit types (Initial, Renewal, etc.) and it only appears on reports matching those tags; leave a tag row empty and it applies to everything on that dimension. The PIN is a soft deterrent for a small trusted team, not real security.</p>
      <h3 style="margin-bottom:8px;">Using this on multiple laptops, phones &amp; tablets</h3>
      <p style="font-size:13.5px;margin-bottom:8px;">Storage mode on this device right now: <strong>${escapeHtml(currentStorageModeLabel())}</strong>.</p>
      <p style="font-size:13.5px;margin-bottom:8px;">There are three ways this app can store data, checked in this order:</p>
      <ol style="margin:0 0 8px 18px;padding:0;font-size:13.5px;line-height:1.8;">
        <li><strong>Your own server</strong> — connect via the <strong>Server Connection</strong> screen and every device pointed at that same server shares data, completely independently of Claude.ai. This is the option for running the app fully on your own, e.g. on phones and tablets in the field with no Claude account involved. The backend code and deployment instructions ship in the <code>server/</code> folder.</li>
        <li><strong>Shared via Claude.ai</strong> — if no server is configured, and this is opened inside Claude.ai (the artifact in this conversation, or a link/conversation shared with your team), everyone sees the same data automatically, kept in sync on any device, for as long as you're all using it through Claude.</li>
        <li><strong>Local-only fallback</strong> — if neither of the above applies (e.g. the file was downloaded and opened directly, with no server configured), data only saves to that one browser. You'll see a banner at the top when this happens.</li>
      </ol>
      <h3 style="margin-bottom:8px;margin-top:14px;">Known limits of this prototype</h3>
      <p style="font-size:13.5px;">The Claude-shared mode runs on the artifact's built-in key-value storage (~5MB per item). Your own server has no such limit (it's plain SQLite), but it's a single shared API key rather than individual logins, and the SQLite file is the only copy of your data — back it up. See <code>server/README.md</code> for security notes and backup guidance.</p>
    </div>
  `;
}

/* =========================================================
   UTILITIES
========================================================= */
function escapeHtml(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }
function formatDate(d){ if(!d) return ''; const dt = new Date(d); if(isNaN(dt)) return d; return dt.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}); }
function formatBytes(b){ if(!b) return '0 KB'; const kb=b/1024; return kb<1024? kb.toFixed(0)+' KB' : (kb/1024).toFixed(1)+' MB'; }
function timeAgo(iso){
  if(!iso) return 'just now';
  const s = Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+' min ago';
  if(s<86400) return Math.floor(s/3600)+' hr ago';
  return Math.floor(s/86400)+' day(s) ago';
}
function downloadDataUrl(dataUrl, filename){
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

/* =========================================================
   BOOT
========================================================= */
function showStorageBannerIfNeeded(){
  const mode = currentStorageMode();
  if(mode !== 'local-fallback') return;
  const banner = document.getElementById('storage-banner');
  banner.style.display = 'flex';
  banner.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
    <span><b>Local-only mode:</b> data will only save to this browser/device, not share with your team. Open this through Claude.ai to get storage shared automatically, or connect it to your own server from the <b>Server Connection</b> screen for shared storage without Claude.</span>
  `;
}

(async function boot(){
  showStorageBannerIfNeeded();
  await ensureSeeded();
  await ensureMibcoForecastExample();
  await ensureCriticalExamples();
  await loadWorkshopData();
  await render();
})();

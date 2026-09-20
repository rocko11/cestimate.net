/* ============ STATE ============ */
let files = [];  // entries: {file,name,size,images:[b64]|null,compBytes,status,msg}
let lastRows = [], lastTotals = {};
let lastLabor = {rows:[], phases:[], totHrs:0, totLaborCost:0, projWorkDays:0};

/* ============ UPLOAD HANDLING ============ */
const drop = document.getElementById('drop');
const fileinput = document.getElementById('fileinput');
drop.onclick = () => fileinput.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('hover'); };
drop.ondragleave = () => drop.classList.remove('hover');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hover'); addFiles(e.dataTransfer.files); };
fileinput.onchange = e => addFiles(e.target.files);

function addFiles(list){
  for(const f of list){
    const entry={file:f,name:f.name,size:f.size,images:null,compBytes:0,status:'pending',msg:''};
    files.push(entry);
    compressEntry(entry).then(renderFiles).catch(()=>renderFiles()); // shrink immediately on upload
  }
  renderFiles();
}

// Compress on upload: render PDF pages / images to downscaled JPEGs so the
// payload is well under the 4 MB request limit before analysis ever runs.
async function compressEntry(entry){
  try{
    const f=entry.file;
    let imgs=[];
    if(f.type==='application/pdf') imgs=await pdfToImages(f);
    else if(f.type.startsWith('image/')) imgs=[await imageToScaled(f)];
    else { entry.status='error'; entry.msg='unsupported type (use PDF/PNG/JPG)'; return; }
    entry.images=imgs;
    entry.compBytes=imgs.reduce((s,b)=>s+Math.ceil(b.length*0.75),0); // base64 → bytes
    entry.status='done';
  }catch(e){ entry.status='error'; entry.msg=(e&&e.message)||'could not compress'; }
}

function renderFiles(){
  const el = document.getElementById('filelist');
  el.innerHTML = files.map((e,i)=>{
    const mb = (e.size/1048576).toFixed(1);
    let tail;
    if(e.status==='pending') tail = `<span style="color:#928f86">(${mb} MB · compressing…)</span>`;
    else if(e.status==='error') tail = `<span style="color:#b5340b">(${mb} MB · ${e.msg})</span>`;
    else { const c=(e.compBytes/1048576).toFixed(2); tail = `<span style="color:#0F6E56">(${mb} MB → ${c} MB ✓ under limit)</span>`; }
    return `<div class="fileitem">📄 ${e.name} ${tail}<button class="rm" onclick="removeFile(${i})">×</button></div>`;
  }).join('');
  const anyReady = files.some(e=>e.status==='done');
  const btn=document.getElementById('analyze-btn');
  if(btn) btn.disabled = !anyReady;
}
function removeFile(i){ files.splice(i,1); renderFiles(); }

function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result.split(',')[1]);
    r.onerror=rej; r.readAsDataURL(file);
  });
}

/* ============ AI PLAN ANALYSIS ============ */
/* NOTE: the AI plan-reading step calls the Anthropic API. That call only
   succeeds in an environment that provides credentials/proxying (e.g. running
   inside Claude, or behind your own backend that injects an API key). When the
   call is unavailable the app cleanly falls back to manual entry, and the full
   takeoff + labor/schedule engine still works. See README for hosting notes. */
/* When deployed to Netlify with the analyze function, calls go through the
   backend proxy (which holds the API key). Large PDFs are rendered to downscaled
   JPEGs in the browser and sent in batches that stay under the request limit, so
   you can upload big plan sets without the "file too large" error. */
const PROXY_URL='/.netlify/functions/analyze';
const MAX_DIM=1500;        // px — longest side of each rendered page
const JPEG_Q=0.7;          // page image quality
const BATCH_BUDGET=3.2e6;  // ~3.2 MB of base64 per request (safely under Netlify's 6 MB)

let _pdfjs=null;
function ensurePdfJs(){
  if(_pdfjs) return _pdfjs;
  _pdfjs=new Promise((resolve,reject)=>{
    if(window.pdfjsLib){ resolve(window.pdfjsLib); return; }
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload=()=>{ try{
      window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    }catch(e){ reject(e); } };
    s.onerror=()=>reject(new Error('Could not load the PDF compressor (offline?).'));
    document.head.appendChild(s);
  });
  return _pdfjs;
}

// Render each PDF page to a downscaled JPEG (base64). Shrinks an 18 MB plan set
// to a few hundred KB per page, so size is no longer a barrier.
// Page 1 of a filed NYC plan set is conventionally the zoning/plot plan cover
// sheet, whose "ZONING ANALYSIS" block (dwelling-unit totals, GFA, occupancy)
// is printed as small text that becomes illegible once the whole D-size sheet
// is downscaled to MAX_DIM. So for page 1 only, also render a high-resolution
// crop of that block and send it as a second reference image.
async function pdfToImages(file,onProg){
  const pdfjs=await ensurePdfJs();
  const buf=await file.arrayBuffer();
  const pdf=await pdfjs.getDocument({data:buf}).promise;
  const out=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const base=page.getViewport({scale:1});
    const scale=Math.min(MAX_DIM/Math.max(base.width,base.height),2)||1;
    const vp=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(vp.width); canvas.height=Math.ceil(vp.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    out.push(canvas.toDataURL('image/jpeg',JPEG_Q).split(',')[1]);
    if(p===1){
      try{ out.push(await renderZoningCrop(page)); }catch(e){ /* non-fatal — fall back to full page only */ }
    }
    if(onProg) onProg(p,pdf.numPages);
  }
  return out;
}

// High-resolution close-up of the cover sheet's top-left corner, where NYC
// filed-plan zoning-analysis blocks conventionally live.
async function renderZoningCrop(page){
  const base=page.getViewport({scale:1});
  const hiScale=Math.min(3200/Math.max(base.width,base.height),4)||2;
  const vp=page.getViewport({scale:hiScale});
  const big=document.createElement('canvas');
  big.width=Math.ceil(vp.width); big.height=Math.ceil(vp.height);
  await page.render({canvasContext:big.getContext('2d'),viewport:vp}).promise;
  const cw=Math.ceil(big.width*0.26), ch=Math.ceil(big.height*0.38);
  const crop=document.createElement('canvas');
  crop.width=Math.min(cw,MAX_DIM*1.4); crop.height=Math.round(crop.width*(ch/cw));
  crop.getContext('2d').drawImage(big,0,0,cw,ch,0,0,crop.width,crop.height);
  return crop.toDataURL('image/jpeg',0.85).split(',')[1];
}

// Downscale an uploaded image to keep the request small.
function imageToScaled(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const scale=Math.min(MAX_DIM/Math.max(img.width,img.height),1)||1;
      const c=document.createElement('canvas');
      c.width=Math.ceil(img.width*scale); c.height=Math.ceil(img.height*scale);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      resolve(c.toDataURL('image/jpeg',JPEG_Q).split(',')[1]);
    };
    img.onerror=()=>reject(new Error('image decode failed'));
    img.src=URL.createObjectURL(file);
  });
}

// Send a batch of page-images for extraction: proxy first, direct fallback.
async function callExtractor(parts){
  try{
    const r=await fetch(PROXY_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({parts,prompt:EXTRACTION_PROMPT})});
    if(r.ok){ const d=await r.json(); if(d&&typeof d.text==='string') return d.text; }
  }catch(e){ /* no proxy (preview) — fall through */ }
  const content=parts.map(p=>({type:'image',source:{type:'base64',media_type:p.media_type,data:p.data}}));
  content.push({type:'text',text:EXTRACTION_PROMPT});
  const r2=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,messages:[{role:'user',content}]})});
  if(!r2.ok) throw new Error('API '+r2.status);
  const d2=await r2.json();
  return (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
}

// Convert a file to downscaled images, batch under the size budget, extract each.
// Returns an array of parsed objects (merged later across all files).
async function extractFromImages(imgs){
  const batches=[]; let cur=[],sz=0;
  for(const data of imgs){
    if(cur.length && sz+data.length>BATCH_BUDGET){ batches.push(cur); cur=[]; sz=0; }
    cur.push({media_type:'image/jpeg',data}); sz+=data.length;
  }
  if(cur.length) batches.push(cur);
  const parsed=[];
  for(const b of batches){
    try{ const t=await callExtractor(b); const j=parseJSON(t); if(j) parsed.push(j); }catch(e){}
  }
  return parsed;
}


async function analyzePlans(){
  show('analyzing'); hide('step-1');
  clearMetrics(); // never let a previous project's / example values carry into a new upload
  const msg=document.getElementById('analyze-msg');
  const sub=document.getElementById('analyze-sub');
  const results=[];
  try{
    // Files were already compressed to page-images on upload; analyze each,
    // then merge. Schedule sheets, cover sheets and floor plans often live in
    // different files, so per-file extraction + merge is the most reliable.
    let done=0;
    for(let i=0;i<files.length;i++){
      const entry=files[i];
      if(entry.status!=='done' || !entry.images || !entry.images.length) continue;
      done++;
      if(msg) msg.textContent=`Reading file ${i+1} of ${files.length}…`;
      if(sub) sub.textContent=entry.name+' — scanning every page & schedule';
      try{
        const arr=await extractFromImages(entry.images);
        arr.forEach(x=>results.push(x));
      }catch(e){ /* skip this file, keep going with the rest */ }
    }
    if(!results.length) throw new Error('no files could be analyzed');
    const {merged,missing}=mergeExtractions(results);
    fillMetrics(merged);
    showExtractNote(results.length, files.length, missing);
    hide('analyzing'); show('step-2'); setChip(2);
  }catch(err){
    hide('analyzing'); show('step-1');
    alert('AI analysis unavailable ('+err.message+').\n\nThis often happens with very large plan PDFs in a sandboxed preview. You can:\n• click "Load 124 Washington example" for known values, or\n• click "Skip — enter metrics manually" and type them in.\nThe full takeoff, labor and Excel export work either way.');
    manualEntry();
  }
}

/* Merge per-file extractions: counts take the MAX seen on any sheet (a schedule
   usually appears once), identifiers take the first non-empty, flags OR together.
   Anything still null after merging is reported to the user as "not found". */
function mergeExtractions(list){
  // Values that should come from ONE authoritative source (the cover/zoning
  // sheet) — take the first non-null in page order. Taking the max here was
  // the bug: a later batch scanning unrelated floor-plan pages could guess a
  // bigger (wrong) number — e.g. miscounting apartment doors as "units" — and
  // that wrong-but-bigger number would win over the correct cover-sheet total.
  const singleFirst=['gfa','nsf','footprint','floors','units','perimeter','f2f'];
  // Schedule quantities can legitimately be split across multiple sheets/batches
  // (a window schedule spanning several pages), so these are summed instead.
  const scheduleSum=['windows','doorsEntry','doorsStair','doorsInterior',
    'hvacCondensers','hvacIndoor','exhaustFans','elevators'];
  const firstStr=['projectName','propertyAddress','ownerName','ownerAddress','dobJob','borough','worktype','constructionType','occupancy'];
  const flags=['cellar','court'];
  const m={};
  singleFirst.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k];
    if(v==null&&typeof x==='number'&&!Number.isNaN(x)) v=x; }); m[k]=v; });
  scheduleSum.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k];
    if(typeof x==='number'&&!Number.isNaN(x)) v=(v==null)?x:v+x; }); m[k]=v; });
  firstStr.forEach(k=>{ let v=''; list.forEach(o=>{ if(!v&&o&&typeof o[k]==='string'&&o[k].trim()) v=o[k].trim(); }); m[k]=v||null; });
  flags.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k]; if(x===0||x===1) v=(v==null)?x:Math.max(v,x); }); m[k]=v; });
  const LBL={gfa:'Total GFA',nsf:'Net SF',footprint:'Footprint/floor',floors:'# Floors',
    units:'# Units',perimeter:'Perimeter',f2f:'Floor-to-floor',windows:'Windows',
    doorsEntry:'Entry doors',doorsStair:'Stair/fire doors',doorsInterior:'Interior doors',
    hvacCondensers:'HVAC condensers',hvacIndoor:'HVAC indoor units',exhaustFans:'Exhaust fans',elevators:'Elevators'};
  const missing=Object.keys(LBL).filter(k=>m[k]==null).map(k=>LBL[k]);
  return {merged:m, missing};
}

function showExtractNote(ok,total,missing){
  const el=document.getElementById('extract-note');
  if(!el) return;
  let h=`<span class="ai-badge">AI-extracted</span> &nbsp;Read <strong>${ok} of ${total}</strong> file(s), scanning every page and schedule. Review the values and correct anything off — purple fields were auto-filled; all are editable.`;
  if(missing&&missing.length){
    h+=`<br><br><strong style="color:#b5340b">Not found on the sheets provided:</strong> ${missing.join(', ')}.<br>Enter these manually below, or go back and also upload the specific schedule sheet that lists them (e.g. window/door schedule, MEP equipment schedule).`;
  }
  el.innerHTML=h;
}

const EXTRACTION_PROMPT = `You are a senior construction estimator reading approved NYC DOB building plans. Examine EVERY page of this file, including title-block text and especially any SCHEDULE TABLES — window schedule, door & hardware schedule, mechanical/HVAC equipment schedule, plumbing fixture schedule, and unit/occupancy matrix. When a schedule lists quantities, COUNT every row and SUM the quantity column (often "QTY", "NO.", or "#") to get the totals. Read carefully and do NOT guess: if a value genuinely does not appear anywhere in this file, return null for it — never invent a number.
The FIRST image (and, if present, a second high-resolution close-up crop of its top-left corner) is normally the cover/zoning-plot-plan sheet. Its "ZONING ANALYSIS" and "USE/OCCUPANCY" blocks are small print — if a crop image is provided, treat it as the authoritative, most-legible source for gfa, floors, units, occupancy, and construction type, and read every digit and word in it carefully before falling back to the full-page image.
For "units" (total dwelling units): look for an explicit statement such as "TOTAL SEVENTY FIVE (75) CLASS \"A\" DWELLING UNITS" — NYC filed plans commonly spell the number out with the numeral in parentheses; use the numeral. If no single total line exists but each floor states its own unit count (e.g. "9TH FLOOR: TEN (10) CLASS \"A\" DWELLING UNITS"), sum those per-floor counts. Do NOT infer units by counting doors, rooms, or symbols on an individual floor-plan drawing — that consistently overcounts. When both an explicit total and a per-floor breakdown are visible, they should agree; report the explicit total.
Also read the title block / cover sheet for the property address and the owner or sponsor entity's name and mailing address.
Return a SINGLE compact JSON object with NO markdown, code fences, or prose. Use null for anything not found. Keys:
{"projectName":string|null,"propertyAddress":string|null (building/property street address from title block),"ownerName":string|null (owner or sponsor entity name from title block),"ownerAddress":string|null (owner's mailing address, if shown separately),"dobJob":string|null,"borough":"Manhattan"|"Brooklyn"|"Queens"|"Bronx"|"Staten Island"|null,"gfa":number|null (total gross SF),"nsf":number|null (net residential/usable SF),"footprint":number|null (typical floor plate SF),"floors":number|null (stories above grade),"cellar":0|1|null,"units":number|null (total dwelling units — see rule above),"f2f":number|null (floor-to-floor ft),"perimeter":number|null (building perimeter LF),"worktype":"new"|"conversion"|"gut"|"partial"|null,"constructionType":"I-A"|"I-B"|"II-A"|"II-B"|"III-A"|"III-B"|"V"|null,"occupancy":"R-2"|"R-3"|"B"|"A"|"M"|"I"|null,"court":0|1|null (inner court / curtain wall present),"windows":number|null (total from window schedule),"doorsEntry":number|null (apartment/entry doors),"doorsStair":number|null (stair + fire-rated doors),"doorsInterior":number|null (interior doors),"hvacCondensers":number|null (outdoor/roof condensing units),"hvacIndoor":number|null (indoor air handlers/cassettes),"exhaustFans":number|null (kitchen + bath exhaust fans),"elevators":number|null}
JSON only.`;

function parseJSON(text){
  if(!text) return null;
  let t=text.replace(/```json/gi,'').replace(/```/g,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a<0||b<0) return null;
  try{ return JSON.parse(t.slice(a,b+1)); }catch{ return null; }
}

const CTYPE_MAP={'I-A':1.15,'I-B':1.10,'II-A':1.0,'II-B':0.96,'III-A':0.93,'III-B':0.90,'V':0.85};
const OCC_MAP={'R-2':1.0,'R-3':0.88,'B':1.0,'A':1.25,'M':0.92,'I':1.42};
const BORO_MAP={'Manhattan':'1.0','Brooklyn':'0.92','Queens':'0.90','Bronx':'0.86','Staten Island':'0.84'};

function fillMetrics(p){
  const nb=v=>(typeof v==='number'&&!Number.isNaN(v))?v:''; // number, else blank
  setV('m-name',p.projectName||''); setV('m-address',p.propertyAddress||'');
  setV('m-owner-name',p.ownerName||''); setV('m-owner-address',p.ownerAddress||'');
  setV('m-job',p.dobJob||'');
  if(p.borough&&BORO_MAP[p.borough]) setSel('m-borough',BORO_MAP[p.borough]);
  setV('m-gfa',nb(p.gfa)); setV('m-nsf',nb(p.nsf!=null?p.nsf:p.gfa)); setV('m-footprint',nb(p.footprint));
  setV('m-floors',nb(p.floors)); setV('m-units',nb(p.units));
  setV('m-f2f',nb(p.f2f)); setV('m-perim',nb(p.perimeter));
  if(p.cellar===0||p.cellar===1) document.getElementById('m-cellar').value=String(p.cellar);
  if(p.worktype) document.getElementById('m-worktype').value=p.worktype;
  if(p.constructionType&&CTYPE_MAP[p.constructionType]) setSel('m-ctype',CTYPE_MAP[p.constructionType]);
  if(p.occupancy&&OCC_MAP[p.occupancy]) setSel('m-occ',OCC_MAP[p.occupancy]);
  if(p.court===0||p.court===1) document.getElementById('m-court').value=String(p.court);
  setV('m-windows',nb(p.windows)); setV('m-doors-entry',nb(p.doorsEntry));
  setV('m-doors-stair',nb(p.doorsStair)); setV('m-doors-int',nb(p.doorsInterior));
  setV('m-hvac-cu',nb(p.hvacCondensers)); setV('m-hvac-ah',nb(p.hvacIndoor));
  setV('m-exhaust',nb(p.exhaustFans)); setV('m-elev',nb(p.elevators));
  // reflect cross-derived areas into blank fields so they're visible & editable
  const gv=id=>+getV(id)||0;
  if(gv('m-gfa')<=0 && gv('m-footprint')>0 && gv('m-floors')>0) setV('m-gfa',Math.round(gv('m-footprint')*gv('m-floors')));
  if(gv('m-footprint')<=0 && gv('m-gfa')>0 && gv('m-floors')>0) setV('m-footprint',Math.round(gv('m-gfa')/gv('m-floors')));
  if(gv('m-nsf')<=0 && gv('m-gfa')>0) setV('m-nsf',Math.round(gv('m-gfa')*0.78));
}

function clearMetrics(){
  ['m-name','m-address','m-owner-name','m-owner-address','m-owner-phone','m-owner-email',
   'm-job','m-gfa','m-nsf','m-footprint','m-floors','m-units','m-f2f','m-perim',
   'm-windows','m-doors-entry','m-doors-stair','m-doors-int','m-hvac-cu','m-hvac-ah','m-exhaust','m-elev']
   .forEach(id=>setV(id,''));
}

function manualEntry(){
  clearMetrics(); // blank fields for the user's own building (not a prior/example project)
  const el=document.getElementById('extract-note');
  if(el) el.innerHTML='<span class="ai-badge">Manual</span> &nbsp;Enter your building\u2019s values below, then run the takeoff. Tip: use \u201cLoad 124 Washington example\u201d on the upload screen if you just want a sample.';
  document.querySelectorAll('#step-2 .field.ai').forEach(f=>f.classList.remove('ai'));
  hide('step-1'); hide('analyzing'); show('step-2'); setChip(2);
}

/* One-click load of the known, verified 124 Washington Avenue values, so the
   verify page is fully populated even when plan-reading can't run (e.g. large
   PDFs in a sandboxed preview). Replace by uploading and analyzing real plans. */
function loadExample(){
  const ex={projectName:'124 Washington Ave, Brooklyn',
    propertyAddress:'124 Washington Avenue, Brooklyn, NY 11205',
    ownerName:'',ownerAddress:'', // not shown anywhere on the filed architectural set — see chat
    dobJob:'B01108308',borough:'Brooklyn',
    gfa:24689,nsf:18596,footprint:4755,floors:4,cellar:1,units:17,f2f:11.5,perimeter:260,
    worktype:'conversion',constructionType:'III-A',occupancy:'R-2',court:1,
    windows:50,doorsEntry:17,doorsStair:26,doorsInterior:45,
    hvacCondensers:18,hvacIndoor:57,exhaustFans:41,elevators:1};
  fillMetrics(ex);
  const el=document.getElementById('extract-note');
  if(el) el.innerHTML='<span class="ai-badge">Example</span> &nbsp;Loaded the known <strong>124 Washington Avenue</strong> values (verified against the Z-001.00 zoning/plot plan sheet: 17 Class A dwelling units — 3+5+5+4 by floor — 24,689 SF gross, Block 1889 Lot 65, R6B). Every field is editable — adjust anything, then run the takeoff. To use your own building, go back and upload &amp; analyze its plans.';
  hide('step-1'); hide('analyzing'); show('step-2'); setChip(2);
}

/* ============ LABOR / SCHEDULE REFERENCE DATA ============ */
/* Loaded NYC labor rates ($/hr, incl. burden) by trade — representative 2025-26.
   Scaled by the editable "labor rate adjustment" field. */
const TRADE_RATE={
  laborer:75, operator:130, concrete:90, ironworker:115, carpenter:95, mason:98,
  roofer:85, glazier:100, insulation:80, drywall:88, tile:92, flooring:82,
  painter:78, millwork:95, plumber:122, sprinkler:115, hvac:115, electrician:120,
  elevator:145, abatement:95
};
/* Per-division crew size & construction phase for scheduling.
   Key = division code (text before the "·"). */
const DIV_SCHED={
  '00':{crew:6,phase:1}, '00b':{crew:10,phase:2}, '00c':{crew:8,phase:3},
  '02':{crew:7,phase:1}, '04':{crew:5,phase:2}, '06':{crew:6,phase:2},
  '05':{crew:4,phase:3}, '07':{crew:4,phase:3}, '08':{crew:5,phase:3},
  '21/22':{crew:7,phase:4}, '23':{crew:7,phase:4}, '26':{crew:7,phase:4},
  '09':{crew:18,phase:5}, '11':{crew:6,phase:6}, '14':{crew:3,phase:6}
};
const PHASE_NAMES={
  1:'Site, Demolition & Foundations', 2:'Structure',
  3:'Envelope, Roof & Openings', 4:'MEP Rough-in',
  5:'Interior Finishes', 6:'Fixtures, Equipment & Commissioning'
};
const HRS_PER_DAY=8;

/* ============ TAKEOFF ENGINE ============ */
function metrics(){
  const g={
    gfa:+getV('m-gfa')||0, nsf:+getV('m-nsf')||0, footprint:+getV('m-footprint')||0,
    floors:+getV('m-floors')||1, units:+getV('m-units')||0, f2f:+getV('m-f2f')||11,
    perim:+getV('m-perim')||0, cellar:+document.getElementById('m-cellar').value||0,
    worktype:document.getElementById('m-worktype').value,
    court:+document.getElementById('m-court').value||0,
    windows:+getV('m-windows')||0, doorsEntry:+getV('m-doors-entry')||0,
    doorsStair:+getV('m-doors-stair')||0, doorsInt:+getV('m-doors-int')||0,
    cu:+getV('m-hvac-cu')||0, ah:+getV('m-hvac-ah')||0, exh:+getV('m-exhaust')||0,
    elev:+getV('m-elev')||0,
    boro:+document.getElementById('m-borough').value||1,
    ctype:+document.getElementById('m-ctype').value||1,
    occ:+document.getElementById('m-occ').value||1,
  };
  // Cross-derive area metrics so area-based lines (e.g. $45/SF superstructure)
  // never read $0 just because one field was left blank.
  if(g.gfa<=0 && g.footprint>0 && g.floors>0) g.gfa=g.footprint*g.floors;
  if(g.footprint<=0 && g.gfa>0 && g.floors>0) g.footprint=g.gfa/g.floors;
  if(g.nsf<=0 && g.gfa>0) g.nsf=Math.round(g.gfa*0.78); // ~78% net-to-gross
  return g;
}

// PARTFACTOR (LF partition per SF floor) and wall height factor
const PARTFACTOR=0.95, WALLHT_RATIO=0.83; // clear wall ht ≈ 0.83 × f2f

// Each item now carries: mh (man-hours per unit) and trade (for labor rate).
function buildTakeoff(m){
  const wallht=m.f2f*WALLHT_RATIO;
  const isNew=m.worktype==='new';
  const divs=[];

  if(isNew){
    divs.push({div:'00 · Sitework, Excavation & Foundations', items:[
      {n:'Excavation & earthwork', basis:'Footprint × ~8 ft depth ÷ 27', qty:m.footprint*8/27, u:'CY', p:55, mh:0.12, trade:'operator', src:'New foundation'},
      {n:'Foundation (footings, mat, walls)', basis:'Footprint SF · mandatory $45/SF', qty:m.footprint, u:'SF', p:45, fixed:true, mh:0.30, trade:'concrete', src:'Mandatory $45/SF (fixed)'},
      {n:'Below-grade waterproofing', basis:'Footprint SF', qty:m.footprint, u:'SF', p:14, mh:0.05, trade:'laborer', src:'Foundation walls+slab'},
      {n:'Utility connections', basis:'Lump', qty:1, u:'LS', p:185000, mh:350, trade:'laborer', src:'ConEd/DEP taps'},
    ]});
    divs.push({div:'00b · Superstructure', items:[
      {n:'Concrete superstructure — frame, slabs & roof deck', basis:'GFA SF · mandatory $45/SF', qty:m.gfa, u:'SF', p:45, fixed:true, mh:0.30, trade:'concrete', src:'Mandatory $45/SF (fixed)'},
    ]});
    divs.push({div:'00c · Exterior Envelope', items:[
      {n:'Exterior facade (new skin)', basis:'≈0.85 × GFA', qty:m.gfa*0.85, u:'SF', p:55, mh:0.30, trade:'glazier', src:'Curtain wall/masonry/panel'},
      {n:'Air/vapor barrier & insulation', basis:'≈0.85 × GFA', qty:m.gfa*0.85, u:'SF', p:16, mh:0.05, trade:'insulation', src:'Continuous insulation'},
    ]});
  }else{
    divs.push({div:'02 · Demolition', items:[
      {n:'Selective interior demolition', basis:'Net area × 40%', qty:m.nsf*0.40, u:'SF', p:9, mh:0.07, trade:'laborer', src:'Partial demo, factored'},
      {n:'Debris removal & disposal', basis:'1 CY / 35 SF demo', qty:(m.nsf*0.40)/35, u:'CY', p:95, mh:0.45, trade:'laborer', src:'NYC C&D disposal'},
      {n:'Asbestos / hazmat abatement', basis:'Net area (if pre-1980)', qty:m.nsf, u:'SF', p:16, mh:0.10, trade:'abatement', src:'Confirm w/ survey'},
    ]});
    divs.push({div:'04 · Masonry', items:[
      {n:'Brick repointing — facade', basis:'Perim × ht × floors × 30%', qty:m.perim*m.f2f*m.floors*0.30, u:'SF', p:28, mh:0.22, trade:'mason', src:'Existing brick retained'},
      {n:'New CMU bearing/shaft walls', basis:'Shaft 4 sides × ht × floors', qty:4*m.f2f*m.floors, u:'SF', p:38, mh:0.16, trade:'mason', src:'Rated CMU'},
    ]});
    divs.push({div:'06 · Wood & Timber', items:[
      {n:'Existing floor structure mod / reinf', basis:'Net resi area', qty:m.nsf, u:'SF', p:12, mh:0.07, trade:'carpenter', src:'Modify/fire-treat existing'},
      {n:'Blocking, backing, rough carpentry', basis:'Net area × 0.5', qty:m.nsf*0.5, u:'SF', p:3.5, mh:0.03, trade:'carpenter', src:'Backing for fixtures'},
    ]});
  }

  // common divisions
  divs.push({div:'05 · Metals', items:[
    {n:'Egress stairs (steel pan + concrete)', basis:'2 stairs', qty:2, u:'EA', p:95000, mh:280, trade:'ironworker', src:'Full-height egress stairs'},
    {n:'Misc metals — railings, guards', basis:'2 stairs × floors × 14 LF', qty:2*m.floors*14, u:'LF', p:185, mh:0.35, trade:'ironworker', src:'Stair guards per code'},
  ]});

  divs.push({div:'07 · Thermal & Moisture', items:[
    {n:'Roofing membrane', basis:'Footprint + bulkhead', qty:m.footprint+800, u:'SF', p:22, mh:0.04, trade:'roofer', src:'EPDM/mod-bit'},
    {n:'Roof insulation', basis:'Footprint + bulkhead', qty:m.footprint+800, u:'SF', p:6.5, mh:0.02, trade:'roofer', src:'R-30 polyiso'},
    !isNew && {n:'Exterior wall insulation (int. face)', basis:'Perim × ht × floors × 85%', qty:m.perim*m.f2f*m.floors*0.85, u:'SF', p:12, mh:0.05, trade:'insulation', src:'Rigid + mineral wool'},
    {n:'Caulking & sealants', basis:'Lump', qty:1, u:'LS', p:45000, mh:250, trade:'laborer', src:'Perimeters, joints'},
  ].filter(Boolean)});

  const courtItem = m.court ? [{n:'Inner court / curtain wall system', basis:'Lump', qty:1, u:'LS', p:185000, mh:550, trade:'glazier', src:'Light-well glazing'}] : [];
  divs.push({div:'08 · Openings (Doors & Windows)', items:[
    !isNew && {n:'Windows (replacement)', basis:'Count from schedule', qty:m.windows, u:'EA', p:2750, mh:3, trade:'glazier', src:'Window schedule'},
    {n:'Apartment / entry doors (rated)', basis:'Count from schedule', qty:m.doorsEntry, u:'EA', p:2800, mh:3.5, trade:'carpenter', src:'2HR HM doors'},
    {n:'Stair / fire-rated doors', basis:'Count from schedule', qty:m.doorsStair, u:'EA', p:3200, mh:3.5, trade:'carpenter', src:'Rated HM'},
    {n:'Interior doors', basis:'Count from schedule', qty:m.doorsInt, u:'EA', p:850, mh:1.3, trade:'carpenter', src:'WD doors'},
    ...courtItem,
  ].filter(Boolean)});

  divs.push({div:'09 · Finishes', items:[
    {n:'Metal stud partition framing', basis:'Net area × 0.95 LF/SF', qty:m.nsf*PARTFACTOR, u:'LF', p:9.8, mh:0.11, trade:'drywall', src:'3-5/8" steel stud · mkt-adj −30%'},
    {n:'Gypsum board (5/8" Type X)', basis:'Partition LF × ht × 2 + ceilings', qty:(m.nsf*PARTFACTOR*wallht*2)+m.nsf, u:'SF', p:2.28, mh:0.016, trade:'drywall', src:'Both faces + ceiling · mkt-adj −30%'},
    {n:'Porcelain tile — bath & kitchen', basis:'Units × 120 SF', qty:m.units*120, u:'SF', p:19.6, mh:0.14, trade:'tile', src:'Bath/kitchen tile · mkt-adj −30%'},
    {n:'Resilient flooring (LVT)', basis:'Net area − tile area', qty:Math.max(m.nsf-m.units*120,0), u:'SF', p:9.8, mh:0.025, trade:'flooring', src:'Living/bedroom · mkt-adj −30%'},
    {n:'Painting — walls & ceilings', basis:'GWB area', qty:(m.nsf*PARTFACTOR*wallht*2)+m.nsf, u:'SF', p:1.30, mh:0.011, trade:'painter', src:'2 coats · mkt-adj −30%'},
    {n:'Specialty ceilings / soffits', basis:'≈40 LF per unit', qty:m.units*40, u:'LF', p:129.5, mh:0.28, trade:'drywall', src:'HVAC soffits · mkt-adj −30%'},
  ]});

  divs.push({div:'11 · Kitchens, Baths & Appliances', items:[
    {n:'Kitchen casework & countertops', basis:'Per unit', qty:m.units, u:'EA', p:12000, mh:15, trade:'millwork', src:'Mid-grade'},
    {n:'Bathroom vanities & accessories', basis:'≈1.6 baths/unit', qty:m.units*1.6, u:'EA', p:3200, mh:5, trade:'millwork', src:'incl ADA reinf'},
    {n:'Appliance packages', basis:'Per unit', qty:m.units, u:'EA', p:4500, mh:3.5, trade:'laborer', src:'Range, fridge, DW'},
  ]});

  if(m.elev>0) divs.push({div:'14 · Conveying', items:[
    {n:'Passenger elevator', basis:'Count', qty:m.elev, u:'EA', p:185000, mh:380, trade:'elevator', src:'Multi-stop'},
  ]});

  divs.push({div:'21/22 · Plumbing & Fire Protection', items:[
    {n:'Plumbing systems (units, risers, common, DHW)', basis:'GFA SF · $13/SF (set)', qty:m.gfa, u:'SF', p:13, fixed:true, mh:0.05, trade:'plumber', src:'$13/SF flat'},
    {n:'Fire sprinkler (NFPA 13R)', basis:'GFA SF · $6/SF (set)', qty:m.gfa, u:'SF', p:6, fixed:true, mh:0.02, trade:'sprinkler', src:'$6/SF flat'},
  ]});

  divs.push({div:'23 · HVAC / Mechanical', items:[
    {n:'Outdoor condensing units', basis:'Count from schedule', qty:m.cu, u:'EA', p:5500, mh:15, trade:'hvac', src:'Roof condensers (avg)'},
    {n:'Indoor air handlers / cassettes', basis:'Count from schedule', qty:m.ah, u:'EA', p:1700, mh:9, trade:'hvac', src:'Per unit zones (avg)'},
    {n:'Exhaust fans (kitchen + bath)', basis:'Count from schedule', qty:m.exh, u:'EA', p:320, mh:4, trade:'hvac', src:'Vented to roof'},
    {n:'Refrigerant piping & insulation', basis:'Per indoor unit', qty:m.ah, u:'EA', p:1200, mh:11, trade:'hvac', src:'R-410A insulated'},
    {n:'Exhaust ductwork & goosenecks', basis:'Per exhaust fan', qty:m.exh, u:'EA', p:2200, mh:9, trade:'hvac', src:'Roof terminations'},
    {n:'Install, controls, balancing (TAB)', basis:'Lump', qty:1, u:'LS', p:95000, mh:380, trade:'hvac', src:'Commissioning'},
  ]});

  divs.push({div:'26 · Electrical', items:[
    {n:'Electrical (service, distribution, units, fixtures, fire alarm)', basis:'GFA SF · $12/SF (set)', qty:m.gfa, u:'SF', p:12, fixed:true, mh:0.05, trade:'electrician', src:'$12/SF flat'},
  ]});

  return divs;
}

/* ============ LABOR & SCHEDULE COMPUTATION ============ */
function computeLabor(divs){
  const laborMult=+getV('labor-mult')||1;
  const rows=[];           // per-division summary
  const phaseMap={};       // phase -> {hrs, cost, days(max), divs:[]}
  let totHrs=0, totCost=0;

  divs.forEach(d=>{
    const code=d.div.split('·')[0].trim();
    const sched=DIV_SCHED[code]||{crew:4,phase:5};
    let hrs=0, cost=0;
    d.items.forEach(it=>{
      const h=(it.qty||0)*(it.mh||0);
      const rate=(TRADE_RATE[it.trade]||90)*laborMult;
      hrs+=h; cost+=h*rate;
    });
    const days=sched.crew>0 ? hrs/(sched.crew*HRS_PER_DAY) : 0;
    const row={code, name:d.div.split('·').slice(1).join('·').trim(), hrs, crew:sched.crew, days, cost, phase:sched.phase};
    rows.push(row);
    totHrs+=hrs; totCost+=cost;
    const ph=phaseMap[sched.phase]||(phaseMap[sched.phase]={hrs:0,cost:0,maxDays:0,divs:[]});
    ph.hrs+=hrs; ph.cost+=cost; ph.maxDays=Math.max(ph.maxDays,days); ph.divs.push(row);
  });

  // Phase list sorted; project duration = sum of phase critical durations
  const phases=Object.keys(phaseMap).map(Number).sort((a,b)=>a-b).map(p=>({
    phase:p, name:PHASE_NAMES[p]||('Phase '+p),
    hrs:phaseMap[p].hrs, cost:phaseMap[p].cost,
    days:Math.ceil(phaseMap[p].maxDays), divs:phaseMap[p].divs
  }));
  const projWorkDays=phases.reduce((s,p)=>s+p.days,0);

  return {rows, phases, totHrs, totLaborCost:totCost, projWorkDays, laborMult};
}

function recalc(){
  const m=metrics();
  const locMult=m.boro*m.ctype*m.occ;
  const divs=buildTakeoff(m);
  const tbody=document.getElementById('takeoff-body');
  let direct=0, lineCount=0;
  const exportRows=[];
  let html='';
  divs.forEach(d=>{
    html+=`<tr class="divhdr"><td colspan="6">${d.div}</td></tr>`;
    let dtotal=0;
    d.items.forEach(it=>{
      const ext=it.fixed ? it.qty*it.p : it.qty*it.p*locMult;
      dtotal+=ext; direct+=ext; lineCount++;
      html+=`<tr><td>${it.n}</td><td class="basis">${it.basis}</td><td class="num">${fmtN(it.qty)}</td><td>${it.u}</td><td class="num">${fmtM(it.p)}</td><td class="num">${fmtM(ext)}</td></tr>`;
      exportRows.push({div:d.div, name:it.n, basis:it.basis, qty:it.qty, unit:it.u, price:it.p, loc:(it.fixed?1:locMult), ext:ext, src:it.src, mh:it.mh, trade:it.trade});
    });
    html+=`<tr class="subtot"><td colspan="5">${d.div.split('·')[0].trim()} subtotal</td><td class="num">${fmtM(dtotal)}</td></tr>`;
  });
  tbody.innerHTML=html;

  const gcPct=+getV('gc-pct')||0, opPct=+getV('op-pct')||0, contPct=+getV('cont-pct')||0;
  const gc=direct*gcPct/100, op=(direct+gc)*opPct/100, pre=direct+gc+op, cont=pre*contPct/100, grand=pre+cont;
  const psf=m.gfa>0?grand/m.gfa:0;

  setT('t-direct',fmtM(direct)); setT('t-gc',fmtM(gc)); setT('t-op',fmtM(op));
  setT('t-cont',fmtM(cont)); setT('t-grand',fmtM(grand));
  setT('gc-l',gcPct); setT('op-l',opPct);
  setT('s-total','$'+(grand/1e6).toFixed(2)+'M'); setT('s-psf','$'+Math.round(psf));
  setT('s-unit',m.units>0?'$'+Math.round(grand/m.units/1000)+'K':'—'); setT('s-units',m.units+' units');
  setT('s-lines',lineCount);
  const bench=document.getElementById('s-bench');
  if(bench){
    if(m.worktype==='new') bench.textContent = psf<300?'below NYC ground-up':psf<=800?'within $300-800/SF':'above typical';
    else bench.textContent = psf<250?'below NYC reno':psf<=600?'within $250-600/SF':'above typical';
  }

  /* ----- Scope of Work: labor & schedule ----- */
  const lab=computeLabor(divs);
  lastLabor=lab;
  renderLabor(lab);

  lastRows=exportRows; lastTotals={direct,gc,op,cont,grand,psf,gcPct,opPct,contPct,m};
}

function renderLabor(lab){
  // schedule table grouped by phase
  const body=document.getElementById('labor-body');
  if(body){
    let html='';
    lab.phases.forEach(ph=>{
      html+=`<tr class="divhdr"><td colspan="5">Phase ${ph.phase} · ${ph.name}</td></tr>`;
      ph.divs.forEach(r=>{
        html+=`<tr><td>${r.code} · ${r.name}</td><td class="num">${fmtN(r.hrs)}</td><td class="num">${r.crew}</td><td class="num">${fmtN(r.days)}</td><td class="num">${fmtM(r.cost)}</td></tr>`;
      });
      html+=`<tr class="subtot"><td>Phase ${ph.phase} — critical duration ${ph.days} work-days</td><td class="num">${fmtN(ph.hrs)}</td><td></td><td class="num">${ph.days}</td><td class="num">${fmtM(ph.cost)}</td></tr>`;
    });
    body.innerHTML=html;
  }
  const wkCal=lab.projWorkDays/5; // 5-day work weeks
  setT('l-hours', Math.round(lab.totHrs).toLocaleString()+' hrs');
  setT('l-cost', fmtM(lab.totLaborCost));
  setT('l-days', lab.projWorkDays+' work-days');
  setT('l-cal', '≈ '+wkCal.toFixed(1)+' wks ('+(lab.projWorkDays/21).toFixed(1)+' mo)');
}

/* ============ EXCEL EXPORT (SheetJS) ============ */
// Load the Excel library only when needed (keeps the page free of load-time
// external dependencies, so it renders reliably even in sandboxed previews).
function ensureXLSX(){
  return new Promise((resolve,reject)=>{
    if(typeof XLSX!=='undefined' && XLSX.utils) return resolve();
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload=()=>resolve();
    s.onerror=()=>reject(new Error('Could not load the Excel library (no internet connection?).'));
    document.head.appendChild(s);
  });
}
async function exportExcel(){
  try{ await ensureXLSX(); }
  catch(e){ alert(e.message+'\n\nThe on-screen takeoff is unaffected — try the download again with an internet connection.'); return; }
  const {direct,gc,op,cont,grand,psf,gcPct,opPct,contPct,m}=lastTotals;
  const wb=XLSX.utils.book_new();
  const ownerContact=[getV('m-owner-phone'),getV('m-owner-email')].filter(Boolean).join(' / ')||'—';

  // Sheet 1: Inputs
  const inAOA=[
    ['MATERIAL TAKEOFF — INPUTS & ASSUMPTIONS'],
    [getV('m-name')||'Project', '', '', 'DOB Job# '+(getV('m-job')||'')],
    ['Property address: '+(getV('m-address')||'—')],
    ['Owner / entity: '+(getV('m-owner-name')||'—')],
    ['Owner mailing address: '+(getV('m-owner-address')||'—')],
    ['Owner contact: '+ownerContact],
    [],
    ['Building metric','Value','Unit'],
    ['Total GFA',m.gfa,'SF'],['Net residential SF',m.nsf,'SF'],['Footprint / floor',m.footprint,'SF'],
    ['Floors',m.floors,'ea'],['Cellar',m.cellar?'Yes':'No',''],['Dwelling units',m.units,'ea'],
    ['Floor-to-floor',m.f2f,'ft'],['Perimeter',m.perim,'LF'],
    [],
    ['Schedule counts','Value'],
    ['Windows',m.windows],['Entry doors',m.doorsEntry],['Stair/fire doors',m.doorsStair],
    ['Interior doors',m.doorsInt],['HVAC condensers',m.cu],['HVAC indoor units',m.ah],
    ['Exhaust fans',m.exh],['Elevators',m.elev],
    [],
    ['Pricing & markups','Value'],
    ['Borough factor',m.boro],['Construction type factor',m.ctype],['Occupancy factor',m.occ],
    ['Location multiplier (combined)',+(m.boro*m.ctype*m.occ).toFixed(3)],
    ['General conditions %',gcPct/100],['GC overhead & profit %',opPct/100],['Contingency %',contPct/100],
    ['Labor rate adjustment',lastLabor.laborMult||1],
    [],
    ['Quantities are estimate-grade derivations from plan data + standard takeoff factors. Verify vs dimensioned drawings.'],
  ];
  const ws1=XLSX.utils.aoa_to_sheet(inAOA);
  ws1['!cols']=[{wch:34},{wch:14},{wch:10},{wch:24}];
  XLSX.utils.book_append_sheet(wb,ws1,'Inputs');

  // Sheet 2: Material Takeoff
  const toAOA=[['MATERIAL QUANTITY TAKEOFF'],[],
    ['Division','Material / work item','Quantity basis','Qty','Unit','Unit $','Loc adj','Extended $','Source']];
  let curDiv='';
  lastRows.forEach(r=>{
    if(r.div!==curDiv){ toAOA.push([r.div]); curDiv=r.div; }
    toAOA.push(['', r.name, r.basis, +r.qty.toFixed(1), r.unit, r.price, +r.loc.toFixed(3), Math.round(r.ext), r.src]);
  });
  toAOA.push([]);
  toAOA.push(['','DIRECT WORK SUBTOTAL','','','','','','',Math.round(direct)]);
  const ws2=XLSX.utils.aoa_to_sheet(toAOA);
  ws2['!cols']=[{wch:32},{wch:34},{wch:30},{wch:10},{wch:6},{wch:11},{wch:9},{wch:14},{wch:30}];
  XLSX.utils.book_append_sheet(wb,ws2,'Material Takeoff');

  // Sheet 3: Cost Summary
  const byDiv={};
  lastRows.forEach(r=>{ byDiv[r.div]=(byDiv[r.div]||0)+r.ext; });
  const sumAOA=[['COST SUMMARY'],[getV('m-name')||'Project'],
    ['Property address: '+(getV('m-address')||'—')],
    ['Owner / entity: '+(getV('m-owner-name')||'—')],
    [],['Division','Amount','% of direct']];
  Object.entries(byDiv).forEach(([k,v])=>sumAOA.push([k,Math.round(v),direct>0?+(v/direct).toFixed(3):0]));
  sumAOA.push([]);
  sumAOA.push(['Direct work subtotal',Math.round(direct)]);
  sumAOA.push(['General conditions ('+gcPct+'%)',Math.round(gc)]);
  sumAOA.push(['GC overhead & profit ('+opPct+'%)',Math.round(op)]);
  sumAOA.push(['Contingency ('+contPct+'%)',Math.round(cont)]);
  sumAOA.push(['TOTAL ESTIMATED HARD COST',Math.round(grand)]);
  sumAOA.push([]);
  sumAOA.push(['Cost per SF (GFA)',+psf.toFixed(2)]);
  sumAOA.push(['Cost per unit',m.units>0?Math.round(grand/m.units):0]);
  sumAOA.push([]);
  sumAOA.push(['Accuracy ±20-30%, pre-bid. Excludes soft costs (design, filing fees, financing, insurance, FF&E).']);
  const ws3=XLSX.utils.aoa_to_sheet(sumAOA);
  ws3['!cols']=[{wch:42},{wch:16},{wch:12}];
  XLSX.utils.book_append_sheet(wb,ws3,'Cost Summary');

  // Sheet 4: Scope of Work — Labor & Schedule
  const lab=lastLabor;
  const labAOA=[['SCOPE OF WORK — LABOR & SCHEDULE'],[getV('m-name')||'Project'],
    ['Property address: '+(getV('m-address')||'—')],[],
    ['Phase','Division','Labor hrs','Crew','Work-days','Labor $ (loaded)']];
  lab.phases.forEach(ph=>{
    labAOA.push(['Phase '+ph.phase+' · '+ph.name]);
    ph.divs.forEach(r=>{
      labAOA.push(['', r.code+' · '+r.name, Math.round(r.hrs), r.crew, +r.days.toFixed(1), Math.round(r.cost)]);
    });
    labAOA.push(['', 'Phase critical duration', Math.round(ph.hrs), '', ph.days, Math.round(ph.cost)]);
    labAOA.push([]);
  });
  labAOA.push(['TOTALS','', Math.round(lab.totHrs),'', lab.projWorkDays, Math.round(lab.totLaborCost)]);
  labAOA.push([]);
  labAOA.push(['Estimated project duration (phased)', lab.projWorkDays+' work-days']);
  labAOA.push(['Approx. calendar', (lab.projWorkDays/5).toFixed(1)+' weeks  /  '+(lab.projWorkDays/21).toFixed(1)+' months']);
  labAOA.push(['Labor rate adjustment applied', lab.laborMult]);
  labAOA.push([]);
  labAOA.push(['Man-hours are estimate-grade productivity factors × takeoff quantities. Crews and phase durations are']);
  labAOA.push(['planning-level; trades within a phase run concurrently (phase duration = longest trade). Labor cost shown']);
  labAOA.push(['is the loaded crew cost embedded WITHIN the installed unit prices on the Cost Summary — it is NOT added on top.']);
  const ws4=XLSX.utils.aoa_to_sheet(labAOA);
  ws4['!cols']=[{wch:26},{wch:34},{wch:12},{wch:8},{wch:11},{wch:16}];
  XLSX.utils.book_append_sheet(wb,ws4,'Labor & Schedule');

  const pname=(getV('m-name')||'project').replace(/[^a-z0-9]+/gi,'_').toLowerCase();
  XLSX.writeFile(wb, pname+'_material_takeoff.xlsx');
}

/* ============ FACADE RENDERING (AI image generation) ============ */
function buildFacadePrompt(m,hasReference){
  const styleByType={new:'contemporary new-construction',conversion:'adaptive-reuse conversion',gut:'renovated',partial:'partially renovated'};
  const materialByCtype={1.15:'fireproof masonry and glass curtain wall',1.10:'fireproof masonry',1.0:'masonry and metal panel',
    0.96:'masonry and metal panel',0.93:'masonry with timber accents',0.90:'masonry',0.85:'wood-frame with siding'};
  const occByCode={1.0:'multifamily residential',0.88:'low-rise residential',1.25:'assembly/community',0.92:'retail/mixed-use',1.42:'institutional'};
  const boroNames={1:'Manhattan',0.92:'Brooklyn',0.90:'Queens',0.86:'the Bronx',0.84:'Staten Island'};
  const address=getV('m-address')||getV('m-name')||'a New York City building';
  const worktype=styleByType[m.worktype]||'new construction';
  const material=materialByCtype[m.ctype]||'masonry';
  const occupancy=occByCode[m.occ]||'residential';
  const boro=boroNames[m.boro]||'New York City';
  const lead=hasReference
    ? 'Using the attached architectural elevation drawing as the exact massing, proportions, and fenestration reference, produce a photorealistic exterior rendering of the building it depicts (not a redesign) — '
    : 'Photorealistic architectural exterior rendering, eye-level street view, daytime, clear sky. ';
  return lead+`A ${m.floors}-story ${worktype} ${occupancy} building at ${address} in ${boro}, New York City. Facade material: ${material}. `+
    (m.units?`Approximately ${m.units} units. `:'')+
    (m.windows?`Roughly ${m.windows} punched or curtain-wall windows arranged in a regular grid. `:'')+
    `NYC streetscape context with sidewalk, street trees, and adjacent rowhouses/buildings. Clean modern architectural visualization style, sharp detail, natural lighting, no people, no text or watermarks.`;
}

// One <option> per rasterized plan page across all uploaded files, so the
// user can pick the actual elevation sheet as a visual reference.
function populateFacadeRefOptions(){
  const sel=document.getElementById('facade-ref');
  if(!sel) return;
  const opts=['<option value="">No reference (text description only)</option>'];
  files.forEach((entry,fi)=>{
    if(entry.status==='done'&&entry.images&&entry.images.length){
      entry.images.forEach((img,pi)=>{
        opts.push(`<option value="${fi}:${pi}">${entry.name} — page ${pi+1}</option>`);
      });
    }
  });
  sel.innerHTML=opts.join('');
}

async function generateFacadeRendering(){
  const btn=document.getElementById('facade-btn');
  const wrap=document.getElementById('facade-result');
  const img=document.getElementById('facade-img');
  const dl=document.getElementById('facade-download');
  const err=document.getElementById('facade-error');
  const refSel=document.getElementById('facade-ref');
  if(err) err.textContent='';
  if(!lastTotals||!lastTotals.m){ if(err) err.textContent='Run the takeoff first so building details are available.'; return; }
  let referenceImage=null;
  if(refSel&&refSel.value){
    const [fi,pi]=refSel.value.split(':').map(Number);
    const entry=files[fi];
    if(entry&&entry.images&&entry.images[pi]) referenceImage='data:image/jpeg;base64,'+entry.images[pi];
  }
  const origLabel=btn.textContent;
  btn.disabled=true; btn.textContent='Generating rendering…';
  try{
    const prompt=buildFacadePrompt(lastTotals.m,!!referenceImage);
    const resp=await fetch('/.netlify/functions/render-facade',{
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt,referenceImage})
    });
    const data=await resp.json().catch(()=>({}));
    if(!resp.ok) throw new Error(data.error||('Request failed ('+resp.status+')'));
    if(!data.image) throw new Error('No image returned');
    const src='data:image/png;base64,'+data.image;
    img.src=src; dl.href=src;
    const pname=(getV('m-name')||getV('m-address')||'facade').replace(/[^a-z0-9]+/gi,'_').toLowerCase();
    dl.download=pname+'_facade_rendering.png';
    wrap.classList.remove('hidden');
  }catch(e){
    if(err) err.textContent='Rendering failed: '+e.message+'. This needs the render-facade Netlify function deployed with a valid OPENAI_API_KEY.';
  }finally{
    btn.disabled=false; btn.textContent=origLabel;
  }
}

/* ============ NAV / HELPERS ============ */
function goToResults(){ hide('step-2'); show('step-3'); setChip(3); recalc(); populateFacadeRefOptions(); }
function backToVerify(){ hide('step-3'); show('step-2'); setChip(2); }
function backToUpload(){ hide('step-2'); show('step-1'); setChip(1); }
function setChip(n){
  for(let i=1;i<=3;i++){
    const c=document.getElementById('chip-'+i);
    c.classList.toggle('active',i===n);
    c.classList.toggle('done',i<n);
  }
}
function show(id){document.getElementById(id).classList.remove('hidden');}
function hide(id){document.getElementById(id).classList.add('hidden');}
function getV(id){const e=document.getElementById(id); return e?e.value:'';}
function setV(id,v){const e=document.getElementById(id); if(e)e.value=v;}
function setSel(id,val){
  const e=document.getElementById(id); if(!e) return;
  e.value=String(val);
  if(e.value!==String(val) && e.options){ // numeric mismatch (e.g. 1 vs 1.0): match by float
    for(const o of e.options){ if(parseFloat(o.value)===parseFloat(val)){ e.value=o.value; break; } }
  }
}
function setT(id,v){const e=document.getElementById(id); if(e)e.textContent=v;}
function fmtM(n){return '$'+Math.round(n).toLocaleString();}
function fmtN(n){return (Math.round(n*10)/10).toLocaleString();}

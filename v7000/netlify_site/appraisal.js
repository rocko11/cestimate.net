/* ============ APPRAISAL REPORT — three approaches to value ============
   Cost approach (land + replacement cost new − depreciation),
   Sales comparison approach (adjusted comps → $/SF and $/unit),
   Income capitalization approach (NOI ÷ cap rate, GRM cross-check),
   reconciled into one opinion of value. The cost approach reads the
   replacement cost straight from the takeoff; everything else is entered
   by the user and saved in the browser per project. */

const APR_KEY='restimator_appraisal_v1';
const COMP_COUNT=6;

function aprDefaults(){
  return {
    purpose:'Prospective market value upon completion', interest:'Fee simple', date:new Date().toISOString().slice(0,10), address:'',
    lotSF:0, landPSF:0, landValue:0, siteImp:0,
    softPct:20, incentivePct:15, effAge:0, econLife:60, funcPct:0, extPct:0,
    comps:Array.from({length:COMP_COUNT},()=>({addr:'',date:'',price:0,sf:0,units:0,adj:0})),
    rentUnit:0, otherInc:0, vacPct:5, opexPct:35, capRate:6, grm:0,
    wCost:30, wSales:40, wIncome:30, notes:'', condition:null, market:null, marketNote:''
  };
}
function aprLoad(name){
  try{ const all=JSON.parse(localStorage.getItem(APR_KEY)||'{}'); const d=all[name||'_']; if(d) return Object.assign(aprDefaults(),d); }catch(e){}
  return aprDefaults();
}
function aprSave(name,d){
  try{ const all=JSON.parse(localStorage.getItem(APR_KEY)||'{}'); all[name||'_']=d; localStorage.setItem(APR_KEY,JSON.stringify(all)); }catch(e){}
}
function aprProjName(){ try{ return (getV('m-name')||'').trim()||'_'; }catch(e){ return '_'; } }

let apr=null;

function openAppraisal(){
  if(!lastTotals||!lastTotals.m){ alert('Run the takeoff first.'); return; }
  apr=aprLoad(aprProjName());
  renderAppraisalForm();
  renderAppraisal();
  hide('step-3'); show('step-8'); window.scrollTo(0,0); track('appraisal_opened');
}
function backFromAppraisal(){ hide('step-8'); show('step-3'); }

/* ---------- form ---------- */
const ai=(id,label,val,opt)=>`<div class="field"><label>${label}${opt&&opt.hint?` <span class="hint">${opt.hint}</span>`:''}</label><input id="apr-${id}" type="${opt&&opt.type||'number'}" ${opt&&opt.step?`step="${opt.step}"`:''} value="${esc(val==null?'':val)}" oninput="aprChange()"></div>`;

function renderAppraisalForm(){
  const d=apr, m=lastTotals.m;
  const comps=d.comps.map((c,i)=>`<tr>
    <td>${i+1}</td>
    <td><input id="apr-c${i}-addr" value="${esc(c.addr)}" oninput="aprChange()" placeholder="Address"></td>
    <td><input id="apr-c${i}-date" type="date" value="${esc(c.date)}" oninput="aprChange()"></td>
    <td><input id="apr-c${i}-price" type="number" value="${c.price||''}" oninput="aprChange()" placeholder="$"></td>
    <td><input id="apr-c${i}-sf" type="number" value="${c.sf||''}" oninput="aprChange()" placeholder="GBA"></td>
    <td><input id="apr-c${i}-units" type="number" value="${c.units||''}" oninput="aprChange()"></td>
    <td><input id="apr-c${i}-adj" type="number" step="0.5" value="${c.adj||0}" oninput="aprChange()" title="Net adjustment, % (time, location, condition, size…). Positive = comp inferior to subject."></td>
  </tr>`).join('');
  document.getElementById('apr-form').innerHTML=`
    <div class="card">
      <h3 style="margin:0 0 .6rem">Assignment</h3>
      <div class="grid4">
        ${ai('purpose','Purpose / premise',d.purpose,{type:'text'})}
        ${ai('interest','Property interest',d.interest,{type:'text'})}
        ${ai('date','Effective date',d.date,{type:'date'})}
        <div class="field"><label>Subject (from takeoff)</label><input value="${esc(m.gfa.toLocaleString())} SF GBA · ${m.units} units · ${m.floors} fl" disabled></div>
        ${ai('address','Property address',d.address||aprGuessAddress(),{type:'text',hint:'street + borough'})}
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="comps-btn" onclick="findComps()">🔎 Find comps &amp; land value</button></div>
        <div class="field" style="grid-column:span 2"><label>&nbsp;</label><span id="comps-status" style="font-size:12px;color:var(--muted)">${d.market?'Market data pulled '+new Date(d.market.fetched).toLocaleString('en-US')+' · '+d.market.comps.length+' building sales, '+d.market.land.comps.length+' land sales within '+d.market.months+' months':'Pulls NYC DOF recorded sales and PLUTO lot data for the address, fills the comps below and sets land value.'}</span></div>
      </div>
    </div>
    ${condSection(d)}
    <div class="card">
      <h3 style="margin:0 0 .6rem">1 · Cost approach</h3>
      <div class="grid4">
        ${ai('lotSF','Lot area (SF)',d.lotSF)}
        ${ai('landPSF','Land value ($/SF of lot)',d.landPSF,{hint:'or enter total below'})}
        ${ai('landValue','Land value ($ total)',d.landValue,{hint:'overrides $/SF'})}
        ${ai('siteImp','Site improvements ($)',d.siteImp,{hint:'paving, landscaping, utilities'})}
        ${ai('softPct','Soft costs (% of hard)',d.softPct,{step:'0.5'})}
        ${ai('incentivePct','Entrepreneurial incentive (%)',d.incentivePct,{step:'0.5'})}
        ${ai('effAge','Effective age (yrs)',d.effAge)}
        ${ai('econLife','Economic life (yrs)',d.econLife)}
        ${ai('funcPct','Functional obsolescence (%)',d.funcPct,{step:'0.5'})}
        ${ai('extPct','External obsolescence (%)',d.extPct,{step:'0.5'})}
      </div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 .6rem">2 · Sales comparison approach</h3>
      <table class="prop-table" style="font-size:12px">
        <thead><tr><th>#</th><th>Comparable sale</th><th>Date</th><th>Sale price</th><th>GBA SF</th><th>Units</th><th>Net adj. %</th></tr></thead>
        <tbody>${comps}</tbody>
      </table>
      <div class="hint" style="font-size:11px;color:var(--muted);margin-top:4px">${d.market?'Filled from NYC DOF recorded sales (adjustments suggested for market time +3%/yr and size; edit as needed). ':''}Net adjustment: + when the comp is inferior to the subject (older, worse location, earlier sale), − when superior. Leave rows blank to skip.</div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 .6rem">3 · Income capitalization approach</h3>
      <div class="grid4">
        ${ai('rentUnit','Avg. monthly rent / unit ($)',d.rentUnit)}
        ${ai('otherInc','Other income / yr ($)',d.otherInc,{hint:'laundry, parking, storage'})}
        ${ai('vacPct','Vacancy & collection loss (%)',d.vacPct,{step:'0.5'})}
        ${ai('opexPct','Operating expenses (% of EGI)',d.opexPct,{step:'0.5'})}
        ${ai('capRate','Capitalization rate (%)',d.capRate,{step:'0.05'})}
        ${ai('grm','Gross rent multiplier',d.grm,{step:'0.1',hint:'optional cross-check'})}
      </div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 .6rem">Reconciliation weights</h3>
      <div class="grid4">
        ${ai('wCost','Cost approach (%)',d.wCost)}
        ${ai('wSales','Sales comparison (%)',d.wSales)}
        ${ai('wIncome','Income approach (%)',d.wIncome)}
        ${ai('notes','Appraiser notes',d.notes,{type:'text'})}
      </div>
    </div>`;
}

function aprChange(){
  const g=id=>{ const e=document.getElementById('apr-'+id); return e?e.value:''; };
  const n=id=>+g(id)||0;
  ['purpose','interest','date','notes','address'].forEach(k=>apr[k]=g(k));
  ['lotSF','landPSF','landValue','siteImp','softPct','incentivePct','effAge','econLife','funcPct','extPct',
   'rentUnit','otherInc','vacPct','opexPct','capRate','grm','wCost','wSales','wIncome'].forEach(k=>apr[k]=n(k));
  apr.comps=apr.comps.map((c,i)=>({addr:g('c'+i+'-addr'),date:g('c'+i+'-date'),price:n('c'+i+'-price'),sf:n('c'+i+'-sf'),units:n('c'+i+'-units'),adj:n('c'+i+'-adj')}));
  aprSave(aprProjName(),apr);
  renderAppraisal();
}

/* ---------- valuation math ---------- */
function appraise(d,t){
  const m=t.m;
  const hard=t.marginPct>0?t.sell:t.grand;                        // hard cost as the client would pay it
  const soft=hard*d.softPct/100;
  const incentive=(hard+soft)*d.incentivePct/100;
  const rcn=hard+soft+incentive;                                    // replacement cost new (improvements)
  const physPct=d.econLife>0?Math.min(1,Math.max(0,d.effAge/d.econLife)):0;
  const phys=rcn*physPct, func=(rcn-phys)*d.funcPct/100, ext=(rcn-phys-func)*d.extPct/100;
  const depr=phys+func+ext;
  const land=d.landValue>0?d.landValue:d.lotSF*d.landPSF;
  const c=d.condition, cure=condCure(c), condAdj=c?Math.max(-25,Math.min(0,+c.condition_adjustment_pct||0)):0;
  const cost={hard,soft,incentive,rcn,physPct,phys,func,ext,depr,land,siteImp:d.siteImp,cure,value:land+d.siteImp+rcn-depr-cure};

  const comps=d.comps.filter(c=>c.price>0&&(c.sf>0||c.units>0)).map(c=>{
    const adjPrice=c.price*(1+c.adj/100);
    return Object.assign({},c,{adjPrice,psf:c.sf>0?adjPrice/c.sf:0,pu:c.units>0?adjPrice/c.units:0});
  });
  const psfs=comps.filter(c=>c.psf>0).map(c=>c.psf), pus=comps.filter(c=>c.pu>0).map(c=>c.pu);
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  const psf=avg(psfs), pu=avg(pus);
  const bySF=psf*m.gfa, byUnit=pu*m.units;
  const salesRaw=bySF>0&&byUnit>0?(bySF+byUnit)/2:(bySF||byUnit);
  const sales={comps,psf,pu,bySF,byUnit,raw:salesRaw,condAdj,value:salesRaw>0?salesRaw*(1+condAdj/100)-cure:0,
    range:psfs.length?[Math.min(...psfs)*m.gfa,Math.max(...psfs)*m.gfa]:null};

  const pgi=d.rentUnit*12*m.units+d.otherInc;
  const vac=pgi*d.vacPct/100, egi=pgi-vac, opex=egi*d.opexPct/100, noi=egi-opex;
  const byCap=d.capRate>0?noi/(d.capRate/100):0, byGRM=d.grm>0?(d.rentUnit*12*m.units)*d.grm:0;
  const incRaw=byCap||byGRM;
  const income={pgi,vac,egi,opex,noi,byCap,byGRM,raw:incRaw,value:incRaw>0?incRaw-cure:0};

  const w=[[cost.value,d.wCost],[sales.value,d.wSales],[income.value,d.wIncome]].filter(x=>x[0]>0&&x[1]>0);
  const wsum=w.reduce((a,x)=>a+x[1],0);
  const final=wsum>0?w.reduce((a,x)=>a+x[0]*x[1],0)/wsum:0;
  const rounded=Math.round(final/10000)*10000;
  return {cost,sales,income,final,rounded,wsum,cure,condAdj};
}

/* ---------- report ---------- */
function renderAppraisal(){
  const t=lastTotals, m=t.m, d=apr, r=appraise(d,t);
  const pct=x=>(x||0).toFixed(1)+'%';
  const row=(k,v,cls)=>`<tr${cls?` class="${cls}"`:''}><td>${k}</td><td class="num">${v}</td></tr>`;
  const effDate=d.date?new Date(d.date+'T12:00:00').toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}):'—';
  const wt={new:'New construction',conversion:'Adaptive reuse / conversion',gut:'Full gut renovation',partial:'Partial renovation'}[m.worktype]||m.worktype;
  const used=[['Cost approach',r.cost.value,d.wCost],['Sales comparison approach',r.sales.value,d.wSales],['Income capitalization approach',r.income.value,d.wIncome]];

  const compRows=r.sales.comps.length?r.sales.comps.map((c,i)=>`<tr><td>${i+1}</td><td>${esc(c.addr||'—')}</td><td>${esc(c.date||'—')}</td><td class="num">${fmtM(c.price)}</td><td class="num">${c.sf?c.sf.toLocaleString():'—'}</td><td class="num">${c.units||'—'}</td><td class="num">${c.adj>0?'+':''}${c.adj}%</td><td class="num">${fmtM(c.adjPrice)}</td><td class="num">${c.psf?fmtM(c.psf):'—'}</td><td class="num">${c.pu?fmtM(c.pu):'—'}</td></tr>`).join('')
    :`<tr><td colspan="10" style="color:var(--muted)">No comparable sales entered — the sales comparison approach is not developed.</td></tr>`;

  document.getElementById('appraisal').innerHTML=`
    <div class="prop-head">
      <h2>Appraisal Report</h2>
      <div class="prop-sub">${esc(getV('m-name')||'Subject property')}${getV('m-job')?' · DOB Job #'+esc(getV('m-job')):''} · ${esc(d.purpose||'Market value')} · ${esc(d.interest)} · Effective date ${effDate}</div>
    </div>

    <div class="prop-hero">
      <div><div class="metric-label">Reconciled opinion of value</div><div class="prop-price">${r.rounded>0?fmtM(r.rounded):'—'}</div><div class="metric-sub">${r.rounded>0?fmtM(r.rounded/Math.max(m.gfa,1))+' / SF GBA · '+(m.units?fmtM(r.rounded/m.units)+' / unit':''):'enter inputs to develop value'}</div></div>
      <div><div class="metric-label">Subject</div><div style="color:#fff;font-size:14px;line-height:1.5">${m.gfa.toLocaleString()} SF GBA · ${m.nsf.toLocaleString()} SF net<br>${m.units} units · ${m.floors} stories${m.cellar?' + cellar':''}<br>${esc(wt)} · ${m.footprint.toLocaleString()} SF footprint</div></div>
    </div>

    <h3>Summary of the three approaches</h3>
    <table class="prop-table">
      <thead><tr><th>Approach</th><th class="num">Indicated value</th><th class="num">$ / SF</th><th class="num">Weight</th></tr></thead>
      <tbody>${used.map(([k,v,w])=>`<tr><td>${k}</td><td class="num">${v>0?fmtM(v):'not developed'}</td><td class="num">${v>0?fmtM(v/Math.max(m.gfa,1)):'—'}</td><td class="num">${v>0?pct(w):'—'}</td></tr>`).join('')}
      <tr class="subtot"><td>Reconciled value (rounded to $10,000)</td><td class="num"><b>${r.rounded>0?fmtM(r.rounded):'—'}</b></td><td class="num">${r.rounded>0?fmtM(r.rounded/Math.max(m.gfa,1)):'—'}</td><td class="num">${r.wsum?pct(r.wsum):'—'}</td></tr></tbody>
    </table>

    ${marketReport(d,r)}
    ${condReport(d.condition,m)}

    <h3>1 · Cost approach</h3>
    <p style="font-size:13px">Replacement cost new of the improvements is taken from this estimate (${t.marginPct>0?'sell price incl. margin':'total with GC, OH&amp;P and contingency'}), plus soft costs and entrepreneurial incentive; accrued depreciation is deducted and land value added.</p>
    <table class="prop-table"><tbody>
      ${row('Hard construction cost (this estimate)',fmtM(r.cost.hard))}
      ${row('Soft costs @ '+pct(d.softPct),fmtM(r.cost.soft))}
      ${row('Entrepreneurial incentive @ '+pct(d.incentivePct),fmtM(r.cost.incentive))}
      ${row('<b>Replacement cost new (RCN)</b>','<b>'+fmtM(r.cost.rcn)+'</b> · '+fmtM(r.cost.rcn/Math.max(m.gfa,1))+'/SF')}
      ${row('Less physical depreciation ('+d.effAge+' / '+d.econLife+' yrs = '+pct(r.cost.physPct*100)+')','('+fmtM(r.cost.phys)+')')}
      ${row('Less functional obsolescence @ '+pct(d.funcPct),'('+fmtM(r.cost.func)+')')}
      ${row('Less external obsolescence @ '+pct(d.extPct),'('+fmtM(r.cost.ext)+')')}
      ${row('Depreciated value of improvements',fmtM(r.cost.rcn-r.cost.depr))}
      ${row('Plus site improvements',fmtM(r.cost.siteImp))}
      ${r.cure>0?row('Less cost to cure deferred maintenance (photo inspection)','('+fmtM(r.cure)+')'):''}
      ${row('Plus land value'+(d.landValue>0?'':d.lotSF&&d.landPSF?' ('+d.lotSF.toLocaleString()+' SF × '+fmtM(d.landPSF)+'/SF)':''),fmtM(r.cost.land))}
      ${row('<b>Indicated value — cost approach</b>','<b>'+fmtM(r.cost.value)+'</b>','subtot')}
    </tbody></table>
    ${r.cost.land<=0?'<div style="font-size:12px;color:#B45309;margin-top:4px">⚠ Land value not entered — the cost approach reflects improvements only.</div>':''}

    <h3>2 · Sales comparison approach</h3>
    <table class="prop-table">
      <thead><tr><th>#</th><th>Comparable</th><th>Date</th><th class="num">Sale price</th><th class="num">GBA SF</th><th class="num">Units</th><th class="num">Net adj.</th><th class="num">Adjusted price</th><th class="num">Adj. $/SF</th><th class="num">Adj. $/unit</th></tr></thead>
      <tbody>${compRows}</tbody>
    </table>
    ${r.sales.comps.length?`<table class="prop-table" style="margin-top:8px"><tbody>
      ${row('Average adjusted $/SF × '+m.gfa.toLocaleString()+' SF',fmtM(r.sales.psf)+'/SF → '+fmtM(r.sales.bySF))}
      ${m.units&&r.sales.pu?row('Average adjusted $/unit × '+m.units+' units',fmtM(r.sales.pu)+'/unit → '+fmtM(r.sales.byUnit)):''}
      ${r.sales.range?row('Indicated range (adjusted $/SF)',fmtM(r.sales.range[0])+' – '+fmtM(r.sales.range[1])):''}
      ${r.condAdj<0?row('Condition adjustment vs. renovated comparables ('+r.condAdj+'%)','('+fmtM(r.sales.raw*-r.condAdj/100)+')'):''}
      ${r.cure>0?row('Less cost to cure (as-is)','('+fmtM(r.cure)+')'):''}
      ${row('<b>Indicated value — sales comparison</b>','<b>'+fmtM(r.sales.value)+'</b>','subtot')}
    </tbody></table>`:''}

    <h3>3 · Income capitalization approach</h3>
    <table class="prop-table"><tbody>
      ${row('Potential gross income ('+m.units+' units × '+fmtM(d.rentUnit)+'/mo × 12'+(d.otherInc?' + other income':'')+')',fmtM(r.income.pgi))}
      ${row('Less vacancy &amp; collection loss @ '+pct(d.vacPct),'('+fmtM(r.income.vac)+')')}
      ${row('Effective gross income',fmtM(r.income.egi))}
      ${row('Less operating expenses @ '+pct(d.opexPct)+' of EGI','('+fmtM(r.income.opex)+')')}
      ${row('<b>Net operating income</b>','<b>'+fmtM(r.income.noi)+'</b>')}
      ${row('Direct capitalization: NOI ÷ '+pct(d.capRate),fmtM(r.income.byCap))}
      ${d.grm>0?row('GRM cross-check: gross rent × '+d.grm,fmtM(r.income.byGRM)):''}
      ${r.cure>0?row('Less cost to cure (as-is)','('+fmtM(r.cure)+')'):''}
      ${row('<b>Indicated value — income approach</b>','<b>'+fmtM(r.income.value)+'</b>','subtot')}
    </tbody></table>
    ${r.income.value<=0?'<div style="font-size:12px;color:#B45309;margin-top:4px">⚠ Enter rent and a cap rate to develop the income approach.</div>':''}

    <h3>Reconciliation</h3>
    <p style="font-size:13px">${aprNarrative(r,d,m)}</p>
    ${d.notes?`<p style="font-size:13px"><b>Appraiser notes:</b> ${esc(d.notes)}</p>`:''}

    <h3>Limiting conditions</h3>
    <ul class="prop-list">
      <li>Replacement cost is derived from the R Estimator takeoff of the plans provided and reflects ${esc(wt).toLowerCase()} hard costs at the stated location and labor rates; it is not a bid.</li>
      <li>Land value, comparable sales, rents, expenses and capitalization rates are user-supplied and have not been independently verified.</li>
      ${d.condition?'<li>Condition ratings and cost-to-cure figures come from an AI review of client-supplied photos and video, not a physical inspection; concealed defects, mechanical systems and code compliance were not verified.</li>':''}
      <li>Where the premise is value upon completion, the value assumes the improvements are built as drawn, lawfully occupied and stabilized.</li>
      <li>This report is a valuation analysis for the client's internal use and is not a USPAP-compliant appraisal unless prepared and signed by a licensed appraiser.</li>
    </ul>
    <div class="prop-sign"><div>Prepared by<br><br>__________________________<br>${esc(getV('m-name')?'R Estimator':'R Estimator')} · ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div><div>Reviewed by<br><br>__________________________<br>Name / license #</div></div>`;
}

function aprNarrative(r,d,m){
  const dev=[['cost',r.cost.value],['sales comparison',r.sales.value],['income',r.income.value]].filter(x=>x[1]>0);
  if(!dev.length) return 'No approach has been developed yet. Enter land value, comparable sales and income inputs above.';
  const parts=dev.map(x=>`the ${x[0]} approach indicates ${fmtM(x[1])}`);
  const vals=dev.map(x=>x[1]), spread=vals.length>1?(Math.max(...vals)-Math.min(...vals))/Math.min(...vals)*100:0;
  let s=parts.join('; ')+'. ';
  if(vals.length>1) s+=`The indications fall within ${spread.toFixed(0)}% of each other${spread>25?', which is a wide spread and suggests one or more inputs should be revisited':''}. `;
  const W={cost:d.wCost,'sales comparison':d.wSales,income:d.wIncome};
  const wtxt=dev.map(x=>W[x[0]]+'% '+x[0]).join(', ');
  s+=`Weighting the approaches ${wtxt} produces a reconciled value of ${fmtM(r.final)}, rounded to <b>${fmtM(r.rounded)}</b>`;
  if(m.units) s+=` (${fmtM(r.rounded/m.units)} per unit, ${fmtM(r.rounded/Math.max(m.gfa,1))} per SF of GBA)`;
  s+='.';
  if(r.cost.value>0&&r.final>0&&r.cost.value>r.final*1.1) s+=' The cost approach exceeds the market indications: the project as designed may cost more to build than it would sell or capitalize for.';
  return s;
}

/* ============ PROPERTY CONDITION — photo & video analysis ============
   The user uploads interior / exterior photos (and optionally video; frames
   are sampled in the browser). Claude vision rates each area, estimates
   effective age, deferred maintenance and cost to cure. Results feed the
   cost approach (effective age, functional obsolescence, cost to cure) and
   an as-is deduction on the market approaches. Photos stay in the browser;
   only the findings are saved. */

let condFiles=[];   // {name,label,src(dataURL 800px),kind:'photo'|'frame'}

function condSection(d){
  const c=d.condition;
  const thumbs=condFiles.map((f,i)=>`<div style="width:110px;font-size:11px">
      <img src="${f.src}" style="width:110px;height:82px;object-fit:cover;border-radius:6px;border:1px solid var(--line)">
      <input placeholder="${f.kind==='frame'?'video frame':'label (Apt 2B, roof…)'}" value="${esc(f.label||'')}" oninput="condFiles[${i}].label=this.value" style="width:100%;font-size:11px;padding:3px 5px;margin-top:3px">
      <a href="#" onclick="condFiles.splice(${i},1);renderCondSection();return false" style="color:var(--muted)">remove</a></div>`).join('');
  return `<div class="card" id="cond-card">
      <h3 style="margin:0 0 .3rem">Property condition — photos &amp; video</h3>
      <p class="hint" style="font-size:12px;margin:0 0 .6rem">Upload interior and exterior photos (optional: a walkthrough video, 8 frames are sampled). The AI rates each area, estimates effective age and deferred maintenance, and feeds the valuation below. Label photos with the unit or area for a per-unit table.</p>
      <div class="actions" style="margin:0 0 .6rem">
        <label class="btn" style="cursor:pointer">📷 Add photos / video<input type="file" accept="image/*,video/*" multiple style="display:none" onchange="condAddFiles(this.files)"></label>
        <button class="btn btn-primary" onclick="analyzeCondition()" ${condFiles.length?'':'disabled'} id="cond-run">🔍 Analyze condition (${condFiles.length} image${condFiles.length===1?'':'s'})</button>
        ${c?'<button class="btn" onclick="apr.condition=null;aprSave(aprProjName(),apr);renderCondSection();renderAppraisal()">✕ Clear findings</button>':''}
        <span id="cond-status" style="font-size:12px;color:var(--muted);align-self:center"></span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${thumbs}</div>
      ${c?`<div style="margin-top:.7rem;font-size:12.5px"><b>Overall ${c.overall_rating}/5 (${esc(c.overall_label||'')})</b> · effective age ${c.effective_age_years} yrs · cost to cure ${fmtM(condCure(c))} — applied to the valuation below.</div>`:''}
    </div>`;
}
function renderCondSection(){ const el=document.getElementById('cond-card'); if(el) el.outerHTML=condSection(apr); }
function condCure(c){ return (c&&c.deferred_maintenance||[]).reduce((a,x)=>a+((+x.cost_low||0)+(+x.cost_high||0))/2,0); }

async function condAddFiles(files){
  for(const f of Array.from(files||[])){
    if(f.type.startsWith('video/')) { for(const fr of await sampleVideo(f,8)) condFiles.push({name:f.name,label:'',src:fr,kind:'frame'}); }
    else if(f.type.startsWith('image/')){ const url=URL.createObjectURL(f); condFiles.push({name:f.name,label:'',src:await shrinkImage(url,800),kind:'photo'}); URL.revokeObjectURL(url); }
  }
  renderCondSection();
}
function sampleVideo(file,n){
  return new Promise(res=>{
    const v=document.createElement('video'); v.muted=true; v.playsInline=true; v.preload='auto'; v.src=URL.createObjectURL(file);
    const out=[]; let i=0;
    v.onerror=()=>res(out);
    v.onloadedmetadata=()=>{ const dur=v.duration||0; if(!dur) return res(out);
      const next=()=>{ if(i>=n) { URL.revokeObjectURL(v.src); return res(out); } v.currentTime=Math.min(dur-0.1,(i+0.5)*dur/n); };
      v.onseeked=()=>{ const sc=Math.min(1,800/Math.max(v.videoWidth,v.videoHeight)); const c=document.createElement('canvas');
        c.width=Math.round(v.videoWidth*sc); c.height=Math.round(v.videoHeight*sc); c.getContext('2d').drawImage(v,0,0,c.width,c.height);
        out.push(c.toDataURL('image/jpeg',0.8)); i++; next(); };
      next(); };
  });
}

const COND_PROMPT=`You are a NYC property-condition inspector supporting an appraisal. Rate what the photos show. Respond with ONLY compact JSON, no prose:
{"items":[{"photo":1,"label":"<label given or what it shows>","area":"interior|exterior","element":"kitchen|bathroom|living/bedroom|hallway/common|facade|roof|windows|mechanical|structure|site|other","rating":1-5,"findings":"<one line>"}],
 "overall_rating":1-5,"overall_label":"<C1 new … C5 poor style word>","effective_age_years":<int>,"remaining_economic_life_years":<int>,
 "functional_obsolescence_pct":<0-15>,"condition_adjustment_pct":<-25..0, discount vs a fully renovated comparable>,
 "deferred_maintenance":[{"item":"<repair>","cost_low":<USD>,"cost_high":<USD>}],"summary":"<3-4 sentences for the report>"}
Rating scale: 5 = new/renovated, 4 = good, 3 = average/dated but sound, 2 = fair/deferred maintenance, 1 = poor/needs gut. Cost to cure at NYC contractor prices. If a photo is unclear, rate it 3 and say so.`;

async function analyzeCondition(){
  if(!condFiles.length) return;
  const st=document.getElementById('cond-status'), btn=document.getElementById('cond-run'); btn.disabled=true;
  try{
    const batches=[]; for(let i=0;i<condFiles.length;i+=5) batches.push(condFiles.slice(i,i+5));
    const results=[];
    for(let b=0;b<batches.length;b++){
      st.textContent=`Analyzing photos ${b*5+1}–${b*5+batches[b].length} of ${condFiles.length}…`;
      const parts=batches[b].map(f=>({media_type:'image/jpeg',data:f.src.split(',')[1]}));
      const labels=batches[b].map((f,i)=>`Photo ${b*5+i+1}: ${f.label||(f.kind==='frame'?'video frame':'unlabeled')}`).join('\n');
      const resp=await postProxy({parts,prompt:labels+'\n\n'+COND_PROMPT.replace('"photo":1','"photo":'+(b*5+1)+' (use the photo numbers above)')});
      const dta=await resp.json(); if(!resp.ok) throw new Error(dta.error||'analysis failed');
      results.push(JSON.parse(String(dta.text||'').replace(/```json|```/g,'').trim()));
    }
    let c=results[0];
    if(results.length>1){
      st.textContent='Consolidating findings…';
      const resp=await postProxy({prompt:'Merge these partial condition analyses of ONE property into a single JSON of the same shape (keep every item, de-duplicate deferred maintenance, recompute the overall fields from all photos). ONLY JSON.\n'+JSON.stringify(results)});
      const dta=await resp.json(); if(resp.ok){ try{ c=JSON.parse(String(dta.text||'').replace(/```json|```/g,'').trim()); }catch(e){} }
      if(c===results[0]){ c=Object.assign({},results[0]); c.items=results.flatMap(r=>r.items||[]); c.deferred_maintenance=results.flatMap(r=>r.deferred_maintenance||[]); }
    }
    c.analyzed=new Date().toISOString(); c.photos=condFiles.length;
    apr.condition=c;
    // Feed the cost approach unless the user already typed something non-default.
    if(!apr.effAge) apr.effAge=+c.effective_age_years||0;
    if(!apr.funcPct) apr.funcPct=+c.functional_obsolescence_pct||0;
    if(!apr.econLife||apr.econLife===60) apr.econLife=(+c.effective_age_years||0)+(+c.remaining_economic_life_years||60);
    aprSave(aprProjName(),apr);
    renderAppraisalForm(); renderAppraisal();
    track('condition_analyzed',{photos:condFiles.length});
  }catch(e){ alert('Condition analysis failed: '+(e.message||e)); }
  finally{ const s=document.getElementById('cond-status'); if(s) s.textContent=''; const b=document.getElementById('cond-run'); if(b) b.disabled=false; }
}

function condReport(c,m){
  if(!c) return '';
  const byLabel={};
  (c.items||[]).forEach(it=>{ const k=it.label||it.element||'—'; (byLabel[k]=byLabel[k]||[]).push(it); });
  const rows=Object.entries(byLabel).map(([k,its])=>{ const avg=its.reduce((a,x)=>a+(+x.rating||3),0)/its.length;
    return `<tr><td>${esc(k)}</td><td>${esc([...new Set(its.map(x=>x.area))].join(', '))}</td><td class="num">${avg.toFixed(1)} / 5</td><td>${esc(its.map(x=>x.findings).filter(Boolean).join(' · '))}</td></tr>`; }).join('');
  const dm=(c.deferred_maintenance||[]).map(x=>`<tr><td>${esc(x.item)}</td><td class="num">${fmtM(+x.cost_low||0)} – ${fmtM(+x.cost_high||0)}</td></tr>`).join('');
  return `<h3>Property condition (photo &amp; video inspection)</h3>
    <p style="font-size:13px"><b>Overall condition ${c.overall_rating}/5 — ${esc(c.overall_label||'')}.</b> ${esc(c.summary||'')} <span style="color:var(--muted)">(${c.photos} images analyzed ${c.analyzed?new Date(c.analyzed).toLocaleDateString('en-US'):''})</span></p>
    <table class="prop-table"><thead><tr><th>Unit / area</th><th>Int/Ext</th><th class="num">Rating</th><th>Findings</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="prop-table" style="margin-top:8px"><thead><tr><th>Deferred maintenance / cost to cure</th><th class="num">NYC cost</th></tr></thead><tbody>${dm||'<tr><td colspan="2" style="color:var(--muted)">None noted</td></tr>'}
      <tr class="subtot"><td>Total cost to cure (midpoint)</td><td class="num"><b>${fmtM(condCure(c))}</b></td></tr></tbody></table>
    <p style="font-size:12.5px;margin-top:6px">Effective age ${c.effective_age_years} yrs · remaining economic life ${c.remaining_economic_life_years} yrs · functional obsolescence ${c.functional_obsolescence_pct}% · condition adjustment vs. renovated comparables ${c.condition_adjustment_pct}%. Cost to cure is deducted from each approach to arrive at as-is value.</p>`;
}


/* ============ MARKET DATA — comps & land value from the address ============
   Netlify function comps.js queries NYC Open Data (PLUTO + DOF rolling sales):
   building sales near the subject (sized/aged like it) fill the sales grid,
   vacant-land sales give $/buildable SF → land value for the cost approach. */
function aprGuessAddress(){
  try{ const r=document.getElementById('render-addr'); if(r&&r.value.trim()) return r.value.trim(); }catch(e){}
  try{ const n=(getV('m-name')||'').trim(); if(/^\d+\s+\w/.test(n)) return n; }catch(e){}
  return '';
}
async function findComps(){
  const addr=(document.getElementById('apr-address')||{}).value||'';
  if(!addr.trim()){ alert('Enter the property address first.'); return; }
  const st=document.getElementById('comps-status'), btn=document.getElementById('comps-btn'); btn.disabled=true;
  const m=lastTotals.m;
  try{
    st.textContent='Looking up the lot and nearby recorded sales…';
    const r=await fetch('/.netlify/functions/comps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:addr,gfa:m.gfa,units:m.units,months:36,limit:12})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    d.fetched=new Date().toISOString();
    apr.address=addr; apr.market=d;
    // Fill the sales grid with the best six; keep the rest in the report.
    const top=d.comps.slice(0,COMP_COUNT);
    apr.comps=apr.comps.map((c,i)=>top[i]?{addr:top[i].address,date:top[i].date,price:top[i].price,sf:top[i].gsf,units:top[i].units,adj:top[i].suggestedAdj}:{addr:'',date:'',price:0,sf:0,units:0,adj:0});
    // Land: lot from PLUTO, value from land comps.
    if(d.subject.lotSF>0) apr.lotSF=d.subject.lotSF;
    if(d.land&&d.land.value>0){ apr.landValue=d.land.value; apr.landPSF=0; }
    aprSave(aprProjName(),apr);
    renderAppraisalForm(); renderAppraisal();
    // Short market commentary from the model (clearly labeled; the numbers above are the record data).
    try{
      const ds=document.getElementById('comps-status'); if(ds) ds.textContent='Writing market commentary…';
      const facts={subject:d.subject,buildingSales:d.comps.slice(0,8).map(c=>({address:c.address,date:c.date,price:c.price,gsf:c.gsf,units:c.units,psf:c.psf,distanceMi:c.distanceMi})),landSales:d.land.comps.slice(0,6),landValue:d.land};
      const resp=await postProxy({prompt:'You are a NYC appraiser. Using ONLY these recorded facts, write 4-5 sentences of market commentary for an appraisal report: describe the submarket, the range and central tendency of building sale prices per SF and per unit, the land sale evidence per buildable SF, and how reliable the land value indication is given the number and proximity of land comps. Plain prose, no headings, no bullet points, no made-up numbers.\n'+JSON.stringify(facts)});
      const t=await resp.json(); if(resp.ok&&t.text){ apr.marketNote=String(t.text).trim(); aprSave(aprProjName(),apr); renderAppraisalForm(); renderAppraisal(); }
    }catch(e){ console.warn('market note skipped',e); }
    track('comps_found',{comps:d.comps.length,land:d.land.comps.length});
  }catch(e){ alert('Comp search failed: '+(e.message||e)); const s2=document.getElementById('comps-status'); if(s2) s2.textContent=''; }
  finally{ const b=document.getElementById('comps-btn'); if(b) b.disabled=false; }
}

function marketReport(d,r){
  const mk=d.market; if(!mk) return '';
  const s=mk.subject, L=mk.land;
  const landRows=(L.comps||[]).map((c,i)=>`<tr><td>${i+1}</td><td>${esc(c.address)}</td><td>${esc(c.date)}</td><td class="num">${fmtM(c.price)}</td><td class="num">${c.lotSF.toLocaleString()}</td><td>${esc(c.zoning||'—')}${c.far?' · FAR '+c.far:''}</td><td class="num">${c.distanceMi} mi</td><td class="num">${c.timeAdj>0?'+':''}${c.timeAdj}%</td><td class="num">${fmtM(c.psfLot)}</td><td class="num">${c.psfBuildable?fmtM(c.psfBuildable):'—'}</td></tr>`).join('');
  return `<h3>Market data &amp; land value (NYC DOF recorded sales · PLUTO)</h3>
    <table class="prop-table"><tbody>
      <tr><td>Subject lot</td><td class="num">${esc(s.address)} · BBL ${esc(s.bbl||'')} · ${s.lotSF.toLocaleString()} SF lot · zoning ${esc(s.zoning||'—')} · max FAR ${s.maxFar||'—'} · ${s.buildableSF?s.buildableSF.toLocaleString()+' buildable SF':'buildable SF n/a'}${s.yearBuilt?' · existing bldg '+s.yearBuilt+' ('+s.bldgSF.toLocaleString()+' SF)':''}</td></tr>
      <tr><td>Search</td><td class="num">${mk.candidates.buildings} building sales and ${mk.candidates.land} land sales within ${mk.months} months in zip ${(mk.zips||[]).join(', ')}; the ${mk.comps.length} most similar buildings (distance, size, unit count, recency) are used as comparables</td></tr>
    </tbody></table>
    ${landRows?`<table class="prop-table" style="margin-top:8px"><thead><tr><th>#</th><th>Land sale</th><th>Date</th><th class="num">Price</th><th class="num">Lot SF</th><th>Zoning</th><th class="num">Dist.</th><th class="num">Time adj.</th><th class="num">$/lot SF</th><th class="num">$/bldg SF</th></tr></thead><tbody>${landRows}</tbody></table>
    <table class="prop-table" style="margin-top:8px"><tbody>
      <tr><td>Median $/buildable SF × ${s.buildableSF.toLocaleString()} buildable SF</td><td class="num">${L.medianPsfBuildable?fmtM(L.medianPsfBuildable)+'/SF → '+fmtM(L.byBuildable):'—'}</td></tr>
      <tr><td>Median $/lot SF × ${s.lotSF.toLocaleString()} SF lot</td><td class="num">${fmtM(L.medianPsfLot)}/SF → ${fmtM(L.byLot)}</td></tr>
      <tr class="subtot"><td><b>Indicated land value</b> <span style="font-weight:400;color:var(--muted)">(${esc(L.method)})</span></td><td class="num"><b>${fmtM(L.value)}</b></td></tr>
    </tbody></table>`:'<p style="font-size:12.5px;color:#B45309">⚠ No vacant-land sales recorded nearby in the period — land value must be entered manually.</p>'}
    ${d.marketNote?`<p style="font-size:13px;margin-top:8px">${esc(d.marketNote)}</p>`:''}`;
}

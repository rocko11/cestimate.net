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
    purpose:'Prospective market value upon completion', interest:'Fee simple', date:new Date().toISOString().slice(0,10),
    lotSF:0, landPSF:0, landValue:0, siteImp:0,
    softPct:20, incentivePct:15, effAge:0, econLife:60, funcPct:0, extPct:0,
    comps:Array.from({length:COMP_COUNT},()=>({addr:'',date:'',price:0,sf:0,units:0,adj:0})),
    rentUnit:0, otherInc:0, vacPct:5, opexPct:35, capRate:6, grm:0,
    wCost:30, wSales:40, wIncome:30, notes:''
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
      </div>
    </div>
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
      <div class="hint" style="font-size:11px;color:var(--muted);margin-top:4px">Net adjustment: + when the comp is inferior to the subject (older, worse location, earlier sale), − when superior. Leave rows blank to skip.</div>
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
  ['purpose','interest','date','notes'].forEach(k=>apr[k]=g(k));
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
  const cost={hard,soft,incentive,rcn,physPct,phys,func,ext,depr,land,siteImp:d.siteImp,value:land+d.siteImp+rcn-depr};

  const comps=d.comps.filter(c=>c.price>0&&(c.sf>0||c.units>0)).map(c=>{
    const adjPrice=c.price*(1+c.adj/100);
    return Object.assign({},c,{adjPrice,psf:c.sf>0?adjPrice/c.sf:0,pu:c.units>0?adjPrice/c.units:0});
  });
  const psfs=comps.filter(c=>c.psf>0).map(c=>c.psf), pus=comps.filter(c=>c.pu>0).map(c=>c.pu);
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  const psf=avg(psfs), pu=avg(pus);
  const bySF=psf*m.gfa, byUnit=pu*m.units;
  const sales={comps,psf,pu,bySF,byUnit,value:bySF>0&&byUnit>0?(bySF+byUnit)/2:(bySF||byUnit),
    range:psfs.length?[Math.min(...psfs)*m.gfa,Math.max(...psfs)*m.gfa]:null};

  const pgi=d.rentUnit*12*m.units+d.otherInc;
  const vac=pgi*d.vacPct/100, egi=pgi-vac, opex=egi*d.opexPct/100, noi=egi-opex;
  const byCap=d.capRate>0?noi/(d.capRate/100):0, byGRM=d.grm>0?(d.rentUnit*12*m.units)*d.grm:0;
  const income={pgi,vac,egi,opex,noi,byCap,byGRM,value:byCap||byGRM};

  const w=[[cost.value,d.wCost],[sales.value,d.wSales],[income.value,d.wIncome]].filter(x=>x[0]>0&&x[1]>0);
  const wsum=w.reduce((a,x)=>a+x[1],0);
  const final=wsum>0?w.reduce((a,x)=>a+x[0]*x[1],0)/wsum:0;
  const rounded=Math.round(final/10000)*10000;
  return {cost,sales,income,final,rounded,wsum};
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

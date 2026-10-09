/* Price book learned from the user's own past budgets (proforma / cost schedule Excel files).
   The user uploads a budget, tells us that project's size (GFA, footprint, units, counts), we map each
   budget line to an estimate line and turn its dollars into a rate on the right driver
   ($/SF GFA, $/SF footprint, $/unit, $/each, or lump sum). Rates from several budgets are averaged.
   Stored in this browser (localStorage). Used when Pricing = "My past budgets". */
(function(){
  const KEY='rest_pricebook_v1';
  // budget wording -> estimate line(s) and the driver its cost scales with
  const MAP=[
    {re:/window/i, lines:['Windows & glass doors (new)'], drv:'windows'},
    {re:/\bdoors?\b/i, lines:['Apartment / entry doors (metal)','Stair / fire-rated doors (metal)','Interior doors (solid wood)'], drv:'doors'},
    {re:/elevator/i, lines:['Passenger elevator'], drv:'elev'},
    {re:/kitchen/i, lines:['Kitchen casework & countertops'], drv:'units'},
    {re:/applian/i, lines:['Appliance packages'], drv:'units'},
    {re:/vanit/i, lines:['Bathroom vanities & accessories'], drv:'units'},
    {re:/fa[cç]ade/i, lines:['Exterior facade (new skin, excl. windows)'], drv:'gfa'},
    {re:/insul|foam/i, lines:['Air/vapor barrier & insulation'], drv:'gfa'},
    {re:/framing|stud/i, lines:['Metal stud partition framing'], drv:'gfa'},
    {re:/sheetrock|drywall|gypsum/i, lines:['Gypsum board (5/8" Type X)'], drv:'gfa'},
    {re:/paint/i, lines:['Painting — walls & ceilings'], drv:'gfa'},
    {re:/tile/i, lines:['Porcelain tile — bath & kitchen'], drv:'gfa'},
    {re:/floor(ing)?\b|wood floor/i, lines:['Engineered wood flooring'], drv:'gfa'},
    {re:/sprink/i, lines:['Fire sprinkler (NFPA 13R)'], drv:'gfa', share:'sprinkler'},
    {re:/plumb/i, lines:['Plumbing systems (units, risers, common, DHW)'], drv:'gfa', share:'plumbing'},
    {re:/hvac|heating|mechanical|air.?cond/i, lines:['__HVAC__'], drv:'gfa'},
    {re:/fire alarm/i, lines:['Electrical (service, distribution, units, fixtures, fire alarm)'], drv:'gfa', add:true},
    {re:/electric/i, lines:['Electrical (service, distribution, units, fixtures, fire alarm)'], drv:'gfa', add:true},
    {re:/rooftop/i, lines:['Rooftop (finish, pavers, rails)'], drv:'lump'},
    {re:/roof/i, lines:['Roofing membrane'], drv:'fp'},
    {re:/shoring|excavat|soe\b/i, lines:['Excavation & soil export'], drv:'fp'},
    {re:/foundation/i, lines:['Foundation (footings, mat, walls)'], drv:'fp'},
    {re:/water ?proof/i, lines:['Below-grade waterproofing'], drv:'fp'},
    {re:/structure|concrete|superstruct/i, lines:['Concrete superstructure — frame, slabs & roof deck'], drv:'gfa', add:true},
    {re:/water and sewer|water & sewer|utilit/i, lines:['Utility connections'], drv:'lump'},
    {re:/stucco/i, lines:['Stucco'], drv:'lump'},
    {re:/scaffold/i, lines:['Scaffolding'], drv:'lump'},
    {re:/sidewalk shed|shed/i, lines:['Sidewalk shed'], drv:'lump'},
    {re:/debris|garbage|dumpster/i, lines:['Debris removal (construction)'], drv:'lump'},
    {re:/fence|gate/i, lines:['Fences & gates'], drv:'lump'},
    {re:/new sidewalk|sidewalk/i, lines:['New sidewalk'], drv:'lump'},
    {re:/landscap/i, lines:['Landscaping'], drv:'lump'},
    {re:/molding|trim/i, lines:['Moldings'], drv:'lump'},
    {re:/closet|shelv/i, lines:['Closets & shelves'], drv:'lump'},
    {re:/camera|intercom/i, lines:['Camera & intercom system'], drv:'lump'},
    {re:/refuse|compactor/i, lines:['Refuse system & ventilation'], drv:'lump'},
  ];
  const DRV_LABEL={gfa:'$/SF GFA',fp:'$/SF footprint',units:'$/unit',windows:'$/window',doors:'$/door',elev:'$/elevator',lump:'lump sum'};

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||'null')||{budgets:[]}; }catch(e){ return {budgets:[]}; } }
  function save(b){ try{ localStorage.setItem(KEY,JSON.stringify(b)); }catch(e){} }
  const money=v=>{ if(typeof v==='number') return v; const s=String(v||'').replace(/[$,\s]/g,''); const n=parseFloat(s); return isFinite(n)?n:NaN; };

  // Find (item, total) rows: a text cell followed in the same row by the first sizeable $ amount.
  function extractRows(wb){
    const rows=[]; const seen=new Set();
    wb.SheetNames.forEach(sn=>{
      const aoa=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,raw:true,defval:''});
      aoa.forEach(r=>{
        for(let i=0;i<Math.min(r.length,12);i++){
          const t=String(r[i]||'').trim();
          if(t.length<3||t.length>60||/^\$?[\d,.\s]+$/.test(t)||/total|subtotal|month|timing|check|straight-line|^ok$/i.test(t)) continue;
          let amt=NaN; for(let k=i+1;k<Math.min(r.length,i+5);k++){ const v=money(r[k]); if(v>=1000&&v<1e8){ amt=v; break; } }
          if(!(amt>0)) continue;
          const key=t.toLowerCase()+'|'+amt; if(seen.has(key)) break; seen.add(key);
          const m=MAP.find(x=>x.re.test(t));
          rows.push({sheet:sn,item:t,amount:amt,map:m?MAP.indexOf(m):-1});
          break;
        }
      });
    });
    return rows;
  }

  // Combine all saved budgets into one rate per estimate line (average of the budgets that have it).
  function rates(){
    const b=load(); const acc={};
    b.budgets.forEach(bg=>{
      const per={};
      bg.rows.forEach(r=>{
        if(r.map<0||r.skip) return; const m=MAP[r.map]; const d=m.drv;
        const den=d==='lump'?1:(+bg.facts[d]||0); if(!(den>0)) return;
        m.lines.forEach(L=>{ const k=L+'|'+d; per[k]=(m.add&&per[k]?per[k]:0)+r.amount/den; });
      });
      Object.entries(per).forEach(([k,v])=>{ (acc[k]=acc[k]||[]).push({v,src:bg.name}); });
    });
    const out={};
    Object.entries(acc).forEach(([k,arr])=>{ const [line,drv]=k.split('|'); out[line]={drv,rate:arr.reduce((a,x)=>a+x.v,0)/arr.length,n:arr.length,src:arr.map(x=>x.src).join(', ')}; });
    return out;
  }

  window.applyLearnedBook=function(divs,m){
    const R=rates(); if(!Object.keys(R).length) return divs;
    const qtyOf={gfa:m.gfa||0,fp:m.footprint||0,units:m.units||0,windows:m.windows||0,elev:m.elev||0,
      doors:null,lump:1};
    let hv=[], hvTot=0;
    divs.forEach(d=>d.items.forEach(it=>{
      if(!it) return;
      if(['Outdoor condensing units','Indoor AC units (1 per room)','Exhaust fans (kitchen + bath)','Refrigerant piping & insulation','Exhaust ductwork & goosenecks','Install, controls, balancing (TAB)'].includes(it.n)){ hv.push(it); hvTot+=(it.qty||0)*(it.p||0); return; }
      const r=R[it.n]; if(!r) return;
      it._own=1; it.fixed=true; it.src='Your budgets: '+r.src+(r.n>1?' (avg of '+r.n+')':'');
      if(r.drv==='lump'){ it.qty=1; it.u='LS'; it.p=Math.round(r.rate); it.basis='Lump sum (your budgets)'; return; }
      if(r.drv==='doors'||r.drv==='windows'||r.drv==='elev'){ it.p=Math.round(r.rate); return; }   // keep the counted quantity
      it.qty=qtyOf[r.drv]; it.u=r.drv==='units'?'EA':'SF'; it.p=Math.round(r.rate*100)/100;
      it.basis=(r.drv==='units'?'Units':(r.drv==='fp'?'Footprint SF':'GFA SF'))+' · $'+it.p+' '+DRV_LABEL[r.drv].replace('$','');
    }));
    const H=R['__HVAC__'];
    if(H&&hvTot>0){ const f=H.rate*(m.gfa||0)/hvTot; hv.forEach(it=>{ it._own=1; it.fixed=true; it.p=Math.round(it.p*f*100)/100; it.src='Your budgets: HVAC $'+H.rate.toFixed(2)+'/SF GFA'; }); }
    return divs;
  };
  window.learnedBookCount=function(){ return load().budgets.length; };

  // ---- UI ----
  function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function modal(){
    let box=document.getElementById('pb-modal'); if(box) return box;
    const st=document.createElement('style');
    st.textContent='#pb-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;align-items:center;justify-content:center}#pb-modal.open{display:flex}#pb-box{background:#fff;color:#111;border-radius:10px;width:min(980px,96vw);max-height:92vh;overflow:auto;padding:16px;font-size:13px}#pb-box table{width:100%;border-collapse:collapse;margin:8px 0}#pb-box th,#pb-box td{border-bottom:1px solid #e3e7ee;padding:4px 6px;text-align:left}#pb-box input[type=number]{width:90px}#pb-box .p{background:#1a3a6b;color:#fff;border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:pointer}';
    document.head.appendChild(st);
    box=document.createElement('div'); box.id='pb-modal';
    box.innerHTML='<div id="pb-box"><div style="display:flex;gap:10px;align-items:center"><strong>📒 Learn prices from your past budgets</strong><span style="flex:1"></span><button id="pb-close">Close</button></div><div id="pb-body"></div></div>';
    document.body.appendChild(box);
    box.querySelector('#pb-close').onclick=()=>box.classList.remove('open');
    return box;
  }
  function renderSaved(){
    const b=load(); const R=rates();
    let h='<p>Upload a proforma or cost schedule (.xlsx) from a past project. Each budget line becomes a rate the estimate can reuse. Nothing leaves your browser.</p>'+
      '<input type="file" id="pb-file" accept=".xlsx,.xls,.csv"> ';
    if(b.budgets.length){
      h+='<h4 style="margin:12px 0 4px">Saved budgets</h4><ul>'+b.budgets.map((bg,i)=>'<li>'+esc(bg.name)+' — GFA '+(+bg.facts.gfa||0).toLocaleString()+' SF, '+(+bg.facts.units||0)+' units, '+bg.rows.filter(r=>r.map>=0&&!r.skip).length+' lines used <button data-del="'+i+'">remove</button></li>').join('')+'</ul>';
      h+='<h4 style="margin:12px 0 4px">Rates the estimate will use</h4><table><tr><th>Estimate line</th><th>Rate</th><th>From</th></tr>'+
        Object.entries(R).map(([L,r])=>'<tr><td>'+esc(L==='__HVAC__'?'HVAC (all lines, scaled)':L)+'</td><td>$'+(r.rate>=100?Math.round(r.rate).toLocaleString():r.rate.toFixed(2))+' '+esc(DRV_LABEL[r.drv].replace('$/','per ').replace('lump sum','lump sum'))+'</td><td>'+esc(r.src)+'</td></tr>').join('')+'</table>';
    }
    const body=document.getElementById('pb-body'); body.innerHTML=h;
    body.querySelector('#pb-file').onchange=function(){ if(this.files[0]) readFile(this.files[0]); };
    body.querySelectorAll('[data-del]').forEach(bt=>bt.onclick=()=>{ const bb=load(); bb.budgets.splice(+bt.dataset.del,1); save(bb); renderSaved(); if(typeof recalc==='function') recalc(); });
  }
  async function readFile(f){
    const body=document.getElementById('pb-body'); body.innerHTML='Reading '+esc(f.name)+'…';
    try{
      if(typeof ensureXLSX==='function') await ensureXLSX();
      const wb=XLSX.read(await f.arrayBuffer(),{type:'array'});
      const rows=extractRows(wb);
      if(!rows.length) throw new Error('no budget lines with dollar amounts were found');
      reviewRows(f.name.replace(/\.[^.]+$/,''),rows);
    }catch(e){ body.innerHTML='<b style="color:#b00">Could not read that file: '+esc(e.message||e)+'</b>'; setTimeout(renderSaved,2500); }
  }
  function reviewRows(name,rows){
    const cur=(typeof metrics==='function')?metrics():{};
    const opts='<option value="-1">— ignore —</option>'+MAP.map((m,i)=>'<option value="'+i+'">'+esc(m.lines[0]==='__HVAC__'?'HVAC (all lines)':m.lines.join(' + '))+' ('+DRV_LABEL[m.drv]+')</option>').join('');
    const f=(id,lab,v)=>'<label style="margin-right:10px">'+lab+' <input type="number" id="pb-'+id+'" value="'+(v||'')+'"></label>';
    let h='<p><b>'+esc(name)+'</b> — '+rows.length+' lines found. Enter the size of <u>that</u> project (prefilled with the current one — change it if the budget is for a different building), check the matches, then save.</p>'+
      '<div><label style="margin-right:10px">Budget name <input id="pb-name" value="'+esc(name)+'"></label></div><div style="margin:6px 0">'+
      f('gfa','GFA SF',cur.gfa)+f('fp','Footprint SF',cur.footprint)+f('units','Units',cur.units)+f('windows','Windows',cur.windows)+
      f('doors','Doors (all)',(cur.doorsEntry||0)+(cur.doorsStair||0)+(cur.doorsInt||0))+f('elev','Elevators',cur.elev)+'</div>'+
      '<table><tr><th>Budget line</th><th>Amount</th><th>Use as</th></tr>'+
      rows.map((r,i)=>'<tr><td>'+esc(r.item)+' <span style="color:#888">('+esc(r.sheet)+')</span></td><td>$'+Math.round(r.amount).toLocaleString()+'</td><td><select data-i="'+i+'">'+opts+'</select></td></tr>').join('')+'</table>'+
      '<button class="p" id="pb-save">Save to my price book</button> <button id="pb-cancel">Cancel</button>';
    const body=document.getElementById('pb-body'); body.innerHTML=h;
    body.querySelectorAll('select[data-i]').forEach(s=>{ s.value=String(rows[+s.dataset.i].map); });
    body.querySelector('#pb-cancel').onclick=renderSaved;
    body.querySelector('#pb-save').onclick=()=>{
      body.querySelectorAll('select[data-i]').forEach(s=>{ rows[+s.dataset.i].map=+s.value; });
      const g=id=>+(document.getElementById('pb-'+id).value)||0;
      const facts={gfa:g('gfa'),fp:g('fp'),units:g('units'),windows:g('windows'),doors:g('doors'),elev:g('elev')};
      if(!(facts.gfa>0)){ document.getElementById('pb-gfa').style.outline='2px solid #c00'; return; }
      const b=load(); b.budgets.push({name:document.getElementById('pb-name').value||name,facts,rows,saved:new Date().toISOString()}); save(b);
      const sel=document.getElementById('price-book'); if(sel){ sel.value='learned'; if(typeof setPriceBook==='function') setPriceBook('learned'); }
      renderSaved();
    };
  }
  window.openPriceBook=function(){ const box=modal(); renderSaved(); box.classList.add('open'); };
})();

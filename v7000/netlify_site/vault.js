// vault.js — keeps a copy of every file a signed-in user adds anywhere in the app (plans, CAD, budgets,
// saved estimates) in their account storage, so P National admins can open it later from /admin.
// Runs in the background; it never blocks or changes the estimating flow.
(function(){
  const API='/.netlify/functions/files';
  const seen=new Set(), queue=[]; let busy=false, toast=null;
  const key=f=>f.name+'|'+f.size+'|'+f.lastModified;
  function show(text,done){
    if(!toast){ toast=document.createElement('div'); toast.id='vault-toast';
      toast.style.cssText='position:fixed;right:16px;bottom:16px;z-index:9999;max-width:min(360px,calc(100vw - 32px));background:#0B2239;color:#CFE3F5;font:500 12px Inter,Arial,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 6px 20px rgba(11,34,57,.25);transition:opacity .3s';
      document.body.appendChild(toast); }
    toast.textContent=text; toast.style.opacity='1';
    clearTimeout(toast._t); if(done) toast._t=setTimeout(()=>{ toast.style.opacity='0'; },3500);
  }
  const b64=buf=>{ let s='',u=new Uint8Array(buf); for(let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(s); };
  async function post(body){
    for(let t=0;t<3;t++){
      try{ const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
        const d=await r.json().catch(()=>({})); if(r.ok) return d; if(r.status<500) throw new Error(d.error||('HTTP '+r.status)); }
      catch(e){ if(t===2||/HTTP 4|not allowed|Please sign in/.test(e.message)) throw e; }
      await new Promise(r=>setTimeout(r,1500*(t+1)));
    }
  }
  async function send(f,source){
    const s=await post({action:'start',name:f.name,size:f.size,type:f.type,source});
    for(let n=0;n<s.chunks;n++){
      const part=await f.slice(n*s.chunkSize,(n+1)*s.chunkSize).arrayBuffer();
      await post({action:'chunk',id:s.id,n,data:b64(part)});
      show('Saving '+f.name+' to your files… '+Math.round((n+1)*100/s.chunks)+'%');
    }
    await post({action:'finish',id:s.id,chunks:s.chunks});
  }
  async function pump(){
    if(busy) return; busy=true;
    while(queue.length){ const [f,source]=queue.shift();
      try{ show('Saving '+f.name+' to your files…'); await send(f,source); show('Saved '+f.name+' to your files ✓',true); }
      catch(e){ console.warn('vault upload failed',f.name,e); show('Could not save '+f.name+' to your files ('+e.message+')',true); } }
    busy=false;
  }
  function take(list,source){
    if(!window.REST_USER) return;                  // only for signed-in users
    for(const f of Array.from(list||[])){ if(!f||!f.size||seen.has(key(f))) continue; seen.add(key(f)); queue.push([f,source]); }
    pump();
  }
  const src=el=>(el&&el.id)||(el&&el.accept)||'upload';
  document.addEventListener('change',e=>{ const t=e.target; if(t&&t.tagName==='INPUT'&&t.type==='file') take(t.files,src(t)); },true);
  document.addEventListener('drop',e=>{ if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length) take(e.dataTransfer.files,'drop'); },true);
  window.vaultSave=take;
})();

async function update(){
  const s=await window.desktopStatus.read();
  const relay=document.getElementById('relay');relay.textContent=s.relay;relay.className=s.relay==='connected'?'good':'muted';
  document.getElementById('listener').textContent=s.listener||'Starting…';
  document.getElementById('error').textContent=s.error||'';
  if(s.relay==='starting')return;
  const container=document.getElementById('phones');container.replaceChildren();
  for(const phone of s.phones){
    const section=document.createElement('section');
    const row=document.createElement('div');row.className='row';
    const name=document.createElement('strong');name.textContent=`${{audiocodes:'AudioCodes',polycom:'Polycom',yealink:'Yealink'}[phone.vendor]||''} ${phone.model}`;
    const badge=document.createElement('span');badge.className='badge';badge.textContent=phone.extension||'No extension';
    row.append(name,badge);
    const details=document.createElement('div');details.className='row muted';
    const ip=document.createElement('code');ip.textContent=phone.ip;
    const state=document.createElement('span');state.textContent=phone.call?.[0]?.CallState||(phone.callStateKnown===false?`${phone.registration||'Unknown'} · call state unavailable`:phone.registration||'Awaiting SIP registration');
    details.append(ip,state);section.append(row,details);container.append(section);
    if(phone.reachable===false){const warning=document.createElement('p');warning.textContent=`Phone not reachable${phone.networkError?` (${phone.networkError})`:''}. Check its address and the app's Local Network permission in system settings.`;section.append(warning);}
  }
  if(!s.phones.length){const p=document.createElement('p');p.textContent='Waiting for the authorized phone inventory.';container.append(p);}
}
update();setInterval(()=>update().catch(()=>{}),1000);

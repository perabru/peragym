'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const RECEIPT_KEY = 'peragym-purchase-receipt-v1';
  const THEME_KEY = 'peragym-promo-theme-v1';
  const money = cents => new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL'}).format(cents / 100);
  let config = {salesEnabled:false,priceCents:null};
  let licensed = false, order = null, pollHandle = null, toastHandle = null;
  let checking = false, submitting = false, claiming = false;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(value);
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{20,200}$/.test(value);

  function setTheme(dark, persist=true) {
    document.body.classList.toggle('dark',dark);
    $('#theme-toggle').setAttribute('aria-checked',String(dark));
    $('#theme-toggle').setAttribute('aria-label',dark?'Ativar tema claro':'Ativar tema escuro');
    $('meta[name="theme-color"]').content=dark?'#211c26':'#fff8f1';
    if(persist)try{localStorage.setItem(THEME_KEY,dark?'dark':'light');}catch(error){}
  }
  try {const theme=localStorage.getItem(THEME_KEY);setTheme(theme?theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches,false);}catch(error){setTheme(false,false);}
  $('#theme-toggle').addEventListener('click',()=>setTheme(!document.body.classList.contains('dark')));
  $('#year').textContent=new Date().getFullYear();
  if(new URL(location.href).searchParams.get('acesso')==='necessario')$('#recovery-banner').hidden=false;

  async function api(path, options={}) {
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
      const json=await response.json().catch(()=>({}));
      if(!response.ok||json.ok===false)throw new Error(json.error||json.message||'Não foi possível concluir. Tente novamente.');
      return json;
    } catch(error) {if(error.name==='AbortError')throw new Error('A conexão demorou mais que o esperado. Tente novamente.');throw error;}
    finally {clearTimeout(timeout);}
  }
  function message(text, target) {
    if(target){target.textContent=text;target.hidden=false;return;}
    $('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastHandle);toastHandle=setTimeout(()=>$('#toast').classList.remove('visible'),3500);
  }
  function error(text){message(text,$('#checkout-error'));}
  function clearErrors(){['#checkout-error','#restore-error'].forEach(selector=>{$(selector).hidden=true;$(selector).textContent='';});}
  function storeReceipt(value) {try{localStorage.setItem(RECEIPT_KEY,JSON.stringify(value));}catch(error){}}
  function readReceipt() {try{const value=JSON.parse(localStorage.getItem(RECEIPT_KEY)||'null');return value&&validId(value.id)&&validToken(value.accessToken)?value:null;}catch(error){return null;}}
  function cleanReceipt(value) {
    if(!value||!validId(value.id)||!validToken(value.accessToken))throw new Error('O arquivo não contém um pedido válido do PeraGym.');
    return {id:value.id,accessToken:value.accessToken};
  }
  function updateSaleUI() {
    const ready=config.salesEnabled===true&&Number.isInteger(config.priceCents)&&config.priceCents>0;
    $$('[data-buy]').forEach(button=>{button.disabled=!licensed&&!ready;$('span',button).textContent=licensed?'Abrir meu PeraGym':ready?'Comprar com Pix':'Vendas em preparação';});
    $('#price').textContent=ready?money(config.priceCents):'Preço em definição';
    $('#price-description').textContent=ready?'Pagamento único por Pix.':'Vendas em preparação.';
    $$('[data-sale-note]').forEach(el=>el.textContent=licensed?'Seu acesso já está liberado neste navegador.':ready?`${money(config.priceCents)} · pagamento único por Pix · confirmação manual`:'Preço e abertura das vendas serão definidos pelo responsável.');
  }
  async function loadConfiguration() {
    const responses=await Promise.allSettled([api('/api/config'),api('/api/session')]);
    if(responses[0].status==='fulfilled')config=responses[0].value;
    if(responses[1].status==='fulfilled')licensed=responses[1].value.licensed===true;
    updateSaleUI();
  }
  function pausePolling(){clearInterval(pollHandle);pollHandle=null;}
  function startPolling(){pausePolling();pollHandle=setInterval(()=>{if(!document.hidden&&$('#checkout-dialog').open&&order)checkStatus(false);},10000);}
  function closeDialog(id){$('#'+id).close();if(id==='checkout-dialog')pausePolling();}
  $$('[data-close]').forEach(button=>button.addEventListener('click',()=>closeDialog(button.dataset.close)));
  $('#checkout-dialog').addEventListener('cancel',()=>pausePolling());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('#checkout-dialog').open&&order)checkStatus(false);});

  async function buy() {
    if(licensed){location.assign('/app/');return;}
    clearErrors();
    order=readReceipt();
    $('#checkout-form').hidden=!!order;$('#order-view').hidden=!order;
    $('#checkout-price').textContent=Number.isInteger(config.priceCents)?money(config.priceCents):'';
    $('#checkout-dialog').showModal();
    if(order){renderOrder(order);await checkStatus(true);startPolling();}
  }
  $$('[data-buy]').forEach(button=>button.addEventListener('click',buy));
  $$('[data-restore]').forEach(button=>button.addEventListener('click',async()=>{
    const saved=readReceipt();if(saved){order=saved;clearErrors();$('#checkout-form').hidden=true;$('#order-view').hidden=false;$('#checkout-dialog').showModal();renderOrder(order);await checkStatus(true);startPolling();return;}
    clearErrors();$('#restore-form').reset();$('#restore-dialog').showModal();
  }));

  function renderOrder(value) {
    const paid=value.status==='paid';const rejected=value.status==='rejected';
    const payload=typeof value.pixPayload==='string'?value.pixPayload:'';
    $('#order-status').classList.toggle('paid',paid);
    $('#order-status span').textContent=paid?'Pix confirmado · acesso liberado':rejected?'Pedido não confirmado':'Aguardando confirmação do Pix';
    $('.order-explanation').textContent=paid?'O recebimento do Pix foi confirmado. Você já pode abrir o aplicativo.':rejected?'Este pedido não foi confirmado. Consulte o responsável antes de fazer um novo pagamento.':'Após Bruno confirmar o recebimento do Pix, este pedido libera o acesso ao aplicativo.';
    $('#order-price').textContent=Number.isInteger(value.priceCents)?money(value.priceCents):'Pedido recuperado';
    $('#pix-payload').value=payload;$('#pix-payload').closest('label').hidden=!payload||paid||rejected;
    $('#copy-pix').hidden=!payload||paid||rejected;
    $('#pix-key').textContent=typeof value.pixKey==='string'?value.pixKey:'bruno.pera@unifesp.br';
    $('.pix-key').hidden=paid||rejected;
    $('#order-id').textContent=value.id;
    $('#open-app').hidden=!paid;$('#check-status').hidden=paid||rejected;
    $('#new-order').hidden=paid||!config.salesEnabled;
    $('#save-receipt').className=paid?'button secondary full':'text-link';
    $('#save-receipt').textContent=paid?'Salvar meu acesso antes de instalar':'Salvar acesso do pedido';
    $('#receipt-guidance').classList.toggle('receipt-important',paid);
    $('#receipt-guidance').textContent=paid?'Antes de instalar no iPhone ou usar em outro navegador, salve seu arquivo de acesso. O aplicativo instalado pode abrir em um ambiente separado do navegador. Use este arquivo para restaurar a compra. Ele contém sua chave privada de acesso.':'Guarde o arquivo de acesso em um local privado. Ele contém sua chave de acesso ao pedido.';
    $('#qr-container').replaceChildren();$('#qr-container').hidden=true;
    if(!paid&&!rejected&&typeof value.qrDataUrl==='string'&&/^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value.qrDataUrl)){
      const image=new Image();image.src=value.qrDataUrl;image.alt='QR Code Pix deste pedido';$('#qr-container').append(image);$('#qr-container').hidden=false;
    }
  }
  $('#checkout-form').addEventListener('submit',async event=>{
    event.preventDefault();if(submitting)return;clearErrors();
    if(!config.salesEnabled||!Number.isInteger(config.priceCents)||config.priceCents<=0){error('As vendas ainda não estão abertas.');return;}
    const name=$('#buyer-name').value.trim(),email=$('#buyer-email').value.trim();
    if(name.length<2){error('Informe seu nome para identificar o pedido.');return;}
    submitting=true;$('#create-order').disabled=true;$('#create-order').textContent='Preparando seu pedido…';
    try {
      const created=await api('/api/orders',{method:'POST',body:JSON.stringify({name,email})});
      cleanReceipt(created);order=created;storeReceipt(order);$('#checkout-form').hidden=true;$('#order-view').hidden=false;renderOrder(order);startPolling();
    } catch(err){error(err.message);}
    finally{submitting=false;$('#create-order').disabled=false;$('#create-order').textContent='Gerar pedido Pix ↗';}
  });
  async function checkStatus(showError) {
    if(!order||checking)return;checking=true;$('#check-status').disabled=true;
    try {
      const current=await api('/api/orders/'+encodeURIComponent(order.id),{headers:{Authorization:'Bearer '+order.accessToken}});
      order={...order,...current,id:order.id,accessToken:order.accessToken};storeReceipt(order);renderOrder(order);
      if(order.status==='paid'||order.status==='rejected')pausePolling();
      if(showError&&order.status==='pending')message('O pedido continua aguardando a conferência do Pix.',$('#checkout-error'));
    } catch(err){if(showError)error(err.message);}
    finally{checking=false;$('#check-status').disabled=false;}
  }
  $('#check-status').addEventListener('click',()=>{clearErrors();checkStatus(true);});
  $('#new-order').addEventListener('click',()=>{
    pausePolling();order=null;clearErrors();$('#order-view').hidden=true;$('#checkout-form').hidden=false;
    $('#checkout-price').textContent=Number.isInteger(config.priceCents)?money(config.priceCents):'';
  });
  $('#open-app').addEventListener('click',async()=>{
    if(!order||claiming)return;claiming=true;$('#open-app').disabled=true;clearErrors();
    try {
      const result=await api('/api/orders/'+encodeURIComponent(order.id)+'/claim',{method:'POST',headers:{Authorization:'Bearer '+order.accessToken}});
      licensed=true;updateSaleUI();location.assign(typeof result.appUrl==='string'&&result.appUrl.startsWith('/app/')?result.appUrl:'/app/');
    } catch(err){error(err.message);}
    finally{claiming=false;$('#open-app').disabled=false;}
  });
  async function copy(text,label){
    try{await navigator.clipboard.writeText(text);message(label,$('#checkout-error'));}
    catch(err){error('Não foi possível copiar automaticamente. Selecione e copie o texto exibido.');}
  }
  $('#copy-pix').addEventListener('click',()=>copy($('#pix-payload').value,'Código Pix copiado.'));
  $('#copy-key').addEventListener('click',()=>copy($('#pix-key').textContent,'Chave Pix copiada.'));
  $('#save-receipt').addEventListener('click',()=>{
    if(!order)return;
    const receipt={format:'peragym-purchase-receipt',version:1,id:order.id,accessToken:order.accessToken,createdAt:new Date().toISOString()};
    const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='PeraGym-pedido-'+order.id+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    message('Guarde o arquivo do pedido em um local privado.',$('#checkout-error'));
  });
  async function restore(receipt) {
    clearErrors();const cleaned=cleanReceipt(receipt);
    const current=await api('/api/orders/'+encodeURIComponent(cleaned.id),{headers:{Authorization:'Bearer '+cleaned.accessToken}});
    order={...current,...cleaned};storeReceipt(order);$('#restore-dialog').close();$('#checkout-form').hidden=true;$('#order-view').hidden=false;renderOrder(order);$('#checkout-dialog').showModal();if(order.status==='pending')startPolling();
  }
  $('#restore-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('#restore-form [type="submit"]');button.disabled=true;
    try{await restore({id:$('#restore-id').value.trim(),accessToken:$('#restore-token').value.trim()});}
    catch(err){message(err.message,$('#restore-error'));}finally{button.disabled=false;}
  });
  $('#import-receipt').addEventListener('click',()=>$('#receipt-file').click());
  $('#receipt-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{if(file.size>65536)throw new Error('Este arquivo é grande demais para ser um pedido do PeraGym.');const value=JSON.parse(await file.text());await restore(value);}
    catch(err){message(err instanceof SyntaxError?'O arquivo selecionado não é um JSON válido.':err.message,$('#restore-error'));}
    finally{event.target.value='';}
  });
  loadConfiguration();
})();

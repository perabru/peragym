'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {config:null,orders:[],owner:null,filter:'pending',ready:false,loading:false,dialogOrder:null};
let toastTimer;
const money = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value||0)/100);
const escapeHtml = value => String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function parsePrice(value){
  const raw=String(value).trim();
  if(!/^\d{1,6}(?:[,.]\d{1,2})?$/.test(raw))return null;
  const parts=raw.replace(',','.').split('.');
  const cents=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
  return Number.isSafeInteger(cents)&&cents>=100&&cents<=99999900?cents:null;
}

function displayDate(raw,includeTime=true){
  const value=typeof raw==='number'?raw:Date.parse(raw);
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return 'Data não informada';
  const options={day:'2-digit',month:'short',year:'numeric'};
  if(includeTime){options.hour='2-digit';options.minute='2-digit';}
  return date.toLocaleString('pt-BR',options);
}

async function api(path,body){
  const options={method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}};
  if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const response=await fetch(path,options);
  let result;
  try{result=await response.json();}catch(error){result={error:'Não foi possível ler a resposta. Atualize a página para tentar novamente.'};}
  if(!response.ok||result.ok===false){
    const failure=new Error(result.error||'Não foi possível concluir a operação.');
    failure.status=response.status;throw failure;
  }
  return result;
}

function notify(message){
  $('#toast').textContent=message;$('#toast').classList.add('visible');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4000);
}

function showError(selector,message){const element=$(selector);element.textContent=message||'';element.hidden=!message;}

function applyTheme(dark){
  document.body.classList.toggle('dark',dark);
  $('#theme-toggle').setAttribute('aria-pressed',String(dark));
  $('#theme-toggle').setAttribute('aria-label',dark?'Ativar tema claro':'Ativar tema escuro');
  $('meta[name="theme-color"]').content=dark?'#211c26':'#fff8f1';
  try{localStorage.setItem('peragym-admin-theme',dark?'dark':'light');}catch(error){}
}

function showAccessFailure(error){
  const auth=error.status===401;
  if(!auth&&error.status!==403)return false;
  $('#access-message').hidden=false;$('#admin-content').hidden=true;
  $('#access-title').textContent=auth?'Entre na sua conta':'Esta área é restrita ao responsável';
  $('#access-description').textContent=auth?'Confirme sua identidade para configurar as vendas e conferir os pedidos.':'A conta atual não tem permissão para administrar o PeraGym. Entre com a conta do responsável.';
  return true;
}

function setConfigEnabled(enabled){
  $('#price').disabled=!enabled;
  $('#sales-enabled').disabled=!enabled||parsePrice($('#price').value)===null;
  $('#save-config').disabled=!enabled;
}

function renderConfig(){
  const config=state.config;
  const defined=Number.isSafeInteger(config.priceCents)&&config.priceCents>0;
  $('#price').value=defined?(config.priceCents/100).toFixed(2).replace('.',','):'';
  $('#sales-enabled').checked=defined&&config.salesEnabled===true;
  $('#sales-status').textContent=defined&&config.salesEnabled?'Vendas ativas':'Vendas pausadas';
  $('#sales-status').className=`status-badge ${defined&&config.salesEnabled?'active':'paused'}`;
  $('#setup-note').hidden=defined;
  $('#pix-key').textContent=config.pixKey||'bruno.pera@unifesp.br';
  $('#merchant-name').textContent=config.merchantName||'BRUNO MICHEL PERA';
  setConfigEnabled(true);
}

function renderOwner(){
  const owner=state.owner||{};
  const name=owner.name||owner.email||'Responsável pelo PeraGym';
  $('#owner-name').textContent=name;
  $('#owner-email').textContent=owner.email||'Acesso protegido';
  $('.owner-avatar').textContent=name.trim().charAt(0).toLocaleUpperCase('pt-BR')||'P';
}

function renderStats(){
  const pending=state.orders.filter(order=>order.status==='pending');
  const paid=state.orders.filter(order=>order.status==='paid');
  $('#pending-count').textContent=pending.length.toString().padStart(2,'0');
  $('#paid-count').textContent=paid.length.toString().padStart(2,'0');
  $('#paid-total').textContent=money(paid.reduce((total,order)=>total+Number(order.priceCents||0),0));
  $('#filter-pending-count').textContent=pending.length;
  $('#orders-summary').textContent=pending.length===0?'Nenhum pedido aguardando conferência.':`${pending.length} pedido${pending.length===1?'':'s'} aguardando conferência no banco.`;
}

function statusLabel(status){return {pending:'Aguardando conferência',paid:'Liberado',rejected:'Não confirmado'}[status]||'Em revisão';}

function orderCard(order){
  const avatar=String(order.name||'P').trim().charAt(0).toLocaleUpperCase('pt-BR')||'P';
  const status=['pending','paid','rejected'].includes(order.status)?order.status:'pending';
  const actions=status==='pending'?`<div class="order-actions"><button class="review-button" type="button" data-action="reject" data-id="${escapeHtml(order.id)}">Não confirmar</button><button class="button primary" type="button" data-action="approve" data-id="${escapeHtml(order.id)}">Conferir e liberar <span aria-hidden="true">↗</span></button></div>`:`<p class="order-confirmed">${status==='paid'?`<strong>Recebimento confirmado</strong>${escapeHtml(displayDate(order.approvedAt||order.updatedAt||order.createdAt))}${order.bankReference?`<br>Ref.: ${escapeHtml(order.bankReference)}`:''}`:'O acesso permanece bloqueado.'}</p>`;
  return `<article class="order-card"><div class="order-name"><span class="order-avatar" aria-hidden="true">${escapeHtml(avatar)}</span><div class="order-person"><h3>${escapeHtml(order.name||'Nome não informado')}</h3><p class="order-email">${escapeHtml(order.email||'E-mail não informado')}</p><p class="order-id">Pedido ${escapeHtml(order.id)}</p></div></div><div class="order-meta"><div class="order-price"><strong>${escapeHtml(money(order.priceCents))}</strong><span class="order-date">${escapeHtml(displayDate(order.createdAt))}</span></div><span class="status-badge ${status}">${escapeHtml(statusLabel(status))}</span></div>${actions}</article>`;
}

function renderOrders(){
  const query=$('#order-search').value.trim().toLocaleLowerCase('pt-BR');
  const matches=state.orders.filter(order=>(state.filter==='all'||order.status===state.filter)&&`${order.name||''} ${order.email||''} ${order.id||''}`.toLocaleLowerCase('pt-BR').includes(query));
  $$('.filter').forEach(button=>{const selected=button.dataset.filter===state.filter;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
  if(matches.length){$('#orders-list').innerHTML=matches.map(orderCard).join('');}
  else{
    const hasOrders=state.orders.length>0;
    const title=hasOrders?'Nenhum pedido neste filtro':'Tudo pronto para seus primeiros pedidos';
    const description=hasOrders?'Tente outro nome ou escolha outra situação para visualizar os pedidos.':'Quando uma compra for iniciada, ela aparecerá aqui para conferência. Nenhuma liberação acontece antes da sua confirmação.';
    $('#orders-list').innerHTML=`<div class="empty-state"><span class="empty-icon" aria-hidden="true">${hasOrders?'⌕':'✓'}</span><h3>${title}</h3><p>${description}</p></div>`;
  }
  $$('#orders-list [data-action]').forEach(button=>button.addEventListener('click',()=>openOrderDialog(button.dataset.action,button.dataset.id)));
}

async function loadState({keepConfig=false}={}){
  if(state.loading)return;
  state.loading=true;$('#admin-content').setAttribute('aria-busy','true');$('#refresh-orders').disabled=true;
  showError('#orders-error','');
  try{
    const payload=await api('/api/admin/state');
    if(!payload.config||!Array.isArray(payload.orders))throw new Error('O painel recebeu uma resposta incompleta. Tente atualizar novamente.');
    state.config=payload.config;state.orders=[...payload.orders].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));state.owner=payload.owner;state.ready=true;
    $('#access-message').hidden=true;$('#admin-content').hidden=false;
    renderOwner();if(!keepConfig)renderConfig();renderStats();renderOrders();
  }catch(error){
    if(!showAccessFailure(error)){
      showError('#orders-error',error.message||'Não foi possível carregar os pedidos.');
      if(!state.ready){$('#orders-summary').textContent='Conexão com o painel indisponível.';$('#orders-list').innerHTML='<div class="empty-state"><span class="empty-icon" aria-hidden="true">!</span><h3>Vamos tentar de novo?</h3><p>Use Atualizar para carregar as configurações e os pedidos.</p></div>';}
    }
  }finally{state.loading=false;$('#admin-content').setAttribute('aria-busy','false');$('#refresh-orders').disabled=false;}
}

async function saveConfig(event){
  event.preventDefault();showError('#config-error','');
  if(!state.ready)return;
  const priceCents=parsePrice($('#price').value);
  if(priceCents===null){showError('#config-error','Informe um preço entre R$ 1,00 e R$ 999.999,00, com até duas casas decimais.');$('#price').focus();return;}
  const salesEnabled=$('#sales-enabled').checked;
  setConfigEnabled(false);$('#save-config').textContent='Salvando…';
  try{
    await api('/api/admin/config',{priceCents,salesEnabled});
    state.config={...state.config,priceCents,salesEnabled};renderConfig();notify(salesEnabled?'Configuração salva. Novos pedidos estão habilitados.':'Configuração salva. Novos pedidos estão pausados.');
  }catch(error){if(!showAccessFailure(error))showError('#config-error',error.message);}
  finally{$('#save-config').textContent='Salvar configuração ✓';if(!$('#admin-content').hidden)setConfigEnabled(true);}
}

function renderReview(selector,order){
  const fields=[['Valor do pedido',money(order.priceCents),'review-amount'],['Comprador',order.name||'Não informado',''],['E-mail',order.email||'Não informado',''],['Pedido',order.id,'review-id'],['Chave Pix',state.config?.pixKey||'bruno.pera@unifesp.br','']];
  $(selector).innerHTML=fields.map(([label,value,className])=>`<div class="${className}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
}

function openOrderDialog(action,id){
  const order=state.orders.find(entry=>String(entry.id)===String(id));
  if(!order||order.status!=='pending'){notify('Este pedido não está mais pendente. Atualize a lista.');return;}
  state.dialogOrder=order;
  if(action==='approve'){
    $('#approve-form').reset();showError('#approve-error','');renderReview('#approve-review',order);$('#approve-submit').disabled=true;$('#approve-dialog').showModal();
  }else{
    $('#reject-form').reset();showError('#reject-error','');renderReview('#reject-review',order);$('#reject-dialog').showModal();
  }
}

function updateApprovalButton(){
  const reference=$('#bank-reference').value.trim();
  $('#approve-submit').disabled=!$('#bank-checked').checked||reference.length<6||reference.length>100;
}

function setDialogBusy(dialogId,busy){
  $$(`#${dialogId} button`).forEach(button=>button.disabled=busy);
  $(`#${dialogId}`).dataset.busy=String(busy);
}

async function approveOrder(event){
  event.preventDefault();showError('#approve-error','');
  const order=state.dialogOrder,bankReference=$('#bank-reference').value.trim();
  if(!order)return;
  if(!$('#bank-checked').checked||bankReference.length<6||bankReference.length>100){showError('#approve-error','Confirme a conferência no extrato e registre a referência da transação.');return;}
  setDialogBusy('approve-dialog',true);$('#approve-submit').textContent='Confirmando…';
  try{
    await api(`/api/admin/orders/${encodeURIComponent(order.id)}/approve`,{bankReference,confirmedInBank:$('#bank-checked').checked});
    $('#approve-dialog').close();state.dialogOrder=null;notify('Recebimento confirmado. O pedido está liberado.');await loadState({keepConfig:true});
  }catch(error){if(showAccessFailure(error))$('#approve-dialog').close();else showError('#approve-error',error.message);}
  finally{setDialogBusy('approve-dialog',false);$('#approve-submit').textContent='Confirmar e liberar ✓';updateApprovalButton();}
}

async function rejectOrder(event){
  event.preventDefault();showError('#reject-error','');
  const order=state.dialogOrder,reason=$('#reject-reason').value.trim();
  if(!order)return;
  if(reason.length<6||reason.length>300){showError('#reject-error','Registre um motivo com 6 a 300 caracteres.');return;}
  setDialogBusy('reject-dialog',true);$('#reject-submit').textContent='Registrando…';
  try{
    await api(`/api/admin/orders/${encodeURIComponent(order.id)}/reject`,{reason});
    $('#reject-dialog').close();state.dialogOrder=null;notify('Revisão registrada. O acesso continua bloqueado.');await loadState({keepConfig:true});
  }catch(error){if(showAccessFailure(error))$('#reject-dialog').close();else showError('#reject-error',error.message);}
  finally{setDialogBusy('reject-dialog',false);$('#reject-submit').textContent='Registrar revisão';}
}

$('#theme-toggle').addEventListener('click',()=>applyTheme(!document.body.classList.contains('dark')));
try{const saved=localStorage.getItem('peragym-admin-theme');applyTheme(saved?saved==='dark':matchMedia('(prefers-color-scheme: dark)').matches);}catch(error){}
$('#config-form').addEventListener('submit',saveConfig);
$('#price').addEventListener('input',()=>{const valid=parsePrice($('#price').value)!==null;$('#sales-enabled').disabled=!state.ready||!valid;if(!valid)$('#sales-enabled').checked=false;});
$('#refresh-orders').addEventListener('click',()=>loadState());
$('#order-search').addEventListener('input',renderOrders);
$$('.filter').forEach(button=>button.addEventListener('click',()=>{state.filter=button.dataset.filter;renderOrders();}));
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>{const dialog=$(`#${button.dataset.close}`);if(dialog.dataset.busy!=='true'){dialog.close();state.dialogOrder=null;}}));
$$('dialog').forEach(dialog=>dialog.addEventListener('cancel',event=>{if(dialog.dataset.busy==='true')event.preventDefault();else state.dialogOrder=null;}));
$('#bank-checked').addEventListener('change',updateApprovalButton);
$('#bank-reference').addEventListener('input',updateApprovalButton);
$('#approve-form').addEventListener('submit',approveOrder);
$('#reject-form').addEventListener('submit',rejectOrder);
loadState();

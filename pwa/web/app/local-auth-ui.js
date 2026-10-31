const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createLocalAuthUI({mount, account, biometric, onUnlock, onLock, onRefresh=async()=>{}, onBusy=()=>{}}) {
  let profiles=[], mode='login', busy=false, username='', message='', support={available:false}, enrolled=false;
  let pendingRecovery=null, recoveryEnabled=null, recoveryProfileId=null, settingsRequest=0, lifecycle=0;
  let disposeRecoveryDialog=null;
  const currentState=()=>account.getState();
  const hasPendingRecovery=()=>Boolean(pendingRecovery);
  const selectedProfile=()=>profiles.find(p=>p.username===username.trim().toLowerCase());
  const readableError=(error,fallback)=>error?.message||fallback;
  const liveProfile=id=>currentState().unlocked&&!currentState().guest&&currentState().profile?.id===id;
  function reportBusy(value){try{const pending=onBusy(value);if(pending&&typeof pending.catch==='function')pending.catch(()=>{});}catch(_){}}
  function clearForm(form){
    form?.reset?.();
    for(const name of ['password','newPassword','confirmation','recoveryCode'])if(form?.elements?.[name])form.elements[name].value='';
  }
  function clearRecovery(){
    const input=mount.querySelector('[data-local-recovery-code]');if(input)input.value='';
    const ack=mount.querySelector('[data-local-recovery-ack]');if(ack)ack.checked=false;
    if(pendingRecovery)pendingRecovery.code='';pendingRecovery=null;
  }
  function recoveryCode(value){if(typeof value!=='string'||!value.trim())throw new Error('O código não pôde ser exibido. Gere outro para ativar a recuperação.');return value;}
  async function initialize() {
    profiles=await account.listProfiles();
    if(!profiles.length)mode='register';
    try{support=await biometric.support();}catch(_){support={available:false};}
    if(!username&&profiles.length)username=profiles[0].username;
  }
  async function updateBiometricButton() {
    const selected=selectedProfile(), button=mount.querySelector('[data-local-biometric]');
    if(!button)return;
    let exists=false;
    try{exists=!!selected&&await biometric.hasEnrollment(selected.id);}catch(_){}
    if(!button.isConnected||selectedProfile()?.id!==selected?.id)return;
    button.hidden=!(support.available&&exists);button.disabled=busy;
  }
  function layout(content){return `<section class="auth-layout" aria-label="Acesso local"><div class="auth-cover"><span class="eyebrow">SEU TREINO. SUA FITA.</span><img class="auth-cassette" src="/assets/cassette.svg" alt="Fita cassete PeraGym"><p>Play no treino.</p><span class="auth-side">SIDE A · PERAGYM</span></div><div class="auth-card">${content}</div></section>`;}
  function codeMarkup(acknowledged,label='Continuar'){
    return `<p class="auth-recovery-intro">Guarde este código fora do aplicativo. Ele permite criar uma nova senha para os dados que continuam neste aparelho.</p><label class="auth-recovery-code-label">Seu código de recuperação<textarea data-local-recovery-code readonly rows="3" wrap="soft" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Seu código de recuperação"></textarea></label><p class="auth-recovery-warning">Este código só será exibido agora. Um novo código invalida o anterior.</p><label class="auth-recovery-ack"><input type="checkbox" data-local-recovery-ack ${acknowledged?'checked':''}><span>Guardei meu código em um lugar seguro.</span></label><p class="auth-error" data-local-recovery-error role="alert" hidden></p><button type="button" class="button primary full" data-local-recovery-continue ${!acknowledged||busy?'disabled':''}>${label} <img class="cassette-icon" src="/assets/cassette.svg" alt=""></button>`;
  }
  function renderPendingRecovery(){
    const pending=pendingRecovery;if(!pending)return;
    const error=pending.step==='generation-error', ready=pending.step==='code';
    const title=ready?'Guarde seu código':error?(pending.kind==='register'?'Conta criada.':'Senha alterada.'):'Preparando a recuperação';
    let content=`<span class="eyebrow">RECUPERAÇÃO LOCAL</span><h1>${title}</h1><p class="auth-subtitle">@${escape(pending.username||username)}</p>`;
    if(ready)content+=`<form id="local-recovery-code-form">${codeMarkup(pending.acknowledged)}</form>`;
    else if(error)content+=`<p class="auth-error" role="alert">${escape(pending.error||'Não foi possível gerar seu código agora.')}</p><p class="auth-recovery-intro">Sua conta e seus dados foram preservados. Tente gerar o código novamente ou entre depois com a sua senha para ativar a recuperação nos Ajustes.</p><div class="auth-recovery-actions"><button type="button" class="button primary full" data-local-recovery-retry ${busy?'disabled':''}>Gerar código novamente</button><button type="button" class="button secondary full" data-local-recovery-later ${busy?'disabled':''}>Voltar para Entrar</button></div>`;
    else content+='<p class="auth-recovery-intro" role="status">Gerando seu código de recuperação…</p>';
    mount.innerHTML=layout(content);
    if(ready){
      const input=mount.querySelector('[data-local-recovery-code]');if(input)input.value=pending.code;
      const checkbox=mount.querySelector('[data-local-recovery-ack]'),button=mount.querySelector('[data-local-recovery-continue]');
      checkbox.onchange=()=>{if(busy||pendingRecovery!==pending)return;pending.acknowledged=checkbox.checked;button.disabled=!checkbox.checked;};
      button.onclick=async()=>{
        if(busy||pendingRecovery!==pending||!checkbox.checked)return;
        const run=lifecycle;busy=true;button.disabled=true;pending.acknowledged=true;
        // The credential is removed before the training screen can be rendered.
        clearRecovery();mount.innerHTML='';
        try{reportBusy('Abrindo seus treinos...');await onUnlock();}
        catch(error){if(run!==lifecycle)return;message=readableError(error,'Não foi possível abrir os treinos. Entre novamente.');account.lock();mode='login';}
        finally{if(run===lifecycle){busy=false;reportBusy(null);if(!currentState().unlocked)render();}}
      };
      const form=mount.querySelector('form');if(form)form.onsubmit=event=>{event.preventDefault();return button.onclick();};
    }
    const retry=mount.querySelector('[data-local-recovery-retry]');if(retry)retry.onclick=generatePendingCode;
    const later=mount.querySelector('[data-local-recovery-later]');if(later)later.onclick=async()=>{
      if(busy)return;const run=++lifecycle;busy=true;account.lock();clearRecovery();mode='login';message='';
      try{reportBusy('Abrindo a entrada...');profiles=await account.listProfiles();}
      catch(error){if(run===lifecycle)message=readableError(error,'Entre com o usuário e a senha da sua conta.');}
      finally{if(run===lifecycle){busy=false;reportBusy(null);render();}}
    };
  }
  async function generatePendingCode(){
    if(busy||!pendingRecovery)return;
    const pending=pendingRecovery,run=lifecycle;busy=true;pending.step='generating';pending.error='';renderPendingRecovery();
    try{
      reportBusy('Gerando seu código de recuperação...');
      const code=await account.createRecoveryCode();if(run!==lifecycle||pendingRecovery!==pending)return;
      pending.code=recoveryCode(code);pending.step='code';pending.acknowledged=false;
    }catch(error){if(run===lifecycle&&pendingRecovery===pending){pending.step='generation-error';pending.error=readableError(error,'Não foi possível gerar seu código agora.');}}
    finally{if(run===lifecycle){busy=false;reportBusy(null);if(pendingRecovery)renderPendingRecovery();}}
  }
  function render() {
    if(pendingRecovery){renderPendingRecovery();return;}
    if(mode==='recover'){renderRecoverForm();return;}
    mount.innerHTML=layout(`<div class="auth-tabs" role="group" aria-label="Tipo de acesso"><button type="button" data-auth-mode="login" class="${mode==='login'?'active':''}" aria-pressed="${mode==='login'}">Entrar</button><button type="button" data-auth-mode="register" class="${mode==='register'?'active':''}" aria-pressed="${mode==='register'}">Criar conta</button></div><span class="eyebrow">NESTE APARELHO</span><h1>${mode==='register'?'Criar conta':'Bom treino.'}</h1><p class="auth-subtitle">${mode==='register'?'Cadastro opcional para proteger seus dados com senha.':'Entre no seu perfil ou continue sem cadastro.'}</p><button type="button" class="button secondary full guest-login" data-local-guest ${busy?'disabled':''}>Usar sem cadastro</button><form id="local-auth-form">${mode==='register'?'<label>Seu nome<input name="name" required maxlength="60" autocomplete="name" placeholder="Como você se chama?"></label>':''}<label>Usuário<input name="username" required maxlength="40" minlength="3" autocapitalize="none" autocomplete="username" spellcheck="false" value="${escape(username)}" placeholder="seu.usuario" ${profiles.length?'list="local-profile-names"':''}></label>${profiles.length?`<datalist id="local-profile-names">${profiles.map(p=>`<option value="${escape(p.username)}">${escape(p.name)}</option>`).join('')}</datalist>`:''}<label>Senha<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="${mode==='register'?'new-password':'current-password'}" placeholder="${mode==='register'?'Pelo menos 8 caracteres':'Sua senha local'}"></label>${mode==='register'?'<label>Repetir senha<input name="confirmation" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="Digite a senha novamente"></label>':''}${mode==='register'?'<label class="auth-copy-guest"><input type="checkbox" name="copyGuestData" value="on"><span>Copiar meus dados de visitante para a nova conta</span></label>':''}<p class="auth-error" role="alert" ${message?'':'hidden'}>${escape(message)}</p><button class="button primary full" type="submit" ${busy?'disabled':''}>${busy?'Abrindo...':mode==='register'?'Criar conta':'Entrar'} <img class="cassette-icon" src="/assets/cassette.svg" alt=""></button>${mode==='login'?'<button type="button" class="auth-forgot" data-local-forgot>Esqueci minha senha</button><button type="button" class="button secondary full biometric-login" data-local-biometric hidden>Digital / Face ID</button>':''}</form><p class="auth-footnote">Cadastro opcional. A recuperação de senha exige um código guardado previamente e os dados deste aparelho. Contas antigas podem ativar o código nos Ajustes depois de entrar.</p>`);
    mount.querySelectorAll('[data-auth-mode]').forEach(button=>button.onclick=()=>{if(busy)return;clearForm(mount.querySelector('form'));mode=button.dataset.authMode;message='';render();});
    const form=mount.querySelector('form');
    form.elements.username.oninput=event=>{username=event.target.value;void updateBiometricButton();};
    form.onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const fields=new FormData(form),registering=mode==='register',run=lifecycle;username=String(fields.get('username')).trim();
      const password=String(fields.get('password')||''),confirmation=String(fields.get('confirmation')||'');
      const input={name:String(fields.get('name')||''),username,password};if(fields.get('copyGuestData')==='on')input.copyGuestData=true;
      clearForm(form);
      if(registering&&password!==confirmation){message='As senhas precisam ser iguais.';render();return;}
      busy=true;message='';form.querySelector('[type=submit]').disabled=true;
      try{
        reportBusy(registering?'Criando seu perfil local...':'Abrindo seu perfil local...');
        if(registering){
          await account.register(input);if(run!==lifecycle)return;
          pendingRecovery={kind:'register',username,step:'generating',code:'',acknowledged:false,error:''};renderPendingRecovery();
          reportBusy('Gerando seu código de recuperação...');
          const code=await account.createRecoveryCode();if(run!==lifecycle)return;
          pendingRecovery.code=recoveryCode(code);pendingRecovery.step='code';
        }else{await account.login(username,password);if(run!==lifecycle)return;await onUnlock();}
      }catch(error){
        if(run!==lifecycle)return;
        if(pendingRecovery){pendingRecovery.step='generation-error';pendingRecovery.error=readableError(error,'Não foi possível gerar seu código agora.');}
        else{message=readableError(error,'Não foi possível entrar.');if(currentState().unlocked)account.lock();}
      }finally{if(run===lifecycle){busy=false;reportBusy(null);if(pendingRecovery||!currentState().unlocked)render();}}
    };
    const forgot=mount.querySelector('[data-local-forgot]');if(forgot)forgot.onclick=()=>{if(busy)return;clearForm(form);mode='recover';message='';render();};
    const guest=mount.querySelector('[data-local-guest]');if(guest)guest.onclick=async()=>{
      if(busy)return;const run=lifecycle;busy=true;guest.disabled=true;message='';clearForm(form);
      try{reportBusy('Abrindo o uso sem cadastro...');await account.enterGuest();if(run!==lifecycle)return;await onUnlock();}
      catch(error){if(run===lifecycle){message=readableError(error,'Não foi possível abrir o uso sem cadastro.');if(currentState().unlocked)account.lock();}}
      finally{if(run===lifecycle){busy=false;reportBusy(null);if(!currentState().unlocked)render();}}
    };
    const bio=mount.querySelector('[data-local-biometric]');if(bio)bio.onclick=async()=>{
      const selected=selectedProfile();if(busy||!selected)return;
      const run=lifecycle;busy=true;bio.disabled=true;message='';clearForm(form);
      try{reportBusy('Confirmando o acesso no aparelho...');await biometric.unlock(selected.id);if(run!==lifecycle)return;await onUnlock();}
      catch(error){if(run===lifecycle){message=readableError(error,'Use sua senha para entrar.');if(currentState().unlocked)account.lock();}}
      finally{if(run===lifecycle){busy=false;reportBusy(null);if(!currentState().unlocked)render();}}
    };
    void updateBiometricButton();
  }
  function renderRecoverForm(){
    mount.innerHTML=layout(`<span class="eyebrow">RECUPERAÇÃO LOCAL</span><h1>Nova senha</h1><p class="auth-subtitle">Use o código que você guardou para este perfil.</p><form id="local-recovery-form"><label>Usuário<input name="username" required maxlength="40" minlength="3" autocapitalize="none" autocomplete="username" spellcheck="false" value="${escape(username)}" placeholder="seu.usuario"></label><label>Código de recuperação<input name="recoveryCode" required maxlength="100" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="PG-..."></label><label>Nova senha<input name="newPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="Pelo menos 8 caracteres"></label><label>Repetir nova senha<input name="confirmation" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="Digite a nova senha novamente"></label><p class="auth-error" role="alert" ${message?'':'hidden'}>${escape(message)}</p><button type="submit" class="button primary full" ${busy?'disabled':''}>Redefinir senha <img class="cassette-icon" src="/assets/cassette.svg" alt=""></button><button type="button" class="button secondary full" data-local-recovery-back ${busy?'disabled':''}>Voltar para Entrar</button></form><p class="auth-footnote">Não há envio por e-mail. Sem um código ativado e guardado antes, não é possível redefinir a senha. Os dados precisam continuar neste aparelho.</p>`);
    const form=mount.querySelector('form');form.elements.username.oninput=event=>username=event.target.value;
    mount.querySelector('[data-local-recovery-back]').onclick=()=>{if(busy)return;clearForm(form);mode='login';message='';render();};
    form.onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const fields=new FormData(form),run=lifecycle;username=String(fields.get('username')||'').trim();
      const code=String(fields.get('recoveryCode')||'').trim(),newPassword=String(fields.get('newPassword')||''),confirmation=String(fields.get('confirmation')||'');clearForm(form);
      if(newPassword!==confirmation){message='As senhas precisam ser iguais.';renderRecoverForm();return;}
      if(!code){message='Informe o código que você guardou.';renderRecoverForm();return;}
      busy=true;message='';form.querySelector('[type=submit]').disabled=true;
      try{
        if(currentState().unlocked)throw new Error('Saia do perfil antes de recuperar a senha.');
        reportBusy('Recuperando seu perfil local...');
        const result=await account.recoverPassword({username,recoveryCode:code,newPassword});if(run!==lifecycle)return;
        pendingRecovery={kind:'recover',username:result?.profile?.username||username,step:'generation-error',code:'',acknowledged:false,error:''};
        pendingRecovery.code=recoveryCode(result?.recoveryCode);pendingRecovery.step='code';
      }catch(error){if(run===lifecycle){if(pendingRecovery){pendingRecovery.step='generation-error';pendingRecovery.error=readableError(error,'Não foi possível exibir o novo código. Gere outro.');}else{message=readableError(error,'Não foi possível recuperar este perfil.');if(currentState().unlocked)account.lock();}}}
      finally{if(run===lifecycle){busy=false;reportBusy(null);render();}}
    };
  }
  function settingsMarkup() {
    const state=currentState(),profile=state.profile;
    if(state.guest)return `<section class="setting-card local-profile-card"><span class="eyebrow">SEM CADASTRO</span><h2>Visitante</h2><p>Uso sem senha neste aparelho</p><div class="backup-actions"><button type="button" class="button primary" data-local-create>Criar conta</button><button type="button" class="button secondary" data-local-lock>Sair</button></div><p class="form-hint">Seus treinos de visitante continuam salvos ao sair. Ao criar uma conta, você pode escolher copiar esses dados para um perfil com senha.</p></section>`;
    const known=recoveryProfileId===profile?.id&&recoveryEnabled!==null;
    return `<section class="setting-card local-profile-card"><span class="eyebrow">PERFIL LOCAL</span><h2>${escape(profile?.name)}</h2><p>@${escape(profile?.username)} · Dados criptografados</p><div class="backup-actions"><button type="button" class="button secondary" data-local-enroll ${support.available?'':'disabled'}>${enrolled?'Desativar digital / Face ID':'Ativar digital / Face ID'}</button><button type="button" class="button secondary" data-local-lock>Sair e bloquear</button></div><p class="form-hint" data-local-bio-status>${support.available?'A confirmação é feita pelo aparelho. Ele pode usar digital, rosto ou PIN.':'Este navegador não permite desbloqueio seguro do banco pelo aparelho. Use sua senha.'}</p></section><section class="setting-card local-recovery-card"><span class="eyebrow">ACESSO LOCAL</span><h2>Recuperação de senha</h2><p data-local-recovery-status role="status">${known?(recoveryEnabled?'Código de recuperação ativado.':'Recuperação ainda não ativada.'):'Consultando recuperação...'}</p><button type="button" class="button secondary" data-local-recovery-generate disabled>${known&&recoveryEnabled?'Renovar código':'Ativar recuperação'}</button><p class="form-hint">Guarde o código fora do aplicativo. Ele só funciona com os dados deste aparelho. Não há recuperação por e-mail.</p></section>`;
  }
  function openRecoverySettings(){
    if(busy||currentState().guest||!currentState().unlocked)return;
    const profile=currentState().profile,doc=mount.ownerDocument||globalThis.document;
    const status=mount.querySelector('[data-local-recovery-status]');
    if(!doc?.createElement||!doc.body){if(status)status.textContent='Não foi possível abrir o código neste navegador. Atualize a página e tente novamente.';return;}
    disposeRecoveryDialog?.();
    const dialog=doc.createElement('dialog');dialog.id='local-recovery-dialog';dialog.className='local-recovery-dialog';dialog.setAttribute('aria-label','Recuperação de senha');
    const state={step:'confirm',code:'',acknowledged:false,error:'',busy:false,closed:false};const run=lifecycle;
    function dispose(){
      if(state.closed)return;state.closed=true;state.code='';
      const input=dialog.querySelector('[data-local-recovery-code]');if(input)input.value='';
      const ack=dialog.querySelector('[data-local-recovery-ack]');if(ack)ack.checked=false;
      if(dialog.open&&typeof dialog.close==='function')dialog.close();dialog.innerHTML='';dialog.remove();
      if(disposeRecoveryDialog===dispose)disposeRecoveryDialog=null;
    }
    disposeRecoveryDialog=dispose;doc.body.append(dialog);
    function draw(){
      if(state.closed)return;
      dialog.innerHTML=`<form class="local-recovery-dialog-form"><span class="eyebrow">RECUPERAÇÃO DE SENHA</span><h2>${state.step==='code'?'Guarde seu novo código':'Gerar um novo código?'}</h2>${state.step==='code'?codeMarkup(state.acknowledged,'Fechar'):`<p class="auth-recovery-intro">O código anterior deixará de funcionar. Sua senha e seus treinos serão mantidos.</p><p class="auth-error" data-local-recovery-error role="alert" ${state.error?'':'hidden'}>${escape(state.error)}</p><div class="auth-recovery-actions"><button type="button" class="button primary full" data-local-recovery-confirm ${state.busy?'disabled':''}>${state.busy?'Gerando...':'Gerar novo código'}</button><button type="button" class="button secondary full" data-local-recovery-cancel ${state.busy?'disabled':''}>Cancelar</button></div>`}</form>`;
      const form=dialog.querySelector('form');form.onsubmit=event=>{event.preventDefault();return state.step==='code'?finish():generate();};
      const confirm=dialog.querySelector('[data-local-recovery-confirm]');if(confirm)confirm.onclick=generate;
      const cancel=dialog.querySelector('[data-local-recovery-cancel]');if(cancel)cancel.onclick=()=>{if(!state.busy)dispose();};
      if(state.step==='code'){
        const input=dialog.querySelector('[data-local-recovery-code]');input.value=state.code;
        const ack=dialog.querySelector('[data-local-recovery-ack]'),button=dialog.querySelector('[data-local-recovery-continue]');
        button.disabled=!state.acknowledged||state.busy;
        ack.onchange=()=>{if(state.busy)return;state.acknowledged=ack.checked;button.disabled=!ack.checked;};button.onclick=finish;
      }
    }
    async function generate(){
      if(busy||state.busy||state.closed||!liveProfile(profile.id))return;
      busy=true;state.busy=true;state.error='';draw();
      try{reportBusy('Gerando seu código de recuperação...');const code=await account.createRecoveryCode();if(run!==lifecycle||state.closed||!liveProfile(profile.id))return;state.code=recoveryCode(code);state.step='code';state.acknowledged=false;recoveryEnabled=true;recoveryProfileId=profile.id;}
      catch(error){if(run===lifecycle&&!state.closed)state.error=readableError(error,'Não foi possível gerar seu código agora.');}
      finally{if(run===lifecycle){busy=false;state.busy=false;reportBusy(null);if(!liveProfile(profile.id))dispose();else draw();}}
    }
    async function finish(){
      const checkbox=dialog.querySelector('[data-local-recovery-ack]');
      if(busy||state.busy||state.closed||!checkbox?.checked)return;
      busy=true;state.busy=true;dispose();
      try{reportBusy('Atualizando a recuperação...');if(run===lifecycle&&liveProfile(profile.id))await onRefresh();}
      catch(error){if(run===lifecycle&&status?.isConnected)status.textContent=readableError(error,'Código gerado. Atualize os Ajustes para consultar o status.');}
      finally{if(run===lifecycle){busy=false;reportBusy(null);}}
    }
    dialog.oncancel=event=>{event.preventDefault();if(state.busy)return;if(state.step==='code'){if(state.acknowledged)void finish();return;}dispose();};
    dialog.onclose=dispose;draw();if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  }
  function bindSettings() {
    const button=mount.querySelector('[data-local-enroll]'),lock=mount.querySelector('[data-local-lock]');
    if(lock)lock.onclick=()=>{if(!busy)void onLock();};
    const create=mount.querySelector('[data-local-create]');if(create)create.onclick=async()=>{
      if(busy)return;busy=true;
      try{reportBusy('Preparando o cadastro opcional...');await onLock();mode='register';username='';message='';enrolled=false;}
      catch(error){message=readableError(error,'Não foi possível abrir o cadastro.');}
      finally{busy=false;reportBusy(null);if(!currentState().unlocked)render();}
    };
    if(currentState().guest)return;
    const profile=currentState().profile;if(!profile)return;
    if(button){
      button.disabled=true;
      void biometric.hasEnrollment(profile.id).then(value=>{if(!button.isConnected||currentState().profile?.id!==profile.id)return;enrolled=value;button.disabled=!support.available;button.textContent=enrolled?'Desativar digital / Face ID':'Ativar digital / Face ID';}).catch(()=>{});
      button.onclick=async()=>{
        if(busy||button.disabled)return;const run=lifecycle;busy=true;button.disabled=true;
        const status=mount.querySelector('[data-local-bio-status]');
        try{reportBusy(enrolled?'Desativando o acesso pelo aparelho...':'Ativando o acesso pelo aparelho...');if(enrolled)await biometric.remove(profile.id);else await biometric.enroll();if(run!==lifecycle||!liveProfile(profile.id))return;enrolled=!enrolled;button.textContent=enrolled?'Desativar digital / Face ID':'Ativar digital / Face ID';if(status)status.textContent=enrolled?'Desbloqueio do aparelho ativado. Sua senha continua funcionando.':'Desbloqueio do aparelho desativado.';await onRefresh();}
        catch(error){if(run===lifecycle&&status?.isConnected)status.textContent=readableError(error,'Não foi possível ativar. Continue usando sua senha.');}
        finally{if(run===lifecycle){busy=false;button.disabled=!support.available;reportBusy(null);}}
      };
    }
    const recoveryButton=mount.querySelector('[data-local-recovery-generate]'),recoveryStatus=mount.querySelector('[data-local-recovery-status]');
    if(recoveryButton){
      recoveryButton.onclick=openRecoverySettings;
      const ticket=++settingsRequest,run=lifecycle;busy=true;recoveryButton.disabled=true;
      if(recoveryStatus)recoveryStatus.textContent='Consultando recuperação...';reportBusy('Consultando a recuperação de senha...');
      void (async()=>{
        try{const status=await account.getRecoveryStatus();if(ticket!==settingsRequest||run!==lifecycle||!liveProfile(profile.id)||!recoveryButton.isConnected)return;recoveryEnabled=status?.enabled===true;recoveryProfileId=profile.id;if(recoveryStatus)recoveryStatus.textContent=recoveryEnabled?'Código de recuperação ativado.':'Recuperação ainda não ativada.';recoveryButton.textContent=recoveryEnabled?'Renovar código':'Ativar recuperação';}
        catch(error){if(ticket===settingsRequest&&run===lifecycle&&recoveryStatus?.isConnected)recoveryStatus.textContent=readableError(error,'Não foi possível consultar a recuperação. Você pode gerar um novo código.');}
        finally{if(ticket===settingsRequest&&run===lifecycle){busy=false;reportBusy(null);if(recoveryButton.isConnected)recoveryButton.disabled=!liveProfile(profile.id);}}
      })();
    }
  }
  async function reset(){
    const run=++lifecycle;settingsRequest++;clearRecovery();disposeRecoveryDialog?.();message='';mode='login';enrolled=false;recoveryEnabled=null;recoveryProfileId=null;busy=false;reportBusy(null);
    await initialize();if(run===lifecycle)render();
  }
  return {initialize,render,settingsMarkup,bindSettings,reset,hasPendingRecovery};
}

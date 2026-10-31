const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createLocalAuthUI({mount, account, biometric, onUnlock, onLock, onRefresh=async()=>{}}) {
  let profiles=[], mode='login', busy=false, username='', message='', support={available:false}, enrolled=false;
  async function initialize() {
    profiles=await account.listProfiles();
    if(!profiles.length)mode='register';
    try{support=await biometric.support();}catch(_){support={available:false};}
    if(!username&&profiles.length)username=profiles[0].username;
  }
  const selectedProfile=()=>profiles.find(p=>p.username===username.trim().toLowerCase());
  async function updateBiometricButton() {
    const selected=selectedProfile(), button=mount.querySelector('[data-local-biometric]');
    if(!button)return;
    let exists=false;
    try{exists=!!selected&&await biometric.hasEnrollment(selected.id);}catch(_){}
    if(!button.isConnected||selectedProfile()?.id!==selected?.id)return;
    button.hidden=!(support.available&&exists);
    button.disabled=busy;
  }
  function render() {
    mount.innerHTML=`<section class="auth-layout" aria-label="Acesso local"><div class="auth-cover"><span class="eyebrow">SEU TREINO. SUA FITA.</span><img class="auth-cassette" src="/peragym/docs/assets/cassette.svg" alt="Fita cassete PeraGym"><p>Play no treino.</p><span class="auth-side">SIDE A · PERAGYM</span></div><div class="auth-card"><div class="auth-tabs" role="group" aria-label="Tipo de acesso"><button type="button" data-auth-mode="login" class="${mode==='login'?'active':''}" aria-pressed="${mode==='login'}">Entrar</button><button type="button" data-auth-mode="register" class="${mode==='register'?'active':''}" aria-pressed="${mode==='register'}">Criar conta</button></div><span class="eyebrow">NESTE APARELHO</span><h1>${mode==='register'?'Criar conta':'Bom treino.'}</h1><p class="auth-subtitle">${mode==='register'?'Um perfil só seu.':'Entre para abrir suas fichas.'}</p><form id="local-auth-form">${mode==='register'?'<label>Seu nome<input name="name" required maxlength="60" autocomplete="name" placeholder="Como você se chama?"></label>':''}<label>Usuário<input name="username" required maxlength="40" minlength="3" autocapitalize="none" autocomplete="username" spellcheck="false" value="${escape(username)}" placeholder="seu.usuario" ${profiles.length?'list="local-profile-names"':''}></label>${profiles.length?`<datalist id="local-profile-names">${profiles.map(p=>`<option value="${escape(p.username)}">${escape(p.name)}</option>`).join('')}</datalist>`:''}<label>Senha<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="${mode==='register'?'new-password':'current-password'}" placeholder="${mode==='register'?'Pelo menos 8 caracteres':'Sua senha local'}"></label>${mode==='register'?'<label>Repetir senha<input name="confirmation" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="Digite a senha novamente"></label>':''}<p class="auth-error" role="alert" ${message?'':'hidden'}>${escape(message)}</p><button class="button primary full" type="submit" ${busy?'disabled':''}>${busy?'Abrindo...':mode==='register'?'Criar conta':'Entrar'} <img class="cassette-icon" src="/peragym/docs/assets/cassette.svg" alt=""></button>${mode==='login'?'<button type="button" class="button secondary full biometric-login" data-local-biometric hidden>Digital / Face ID</button>':''}</form><p class="auth-footnote">Dados criptografados neste aparelho. Guarde sua senha: ela não pode ser recuperada.</p></div></section>`;
    mount.querySelectorAll('[data-auth-mode]').forEach(button=>button.onclick=()=>{if(busy)return;mode=button.dataset.authMode;message='';render();});
    const form=mount.querySelector('form');
    form.elements.username.oninput=event=>{username=event.target.value;void updateBiometricButton();};
    form.onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const fields=new FormData(form);username=String(fields.get('username')).trim();
      const password=String(fields.get('password'));
      if(mode==='register'&&password!==fields.get('confirmation')){message='As senhas precisam ser iguais.';render();return;}
      busy=true;message='';form.querySelector('[type=submit]').disabled=true;
      try{
        if(mode==='register')await account.register({name:String(fields.get('name')),username,password});
        else await account.login(username,password);
        // Remove password inputs before training data is rendered.
        form.reset();await onUnlock();
      }catch(error){message=error.message||'Não foi possível entrar.';if(account.getState().unlocked)account.lock();}
      finally{busy=false;if(!account.getState().unlocked)render();}
    };
    const bio=mount.querySelector('[data-local-biometric]');
    if(bio)bio.onclick=async()=>{
      const selected=selectedProfile();if(busy||!selected)return;
      busy=true;bio.disabled=true;message='';
      try{await biometric.unlock(selected.id);await onUnlock();}
      catch(error){message=error.message||'Use sua senha para entrar.';if(account.getState().unlocked)account.lock();}
      finally{busy=false;if(!account.getState().unlocked)render();}
    };
    void updateBiometricButton();
  }
  function settingsMarkup() {
    const profile=account.getState().profile;
    return `<section class="setting-card local-profile-card"><span class="eyebrow">PERFIL LOCAL</span><h2>${escape(profile?.name)}</h2><p>@${escape(profile?.username)} · Dados criptografados</p><div class="backup-actions"><button type="button" class="button secondary" data-local-enroll ${support.available?'':'disabled'}>${enrolled?'Desativar digital / Face ID':'Ativar digital / Face ID'}</button><button type="button" class="button secondary" data-local-lock>Sair e bloquear</button></div><p class="form-hint" data-local-bio-status>${support.available?'A confirmação é feita pelo aparelho. Ele pode usar digital, rosto ou PIN.':'Este navegador não permite desbloqueio seguro do banco pelo aparelho. Use sua senha.'}</p></section>`;
  }
  function bindSettings() {
    const button=mount.querySelector('[data-local-enroll]'), lock=mount.querySelector('[data-local-lock]');
    if(lock)lock.onclick=()=>{void onLock();};
    if(!button)return;
    const profile=account.getState().profile;
    button.disabled=true;
    void biometric.hasEnrollment(profile.id).then(value=>{if(!button.isConnected||account.getState().profile?.id!==profile.id)return;enrolled=value;button.disabled=!support.available;button.textContent=enrolled?'Desativar digital / Face ID':'Ativar digital / Face ID';}).catch(()=>{});
    button.onclick=async()=>{
      if(button.disabled)return;button.disabled=true;
      const status=mount.querySelector('[data-local-bio-status]');
      try{if(enrolled)await biometric.remove(profile.id);else await biometric.enroll();enrolled=!enrolled;button.textContent=enrolled?'Desativar digital / Face ID':'Ativar digital / Face ID';status.textContent=enrolled?'Desbloqueio do aparelho ativado. Sua senha continua funcionando.':'Desbloqueio do aparelho desativado.';await onRefresh();}
      catch(error){status.textContent=error.message||'Não foi possível ativar. Continue usando sua senha.';}
      finally{button.disabled=false;}
    };
  }
  async function reset(){message='';mode='login';enrolled=false;await initialize();render();}
  return {initialize,render,settingsMarkup,bindSettings,reset};
}

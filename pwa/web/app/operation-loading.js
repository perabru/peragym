/** Shared foreground status for real asynchronous work. No artificial delay or progress. */
export function createOperationLoading({document=globalThis.document}={}) {
  const operations=new Map();
  let dialog,title,status,focusBefore=null,sequence=0,revision=0;
  const messageText=message=>typeof message==='string'&&message.trim()?message.trim().slice(0,300):'Aguarde um instante...';
  function ensureDialog() {
    if(dialog?.isConnected)return;
    const existing=document?.getElementById?.('operation-loading');
    dialog=existing?.tagName?.toLowerCase()==='dialog'?existing:document.createElement('dialog');
    dialog.id='operation-loading';dialog.classList.add('operation-loading');
    dialog.setAttribute('aria-labelledby','operation-loading-title');
    dialog.setAttribute('aria-modal','true');
    // Only this dialog is owned by the helper; editor and settings remain intact.
    dialog.replaceChildren();
    const content=document.createElement('div');content.className='operation-loading-content';
    const image=document.createElement('img');image.src='/assets/cassette.svg';image.alt='';
    image.width=100;image.height=64;image.setAttribute('aria-hidden','true');image.className='operation-loading-cassette';
    title=document.createElement('h2');title.id='operation-loading-title';title.textContent='Um instante...';
    status=document.createElement('p');status.className='operation-loading-message';status.setAttribute('role','status');
    status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
    const indicator=document.createElement('div');indicator.className='operation-loading-indicator';indicator.setAttribute('aria-hidden','true');
    for(let index=0;index<3;index++)indicator.append(document.createElement('span'));
    content.append(image,title,status,indicator);dialog.append(content);
    dialog.addEventListener('cancel',event=>event.preventDefault());
    if(!dialog.isConnected)document.body.append(dialog);
  }
  function showLatest() {
    ensureDialog();
    let newest='';for(const message of operations.values())newest=message;
    status.textContent=newest;dialog.setAttribute('aria-busy','true');
    document.body.classList.add('operation-busy');
    if(!dialog.open)dialog.showModal();
  }
  function hide() {
    document?.body?.classList.remove('operation-busy');
    if(dialog){dialog.setAttribute('aria-busy','false');if(dialog.open)dialog.close();}
    if(status)status.textContent='';
    const target=focusBefore;focusBefore=null;
    if(target&&target.isConnected!==false&&!target.disabled){try{target.focus({preventScroll:true});}catch{/* The previous control may have been removed while saving. */}}
  }
  function start(message) {
    if(!operations.size)focusBefore=document?.activeElement||null;
    const token=++sequence,current=revision;
    operations.set(token,messageText(message));
    try{showLatest();}catch(error){operations.delete(token);if(!operations.size)hide();throw error;}
    let released=false;
    return function release() {
      if(released||current!==revision)return;
      released=true;operations.delete(token);
      if(operations.size)showLatest();else hide();
    };
  }
  function run(message,task) {
    if(typeof task!=='function')return Promise.reject(new TypeError('A operação precisa ser uma função.'));
    const release=start(message);
    let result;
    // Keep permission/popup APIs on the original click stack, before any await.
    try{result=task();}catch(error){release();return Promise.reject(error);}
    return Promise.resolve(result).finally(release);
  }
  function track(message,promise) {
    const release=start(message);
    return Promise.resolve(promise).finally(release);
  }
  function clear() {revision++;operations.clear();hide();}
  return {start,run,track,clear};
}

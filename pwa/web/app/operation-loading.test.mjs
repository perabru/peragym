import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationLoading} from './operation-loading.js';

function fixture(){
 const document={activeElement:null};const nodes=[];
 function createElement(tag){
  const classes=new Set(),attributes=new Map(),events=new Map();
  const node={tagName:tag.toUpperCase(),children:[],open:false,isConnected:false,disabled:false,id:'',className:'',textContent:'',focusCalls:[],showCalls:0,closeCalls:0,
   classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)},
   setAttribute(name,value){attributes.set(name,String(value));},getAttribute:name=>attributes.get(name)??null,
   append(...children){for(const child of children){child.parentNode=node;child.isConnected=node.isConnected;node.children.push(child);}},
   replaceChildren(...children){node.children=[];node.append(...children);},
   addEventListener(name,fn){const list=events.get(name)||[];list.push(fn);events.set(name,list);},
   dispatch(name,event){for(const fn of events.get(name)||[])fn(event);},
   showModal(){assert.equal(node.isConnected,true);node.showCalls++;node.open=true;document.activeElement=node;},
   close(){node.closeCalls++;node.open=false;},focus(options){node.focusCalls.push(options);document.activeElement=node;}
  };
  Object.defineProperty(node,'innerHTML',{set(){throw new Error('Messages must never use innerHTML');}});
  nodes.push(node);return node;
 }
 document.createElement=createElement;document.body=createElement('body');document.body.isConnected=true;
 document.getElementById=id=>nodes.find(node=>node.id===id&&node.isConnected)||null;
 const previous=createElement('button');document.body.append(previous);document.activeElement=previous;
 const helper=createOperationLoading({document});
 const dialog=()=>document.getElementById('operation-loading');
 const allChildren=node=>[node,...node.children.flatMap(allChildren)];
 const status=()=>allChildren(dialog()).find(node=>node.getAttribute('role')==='status');
 return {document,helper,previous,dialog,status,createElement,allChildren,nodes};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test('status dialog is created lazily and uses accessible plain text without invented progress',()=>{
 const f=fixture();assert.equal(f.dialog(),null);
 const release=f.helper.start('<img src=x onerror=alert(1)> Salvando ficha');
 assert.equal(f.dialog().open,true);assert.equal(f.dialog().getAttribute('aria-labelledby'),'operation-loading-title');assert.equal(f.dialog().getAttribute('aria-modal'),'true');assert.equal(f.dialog().getAttribute('aria-busy'),'true');
 assert.equal(f.status().textContent,'<img src=x onerror=alert(1)> Salvando ficha');assert.equal(f.status().getAttribute('aria-live'),'polite');
 assert.equal(f.allChildren(f.dialog()).some(n=>n.getAttribute('role')==='progressbar'||n.getAttribute('aria-valuenow')!==null),false);
 assert.equal(f.document.body.classList.contains('operation-busy'),true);release();
 assert.equal(f.dialog().open,false);assert.equal(f.document.body.classList.contains('operation-busy'),false);
});

test('Escape cancellation is prevented while real work remains pending',()=>{
 const f=fixture(),release=f.helper.start('Salvando');let prevented=false;
 f.dialog().dispatch('cancel',{preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(f.dialog().open,true);release();
});

test('overlapping operations keep the newest message and stay visible until all settle',()=>{
 const f=fixture(),older=f.helper.start('Salvando ficha'),newer=f.helper.start('Carregando histórico');
 assert.equal(f.status().textContent,'Carregando histórico');older();assert.equal(f.status().textContent,'Carregando histórico');assert.equal(f.dialog().open,true);
 older();assert.equal(f.dialog().open,true);newer();assert.equal(f.dialog().open,false);assert.equal(f.previous.focusCalls.length,1);
});

test('finishing the newest operation restores the message of the still-running older operation',()=>{
 const f=fixture(),older=f.helper.start('Importando backup'),newer=f.helper.start('Atualizando gráficos');
 newer();assert.equal(f.status().textContent,'Importando backup');assert.equal(f.dialog().open,true);older();assert.equal(f.dialog().open,false);
});

test('clear invalidates old release functions and cannot close a newer operation',()=>{
 const f=fixture(),old=f.helper.start('Conta anterior');f.helper.clear();assert.equal(f.dialog().open,false);assert.equal(f.status().textContent,'');
 const current=f.helper.start('Nova conta');old();assert.equal(f.dialog().open,true);assert.equal(f.status().textContent,'Nova conta');
 current();assert.equal(f.dialog().open,false);f.helper.clear();assert.equal(f.document.body.classList.contains('operation-busy'),false);
});

test('run invokes task synchronously on the caller gesture and preserves its eventual result',async()=>{
 const f=fixture(),pending=deferred();let onGesture=true,called=false;
 const result=f.helper.run('Abrindo autorização',()=>{assert.equal(onGesture,true);called=true;assert.equal(f.dialog().open,true);return pending.promise;});
 onGesture=false;assert.equal(called,true);assert.equal(f.dialog().open,true);pending.resolve({ok:true});assert.deepEqual(await result,{ok:true});assert.equal(f.dialog().open,false);
});

test('a synchronously throwing operation propagates its original error and restores focus',async()=>{
 const f=fixture(),error=new Error('Falha do banco');const result=f.helper.run('Salvando',()=>{throw error;});
 await assert.rejects(result,value=>value===error);assert.equal(f.dialog().open,false);assert.equal(f.document.activeElement,f.previous);assert.equal(f.previous.focusCalls.length,1);
});

test('asynchronous failures propagate and release busy state without masking the error',async()=>{
 const f=fixture(),pending=deferred(),error=new Error('Espaço insuficiente');const result=f.helper.run('Importando',()=>pending.promise);
 pending.reject(error);await assert.rejects(result,value=>value===error);assert.equal(f.dialog().open,false);assert.equal(f.dialog().getAttribute('aria-busy'),'false');assert.equal(f.document.body.classList.contains('operation-busy'),false);
});

test('track wraps an already-created promise and keeps the same success/error semantics',async()=>{
 const f=fixture(),pending=deferred();const success=f.helper.track('Carregando',pending.promise);assert.equal(f.dialog().open,true);
 pending.resolve(42);assert.equal(await success,42);assert.equal(f.dialog().open,false);
 const error=new Error('Indisponível');await assert.rejects(f.helper.track('Tentando novamente',Promise.reject(error)),value=>value===error);assert.equal(f.dialog().open,false);
});

test('nested run operations do not dismiss another task which is still pending',async()=>{
 const f=fixture(),first=deferred(),second=deferred();
 const one=f.helper.run('Salvando',()=>first.promise),two=f.helper.run('Atualizando',()=>second.promise);
 second.resolve();await two;assert.equal(f.dialog().open,true);assert.equal(f.status().textContent,'Salvando');first.resolve();await one;assert.equal(f.dialog().open,false);
});

test('the helper reuses its own existing dialog without touching an editor dialog or its roles',()=>{
 const f=fixture(),editor=f.createElement('dialog');editor.id='editor';editor.open=true;editor.setAttribute('role','form');editor.setAttribute('aria-labelledby','editor-title');f.document.body.append(editor);
 const existing=f.createElement('dialog');existing.id='operation-loading';f.document.body.append(existing);
 const release=f.helper.start('Salvando ficha');assert.equal(f.dialog(),existing);release();
 assert.equal(editor.open,true);assert.equal(editor.getAttribute('role'),'form');assert.equal(editor.getAttribute('aria-labelledby'),'editor-title');
});

test('focus returns to the original control only once and ignores a control removed during work',()=>{
 const f=fixture(),release=f.helper.start('Salvando');release();release();assert.equal(f.previous.focusCalls.length,1);
 f.previous.isConnected=false;const second=f.helper.start('Outra operação');second();assert.equal(f.previous.focusCalls.length,1);
});

test('clearing an idle helper does not create a dialog or move focus',()=>{
 const f=fixture();f.helper.clear();assert.equal(f.dialog(),null);assert.equal(f.previous.focusCalls.length,0);
});

test('a nonfunction task rejects before creating a busy overlay',async()=>{
 const f=fixture();await assert.rejects(f.helper.run('Inválido',null),TypeError);assert.equal(f.dialog(),null);
});

test('an active release updates real progress in the same dialog without reopening or moving focus',()=>{
 const f=fixture(),release=f.helper.start('Carregando playlists…'),dialog=f.dialog(),focus=f.document.activeElement;
 assert.equal(typeof release.update,'function');release.update('Carregadas 50 playlists…');
 assert.equal(f.dialog(),dialog);assert.equal(f.status().textContent,'Carregadas 50 playlists…');assert.equal(dialog.showCalls,1);assert.equal(dialog.closeCalls,0);assert.equal(f.document.activeElement,focus);assert.equal(f.previous.focusCalls.length,0);
 release.update('<script>alert(1)</script>');assert.equal(f.status().textContent,'<script>alert(1)</script>');release();assert.equal(dialog.closeCalls,1);
});

test('updating an older operation preserves the newer operation priority until it finishes',()=>{
 const f=fixture(),older=f.helper.start('Carregando playlists…'),newer=f.helper.start('Abrindo player…');
 older.update('Carregadas 100 playlists…');assert.equal(f.status().textContent,'Abrindo player…');
 newer.update('Player conectado.');assert.equal(f.status().textContent,'Player conectado.');assert.equal(f.dialog().showCalls,1);
 newer();assert.equal(f.status().textContent,'Carregadas 100 playlists…');assert.equal(f.dialog().open,true);older();
});

test('updates after release never recreate busy UI or overwrite another operation',()=>{
 const f=fixture(),old=f.helper.start('Primeira operação');old();old.update('Resposta tardia');assert.equal(f.dialog().open,false);assert.equal(f.status().textContent,'');
 const next=f.helper.start('Operação atual');old.update('Outro retorno tardio');assert.equal(f.status().textContent,'Operação atual');assert.equal(f.dialog().showCalls,2);next();
});

test('clear invalidates pending progress callbacks even when a new profile starts an operation',()=>{
 const f=fixture(),old=f.helper.start('Perfil anterior');f.helper.clear();
 old.update('Dado antigo');assert.equal(f.dialog().open,false);assert.equal(f.status().textContent,'');
 const current=f.helper.start('Novo perfil');old.update('Retorno do perfil anterior');assert.equal(f.status().textContent,'Novo perfil');assert.equal(f.dialog().showCalls,2);current();
});

test('a progress update cannot reopen an externally closed dialog',()=>{
 const f=fixture(),release=f.helper.start('Carregando…'),dialog=f.dialog();dialog.close();const focus=f.document.activeElement;
 release.update('Carregadas 50 linhas…');assert.equal(dialog.open,false);assert.equal(dialog.showCalls,1);assert.equal(f.document.activeElement,focus);release();
});

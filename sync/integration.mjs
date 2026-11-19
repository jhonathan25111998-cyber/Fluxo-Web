import { watchGeneration } from './generation.mjs';
import { mountCurrentImport } from './current-import-ui.mjs';
import { mountRestoration } from './restoration-ui.mjs';
import { listDrafts } from './drafts.mjs';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth, db } from './firebase.mjs';
import { openTaskStore } from './runtime/task-store.mjs';
import { startTaskSession } from './runtime/task-session.mjs';
import { accountStorage } from '../account-storage.js';
import { mountLabUI } from './ui.mjs';
import { makeBackup, recover, savedRecovery } from './recovery.mjs';
import './register-sw.mjs';

let stopGeneration;
const localDb = await openLocalStore();
async function openLocalStore() {
  const status = document.getElementById('status');
  while (true) {
    try {
      const db = await openTaskStore();
      status.textContent = 'Escolha uma conta para começar.';
      return db;
    } catch {
      status.textContent = 'Não foi possível abrir o armazenamento local. Nenhum dado foi apagado. '
        + 'Verifique as permissões ou o espaço disponível e tente novamente.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Tentar abrir novamente';
      status.append(retry);
      await new Promise(resolve => retry.addEventListener('click', () => {
        retry.disabled = true;
        resolve();
      }, { once: true }));
      retry.remove();
    }
  }
}
const el = id => document.getElementById(id);
let current;
const ui = mountLabUI({ session: () => current?.session, identity: () => current });
const message = value => { el('status').textContent = value; };
const restoration = mountRestoration({ owner: () => current, message });
const importer = mountCurrentImport({owner:()=>current});
function reset() {
  el('control-status').hidden=true;
  current?.session.close(); current=undefined; ui.clear(); importer.clear();
  el('recovery-file').value=''; restoration.clear(true); el('saved-backup-list').replaceChildren();
  el('space-form').reset(); el('password').value='';
}
onAuthStateChanged(auth,user=>{
  stopGeneration?.();reset();
  el('email').value=user?.email??'';
  el('email').disabled=el('password').disabled=el('login').disabled=false;
  el('logout').hidden=!user;
  if(!user)return;
  stopGeneration=watchGeneration(user,control=>{
    if(!control.ready){reset();message(control.message);el('logout').hidden=false;return;}
    function showControl(){el('control-status').textContent=!control.confirmed?'Cópia local anteriormente conferida; envios pausados até verificar a geração no servidor.':control.status!=='active'?'Geração pausada; alterações locais preservadas.':'';el('control-status').hidden=!el('control-status').textContent;}
    if(current?.uid===user.uid&&current.generation===control.generation){current.control=control;showControl();void current.session.flush();return;}
    reset();const context={uid:user.uid,generation:control.generation,control};current=context;
    context.session=startTaskSession({db,localDb,uid:user.uid,generation:context.generation,
      securityPaused:()=>!context.control.confirmed||context.control.status!=='active',
      notify(value){if(current===context){message(value);void ui.render();}}});
    showControl();void ui.render();
  });
});

async function action(work) {
  const owner = current;
  try { await work(); } catch (error) { if (owner === current) message(error.message); }
}
el('login').onclick = () => void action(async () => {
  const email = el('email').value.trim();
  await signInWithEmailAndPassword(auth, email, el('password').value);
  el('password').value = '';
});
el('logout').onclick = () => void action(() => signOut(auth));
function download(raw, name) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
el('export-sync').onclick = () => void action(async () => {
  const owner = current;
  const raw = await makeBackup(owner, await owner.session.state());
  if (owner === current) download(raw, 'fluxo-backup.json');
});
el('recover-sync').onclick = () => void action(async () => {
  const owner = current;
  const file = el('recovery-file').files[0];
  if (!file) throw new Error('Escolha o arquivo a preservar.');
  const raw = await file.text();
  if (owner !== current) return;
  await recover(raw, owner, () => owner === current, accountStorage(localStorage, owner.uid));
  if (owner === current) message('Cópia recuperável conferida. Envio pausado.');
});
el('export-recovery').onclick = () => void action(async () => {
  const owner = current;
  const raw = await savedRecovery(owner);
  if (owner === current && raw) download(raw, 'fluxo-recuperacao.json');
});

el('space-form').onsubmit = event => {
  event.preventDefault();
  void action(async () => {
    const owner = current;
    await owner.session.enqueue('espaco_' + crypto.randomUUID(), { name: el('space-form').elements.name.value },
      { kind: 'space', create: true });
    if (owner === current) { el('space-form').reset(); await ui.render(); }
  });
};
el('drafts-export').onclick = () => void action(async () => {
  const owner = current;
  const drafts = await listDrafts(owner.uid, owner.generation);
  if (owner === current) download(JSON.stringify(drafts), 'fluxo-rascunhos.json');
});


el('saved-backups').onclick = () => void action(async () => {
  const owner = current;
  if (!owner) throw new Error('Entre com sua conta.');
  const copies = (await listDrafts(owner.uid, owner.generation)).filter(row => row.data.type === 'backupPorRegistro');
  if (owner !== current) return;
  el('saved-backup-list').replaceChildren();
  copies.forEach((copy, index) => {
    const button = document.createElement('button');
    button.textContent = 'Baixar cópia preservada ' + (index + 1);
    button.onclick = () => { if (owner === current) download(copy.data.raw, 'fluxo-copia-preservada.json'); };
    el('saved-backup-list').append(button);
  });
});


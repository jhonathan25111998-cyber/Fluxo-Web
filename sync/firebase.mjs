import config from '../runtime-config.js';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

function block(message) {
  const panel = document.createElement('section');
  panel.setAttribute('role','alert'); panel.textContent = message;
  document.body.replaceChildren(panel);
  throw new Error(message);
}
if (!config.enabled) block('Versão candidata preservada. A conexão ao Firebase está desabilitada até a autorização de publicação.');
if (config.protocol !== 3) block('Configuração de versão incompatível. Nenhum dado foi enviado.');
if (config.mode === 'emulator') {
  if (location.hostname !== '127.0.0.1' || !config.firebase.projectId.startsWith('demo-')) block('Emulador permitido somente em 127.0.0.1 e projeto fictício.');
} else if (config.mode !== 'production' || location.protocol !== 'https:') block('A versão real exige HTTPS e configuração de produção explícita.');
export const app = initializeApp(config.firebase);
export const auth = getAuth(app);
export const db = getFirestore(app);
if (config.mode === 'emulator') {
  connectAuthEmulator(auth,'http://127.0.0.1:9199',{disableWarnings:true});
  connectFirestoreEmulator(db,'127.0.0.1',8189);
}
// A fila persistente do Fluxo controla as gravações; não habilitar outra fila no SDK.
try { await setPersistence(auth,browserLocalPersistence); }
catch { block('Não foi possível preservar a sessão neste navegador. Verifique as permissões de armazenamento e reabra o Fluxo. Nenhum dado foi apagado.'); }

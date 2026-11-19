import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase.mjs';
import { validControl } from './generation-model.mjs';
import { DATA_ENABLED, ACTIVATION_MESSAGE } from './deployment-policy.mjs';

export function watchGeneration(user, notify) {
  if (!DATA_ENABLED) { notify({ready:false,message:ACTIVATION_MESSAGE}); return () => {}; }
  let closed = false;
  const key = 'fluxo:generation:v3:' + user.uid;
  const emit = value => { if (!closed) notify(value); };
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* preservado */ }
  let previous = validControl(cached);
  // navigator.onLine pode permanecer true quando apenas o roteador está acessível.
  // A cópia antes validada continua editável; nunca autoriza envios sem o servidor.
  const fallback = setTimeout(() => {
    if(previous)emit({...previous,ready:true,confirmed:false});
  },5000);
  if (previous && !navigator.onLine) emit({...previous,ready:true,confirmed:false});
  else emit({ready:false,message:'Verificando a geração desta conta. Os dados antigos permanecem preservados.'});
  const stop = onSnapshot(doc(db,'fluxoSync',user.uid),{includeMetadataChanges:true},snapshot => {
    // Uma falta no cache em memória não invalida a geração já conferida no disco.
    // Online, aguardar o servidor também evita exibir brevemente a geração anterior.
    if(snapshot.metadata.fromCache) return;
    clearTimeout(fallback);
    const control = validControl(snapshot.exists() ? snapshot.data() : null);
    if (!control) {
      emit({ready:false,message:'Geração ausente ou incompatível. A ativação exige configuração aprovada no Firebase. Nenhum dado legado foi carregado.'});
      return;
    }
    const confirmed = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
    previous = control;
    if (confirmed) { try { localStorage.setItem(key,JSON.stringify(snapshot.data())); } catch { /* fila permanece no IndexedDB */ } }
    emit({...control,ready:true,confirmed});
  },() => {clearTimeout(fallback);emit(previous ? {...previous,ready:true,confirmed:false} :
    {ready:false,message:'Não foi possível verificar a geração. Confira a conexão e as permissões. Nenhum dado foi apagado.'});});
  return () => { closed=true; clearTimeout(fallback); stop(); };
}

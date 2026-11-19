import { watchGeneration } from './sync/generation.mjs';
import { showActivationScreen, hideActivationScreen } from './sync/activation-screen.mjs';
import { authMessage } from './sync/auth-errors.mjs';
import './sync/register-sw.mjs';
import { civilToday, displayTimeZone } from './sync/runtime/recurrence.mjs';
import { focusClock } from './sync/focus-clock.mjs';
import { installAccessibility } from './sync/accessibility.mjs';
import { isLocalDate } from './sync/monthly.mjs';
import { makeBackup } from './sync/recovery.mjs';
import { keepDraft } from './sync/drafts.mjs';
import { openAdapter } from './sync/adapter.mjs';
const perRecord = true;
if (perRecord) document.getElementById('emergency-draft-export').hidden = false;
let recordAdapter, integratedProfile = {}, integratedSync, integratedCounters={}, focusCycleId, focusCycleSeconds, runningFocusClock, focusTick;
let displayedCivilDay;
let avatarReader = null, avatarReadVersion = 0;
import { accountStorage } from './account-storage.js';
import { avatar as renderAvatar, domCardKey, goals as renderGoals, dayTasks as renderDayTasks, cards as renderCards, calendarCell, node as safeNode, button as safeButton } from './safe-dom.js';
import { STATE_KEY, LOCK_NAME, readRevision, fingerprint, writeDraft, listDrafts, commitLocal } from './local-state.js';
import { RECOVERY_KEY, EXTRA_KEY, validateBackup, validateRawSnapshot, buildBackup, snapshotStorage,
  recoveryBlocked, prepareRestore, commitRestore, readLocalJSON, transactionDone } from './backup.js';
import { app, auth, db } from "./sync/firebase.mjs";
import {

  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* =========================
   FIREBASE
========================= */


/* =========================
   ESTADO GLOBAL
========================= */
let currentUser = null;
window.currentUser = null;

let dbBackup = null;
let sessao = null;
let dadosLocais = null;
const rascunhosEmMemoria = new Map();
const PENDING_KEY = 'fluxoEnvioPendente';
const ativa = contexto => !!contexto && contexto === sessao && currentUser?.uid === contexto.uid &&
  (auth.currentUser === undefined || auth.currentUser?.uid === contexto.uid);
function exigirSessao(contexto) {
  if (!ativa(contexto)) throw new Error('A sessão mudou.');
}
function agendarSessao(contexto, callback, ms) {
  if (!ativa(contexto)) return;
  const id = setTimeout(() => {
    contexto.timers.delete(id);
    if (ativa(contexto)) callback();
  }, ms);
  contexto.timers.add(id);
  return id;
}

let armazenamentoInvalido = false;
let restauracaoEmCurso = false;
let operacoesRemotas = 0;
const CONFLICT_KEY = 'fluxoLocalConflictV2';
let conflitoLocal = false;
let versaoLocal = 0;
let baseLocal = "";
let filaLocal = Promise.resolve();
let gravacoesLocais = 0;
function indicarConflito(draft, motivo) {
  conflitoLocal = true;
  try { dadosLocais.setItem(CONFLICT_KEY, JSON.stringify({ draftId: draft?.id, motivo, data: new Date().toISOString() })); } catch { /* draft still retained */ }
  mostrarIndicadorSync('⚠️ Conflito local: versões preservadas. Exporte as versões pelo menu Backup.', 'error');
  atualizarStatusConexao();
}
function preservarRascunhoEmMemoria(contexto, values, error) {
  armazenamentoInvalido = true;
  const rascunhos = rascunhosEmMemoria.get(contexto.uid) || [];
  rascunhos.push({ uid: contexto.uid, values, createdAt: new Date().toISOString() });
  rascunhosEmMemoria.set(contexto.uid, rascunhos);
  alert('Armazenamento indisponível: ' + error.message + '. Mantenha esta aba aberta e use Exportar versões locais.');
}
function persistirLocal(values, pendente = true) {
  const contexto = sessao;
  if (!ativa(contexto)) return Promise.resolve(false);
  let draft;
  try { draft = writeDraft(dadosLocais, { values, before: snapshotStorage(dadosLocais), baseRevision: versaoLocal, baseFingerprint: baseLocal, uid: currentUser?.uid || null }); }
  catch (error) {
    preservarRascunhoEmMemoria(contexto, values, error);
    return Promise.resolve(false);
  }
  if (pendente) {
    try { dadosLocais.setItem(PENDING_KEY, draft.id); }
    catch (error) { indicarConflito(draft, error.message); return Promise.resolve(false); }
  }
  gravacoesLocais++;
  const operation = filaLocal.then(async () => {
    if (!ativa(contexto)) return false;
    if (!navigator.locks || conflitoLocal || armazenamentoInvalido || restauracaoEmCurso || dadosLocais.getItem(RECOVERY_KEY) !== recoveryObservado) {
      indicarConflito(draft, 'Edição preservada sem substituir o estado atual.'); return false;
    }
    return navigator.locks.request(contexto.lock, () => {
      if (!ativa(contexto)) return false;
      if (conflitoLocal || restauracaoEmCurso || dadosLocais.getItem(RECOVERY_KEY) !== recoveryObservado) { indicarConflito(draft,'Estado de recuperação alterado.'); return false; }
      const result = commitLocal(dadosLocais, draft, versaoLocal, baseLocal);
      if (result.conflict) { indicarConflito(draft,'Outra aba ou versão alterou os dados.'); return false; }
      versaoLocal = result.revision; baseLocal = result.fingerprint; return true;
    });
  }).catch(error => { if (ativa(contexto)) indicarConflito(draft,error.message); return false; }).finally(() => { if (ativa(contexto)) gravacoesLocais--; });
  filaLocal = operation.then(() => {});
  return operation;
}
window.exportarConflitosJSON = function() {
  if (!ativa(sessao)) return;
  const payload = {
    tipo: 'fluxo-versoes-locais',
    fluxoOwnerUid: sessao.uid,
    atual: snapshotStorage(dadosLocais),
    versao: dadosLocais.getItem(STATE_KEY),
    recuperacao: dadosLocais.getItem(RECOVERY_KEY),
    conflito: dadosLocais.getItem(CONFLICT_KEY),
    rascunhos: [...listDrafts(dadosLocais), ...(rascunhosEmMemoria.get(sessao.uid) || [])]
  };
  const a=document.createElement('a');const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));a.href=url;a.download='fluxo-versoes-'+getDataHoje()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};

let recoveryObservado = null;
function lerJSONLocal(key, fallback) {
  return readLocalJSON(dadosLocais, key, fallback, (campo, erro) => {
    armazenamentoInvalido = true;
    console.error('Dado local preservado, mas inválido:', campo, erro);
  });
}
function protecaoDadosAtiva() {
  return !ativa(sessao) || armazenamentoInvalido || conflitoLocal || dadosLocais.getItem(CONFLICT_KEY) !== null || gravacoesLocais > 0 || restauracaoEmCurso || recoveryBlocked(dadosLocais) || !navigator.locks;
}
function avisarProtecaoDados() {
  mostrarIndicadorSync('⚠️ Dados protegidos: sincronização Firebase pausada. Faça backup e confira a restauração local.', 'info');
}

let tarefas = [], metas = [], cardsTarefas = [];
let tempoTotalFocado = 0, tempoFocadoHoje = 0, tarefasReagendadasHoje = 0;
let ultimaDataFoco = "", ultimaDataReset = "", ultimaDataReagendamento = "";

let tarefaReagendando = null;
let tarefaArrastandoId = null;
let tarefaArrastandoOrigem = null;
let tarefaDescricaoAtual = null;
let tarefaEditandoAtual = null;

let dataCalendario = new Date();
let modoCalendario = localStorage.getItem("modoCalendario") || "mes";

let dataModalDiaAtual = null;

/* =========================
   MODO FOCO / POMODORO
========================= */
let tarefaFocoAtual = null;
let timerPomodoro = null;
let segundosRestantes = 25 * 60;
let emPausa = false;
let musicaAtiva = false;
let musicaPendente = false, musicaRequest = 0;

/* =========================
   UTILS
========================= */
function getDataHoje() {
  if (perRecord) return civilToday(displayTimeZone(integratedProfile.timeZone).zone);
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
}

function getProximoDiaUtil(dataStr) {
  const data = new Date(dataStr + "T00:00:00");
  data.setDate(data.getDate() + 1);
  while (data.getDay() === 0 || data.getDay() === 6) data.setDate(data.getDate() + 1);
  return data.toISOString().split("T")[0];
}

function getProximaData(recorrencia, dataAtualStr) {
  const data = new Date(dataAtualStr + "T00:00:00");
  switch (recorrencia) {
    case "diaria": data.setDate(data.getDate() + 1); break;
    case "dias_uteis": return getProximoDiaUtil(dataAtualStr);
    case "semanal": data.setDate(data.getDate() + 7); break;
    case "mensal": data.setMonth(data.getMonth() + 1); break;
    default: return null;
  }
  return data.toISOString().split("T")[0];
}

function capitalizarPrimeira(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatarDataHeader(d = new Date()) {
  const dataStr = d.toLocaleDateString("pt-BR", {
    ...(perRecord ? {timeZone:displayTimeZone(integratedProfile.timeZone).zone}:{}),
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  return capitalizarPrimeira(dataStr);
}

function formatarDataPtBr(dataStr) {
  if (!dataStr) return "";
  const [y, m, dia] = dataStr.split("-").map(Number);
  const dt = new Date(y, m - 1, dia);
  const dataFormatada = dt.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  return capitalizarPrimeira(dataFormatada);
}

function uid() {
  return Date.now() + Math.random();
}

/* =========================
   RECORRÊNCIA ROBUSTA
========================= */
function makeSerieId() {
  return "serie_" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
}

function normalizarTarefaRecorrente(t) {
  if (t && t.recorrencia && t.recorrencia !== "" && !t.serieId) {
    t.serieId = makeSerieId();
  }
  return t;
}

function garantirSerieIds() {
  let alterou = false;
  tarefas.forEach((t) => {
    if (t.recorrencia && t.recorrencia !== "" && !t.serieId) {
      t.serieId = makeSerieId();
      alterou = true;
    }
  });
  return alterou;
}

function existePendenteDaSerie(serieId, ignoreId = null) {
  return tarefas.some((x) => x.serieId === serieId && !x.concluida && x.id !== ignoreId);
}

function existeInstanciaDaSerieNaData(serieId, dataStr, ignoreId = null) {
  return tarefas.some((x) => x.serieId === serieId && x.data === dataStr && x.id !== ignoreId);
}

// Historical duplicates are preserved. Existing checks still avoid creating new
// occurrences when a pending occurrence already exists. Reconciliation is manual.
function deduplicarPendentesPorSerieData() { return false; }
function deduplicarPendenciaUnicaPorSerie() { return false; }

/* ===== FUNÇÃO CORRIGIDA: RECORRÊNCIA "INTELIGENTE" + DIÁRIA SEMPRE HOJE ===== */
function calcularBaseEfetivaConclusao(tarefa) {
  const hoje = getDataHoje();
  const dataOriginal = tarefa.data;
  
  // Se não está atrasada, mantém a data original
  if (dataOriginal >= hoje) {
    return dataOriginal;
  }

  // Para recorrência diária ou dias úteis, sempre usar a data de conclusão (hoje)
  if (tarefa.recorrencia === 'diaria' || tarefa.recorrencia === 'dias_uteis') {
    return hoje;
  }

  // Para semanal e mensal, lógica inteligente
  let intervalo = 0;
  switch (tarefa.recorrencia) {
    case 'semanal': intervalo = 7; break;
    case 'mensal': intervalo = 30; break;
    default: intervalo = 7;
  }

  const atraso = Math.floor((new Date(hoje) - new Date(dataOriginal)) / (1000 * 60 * 60 * 24));
  return atraso > intervalo ? hoje : dataOriginal;
}

function gerarProximaInstanciaSeNecessario(tarefaConcluida) {
  if (!tarefaConcluida) return;
  if (!tarefaConcluida.recorrencia || tarefaConcluida.recorrencia === "") return;
  normalizarTarefaRecorrente(tarefaConcluida);
  const serieId = tarefaConcluida.serieId;
  if (!serieId) return;
  if (existePendenteDaSerie(serieId, tarefaConcluida.id)) return;
  const base = calcularBaseEfetivaConclusao(tarefaConcluida);
  const proximaData = getProximaData(tarefaConcluida.recorrencia, base);
  if (!proximaData) return;
  if (existeInstanciaDaSerieNaData(serieId, proximaData, tarefaConcluida.id)) return;
  tarefas.push({
    id: uid(),
    texto: tarefaConcluida.texto,
    descricao: tarefaConcluida.descricao || "",
    bloco: tarefaConcluida.bloco,
    data: proximaData,
    prioridade: tarefaConcluida.prioridade || "p3",
    recorrencia: tarefaConcluida.recorrencia,
    serieId: serieId,
    concluida: false,
    concluidaEm: null,
    tempoGasto: 0,
    notificado: false,
    ordem: tarefas.filter((t) => t.bloco === tarefaConcluida.bloco && !t.concluida).length,
    origemRecorrente: "conclusao",
    criadoEm: new Date().toISOString()
  });
}

function concluirTarefaComRecorrencia(id) {
  if (perRecord) {
    void recordAdapter.complete(id).catch(error => mostrarIndicadorSync(error.message, 'error'));
    return;
  }
  const tarefa = tarefas.find((t) => t.id === id);
  if (!tarefa || tarefa.concluida) return;
  tarefa.concluida = true;
  tarefa.concluidaEm = new Date().toISOString();
  gerarProximaInstanciaSeNecessario(tarefa);
}

/* =========================
   FEEDBACK UI
========================= */
let timerIndicador;
window.mostrarIndicadorSync = function (mensagem, tipo = "success") {
  if(perRecord&&tipo==='success'&&/(tarefa|meta).*(adicionad|editad|excluíd|concluíd|reativad)/i.test(mensagem)&&!/confirmad/i.test(mensagem)) {
    mensagem='Alteração solicitada nesta aba; aguardando preservação local e confirmação.';tipo='info';
  }
  let indicator = document.getElementById("syncIndicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "syncIndicator";
    indicator.className = "sync-indicator";
    document.body.appendChild(indicator);
  }
  const icon = tipo === "success" ? "✅" : tipo === "error" ? "❌" : "🔄";
  indicator.textContent = `${icon} ${mensagem}`;
  indicator.classList.add("show");
  clearTimeout(timerIndicador);
  const critical = tipo === 'error' && /rascunho|memória|disco|preserv|recupera|conflito/i.test(mensagem);
  if (critical && currentUser) {
    document.getElementById('recoveryAlertText').textContent = mensagem;
    document.getElementById('recoveryAlert').hidden = false;
  }
  indicator.setAttribute('role',critical ? 'alert' : 'status');
  if (!critical) timerIndicador = setTimeout(() => indicator.classList.remove("show"), 2200);
};

/* =========================
   LOGIN
========================= */
window.togglePasswordVisibility = (id, btn) => {
  const inp = document.getElementById(id);
  if (!inp) return;
  if (inp.type === "password") {
    inp.type = "text";
    btn.innerHTML = '<i class="far fa-eye-slash"></i>';
  } else {
    inp.type = "password";
    btn.innerHTML = '<i class="far fa-eye"></i>';
  }
};

window.mostrarCadastro = () => {
  const l = document.getElementById("loginForm");
  const r = document.getElementById("registerForm");
  if (l) l.style.display = "none";
  if (r) r.style.display = "block";
};

window.baixarRascunhoIntegrado = () => {
  if (!recordAdapter || !sessao) return;
  const drafts = recordAdapter.emergency();
  const latest = drafts.at(-1);
  if (!latest) { mostrarIndicadorSync('Nenhum rascunho em memória. As cópias persistentes ficam no painel de pendências.'); return; }
  const payload = { ...(latest.observedView ?? {}), ...(latest.desired ?? {}),
    ...(latest.profile ? { profile: latest.profile } : {}),
    fluxoOwnerUid: sessao.uid, fluxoDraftVersions: drafts };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'fluxo-rascunhos-preservados.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

window.mostrarLogin = () => {
  const l = document.getElementById("loginForm");
  const r = document.getElementById("registerForm");
  if (l) l.style.display = "block";
  if (r) r.style.display = "none";
};

window.fazerLogin = async () => {
  try {
    const email = document.getElementById("loginEmail")?.value?.trim();
    const senha = document.getElementById("loginPassword")?.value;
    await signInWithEmailAndPassword(auth, email, senha);
  } catch (error) {
    const err = document.getElementById("loginErrorMessage");
    if (err && !auth.currentUser) err.textContent = authMessage(error);
  }
};

window.fazerCadastro = async () => {
  const email = document.getElementById("registerEmail")?.value?.trim();
  const pwd = document.getElementById("registerPassword")?.value;
  const conf = document.getElementById("registerConfirm")?.value;
  const err = document.getElementById("registerErrorMessage");
  if (pwd !== conf) {
    if (err) err.textContent = "Senhas não coincidem";
    return;
  }
  try {
    await createUserWithEmailAndPassword(auth, email, pwd);
    mostrarIndicadorSync("✅ Conta criada!");
  } catch (e) {
    if (err) err.textContent = e.message || "Erro ao cadastrar";
  }
};

window.loginComGoogle = async () => {
  if (window.loginComGoogle.pending) return;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  window.loginComGoogle.pending = true;
  try { await signInWithPopup(auth, provider); }
  catch(error) { if (!auth.currentUser) document.getElementById('loginErrorMessage').textContent = authMessage(error); }
  finally { window.loginComGoogle.pending = false; }
};

window.fazerLogout = async () => {
  const uidAnterior = currentUser?.uid;
  trocarSessao(null);
  try { await signOut(auth); }
  catch {
    if (!sessao && auth.currentUser?.uid === uidAnterior) {
      location.reload();
      if (currentUser?.uid === uidAnterior) mostrarIndicadorSync('Não foi possível sair da conta.', 'error');
    }
  }
};

/* =========================
   FIRESTORE SYNC (DADOS + PERFIL) – com tratamento de erro
========================= */
async function salvarTudoFirebase(contexto = sessao) {
  if (perRecord) {
    if (recordAdapter && ativa(contexto)) await recordAdapter.session.flush();
    return;
  }
  if (!ativa(contexto) || !contexto.remotoPronto || operacoesRemotas || protecaoDadosAtiva()) return;
  const pendente = dadosLocais.getItem(PENDING_KEY);
  if (!pendente) return;
  operacoesRemotas++;
  try {
    if (JSON.parse(dadosLocais.getItem(STATE_KEY))?.draftId !== pendente) return;
    const dados = {
      tarefas: lerJSONLocal("tarefas", []),
      metas: lerJSONLocal("metas", []),
      cardsTarefas: lerJSONLocal("cardsTarefas", []),
      tempoTotalFocado: parseInt(dadosLocais.getItem("tempoTotalFocado") || "0", 10),
      tempoFocadoHoje: parseInt(dadosLocais.getItem("tempoFocadoHoje") || "0", 10),
      tarefasReagendadasHoje: parseInt(dadosLocais.getItem("tarefasReagendadasHoje") || "0", 10),
      profile: lerJSONLocal("profile", {}),
      ultimaAtualizacao: new Date().toISOString()
    };
    if (protecaoDadosAtiva()) return;
    await setDoc(doc(db, "usuarios", contexto.uid), dados, { merge: true });
    if (!ativa(contexto)) return;
    if (dadosLocais.getItem(PENDING_KEY) === pendente) dadosLocais.removeItem(PENDING_KEY);
    else agendarSessao(contexto, () => salvarTudoFirebase(contexto), 400);
    atualizarStatusConexao();
  } catch (err) {
    if (!ativa(contexto)) return;
    console.error('Erro ao salvar no Firebase:', err);
    if (err.code === 'permission-denied') {
      mostrarIndicadorSync('⚠️ Permissão negada. Verifique as regras do Firestore.', 'error');
    } else {
      mostrarIndicadorSync('⚠️ Erro ao sincronizar com o servidor.', 'error');
    }
  } finally { if (ativa(contexto)) operacoesRemotas--; }
}

async function carregarDadosFirebase(contexto = sessao) {
  if (perRecord) return;
  if (!ativa(contexto) || protecaoDadosAtiva() || dadosLocais.getItem(PENDING_KEY) !== null) return;
  const revisionAtRead = versaoLocal;
  const fingerprintAtRead = baseLocal;
  operacoesRemotas++;
  try {
    const docRef = doc(db, "usuarios", contexto.uid);
    const docSnap = await getDoc(docRef);
    if (!ativa(contexto) || protecaoDadosAtiva() || docSnap.metadata?.fromCache) return;
    if (docSnap.exists()) {
      const d = docSnap.data();
      const validated = validateBackup({ ...d, tarefas: d.tarefas || [] });
      const values = {};
      for (const [key,value] of Object.entries(validated.values)) values[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (versaoLocal !== revisionAtRead || fingerprint(dadosLocais) !== fingerprintAtRead) {
        const draft=writeDraft(dadosLocais,{values,uid:currentUser?.uid,tipo:'leitura-remota-concorrente',baseRevision:revisionAtRead});
        indicarConflito(draft,'Os dados locais mudaram durante o carregamento.');
        return;
      }
      if (!await persistirLocal(values, false) || !ativa(contexto)) return;
      recarregarEstadoLocal();
    }
    contexto.remotoPronto = true;
    if (dadosLocais.getItem(PENDING_KEY)) agendarSessao(contexto, () => salvarTudoFirebase(contexto), 400);
  } catch (err) {
    if (!ativa(contexto)) return;
    console.error('Erro ao carregar dados do Firebase:', err);
    if (err.code === 'permission-denied') {
      mostrarIndicadorSync('⚠️ Permissão negada. Verifique as regras do Firestore.', 'error');
    }
    mostrarIndicadorSync('Dados locais preservados. Não foi possível verificar a cópia no Firebase.', 'error');
  } finally { if (ativa(contexto)) operacoesRemotas--; }
}

/* =========================
   PERFIL - CARREGAR, SALVAR, APLICAR
========================= */
function aplicarPerfil(profile) {
  if (!profile) return;
  // Avatar grande (esquerda) - removido, mantido apenas por compatibilidade
  const avatarEl = document.getElementById("userAvatar");
  if (avatarEl) {
    if (profile.avatar) {
      renderAvatar(avatarEl, profile.avatar);
    } else {
      avatarEl.innerHTML = `<i class="fas fa-user-circle"></i>`;
    }
  }
  // Avatar pequeno (direita)
  const avatarSmall = document.getElementById("userAvatarSmall");
  if (avatarSmall) {
    if (profile.avatar) {
      renderAvatar(avatarSmall, profile.avatar);
    } else {
      avatarSmall.innerHTML = `<i class="fas fa-user-circle"></i>`;
    }
  }
  // Nome do usuário
  const nameDisplay = document.getElementById("userNameDisplay");
  if (nameDisplay) {
    nameDisplay.textContent = profile.nome || "Usuário";
  }
  // Preview no modal
  const preview = document.getElementById("avatarPreview");
  if (preview) {
    if (profile.avatar) {
      renderAvatar(preview, profile.avatar);
    } else {
      preview.innerHTML = `<i class="fas fa-user-circle" style="font-size:64px;color:white;"></i>`;
    }
  }
}

function limparAvatarTemporario() {
  avatarReadVersion++;
  if (avatarReader?.readyState === FileReader.LOADING) avatarReader.abort();
  avatarReader = null;
  window._avatarTemp = null;
  const save = document.querySelector('#modalPerfilOverlay .btn-primary');
  if (save) save.disabled = false;
}

window.abrirModalPerfil = function() {
  limparAvatarTemporario();
  const modal = document.getElementById("modalPerfilOverlay");
  if (!modal) return;
  const profile = perRecord ? integratedProfile : lerJSONLocal("profile", {});
  const nomeInput = document.getElementById("perfilNome");
  const emailInput = document.getElementById("perfilEmail");
  if (nomeInput) nomeInput.value = profile.nome || "";
  if (emailInput && currentUser) emailInput.value = currentUser.email;
  const preview = document.getElementById("avatarPreview");
  if (preview) {
    if (profile.avatar) {
      renderAvatar(preview, profile.avatar);
    } else {
      preview.innerHTML = `<i class="fas fa-user-circle" style="font-size:64px;color:white;"></i>`;
    }
  }
  modal.classList.add("show");
  abrirTabPerfil('dados');
};

window.fecharModalPerfil = function() {
  limparAvatarTemporario();
  document.getElementById("modalPerfilOverlay")?.classList.remove("show");
  atualizarProjecaoIntegrada();
};

window.uploadAvatar = function(event) {
  const contexto = sessao;
  if (!ativa(contexto)) return;
  const file = event.target.files[0];
  if (!file) return;
  limparAvatarTemporario();
  if (!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type) || file.size > 149000) {
    mostrarIndicadorSync('Escolha uma imagem PNG, JPEG, GIF ou WebP de até 149 KB.', 'error');
    renderAvatar(document.getElementById('avatarPreview'), (perRecord ? integratedProfile : lerJSONLocal('profile', {})).avatar);
    return;
  }
  const reader = new FileReader();
  avatarReader = reader;
  const version = avatarReadVersion;
  const save = document.querySelector('#modalPerfilOverlay .btn-primary');
  if (save) save.disabled = true;
  reader.onload = function(e) {
    if (!ativa(contexto) || version !== avatarReadVersion) return;
    const dataUrl = e.target.result;
    const preview = document.getElementById("avatarPreview");
    if (preview) {
      renderAvatar(preview, dataUrl);
    }
    window._avatarTemp = dataUrl;
    avatarReader = null;
    if (save) save.disabled = false;
  };
  reader.onerror = () => {
    if (!ativa(contexto) || version !== avatarReadVersion) return;
    limparAvatarTemporario();
    mostrarIndicadorSync('Não foi possível ler a imagem. O perfil anterior foi preservado.', 'error');
  };
  reader.readAsDataURL(file);
};

window.salvarPerfil = async function() {
  const contexto = sessao;
  if (!ativa(contexto)) return;
  const nome = document.getElementById("perfilNome")?.value?.trim() || "";
  const profile = perRecord ? { nome } : { ...lerJSONLocal('profile', {}), nome };
  if (window._avatarTemp) profile.avatar = window._avatarTemp;
  if (perRecord) {
    try { await recordAdapter.profile(profile); if (!ativa(contexto)) return; fecharModalPerfil(); await recordAdapter.refresh(); } catch (error) { if (ativa(contexto)) mostrarIndicadorSync(error.message, 'error'); }
    return;
  }
  if (!await persistirLocal({ profile: JSON.stringify(profile) }) || !ativa(contexto)) return;
  aplicarPerfil(profile);
  window._avatarTemp = null;
  fecharModalPerfil();
  await salvarTudoFirebase(contexto);
};

/* =========================
   ABAS DO PERFIL
========================= */
window.abrirTabPerfil = function(tab) {
  document.querySelectorAll('.perfil-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.getElementById('tabDados').style.display = tab === 'dados' ? 'block' : 'none';
  document.getElementById('tabRelatorios').style.display = tab === 'relatorios' ? 'block' : 'none';
  if (tab === 'relatorios') {
    gerarRelatorios();
  }
};

function gerarRelatorios() {
  const container = document.getElementById('relatoriosContainer');
  if (!container) return;

  const hoje = getDataHoje();
  const trintaDiasAtras = new Date();
  trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
  let dataLimite = trintaDiasAtras.toISOString().split('T')[0];
  if (perRecord) {
    const civil = new Date(getDataHoje() + 'T12:00:00Z');
    civil.setUTCDate(civil.getUTCDate() - 30);
    dataLimite = civil.toISOString().slice(0, 10);
  }

  const tarefasConcluidas = tarefas.filter(t => t.concluida);
  const tarefasHoje = tarefas.filter(t => t.data === hoje && !t.concluida);
  const tarefasAtrasadas = tarefas.filter(t => t.data && t.data < hoje && !t.concluida);
  const concluidasUltimos30Dias = tarefasConcluidas.filter(t => typeof t.concluidaEm === 'string' && t.concluidaEm.split('T')[0] >= dataLimite);
  const totalTarefas = tarefas.length;
  const totalConcluidas = tarefasConcluidas.length;
  const taxaConclusao = totalTarefas > 0 ? Math.round((totalConcluidas / totalTarefas) * 100) : 0;
  const horasFoco = Math.floor(tempoTotalFocado / 60);
  const minutosFoco = tempoTotalFocado % 60;
  const p1 = tarefasConcluidas.filter(t => t.prioridade === 'p1').length;
  const p2 = tarefasConcluidas.filter(t => t.prioridade === 'p2').length;
  const p3 = tarefasConcluidas.filter(t => t.prioridade === 'p3').length;
  const recorrentes = tarefasConcluidas.filter(t => t.recorrencia && t.recorrencia !== '').length;
  const avulsas = totalConcluidas - recorrentes;

  const cardsMap = Object.create(null);
  tarefasConcluidas.forEach(t => {
    if (t.bloco) {
      const key = perRecord ? (t._displaySpaceId ?? t._spaceId ?? t.bloco) : t.bloco;
      const summary = cardsMap[key] ?? { nome: t.bloco, quantidade: 0 };
      summary.quantidade++;
      cardsMap[key] = summary;
    }
  });
  const topCards = Object.values(cardsMap).sort((a, b) => b.quantidade - a.quantidade)
    .slice(0, 3).map(({ nome, quantidade }) => [nome, quantidade]);

  let html = `
    <div style="margin-bottom:16px;">
      <h4 style="color:#a855f7;margin-bottom:8px;">📊 Resumo Geral</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="relatorio-card">
          <div class="relatorio-label">Total de tarefas</div>
          <div class="relatorio-valor">${totalTarefas}</div>
        </div>
        <div class="relatorio-card">
          <div class="relatorio-label">Concluídas</div>
          <div class="relatorio-valor" style="color:#22c55e;">${totalConcluidas}</div>
        </div>
        <div class="relatorio-card">
          <div class="relatorio-label">Taxa de conclusão</div>
          <div class="relatorio-valor" style="color:#fbbf24;">${taxaConclusao}%</div>
        </div>
        <div class="relatorio-card">
          <div class="relatorio-label">Tempo focado</div>
          <div class="relatorio-valor" style="color:#667eea;">${horasFoco}h ${minutosFoco}m</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:16px;">
      <h4 style="color:#a855f7;margin-bottom:8px;">📈 Últimos 30 dias</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div class="relatorio-card">
          <div class="relatorio-label">Concluídas</div>
          <div class="relatorio-valor" style="color:#22c55e;">${concluidasUltimos30Dias.length}</div>
        </div>
        <div class="relatorio-card">
          <div class="relatorio-label">Pendentes hoje</div>
          <div class="relatorio-valor" style="color:#fbbf24;">${tarefasHoje.length}</div>
        </div>
        <div class="relatorio-card">
          <div class="relatorio-label">Atrasadas</div>
          <div class="relatorio-valor" style="color:#ef4444;">${tarefasAtrasadas.length}</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:16px;">
      <h4 style="color:#a855f7;margin-bottom:8px;">🏷️ Por prioridade</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div class="relatorio-card prioridade-alta">
          <div class="relatorio-label">🔴 Alta</div>
          <div class="relatorio-valor">${p1}</div>
        </div>
        <div class="relatorio-card prioridade-media">
          <div class="relatorio-label">🟡 Média</div>
          <div class="relatorio-valor">${p2}</div>
        </div>
        <div class="relatorio-card prioridade-baixa">
          <div class="relatorio-label">🟢 Baixa</div>
          <div class="relatorio-valor">${p3}</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:16px;">
      <h4 style="color:#a855f7;margin-bottom:8px;">🔄 Recorrência</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="relatorio-card">
          <div class="relatorio-label">Recorrentes</div>
          <div class="relatorio-valor">${recorrentes}</div>
        </div>
        <div class="relatorio-card">
          <div class="relatorio-label">Avulsas</div>
          <div class="relatorio-valor">${avulsas}</div>
        </div>
      </div>
    </div>

    <div>
      <h4 style="color:#a855f7;margin-bottom:8px;">📁 Top espaços</h4>
      <div class="relatorio-espacos"></div>
    </div>
  `;
  container.innerHTML = html; // estrutura fixa e contagens numéricas
  const espacos = container.querySelector('.relatorio-espacos');
  for (const [nome, qtd] of topCards) {
    const linha = safeNode('div');
    linha.style.cssText = 'display:flex;justify-content:space-between;padding:6px 10px;background:rgba(255,255,255,0.04);border-radius:6px;margin-bottom:4px;border:1px solid rgba(255,255,255,0.04)';
    const titulo = safeNode('span', '', nome);
    titulo.style.fontSize = '13px';
    const quantidade = safeNode('span', '', qtd);
    quantidade.style.cssText = 'font-weight:600;color:#a855f7';
    linha.append(titulo, quantidade);
    espacos.append(linha);
  }
  if (!topCards.length) {
    const vazio = safeNode('div', '', 'Nenhuma tarefa concluída ainda.');
    vazio.style.cssText = 'color:rgba(255,255,255,0.5);font-size:13px';
    espacos.append(vazio);
  }
  if (perRecord && tarefasConcluidas.some(t => t.serieId)) {
    const history = safeNode('details');
    history.append(safeNode('summary', '', 'Ocorrências concluídas · reabrir sem alterar as seguintes'));
    for (const task of tarefasConcluidas.filter(t => t.serieId)) {
      const row = safeNode('div');
      const reopen = safeButton('', 'Reabrir ' + task.texto, 'rotate-left', () => {
        fecharModalPerfil();
        window.toggleTarefa(task.id);
      });
      reopen.textContent = 'Reabrir';
      row.append(safeNode('span', '', task.texto + ' · ' + (task.data ?? 'Sem data') + ' '), reopen);
      history.append(row);
    }
    container.append(history);
  }
}

/* =========================
   TEMAS COM 3 ESTADOS
========================= */
function aplicarTemaSalvo() {
  const tema = localStorage.getItem("temaFluxo") || "purple";
  document.body.classList.remove("dark-theme", "light-theme", "purple-theme");
  if (tema === "dark") {
    document.body.classList.add("dark-theme");
  } else if (tema === "light") {
    document.body.classList.add("light-theme");
  } else {
    document.body.classList.add("purple-theme");
  }
  // Atualizar ícone do botão de tema
  const icon = document.querySelector("#themeToggle i");
  if (icon) {
    if (tema === "purple") icon.className = "fas fa-palette";
    else if (tema === "light") icon.className = "fas fa-sun";
    else if (tema === "dark") icon.className = "fas fa-moon";
  }
}

function toggleTema() {
  const current = localStorage.getItem("temaFluxo") || "purple";
  let novo = "";
  if (current === "purple") novo = "light";
  else if (current === "light") novo = "dark";
  else if (current === "dark") novo = "purple";
  localStorage.setItem("temaFluxo", novo);
  aplicarTemaSalvo();
}

/* =========================
   INDEXEDDB BACKUP
========================= */
function initIndexedDB() {
  return new Promise((resolve) => {
    let request;
    try { request = indexedDB.open("FLUXO_Backup_Contas_V1", 2); }
    catch (error) { console.error('Backup local indisponível:', error); resolve(); return; }
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
    request.onsuccess = (event) => {
      dbBackup = event.target.result;
      dbBackup.onversionchange = () => { dbBackup.close(); dbBackup = null; };
      resolve();
    };
    request.onupgradeneeded = (event) => {
      const dbi = event.target.result;
      if (!dbi.objectStoreNames.contains("backups")) {
        const store = dbi.createObjectStore("backups", { keyPath: "id", autoIncrement: true });
        store.createIndex("usuario", "usuario");
        store.createIndex("timestamp", "timestamp");
      }
    };
  });
}

function lerRegistroBackup(id) {
  return new Promise((resolve, reject) => {
    if (!dbBackup) { reject(new Error('Armazenamento de backup indisponível.')); return; }
    const tx = dbBackup.transaction(['backups'], 'readonly');
    const req = tx.objectStore('backups').get(id);
    req.onerror = () => reject(req.error || new Error('Falha ao ler backup.'));
    req.onsuccess = () => resolve(req.result);
  });
}

async function gravarRegistroBackup(backup) {
  if (!dbBackup) throw new Error('IndexedDB indisponível. Nenhum sucesso foi confirmado.');
  const tx = dbBackup.transaction(['backups'], 'readwrite');
  const completed = transactionDone(tx);
  const req = tx.objectStore('backups').add(backup);
  await completed;
  const saved = await lerRegistroBackup(req.result);
  if (!saved || Object.keys(backup).some(key => JSON.stringify(saved[key]) !== JSON.stringify(backup[key]))) {
    throw new Error('Não foi possível verificar o backup gravado.');
  }
  return saved;
}

async function salvarBackupIndexedDB(contexto = sessao) {
  if (!ativa(contexto)) throw new Error('Entre na conta antes de fazer backup.');
  if (!navigator.locks) throw new Error('Este navegador não oferece bloqueio seguro para capturar o backup.');
  await filaLocal;
  return navigator.locks.request(contexto.lock, async () => {
  exigirSessao(contexto);
  const payload = buildBackup(dadosLocais);
  const backup = await gravarRegistroBackup({ ...payload, usuario: contexto.uid,
    timestamp: Date.now(), data: new Date().toISOString(),
    recoveryJournal: dadosLocais.getItem(RECOVERY_KEY) });
  validateBackup(backup);
  return backup;
  });
}

async function listarBackups() {
  const contexto = sessao;
  if (!ativa(contexto) || !dbBackup) return [];
  return new Promise((resolve, reject) => {
    const tx = dbBackup.transaction(['backups'], 'readonly');
    const req = tx.objectStore('backups').index('usuario').getAll(IDBKeyRange.only(contexto.uid));
    req.onsuccess = () => resolve((req.result || []).reverse());
    req.onerror = () => reject(req.error || new Error('Falha ao listar backups.'));
  });
}

function recarregarEstadoLocal() {
  tarefas = lerJSONLocal('tarefas', []);
  metas = lerJSONLocal('metas', []);
  cardsTarefas = lerJSONLocal('cardsTarefas', []);
  if (!cardsTarefas.length && !recoveryBlocked(dadosLocais)) cardsTarefas = [{ id: 'default_' + Date.now(), nome: 'Minhas Tarefas' }];
  tempoTotalFocado = Number(dadosLocais.getItem('tempoTotalFocado') || 0);
  tempoFocadoHoje = Number(dadosLocais.getItem('tempoFocadoHoje') || 0);
  tarefasReagendadasHoje = Number(dadosLocais.getItem('tarefasReagendadasHoje') || 0);
  ultimaDataFoco = dadosLocais.getItem('ultimaDataFoco') || '';
  ultimaDataReset = dadosLocais.getItem('ultimaDataReset') || '';
  ultimaDataReagendamento = dadosLocais.getItem('ultimaDataReagendamento') || '';
  aplicarPerfil(lerJSONLocal('profile', {}));
  renderizarTarefas(); renderizarMetas(); renderizarMetasCarrossel();
  renderizarCalendario(); atualizarDashboard(); atualizarRodape();
}

async function restaurarDadosValidados(input) {
  // Validation precedes confirmation, preservation and any local write.
  const validated = input?.rawStorage ? validateRawSnapshot(input.rawStorage) : validateBackup(input);
  const contexto = sessao;
  exigirSessao(contexto);
  if (validated.source.fluxoOwnerUid !== undefined && validated.source.fluxoOwnerUid !== contexto.uid) {
    throw new Error('Este arquivo de backup foi exportado por outra conta.');
  }
  if (restauracaoEmCurso || operacoesRemotas > 0 || gravacoesLocais > 0) {
    throw new Error('Há uma operação em andamento. Restauração interrompida para evitar sobrescrita. Aguarde sua conclusão e confirme novamente.');
  }
  if (!navigator.locks) throw new Error("Este navegador não oferece o bloqueio seguro necessário para restaurar.");
  const uidRestaurando = contexto.uid;
  const versionAtConfirmation = readRevision(dadosLocais);
  const fingerprintAtConfirmation = fingerprint(dadosLocais);
  const existingGuard = dadosLocais.getItem(RECOVERY_KEY);
  if (existingGuard !== null) {
    let previous;
    try { previous = JSON.parse(existingGuard); } catch { throw new Error('Registro de recuperação inválido. Preserve o armazenamento antes de continuar.'); }
    if (previous.uid !== uidRestaurando) throw new Error('A recuperação pendente pertence a outra conta.');
  }
  if (!confirm('Restaurar ' + validated.values.tarefas.length + ' tarefas neste dispositivo? Uma cópia integral do estado anterior será preservada. A sincronização com Firebase ficará pausada; nenhum dado remoto será substituído.')) return false;
  restauracaoEmCurso = true;
  try {
    return await navigator.locks.request(contexto.lock, async () => {
    exigirSessao(contexto);
    if (readRevision(dadosLocais) !== versionAtConfirmation || fingerprint(dadosLocais) !== fingerprintAtConfirmation) {
      throw new Error('Outra aba alterou os dados depois da confirmação. Confira os dados e confirme novamente.');
    }
    // Preserve even malformed raw values; never require parsing the old data.
    await gravarRegistroBackup({ usuario: uidRestaurando, timestamp: Date.now(),
      data: new Date().toISOString(), tipo: 'antes-da-restauracao',
      rawStorage: snapshotStorage(dadosLocais), recoveryJournal: existingGuard,
      localState: dadosLocais.getItem(STATE_KEY), conflictState: dadosLocais.getItem(CONFLICT_KEY) });
    exigirSessao(contexto);
    const journal = prepareRestore(dadosLocais, input?.rawStorage ? input : validated.source, uidRestaurando);
    commitRestore(dadosLocais, journal);
    recoveryObservado = dadosLocais.getItem(RECOVERY_KEY);
    const revision = readRevision(dadosLocais) + 1;
    dadosLocais.setItem(STATE_KEY, JSON.stringify({revision,restoredAt:new Date().toISOString()}));
    versaoLocal=revision;baseLocal=fingerprint(dadosLocais);
    armazenamentoInvalido = false;
    recarregarEstadoLocal();
    atualizarStatusConexao();
    mostrarIndicadorSync('✅ Restauração local validada. Firebase pausado; cópia anterior preservada.', 'info');
    return true;
    });
  } finally { if (ativa(contexto)) restauracaoEmCurso = false; }
}

async function restaurarBackupIndexedDB(backupId) {
  if (perRecord) { location.href = new URL('sync-center.html#restore',location.href).href; return; }
  const contexto = sessao;
  try {
    exigirSessao(contexto);
    const backup = await lerRegistroBackup(backupId);
    exigirSessao(contexto);
    if (!backup || backup.usuario !== contexto.uid) throw new Error('Backup não encontrado para esta conta.');
    await restaurarDadosValidados(backup);
  } catch (error) { if (ativa(contexto)) alert(error.message); }
}

async function excluirBackupIndexedDB(backupId) {
  const contexto = sessao;
  try {
    exigirSessao(contexto);
    const backup = await lerRegistroBackup(backupId);
    exigirSessao(contexto);
    if (!backup || backup.usuario !== contexto.uid) throw new Error('Backup não encontrado para esta conta.');
    if (backup.tipo === 'antes-da-restauracao') throw new Error('Cópia de preservação protegida nesta etapa.');
    if (!confirm('Excluir este backup local?')) return;
    const tx = dbBackup.transaction(['backups'], 'readwrite');
    const completed = transactionDone(tx);
    tx.objectStore('backups').delete(backupId);
    await completed;
    if (!ativa(contexto)) return;
    if (await lerRegistroBackup(backupId)) throw new Error('Exclusão não confirmada.');
    if (ativa(contexto)) mostrarIndicadorSync('🗑 Backup removido');
  } catch (error) { if (ativa(contexto)) alert(error.message); }
}

window.fazerBackupManual = async () => {
  if (perRecord) {
    const context = sessao;
    try {
      const raw = await makeBackup({ uid: context.uid, generation: context.generation }, await recordAdapter.session.state());
      await keepDraft(context.uid, { type: 'backupPorRegistro', raw }, () => exigirSessao(context), context.generation);
      if (ativa(context)) mostrarIndicadorSync('Cópia por registro gravada e conferida no armazenamento local.');
    } catch (error) { if (ativa(context)) mostrarIndicadorSync(error.message, 'error'); }
    return;
  }
  const contexto = sessao;
  try {
    await salvarBackupIndexedDB(contexto);
    if (!ativa(contexto)) return;
    mostrarIndicadorSync('✅ Backup local gravado e validado');
  } catch (error) { if (ativa(contexto)) alert(error.message); }
};
window.restaurarBackupIndexedDB = restaurarBackupIndexedDB;
window.excluirBackupIndexedDB = excluirBackupIndexedDB;

window.importarBackupJSON = function() {
  if (perRecord) { location.href = new URL('sync-center.html#restore',location.href).href; return; }
  const contexto = sessao;
  if (!ativa(contexto)) return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const raw = await file.text();
      if (ativa(contexto)) await restaurarDadosValidados(raw);
    } catch (error) { if (ativa(contexto)) alert('Restauração não concluída: ' + error.message); }
  };
  input.click();
};

window.exportarBackupJSON = async function() {
  if (perRecord) {
    const context = sessao;
    try {
      const raw = await makeBackup({ uid: context.uid, generation: context.generation }, await recordAdapter.session.state());
      if (!ativa(context)) return;
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'fluxo-backup.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      mostrarIndicadorSync('Arquivo por registro validado. Confira o download.');
    } catch (error) { if (ativa(context)) mostrarIndicadorSync(error.message, 'error'); }
    return;
  }
  const contexto = sessao;
  try {
    exigirSessao(contexto);
    if (!navigator.locks) throw new Error('Este navegador não oferece bloqueio seguro para exportar.');
    await filaLocal;
    const payload = await navigator.locks.request(contexto.lock, () => {
      exigirSessao(contexto);
      return buildBackup(dadosLocais);
    });
    if (!ativa(contexto)) return;
    validateBackup(payload);
    const blob = new Blob([JSON.stringify({ ...payload, fluxoOwnerUid: contexto.uid }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fluxo-backup-' + getDataHoje() + '.json';
    a.click();
    const url = a.href;
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    mostrarIndicadorSync('Arquivo validado; download solicitado. Confira o arquivo baixado.', 'info');
  } catch (error) { if (ativa(contexto)) alert(error.message); }
};

function resumoBackup(backup) {
  if (backup.rawStorage) return 'Cópia integral anterior à restauração (protegida)';
  try { return validateBackup(backup).values.tarefas.length + ' tarefas'; }
  catch { return 'Backup inválido — restauração bloqueada'; }
}

window.abrirModalBackup = async function() {
  if (perRecord) { location.href = new URL('sync-center.html#restore',location.href).href; return; }
  const contexto = sessao;
  if (!ativa(contexto)) return;
  const modal = document.getElementById("modalBackupOverlay");
  const list = document.getElementById("backupList");
  if (!modal || !list) return;
  let backups;
  try { backups = await listarBackups(); }
  catch (error) { if (ativa(contexto)) alert(error.message); return; }
  if (!ativa(contexto)) return;
  if (!backups.length) {
    list.innerHTML = `<div style="color:rgba(255,255,255,.7);font-size:12px;">Nenhum backup encontrado.</div>`;
  } else {
    list.replaceChildren(...backups.map(b => {
      const item=safeNode('div','backup-item');const info=safeNode('div','backup-info');
      info.append(safeNode('div','backup-data',new Date(b.timestamp).toLocaleString('pt-BR')),safeNode('div','backup-tarefas',resumoBackup(b)));
      const actions=safeNode('div','backup-actions');
      actions.append(safeButton('','Restaurar','undo',()=>restaurarBackupIndexedDB(b.id)),safeButton('','Excluir','trash-alt',()=>excluirBackupIndexedDB(b.id)));
      item.append(info,actions);return item;
    }));
  }
  modal.classList.add("show");
};

window.fecharModalBackup = function() {
  document.getElementById("modalBackupOverlay")?.classList.remove("show");
};

/* =========================
   NOTIFICAÇÕES
========================= */
window.abrirModalNotificacoes = function() {
  const modal = document.getElementById("modalNotificacoesOverlay");
  const lista = document.getElementById("notificacoesLista");
  if (!modal || !lista) return;
  const hoje = getDataHoje();
  const atrasadas = tarefas.filter(t => t.data && t.data < hoje && !t.concluida);
  const hojePendentes = tarefas.filter(t => t.data === hoje && !t.concluida);
  lista.replaceChildren();
  function adicionarAviso(rows, titulo, estado, importante = false) {
    if (!rows.length) return;
    const aviso = safeNode('div', importante ? 'notificacao-item importante' : 'notificacao-item');
    aviso.append(safeNode('div', 'notif-titulo', titulo),
      safeNode('div', 'notif-desc', rows.map(tarefa => tarefa.texto).join(', ')),
      safeNode('div', 'notif-data', rows.length + ' tarefa(s) ' + estado));
    lista.append(aviso);
  }
  adicionarAviso(atrasadas, '⚠️ Tarefas atrasadas', 'aguardam', true);
  adicionarAviso(hojePendentes, '📌 Tarefas para hoje', 'pendentes');
  if (!atrasadas.length && !hojePendentes.length) {
    const vazio = safeNode('div', '', '🎉 Nenhuma notificação pendente!');
    vazio.style.cssText = 'text-align:center;color:rgba(255,255,255,0.7);padding:20px';
    lista.append(vazio);
  }
  modal.classList.add("show");
};

window.fecharModalNotificacoes = function() {
  document.getElementById("modalNotificacoesOverlay")?.classList.remove("show");
};

/* =========================
   LÓGICA PRINCIPAL
========================= */
async function verificarResetDiario() {
  const values = {};
  if (protecaoDadosAtiva()) return;
  const hoje = getDataHoje();
  if (ultimaDataReset !== hoje) {
    ultimaDataReset = hoje;
    values["ultimaDataReset"] = hoje;
    if (ultimaDataReagendamento !== hoje) {
      tarefasReagendadasHoje = 0;
      values["tarefasReagendadasHoje"] = "0";
      values["ultimaDataReagendamento"] = hoje;
      ultimaDataReagendamento = hoje;
    }
  }
  if (ultimaDataFoco !== hoje) {
    tempoFocadoHoje = 0;
    values["tempoFocadoHoje"] = "0";
    values["ultimaDataFoco"] = hoje;
    ultimaDataFoco = hoje;
  }
  if(Object.keys(values).length) await persistirLocal(values, false);
}

function sincronizarTarefasRecorrentes() {
  if (perRecord) return false;
  if (protecaoDadosAtiva()) return false;
  let alterou = false;
  if (garantirSerieIds()) alterou = true;
  if (deduplicarPendentesPorSerieData()) alterou = true;
  if (deduplicarPendenciaUnicaPorSerie()) alterou = true;
  return alterou;
}

async function salvarDados() {
  if (perRecord) {
    if (!recordAdapter) return false;
    try {
      await recordAdapter.save({ tarefas, metas, cardsTarefas });
      mostrarIndicadorSync('Alteração preservada localmente. Consulte o status de envio até a confirmação.','info');
      return true;
    } catch (error) {
      mostrarIndicadorSync(error.message, 'error');
      return false;
    }
  }
  const contexto = sessao;
  if (!ativa(contexto)) return false;
  const values = {
    tarefas: JSON.stringify(tarefas), metas: JSON.stringify(metas), cardsTarefas: JSON.stringify(cardsTarefas),
    tempoTotalFocado: String(tempoTotalFocado), tempoFocadoHoje: String(tempoFocadoHoje), tarefasReagendadasHoje: String(tarefasReagendadasHoje)
  };
  try { validateBackup(values); } catch (error) {
    armazenamentoInvalido=true;
    let draft;
    try { draft=writeDraft(dadosLocais,{values,uid:currentUser?.uid}); }
    catch (erroDeGravacao) { preservarRascunhoEmMemoria(contexto, values, erroDeGravacao); }
    indicarConflito(draft,error.message);return false;
  }
  const pending = persistirLocal(values);
  renderizarTarefas();renderizarMetas();renderizarMetasCarrossel();renderizarCalendario();atualizarDashboard();atualizarRodape();
  if(dataModalDiaAtual)renderizarConteudoModalDia(dataModalDiaAtual);
  const ok = await pending;
  if (ok && ativa(contexto)) {
    atualizarStatusConexao();
    agendarSessao(contexto, () => salvarTudoFirebase(contexto), 400);
  }
  return ok;
}

/* =========================
   TAREFAS
========================= */
window.toggleTarefa = function(id) {
  if (perRecord) {
    const task = tarefas.find(row => row.id === id);
    if (!task) return;
    if (!task.concluida) {
      void recordAdapter.complete(id).catch(error => mostrarIndicadorSync(error.message, 'error'));
      return;
    }
    if (task.serieId) {
      void recordAdapter.reopen(id).catch(error => mostrarIndicadorSync(error.message, 'error'));
      return;
    }
  }
  const t = tarefas.find((x) => x.id === id);
  if (!t) return;
  if (!t.concluida) {
    concluirTarefaComRecorrencia(id);
    mostrarIndicadorSync("✅ Tarefa concluída!");
  } else {
    t.concluida = false;
    t.concluidaEm = null;
    mostrarIndicadorSync("🔄 Tarefa reativada!");
  }
  salvarDados();
};

window.excluirTarefa = function(id) {
  const task=tarefas.find(t=>t.id===id);
  if(perRecord&&task?.serieId){
    const dialog=document.getElementById('recurrenceDeleteDialog');
    dialog.dataset.taskId=id;dialog.showModal();return;
  }
  if (!confirm("Excluir tarefa?")) return;
  tarefas = tarefas.filter((t) => t.id !== id);
  salvarDados();
  mostrarIndicadorSync("🗑 Tarefa excluída!");
};

let edicaoInicial = null, edicaoSalvando = false;
const lerEdicao = () => Object.fromEntries(['Titulo','Descricao','Data','Prioridade','Recorrencia','Espaco']
  .map(key => [key, document.getElementById('edicao'+key).value]));
window.abrirModalEdicao = function(id) {
  if (edicaoSalvando) return;
  const tarefa = tarefas.find((t) => t.id === id);
  if (!tarefa) return;
  tarefaEditandoAtual = tarefa;
  document.getElementById("edicaoTitulo").value = tarefa.texto || "";
  document.getElementById("edicaoDescricao").value = tarefa.descricao || "";
  document.getElementById("edicaoData").value = tarefa.data || '';
  document.getElementById("edicaoPrioridade").value = tarefa.prioridade || "p3";
  document.getElementById("edicaoRecorrencia").value = tarefa.recorrencia || "";
  const espaco = document.getElementById('edicaoEspaco');
  espaco.replaceChildren(...cardsTarefas.map(card => {
    const option = document.createElement('option');
    option.value = String(card.id); option.textContent = card.nome;
    return option;
  }));
  espaco.value = String(tarefa._displaySpaceId ?? tarefa._spaceId ?? cardsTarefas.find(c=>c.nome===tarefa.bloco)?.id ?? '');
  edicaoInicial = lerEdicao();
  document.getElementById('edicaoErro').hidden = true;
  document.getElementById("modalEdicaoOverlay").classList.add("show");
};

window.fecharModalEdicao = function() {
  if (edicaoSalvando) return;
  document.getElementById("modalEdicaoOverlay")?.classList.remove("show");
  tarefaEditandoAtual = null;
  edicaoInicial = null;
  atualizarProjecaoIntegrada();
};

window.salvarEdicaoTarefa = async function() {
  if (!tarefaEditandoAtual || edicaoSalvando) return;
  const values = lerEdicao(), errorBox = document.getElementById('edicaoErro');
  if (JSON.stringify(values) === JSON.stringify(edicaoInicial)) { fecharModalEdicao(); return true; }
  const space = cardsTarefas.find(c=>String(c.id)===values.Espaco);
  if (!values.Titulo.trim() || !space || !document.getElementById('edicaoData').validity.valid) {
    errorBox.textContent = !values.Titulo.trim() ? 'Informe um título para a tarefa.' : !space ? 'Escolha um espaço disponível.' : 'Informe uma data válida.';
    errorBox.hidden = false; return false;
  }
  const contexto = sessao, editing = tarefaEditandoAtual;
  const desired = structuredClone({ tarefas, metas, cardsTarefas });
  const task = desired.tarefas.find(t=>t.id===editing.id);
  Object.assign(task,{texto:values.Titulo.trim(),descricao:values.Descricao,data:values.Data,
    prioridade:values.Prioridade,recorrencia:values.Recorrencia,bloco:space.nome,
    ...(perRecord ? {_spaceId:space._virtual ? null : space.id,_displaySpaceId:space.id} : {})});
  normalizarTarefaRecorrente(task);
  edicaoSalvando = true; document.getElementById('edicaoSalvar').disabled = true;
  try {
    if (perRecord) {
      if (!recordAdapter) throw new Error('A sessão ainda não está pronta. Mantenha esta janela aberta.');
      await recordAdapter.save(desired);
    } else {
      const previous = tarefas; tarefas = desired.tarefas;
      if (!await salvarDados()) { tarefas = previous; throw new Error('Não foi possível preservar a edição. Tente novamente ou exporte os rascunhos.'); }
    }
    if (!ativa(contexto) || tarefaEditandoAtual !== editing) return false;
    edicaoSalvando = false; fecharModalEdicao();
    mostrarIndicadorSync('Edição preservada localmente. Acompanhe o envio até a confirmação.','info');
    return true;
  } catch (error) {
    if (ativa(contexto) && tarefaEditandoAtual === editing) {
      errorBox.textContent = 'A edição exige conferência. Preserve esta janela ou exporte os rascunhos. ' + error.message;
      errorBox.hidden = false;
      mostrarIndicadorSync(errorBox.textContent,'error');
    }
    return false;
  } finally { edicaoSalvando = false; document.getElementById('edicaoSalvar').disabled = false; }
};

window.abrirModalDescricao = function(id) {
  const tarefa = tarefas.find((t) => t.id === id);
  if (!tarefa) return;
  tarefaDescricaoAtual = tarefa;
  document.getElementById("modalDescricaoTitulo").textContent = tarefa.texto || "Sem título";
  document.getElementById("modalDescricaoTexto").textContent = tarefa.descricao || "Nenhuma descrição adicionada";
  document.getElementById("modalDescricaoOverlay")?.classList.add("show");
};

window.fecharModalDescricao = function() {
  document.getElementById("modalDescricaoOverlay")?.classList.remove("show");
  tarefaDescricaoAtual = null;
  atualizarProjecaoIntegrada();
};

window.editarDescricaoModal = function() {
  if (!tarefaDescricaoAtual) return;
  const nova = prompt("Editar descrição:", tarefaDescricaoAtual.descricao || "");
  if (nova !== null) {
    tarefaDescricaoAtual.descricao = nova;
    salvarDados();
    fecharModalDescricao();
    mostrarIndicadorSync("📝 Descrição atualizada!");
  }
};

window.abrirModalReagendar = function(id) {
  tarefaReagendando = tarefas.find((t) => t.id === id);
  if (!tarefaReagendando) return;
  document.getElementById("novaDataReagendar").value = tarefaReagendando.data || getDataHoje();
  document.getElementById("modalReagendarOverlay")?.classList.add("show");
};

window.fecharModalReagendar = function() {
  document.getElementById("modalReagendarOverlay")?.classList.remove("show");
  tarefaReagendando = null;
  atualizarProjecaoIntegrada();
};

window.confirmarReagendamento = function() {
  const novaData = document.getElementById("novaDataReagendar").value;
  if (!tarefaReagendando || !novaData) return;
  if (tarefaReagendando.recorrencia && tarefaReagendando.serieId) {
    const existe = tarefas.some(t =>
      t.serieId === tarefaReagendando.serieId &&
      t.data === novaData &&
      t.id !== tarefaReagendando.id &&
      !t.concluida
    );
    if (existe) {
      mostrarIndicadorSync("⚠️ Já existe uma tarefa pendente nesta data para esta recorrência.", "error");
      return;
    }
  }
  tarefaReagendando.data = novaData;
  tarefaReagendando.notificado = false;
  tarefasReagendadasHoje++;
  normalizarTarefaRecorrente(tarefaReagendando);
  salvarDados();
  fecharModalReagendar();
  mostrarIndicadorSync("📅 Tarefa reagendada!");
};

window.adicionarCardTarefa = function() {
  const nome = prompt("Nome do novo espaço:");
  if (!nome || !nome.trim()) return;
  cardsTarefas.push({ id: "card_" + Date.now(), nome: nome.trim() });
  salvarDados();
  mostrarIndicadorSync(`📁 Espaço "${nome.trim()}" criado!`);
};

window.editarCardTarefa = function(id) {
  const card = cardsTarefas.find((c) => c.id === id);
  if (!card) return;
  const novoNome = prompt("Editar nome:", card.nome);
  if (!novoNome || !novoNome.trim()) return;
  const antigo = card.nome;
  card.nome = novoNome.trim();
  tarefas.forEach((t) => {
    if (perRecord ? t._spaceId === id : t.bloco === antigo) t.bloco = card.nome;
  });
  salvarDados();
  mostrarIndicadorSync("✏️ Espaço renomeado!");
};

window.excluirCardTarefa = function(id) {
  if (!confirm("Excluir este espaço?")) return;
  const card = cardsTarefas.find((c) => c.id === id);
  if (!card) return;
  tarefas = tarefas.filter((t) => perRecord ? t._spaceId !== id : t.bloco !== card.nome);
  cardsTarefas = cardsTarefas.filter((c) => c.id !== id);
  if (cardsTarefas.length === 0 && !recoveryBlocked(dadosLocais)) cardsTarefas = [{ id: "default_" + Date.now(), nome: "Minhas Tarefas" }];
  salvarDados();
  mostrarIndicadorSync("🗑 Espaço excluído!");
};

function atualizarProjecaoIntegrada() {
  if (perRecord && recordAdapter) void recordAdapter.refresh().catch(error => mostrarIndicadorSync(error.message, 'error'));
}

window.mostrarFormAdicionar = function(cardId) {
  const form = document.getElementById(`form-${domCardKey(cardId)}`);
  if (!form) return;
  form.classList.toggle("show");
  if (form.classList.contains("show")) {
    const input = document.getElementById(`texto-${domCardKey(cardId)}`);
    if (input) agendarSessao(sessao, () => input.focus(), 100);
  } else atualizarProjecaoIntegrada();
};

window.adicionarTarefaInline = function(cardId) {
  const card = cardsTarefas.find((c) => c.id === cardId);
  if (!card) return;
  const texto = document.getElementById(`texto-${domCardKey(cardId)}`)?.value.trim();
  if (!texto) return;
  const descricao = document.getElementById(`descricao-${domCardKey(cardId)}`)?.value.trim() || "";
  const data = document.getElementById(`data-${domCardKey(cardId)}`)?.value || getDataHoje();
  const prioridade = document.getElementById(`prioridade-${domCardKey(cardId)}`)?.value || "p3";
  const recorrencia = document.getElementById(`recorrencia-${domCardKey(cardId)}`)?.value || "";
  const nova = {
    id: uid(),
    texto,
    descricao,
    bloco: card.nome,
    ...(perRecord ? { _spaceId: card.id } : {}),
    data,
    prioridade,
    recorrencia,
    concluida: false,
    tempoGasto: 0,
    notificado: false,
    ordem: tarefas.filter((t) => t.bloco === card.nome && !t.concluida).length
  };
  normalizarTarefaRecorrente(nova);
  tarefas.push(nova);
  const txt = document.getElementById(`texto-${domCardKey(cardId)}`);
  const desc = document.getElementById(`descricao-${domCardKey(cardId)}`);
  if (txt) txt.value = "";
  if (desc) desc.value = "";
  document.getElementById(`form-${domCardKey(cardId)}`)?.classList.remove("show");
  salvarDados();
  mostrarIndicadorSync("✅ Tarefa adicionada!");
};

window.marcarTodasHoje = function() {
  const hoje = getDataHoje();
  const alvos = tarefas.filter((t) => t.data === hoje && !t.concluida);
  if (alvos.length === 0) {
    alert("🎉 Nenhuma tarefa pendente para hoje!");
    return;
  }
  if (confirm(`Concluir ${alvos.length} tarefa(s) de hoje?`)) {
    alvos.forEach((t) => concluirTarefaComRecorrencia(t.id));
    salvarDados();
    mostrarIndicadorSync(`🎉 ${alvos.length} tarefa(s) concluída(s)!`);
  }
};

/* Drag and Drop */
window.iniciarDragTarefa = function(id, cardNome, event) {
  tarefaArrastandoId = id;
  tarefaArrastandoOrigem = cardNome;
  event.dataTransfer.setData("text/plain", String(id));
  const el = event.target.closest(".tarefa-item");
  if (el) el.classList.add("dragging");
};

window.permitirDropTarefa = (event) => event.preventDefault();
window.permitirDropCard = (event) => {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
};
window.removerDragOver = (event) => event.currentTarget.classList.remove("drag-over");

window.soltarTarefa = function(event, cardNomeDestino, tarefaIdDestino, spaceDestinationId) {
  if (perRecord) {
    event.preventDefault();
    const task = tarefas.find(row => row.id === tarefaArrastandoId);
    if (!task || !spaceDestinationId) return;
    task._spaceId = spaceDestinationId;
    task._displaySpaceId = spaceDestinationId;
    task.bloco = cardNomeDestino;
    const sequence = tarefas.filter(row => row._spaceId === spaceDestinationId && row.id !== task.id)
      .sort((a, b) => a.ordem - b.ordem);
    const target = sequence.findIndex(row => row.id === tarefaIdDestino);
    sequence.splice(target < 0 ? sequence.length : target, 0, task);
    sequence.forEach((row, index) => { row.ordem = index; });
    tarefaArrastandoId = tarefaArrastandoOrigem = null;
    void salvarDados();
    return;
  }
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  if (!tarefaArrastandoId) return;
  if (tarefaArrastandoOrigem === cardNomeDestino && tarefaIdDestino) {
    const tarefasDoCard = tarefas
      .filter((t) => t.bloco === cardNomeDestino && !t.concluida)
      .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    const indexOrigem = tarefasDoCard.findIndex((t) => t.id === tarefaArrastandoId);
    const indexDestino = tarefasDoCard.findIndex((t) => t.id === tarefaIdDestino);
    if (indexOrigem !== -1 && indexDestino !== -1) {
      const [item] = tarefasDoCard.splice(indexOrigem, 1);
      tarefasDoCard.splice(indexDestino, 0, item);
      tarefasDoCard.forEach((t, idx) => {
        const g = tarefas.find((gt) => gt.id === t.id);
        if (g) g.ordem = idx;
      });
      salvarDados();
    }
  } else if (tarefaArrastandoOrigem !== cardNomeDestino) {
    const tarefa = tarefas.find((t) => t.id === tarefaArrastandoId);
    if (tarefa) {
      tarefa.bloco = cardNomeDestino;
      salvarDados();
      mostrarIndicadorSync("📦 Tarefa movida");
    }
  }
  tarefaArrastandoId = null;
  tarefaArrastandoOrigem = null;
  document.querySelectorAll(".tarefa-item").forEach((el) => el.classList.remove("dragging"));
};

/* =========================
   MODO FOCO
========================= */
window.moverTarefaNoCard=function(id,direction){
  const task=tarefas.find(t=>t.id===id);if(!task)return;
  const rows=tarefas.filter(t=>t._displaySpaceId===task._displaySpaceId&&!t.concluida).sort((a,b)=>(a.ordem??0)-(b.ordem??0));
  const from=rows.findIndex(t=>t.id===id),to=from+direction;if(from<0||to<0||to>=rows.length)return;
  [rows[from],rows[to]]=[rows[to],rows[from]];rows.forEach((t,i)=>{t.ordem=i;});void salvarDados();
};
function mostrarNotificacaoBrowser(titulo, corpo) {
  if (!ativa(sessao)) return;
  try {
    if ("Notification" in window && Notification.permission === "granted") sessao.notifications.add(new Notification(titulo, { body: corpo, icon: "logo.png" }));
  } catch { mostrarIndicadorSync('Notificações indisponíveis neste navegador. Os avisos continuam no painel.', 'info'); }
}

window.abrirModoFoco = function(id) {
  const tarefa = tarefas.find((t) => t.id === id);
  if (!tarefa) return;
  if(timerPomodoro)window.fecharModoFoco();
  runningFocusClock=null;focusTick=null;
  tarefaFocoAtual = tarefa;
  segundosRestantes = 25 * 60;
  emPausa = false;
  const txt = document.getElementById("tarefaFocoTexto");
  if (txt) txt.textContent = tarefa.texto;
  const timer = document.getElementById("timerFocoGrande");
  if (timer) timer.textContent = "25:00";
  const bar = document.getElementById("progressoFocoBar");
  if (bar) bar.style.width = "0%";
  const btnIniciar = document.getElementById("btnIniciarFoco");
  const btnPausar = document.getElementById("btnPausarFoco");
  if (btnIniciar) btnIniciar.style.display = "inline-flex";
  if (btnPausar) btnPausar.style.display = "none";
  document.getElementById("modalFocoOverlay")?.classList.add("show");
  mostrarNotificacaoBrowser("🧘 Modo Foco iniciado", `Foco em: ${tarefa.texto}`);
};

window.fecharModoFoco = function() {
  if (timerPomodoro) clearInterval(timerPomodoro);
  timerPomodoro = null;
  runningFocusClock=null;focusTick=null;
  document.getElementById("modalFocoOverlay")?.classList.remove("show");
};

function atualizarTimerUI() {
  const m = Math.floor(segundosRestantes / 60);
  const s = segundosRestantes % 60;
  const timer = document.getElementById("timerFocoGrande");
  if (timer) timer.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const total = 25 * 60;
  const perc = Math.min(100, Math.max(0, ((total - segundosRestantes) / total) * 100));
  const bar = document.getElementById("progressoFocoBar");
  if (bar) bar.style.width = `${perc}%`;
}

window.iniciarPomodoro = function() {
  if (perRecord && !timerPomodoro) { focusCycleId = 'focus_' + crypto.randomUUID(); focusCycleSeconds = segundosRestantes; }
  if (timerPomodoro) return;
  emPausa = false;
  const b1 = document.getElementById("btnIniciarFoco");
  const b2 = document.getElementById("btnPausarFoco");
  if (b1) b1.style.display = "none";
  if (b2) b2.style.display = "inline-flex";
  const contexto = sessao;
  if (!ativa(contexto)) return;
  runningFocusClock=focusClock(segundosRestantes);
  const clock=runningFocusClock,cycleId=focusCycleId,taskId=tarefaFocoAtual?.id??null;
  let finished=false;
  focusTick=() => {
    if (!ativa(contexto)) return;
    if (emPausa) return;
    segundosRestantes=clock.sample();
    atualizarTimerUI();
    if (segundosRestantes <= 0 && !finished) {
      finished=true;
      clearInterval(timerPomodoro);
      timerPomodoro = null;
      if (perRecord) {
        void recordAdapter.focus(cycleId, clock.total, taskId)
          .catch(error => mostrarIndicadorSync(error.message, 'error'));
      } else {
      tempoFocadoHoje += 25;
      tempoTotalFocado += 25;
      if (tarefaFocoAtual) {
        tarefaFocoAtual.tempoGasto = (tarefaFocoAtual.tempoGasto || 0) + 25;
      }
      salvarDados();
      }
      mostrarIndicadorSync("🍅 Ciclo encerrado. Evento de foco aguardando confirmação.",'info');
      mostrarNotificacaoBrowser("🍅 Pomodoro concluído!", "Parabéns! Você completou um ciclo de foco.");
      if (b1) b1.style.display = "inline-flex";
      if (b2) b2.style.display = "none";
    }
  };
  timerPomodoro=setInterval(focusTick,1000);
};

window.pausarPomodoro = function() {
  if(!runningFocusClock||!timerPomodoro)return;
  emPausa = !emPausa;
  if(emPausa)runningFocusClock.pause();else runningFocusClock.resume();
  const btn = document.getElementById("btnPausarFoco");
  if (btn) btn.innerHTML = emPausa ? '<i class="fas fa-play"></i> Retomar' : '<i class="fas fa-pause"></i> Pausar';
};

window.prorrogarTempoFoco = function() {
  if(runningFocusClock&&timerPomodoro){try{runningFocusClock.extend(600);}catch(error){mostrarIndicadorSync(error.message,'error');return;}}
  if (perRecord && timerPomodoro) focusCycleSeconds += 10 * 60;
  segundosRestantes += 10 * 60;
  atualizarTimerUI();
  mostrarIndicadorSync("⏱️ +10 minutos adicionados");
};

window.concluirTarefaFoco = function() {
  if (perRecord && tarefaFocoAtual) {
    void recordAdapter.complete(tarefaFocoAtual.id).catch(error => mostrarIndicadorSync(error.message, 'error'));
    fecharModoFoco();
    return;
  }
  if (!tarefaFocoAtual) return;
  concluirTarefaComRecorrencia(tarefaFocoAtual.id);
  salvarDados();
  mostrarIndicadorSync("✅ Tarefa concluída no foco!");
  mostrarNotificacaoBrowser("✅ Tarefa concluída!", `"${tarefaFocoAtual.texto}" foi concluída.`);
  fecharModoFoco();
};

window.toggleMusicaFoco = async function() {
  const audio = document.getElementById("lofiAudio");
  const btn = document.getElementById("btnMusicaFoco");
  if (!audio || !btn) return;
  const contexto = sessao;
  if (!ativa(contexto)) return;
  const ticket = ++musicaRequest;
  if (musicaAtiva || musicaPendente) {
    audio.pause();
    musicaAtiva = musicaPendente = false;
    btn.replaceChildren(safeNode('i','fas fa-music'), ' LoFi Focus');
    return;
  }
  musicaPendente = true;
  try {
    await audio.play();
    if (!ativa(contexto) || ticket !== musicaRequest) {
      if (!musicaAtiva && !musicaPendente) audio.pause();
      return;
    }
    musicaAtiva = true; musicaPendente = false;
    btn.replaceChildren(safeNode('i','fas fa-volume-mute'), ' Parar LoFi');
  } catch {
    if (!ativa(contexto) || ticket !== musicaRequest) return;
    musicaAtiva = musicaPendente = false;
    btn.replaceChildren(safeNode('i','fas fa-music'), ' LoFi Focus');
    mostrarIndicadorSync('Não foi possível reproduzir o áudio. Verifique a permissão ou tente novamente.', 'error');
  }
};

window.ajustarVolumeFoco = function(valor) {
  const audio = document.getElementById("lofiAudio");
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, Number(valor) / 100));
};

/* =========================
   METAS
========================= */
window.togglePainelMetas = function() {
  const painel = document.getElementById("metasCompletas");
  const btn = document.getElementById("metasToggleBtn");
  if (!painel || !btn) return;
  const aberto = painel.style.display === "block";
  painel.style.display = aberto ? "none" : "block";
  btn.textContent = aberto ? "Ver metas" : "Ocultar metas";
};

function renderizarMetas() {
  const container = document.getElementById("metasGrid");
  if (!container) return;
  renderGoals(container, metas, window);
  const total = metas.length;
  const concl = metas.filter((m) => m.concluida).length;
  const progresso = total ? Math.round((concl / total) * 100) : 0;
  const t = document.getElementById("totalMetas");
  const c = document.getElementById("concluidasMetas");
  const p = document.getElementById("progressoMetas");
  if (t) t.textContent = String(total);
  if (c) c.textContent = String(concl);
  if (p) p.textContent = String(progresso);
}

function renderizarMetasCarrossel() {
  const container = document.getElementById("metasCarousel");
  if (!container) return;
  container.style.display = "none";
  container.innerHTML = "";
}

window.adicionarMeta = function() {
  const texto = document.getElementById("novaMetaTexto")?.value?.trim();
  const categoria = document.getElementById("novaMetaCategoria")?.value || "Geral";
  if (!texto) return;
  metas.push({ id: Date.now(), texto, categoria, concluida: false });
  const inp = document.getElementById("novaMetaTexto");
  if (inp) inp.value = "";
  salvarDados();
  mostrarIndicadorSync("🎯 Meta adicionada!");
};

window.toggleMeta = function(id) {
  const m = metas.find((x) => x.id === id);
  if (!m) return;
  m.concluida = !m.concluida;
  salvarDados();
  mostrarIndicadorSync(m.concluida ? "✅ Meta concluída!" : "🔄 Meta reativada!");
};

window.excluirMeta = function(id) {
  if (!confirm("Excluir meta?")) return;
  metas = metas.filter((m) => m.id !== id);
  salvarDados();
  mostrarIndicadorSync("🗑 Meta excluída!");
};

/* =========================
   DASHBOARD / RODAPÉ
========================= */
function atualizarDashboard() {
  const hoje = getDataHoje();
  const tarefasHoje = tarefas.filter((t) => t.data === hoje && !t.concluida);
  const tarefasAtrasadas = tarefas.filter((t) => t.data && t.data < hoje && !t.concluida);
  const alerta = document.getElementById("dashboardAlerta");
  if (!alerta) return;
  const alertaTexto = document.getElementById("alertaTexto");
  if (tarefasAtrasadas.length > 0) {
    alerta.style.display = "inline-flex";
    const qtd = tarefasAtrasadas.length;
    const palavra = qtd === 1 ? "tarefa atrasada" : "tarefas atrasadas";
    alertaTexto.textContent = `Você tem ${qtd} ${palavra}!`;
  } else if (tarefasHoje.length > 0) {
    alerta.style.display = "inline-flex";
    const qtd = tarefasHoje.length;
    const palavra = qtd === 1 ? "tarefa para hoje" : "tarefas para hoje";
    alertaTexto.textContent = `Você tem ${qtd} ${palavra}!`;
  } else {
    alerta.style.display = "none";
  }
}

function atualizarRodape() {
  const hoje = getDataHoje();
  const concluidas = perRecord ? integratedCounters.completionsToday ?? tarefas.filter(t=>t.concluida&&(t.concluidaEm??'').split('T')[0]===hoje).length : tarefas.filter((t) => t.concluida && t.data === hoje).length;
  const pendentes = tarefas.filter((t) => !t.concluida && t.data === hoje).length;
  const total = concluidas + pendentes;
  const taxa = total > 0 ? Math.round((concluidas / total) * 100) : 0;
  const footerConcluidas = document.getElementById("footerConcluidas");
  const footerTaxa = document.getElementById("footerTaxa");
  const footerPendentes = document.getElementById("footerPendentes");
  const footerTempo = document.getElementById("footerTempo");
  const footerReagendadas = document.getElementById("footerReagendadasCount");
  if (footerConcluidas) footerConcluidas.textContent = String(concluidas);
  if (footerTaxa) footerTaxa.textContent = `${taxa}%`;
  if (footerPendentes) footerPendentes.textContent = String(pendentes);
  if (footerTempo) footerTempo.textContent = `${Math.floor(tempoFocadoHoje / 60)}h ${tempoFocadoHoje % 60}m`;
  if (footerReagendadas) footerReagendadas.textContent = String(tarefasReagendadasHoje);
}

/* =========================
   CALENDÁRIO / VIEW
========================= */
const VIEW_STORAGE_KEY = "fluxo_view_mode";

function setActiveViewButton(view) {
  const btnCards = document.querySelector('.view-btn[onclick*="cards"]');
  const btnCalendario = document.querySelector('.view-btn[onclick*="calendario"]');
  btnCards?.classList.toggle("active", view === "cards");
  btnCalendario?.classList.toggle("active", view === "calendario");
}

function setView(view, persist = true) {
  const cards = document.getElementById("cardsView");
  const cal = document.getElementById("calendarioView");
  if (!cards || !cal) return;
  if (view === "calendario") {
    cards.style.display = "none";
    cal.style.display = "block";
    renderizarCalendario();
  } else {
    cards.style.display = "block";
    cal.style.display = "none";
  }
  setActiveViewButton(view);
  if (persist) localStorage.setItem(VIEW_STORAGE_KEY, view);
}

window.toggleView = function(view) {
  setView(view, true);
};

window.mudarModoCalendario = function(modo) {
  modoCalendario = modo;
  localStorage.setItem("modoCalendario", modo);
  renderizarCalendario();
  document.querySelectorAll(".cal-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === modo);
  });
};

window.mudarMes = function(delta) {
  dataCalendario.setMonth(dataCalendario.getMonth() + delta);
  renderizarCalendario();
};

window.irParaHoje = function() {
  dataCalendario = new Date();
  const cal = document.getElementById("calendarioView");
  if (cal && cal.style.display !== "none") renderizarCalendario();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

/* ===== MODAL DIA CALENDÁRIO ===== */
function renderizarConteudoModalDia(dataStr) {
  const tituloEl = document.getElementById("modalDiaTitulo");
  const resumoEl = document.getElementById("modalDiaResumo");
  const listaEl = document.getElementById("modalDiaLista");
  if (!tituloEl || !resumoEl || !listaEl) return;
  const tarefasDia = tarefas
    .filter((t) => t.data === dataStr && !t.concluida)
    .sort((a, b) => {
      const ordem = { p1: 1, p2: 2, p3: 3 };
      const pa = ordem[a.prioridade || "p3"];
      const pb = ordem[b.prioridade || "p3"];
      if (pa !== pb) return pa - pb;
      return (a.ordem || 0) - (b.ordem || 0);
    });
  tituloEl.textContent = formatarDataPtBr(dataStr);
  resumoEl.textContent = tarefasDia.length === 0
    ? "Nenhuma tarefa pendente neste dia."
    : `${tarefasDia.length} tarefa(s) pendente(s)`;
  if (tarefasDia.length === 0) {
    listaEl.innerHTML = `<div class="modal-dia-empty">Sem tarefas pendentes para este dia 🎉</div>`;
    return;
  }
  const recorrenciaLabel = {
    diaria: "Diária",
    dias_uteis: "Dias úteis",
    semanal: "Semanal",
    mensal: "Mensal"
  };
  renderDayTasks(listaEl, tarefasDia, window);
}

window.adicionarTarefaNoDiaModal = function() {
  if (!dataModalDiaAtual) return;
  const textoEl = document.getElementById("modalDiaNovoTexto");
  const descEl = document.getElementById("modalDiaNovaDescricao");
  const priEl = document.getElementById("modalDiaNovaPrioridade");
  const recEl = document.getElementById("modalDiaNovaRecorrencia");
  const texto = textoEl?.value?.trim();
  const descricao = descEl?.value?.trim() || "";
  const prioridade = priEl?.value || "p2";
  const recorrencia = recEl?.value || "";
  if (!texto) {
    alert("Digite o título da tarefa.");
    return;
  }
  const blocoPadrao = (cardsTarefas[0] && cardsTarefas[0].nome) ? cardsTarefas[0].nome : "Minhas Tarefas";
  const nova = {
    id: uid(),
    texto,
    descricao,
    bloco: blocoPadrao,
    ...(perRecord ? { _spaceId: cardsTarefas[0]?.id ?? null } : {}),
    data: dataModalDiaAtual,
    prioridade,
    recorrencia,
    concluida: false,
    tempoGasto: 0,
    notificado: false,
    ordem: tarefas.filter((t) => t.bloco === blocoPadrao && !t.concluida).length
  };
  normalizarTarefaRecorrente(nova);
  tarefas.push(nova);
  if (textoEl) textoEl.value = "";
  if (descEl) descEl.value = "";
  if (priEl) priEl.value = "p2";
  if (recEl) recEl.value = "";
  salvarDados();
  mostrarIndicadorSync("✅ Tarefa adicionada no calendário!");
};

window.abrirDiaCalendario = function(dataStr) {
  dataModalDiaAtual = dataStr;
  renderizarConteudoModalDia(dataStr);
  const textoEl = document.getElementById("modalDiaNovoTexto");
  const descEl = document.getElementById("modalDiaNovaDescricao");
  const priEl = document.getElementById("modalDiaNovaPrioridade");
  const recEl = document.getElementById("modalDiaNovaRecorrencia");
  if (textoEl) textoEl.value = "";
  if (descEl) descEl.value = "";
  if (priEl) priEl.value = "p2";
  if (recEl) recEl.value = "";
  document.getElementById("modalDiaOverlay")?.classList.add("show");
};

window.fecharDiaCalendario = function() {
  document.getElementById("modalDiaOverlay")?.classList.remove("show");
  dataModalDiaAtual = null;
};

/* ===== RENDERIZAÇÃO DO CALENDÁRIO ===== */
function renderizarCalendario() {
  const grade = document.getElementById("calendarioGrade");
  const mesLabel = document.getElementById("calendarioMes");
  if (!grade) return;
  const ano = dataCalendario.getFullYear();
  const mes = dataCalendario.getMonth();
  const hoje = getDataHoje();
  const isMobile = window.innerWidth <= 768;
  if (mesLabel) {
    mesLabel.textContent = dataCalendario.toLocaleDateString("pt-BR", {
      month: "long",
      year: "numeric"
    });
  }
  grade.className = "calendario-grade";
  if (modoCalendario === "semana") grade.classList.add("modo-semana");
  else if (modoCalendario === "dia") grade.classList.add("modo-dia");
  const cells = document.createDocumentFragment();
  function appendLabel(text, style) {
    const label = safeNode('div', '', text);
    label.style.cssText = style;
    cells.append(label);
  }
  if (modoCalendario === "mes") {
    const primeiroDia = new Date(ano, mes, 1);
    const ultimoDia = new Date(ano, mes + 1, 0);
    const inicioSemana = (primeiroDia.getDay() + 6) % 7;
    const totalDias = ultimoDia.getDate();
    const diasSemana = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
    diasSemana.forEach(day => appendLabel(day, "font-size:12px;opacity:.75;text-align:center;padding:6px 0;color:white"));
    for (let i = 0; i < inicioSemana; i++) cells.append(safeNode("div"));
    for (let dia = 1; dia <= totalDias; dia++) {
      const dataStr = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
      cells.append(calendarCell(tarefas, dataStr, dia, hoje, false, isMobile));
    }
  } else if (modoCalendario === "semana") {
    const dataInicio = new Date(ano, mes, 1);
    const diaSemana = (dataInicio.getDay() + 6) % 7;
    const inicioSemanaOffset = -diaSemana;
    const dataSegunda = new Date(ano, mes, 1);
    dataSegunda.setDate(dataSegunda.getDate() + inicioSemanaOffset);
    const diffDias = (dataCalendario - dataSegunda) / (1000*60*60*24);
    const semanaAtual = Math.floor(diffDias / 7);
    dataSegunda.setDate(dataSegunda.getDate() + semanaAtual * 7);
    if (!isMobile) {
      const diasSemana = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
      diasSemana.forEach(day => appendLabel(day, "font-size:12px;opacity:.75;text-align:center;padding:6px 0;color:white"));
    }
    for (let i = 0; i < 7; i++) {
      const dataDia = new Date(dataSegunda);
      dataDia.setDate(dataDia.getDate() + i);
      const dia = dataDia.getDate();
      const mesDia = dataDia.getMonth() + 1;
      const anoDia = dataDia.getFullYear();
      const dataStr = `${anoDia}-${String(mesDia).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
      cells.append(calendarCell(tarefas, dataStr, dia, hoje, false, isMobile));
    }
  } else if (modoCalendario === "dia") {
    const dia = dataCalendario.getDate();
    const mesDia = dataCalendario.getMonth() + 1;
    const anoDia = dataCalendario.getFullYear();
    const dataStr = `${anoDia}-${String(mesDia).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    const nomeDia = capitalizarPrimeira(dataCalendario.toLocaleDateString("pt-BR", { weekday: "long" }));
    appendLabel(`${nomeDia}, ${dia}/${mesDia}/${anoDia}`, "grid-column:1;text-align:center;color:white;font-weight:600;padding:8px 0");
    cells.append(calendarCell(tarefas, dataStr, dia, hoje, true, isMobile));
  }
  grade.replaceChildren(cells);
  grade.onclick = event => { const day = event.target.closest('[data-day]'); if (day && grade.contains(day)) abrirDiaCalendario(day.dataset.day); };
}

function renderizarTarefas() {
  const container = document.getElementById('blocosTarefas');
  if (container) renderCards(container, cardsTarefas, tarefas, getDataHoje(), window, {today: calcularHoje, month: calcularUltimos30Dias});
}

function calcularHoje(nomeCard, spaceId) {
  const hoje = getDataHoje();
  return tarefas.filter(t => (perRecord ? t._displaySpaceId === spaceId : t.bloco === nomeCard) && t.data === hoje && !t.concluida).length;
}

function calcularUltimos30Dias(nomeCard, spaceId) {
  const trintaDiasAtras = new Date();
  trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
  let dataLimite = trintaDiasAtras.toISOString().split('T')[0];
  if (perRecord) {
    const civil = new Date(getDataHoje() + 'T12:00:00Z');
    civil.setUTCDate(civil.getUTCDate() - 30);
    dataLimite = civil.toISOString().slice(0, 10);
  }
  return tarefas.filter(t =>
    (perRecord ? t._displaySpaceId === spaceId : t.bloco === nomeCard) &&
    t.concluida &&
    typeof t.concluidaEm === 'string' &&
    t.concluidaEm.split('T')[0] >= dataLimite
  ).length;
}

/* =========================
   STATUS / TEMA / EVENTOS
========================= */
function atualizarStatusConexao() {
  const el = document.getElementById("statusConnection");
  if (!el) return;
  if(perRecord){
    if(!ativa(sessao)){el.textContent=auth.currentUser?'Verificando a geração da conta…':'Entre para sincronizar';return;}
    const status=integratedSync;
    if(!status){el.textContent='Carregando estado local…';return;}
    const protection=status.paused;
    el.textContent=protection ? 'Envio pausado • '+protection : status.conflicts ? 'Conflito pendente • versões preservadas' : !navigator.onLine ? 'Offline • alterações locais preservadas' : status.listeningFailed ? 'Leitura remota interrompida • confira a conexão' : status.pending ? status.pending+' alteração(ões) local(is) aguardando confirmação' : 'Online • alterações confirmadas';
    el.classList.toggle('status-offline',!navigator.onLine);el.classList.toggle('status-online',navigator.onLine);return;
  }
  if (protecaoDadosAtiva()) {
    el.textContent = conflitoLocal ? "Conflito local • versões preservadas • Firebase pausado" : "Recuperação local • Firebase pausado";
    return;
  }
  if (ativa(sessao) && dadosLocais.getItem(PENDING_KEY)) {
    el.textContent = 'Alterações locais preservadas • envio pendente';
    return;
  }
  if (navigator.onLine) {
    el.classList.remove("status-offline");
    el.classList.add("status-online");
    el.innerHTML = `<i class="fas fa-wifi"></i> Online`;
  } else {
    el.classList.remove("status-online");
    el.classList.add("status-offline");
    el.innerHTML = `<i class="fas fa-wifi"></i> Offline`;
  }
}

function fecharDropdownUser() {
  document.getElementById("dropdownMenuUser")?.classList.remove("show");
}

function bindUI() {
  // Dropdown toggle
  const dropdownToggle = document.getElementById("dropdownToggle");
  const dropdownMenu = document.getElementById("dropdownMenuUser");
  if (dropdownToggle && dropdownMenu) {
    dropdownToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle("show");
    });
    document.addEventListener("click", () => dropdownMenu.classList.remove("show"));
  }

  document.getElementById("syncNowBtn")?.addEventListener("click", () => {
    if (protecaoDadosAtiva()) { avisarProtecaoDados(); return; }
    const ok = sincronizarTarefasRecorrentes();
    salvarDados();
    if (!ok) mostrarIndicadorSync("ℹ️ Nada novo para sincronizar", "info");
    fecharDropdownUser();
  });

  document.getElementById("rescheduleBtn")?.addEventListener("click", () => {
    const hoje = getDataHoje();
    const atrasadas = tarefas.filter((t) => t.data && t.data < hoje && !t.concluida);
    if (atrasadas.length === 0) {
      mostrarIndicadorSync("🎉 Sem tarefas atrasadas");
      fecharDropdownUser();
      return;
    }
    if (!confirm(`Reagendar ${atrasadas.length} tarefa(s) atrasada(s) para hoje?`)) {
      fecharDropdownUser();
      return;
    }
    atrasadas.forEach((t) => {
      t.data = hoje;
      t.notificado = false;
      tarefasReagendadasHoje++;
      normalizarTarefaRecorrente(t);
    });
    salvarDados();
    mostrarIndicadorSync(`📅 ${atrasadas.length} tarefa(s) reagendada(s)!`);
    fecharDropdownUser();
  });

  document.getElementById("backupBtn")?.addEventListener("click", () => {
    abrirModalBackup();
    fecharDropdownUser();
  });

  document.getElementById("notifyBtn")?.addEventListener("click", () => {
    abrirModalNotificacoes();
    fecharDropdownUser();
  });

  document.getElementById("themeToggle")?.addEventListener("click", () => {
    toggleTema();
    fecharDropdownUser();
  });

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    fazerLogout();
    fecharDropdownUser();
  });

  document.getElementById("relatoriosBtn")?.addEventListener("click", () => {
    abrirModalPerfil();
    abrirTabPerfil('relatorios');
    fecharDropdownUser();
  });

  // Fechar modais com clique no overlay
  document.querySelectorAll(".modal-descricao-overlay, .modal-backup-overlay, .modal-reagendar-overlay, .modal-notificacoes-overlay, .modal-perfil-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.classList.remove("show");
      }
    });
  });

  window.addEventListener("online", atualizarStatusConexao);
  window.addEventListener("offline", atualizarStatusConexao);
}
/* ============================================================
   🎤 COMANDOS DE VOZ (Web Speech API) – CORRIGIDO
   ============================================================ */

// Verifica se o navegador suporta reconhecimento de voz
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

// Estado do microfone
let microfoneAtivo = false;
let timeoutReconhecimento = null;
let tentativasReconexao = 0;
const MAX_TENTATIVAS = 3;

// Elemento do botão
const btnMicrofone = document.getElementById('btnMicrofone');

// Variável global para acumular o texto da fala
let textoCompleto = '';

if (!SpeechRecognition && btnMicrofone) {
  btnMicrofone.style.opacity = '0.3';
  btnMicrofone.title = 'Reconhecimento de voz não suportado';
  btnMicrofone.disabled = true;
}

function pararReconhecimento() {
  clearTimeout(timeoutReconhecimento);
  const anterior = recognition;
  recognition = null;
  if (anterior) {
    anterior.onresult = anterior.onend = anterior.onerror = null;
    try { anterior.abort(); } catch { /* já encerrado */ }
  }
  textoCompleto = '';
  microfoneAtivo = false;
  tentativasReconexao = 0;
  btnMicrofone?.classList.remove('listening');
  btnMicrofone?.replaceChildren(safeNode('i', 'fas fa-microphone'));
}

function configurarRecognition(contexto) {
  const instancia = new SpeechRecognition();
  recognition = instancia;
  instancia.lang = 'pt-BR';
  instancia.continuous = true;
  instancia.interimResults = true;
  instancia.maxAlternatives = 1;
  const atual = () => ativa(contexto) && recognition === instancia && microfoneAtivo;
  instancia.onresult = function(event) {
    if (!atual()) return;
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += ' ' + transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    if (finalTranscript) {
      tentativasReconexao = 0;
      textoCompleto = [textoCompleto, finalTranscript.trim()].filter(Boolean).join(' ');
    }

    if (interimTranscript) {
      console.log('🎤 Ouvindo (parcial):', interimTranscript);
    }

    if (finalTranscript && textoCompleto.trim().length > 0) {
      clearTimeout(timeoutReconhecimento);
      timeoutReconhecimento = agendarSessao(contexto, () => {
        if (atual() && textoCompleto.trim().length > 0) {
          processarComandoVoz(textoCompleto.trim());
          textoCompleto = '';
        }
      }, 1500);
    }
  };

  instancia.onend = function() {
    if (!atual()) return;
    if (tentativasReconexao > 0) return;
    if (textoCompleto.trim().length > 0) {
      processarComandoVoz(textoCompleto.trim());
      textoCompleto = '';
    }
    microfoneAtivo = false;
    if (btnMicrofone) {
      btnMicrofone.classList.remove('listening');
      btnMicrofone.innerHTML = '<i class="fas fa-microphone"></i>';
    }
    clearTimeout(timeoutReconhecimento);
    tentativasReconexao = 0; // reseta tentativas ao finalizar normalmente
  };

  instancia.onerror = function(event) {
    if (!atual()) return;
    console.error('Erro no reconhecimento de voz:', event.error);

    if (event.error === 'network') {
      mostrarIndicadorSync('⚠️ Problema de conexão. Tentando novamente...', 'info');
      tentativasReconexao++;
      if (tentativasReconexao <= MAX_TENTATIVAS) {
        agendarSessao(contexto, () => {
          if (atual() && microfoneAtivo) {
            try {
              instancia.start();
            } catch (e) {
              console.error('Falha ao reiniciar reconhecimento:', e);
            }
          }
        }, 2000);
        return;
      } else {
        mostrarIndicadorSync('❌ Não foi possível conectar ao servidor de voz.', 'error');
      }
    } else if (event.error === 'not-allowed') {
      mostrarIndicadorSync('❌ Permissão do microfone negada!', 'error');
    } else if (event.error === 'no-speech') {
      mostrarIndicadorSync('⏳ Nenhuma fala detectada. Tente novamente.', 'info');
    } else {
      mostrarIndicadorSync('❌ Erro: ' + event.error, 'error');
    }

    pararReconhecimento();
  };
}

/**
 * Alterna o estado do microfone (liga/desliga)
 */
window.toggleMicrofone = function() {
  const contexto = sessao;
  if (!ativa(contexto)) return;
  if (!SpeechRecognition) {
    mostrarIndicadorSync('❌ Reconhecimento de voz não suportado', 'error');
    return;
  }

  // Verifica se está online antes de iniciar
  if (!navigator.onLine) {
    mostrarIndicadorSync('⚠️ Você está offline. Conecte-se à internet para usar o microfone.', 'error');
    return;
  }

  if (microfoneAtivo) {
    recognition.stop();
    microfoneAtivo = false;
    if (btnMicrofone) {
      btnMicrofone.classList.remove('listening');
      btnMicrofone.innerHTML = '<i class="fas fa-microphone"></i>';
    }
    mostrarIndicadorSync('🛑 Microfone desligado', 'info');
    textoCompleto = '';
    tentativasReconexao = 0;
    return;
  }

  try {
    pararReconhecimento();
    configurarRecognition(contexto);
    recognition.start();
    microfoneAtivo = true;
    textoCompleto = '';
    tentativasReconexao = 0;
    if (btnMicrofone) {
      btnMicrofone.classList.add('listening');
      btnMicrofone.innerHTML = '<i class="fas fa-stop-circle"></i>';
    }
    mostrarIndicadorSync('🎤 Ouvindo... fale seu comando', 'info');
  } catch (e) {
    console.error('Erro ao iniciar reconhecimento:', e);
    mostrarIndicadorSync('❌ Erro ao acessar microfone', 'error');
    microfoneAtivo = false;
    if (btnMicrofone) {
      btnMicrofone.classList.remove('listening');
      btnMicrofone.innerHTML = '<i class="fas fa-microphone"></i>';
    }
  }
};

// Evento de clique no botão
if (btnMicrofone) {
  btnMicrofone.addEventListener('click', window.toggleMicrofone);
}

/**
 * Processa o comando de voz e cria a tarefa
 * @param {string} texto - Texto transcrito da fala
 */
async function processarComandoVoz(texto) {
  if (!ativa(sessao)) return;
  const contexto = sessao;
  const textoLimpo = texto.toLowerCase().trim();
  console.log('📝 Comando recebido (completo):', textoLimpo);

  const textoLimpoSemPontuacao = textoLimpo.replace(/[.,;:?!]/g, ' ').replace(/\s+/g, ' ').trim();

  // 🚀 FILTRO DE PALAVRAS-CHAVE
  const palavrasChave = ['adicionar', 'criar', 'nova', 'add', 'tarefa', 'task'];
  const comecaComPalavraChave = palavrasChave.some(palavra => 
    textoLimpoSemPontuacao.startsWith(palavra)
  );

  if (!comecaComPalavraChave) {
    mostrarIndicadorSync('ℹ️ Comando não reconhecido. Diga: "Adicionar tarefa <título> no card <nome>"', 'info');
    if (window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance('Comando não reconhecido. Tente novamente.');
      utterance.lang = 'pt-BR';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    }
    return;
  }

  const padroes = [
    /^(?:adicionar|criar|nova|add)\s+(?:(?:tarefa|task)\s+)?(.+?)(?:\s+(?:no|em)\s+(?:(?:card|espaço|espaco)\s+)?(.+))?$/i,
    /^(?:tarefa|task)\s+(.+?)(?:\s+(?:no|em)\s+(?:(?:card|espaço|espaco)\s+)?(.+))?$/i
  ];

  let titulo = null;
  let cardNome = null;

  for (const padrao of padroes) {
    const match = texto.trim().replace(/\s+/g,' ').match(padrao);
    if (match) {
      titulo = match[1]?.trim();
      cardNome = match[2]?.trim();
      if (titulo) break;
    }
  }

  if (!titulo) {
    const palavrasRemover = ['adicionar', 'criar', 'nova', 'tarefa', 'task', 'add'];
    let textoAux = textoLimpoSemPontuacao;
    for (const palavra of palavrasRemover) {
      textoAux = textoAux.replace(new RegExp(`^${palavra}\\s+`, 'i'), '');
    }
    if (textoAux.length > 0) {
      titulo = textoAux;
    }
  }

  if (!titulo) {
    mostrarIndicadorSync('❌ Não entendi o título da tarefa. Tente: "Adicionar tarefa <título> no card <nome>"', 'error');
    return;
  }

  titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);

  if (!cardNome) {
    if (cardsTarefas.length > 0) {
      cardNome = cardsTarefas[0].nome;
    } else {
      cardsTarefas.push({ id: 'default_' + Date.now(), nome: 'Minhas Tarefas' });
      cardNome = 'Minhas Tarefas';
    }
    mostrarIndicadorSync(`ℹ️ Nenhum card especificado. Usando "${cardNome}"`, 'info');
  }

  const correspondencias = cardsTarefas.filter(c => c.nome.toLowerCase() === cardNome.toLowerCase());
  if (perRecord && correspondencias.length > 1) {
    mostrarIndicadorSync('Há mais de um espaço com esse nome. Escolha o espaço pela interface.', 'error');
    return;
  }
  const card = correspondencias[0];
  if (!card) {
    mostrarIndicadorSync(`❌ Card "${cardNome}" não encontrado.`, 'error');
    return;
  }

  let prioridade = 'p2';
  if (/\b(urgente|alta|importante|prioridade alta|prioridade 1|p1)\b/i.test(textoLimpoSemPontuacao)) {
    prioridade = 'p1';
  } else if (/\b(baixa|tranquilo|fácil|prioridade baixa|prioridade 3|p3)\b/i.test(textoLimpoSemPontuacao)) {
    prioridade = 'p3';
  }

  let recorrencia = '';
  if (/\b(diária|todo dia|diariamente|recorrente diária|recorrencia diaria)\b/i.test(textoLimpoSemPontuacao)) {
    recorrencia = 'diaria';
  } else if (/\b(dias úteis|dias uteis|recorrente dias úteis|recorrencia dias uteis)\b/i.test(textoLimpoSemPontuacao)) {
    recorrencia = 'dias_uteis';
  } else if (/\b(semanal|toda semana|recorrente semanal|recorrencia semanal)\b/i.test(textoLimpoSemPontuacao)) {
    recorrencia = 'semanal';
  } else if (/\b(mensal|todo mês|recorrente mensal|recorrencia mensal)\b/i.test(textoLimpoSemPontuacao)) {
    recorrencia = 'mensal';
  }

  let data = getDataHoje();
  if (/(?:^|\s)(amanhã|amanha)(?=$|\s)/i.test(textoLimpoSemPontuacao)) {
    if (perRecord) {
      const amanha = new Date(getDataHoje() + 'T12:00:00Z');
      amanha.setUTCDate(amanha.getUTCDate() + 1);
      data = amanha.toISOString().slice(0,10);
    } else {
      const amanha = new Date(); amanha.setDate(amanha.getDate()+1);
      data = `${amanha.getFullYear()}-${String(amanha.getMonth()+1).padStart(2,'0')}-${String(amanha.getDate()).padStart(2,'0')}`;
    }
  } else if (/\b(hoje)\b/i.test(textoLimpoSemPontuacao)) {
    data = getDataHoje();
  } else {
    const dataMatch = textoLimpoSemPontuacao.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (dataMatch) {
      const dia = parseInt(dataMatch[1]);
      const mes = parseInt(dataMatch[2]) - 1;
      const ano = dataMatch[3] ? parseInt(dataMatch[3]) : Number(getDataHoje().slice(0,4));
      const candidate = `${ano}-${String(mes+1).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
      if (!isLocalDate(candidate)) { mostrarIndicadorSync('Data inválida no comando. Nenhuma tarefa foi criada.', 'error'); return; }
      data = candidate;
    }
  }

  const novaTarefa = {
    id: uid(),
    texto: titulo,
    descricao: '',
    bloco: card.nome,
    ...(perRecord ? { _spaceId: card.id } : {}),
    data: data,
    prioridade: prioridade,
    recorrencia: recorrencia,
    concluida: false,
    concluidaEm: null,
    tempoGasto: 0,
    notificado: false,
    ordem: tarefas.filter(t => t.bloco === card.nome && !t.concluida).length,
    criadoEm: new Date().toISOString()
  };

  normalizarTarefaRecorrente(novaTarefa);
  tarefas.push(novaTarefa);
  if (!await salvarDados() || !ativa(contexto)) return;

  const emoji = prioridade === 'p1' ? '🔴' : prioridade === 'p3' ? '🟢' : '🟡';
  const recLabel = recorrencia ? ` (${recorrencia})` : '';
  mostrarIndicadorSync(`🎤 Tarefa "${titulo}" registrada localmente em "${card.nome}" ${emoji} ${recLabel}`, 'info');

  if (window.speechSynthesis) {
    const utterance = new SpeechSynthesisUtterance(`Tarefa "${titulo}" registrada localmente.`);
    utterance.lang = 'pt-BR';
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  // Para o microfone automaticamente após processar o comando
  if (recognition) {
    recognition.stop();
  }
}

/* =========================
   INIT
========================= */
async function initApp() {
  await initIndexedDB();
  aplicarTemaSalvo();
  bindUI();
  installAccessibility(window);
  const editorOverlay = document.getElementById('modalEdicaoOverlay');
  let editorBackdropDown = false;
  editorOverlay.addEventListener('pointerdown',event=>{editorBackdropDown=event.target===editorOverlay;});
  editorOverlay.addEventListener('click',event=>{
    if (event.target===editorOverlay && editorBackdropDown) void window.salvarEdicaoTarefa();
    editorBackdropDown=false;
  });
  function refreshCivilDay(){
    focusTick?.();
    if(!ativa(sessao))return;
    const day=getDataHoje();
    if(day!==displayedCivilDay){displayedCivilDay=day;
      for(const id of ['dataHojeHeader','dataHojeMobile'])if(document.getElementById(id))document.getElementById(id).textContent=formatarDataHeader();
      void recordAdapter?.refresh().catch(error=>mostrarIndicadorSync(error.message,'error'));
    }
    atualizarStatusConexao();
  }
  document.addEventListener('visibilitychange',refreshCivilDay);window.addEventListener('focus',refreshCivilDay);
  setInterval(refreshCivilDay,30000);
  document.getElementById('recurrenceDeleteDialog').addEventListener('click',event=>{
    const mode=event.target.closest('[data-recurrence-delete]')?.dataset.recurrenceDelete;
    if(!mode)return;const dialog=event.currentTarget,id=dialog.dataset.taskId;dialog.close();
    if(mode!=='cancel')void recordAdapter?.removeOccurrence(id,mode).catch(error=>mostrarIndicadorSync(error.message,'error'));
  });
  ajustarVolumeFoco(document.getElementById('volumeFoco')?.value ?? 30);
  window.addEventListener('storage', event => {
    if (perRecord) return;
    if (!ativa(sessao) || !event.key?.startsWith(dadosLocais.prefix)) return;
    const key = event.key.slice(dadosLocais.prefix.length);
    if (key === STATE_KEY || key === RECOVERY_KEY || ['tarefas','metas','cardsTarefas','profile'].includes(key)) {
      if (fingerprint(dadosLocais) !== baseLocal) {
        try { writeDraft(dadosLocais,{uid:currentUser?.uid,baseRevision:versaoLocal,values:{tarefas:JSON.stringify(tarefas),metas:JSON.stringify(metas),cardsTarefas:JSON.stringify(cardsTarefas)},before:event.oldValue,key:event.key,tipo:'aba-desatualizada'}); } catch { /* keep this tab open */ }
        indicarConflito(null,'Outra aba alterou dados locais.');
      }
    }
  });
  atualizarStatusConexao();

  const dataHeader = document.getElementById("dataHojeHeader");
  const dataMobile = document.getElementById("dataHojeMobile");
  const textoData = formatarDataHeader(new Date());
  if (dataHeader) dataHeader.textContent = textoData;
  if (dataMobile) dataMobile.textContent = textoData;

  const savedView = localStorage.getItem(VIEW_STORAGE_KEY);
  setView(savedView === "calendario" ? "calendario" : "cards", false);

  const isMobile = window.innerWidth <= 768;
  if (isMobile && !localStorage.getItem("modoCalendario")) {
    modoCalendario = "semana";
    localStorage.setItem("modoCalendario", modoCalendario);
  }
  document.querySelectorAll(".cal-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === modoCalendario);
  });

  if ("Notification" in window) {
    const contexto = sessao;
    const indisponivel = () => { if (ativa(contexto)) mostrarIndicadorSync('Notificações indisponíveis neste navegador. Use o painel de avisos.', 'info'); };
    try { Promise.resolve(Notification.requestPermission()).catch(indisponivel); } catch { indisponivel(); }
  }

  window.addEventListener("resize", () => {
    const mobile = window.innerWidth <= 768;
    const atual = localStorage.getItem("modoCalendario");
    if (mobile && !atual) {
      modoCalendario = "semana";
      localStorage.setItem("modoCalendario", "semana");
      renderizarCalendario();
    }
    renderizarCalendario();
  });

  let stopGeneration;
  const authControls = document.querySelectorAll('#loginOverlay input, #loginOverlay button');
  for (const field of authControls) field.disabled = true;
  onAuthStateChanged(auth, user => {
    stopGeneration?.(); trocarSessao(null);
    for (const field of authControls) field.disabled = false;
    const gate = document.getElementById('generationGate');
    const notice = document.getElementById('generationNotice');notice.hidden=true;
    if (!user) { gate.hidden = true; return; }
    stopGeneration = watchGeneration(user, control => {
      notice.textContent = control.ready && !control.confirmed ? 'Cópia local anteriormente conferida. A geração atual ainda não foi verificada: envios estão pausados.'
        : control.ready && control.status !== 'active' ? 'Esta geração está pausada. Alterações locais continuam preservadas.' : '';
      notice.hidden = !notice.textContent;
      if (!control.ready) {
        trocarSessao(null); showActivationScreen(control.message); return;
      }
      hideActivationScreen(); document.getElementById('syncTools').hidden=false;
      if (sessao?.uid===user.uid && sessao.generation===control.generation) { sessao.control=control; void recordAdapter?.session.flush(); return; }
      void abrirSessao(user, control);
    });
  });
}

function trocarSessao(user) {
  hideActivationScreen(); document.getElementById('syncTools').hidden=true;
  recordAdapter?.close();
  recordAdapter = undefined;
  integratedProfile = {};
  integratedSync=undefined;integratedCounters={};displayedCivilDay=undefined;
  const zoneNotice=document.getElementById('timeZoneNotice');zoneNotice.textContent='';zoneNotice.hidden=true;
  focusCycleId = undefined;
  focusCycleSeconds = 0;
  const anterior = sessao;
  sessao = null;
  currentUser = null;
  window.currentUser = null;
  for (const id of anterior?.timers || []) clearTimeout(id);
  for (const aviso of anterior?.notifications || []) aviso.close();
  clearTimeout(timerIndicador);
  clearInterval(timerPomodoro);
  timerPomodoro = null;
  runningFocusClock=null;focusTick=null;
  tarefaFocoAtual = null;
  emPausa = false;
  segundosRestantes = 25 * 60;
  const audio = document.getElementById('lofiAudio');
  if (audio) { audio.pause(); audio.currentTime = 0; }
  musicaAtiva = false;
  musicaPendente = false; musicaRequest++;
  const botaoMusica = document.getElementById('btnMusicaFoco');
  if (botaoMusica) botaoMusica.replaceChildren(safeNode('i','fas fa-music'), ' LoFi Focus');
  pararReconhecimento();
  window.speechSynthesis?.cancel();
  limparAvatarTemporario();
  tarefaReagendando = tarefaDescricaoAtual = tarefaEditandoAtual = null;
  document.getElementById('recoveryAlert').hidden = true;
  document.getElementById('recoveryAlertText').textContent = '';
  tarefaArrastandoId = tarefaArrastandoOrigem = dataModalDiaAtual = null;
  for (const modal of document.querySelectorAll('[id$="Overlay"].show')) modal.classList.remove('show');
  fecharDropdownUser();
  for (const campo of document.querySelectorAll('input:not([type=range]), textarea')) campo.value = '';
  for (const id of ['blocosTarefas','metasGrid','calendarioGrade','backupList','relatoriosContainer',
    'notificacoesLista','modalDiaLista','modalDiaTitulo','modalDiaResumo','modalDescricaoTitulo',
    'modalDescricaoTexto','tarefaFocoTexto','alertaTexto','loginErrorMessage','registerErrorMessage','syncIndicator']) {
    document.getElementById(id)?.replaceChildren();
  }
  document.getElementById('syncIndicator')?.classList.remove('show');
  aplicarPerfil({});
  const mainApp = document.getElementById('mainApp');
  const login = document.getElementById('loginOverlay');
  if (mainApp) mainApp.style.display = 'none';
  if (login) login.style.display = user ? 'none' : 'flex';

  dadosLocais = user ? accountStorage(localStorage, user.uid) : null;
  tarefas = []; metas = []; cardsTarefas = [];
  tempoTotalFocado = tempoFocadoHoje = tarefasReagendadasHoje = 0;
  ultimaDataFoco = ultimaDataReset = ultimaDataReagendamento = '';
  armazenamentoInvalido = !!user && rascunhosEmMemoria.has(user.uid);
  restauracaoEmCurso = false;
  operacoesRemotas = gravacoesLocais = 0;
  filaLocal = Promise.resolve();
  conflitoLocal = !!dadosLocais && dadosLocais.getItem(CONFLICT_KEY) !== null;
  recoveryObservado = dadosLocais?.getItem(RECOVERY_KEY) ?? null;
  baseLocal = dadosLocais ? fingerprint(dadosLocais) : '';
  versaoLocal = 0;
  atualizarRodape();
  renderizarMetas();
  if (dadosLocais) {
    try { versaoLocal = readRevision(dadosLocais); }
    catch { armazenamentoInvalido = true; }
  }
  if (!user) return null;
  currentUser = user;
  window.currentUser = Object.freeze({ uid: user.uid });
  sessao = { uid: user.uid, lock: LOCK_NAME + ':' + dadosLocais.prefix,
    timers: new Set(), notifications: new Set(), remotoPronto: false };
  return sessao;
}

async function abrirSessao(user, control) {
  const contexto = trocarSessao(user);
  if (!contexto) return;
  contexto.generation = control?.generation; contexto.control = control;
  if (perRecord) {
    document.getElementById('mainApp').style.display = 'none';
    try {
      const adapter = await openAdapter({
        db, uid: user.uid, generation: contexto.generation, securityPaused: () => !contexto.control?.confirmed || contexto.control?.status !== 'active', active: () => ativa(contexto),
        notify: message => { if (ativa(contexto)) mostrarIndicadorSync(message); },
        render: data => {
          if (!ativa(contexto)) return;
          tarefas = data.tarefas; metas = data.metas; cardsTarefas = data.cardsTarefas;
          integratedProfile = data.profile;
          integratedSync=data.sync;integratedCounters=data.counters;
          const zoneNotice=document.getElementById('timeZoneNotice');zoneNotice.textContent=data.timeZoneProblem??'';zoneNotice.hidden=!data.timeZoneProblem;
          tempoTotalFocado = data.counters.total;
          tempoFocadoHoje = data.counters.today;
          tarefasReagendadasHoje = data.counters.reschedules;
          aplicarPerfil(data.profile);
          renderizarTarefas(); renderizarMetas(); renderizarMetasCarrossel(); renderizarCalendario();
          atualizarDashboard(); atualizarRodape();
          atualizarStatusConexao();
          if (dataModalDiaAtual) renderizarConteudoModalDia(dataModalDiaAtual);
        }
      });
      if (!ativa(contexto)) adapter.close();
      else { recordAdapter = adapter; document.getElementById('mainApp').style.display = 'block'; document.getElementById('syncTools').hidden=false; }
    } catch (error) { if (ativa(contexto)) mostrarIndicadorSync(error.message, 'error'); }
    return;
  }
  try {
    if (recoveryBlocked(dadosLocais)) {
      const journal = JSON.parse(dadosLocais.getItem(RECOVERY_KEY));
      if (journal.uid !== contexto.uid) throw new Error('Registro de recuperação incompatível com esta conta.');
      if (journal.status === 'prepared') {
        if (!confirm('Concluir a restauração local interrompida? O Firebase continuará pausado.')) return;
        const retomou = await navigator.locks.request(contexto.lock, () => {
          if (!ativa(contexto)) return false;
          commitRestore(dadosLocais, journal);
          versaoLocal = readRevision(dadosLocais) + 1;
          dadosLocais.setItem(STATE_KEY, JSON.stringify({ revision: versaoLocal }));
          baseLocal = fingerprint(dadosLocais);
          recoveryObservado = dadosLocais.getItem(RECOVERY_KEY);
          return true;
        });
        if (!retomou || !ativa(contexto)) return;
      } else if (journal.status !== 'restored') {
        throw new Error('Registro de recuperação inválido.');
      }
    }
    for (const key of ['tempoTotalFocado', 'tempoFocadoHoje', 'tarefasReagendadasHoje']) {
      const raw = dadosLocais.getItem(key);
      if (raw !== null && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 0 || raw.trim() === '')) armazenamentoInvalido = true;
    }
    recarregarEstadoLocal();
    const mainApp = document.getElementById('mainApp');
    if (mainApp) mainApp.style.display = 'block';
    atualizarStatusConexao();
    await carregarDadosFirebase(contexto);
    if (!ativa(contexto)) return;
    if (!dadosLocais.getItem(PENDING_KEY)) await verificarResetDiario();
    if (!ativa(contexto)) return;
    atualizarRodape();
    atualizarStatusConexao();
    if (sincronizarTarefasRecorrentes()) await salvarDados();
  } catch (error) {
    if (ativa(contexto)) {
      armazenamentoInvalido = true;
      const mainApp = document.getElementById('mainApp');
      if (mainApp) mainApp.style.display = 'block';
      atualizarStatusConexao();
      mostrarIndicadorSync(error.message, 'error');
    }
  }
}

initApp();













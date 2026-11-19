import { isLocalDate } from './monthly.mjs';
import { validJSON, validateChanges } from './runtime/task-model.mjs';

export async function fingerprint(value) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
}
const typed = value => JSON.stringify([typeof value,value]);
const identifier = value => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isFinite(value);
const cadence = new Set(['','diaria','semanal','mensal','dias_uteis']);
function parsed(value, fallback) { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
export async function previewCurrent(raw) {
  if (typeof raw !== 'string' || raw.length > 20000000) throw new Error('Arquivo ausente ou maior que 20 MB.');
  let outer, tasks, spaces;
  try {
    outer=JSON.parse(raw);
    tasks=parsed(outer?.localStorage?.tarefas,outer?.tarefas);
    spaces=parsed(outer?.localStorage?.cardsTarefas,outer?.cardsTarefas ?? []);
  } catch { throw new Error('JSON inválido. O arquivo original não foi alterado.'); }
  if (!Array.isArray(tasks) || !Array.isArray(spaces) || !validJSON(outer)) throw new Error('Estrutura de backup inválida.');
  const digest=await fingerprint(raw), rows=[], pending=tasks.filter(t=>t?.concluida===false);
  const invalidDone=tasks.filter(t=>!t || typeof t.concluida!=='boolean').length;
  const taskIds=new Map();
  for (const task of tasks) taskIds.set(typed(task?.id),(taskIds.get(typed(task?.id))??0)+1);
  for (const task of pending) {
    const identity=typed(task.id), recurring=!!task.recorrencia;
    const group=recurring && identifier(task.serieId) ? tasks.filter(t=>typed(t?.serieId)===typed(task.serieId)) : [task];
    const issues=[];
    if (!identifier(task.id) || taskIds.get(identity)!==1) issues.push('Identificador ausente ou duplicado.');
    if (!cadence.has(task.recorrencia ?? '')) issues.push('Frequência desconhecida.');
    if (recurring && (!identifier(task.serieId) || group.filter(t=>t.concluida===false).length!==1)) issues.push('Série sem identificação segura ou com várias ocorrências pendentes.');
    if (recurring && group.some(t=>t.recorrencia!==task.recorrencia)) issues.push('O histórico contém frequências diferentes.');
    if (recurring && group.some(t=>t.concluida && isLocalDate(t.data) && isLocalDate(task.data) && t.data>=task.data)) issues.push('O histórico já contém uma ocorrência concluída nesta data ou depois dela.');
    if (recurring && group.some(t=>Object.entries(t).some(([key,value])=> /^(ativa|ativo|active|enabled)$/i.test(key) && value===false
      || /^(cancelada|cancelado|encerrada|encerrado|desativada|desativado|deleted|disabled)$/i.test(key) && value===true))) issues.push('Possível série encerrada ou desativada.');
    const candidates=spaces.filter(s=>s?.nome===task.bloco);
    if (task.bloco && candidates.length!==1) issues.push('Espaço sem correspondência única.');
    if (candidates.length===1 && (!identifier(candidates[0].id) || spaces.filter(s=>typed(s?.id)===typed(candidates[0].id)).length!==1)) issues.push('Identificador de espaço ambíguo.');
    const days=[...new Set(group.filter(t=>isLocalDate(t.data)).map(t=>Number(t.data.slice(8))))].sort((a,b)=>a-b);
    const monthly=task.recorrencia==='mensal';
    const anchor=monthly && days.length===1 ? days[0] : null;
    const changes={text:task.texto,description:task.descricao??'',
      date:task.data==null||task.data===''?null:task.data,
      priority:task.prioridade==null||task.prioridade===''?'p2':task.prioridade,done:false,spaceId:null};
    try { validateChanges(changes); if(recurring && !isLocalDate(task.data)) throw new Error('Data ausente.'); }
    catch(error) { issues.push(error.message); }
    const importIdentity=await fingerprint(typed([recurring?'series':'task',recurring?task.serieId:task.id]));
    rows.push({raw:task,identity,importIdentity,id:'imp_'+importIdentity.slice(0,48),recurring,changes,space:candidates[0]??null,
      days,anchor,review:monthly && anchor===null,issues});
  }
  return {digest,total:tasks.length,completed:tasks.filter(t=>t?.concluida===true).length,pending:pending.length,
    simple:rows.filter(r=>!r.recurring).length,recurring:rows.filter(r=>r.recurring).length,
    invalidDone,rows,spaces};
}
export function reviewImport(preview, anchors={}) {
  if(preview.invalidDone) throw new Error('Há tarefas com estado de conclusão inválido. A importação foi bloqueada.');
  return preview.rows.map(row=>{
    const decision=anchors[row.id];
    const mode=row.review && decision && typeof decision==='object' ? decision.mode : 'recurring';
    if(row.review && mode==='hold')return {...row,held:true};
    if(row.issues.length) throw new Error(row.issues.join(' '));
    const destinationId=row.recurring?row.id+'-1':row.id;
    if(row.review && mode==='single'){
      if(decision.confirmed!==true)throw new Error('Confirme explicitamente a conversão desta série em tarefa avulsa.');
      return {...row,destinationId,recurring:false,anchorDay:null,importMode:'single-reviewed'};
    }
    if(row.review && mode!=='recurring')throw new Error('Escolha uma decisão válida para a série.');
    const anchorDay=row.review?Number(typeof decision==='object'?decision.anchorDay:decision):row.anchor;
    if(row.review && (!Number.isInteger(anchorDay)||anchorDay<1||anchorDay>31)) throw new Error('Confira o dia de referência de todas as séries mensais divergentes.');
    return {...row,destinationId,anchorDay,importMode:row.recurring?'recurring':'simple'};
  }).filter(row=>!row.held);
}

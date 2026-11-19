import config from '../runtime-config.js';
import { previewCurrent, reviewImport, fingerprint } from './current-import-model.mjs';
import { preserve, orderId } from './adapter-model.mjs';
import { keepDraft } from './drafts.mjs';
import { equal } from './runtime/task-model.mjs';
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
export function mountCurrentImport({owner}) {
  const panel=node('section'), heading=node('h2','Importar tarefas atuais do Fluxo anterior');
  const file=node('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','Backup das tarefas atuais');
  const previewButton=node('button','Conferir arquivo'), list=node('div'), summary=node('p'), status=node('p');status.setAttribute('role','status');
  const consent=node('input');consent.type='checkbox';
  const label=node('label',' Confirmo que este arquivo pertence a esta conta e que revisei as séries mensais.');label.prepend(consent);
  const apply=node('button','Importar na geração desta conta');apply.disabled=true;
  panel.append(heading,node('p','Somente tarefas pendentes. O histórico concluído e os contadores antigos não serão importados.'),file,previewButton,summary,list,label,apply,status);
  document.querySelector('main').append(panel);
  let version=0,preview,raw,inputs={},choices={};
  function clear(resetFile=false){version++;preview=raw=undefined;inputs={};choices={};list.replaceChildren();summary.textContent='';status.textContent='';consent.checked=false;apply.disabled=true;if(resetFile)file.value='';}
  file.onchange=()=>clear();
  previewButton.onclick=async()=>{
    clear(); const v=version;
    try {
      if(!file.files[0])throw new Error('Escolha um backup JSON.');
      const value=await file.files[0].text(), result=await previewCurrent(value);
      if(v!==version)return; raw=value;preview=result;
      summary.textContent=`${result.total} registros: ${result.completed} concluídos preservados no arquivo; ${result.simple} avulsos e ${result.recurring} recorrentes pendentes. ${result.rows.filter(r=>r.review).length} séries mensais exigem revisão.`;
      for(const row of result.rows){
        const item=node('article');item.append(node('p',row.raw.texto+' · '+(row.raw.data??'Sem data')+' · '+(row.raw.bloco??'Sem espaço')));
        item.append(node('p','Prioridade: '+row.changes.priority+' · Frequência: '+(row.raw.recorrencia||'Avulsa')),
          node('p',row.changes.description||'Sem descrição'));
        if(row.issues.length)item.append(node('p','Bloqueado: '+row.issues.join(' ')));
        if(row.review){const field=node('input');field.type='number';field.min='1';field.max='31';field.required=true;
          const name=node('label','Dia mensal original (dias observados: '+row.days.join(', ')+'): ');name.append(field);item.append(name);inputs[row.id]=field;
          const mode=node('select');mode.setAttribute('aria-label','Decisão para '+row.raw.texto);
          for(const [value,title]of [['recurring','Continuar mensal: informar o dia confirmado'],['hold','Preservar para revisão, sem importar agora'],['single','Importar somente esta tarefa como avulsa']])mode.add(new Option(title,value));
          const checkbox=node('input');checkbox.type='checkbox';checkbox.disabled=true;
          const confirmation=node('label',' Confirmo importar '+row.raw.texto+' como avulsa, sem continuar a série.');confirmation.prepend(checkbox);
          mode.onchange=()=>{field.disabled=mode.value!=='recurring';checkbox.disabled=mode.value!=='single';checkbox.checked=false;};
          item.append(node('p','O histórico não comprova o dia original. O título da tarefa não determina a regra.'),mode,confirmation);
          choices[row.id]={mode,checkbox};}
        list.append(item);
      }
      apply.disabled=!config.importEnabled || result.invalidDone>0 || result.rows.some(r=>r.issues.length);
      if(!config.importEnabled)status.textContent='Prévia disponível. A importação real permanece desabilitada até autorização.';
    }catch(error){if(v===version)status.textContent=error.message;}
  };
  apply.onclick=async()=>{
    const current=owner(),v=version;
    const guard=()=>{if(v!==version||owner()!==current||!current?.control?.confirmed||current.control.status!=='active')throw new Error('Conta, geração ou conexão não confirmada. A tentativa foi preservada.');};
    apply.disabled=true;
    try {
      guard();if(!config.importEnabled||!consent.checked)throw new Error('Confirme a propriedade e a revisão do arquivo.');
      const decisions=Object.fromEntries(Object.entries(inputs).map(([id,input])=>[id,{mode:choices[id].mode.value,anchorDay:input.value,confirmed:choices[id].checkbox.checked}]));
      const selected=reviewImport(preview,decisions);
      if(!selected.length)throw new Error('Todas as tarefas foram mantidas para revisão. Nenhuma importação foi iniciada.');
      if(!confirm(`Preparar ${selected.length} tarefas nesta conta, sem importar o histórico?`))return;
      await keepDraft(current.uid,{type:'importacaoAtual',raw,digest:preview.digest,decisions,
        selections:selected.map(r=>({id:r.destinationId,anchorDay:r.anchorDay,mode:r.importMode}))},guard,current.generation);
      await navigator.locks.request('fluxo-import:'+JSON.stringify([current.uid,current.generation]),async()=>{
        const session=current.session, imported=[], tracked=new Set();
        async function existing(id,identity,selection){
          guard();const state=await session.state();guard();
          const local=state.tasks.find(r=>r.id===id), remote=await session.readRecord(id);guard();
          if(remote?.deleted||local?.confirmed?.deleted)throw new Error('Identificador excluído: restauração explícita necessária.');
          const data=remote?.data??local?.view;
          if(data && data.legacy?.audit?.importIdentity!==identity)throw new Error('Identificador já ocupado por outra versão. Nenhuma versão foi substituída.');
          if(data && selection && !equal(data.legacy.original,selection.raw))throw new Error('Este registro tem outra versão no arquivo. A tentativa foi preservada nos rascunhos; confira as diferenças pela edição/conciliação antes de continuar.');
          if(data && selection && Object.hasOwn(selection,'recurring') && (selection.recurring ? data.seriesId!==selection.id : data.seriesId!=null))throw new Error('Esta tarefa já foi importada com outra decisão. Use a edição/conciliação explícita; nenhuma segunda tarefa será criada.');
          if(data && selection?.recurring && selection.raw.recorrencia==='mensal'){
            const anchor=data.legacy?.audit?.reviewedAnchorDay ?? (await session.readRecord(selection.id))?.data.anchorDay;
            guard();
            if(anchor!==selection.anchorDay)throw new Error('O dia mensal já confirmado difere desta escolha. Confira a série pela edição/conciliação; a importação não altera uma decisão anterior.');
          }
          return !!data;
        }
        const sequences=new Map();
        for(const row of selected){
          guard();let spaceId=null;
          if(row.space){
            const identity=await fingerprint(JSON.stringify(['space',typeof row.space.id,row.space.id]));spaceId='imp_'+identity.slice(0,48);tracked.add(spaceId);
            if(!await existing(spaceId,identity,{raw:row.space})){
              const legacy=preserve(row.space,null,'backup-atual',0);legacy.audit.importIdentity=identity;legacy.audit.sourceDigest=preview.digest;
              await session.enqueue(spaceId,{name:row.space.nome,legacy},{kind:'space',create:true});
            }
          }
          const id=row.destinationId;
          tracked.add(id);
          const legacy=preserve(row.raw,null,'backup-atual',preview.rows.indexOf(row));
          legacy.audit.importIdentity=row.importIdentity;legacy.audit.sourceDigest=preview.digest;
          legacy.audit.importMode=row.importMode;legacy.audit.reviewedAnchorDay=row.anchorDay;
          if(!await existing(id,row.importIdentity,row)){
            guard();const changes={...row.changes,spaceId,legacy};
            if(row.recurring){const {date,done,...editable}=changes;await session.startSeries({seriesId:row.id,date,cadence:row.raw.recorrencia,anchorDay:row.anchorDay??undefined,changes:editable});}
            else await session.enqueue(id,changes,{create:true});
          }
          imported.push(id);
          if(spaceId){const ids=sequences.get(spaceId)??[];ids.push({id,order:row.raw.ordem??0});sequences.set(spaceId,ids);}
          status.textContent=`${imported.length}/${selected.length} tarefas preservadas na fila ou já existentes. Conferindo confirmação remota…`;
        }
        // A ordem já existente exige conciliação; nunca substituí-la pela ordem do backup.
        for(const [spaceId,rows] of sequences){
          guard();const id=await orderId(spaceId);tracked.add(id);
          const state=await session.state();guard();const remote=await session.readRecord(id);guard();
          if(!remote&&!state.tasks.some(r=>r.id===id))await session.enqueue(id,{ids:rows.sort((a,b)=>a.order-b.order).map(r=>r.id)},{kind:'order',create:true});
        }
        await session.flush();guard();
        const state=await session.state();guard();
        const remaining=state.operations.filter(op=>op.status!=='confirmed'&&tracked.has(op.id));
        status.textContent=remaining.length?'Importação preservada, com confirmações pendentes ou conflitos. Consulte a fila; pode repetir este arquivo para retomar sem duplicar.':'Importação confirmada. Nenhum histórico concluído foi importado.';
        if(!remaining.length&&selected.length<preview.rows.length)status.textContent+=' '+(preview.rows.length-selected.length)+' tarefas permanecem no arquivo para revisão; não foram importadas.';
      });
    }catch(error){if(v===version)status.textContent=error.message+' Operações já preservadas não foram apagadas; repita o arquivo para retomar.';}
    finally{if(v===version)apply.disabled=!config.importEnabled||!preview;}
  };
  return {clear:()=>clear(true)};
}

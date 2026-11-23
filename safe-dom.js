import { matchesFilter } from './sync/productivity.mjs';
// Dynamic values are assigned through DOM properties, never parsed as markup or code.
export const node = (tag, cls = '', text) => {
  const n = document.createElement(tag); n.className = cls;
  if (text !== undefined) n.textContent = String(text ?? '');
  return n;
};
const icon = name => node('i', 'fas fa-' + name);
export function button(cls, title, name, action) {
  const b = node('button', cls); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
  if (name) b.append(icon(name));
  b.addEventListener('click', event => { event.stopPropagation(); action(event); });
  return b;
}
export const domCardKey = id => encodeURIComponent(JSON.stringify(id));
export function avatar(container, value) {
  if (!container) return;
  container.replaceChildren(icon('user-circle'));
  if (typeof value !== 'string') return;
  let safe = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value);
  try { const u = new URL(value); safe ||= u.protocol === 'https:' && !u.username && !u.password; } catch { /* no URL */ }
  if (!safe) return;
  const img = node('img'); img.alt = 'Avatar'; img.src = value;
  Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' });
  container.replaceChildren(img);
}
const recLabel = rec => ({ diaria:'Diária', dias_uteis:'Dias úteis', 'dias-uteis':'Dias úteis', semanal:'Semanal', mensal:'Mensal' }[rec] || 'Recorrente');
const pri = task => task.prioridade === 'p1' ? 'p1' : task.prioridade === 'p2' ? 'p2' : 'p3';
export function goals(container, rows, actions) {
  if (!container) return;
  container.replaceChildren(...rows.map(m => {
    const card = node('div', 'meta-card-mini');
    Object.assign(card.style,{background:'rgba(255,255,255,0.08)',padding:'12px',borderRadius:'12px',display:'flex',justifyContent:'space-between',alignItems:'center'});
    const left = node('div'); Object.assign(left.style, {display:'flex',alignItems:'center',gap:'10px',flex:'1'});
    const check = button(m.concluida ? 'circulo-concluido' : 'circulo-pendente', 'Alternar conclusão', m.concluida ? 'check' : null, () => actions.toggleMeta(m.id));
    if(!m.concluida)check.style.background='transparent';else check.style.border='none';
    const info = node('div'); info.append(node('div','titulo-meta',m.texto), node('small','',m.categoria || ''));
    Object.assign(info.lastChild.style,{color:'rgba(255,255,255,0.5)',fontSize:'11px'});
    const remove=button('','Excluir meta','trash-alt',()=>actions.excluirMeta(m.id));Object.assign(remove.style,{background:'none',border:'none',color:'rgba(255,255,255,0.4)',cursor:'pointer'});
    // O laboratório/offline não depende da fonte remota dos ícones.
    remove.append(document.createTextNode('×'));remove.style.minWidth='24px';remove.style.minHeight='24px';
    const hit=node('label','check-hit');hit.append(check);left.append(hit,info); card.append(left,remove);
    return card;
  }));
}
export function dayTasks(container, rows, actions) {
  container.replaceChildren(...rows.map(t => {
    const row=node('div','modal-dia-item '+pri(t)); const main=node('div','modal-dia-main');
    main.append(node('div','modal-dia-title',t.texto));
    if(t.descricao) main.append(node('div','modal-dia-desc',t.descricao));
    const tags=node('div','modal-dia-tags'); tags.append(node('span','modal-dia-tag',pri(t)==='p1'?'🔴 Alta':pri(t)==='p2'?'🟡 Média':'🟢 Baixa'));
    if(t.bloco) tags.append(node('span','modal-dia-tag',t.bloco));
    if(t.recorrencia) tags.append(node('span','modal-dia-tag',recLabel(t.recorrencia)));
    main.append(tags);const buttons=node('div','modal-dia-actions');
    for(const [title,name,fn] of [['Concluir','check','toggleTarefa'],['Editar','edit','abrirModalEdicao'],['Reagendar','calendar-alt','abrirModalReagendar'],['Excluir','trash-alt','excluirTarefa']]) buttons.append(button('modal-dia-btn'+(fn==='excluirTarefa'?' danger':''),title,name,()=>actions[fn](t.id)));
    row.append(main,buttons);return row;
  }));
}
export function cards(container, cards, tasks, today, actions, counts) {
  const restoreFocus=document.activeElement?.matches('.task-options-toggle,.space-options-toggle')?document.activeElement.id:null;
  container.replaceChildren();
  for(const card of cards) {
    const key=domCardKey(card.id);const box=node('div','card-espaco');
    box.addEventListener('dragover',actions.permitirDropCard);box.addEventListener('dragleave',actions.removerDragOver);
    box.addEventListener('drop',e=>actions.soltarTarefa(e,card.nome,null,card.id));
    const rows=tasks.filter(t=>(t._displaySpaceId ? t._displaySpaceId===card.id : t.bloco===card.nome) && (counts.filter ? matchesFilter(t,today,counts.filter) : (t._displaySpaceId ? (!t.data || t.data<=today) : t.data && t.data<=today) && !t.concluida)).sort((a,b)=>(a.ordem||0)-(b.ordem||0));
    const head=node('div','card-header'),identity=node('div','space-identity'),title=node('span','space-name',card.nome);
    if(!card._virtual){const handle=button('space-drag-handle','Arrastar espaço '+card.nome,'grip-vertical',()=>{});handle.draggable=true;handle.addEventListener('dragstart',e=>actions.iniciarDragEspaco(card.id,e));handle.addEventListener('dragend',()=>actions.encerrarDragEspaco());identity.append(handle);}
    identity.append(title);
    title.title=card.nome;
    const controls=node('div','space-header-actions'),spaceMenu=node('div','space-menu-panel');spaceMenu.hidden=true;spaceMenu.id='space-menu-'+key;spaceMenu.setAttribute('role','group');spaceMenu.setAttribute('aria-label','Ações do espaço '+card.nome);
    controls.append(node('span','space-count',rows.length+(rows.length===1?' ativa':' ativas')));
    if(!card._virtual){
      const toggle=button('space-options-toggle','Opções do espaço · '+card.nome,'ellipsis-v',()=>{spaceMenu.hidden=!spaceMenu.hidden;toggle.setAttribute('aria-expanded',String(!spaceMenu.hidden));});toggle.id='space-options-'+key;toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',spaceMenu.id);
      const close=()=>{spaceMenu.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus({preventScroll:true});};
      for(const target of [toggle,spaceMenu])target.addEventListener('keydown',e=>{if(e.key==='Escape'&&!spaceMenu.hidden){e.preventDefault();e.stopPropagation();close();}});
      for(const [label,iconName,action]of [['Mover espaço para a posição anterior','arrow-left',()=>actions.moverEspaco(card.id,-1)],['Mover espaço para a próxima posição','arrow-right',()=>actions.moverEspaco(card.id,1)],['Excluir espaço','trash-alt',()=>actions.excluirCardTarefa(card.id)]]){const item=button('space-menu-action'+(iconName==='trash-alt'?' danger':''),label+' · '+card.nome,iconName,()=>{close();action();});item.append(document.createTextNode(' '+label));spaceMenu.append(item);}
      controls.append(button('space-edit','Editar espaço','edit',()=>actions.editarCardTarefa(card.id)),toggle);
    }
    head.append(identity,controls);
    const content=node('div','card-content');
    content.append(blankCreationArea(container,card,key,actions));
    if(!rows.length){const empty=node('div','estado-vazio');empty.append(icon('check-circle'),node('p','','Nenhuma tarefa nesta visualização'),node('small','','Troque o filtro ou adicione uma tarefa'));content.append(empty);}
    for(const t of rows){
      const row=node('div','tarefa-item '+pri(t));row.draggable=true;
      row.addEventListener('dragstart',e=>actions.iniciarDragTarefa(t.id,card.nome,e));
      row.addEventListener('dragend',()=>document.querySelectorAll('.tarefa-item').forEach(el=>el.classList.remove('dragging')));
      row.addEventListener('dragover',actions.permitirDropTarefa);row.addEventListener('drop',e=>{e.stopPropagation();actions.soltarTarefa(e,card.nome,t.id,card.id);});
      const left=node('div','task-left');const handle=node('div','drag-handle');handle.append(icon('grip-vertical'));
      const check=node('input','task-checkbox');check.type='checkbox';check.checked=!!t.concluida;check.setAttribute('aria-label','Concluir '+t.texto);check.addEventListener('change',()=>actions.toggleTarefa(t.id));
      const info=node('div','task-info');const text=node('button','task-title text-control',t.texto);text.type='button';text.title='Editar tarefa';text.setAttribute('aria-label','Editar '+t.texto);text.addEventListener('click',()=>actions.abrirModalEdicao(t.id));
      const meta=node('div','task-meta');const date=node('button','meta-date text-control '+(t.data<today?'badge atrasada':''),(t.data||'Sem data')+(t.data&&t.data<today?' ⚠':''));date.type='button';date.setAttribute('aria-label','Reagendar '+t.texto);date.addEventListener('click',()=>actions.abrirModalReagendar(t.id));meta.append(date);
      if(t.tempoGastoLegado)meta.append(node('span','meta-tag','Foco anterior preservado: '+t.tempoGastoLegado+' (unidade em conferência)'));
      if(t.data>today){const future=button('meta-date text-control','Ver no calendário · '+t.texto,'calendar-alt',()=>actions.verDataTarefa(t.id));meta.append(future);}
      if(t.recorrencia)meta.append(node('span','meta-tag',recLabel(t.recorrencia)));
      if(t.tempoGasto)meta.append(node('span','meta-tag',Math.floor(t.tempoGasto/60)+'min'));
      const priority=({p1:'Alta',p2:'Média',p3:'Baixa'})[pri(t)],priorityId='priority-'+domCardKey(t.id);
      const description=node('span','visually-hidden','Prioridade '+priority);description.id=priorityId;text.setAttribute('aria-describedby',priorityId);check.setAttribute('aria-describedby',priorityId);row.title='Prioridade '+priority;
      info.append(description,text,meta);const hit=node('label','check-hit');hit.append(check);left.append(handle,hit,info);
      const btns=node('div','task-actions-2x2'),panel=node('div','task-menu-panel');panel.hidden=true;panel.id='task-menu-'+domCardKey(t.id);panel.setAttribute('role','group');panel.setAttribute('aria-label','Ações de '+t.texto);
      const toggle=button('task-action-btn task-options-toggle','Opções de '+t.texto,'ellipsis-v',()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));});toggle.id='task-options-'+domCardKey(t.id);toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',panel.id);
      const close=()=>{panel.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus({preventScroll:true});};
      toggle.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){e.preventDefault();e.stopPropagation();close();}});
      panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}});
      panel.append(node('span','task-menu-priority','Prioridade: '+priority));
      for(const [label,action]of [['Editar tarefa',()=>actions.abrirModalEdicao(t.id)],['Mover para cima',()=>actions.moverTarefaNoCard(t.id,-1)],['Mover para baixo',()=>actions.moverTarefaNoCard(t.id,1)],['Excluir tarefa',()=>actions.excluirTarefa(t.id)]]){const item=button('task-menu-action',label+' · '+t.texto,null,()=>{close();action();});item.textContent=label;panel.append(item);}
      btns.append(button('task-action-btn','Modo Foco','clock',()=>actions.abrirModoFoco(t.id)),toggle);row.append(left,btns,panel);content.append(row);
    }
    const add=button('btn-nova-tarefa','Nova Tarefa','plus-circle',()=>actions.mostrarFormAdicionar(card.id));add.append(document.createTextNode(' Nova Tarefa'));
    const summary=node('div','card-resumo');const item=node('div','card-resumo-item');
    const summaryIcon=node('span','resumo-icon');summaryIcon.append(icon('chart-simple'));
    const summaryText=node('span','resumo-texto'),todayCount=counts.today(card.nome,card.id),monthCount=counts.month(card.nome,card.id);
    for(const [count,label]of [[todayCount,todayCount===1?'pendente para hoje':'pendentes para hoje'],[monthCount,monthCount===1?'concluída em 30 dias':'concluídas em 30 dias']]){const line=node('span','resumo-line');line.append(node('span','resumo-num',count),document.createTextNode('\u00a0'+label));summaryText.append(line);}
    item.append(summaryIcon,summaryText);summary.append(item);
    const form=node('div','inline-form');form.id='form-'+key;
    for(const [tag,field,type,placeholder] of [['input','texto','text','Título...'],['textarea','descricao',null,'Descrição...'],['input','data','date','']]){const input=node(tag);input.id=field+'-'+key;input.setAttribute('aria-label',placeholder||'Data');if(type)input.type=type;if(placeholder)input.placeholder=placeholder;if(type==='date')input.value=today;if(tag==='textarea')input.rows=2;form.append(input);}
    for(const [field,options] of [['prioridade',[['p3','🟢 Baixa'],['p2','🟡 Média'],['p1','🔴 Alta']]],['recorrencia',[['','Sem recorrência'],['diaria','Diária'],['dias_uteis','Dias úteis'],['semanal','Semanal'],['mensal','Mensal']]]]){const select=node('select');select.id=field+'-'+key;select.setAttribute('aria-label',field);for(const [value,label] of options){const option=node('option','',label);option.value=value;select.append(option);}form.append(select);}
    const buttons=node('div','inline-form-buttons');const confirm=button('btn-confirm','Adicionar',null,()=>actions.adicionarTarefaInline(card.id));confirm.textContent='Adicionar';const cancel=button('btn-cancel','Cancelar',null,()=>actions.mostrarFormAdicionar(card.id));cancel.textContent='Cancelar';buttons.append(confirm,cancel);form.append(buttons);box.append(head,spaceMenu,content,add,summary,form);container.append(box);
  }
  const add=node('div','card-novo-espaco');const body=node('div');body.append(icon('plus-circle'),node('p','','Novo Espaço'));add.append(body);add.tabIndex=0;add.setAttribute('role','button');add.addEventListener('click',actions.adicionarCardTarefa);add.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')actions.adicionarCardTarefa();});container.append(add);
  if(restoreFocus)document.getElementById(restoreFocus)?.focus({preventScroll:true});
}
export function calendarCell(tasks,data,day,today,expanded,mobile) {
  const rows=tasks.filter(t=>t.data===data&&!t.concluida).sort((a,b)=>pri(a).localeCompare(pri(b)));
  const cell=node('div','cal-dia'+(data===today?' hoje':''));cell.dataset.day=data;
  cell.tabIndex=0;cell.setAttribute('role','button');cell.setAttribute('aria-label',data+' · '+rows.length+' tarefas pendentes');
  cell.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();cell.click();}});
  const top=node('div','cal-dia-topo');top.append(node('span','cal-dia-num',day));if(rows.length)top.append(node('span','cal-dia-badge',rows.length));
  const list=node('div','cal-dia-lista');const visible=expanded?rows:rows.slice(0,mobile?2:3);
  for(const task of visible){const entry=node('div','cal-task '+pri(task));entry.title=task.texto;entry.append(node('span','',task.texto));list.append(entry);}
  if(rows.length>visible.length)list.append(node('div','cal-task-more','+'+(rows.length-visible.length)+' mais'));cell.append(top,list);return cell;
}






// Retain drag suppression across projection renders, without intercepting native scrolling.
const creationGuards=new WeakMap();
function blankCreationArea(container,card,key,actions){
  let guard=creationGuards.get(container);
  if(!guard){
    guard={dragging:false,until:0};creationGuards.set(container,guard);
    container.addEventListener('dragstart',()=>{guard.dragging=true;},true);
    const finish=()=>{guard.dragging=false;guard.until=performance.now()+500;};
    container.addEventListener('drop',finish,true);container.addEventListener('dragend',finish,true);
  }
  const area=button('space-create-area','Nova tarefa na área vazia · '+card.nome,null,event=>{
    const moved=gesture?.moved;gesture=null;
    if((guard.dragging&&container.querySelector('.dragging,.space-dragging'))||performance.now()<guard.until||moved||document.getSelection()?.isCollapsed===false)return;
    const form=document.getElementById('form-'+key);
    if(!form?.classList.contains('show'))actions.mostrarFormAdicionar(card.id);
    form?.querySelector('input[type=text]')?.focus();
    gesture=null;
  });
  let gesture=null;
  area.addEventListener('pointerdown',event=>{gesture={x:event.clientX,y:event.clientY,scrollX,scrollY,moved:!event.isPrimary||event.button!==0};});
  area.addEventListener('pointermove',event=>{if(gesture&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>8)gesture.moved=true;});
  area.addEventListener('pointerup',()=>{if(gesture&&(scrollX!==gesture.scrollX||scrollY!==gesture.scrollY))gesture.moved=true;if(gesture?.moved)guard.until=performance.now()+500;gesture=null;});
  area.addEventListener('pointercancel',()=>{gesture=null;guard.until=performance.now()+500;});
  return area;
}

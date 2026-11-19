export function installAccessibility(actions) {
  const closeNames={modalDescricaoOverlay:'fecharModalDescricao',modalEdicaoOverlay:'fecharModalEdicao',modalBackupOverlay:'fecharModalBackup',modalFocoOverlay:'fecharModoFoco',modalReagendarOverlay:'fecharModalReagendar',modalDiaOverlay:'fecharDiaCalendario',modalNotificacoesOverlay:'fecharModalNotificacoes',modalPerfilOverlay:'fecharModalPerfil'};
  const overlays=[...document.querySelectorAll('[id$="Overlay"]')].filter(o=>closeNames[o.id]);
  const previous=new WeakMap();
  const stack=[];
  let originalOverflow='';
  function arrange(){
    if(stack.length && !document.body.hasAttribute('data-modal-lock')){
      originalOverflow=document.body.style.overflow;document.body.style.overflow='hidden';document.body.setAttribute('data-modal-lock','');
    }
    for(const [index,overlay] of stack.entries()){
      overlay.style.zIndex=String(3500+index*20);
      overlay.inert=index!==stack.length-1;
      overlay.setAttribute('aria-modal',String(index===stack.length-1));
    }
    if(!stack.length){document.body.style.overflow=originalOverflow;document.body.removeAttribute('data-modal-lock');}
  }
  const controls=overlay=>[...overlay.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(e=>!e.disabled&&e.getClientRects().length);
  for(const overlay of overlays){
    overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
    const title=overlay.querySelector('h1,h2,h3');if(title){title.id||=overlay.id+'Title';overlay.setAttribute('aria-labelledby',title.id);}
    else overlay.setAttribute('aria-label','Janela do Fluxo');
    for(const button of overlay.querySelectorAll('.modal-close'))button.setAttribute('aria-label','Fechar janela');
  }
  const observer=new MutationObserver(records=>{
    for(const {target}of records){if(!overlays.includes(target))continue;
      if(target.classList.contains('show')){
        if(!previous.has(target)){previous.set(target,document.activeElement);stack.push(target);arrange();queueMicrotask(()=>controls(target)[0]?.focus());}
      }else if(previous.has(target)){
        const focus=previous.get(target);previous.delete(target);stack.splice(stack.indexOf(target),1);
        target.inert=false;target.style.removeProperty('z-index');arrange();
        if(focus?.isConnected&&!focus.closest('[inert]'))focus.focus();else controls(stack.at(-1)??target)[0]?.focus();
      }
    }
  });
  for(const overlay of overlays)observer.observe(overlay,{attributes:true,attributeFilter:['class']});
  document.addEventListener('keydown',event=>{
    if(document.querySelector('dialog[open]'))return;
    const overlay=stack.at(-1);if(!overlay)return;
    if(event.key==='Escape'){event.preventDefault();actions[closeNames[overlay.id]]?.();return;}
    if(event.key!=='Tab')return;const items=controls(overlay);if(!items.length)return;
    const index=items.indexOf(document.activeElement);
    if(event.shiftKey&&(index<=0)){event.preventDefault();items.at(-1).focus();}
    else if(!event.shiftKey&&(index<0||index===items.length-1)){event.preventDefault();items[0].focus();}
  });
}

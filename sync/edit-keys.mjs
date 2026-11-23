// Atalhos somente em editores explicitamente registrados; controles nativos ficam livres.
const saving=new WeakSet();
export const isSaving=scope=>!!scope&&saving.has(scope);
export async function saveOnce(scope,work){
 if(saving.has(scope))return false;
 saving.add(scope);scope.setAttribute('aria-busy','true');
 const buttons=[...scope.querySelectorAll('button[type="submit"]')].map(b=>[b,b.disabled]);
 for(const [b]of buttons)b.disabled=true;
 try{return await work();}finally{saving.delete(scope);scope.removeAttribute('aria-busy');for(const [b,disabled]of buttons)b.disabled=disabled;}
}
export function installEnterSave(root,resolve,onError=()=>{}){
 root.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey)return;
  const field=event.target;
  if(!(field instanceof HTMLTextAreaElement)&&!(field instanceof HTMLInputElement&&['text','search','email','url','tel','number'].includes(field.type)))return;
  if(field.disabled||field.readOnly||field.closest('[inert]'))return;
  const save=resolve(field);if(!save)return;
  event.preventDefault();if(event.repeat)return;
  Promise.resolve().then(save).catch(onError);
 });
}
export function editText({title,value='',multiline=false,maxLength=200,save}){
 if(document.getElementById('textEditDialog'))return;
 const previous=document.activeElement,dialog=document.createElement('dialog');dialog.id='textEditDialog';dialog.className='modal-conteudo fluxo-text-editor';
 const form=document.createElement('form');form.dataset.enterSave='true';
 const heading=document.createElement('h3');heading.id='textEditTitle';heading.textContent=title;dialog.setAttribute('aria-labelledby',heading.id);
 const label=document.createElement('label');label.textContent=title;
 const input=document.createElement(multiline?'textarea':'input');input.id='textEditValue';if(!multiline)input.type='text';input.className='modal-input';input.value=value;input.maxLength=maxLength;input.required=!multiline;label.append(input);
 const hint=document.createElement('p');hint.textContent='Enter salva · Shift+Enter quebra linha · Escape cancela.';
 const error=document.createElement('p');error.role='alert';
 const actions=document.createElement('div');actions.className='modal-actions';
 const confirm=document.createElement('button');confirm.type='submit';confirm.className='btn-primary';confirm.textContent='Salvar';
 const cancel=document.createElement('button');cancel.type='button';cancel.className='btn-secondary';cancel.textContent='Cancelar';cancel.onclick=()=>{if(!isSaving(form))dialog.close();};
 actions.append(confirm,cancel);form.append(heading,label,hint,error,actions);dialog.append(form);document.body.append(dialog);
 form.onsubmit=event=>{event.preventDefault();void saveOnce(form,async()=>{error.textContent='';try{await save(input.value);dialog.close();}catch(e){error.textContent=e.message;}});};
 dialog.addEventListener('cancel',event=>{if(isSaving(form))event.preventDefault();});
 dialog.addEventListener('close',()=>{dialog.remove();if(previous?.isConnected)previous.focus();});
 let outside=false;const isOutside=event=>{const r=dialog.getBoundingClientRect();return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;};
 dialog.addEventListener('pointerdown',event=>{outside=isOutside(event);});dialog.addEventListener('click',event=>{if(outside&&isOutside(event))form.requestSubmit();outside=false;});
 dialog.showModal();input.focus();input.select();
}

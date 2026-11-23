/* Preferência exclusivamente visual, aplicada antes do CSS e do aplicativo. */
(()=>{
 const key='temaFluxo',root=document.documentElement;let current='dark';
 try{current=localStorage.getItem(key)==='light'?'light':'dark';}catch{}
 function apply(value=current){
  current=value==='light'?'light':'dark';
  for(const element of [root,document.body])if(element){element.classList.remove('purple-theme','light-theme','dark-theme');element.classList.add(current+'-theme');}
  root.style.colorScheme=current;
  try{if(localStorage.getItem(key)!==current)localStorage.setItem(key,current);}catch{}
  const button=document.getElementById('themeToggle'),next=current==='dark'?'Claro':'Escuro';
  if(button){button.title='Mudar para tema '+next;button.setAttribute('aria-label',button.title);const icon=button.querySelector('i');if(icon)icon.className=current==='dark'?'fas fa-moon':'fas fa-sun';}
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',current==='dark'?'#141820':'#f5f6f8');
 }
 window.FluxoTheme={apply,toggle:()=>apply(current==='dark'?'light':'dark'),get current(){return current;}};
 apply();document.addEventListener('DOMContentLoaded',()=>apply());
 window.addEventListener('storage',event=>{if(event.key===key)apply(event.newValue);});
})();

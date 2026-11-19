// performance.now é monotônico: alteração manual de Date.now não cria minutos de foco.
export function focusClock(seconds, now=()=>performance.now()) {
  if(!Number.isSafeInteger(seconds)||seconds<1||seconds>86400)throw new RangeError('Duração de foco inválida.');
  let remaining=seconds*1000,total=seconds,last=now(),paused=false;
  function sample(){const current=now();if(!paused)remaining=Math.max(0,remaining-Math.max(0,current-last));last=current;return Math.ceil(remaining/1000);}
  return {sample,get total(){return total;},get paused(){return paused;},
    pause(){sample();paused=true;},resume(){last=now();paused=false;},
    extend(seconds){if(!Number.isSafeInteger(seconds)||seconds<1||total+seconds>86400)throw new RangeError('Ciclo de foco limitado a 24 horas.');sample();remaining+=seconds*1000;total+=seconds;}};
}

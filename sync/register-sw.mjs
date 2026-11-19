if ('serviceWorker' in navigator && isSecureContext) {
  window.addEventListener('load',() => {
    navigator.serviceWorker.register(new URL('../sj.js',import.meta.url),
      {scope:new URL('../',import.meta.url).pathname}).catch(() => {
      console.warn('Instalação offline indisponível. Os dados locais não foram apagados.');
    });
  });
}

export function authMessage(error) {
  return ({
    'auth/popup-blocked':'Permita a janela de login e tente novamente. No celular, abra o Fluxo diretamente no navegador.',
    'auth/popup-closed-by-user':'A janela de login foi fechada. Nenhum dado foi alterado; você pode tentar novamente.',
    'auth/cancelled-popup-request':'Já existe uma tentativa de login. Aguarde ou feche a janela anterior.',
    'auth/unauthorized-domain':'Este endereço ainda precisa ser autorizado no Firebase Authentication.',
    'auth/operation-not-allowed':'Este método de login precisa ser habilitado no Firebase Authentication.',
    'auth/account-exists-with-different-credential':'Entre pelo método já utilizado nesta conta. Não criaremos nem uniremos outra conta automaticamente.',
    'auth/network-request-failed':'Não foi possível conectar para entrar. Confira a internet e tente novamente; os dados locais foram preservados.',
    'auth/web-storage-unsupported':'O navegador bloqueou o armazenamento necessário à sessão. Confira as permissões de armazenamento.',
    'auth/too-many-requests':'Muitas tentativas de entrada. Aguarde antes de tentar novamente.',
    'auth/invalid-credential':'E-mail ou senha inválidos.',
    'auth/wrong-password':'E-mail ou senha inválidos.',
    'auth/user-not-found':'E-mail ou senha inválidos.'
  })[error?.code] ?? 'Não foi possível entrar. Confira a conexão e tente novamente.';
}

import config from '../runtime-config.js';
export const ACTIVATION_MESSAGE = 'Login confirmado. As tarefas, a nova geração e as gravações permanecem desativadas até autorização específica. Nenhuma importação foi realizada.';
export function canUseData(value) {
  return value.mode === 'emulator' || (value.mode === 'production' && value.dataEnabled === true);
}
// Decisão fixa durante esta carga. Alterar um objeto em memória não libera a sessão.
export const DATA_ENABLED = canUseData(config);

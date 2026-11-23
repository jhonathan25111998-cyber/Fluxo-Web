// View-only helpers: dates are civil YYYY-MM-DD values supplied by the account clock.
export function matchesFilter(task, today, filter = 'today') {
  if (task.concluida) return false;
  if (filter === 'all') return true;
  if (!task.data) return false;
  return filter === 'future' ? task.data > today : filter === 'late' ? task.data < today : task.data <= today;
}
const normalized = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
export function searchTasks(tasks, query, limit = 50) {
  const term = normalized(query.trim()), seen = new Set(), matches = [];
  if (!term) return { total: 0, rows: [] };
  let total = 0;
  for (const task of tasks) {
    if (seen.has(task.id) || !normalized([task.texto, task.descricao, task.bloco].join(' ')).includes(term)) continue;
    seen.add(task.id); total++;
    if (matches.length < limit) matches.push(task);
  }
  return { total, rows: matches };
}
export function syncPresentation(status, online = true) {
  if (!status) return { text: 'Carregando estado local…', attention: false };
  const pending = status.pending ? `${status.pending} alteração(ões) salva(s) localmente • aguardando envio` : '';
  if (status.conflicts) return { text: 'Conflito pendente • versões preservadas • consulte os detalhes', attention: true };
  if (status.paused) return { text: 'Envio pausado • ' + status.paused, attention: true };
  if (status.listeningFailed) return { text: 'Erro na leitura remota • dados locais preservados', attention: true };
  if (!online) return { text: 'Offline • ' + (pending || 'dados locais preservados'), attention: true };
  if (pending) return { text: pending, attention: true };
  if (!status.serverConfirmed) return { text: 'Conectando • conferindo o servidor', attention: false };
  return { text: 'Online • alterações confirmadas no servidor', attention: false };
}

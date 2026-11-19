// Apresentação somente: não consulta Firebase, não abre filas e não libera dados.
export function showActivationScreen(message) {
  document.getElementById('loginOverlay').style.display='none';
  document.getElementById('mainApp').style.display='none';
  document.getElementById('syncTools').hidden=true;
  document.getElementById('generationMessage').textContent=message;
  document.getElementById('generationGate').hidden=false;
}
export function hideActivationScreen() {
  document.getElementById('generationGate').hidden=true;
}

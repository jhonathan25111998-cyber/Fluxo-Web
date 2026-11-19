export function validControl(value) {
  if (!value || value.schemaVersion !== 3 || value.minClientVersion !== 3
    || !['active','paused'].includes(value.status)
    || typeof value.activeGeneration !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.activeGeneration)
    || value.activeGeneration === 'fase6-base') return null;
  return {generation:value.activeGeneration,status:value.status};
}

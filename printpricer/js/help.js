// Help / instructions modal.

export function initHelp() {
  const trigger = document.getElementById('help-btn');
  const modal = document.getElementById('help-modal');
  const close = document.getElementById('help-close');
  if (!trigger || !modal) return;
  const open  = () => modal.classList.add('show');
  const shut  = () => modal.classList.remove('show');
  trigger.addEventListener('click', open);
  close.addEventListener('click', shut);
  modal.addEventListener('click', e => { if (e.target === modal) shut(); });
}

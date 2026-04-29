// Help / instructions modal.

export function initHelp() {
  const modal = document.getElementById('help-modal');
  const close = document.getElementById('help-close');
  if (!modal) return;
  const open = () => modal.classList.add('show');
  const shut = () => modal.classList.remove('show');
  // Bind every help affordance (top button next to the layer tabs is the
  // primary; older footer button stays supported if present).
  document.querySelectorAll('#help-btn-top, #help-btn').forEach(b => {
    b.addEventListener('click', open);
  });
  close.addEventListener('click', shut);
  modal.addEventListener('click', e => { if (e.target === modal) shut(); });
}

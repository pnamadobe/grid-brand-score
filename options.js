const DEFAULTS = { enabled: true, green: 85, amber: 80, position: 'bottom-right' };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('green').value = s.green;
  $('amber').value = s.amber;
  $('position').value = s.position;
});

$('save').addEventListener('click', () => {
  const green = Number($('green').value);
  const amber = Number($('amber').value);
  if (!Number.isFinite(green) || !Number.isFinite(amber) || amber > green) {
    $('status').style.color = '#c9252d';
    $('status').textContent = 'Amber threshold must be a number no higher than green.';
    return;
  }
  chrome.storage.sync.set(
    { enabled: $('enabled').checked, green, amber, position: $('position').value },
    () => {
      $('status').style.color = '#0f7d55';
      $('status').textContent = 'Saved — open Assets tabs update immediately.';
    },
  );
});

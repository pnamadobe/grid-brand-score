const DEFAULTS = { enabled: true, bandMode: 'fixed', green: 85, amber: 80, topPct: 25, bottomPct: 25, position: 'bottom-right' };
const $ = (id) => document.getElementById(id);
const mode = () => document.querySelector('input[name="bandMode"]:checked')?.value || 'fixed';

function showGroups() {
  $('fixedGroup').hidden = mode() !== 'fixed';
  $('relativeGroup').hidden = mode() !== 'relative';
}

function showMiddle() {
  const mid = 100 - (Number($('topPct').value) || 0) - (Number($('bottomPct').value) || 0);
  $('midPct').textContent = `${mid} %`;
}

function fail(msg) {
  $('status').style.color = '#c9252d';
  $('status').textContent = msg;
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  document.querySelector(`input[name="bandMode"][value="${s.bandMode === 'relative' ? 'relative' : 'fixed'}"]`).checked = true;
  $('green').value = s.green;
  $('amber').value = s.amber;
  $('topPct').value = s.topPct;
  $('bottomPct').value = s.bottomPct;
  $('position').value = s.position;
  showGroups();
  showMiddle();
});

for (const r of document.querySelectorAll('input[name="bandMode"]')) r.addEventListener('change', showGroups);
$('topPct').addEventListener('input', showMiddle);
$('bottomPct').addEventListener('input', showMiddle);

$('save').addEventListener('click', () => {
  const green = Number($('green').value);
  const amber = Number($('amber').value);
  const topPct = Number($('topPct').value);
  const bottomPct = Number($('bottomPct').value);
  if (!Number.isFinite(green) || !Number.isFinite(amber) || amber > green) {
    return fail('Amber threshold must be a number no higher than green.');
  }
  if (![topPct, bottomPct].every((p) => Number.isFinite(p) && p >= 0 && p <= 100) || topPct + bottomPct > 100) {
    return fail('Top and bottom percentages must be 0–100 and add up to 100 or less.');
  }
  chrome.storage.sync.set(
    { enabled: $('enabled').checked, bandMode: mode(), green, amber, topPct, bottomPct, position: $('position').value },
    () => {
      $('status').style.color = '#0f7d55';
      $('status').textContent = 'Saved — open Assets tabs update immediately.';
    },
  );
});

const API = '/api';

// ─── State ───
let currentView = 'timeline';

// ─── Tab Navigation ───
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    document.getElementById(`view-${view}`).classList.add('active');
    currentView = view;
    if (view === 'timeline') loadTimeline();
    if (view === 'health') loadHealth();
  });
});

// ─── Filters ───
const filterType = document.getElementById('filter-type');
const filterStatus = document.getElementById('filter-status');
const filterProject = document.getElementById('filter-project');

filterType.addEventListener('change', loadTimeline);
filterStatus.addEventListener('change', loadTimeline);
let debounceTimer;
filterProject.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadTimeline, 300);
});

// ─── Timeline ───
async function loadTimeline() {
  const params = new URLSearchParams();
  if (filterType.value) params.set('type', filterType.value);
  if (filterStatus.value) params.set('status', filterStatus.value);
  if (filterProject.value) params.set('project', filterProject.value);

  const res = await fetch(`${API}/memories?${params}`);
  const memories = await res.json();

  const list = document.getElementById('timeline-list');
  const count = document.getElementById('memory-count');
  count.textContent = `${memories.length} memories`;

  if (memories.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem">No memories found.</p>';
    return;
  }

  list.innerHTML = memories.map(m => `
    <div class="memory-item ${m.status}" data-id="${m.id}">
      <span class="badge badge-${m.type}">${m.type}</span>
      <div class="memory-content">
        <p>${escapeHtml(m.content)}</p>
        <div class="memory-meta">
          <span>confidence: ${m.confidence}</span>
          ${m.project ? `<span>project: ${m.project}</span>` : ''}
          <span>${m.status}</span>
          <span>${formatDate(m.updated_at)}</span>
        </div>
        ${m.tags && m.tags.length ? `
          <div class="memory-tags" style="margin-top:0.3rem">
            ${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');

  // Attach click handlers
  list.querySelectorAll('.memory-item').forEach(item => {
    item.addEventListener('click', () => openEditModal(item.dataset.id));
  });
}

// ─── Health Dashboard ───
async function loadHealth() {
  const res = await fetch(`${API}/health`);
  const stats = await res.json();

  const container = document.getElementById('health-content');

  const total = stats.total || 0;
  const types = ['identity', 'preference', 'project', 'episode', 'rule'];
  const colors = {
    identity: 'var(--badge-identity)',
    preference: 'var(--badge-preference)',
    project: 'var(--badge-project)',
    episode: 'var(--badge-episode)',
    rule: 'var(--badge-rule)',
  };

  const barSegments = total > 0
    ? types.map(t => {
        const count = stats.byType[t] || 0;
        const pct = (count / total * 100).toFixed(1);
        return pct > 0 ? `<span style="width:${pct}%;background:${colors[t]}" title="${t}: ${count}">${count > 0 ? t : ''}</span>` : '';
      }).join('')
    : '<span style="width:100%;background:var(--border)">empty</span>';

  container.innerHTML = `
    <div class="health-grid">
      <div class="stat-card">
        <div class="value">${total}</div>
        <div class="label">Total Memories</div>
      </div>
      <div class="stat-card ${stats.pendingReviewCount > 0 ? 'warning' : ''}">
        <div class="value">${stats.pendingReviewCount}</div>
        <div class="label">Pending Review</div>
      </div>
      <div class="stat-card ${stats.lowConfidenceCount > 0 ? 'warning' : ''}">
        <div class="value">${stats.lowConfidenceCount}</div>
        <div class="label">Low Confidence</div>
      </div>
      <div class="stat-card ${stats.staleEpisodesCount > 0 ? 'danger' : ''}">
        <div class="value">${stats.staleEpisodesCount}</div>
        <div class="label">Stale Episodes</div>
      </div>
    </div>

    <h3 style="font-size:0.9rem;margin-bottom:0.5rem">Distribution by Type</h3>
    <div class="type-bar">${barSegments}</div>

    <h3 style="font-size:0.9rem;margin-bottom:0.5rem">Status Breakdown</h3>
    <table style="width:100%;font-size:0.85rem;border-collapse:collapse">
      ${Object.entries(stats.byStatus || {}).map(([k, v]) =>
        `<tr><td style="padding:0.3rem 0">${k}</td><td style="text-align:right">${v}</td></tr>`
      ).join('')}
    </table>

    ${stats.oldestMemory ? `<p style="margin-top:1rem;font-size:0.8rem;color:var(--text-muted)">Oldest: ${formatDate(stats.oldestMemory)} | Newest: ${formatDate(stats.newestMemory)}</p>` : ''}
  `;
}

// ─── Edit Modal ───
const modal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');

async function openEditModal(id) {
  const [memRes, verRes] = await Promise.all([
    fetch(`${API}/memories/${id}`),
    fetch(`${API}/memories/${id}/versions`),
  ]);
  const memory = await memRes.json();
  const versions = await verRes.json();

  document.getElementById('edit-id').value = memory.id;
  document.getElementById('edit-content').value = memory.content;
  document.getElementById('edit-type').value = memory.type;
  document.getElementById('edit-confidence').value = memory.confidence;
  document.getElementById('edit-status').value = memory.status;
  document.getElementById('edit-tags').value = (memory.tags || []).join(', ');
  document.getElementById('edit-project').value = memory.project || '';
  document.getElementById('edit-reason').value = '';

  const expiresInput = document.getElementById('edit-expires');
  if (memory.expires_at) {
    expiresInput.value = memory.expires_at.slice(0, 16);
  } else {
    expiresInput.value = '';
  }

  document.getElementById('edit-meta').textContent =
    `ID: ${memory.id}\nCreated: ${memory.created_at}\nUpdated: ${memory.updated_at}` +
    (memory.source_tool ? `\nSource: ${memory.source_tool}` : '') +
    (memory.confirmation_count ? `\nConfirmations: ${memory.confirmation_count}` : '');

  const verContainer = document.getElementById('version-history');
  if (versions.length > 0) {
    verContainer.innerHTML = `
      <h3>Version History (${versions.length})</h3>
      ${versions.map(v => `
        <div class="version-item">
          <div>${escapeHtml(v.content)}</div>
          <div class="reason">${escapeHtml(v.reason)} — ${formatDate(v.created_at)}</div>
        </div>
      `).join('')}
    `;
  } else {
    verContainer.innerHTML = '';
  }

  modal.showModal();
}

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const expiresVal = document.getElementById('edit-expires').value;
  const body = {
    content: document.getElementById('edit-content').value,
    type: document.getElementById('edit-type').value,
    confidence: parseFloat(document.getElementById('edit-confidence').value),
    status: document.getElementById('edit-status').value,
    tags: document.getElementById('edit-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    project: document.getElementById('edit-project').value || undefined,
    reason: document.getElementById('edit-reason').value || undefined,
    expires_at: expiresVal ? new Date(expiresVal).toISOString() : undefined,
  };

  await fetch(`${API}/memories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  modal.close();
  loadTimeline();
});

document.getElementById('btn-forget').addEventListener('click', async () => {
  const id = document.getElementById('edit-id').value;
  const reason = prompt('Reason for forgetting this memory:');
  if (reason === null) return;

  await fetch(`${API}/memories/${id}/forget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });

  modal.close();
  loadTimeline();
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  const id = document.getElementById('edit-id').value;
  if (!confirm('Permanently delete this memory? This cannot be undone.')) return;

  await fetch(`${API}/memories/${id}`, { method: 'DELETE' });
  modal.close();
  loadTimeline();
});

document.getElementById('btn-cancel').addEventListener('click', () => modal.close());

// ─── Helpers ───
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString();
}

// ─── Init ───
loadTimeline();
loadSyncStatus();

// ─── Sync ───
async function loadSyncStatus() {
  try {
    const res = await fetch(`${API}/sync/status`);
    const data = await res.json();
    const badge = document.getElementById('sync-status');
    const btn = document.getElementById('btn-sync');

    if (data.configured && data.authenticated) {
      const pending = (data.localOnly || 0) + (data.modified || 0);
      badge.textContent = pending > 0 ? `${pending} unsynced` : 'synced';
      btn.style.display = '';
    } else if (data.configured) {
      badge.textContent = 'not logged in';
    }
  } catch { /* sync not configured */ }
}

async function doSync() {
  const btn = document.getElementById('btn-sync');
  btn.textContent = 'Syncing...';
  btn.disabled = true;

  try {
    const res = await fetch(`${API}/sync`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      alert('Sync error: ' + data.error);
    } else {
      alert(`Synced: pushed ${data.pushed}, pulled ${data.pulled}`);
      loadTimeline();
    }
  } catch (e) {
    alert('Sync failed: ' + e.message);
  }

  btn.textContent = 'Sync';
  btn.disabled = false;
  loadSyncStatus();
}

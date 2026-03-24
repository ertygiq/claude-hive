// Predefined colors for templates/tasks
const TASK_COLORS = [
  { id: 'slate',   label: 'Slate',   swatch: '#58a6ff' },
  { id: 'emerald', label: 'Emerald', swatch: '#3fb950' },
  { id: 'amber',   label: 'Amber',   swatch: '#d29922' },
  { id: 'rose',    label: 'Rose',    swatch: '#f85149' },
  { id: 'purple',  label: 'Purple',  swatch: '#bc8cff' },
  { id: 'teal',    label: 'Teal',    swatch: '#39d3c3' },
  { id: 'pink',    label: 'Pink',    swatch: '#db61a2' },
  { id: 'orange',  label: 'Orange',  swatch: '#ed9144' },
  { id: 'indigo',  label: 'Indigo',  swatch: '#7978ff' },
  { id: 'cyan',    label: 'Cyan',    swatch: '#76d3ff' },
];

function randomColor() {
  return TASK_COLORS[Math.floor(Math.random() * TASK_COLORS.length)].id;
}

function colorDot(colorId) {
  const c = TASK_COLORS.find(c => c.id === colorId);
  return c ? `<span class="tmpl-color-dot" style="background:${c.swatch}"></span>` : '';
}

// State
let state = { queue: [], workers: [], results: [], stats: {}, paused: false, max_parallel: 4, version: 0 };
let selectedTaskId = null;
let currentDetailTab = 'output';
let detailHeight = 350;
let configCache = null;
let reviewSectionsLocal = [];
let editingReviewSectionId = null;
let pollTimer = null;
let hasLoadedState = false;

// --- Polling ---
function startPolling() {
  poll();
  pollTimer = setInterval(poll, 600);
}

async function poll() {
  let stateChanged = false;
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (!hasLoadedState || data.version !== state.version) {
      state = data;
      hasLoadedState = true;
      stateChanged = true;
    }
  } catch (e) {
    console.error('Poll error:', e);
    return;
  }
  if (!stateChanged) return;
  try {
    render();
  } catch (e) {
    console.error('Render error:', e);
  }
}

// --- Rendering ---
function render() {
  renderStats();
  renderQueue();
  renderWorkers();
  renderResults();
  renderPausedBanner();

  if (selectedTaskId) {
    refreshDetail();
  }
}

function renderStats() {
  document.getElementById('stat-queued').textContent = state.stats.queued || 0;
  document.getElementById('stat-running').textContent = state.stats.running || 0;
  document.getElementById('stat-completed').textContent = state.stats.completed || 0;
  document.getElementById('stat-failed').textContent = (state.stats.failed || 0) + (state.stats.cancelled || 0);
  document.getElementById('worker-count').textContent = `${state.stats.running || 0} / ${state.max_parallel}`;
  document.getElementById('queue-count').textContent = state.stats.queued || 0;
  document.getElementById('results-count').textContent = (state.stats.completed || 0) + (state.stats.failed || 0) + (state.stats.cancelled || 0);

  const btn = document.getElementById('pause-btn');
  if (state.paused) {
    btn.textContent = '▶ Resume';
    btn.classList.add('primary');
  } else {
    btn.textContent = '⏸ Pause';
    btn.classList.remove('primary');
  }
}

function renderPausedBanner() {
  const banner = document.getElementById('paused-banner');
  banner.classList.toggle('visible', state.paused);
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  if (state.queue.length === 0) {
    list.innerHTML = '<div class="empty">No tasks in queue</div>';
    return;
  }
  list.innerHTML = state.queue.map(t => `
    <div class="task-card ${t.id === selectedTaskId ? 'selected' : ''}"
         onclick="selectTask('${t.id}')"
         draggable="true"
         ondragstart="dragStart(event, '${t.id}')"
         ondragover="dragOver(event)"
         ondrop="drop(event, '${t.id}')">
      <div class="label">${colorDot(t.color)}${esc(t.label)}</div>
      <div class="meta">
        <span class="status-badge status-queued">queued</span>
      </div>
      <div class="actions">
        <button class="icon-btn small" onclick="event.stopPropagation();removeTask('${t.id}')" title="Remove">✕</button>
      </div>
    </div>
  `).join('');
}

function renderWorkers() {
  const list = document.getElementById('workers-list');
  if (state.workers.length === 0) {
    list.innerHTML = '<div class="empty">No active workers</div>';
    return;
  }
  list.innerHTML = state.workers.map(t => {
    const elapsed = t.started_at ? formatElapsed(new Date(t.started_at)) : '';
    const tail = t.output_tail || '';
    const lastLines = tail.split('\n').slice(-6).join('\n');
    const statusClass = t.status === 'reviewing' ? 'status-reviewing' : 'status-running';
    const statusText = t.status === 'reviewing' ? 'reviewing' : 'running';
    return `
      <div class="worker-card task-card ${t.id === selectedTaskId ? 'selected' : ''}"
           onclick="selectTask('${t.id}')"
           data-task-id="${t.id}"
           data-started-at="${t.started_at || ''}">
        <div class="worker-header">
          <span class="label">${colorDot(t.color)}${esc(t.label)}</span>
          <span class="elapsed"><span class="pulse"></span> ${elapsed}</span>
        </div>
        <div class="meta" style="margin-bottom:6px">
          <span class="status-badge ${statusClass}">${statusText}</span>
          <span>${formatBytes(t.output_length || 0)} output</span>
        </div>
        <div class="output-preview">${esc(lastLines) || '...'}</div>
        <div class="actions">
          <button class="icon-btn small" onclick="event.stopPropagation();cancelTask('${t.id}')" title="Cancel">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderResults() {
  const list = document.getElementById('results-list');
  const results = state.results || [];
  if (results.length === 0) {
    list.innerHTML = '<div class="empty">No results yet</div>';
    return;
  }

  const sorted = [...results].sort((a, b) => {
    const da = a.completed_at || a.created_at || '';
    const db = b.completed_at || b.created_at || '';
    return db.localeCompare(da);
  });

  let html = '';
  let lastDateLabel = '';
  for (const t of sorted) {
    const dateLabel = resultDateLabel(t.completed_at || t.created_at);
    if (dateLabel !== lastDateLabel) {
      html += `<div class="results-date-header">${dateLabel}</div>`;
      lastDateLabel = dateLabel;
    }
    const icon = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '⊘';
    const statusClass = `status-${t.status}`;
    const duration = t.started_at && t.completed_at
      ? formatDuration(new Date(t.started_at), new Date(t.completed_at))
      : '';
    const summary = (t.status === 'failed' || t.status === 'cancelled') && t.summary
      ? `<div class="result-summary">${esc(t.summary)}</div>`
      : '';
    html += `
      <div class="task-card ${t.id === selectedTaskId ? 'selected' : ''}"
           onclick="selectTask('${t.id}')">
        <div class="label">
          ${colorDot(t.color)}<span class="status-badge ${statusClass}">${icon}</span>
          ${esc(t.label)}
        </div>
        <div class="meta">
          ${duration ? `<span>${duration}</span>` : ''}
          ${t.has_review ? '<span>📋 reviewed</span>' : ''}
          ${t.chat_count > 0 ? `<span>💬 ${t.chat_count}</span>` : ''}
        </div>
        ${summary}
        <div class="actions">
          <button class="icon-btn small" onclick="event.stopPropagation();retryTask('${t.id}')" title="Retry">↻</button>
          <button class="icon-btn small" onclick="event.stopPropagation();deleteResultTask('${t.id}')" title="Delete">✕</button>
        </div>
      </div>
    `;
  }
  list.innerHTML = html;
}

function resultDateLabel(iso) {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today - target) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: now.getFullYear() !== d.getFullYear() ? 'numeric' : undefined });
}

// --- Detail Panel ---
async function selectTask(id) {
  selectedTaskId = id;
  document.getElementById('detail-panel').classList.remove('hidden');
  document.getElementById('resize-handle').style.display = 'block';
  document.getElementById('detail-panel').style.height = detailHeight + 'px';
  await refreshDetail();
  render();
}

async function refreshDetail() {
  if (!selectedTaskId) return;
  try {
    const res = await fetch(`/api/tasks/${selectedTaskId}`);
    if (!res.ok) { closeDetail(); return; }
    const task = await res.json();
    renderDetail(task);
  } catch (e) {
    // silent
  }
}

function renderDetail(task) {
  const label = task.label || '';
  const titleEl = document.getElementById('detail-title');
  titleEl.textContent = label.length > 80 ? label.slice(0, 77) + '...' : label;
  titleEl.title = label;
  const statusEl = document.getElementById('detail-status');
  statusEl.textContent = task.status;
  statusEl.className = `status-badge status-${task.status}`;

  const cancelBtn = document.getElementById('detail-cancel-btn');
  cancelBtn.style.display = ['queued', 'running', 'reviewing'].includes(task.status) ? 'inline-block' : 'none';

  const canChat = ['completed', 'failed'].includes(task.status);
  document.getElementById('chat-area').style.display =
    (currentDetailTab === 'output' && canChat) ? 'flex' : 'none';

  document.querySelectorAll('.detail-tab').forEach(tab => {
    tab.classList.toggle('active', tab.textContent.toLowerCase() === currentDetailTab);
  });

  const body = document.getElementById('detail-body');

  switch (currentDetailTab) {
    case 'output': {
      let html = '';
      const failureDetails = task.failure_details || '';

      if ((task.status === 'failed' || task.status === 'cancelled') && failureDetails) {
        html += `<div class="error-block">
          <div class="section-label">Failure</div>
          <pre class="error-pre">${esc(failureDetails)}</pre>
        </div>`;
        html += `<hr class="section-divider">`;
      }

      const output = task.output || '';
      if (typeof marked !== 'undefined' && output.length > 0) {
        html += `<div class="rendered-output">${renderMarkdownSafely(output)}</div>`;
      } else {
        html += `<pre>${esc(output || 'No output yet...')}</pre>`;
      }

      const reviewEntries = getReviewEntries(task);
      if (reviewEntries.length > 0) {
        html += `<hr class="section-divider"><div class="section-label">Review</div>`;
        html += reviewEntries.map(entry => {
          const promptHtml = `<pre>${esc(entry.prompt || '')}</pre>`;
          const outputHtml = typeof marked !== 'undefined'
            ? `<div class="rendered-output">${renderMarkdownSafely(entry.output || '')}</div>`
            : `<pre>${esc(entry.output || '')}</pre>`;
          return `
            <div class="review-entry">
              <div class="section-label">Prompt</div>
              ${promptHtml}
              <div class="section-label">Response</div>
              ${outputHtml}
            </div>
          `;
        }).join('<hr class="section-divider">');
      } else if (task.review_output) {
        html += `<hr class="section-divider"><div class="section-label">Review</div>`;
        if (typeof marked !== 'undefined') {
          html += `<div class="rendered-output">${renderMarkdownSafely(task.review_output)}</div>`;
        } else {
          html += `<pre>${esc(task.review_output)}</pre>`;
        }
      }

      if (task.chat_history && task.chat_history.length > 0) {
        html += `<hr class="section-divider">`;
        html += task.chat_history.map(m => {
          const isPending = m.status === 'pending';
          const content = (m.role === 'assistant' && typeof marked !== 'undefined')
            ? renderMarkdownSafely(m.content)
            : esc(m.content);
          return `
            <div class="chat-message ${m.role}">
              <div class="chat-role">${m.role}</div>
              <div class="chat-content ${isPending ? 'pending' : ''}">${content}${isPending ? ' (sending...)' : ''}</div>
            </div>
          `;
        }).join('');
      }

      body.innerHTML = html;
      break;
    }

    case 'prompt':
      body.innerHTML = `<pre>${esc(task.prompt)}</pre>`;
      break;

  }
}

function switchDetailTab(tab) {
  currentDetailTab = tab;
  refreshDetail();
}

function closeDetail() {
  selectedTaskId = null;
  currentDetailTab = 'output';
  document.getElementById('detail-panel').classList.add('hidden');
  document.getElementById('resize-handle').style.display = 'none';
  render();
}

// --- Session fullscreen ---
let sessionTaskId = null;
let activeSessionId = null;
const sessionFrames = new Map();

function copySessionId() {
  if (!selectedTaskId) return;
  const task = findTask(selectedTaskId);
  if (!task) return;
  navigator.clipboard.writeText(task.session_id).then(() => {
    const btn = document.getElementById('copy-session-id-btn');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'ID'; }, 1500);
  });
}

function openSession() {
  if (!selectedTaskId) return;
  const task = findTask(selectedTaskId);
  if (!task) return;
  sessionTaskId = selectedTaskId;
  mountSessionFrame(task.session_id);
  // Show chat area pinned at bottom
  const chatArea = document.getElementById('chat-area');
  chatArea.style.display = 'flex';
  chatArea.style.position = 'fixed';
  chatArea.style.bottom = '0';
  chatArea.style.left = '0';
  chatArea.style.right = '0';
  chatArea.style.zIndex = '201';
  chatArea.style.background = 'var(--surface)';
  document.getElementById('session-overlay').classList.remove('hidden');
}

function closeSession() {
  document.getElementById('session-overlay').classList.add('hidden');
  // Restore chat area to normal flow
  const chatArea = document.getElementById('chat-area');
  chatArea.style.position = '';
  chatArea.style.bottom = '';
  chatArea.style.left = '';
  chatArea.style.right = '';
  chatArea.style.zIndex = '';
  chatArea.style.background = '';
  sessionTaskId = null;
}

function mountSessionFrame(sessionId) {
  const host = document.getElementById('session-frame-host');

  if (activeSessionId && sessionFrames.has(activeSessionId)) {
    sessionFrames.get(activeSessionId).style.display = 'none';
  }

  let frame = sessionFrames.get(sessionId);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'session-fullscreen';
    const viewerUrl = configCache ? configCache.session_viewer_url : 'http://localhost:3000';
    frame.src = `${viewerUrl}/#${encodeURIComponent(sessionId)}`;
    frame.dataset.sessionId = sessionId;
    sessionFrames.set(sessionId, frame);
    host.appendChild(frame);
  }

  frame.style.display = 'block';
  activeSessionId = sessionId;
}

function findTask(id) {
  return state.queue.find(t => t.id === id)
    || state.workers.find(t => t.id === id)
    || state.results.find(t => t.id === id);
}

// --- Actions ---
async function togglePause() {
  const endpoint = state.paused ? '/api/control/resume' : '/api/control/pause';
  await fetch(endpoint, { method: 'POST' });
  poll();
}

async function removeTask(id) {
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  if (selectedTaskId === id) closeDetail();
  poll();
}

async function cancelTask(id) {
  if (!id) return;
  if (!await showConfirm('Cancel this task?')) return;
  await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' });
  poll();
}

async function cancelAllTasks() {
  const activeCount = (state.queue?.length || 0) + (state.workers?.length || 0);
  if (activeCount === 0) return;
  if (!await showConfirm('Cancel all queued and running tasks?')) return;
  await fetch('/api/tasks/cancel_all', { method: 'POST' });
  poll();
}

async function retryTask(id) {
  if (!await showConfirm('Retry this task?')) return;
  await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
  poll();
}

async function deleteResultTask(id) {
  if (!await showConfirm('Delete this task result?')) return;
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  if (selectedTaskId === id) closeDetail();
  poll();
}

async function clearCompleted() {
  await fetch('/api/completed/clear', { method: 'POST' });
  if (selectedTaskId) {
    const task = state.results.find(t => t.id === selectedTaskId);
    if (task) closeDetail();
  }
  poll();
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || !selectedTaskId) return;

  input.value = '';
  await fetch(`/api/tasks/${selectedTaskId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  poll();
  setTimeout(poll, 1000);
  setTimeout(poll, 3000);
  setTimeout(poll, 6000);
}

// --- Add Task ---
function openAddTask() {
  document.getElementById('add-label').value = '';
  document.getElementById('add-prompt').value = '';
  document.getElementById('add-task-modal').classList.remove('hidden');
  document.getElementById('add-prompt').focus();
}

async function submitAddTask() {
  const prompt = document.getElementById('add-prompt').value.trim();
  if (!prompt) return;
  const label = document.getElementById('add-label').value.trim();

  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, label: label || null })
  });
  closeModal('add-task-modal');
  poll();
}

// --- Batch Add ---
async function openBatchAdd() {
  await loadConfig();
  const select = document.getElementById('batch-template');
  const templates = configCache?.templates || [];
  if (templates.length === 0) {
    select.innerHTML = '<option value="">No templates - add one in Settings first</option>';
  } else {
    select.innerHTML = templates.map(t =>
      `<option value="${t.id}">${esc(t.name)}</option>`
    ).join('');
  }
  document.getElementById('batch-inputs').value = '';
  document.getElementById('batch-modal').classList.remove('hidden');
}

async function submitBatch() {
  const templateId = document.getElementById('batch-template').value;
  const inputsRaw = document.getElementById('batch-inputs').value.trim();
  if (!templateId || !inputsRaw) return;

  const inputs = inputsRaw.split('\n').map(s => s.trim()).filter(Boolean);
  await fetch('/api/tasks/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_id: templateId, inputs })
  });
  closeModal('batch-modal');
  poll();
}

// --- Settings ---
async function loadConfig() {
  const res = await fetch('/api/config');
  configCache = await res.json();
  reviewSectionsLocal = [...(configCache.review_sections || [])];
}

async function openSettings() {
  await loadConfig();
  document.getElementById('cfg-max-parallel').value = configCache.max_parallel;
  document.getElementById('cfg-agent-cmd').value = configCache.agent_cmd;
  document.getElementById('cfg-agent-args').value = (configCache.agent_args || []).join(' ');
  document.getElementById('cfg-work-dir').value = configCache.work_dir || '';
  document.getElementById('cfg-session-viewer-url').value = configCache.session_viewer_url || 'http://localhost:3000';

  resetReviewSectionForm();
  renderTemplatesList();
  renderReviewSectionsList();

  document.getElementById('settings-modal').classList.remove('hidden');
}

function renderTemplatesList() {
  const list = document.getElementById('templates-list');
  const templates = configCache?.templates || [];
  if (templates.length === 0) {
    list.innerHTML = '<div class="empty">No templates defined</div>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const colorDot = t.color ? `<span class="tmpl-color-dot" style="background:${TASK_COLORS.find(c => c.id === t.color)?.swatch || 'transparent'}"></span>` : '';
    return `
    <div class="template-item">
      <span class="template-name">${colorDot}${esc(t.name)}</span>
      <div>
        <button class="small" onclick="editTemplate('${t.id}')">Edit</button>
        <button class="small danger" onclick="deleteTemplate('${t.id}')">Delete</button>
      </div>
    </div>
  `;
  }).join('');
}

function renderReviewSectionsList() {
  const list = document.getElementById('review-sections-list');
  if (reviewSectionsLocal.length === 0) {
    list.innerHTML = '<div class="empty">No review sections</div>';
    return;
  }
  list.innerHTML = reviewSectionsLocal.map((section, i) => `
    <div class="review-prompt-item">
      <div style="flex:1;min-width:0;font-weight:600">${esc(section.name || `Review ${i + 1}`)}</div>
      <div style="display:flex;gap:4px;align-items:center">
        <button class="small" onclick="editReviewSection(${i})">Edit</button>
        <button class="icon-btn small" onclick="removeReviewSection(${i})">✕</button>
      </div>
    </div>
  `).join('');
}

function saveReviewSection() {
  const nameInput = document.getElementById('new-review-section-name');
  const promptInput = document.getElementById('new-review-section-prompt');
  const name = nameInput.value.trim();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (editingReviewSectionId) {
    reviewSectionsLocal = reviewSectionsLocal.map(section =>
      section.id === editingReviewSectionId
        ? { ...section, name: name || section.name || 'Review', prompt }
        : section
    );
  } else {
    reviewSectionsLocal.push({
      id: crypto.randomUUID(),
      name: name || `Review ${reviewSectionsLocal.length + 1}`,
      prompt
    });
  }
  configCache.review_sections = [...reviewSectionsLocal];

  resetReviewSectionForm();
  renderReviewSectionsList();
}

function editReviewSection(index) {
  const section = reviewSectionsLocal[index];
  if (!section) return;

  editingReviewSectionId = section.id;
  document.getElementById('new-review-section-name').value = section.name || '';
  document.getElementById('new-review-section-prompt').value = section.prompt || '';
  document.getElementById('review-section-save-btn').textContent = 'Save Review Section';
  document.getElementById('review-section-cancel-btn').style.display = 'inline-block';
}

function cancelReviewSectionEdit() {
  resetReviewSectionForm();
}

function resetReviewSectionForm() {
  editingReviewSectionId = null;
  document.getElementById('new-review-section-name').value = '';
  document.getElementById('new-review-section-prompt').value = '';
  document.getElementById('review-section-save-btn').textContent = '+ Add Review Section';
  document.getElementById('review-section-cancel-btn').style.display = 'none';
}

async function removeReviewSection(index) {
  if (!await showConfirm('Delete this review section?')) return;

  const [removed] = reviewSectionsLocal.splice(index, 1);
  if (removed && removed.id === editingReviewSectionId) {
    resetReviewSectionForm();
  }
  if (removed && Array.isArray(configCache?.templates)) {
    configCache.templates = configCache.templates.map(template => ({
      ...template,
      review_section_ids: (template.review_section_ids || []).filter(id => id !== removed.id)
    }));
  }
  configCache.review_sections = [...reviewSectionsLocal];
  renderReviewSectionsList();
}

async function persistSettingsConfig() {
  const args = document.getElementById('cfg-agent-args').value.trim();
  await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      max_parallel: parseInt(document.getElementById('cfg-max-parallel').value, 10),
      agent_cmd: document.getElementById('cfg-agent-cmd').value.trim(),
      agent_args: args ? args.split(/\s+/) : [],
      work_dir: document.getElementById('cfg-work-dir').value.trim() || null,
      session_viewer_url: document.getElementById('cfg-session-viewer-url').value.trim(),
      review_sections: reviewSectionsLocal
    })
  });
}

async function saveSettings() {
  await persistSettingsConfig();
  closeModal('settings-modal');
  await loadConfig();
  poll();
}

// --- Templates ---
let editingTemplateId = null;

let selectedTemplateColor = null;

function renderColorPicker(selectedId) {
  const container = document.getElementById('tmpl-color-picker');
  container.innerHTML = TASK_COLORS.map(c => `
    <button type="button" class="color-swatch ${c.id === selectedId ? 'selected' : ''}"
            style="background:${c.swatch}"
            title="${c.label}"
            onclick="pickColor('${c.id}')"></button>
  `).join('');
  selectedTemplateColor = selectedId;
}

function pickColor(id) {
  selectedTemplateColor = id;
  document.querySelectorAll('#tmpl-color-picker .color-swatch').forEach(el => {
    el.classList.toggle('selected', el.title === TASK_COLORS.find(c => c.id === id)?.label);
  });
}

function addTemplateForm() {
  editingTemplateId = null;
  document.getElementById('template-modal-title').textContent = 'Add Template';
  document.getElementById('tmpl-name').value = '';
  document.getElementById('tmpl-body').value = '';
  document.getElementById('tmpl-work-dir').value = '';
  renderColorPicker(randomColor());
  renderTemplateReviewSections([]);
  document.getElementById('template-modal').classList.remove('hidden');
}

function editTemplate(id) {
  const tmpl = configCache.templates.find(t => t.id === id);
  if (!tmpl) return;
  editingTemplateId = id;
  document.getElementById('template-modal-title').textContent = 'Edit Template';
  document.getElementById('tmpl-name').value = tmpl.name;
  document.getElementById('tmpl-body').value = tmpl.template;
  document.getElementById('tmpl-work-dir').value = tmpl.work_dir || '';
  renderColorPicker(tmpl.color || randomColor());
  renderTemplateReviewSections(tmpl.review_section_ids || []);
  document.getElementById('template-modal').classList.remove('hidden');
}

function renderTemplateReviewSections(selectedIds) {
  const container = document.getElementById('tmpl-review-sections');
  if (reviewSectionsLocal.length === 0) {
    container.innerHTML = '<div class="empty">No review sections available</div>';
    return;
  }

  container.innerHTML = reviewSectionsLocal.map(section => `
    <label class="checkbox-item">
      <input type="checkbox" value="${esc(section.id)}" ${selectedIds.includes(section.id) ? 'checked' : ''}>
      <span>${esc(section.name || section.prompt.substring(0, 80))}</span>
    </label>
  `).join('');
}

async function saveTemplate() {
  const name = document.getElementById('tmpl-name').value.trim();
  const template = document.getElementById('tmpl-body').value;
  if (!name || !template) return;

  const reviewSectionIds = Array.from(document.querySelectorAll('#tmpl-review-sections input:checked'))
    .map(input => input.value);

  await persistSettingsConfig();
  await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: editingTemplateId, name, template, review_section_ids: reviewSectionIds, color: selectedTemplateColor, work_dir: document.getElementById('tmpl-work-dir').value.trim() || null })
  });
  closeModal('template-modal');
  await loadConfig();
  renderTemplatesList();
}

async function deleteTemplate(id) {
  if (!await showConfirm('Delete this template?')) return;

  await fetch(`/api/templates/${id}`, { method: 'DELETE' });
  await loadConfig();
  renderTemplatesList();
}

// --- Drag & Drop ---
let draggedId = null;

function dragStart(e, id) {
  draggedId = id;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function dragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.task-card');
  if (card) card.classList.add('drag-over');
}

function drop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));

  if (!draggedId || draggedId === targetId) return;

  const queueIds = state.queue.map(t => t.id);
  const fromIdx = queueIds.indexOf(draggedId);
  const toIdx = queueIds.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;

  queueIds.splice(fromIdx, 1);
  queueIds.splice(toIdx, 0, draggedId);

  fetch('/api/queue/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: queueIds })
  }).then(() => poll());

  draggedId = null;
}

// --- Resize ---
function initResize() {
  const handle = document.getElementById('resize-handle');
  let startY, startHeight;

  handle.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startHeight = detailHeight;
    const onMove = (event) => {
      detailHeight = Math.max(150, Math.min(600, startHeight + (startY - event.clientY)));
      document.getElementById('detail-panel').style.height = `${detailHeight}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// --- Confirm modal ---
let confirmResolve = null;

function showConfirm(message) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').classList.remove('hidden');
  });
}

function resolveConfirm(value) {
  document.getElementById('confirm-modal').classList.add('hidden');
  if (confirmResolve) {
    confirmResolve(value);
    confirmResolve = null;
  }
}

// --- Modal helpers ---
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    if (e.target.id === 'confirm-modal') {
      resolveConfirm(false);
    } else {
      e.target.classList.add('hidden');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (sessionTaskId) {
      closeSession();
      return;
    }
    if (confirmResolve) {
      resolveConfirm(false);
      return;
    }
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    if (selectedTaskId && !document.querySelector('.modal-overlay:not(.hidden)')) {
      closeDetail();
    }
  }
});

// --- Utility ---
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Task output is untrusted model/log text. Escape raw HTML before parsing so tags
// like "<main>" stay literal text, then strip bare-URL autolinks that Marked adds
// for plain hostnames while keeping normal markdown links intact.
function renderMarkdownSafely(source) {
  return stripAutoLinks(marked.parse(
    source
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  ));
}

function stripAutoLinks(html) {
  const template = document.createElement('template');
  template.innerHTML = html;

  template.content.querySelectorAll('a[href]').forEach(link => {
    const text = (link.textContent || '').trim();
    const href = (link.getAttribute('href') || '').trim();
    const normalizedHref = href.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const normalizedText = text.replace(/\/$/, '');

    if (normalizedText === normalizedHref) {
      link.replaceWith(document.createTextNode(text));
    }
  });

  return template.innerHTML;
}

function formatElapsed(start) {
  const secs = Math.floor((Date.now() - start.getTime()) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(start, end) {
  const secs = Math.floor((end.getTime() - start.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getReviewEntries(task) {
  if (Array.isArray(task.review_entries) && task.review_entries.length > 0) {
    return task.review_entries;
  }

  if (task.review_output && Array.isArray(task.review_prompts) && task.review_prompts.length === 1) {
    return [{
      prompt: task.review_prompts[0],
      output: stripLegacyReviewHeading(task.review_output)
    }];
  }

  return [];
}

function stripLegacyReviewHeading(reviewOutput) {
  return reviewOutput
    .replace(/^\*\*.*?\*\*\s*/s, '')
    .replace(/^\s*---\s*/m, '')
    .trim();
}

function updateWorkerElapsedTimes() {
  document.querySelectorAll('.worker-card[data-started-at]').forEach(card => {
    const startedAt = card.dataset.startedAt;
    if (!startedAt) return;
    const elapsedEl = card.querySelector('.elapsed');
    if (!elapsedEl) return;
    elapsedEl.innerHTML = `<span class="pulse"></span> ${formatElapsed(new Date(startedAt))}`;
  });
}

setInterval(() => {
  if (state.workers.length > 0) updateWorkerElapsedTimes();
  if (selectedTaskId && state.workers.some(w => w.id === selectedTaskId)) refreshDetail();
}, 2000);

// --- Init ---
initResize();
loadConfig().catch(() => {});
startPolling();

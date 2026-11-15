const invoke = window.__TAURI__.core.invoke;
const get = id => document.getElementById(id);
let activeRoot = '';
let state = { installed: false, online: false, projects: [], goals: [] };
let working = false;

function show(message, error = false) {
  const notice = get('notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = !message;
}

function updateWorkspace() {
  const selected = state.projects.find(item => item.project === get('project').value);
  get('workspace').textContent = selected ? selected.workspace + ' · ' + selected.orchestrator : '';
  get('submit').disabled = working || !state.online || !selected;
}

function render() {
  const selection = get('project').value || localStorage.getItem('project');
  get('project').replaceChildren(...state.projects.map(item => new Option(item.project, item.project)));
  if (state.projects.some(item => item.project === selection)) get('project').value = selection;
  get('connection').textContent = state.online ? 'Bridge running' : state.installed ? 'Bridge stopped' : 'Bridge setup needed';
  get('connection').classList.toggle('online', state.online);
  const history = state.goals.map(goal => {
    const item = document.createElement('li');
    item.textContent = goal.summary;
    const meta = document.createElement('span');
    meta.textContent = goal.project + ' · ' + goal.status;
    item.append(meta);
    return item;
  });
  get('history').replaceChildren(...history);
  if (!history.length) get('history').textContent = 'No goals yet.';
  get('provider').value = state.model?.providerID || '';
  get('model').value = state.model?.modelID || '';
  get('model-form').hidden = !state.installed;
  get('install').disabled = working || state.installed;
  get('start').disabled = working || !state.installed;
  get('start').textContent = state.online ? 'Restart bridge' : 'Start bridge';
  get('project-form').querySelector('button').disabled = working || !state.online;
  updateWorkspace();
}

const action = (name, input = {}, root = activeRoot) => invoke('bridge_action', { action: name, root, input });

async function perform(operation, progress) {
  if (working) return;
  working = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  if (progress) show(progress);
  try { await operation(); }
  catch (error) { show(String(error), true); }
  finally {
    working = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    render();
  }
}

async function selectRoot(root) {
  const next = await action('status', {}, root);
  activeRoot = root;
  state = next;
  get('root').value = root;
  localStorage.setItem('bridge-root', root);
  if (!state.installed || !state.online) get('installation').open = true;
  if (state.online && !state.projects.length) get('project-setup').open = true;
}

get('refresh').onclick = () => perform(async () => { await selectRoot(activeRoot); show(''); }, 'Refreshing…');
get('use-root').onclick = () => perform(async () => {
  await selectRoot(get('root').value.trim());
  show(state.installed ? 'Installation selected.' : 'Choose Install bridge to set up this folder.');
}, 'Checking installation…');
get('install').onclick = () => perform(async () => {
  state = await action('install');
  show('Bridge installed. Enter your OpenCode model, then start the bridge.');
}, 'Installing the bridge and its dependencies…');
get('start').onclick = () => perform(async () => {
  const restart = state.online;
  if (restart && !window.confirm('Restart the local bridge and OpenCode server? This is available when Kanzo work is idle.')) {
    show('');
    return;
  }
  state = await action(restart ? 'restart' : 'start');
  if (!state.projects.length) get('project-setup').open = true;
  show(restart ? 'Bridge restarted.' : 'Bridge started.');
}, 'Checking bridge…');
get('model-form').onsubmit = event => {
  event.preventDefault();
  void perform(async () => {
    state = await action('configure', { providerID: get('provider').value, modelID: get('model').value });
    show(state.online ? 'Model saved. It will take effect the next time the bridge starts.' : 'Model saved.');
  });
};
get('project-form').onsubmit = event => {
  event.preventDefault();
  void perform(async () => {
    const project = get('slug').value;
    await action('register', { project, workspace: get('folder').value.trim(), agent: get('agent').value });
    localStorage.setItem('project', project);
    get('project').value = '';
    state = await action('status');
    show('Project registered.');
  }, 'Registering project…');
};
get('project').onchange = () => {
  localStorage.setItem('project', get('project').value);
  updateWorkspace();
};
get('goal-form').onsubmit = event => {
  event.preventDefault();
  void perform(async () => {
    const project = get('project').value;
    const goal = get('goal').value.trim();
    if (!goal) throw new Error('Enter a goal.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([activeRoot, project, goal])));
    const key = 'pending-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const request_id = localStorage.getItem(key) || 'desktop-' + crypto.randomUUID();
    localStorage.setItem(key, request_id);
    await action('submit', { project, goal, request_id });
    localStorage.removeItem(key);
    get('goal').value = '';
    show('Goal submitted. The orchestrator will publish its cards in Kanzo.');
    try { state = await action('status'); } catch { /* Submission already succeeded. */ }
  }, 'Submitting goal…');
};

void perform(async () => {
  const root = localStorage.getItem('bridge-root') || await invoke('default_installation');
  get('root').value = root;
  await selectRoot(root);
  show('');
}, 'Checking bridge…');

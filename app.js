/**
 * ============================================================
 * MINIMAL FINANCE — FRONTEND COMPLETO CON OPTIMISTIC UI (app.js)
 * Motor Diario (Vista Micro) + Proyección Mensual (Vista Macro)
 * ============================================================
 */

// ============================================================
// CONFIGURACIÓN DE CONEXIÓN AL BACKEND
// ============================================================
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbykPEqiNLj1G1N5tNQSF5WqfuPP-t1kttxX57X5lXQwy9eX5wZ952NEb5T_Ylaa3hEs/exec';

// ============================================================
// ESTADO GLOBAL Y SINCRONIZACIÓN EN SEGUNDO PLANO
// ============================================================

const appState = {
  activeUser: 'Brian',
  currentView: 'micro',
  homeBankingTotal: 0,
  bolsaTotal: 0,
  diaCobro: null,
  diasRestantes: [],
  movimientos: [],
  lastProcessedDate: null,

  // Estado para la Proyección Mensual (Macro) — Inicia en Septiembre 2026
  currentMacroYear: 2026,
  currentMacroMonth: 8,
  macroData: null
};

let txModalSubtype = 'single';
let editingMovimientoId = null;
let cierreDiaPendiente = null;
let limpiarColaCandidatos = [];

let hbModalState = { hb: 0, objetivo: 0, bolsa: 0, diasCount: 0, lastEdited: 'objetivo' };

// Borrador local para el modal Sueldos y Servicios (Macro Config)
let macroDraft = null;

// Variables temporales para modales de edición Macro
let currentEditingValueTarget = null;
let currentEditingServiceId = null;
let currentEditingFixedExpenseId = null;
let currentEditingFixedExpenseUser = 'Brian';

let pendingSyncCount = 0;

// ============================================================
// CLIENTE DE API (Apps Script) & BACKGROUND SYNC
// ============================================================

async function fetchWithRetry(url, options, maxRetries = 3, timeoutMs = 35000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const opts = Object.assign({}, options, { signal: controller.signal });
      const res = await fetch(url, opts);
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP Error ' + res.status);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= maxRetries) throw err;
      const delay = Math.pow(2, attempt - 1) * 600;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callBackend(action, payload) {
  const res = await fetchWithRetry(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload || {} })
  }, 3, 35000);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || ('Error en ' + action));
  return json.data;
}

async function callBackendConSync(action, payload) {
  mostrarSyncToast_();
  try {
    return await callBackend(action, payload);
  } finally {
    ocultarSyncToast_();
  }
}

const PENDING_SYNC_QUEUE_KEY = 'pending_sync_queue';
let isProcessingSyncQueue_ = false;

function getPendingSyncQueue_() {
  try {
    const raw = localStorage.getItem(PENDING_SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error leyendo pending_sync_queue:', e);
    return [];
  }
}

function savePendingSyncQueue_(queue) {
  try {
    if (!queue || !queue.length) {
      localStorage.removeItem(PENDING_SYNC_QUEUE_KEY);
    } else {
      localStorage.setItem(PENDING_SYNC_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch (e) {
    console.error('Error guardando pending_sync_queue:', e);
  }
}

function enqueuePendingSync_(action, payload) {
  const queue = getPendingSyncQueue_();
  queue.push({
    id: 'sync_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    action: action,
    payload: payload,
    timestamp: Date.now()
  });
  savePendingSyncQueue_(queue);
}

function isNetworkOrTimeoutError_(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err) return true;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('network') ||
         msg.includes('fetch') ||
         msg.includes('failed to fetch') ||
         msg.includes('timeout') ||
         msg.includes('abort') ||
         msg.includes('offline') ||
         msg.includes('conexión') ||
         msg.includes('internet') ||
         msg.includes('load failed') ||
         msg.includes('http error 502') ||
         msg.includes('http error 503') ||
         msg.includes('http error 504');
}

async function processPendingSyncQueue_() {
  if (isProcessingSyncQueue_) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const queue = getPendingSyncQueue_();
  if (!queue.length) return;

  isProcessingSyncQueue_ = true;
  mostrarSyncToast_();
  try {
    while (queue.length > 0) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      const item = queue[0];
      try {
        await callBackend(item.action, item.payload);
        queue.shift();
        savePendingSyncQueue_(queue);
      } catch (err) {
        console.error('Error procesando ítem de cola pendiente:', item, err);
        if (isNetworkOrTimeoutError_(err)) {
          // Conexión inestable: preservar cola y esperar al próximo reintento/online
          break;
        } else {
          // Error fatal en datos de la petición: descartar para evitar bloqueo permanente
          queue.shift();
          savePendingSyncQueue_(queue);
        }
      }
    }
    if (queue.length === 0) {
      showAppToast('Sincronización pendiente completada');
    }
  } finally {
    isProcessingSyncQueue_ = false;
    ocultarSyncToast_();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('Conexión reestablecida. Procesando cola de sincronización pendiente...');
    processPendingSyncQueue_();
  });
}

async function callBackendBackground(action, payload) {
  const queue = getPendingSyncQueue_();
  // Si ya hay operaciones pendientes o estamos sin conexión, encolar para garantizar orden FIFO
  if ((typeof navigator !== 'undefined' && navigator.onLine === false) || queue.length > 0) {
    enqueuePendingSync_(action, payload);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showAppToast('Sin conexión: acción guardada para sincronizar al volver en línea');
    } else {
      processPendingSyncQueue_();
    }
    return null;
  }

  pendingSyncCount++;
  mostrarSyncToast_();
  try {
    const res = await callBackend(action, payload);
    return res;
  } catch (err) {
    console.error('Error en sync background (' + action + '):', err);
    if (isNetworkOrTimeoutError_(err)) {
      enqueuePendingSync_(action, payload);
      showAppToast('Fallo de red: acción guardada en cola para reintentar', true);
      return null;
    }
    showAppToast('Error de sincronización: ' + (err.message || 'Fallo de red'), true);
    throw err;
  } finally {
    pendingSyncCount--;
    if (pendingSyncCount <= 0) {
      pendingSyncCount = 0;
      ocultarSyncToast_();
    }
  }
}

function showAppToast(message, isError = false) {
  const toast = document.getElementById('exit-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.backgroundColor = isError ? 'rgba(185, 28, 28, 0.95)' : 'rgba(39, 39, 42, 0.95)';
  toast.classList.add('active');
  clearTimeout(toast._appTimer);
  toast._appTimer = setTimeout(() => {
    toast.classList.remove('active');
    setTimeout(() => {
      if (toast) toast.style.backgroundColor = '';
    }, 300);
  }, 3500);
}

function mostrarSyncToast_() {
  const el = document.getElementById('sync-toast');
  if (el) el.classList.add('active');
}

function ocultarSyncToast_() {
  if (pendingSyncCount > 0) return;
  const el = document.getElementById('sync-toast');
  if (el) el.classList.remove('active');
}

// ============================================================
// FORMATEADOR DE MONEDA Y MANEJO DE INPUTS
// ============================================================

const moneyStates = {};

function formatMoneyParts(rawInt, rawDec, isDec) {
  const cleanInt = (rawInt || '').replace(/\D/g, '');
  const cleanDec = (rawDec || '').replace(/\D/g, '').slice(0, 2);

  if (!cleanInt && !isDec) {
    return '';
  }

  const displayInt = cleanInt.replace(/^0+(?=\d)/, '') || '0';
  const formattedInt = displayInt.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  if (isDec) {
    return formattedInt + ',' + cleanDec;
  }
  return formattedInt;
}

function parseMoneyString(str) {
  let isDec = false;
  let intStr = '';
  let decStr = '';

  const commaIndex = str.indexOf(',');
  if (commaIndex !== -1) {
    isDec = true;
    intStr = str.slice(0, commaIndex).replace(/\D/g, '');
    decStr = str.slice(commaIndex + 1).replace(/\D/g, '').slice(0, 2);
  } else {
    intStr = str.replace(/\D/g, '');
  }

  intStr = intStr.replace(/^0+(?=\d)/, '');
  return { int: intStr, dec: decStr, isDec };
}

function countRawBeforeCursor(formattedStr, pos) {
  let intCount = 0;
  let decCount = 0;
  let passedComma = false;
  const limit = Math.min(pos, formattedStr.length);
  for (let i = 0; i < limit; i++) {
    const ch = formattedStr[i];
    if (ch === ',') {
      passedComma = true;
    } else if (ch >= '0' && ch <= '9') {
      if (!passedComma) intCount++;
      else decCount++;
    }
  }
  return { intCount, passedComma, decCount };
}

function findCursorPosInFormatted(formattedStr, { intCount, passedComma, decCount }) {
  let currentInt = 0;
  let currentDec = 0;
  let foundComma = false;

  if (intCount === 0 && !passedComma && decCount === 0) {
    return 0;
  }

  for (let i = 0; i < formattedStr.length; i++) {
    const ch = formattedStr[i];
    if (ch === ',') {
      if (!passedComma && currentInt >= intCount) {
        return i;
      }
      foundComma = true;
      if (passedComma && decCount === 0) {
        return i + 1;
      }
    } else if (ch >= '0' && ch <= '9') {
      if (!foundComma) {
        currentInt++;
        if (!passedComma && currentInt >= intCount) {
          return i + 1;
        }
      } else {
        currentDec++;
        if (currentDec >= decCount) {
          return i + 1;
        }
      }
    }
  }
  return formattedStr.length;
}

function renderMoneyInput(id, targetCursorPos) {
  const el = document.getElementById(id);
  const st = moneyStates[id];
  if (!el || !st) return;

  const formatted = formatMoneyParts(st.int, st.dec, st.isDec);
  el.value = formatted;

  if (typeof targetCursorPos === 'number') {
    try {
      el.setSelectionRange(targetCursorPos, targetCursorPos);
    } catch (e) {}
  }
}

function getMoneyValue(id) {
  const st = moneyStates[id];
  if (!st) return 0;
  const intPart = (st.int || '0').replace(/^0+/, '') || '0';
  const decPart = (st.dec || '').padEnd(2, '0').slice(0, 2);
  return parseFloat(intPart + '.' + decPart) || 0;
}

function setMoneyValue(id, num) {
  if (!moneyStates[id]) moneyStates[id] = { int: '', dec: '', isDec: false, onChange: null };
  const n = Number(num);
  if (isNaN(n) || (num === '' || num === null || num === undefined)) {
    moneyStates[id].int = '';
    moneyStates[id].dec = '';
    moneyStates[id].isDec = false;
  } else {
    const totalStr = Math.max(n || 0, 0).toFixed(2);
    const parts = totalStr.split('.');
    moneyStates[id].int = parts[0];
    moneyStates[id].dec = parts[1];
    moneyStates[id].isDec = true;
  }
  renderMoneyInput(id);
}

function applyMoneyEdit(el, id, type, inputData) {
  const st = moneyStates[id];
  if (!st) return;

  const val = el.value || '';
  const selStart = (typeof el.selectionStart === 'number') ? el.selectionStart : val.length;
  const selEnd = (typeof el.selectionEnd === 'number') ? el.selectionEnd : val.length;
  const isRange = selStart !== selEnd;
  const isAll = isRange && selStart === 0 && selEnd === val.length;

  let newInt = st.int;
  let newDec = st.dec;
  let newIsDec = st.isDec;
  let targetRawCounts = countRawBeforeCursor(val, selStart);

  if (type === 'deleteBackward') {
    if (isAll) {
      newInt = '';
      newDec = '';
      newIsDec = false;
      targetRawCounts = { intCount: 0, passedComma: false, decCount: 0 };
    } else if (isRange) {
      const beforeStr = val.slice(0, selStart);
      const afterStr = val.slice(selEnd);
      const parsed = parseMoneyString(beforeStr + afterStr);
      newInt = parsed.int;
      newDec = parsed.dec;
      newIsDec = parsed.isDec;
      targetRawCounts = countRawBeforeCursor(val, selStart);
    } else {
      if (selStart === 0) return;
      const charBefore = val[selStart - 1];

      if (charBefore === '.') {
        const delPos = selStart - 2;
        if (delPos >= 0) {
          const beforeStr = val.slice(0, delPos);
          const afterStr = val.slice(selStart);
          const parsed = parseMoneyString(beforeStr + afterStr);
          newInt = parsed.int;
          newDec = parsed.dec;
          newIsDec = parsed.isDec;
          const prev = countRawBeforeCursor(val, selStart);
          targetRawCounts = {
            intCount: Math.max(0, prev.intCount - 1),
            passedComma: prev.passedComma,
            decCount: prev.decCount
          };
        }
      } else if (charBefore === ',') {
        const beforeStr = val.slice(0, selStart - 1);
        const parsed = parseMoneyString(beforeStr);
        newInt = parsed.int;
        newDec = '';
        newIsDec = false;
        const prev = countRawBeforeCursor(val, selStart - 1);
        targetRawCounts = {
          intCount: prev.intCount,
          passedComma: false,
          decCount: 0
        };
      } else {
        const beforeStr = val.slice(0, selStart - 1);
        const afterStr = val.slice(selStart);
        const parsed = parseMoneyString(beforeStr + afterStr);
        newInt = parsed.int;
        newDec = parsed.dec;
        newIsDec = parsed.isDec;
        const prev = countRawBeforeCursor(val, selStart);
        if (prev.passedComma) {
          targetRawCounts = {
            intCount: prev.intCount,
            passedComma: true,
            decCount: Math.max(0, prev.decCount - 1)
          };
        } else {
          targetRawCounts = {
            intCount: Math.max(0, prev.intCount - 1),
            passedComma: false,
            decCount: 0
          };
        }
      }
    }
  } else if (type === 'deleteForward') {
    if (isAll) {
      newInt = '';
      newDec = '';
      newIsDec = false;
      targetRawCounts = { intCount: 0, passedComma: false, decCount: 0 };
    } else if (isRange) {
      const beforeStr = val.slice(0, selStart);
      const afterStr = val.slice(selEnd);
      const parsed = parseMoneyString(beforeStr + afterStr);
      newInt = parsed.int;
      newDec = parsed.dec;
      newIsDec = parsed.isDec;
      targetRawCounts = countRawBeforeCursor(val, selStart);
    } else {
      if (selStart >= val.length) return;
      const charAt = val[selStart];
      let delStart = selStart;
      let delEnd = selStart + 1;
      if (charAt === '.' || charAt === ',') {
        delStart = selStart;
        delEnd = Math.min(val.length, selStart + 2);
      }
      const beforeStr = val.slice(0, delStart);
      const afterStr = val.slice(delEnd);
      const parsed = parseMoneyString(beforeStr + afterStr);
      newInt = parsed.int;
      newDec = parsed.dec;
      newIsDec = parsed.isDec;
      targetRawCounts = countRawBeforeCursor(val, selStart);
    }
  } else if (type === 'insert') {
    const inputStr = String(inputData || '');
    for (const ch of inputStr) {
      if (ch === ',' || ch === '.') {
        if (isAll) {
          newInt = '0';
          newDec = '';
          newIsDec = true;
          targetRawCounts = { intCount: 1, passedComma: true, decCount: 0 };
        } else {
          const commaIdx = val.indexOf(',');
          if (commaIdx !== -1) {
            targetRawCounts = {
              intCount: countRawBeforeCursor(val, commaIdx).intCount,
              passedComma: true,
              decCount: 0
            };
          } else {
            const beforeStr = val.slice(0, selStart);
            const afterStr = val.slice(selEnd);
            const parsed = parseMoneyString(beforeStr + ',' + afterStr);
            newInt = parsed.int || '0';
            newDec = parsed.dec;
            newIsDec = true;
            const prev = countRawBeforeCursor(beforeStr, beforeStr.length);
            targetRawCounts = {
              intCount: prev.intCount || 1,
              passedComma: true,
              decCount: 0
            };
          }
        }
      } else if (/^[0-9]$/.test(ch)) {
        if (isAll) {
          newInt = ch;
          newDec = '';
          newIsDec = false;
          targetRawCounts = { intCount: 1, passedComma: false, decCount: 0 };
        } else {
          const beforeStr = val.slice(0, selStart);
          const afterStr = val.slice(selEnd);
          const commaIdx = val.indexOf(',');
          const isInsertingIntoDec = (commaIdx !== -1 && selStart > commaIdx);

          if (isInsertingIntoDec) {
            const currentDecDigits = (commaIdx !== -1 ? val.slice(commaIdx + 1) : '').replace(/\D/g, '');
            if (currentDecDigits.length >= 2 && !isRange) {
              continue;
            }
          } else {
            const currentIntDigits = (commaIdx !== -1 ? val.slice(0, commaIdx) : val).replace(/\D/g, '');
            if (currentIntDigits.length >= 11 && !isRange) {
              continue;
            }
          }

          const combined = beforeStr + ch + afterStr;
          const parsed = parseMoneyString(combined);
          newInt = parsed.int;
          newDec = parsed.dec;
          newIsDec = parsed.isDec || (commaIdx !== -1);

          const prev = countRawBeforeCursor(val, selStart);
          if (prev.passedComma || isInsertingIntoDec) {
            targetRawCounts = {
              intCount: prev.intCount,
              passedComma: true,
              decCount: prev.decCount + 1
            };
          } else {
            targetRawCounts = {
              intCount: prev.intCount + 1,
              passedComma: false,
              decCount: 0
            };
          }
        }
      }
    }
  }

  st.int = newInt;
  st.dec = newDec;
  st.isDec = newIsDec;

  const newFormatted = formatMoneyParts(st.int, st.dec, st.isDec);
  const newPos = findCursorPosInFormatted(newFormatted, targetRawCounts);

  renderMoneyInput(id, newPos);
  if (st.onChange) st.onChange(id);
}

function attachMoneyInput(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!moneyStates[id]) moneyStates[id] = { int: '', dec: '', isDec: false, onChange: null };
  moneyStates[id].onChange = onChange;

  if (el.dataset.moneyAttached === 'true') return;
  el.dataset.moneyAttached = 'true';

  let isFirstFocus = false;
  let focusTimestamp = 0;

  el.addEventListener('focus', () => {
    isFirstFocus = true;
    focusTimestamp = Date.now();
    setTimeout(() => {
      if (document.activeElement === el) {
        try {
          if (el.select) el.select();
          if (typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(0, el.value.length);
          }
        } catch (err) {}
      }
    }, 25);
  });

  el.addEventListener('mouseup', (e) => {
    if (isFirstFocus && (Date.now() - focusTimestamp < 300)) {
      e.preventDefault();
    }
    isFirstFocus = false;
  });

  el.addEventListener('touchend', () => {
    if (isFirstFocus && (Date.now() - focusTimestamp < 300)) {
      // Retener selección inicial en móvil
    }
    setTimeout(() => {
      isFirstFocus = false;
    }, 150);
  });

  el.addEventListener('blur', () => {
    isFirstFocus = false;
    focusTimestamp = 0;
  });

  el.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      applyMoneyEdit(el, id, 'deleteBackward');
      return;
    }
    if (e.inputType === 'deleteContentForward') {
      e.preventDefault();
      applyMoneyEdit(el, id, 'deleteForward');
      return;
    }
    if (e.inputType === 'deleteByCut') {
      e.preventDefault();
      applyMoneyEdit(el, id, 'deleteBackward');
      return;
    }
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
      if (e.data) {
        e.preventDefault();
        applyMoneyEdit(el, id, 'insert', e.data);
      }
      return;
    }
  });

  el.addEventListener('paste', (e) => {
    e.preventDefault();
    const pastedText = (e.clipboardData || window.clipboardData).getData('text') || '';
    applyMoneyEdit(el, id, 'insert', pastedText);
  });
}

// ============================================================
// UTILIDADES DE FECHA Y FORMATO
// ============================================================

function aBooleano_(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1';
  }
  return !!v;
}

function normalizarFechas_(fechas) {
  if (Array.isArray(fechas)) return fechas;
  if (typeof fechas === 'string') {
    try {
      const parsed = JSON.parse(fechas);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { }
    if (fechas.trim()) return [fechas.trim()];
  }
  return [];
}

function formatearMoneda_(n) {
  const num = Number(n) || 0;
  return '$ ' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatearFechaISOLocal_(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function hoyISO_() {
  return formatearFechaISOLocal_(new Date());
}

function sumarDiasLocal_(fecha, dias) {
  const f = new Date(fecha.getTime());
  f.setDate(f.getDate() + dias);
  return f;
}

function formatearFechaLegible_(iso) {
  if (!iso) return '--';
  const partes = iso.split('-').map(Number);
  const f = new Date(partes[0], partes[1] - 1, partes[2]);
  return f.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
}

function capitalizeInput(el) {
  if (el.value.length === 1) el.value = el.value.toUpperCase();
}

function handleOverlayClick(event) {
  if (event.target === event.currentTarget) {
    closeAllActiveModalsWithoutSaving_();
  }
}

// ============================================================
// HEADER, NAVEGACIÓN Y DOCK FLOTANTE
// ============================================================

function cargarUsuarioYColorLocal_() {
  appState.activeUser = localStorage.getItem('userActive') || 'Brian';
  pintarBotonesUsuario_();
}

function pintarBotonesUsuario_() {
  const brianBtn = document.getElementById('user-btn-brian');
  const virginiaBtn = document.getElementById('user-btn-virginia');
  if (!brianBtn || !virginiaBtn) return;

  if (appState.activeUser === 'Brian') {
    brianBtn.classList.add('active');
    virginiaBtn.classList.remove('active');
  } else {
    virginiaBtn.classList.add('active');
    brianBtn.classList.remove('active');
  }

  const modalUserLabel = document.getElementById('modal-user-label');
  if (modalUserLabel) modalUserLabel.textContent = appState.activeUser === 'Brian' ? 'B' : 'V';
  const fixedUserLabel = document.getElementById('fixed-user-label');
  if (fixedUserLabel) fixedUserLabel.textContent = appState.activeUser;
}

function setActiveUser(user) {
  // Destrucción obligatoria de formularios temporales (Zero-Draft Persistence)
  if (typeof resetTxForm_ === 'function') resetTxForm_();
  if (typeof resetFixedExpenseForm_ === 'function') resetFixedExpenseForm_();
  if (typeof resetServiceForm_ === 'function') resetServiceForm_();

  appState.activeUser = user;
  localStorage.setItem('userActive', user);
  pintarBotonesUsuario_();

  if (appState.currentView === 'micro') {
    renderMicroView();
  } else {
    renderMacroView();
  }
}

async function setAccent(color) {
  localStorage.setItem('accentColor_' + appState.activeUser, color);
}

let lastHeaderToggleTime_ = 0;
function toggleMainView(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const now = Date.now();
  if (now - lastHeaderToggleTime_ < 250) return;
  lastHeaderToggleTime_ = now;
  switchView(appState.currentView === 'micro' ? 'macro' : 'micro');
}

function switchView(view, pushHistory = true) {
  // Destrucción obligatoria de estado temporal al conmutar vistas (Zero-Draft Persistence)
  if (typeof resetTxForm_ === 'function') resetTxForm_();
  if (typeof resetFixedExpenseForm_ === 'function') resetFixedExpenseForm_();
  if (typeof resetServiceForm_ === 'function') resetServiceForm_();

  const prevView = appState.currentView;
  appState.currentView = view;
  const viewMicro = document.getElementById('view-micro');
  const viewMacro = document.getElementById('view-macro');
  const mainHeader = document.getElementById('main-header');
  const navTitleText = document.getElementById('nav-title-text');
  const navDynamicTitle = document.getElementById('nav-header-title-btn') || document.getElementById('nav-dynamic-title');
  const syncLabel = document.getElementById('header-sync-label');

  // Reset de Scroll al inicio de la pantalla (0, 0)
  window.scrollTo(0, 0);
  if (document.body) document.body.scrollTop = 0;
  if (document.documentElement) document.documentElement.scrollTop = 0;
  const viewport = document.getElementById('app-viewport');
  if (viewport) viewport.scrollTop = 0;

  if (view === 'micro') {
    // 1. Reset obligatorio de subvistas en Módulo Diario:
    const microSubviews = ['micro-panel-add', 'hb-modal', 'budget-audit-modal', 'future-days-modal'];
    microSubviews.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('hidden');
        el.classList.remove('flex', 'active');
      }
    });
    const microDash = document.getElementById('micro-dashboard-view');
    if (microDash) microDash.classList.remove('hidden');
    if (typeof setMicroSubView === 'function') {
      setMicroSubView('list', false);
    }

    if (navTitleText) {
      navTitleText.textContent = 'Diario';
      navTitleText.className = 'text-3xl font-bold tracking-tight select-none text-[#536460]';
    }
    if (navDynamicTitle) {
      navDynamicTitle.className = 'header-title-btn-expanded';
    }
    if (mainHeader) {
      mainHeader.className = 'w-full px-6 pt-7 pb-4 flex justify-between items-center transition-colors duration-300 view-micro-header bg-white';
    }
    if (syncLabel) {
      syncLabel.className = 'text-[10px] font-bold text-[#8e9b98] mt-1 tracking-tight select-none';
    }

    if (viewMacro && prevView !== 'micro') {
      viewMacro.style.opacity = '0';
      viewMacro.style.transform = 'translateY(8px)';
      setTimeout(() => {
        viewMacro.classList.add('hidden');
        if (viewMicro) {
          viewMicro.classList.remove('hidden');
          viewMicro.style.opacity = '0';
          viewMicro.style.transform = 'translateY(8px)';
          requestAnimationFrame(() => {
            viewMicro.style.opacity = '1';
            viewMicro.style.transform = 'translateY(0)';
            window.scrollTo(0, 0);
            if (document.body) document.body.scrollTop = 0;
            if (document.documentElement) document.documentElement.scrollTop = 0;
            if (viewport) viewport.scrollTop = 0;
          });
        }
      }, 150);
    } else if (viewMicro) {
      viewMicro.classList.remove('hidden');
      viewMicro.style.opacity = '1';
      viewMicro.style.transform = 'translateY(0)';
    }

    renderMicroView();
  } else {
    // Reestablece la fecha seleccionada en appState a la fecha actual real del sistema
    const now = new Date();
    appState.currentMacroYear = now.getFullYear();
    appState.currentMacroMonth = now.getMonth();

    // 1. Reset obligatorio de subvistas en Módulo Mensual:
    const macroSubviews = ['fixed-expense-modal', 'macro-config-modal', 'salary-adjust-modal', 'service-edit-modal', 'value-edit-modal'];
    macroSubviews.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('hidden');
        el.classList.remove('flex', 'active');
      }
    });
    const macroDash = document.getElementById('macro-dashboard-view');
    if (macroDash) macroDash.classList.remove('hidden');
    const fabMenu = document.getElementById('macro-fab-menu');
    if (fabMenu) fabMenu.classList.add('hidden');
    const fabBackdrop = document.getElementById('macro-fab-backdrop');
    if (fabBackdrop) fabBackdrop.classList.add('hidden');

    if (typeof setMacroSubTab === 'function') {
      setMacroSubTab('resumen', false);
    }
    if (typeof setResumenInnerTab === 'function') {
      setResumenInnerTab('incomes', false);
    }
    if (typeof setBrianInnerTab === 'function') {
      setBrianInnerTab('list', false);
    }
    if (typeof setVirginiaInnerTab === 'function') {
      setVirginiaInnerTab('list', false);
    }

    if (navTitleText) {
      navTitleText.textContent = 'Mensual';
      navTitleText.className = 'text-3xl font-bold tracking-tight select-none text-white';
    }
    if (navDynamicTitle) {
      navDynamicTitle.className = 'header-title-btn-expanded';
    }
    if (mainHeader) {
      mainHeader.className = 'w-full px-6 pt-7 pb-4 flex justify-between items-center transition-colors duration-300 view-macro-header bg-[#536460]';
    }
    if (syncLabel) {
      syncLabel.className = 'text-[10px] font-bold text-white/80 mt-1 tracking-tight select-none';
    }

    if (viewMicro && prevView !== 'macro') {
      viewMicro.style.opacity = '0';
      viewMicro.style.transform = 'translateY(8px)';
      setTimeout(() => {
        viewMicro.classList.add('hidden');
        if (viewMacro) {
          viewMacro.classList.remove('hidden');
          viewMacro.style.opacity = '0';
          viewMacro.style.transform = 'translateY(8px)';
          requestAnimationFrame(() => {
            viewMacro.style.opacity = '1';
            viewMacro.style.transform = 'translateY(0)';
            window.scrollTo(0, 0);
            if (document.body) document.body.scrollTop = 0;
            if (document.documentElement) document.documentElement.scrollTop = 0;
            if (viewport) viewport.scrollTop = 0;
            setTimeout(() => {
              centerActiveMonthPill_(false);
            }, 80);
          });
        }
      }, 150);
    } else if (viewMacro) {
      viewMacro.classList.remove('hidden');
      viewMacro.style.opacity = '1';
      viewMacro.style.transform = 'translateY(0)';
      window.scrollTo(0, 0);
      if (document.body) document.body.scrollTop = 0;
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (viewport) viewport.scrollTop = 0;
      setTimeout(() => {
        centerActiveMonthPill_(false);
      }, 80);
    }

    recargarEstadoMensual_();
    if (pushHistory) {
      pushModalHistory_('macro-home');
    }
  }

  pintarBotonesUsuario_();
  autoFitCircleButtons();
}

function handleDockAdd() {
  if (appState.currentView === 'micro') {
    toggleModal(true);
  } else {
    toggleQuickAddModal(true);
  }
}

// ============================================================
// VISTA MICRO (MOTOR DIARIO)
// ============================================================

function calcularComposicion_() {
  const dias = appState.diasRestantes;
  const liquidHB = appState.homeBankingTotal - appState.bolsaTotal;
  const gastosPorFecha = {};
  dias.forEach(f => { gastosPorFecha[f] = 0; });

  let gastosEnPeriodo = 0;
  appState.movimientos.forEach(m => {
    if (m.fromBag) return;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    fechas.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(gastosPorFecha, f)) {
        gastosPorFecha[f] += m.montoPorFecha;
        gastosEnPeriodo += m.montoPorFecha;
      }
    });
  });

  const objetivoBase = dias.length > 0 ? (liquidHB + gastosEnPeriodo) / dias.length : 0;
  return { objetivoBase: objetivoBase, gastosPorFecha: gastosPorFecha };
}

function presupuestoParaFecha_(fechaISO) {
  const comp = calcularComposicion_();
  return comp.objetivoBase - (comp.gastosPorFecha[fechaISO] || 0);
}

function renderMicroView() {
  const hbEl = document.getElementById('hb-total-display');
  const bolsaEl = document.getElementById('savings-bag-display');
  if (hbEl) hbEl.textContent = formatearMoneda_(appState.homeBankingTotal);
  if (bolsaEl) bolsaEl.textContent = formatearMoneda_(appState.bolsaTotal);

  const hoyStr = hoyISO_();
  const mananaStr = formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1));

  const presupuestoHoy = presupuestoParaFecha_(hoyStr);
  const presupuestoManana = presupuestoParaFecha_(mananaStr);

  const hoyEl = document.getElementById('today-budget-display');
  const mananaEl = document.getElementById('tomorrow-budget-display');
  const diasLabel = document.getElementById('days-remaining-label');
  if (hoyEl) hoyEl.textContent = formatearMoneda_(presupuestoHoy);
  if (mananaEl) mananaEl.textContent = formatearMoneda_(presupuestoManana);
  if (diasLabel) {
    diasLabel.textContent = 'Días restantes hasta cobro: ' + appState.diasRestantes.length +
      ' (cobrás el ' + formatearFechaLegible_(appState.diaCobro) + ')';
  }

  renderTransactionList_();
}

function renderTransactionList_() {
  const cont = document.getElementById('transaction-list');
  if (!cont) return;
  const hoyStr = hoyISO_();
  const diasPeriodo = appState.diasRestantes || [];

  const delPeriodo = appState.movimientos.filter(m => {
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.some(f => diasPeriodo.includes(f) || f >= hoyStr);
  });

  if (!delPeriodo.length) {
    cont.innerHTML = '<p class="text-xs text-white/50 text-center py-6">Sin movimientos registrados</p>';
    return;
  }

  cont.innerHTML = delPeriodo.map(m => {
    const titulo = m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único');
    const fechas = normalizarFechas_(m.fechasAfectadas);

    let textoFechas = '';
    if (fechas.length === 1 && fechas[0] === hoyStr) {
      textoFechas = 'Hoy';
    } else {
      textoFechas = fechas.map(f => {
        const p = f.split('-').map(Number);
        return p[2] + '/' + p[1];
      }).join(', ');
    }

    const userLetter = m.usuario === 'Virginia' ? 'V' : 'B';

    return '<button onclick="toggleModal(true, \'' + m.id + '\')" class="w-full flex items-center justify-between text-left py-2 border-b border-white/10 hover:opacity-90 active:opacity-80 transition-opacity">' +
      '<div class="flex items-center gap-3">' +
      '<div class="w-8 h-8 rounded-full bg-white text-[#536460] font-avatar font-bold text-sm flex items-center justify-center shrink-0">' + userLetter + '</div>' +
      '<div>' +
      '<span class="text-[11px] text-white/80 block leading-tight">' + textoFechas + '</span>' +
      '<span class="text-xs font-bold text-white block leading-snug">' + titulo + '</span>' +
      '</div></div>' +
      '<div class="flex items-center gap-4">' +
      (m.fromBag ? '<span class="text-xs text-white/80 font-normal">Ahorro</span>' : '') +
      '<span class="text-sm font-bold text-white tracking-tight">' + formatearMoneda_(m.monto) + '</span>' +
      '</div></button>';
  }).join('');
}

// ============================================================
// MODAL "ACTUALIZAR HOME BANKING" Y SIMULADOR
// ============================================================

function toggleHbModal(show) {
  const modal = document.getElementById('hb-modal');
  const dash = document.getElementById('micro-dashboard-view');
  if (show) {
    prepararHbModal_();
    if (dash) dash.classList.add('hidden');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('hb-modal');
  } else {
    const elHb = document.getElementById('hb-update-amount');
    const elObj = document.getElementById('hb-objetivo-input');
    const elBolsa = document.getElementById('hb-bolsa-input');
    if (elHb) elHb.value = '';
    if (elObj) elObj.value = '';
    if (elBolsa) elBolsa.value = '';
    setMoneyValue('hb-update-amount', '');
    setMoneyValue('hb-objetivo-input', '');
    setMoneyValue('hb-bolsa-input', '');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function prepararHbModal_() {
  const comp = calcularComposicion_();
  hbModalState = {
    hb: appState.homeBankingTotal,
    objetivo: Math.round(comp.objetivoBase),
    bolsa: appState.bolsaTotal,
    diasCount: appState.diasRestantes.length,
    lastEdited: 'objetivo'
  };

  const diasLabel = document.getElementById('hb-days-label');
  if (diasLabel) diasLabel.textContent = hbModalState.diasCount + ' días hasta el próximo cobro';

  const elHb = document.getElementById('hb-update-amount');
  const elObj = document.getElementById('hb-objetivo-input');
  const elBolsa = document.getElementById('hb-bolsa-input');

  if (elHb) {
    elHb.placeholder = formatearMoneda_(hbModalState.hb);
    elHb.value = '';
    moneyStates['hb-update-amount'] = { int: '', dec: '', isDec: false };
  }
  if (elObj) {
    elObj.placeholder = formatearMoneda_(hbModalState.objetivo);
    elObj.value = '';
    moneyStates['hb-objetivo-input'] = { int: '', dec: '', isDec: false };
  }
  if (elBolsa) {
    elBolsa.placeholder = formatearMoneda_(hbModalState.bolsa);
    elBolsa.value = '';
    moneyStates['hb-bolsa-input'] = { int: '', dec: '', isDec: false };
  }

  renderHbModal_();
}

function recomputeHbModal_(origen) {
  const dias = hbModalState.diasCount || 1;
  if (origen === 'objetivo') {
    hbModalState.bolsa = hbModalState.hb - (hbModalState.objetivo * dias);
  } else if (origen === 'bolsa') {
    hbModalState.objetivo = (hbModalState.hb - hbModalState.bolsa) / dias;
  } else if (hbModalState.lastEdited === 'objetivo') {
    hbModalState.bolsa = hbModalState.hb - (hbModalState.objetivo * dias);
  } else {
    hbModalState.objetivo = (hbModalState.hb - hbModalState.bolsa) / dias;
  }
  renderHbModal_();
}

function renderHbModal_() {
  const hintObjetivo = document.getElementById('hb-hint-objetivo');
  const hintBolsa = document.getElementById('hb-hint-bolsa');
  if (hintObjetivo) {
    hintObjetivo.innerHTML = hbModalState.lastEdited === 'bolsa'
      ? '↳ con esta Bolsa, el objetivo queda en <b class="text-[13px] font-bold text-zinc-700">' + formatearMoneda_(hbModalState.objetivo) + '/día</b>'
      : '';
  }
  if (hintBolsa) {
    hintBolsa.innerHTML = hbModalState.lastEdited === 'objetivo'
      ? '↳ con este objetivo, la Bolsa quedaría en <b class="text-[13px] font-bold text-zinc-700">' + formatearMoneda_(hbModalState.bolsa) + '</b>'
      : '';
  }

  const warnEl = document.getElementById('hb-warn-banner');
  const guardarBtn = document.getElementById('btn-guardar-hb');
  if (!warnEl || !guardarBtn) return;

  if (hbModalState.bolsa < 0) {
    const maxObjetivo = hbModalState.hb / (hbModalState.diasCount || 1);
    warnEl.textContent = 'Con este objetivo no alcanza — la Bolsa quedaría en ' +
      formatearMoneda_(hbModalState.bolsa) + '. El máximo sostenible ronda ' +
      formatearMoneda_(maxObjetivo) + '/día.';
    warnEl.classList.remove('hidden');
    guardarBtn.setAttribute('disabled', 'true');
  } else {
    warnEl.classList.add('hidden');
    guardarBtn.removeAttribute('disabled');
  }
}

attachMoneyInput('hb-update-amount', (id) => { hbModalState.hb = getMoneyValue(id); recomputeHbModal_(); });
attachMoneyInput('hb-objetivo-input', (id) => { hbModalState.lastEdited = 'objetivo'; hbModalState.objetivo = getMoneyValue(id); recomputeHbModal_('objetivo'); });
attachMoneyInput('hb-bolsa-input', (id) => { hbModalState.lastEdited = 'bolsa'; hbModalState.bolsa = getMoneyValue(id); recomputeHbModal_('bolsa'); });
attachMoneyInput('tx-amount', () => { });

async function saveHbAmount() {
  if (hbModalState.bolsa < 0) return;
  toggleHbModal(false);

  const vHb = getMoneyValue('hb-update-amount');
  const finalHb = (moneyStates['hb-update-amount'] && moneyStates['hb-update-amount'].int !== '') ? vHb : appState.homeBankingTotal;

  appState.homeBankingTotal = finalHb;
  appState.bolsaTotal = hbModalState.bolsa;
  renderMicroView();

  callBackendBackground('actualizarHB', {
    homeBankingTotal: appState.homeBankingTotal,
    bolsaTotal: appState.bolsaTotal
  });
}

// ============================================================
// "LIMPIAR MOVIMIENTOS PENDIENTES"
// ============================================================

async function handleLimpiarPendientes() {
  toggleHbModal(false);
  mostrarSyncToast_();
  try {
    const resultado = await callBackend('limpiarMovimientosPendientes', {});
    await recargarEstadoDiario_(false);
    limpiarColaCandidatos = (resultado.candidatos || []).slice();
    procesarSiguienteCandidato_();
  } catch (e) {
    alert('Error al limpiar movimientos');
  } finally {
    ocultarSyncToast_();
  }
}

function procesarSiguienteCandidato_() {
  if (!limpiarColaCandidatos.length) {
    const comp = calcularComposicion_();
    hbModalState.hb = appState.homeBankingTotal;
    hbModalState.bolsa = appState.bolsaTotal;
    hbModalState.objetivo = Math.round(comp.objetivoBase);
    hbModalState.diasCount = appState.diasRestantes.length;
    setMoneyValue('hb-objetivo-input', hbModalState.objetivo);
    setMoneyValue('hb-bolsa-input', hbModalState.bolsa);
    recomputeHbModal_();
    return;
  }
  const candidato = limpiarColaCandidatos[0];
  const desc = document.getElementById('limpiar-candidato-desc');
  if (desc) {
    desc.textContent = (candidato.descripcion || 'Gasto divisible') + ' — ' +
      formatearMoneda_(candidato.monto) + ' en total';
  }
  document.getElementById('limpiar-candidato-modal').classList.add('active');
}

async function resolverCandidatoLimpiar(accion) {
  const candidato = limpiarColaCandidatos.shift();
  document.getElementById('limpiar-candidato-modal').classList.remove('active');

  mostrarSyncToast_();
  try {
    if (accion === 'borrar') {
      await callBackend('eliminarMovimiento', { id: candidato.id });
    } else if (accion === 'single') {
      await callBackend('guardarMovimiento', {
        id: candidato.id,
        tipo: 'single',
        fechasAfectadas: [hoyISO_()],
        monto: candidato.montoPorFecha,
        descripcion: candidato.descripcion,
        usuario: candidato.usuario,
        fromBag: candidato.fromBag
      });
    }
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error al procesar candidato');
  } finally {
    ocultarSyncToast_();
    procesarSiguienteCandidato_();
  }
}

// ============================================================
// CIERRE DE DÍA
// ============================================================

async function chequearCierreDia_() {
  const hoyStr = hoyISO_();

  // Si la hoja Config nunca tuvo un lastProcessedDate guardado (primera vez que
  // corre la app, o el valor se borró/nunca se seteó), no hay "día anterior" con
  // el cual comparar. Antes esto cortaba la función acá para siempre y la fecha
  // jamás quedaba guardada en Config, así que el modal nunca se disparaba en
  // ningún día futuro tampoco. Ahora sembramos hoy como línea de base (sin
  // preguntar nada, porque no hay sobrante/déficit real que resolver) para que
  // a partir de mañana el chequeo funcione con normalidad.
  if (!appState.lastProcessedDate) {
    try {
      const resultado = await callBackend('resolverCierreDia', { decision: 'redistribuir', tipo: 'sobrante', monto: 0 });
      appState.lastProcessedDate = resultado.lastProcessedDate;
    } catch (e) {
      console.error('No se pudo inicializar lastProcessedDate en Config:', e);
    }
    return;
  }

  if (appState.lastProcessedDate === hoyStr) return;
  if (appState.lastProcessedDate > hoyStr) return;

  const ventana = [appState.lastProcessedDate].concat(appState.diasRestantes);
  const liquidHB = appState.homeBankingTotal - appState.bolsaTotal;
  const gastosPorFecha = {};
  ventana.forEach(f => { gastosPorFecha[f] = 0; });

  let gastosEnVentana = 0;
  appState.movimientos.forEach(m => {
    if (m.fromBag) return;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    fechas.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(gastosPorFecha, f)) {
        gastosPorFecha[f] += m.montoPorFecha;
        gastosEnVentana += m.montoPorFecha;
      }
    });
  });

  const objetivoAyer = ventana.length > 0 ? (liquidHB + gastosEnVentana) / ventana.length : 0;
  const gastoAyer = gastosPorFecha[appState.lastProcessedDate] || 0;
  const diferencia = objetivoAyer - gastoAyer;

  if (Math.abs(diferencia) < 1) {
    const resultado = await callBackendConSync('resolverCierreDia', { decision: 'redistribuir', tipo: 'sobrante', monto: 0 });
    appState.lastProcessedDate = resultado.lastProcessedDate;
    return;
  }

  cierreDiaPendiente = { tipo: diferencia > 0 ? 'sobrante' : 'deficit', monto: Math.abs(diferencia) };
  mostrarModalCierreDia_(cierreDiaPendiente);
}

function mostrarModalCierreDia_(info) {
  const esDeficit = info.tipo === 'deficit';
  document.getElementById('day-change-title').textContent = esDeficit ? '📉 Día anterior en rojo' : '☀️ ¡Nuevo Día Detectado!';
  document.getElementById('day-change-desc').innerHTML = esDeficit
    ? 'Ayer te pasaste por <strong class="text-zinc-800">' + formatearMoneda_(info.monto) + '</strong>. ¿Cómo lo cubrimos?'
    : 'Ayer te sobraron <strong class="text-zinc-800">' + formatearMoneda_(info.monto) + '</strong>. ¿Qué hacemos?';
  document.getElementById('day-change-btn-bag').textContent = esDeficit ? 'Descontar de la Bolsa' : 'Mover a la Bolsa de Ahorro';
  document.getElementById('day-change-btn-distribute').textContent = 'Repartir entre los días que quedan';
  document.getElementById('day-change-modal').classList.add('active');
}

async function resolveDayChange(decision) {
  const info = cierreDiaPendiente;
  if (!info) return;
  document.getElementById('day-change-modal').classList.remove('active');

  mostrarSyncToast_();
  try {
    const resultado = await callBackend('resolverCierreDia', {
      decision: decision === 'bag' ? 'bolsa' : 'redistribuir',
      tipo: info.tipo,
      monto: info.monto
    });

    appState.bolsaTotal = resultado.bolsaTotal;
    appState.lastProcessedDate = resultado.lastProcessedDate;
    cierreDiaPendiente = null;
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error al cerrar día');
  } finally {
    ocultarSyncToast_();
  }
}

// ============================================================
// MODAL "REGISTRAR MOVIMIENTO" (ÚNICO / DIVISIBLE)
// ============================================================

let isExplicitEditingTx_ = false;

function setMicroSubView(view, push = true) {
  const panelList = document.getElementById('micro-panel-list');
  const panelAdd = document.getElementById('micro-panel-add');
  const tabList = document.getElementById('tab-movs-list');
  const tabAdd = document.getElementById('tab-movs-add');
  if (!panelList || !panelAdd) return;

  if (view === 'list') {
    isExplicitEditingTx_ = false;
    resetTxForm_();
    panelList.classList.remove('hidden');
    panelAdd.classList.add('hidden');
    panelAdd.classList.remove('flex');
    if (tabList) {
      tabList.className = 'text-xs font-black tracking-wider text-white border-b-2 border-white pb-1 focus:outline-none uppercase';
    }
    if (tabAdd) {
      tabAdd.className = 'text-xs font-normal tracking-wider text-white/70 hover:text-white pb-1 focus:outline-none uppercase';
    }
  } else {
    panelAdd.classList.remove('hidden');
    panelAdd.classList.add('flex');
    panelList.classList.add('hidden');
    if (tabAdd) {
      tabAdd.className = 'text-xs font-black tracking-wider text-white border-b-2 border-white pb-1 focus:outline-none uppercase';
    }
    if (tabList) {
      tabList.className = 'text-xs font-normal tracking-wider text-white/70 hover:text-white pb-1 focus:outline-none uppercase';
    }

    // Si NO proviene explícitamente de presionar un elemento de la lista para editar (prepararTxModalEdicion_), ejecutar de forma INCONDICIONAL reseteo
    if (!isExplicitEditingTx_) {
      resetTxForm_();
      editingMovimientoId = null;
      const delBtn = document.getElementById('btn-delete-tx');
      if (delBtn) {
        delBtn.classList.add('hidden');
        delBtn.style.display = 'none';
        delBtn.setAttribute('disabled', 'true');
      }
    }
    isExplicitEditingTx_ = false;

    renderTxDaysCarousel_();
    autoFitCircleButtons();
    if (push) pushModalHistory_('micro-subview-add');
  }
}

function scrollDaysCarousel(delta) {
  const cont = document.getElementById('tx-days-carousel');
  if (cont) {
    cont.scrollBy({ left: delta * 120, behavior: 'smooth' });
  }
}

function renderTxDaysCarousel_() {
  const cont = document.getElementById('tx-days-carousel');
  if (!cont) return;

  if (!cont.dataset.touchIsolated) {
    cont.dataset.touchIsolated = 'true';
    cont.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    cont.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
  }

  const hoy = hoyISO_();
  const dias = (appState.diasRestantes && appState.diasRestantes.length)
    ? appState.diasRestantes.slice(0, 15)
    : [hoy];
  if (!dias.includes(hoy)) dias.unshift(hoy);

  const assignedInput = document.getElementById('tx-assigned-date');
  const customDaysInput = document.getElementById('tx-custom-days');
  const currentAssigned = (assignedInput && assignedInput.value) || hoy;
  const customDaysStr = (customDaysInput && customDaysInput.value) ? customDaysInput.value : '';
  const customDayNums = customDaysStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

  const diasNombres = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vier', 'Sab'];

  cont.innerHTML = dias.map(f => {
    const partes = f.split('-').map(Number);
    const dObj = new Date(partes[0], partes[1] - 1, partes[2]);
    const nombreDia = diasNombres[dObj.getDay()];
    const numDia = partes[2];

    let isSelected = false;
    if (txModalSubtype === 'single') {
      isSelected = (f === currentAssigned);
    } else {
      isSelected = customDayNums.includes(numDia) || (customDayNums.length === 0 && f === currentAssigned);
    }

    return '<button type="button" onclick="selectTxDay_(\'' + f + '\')" class="day-pill ' + (isSelected ? 'active' : 'inactive') + '">' +
      '<span class="text-[11px] font-bold">' + nombreDia + '</span>' +
      '<span class="text-base font-black leading-tight">' + numDia + '</span>' +
      '</button>';
  }).join('');
}

function selectTxDay_(fechaISO) {
  const assignedInput = document.getElementById('tx-assigned-date');
  const customDaysInput = document.getElementById('tx-custom-days');
  const partes = fechaISO.split('-').map(Number);
  const numDia = partes[2];

  if (txModalSubtype === 'single') {
    if (assignedInput) assignedInput.value = fechaISO;
  } else {
    let currentNums = (customDaysInput && customDaysInput.value)
      ? customDaysInput.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      : [];
    if (currentNums.includes(numDia)) {
      currentNums = currentNums.filter(n => n !== numDia);
    } else {
      currentNums.push(numDia);
    }
    currentNums.sort((a, b) => a - b);
    if (customDaysInput) customDaysInput.value = currentNums.join(', ');
    if (assignedInput && currentNums.length) {
      assignedInput.value = fechaISO;
    }
  }
  renderTxDaysCarousel_();
}

function setTxSubtype(tipo) {
  txModalSubtype = tipo;

  const tabSingle = document.getElementById('tab-single');
  const tabDivisible = document.getElementById('tab-divisible');
  if (tabSingle && tabDivisible) {
    if (tipo === 'single') {
      tabSingle.className = 'text-sm font-black text-white focus:outline-none pb-1 border-b-2 border-white';
      tabDivisible.className = 'text-sm font-normal text-white/70 hover:text-white focus:outline-none pb-1';
    } else {
      tabDivisible.className = 'text-sm font-black text-white focus:outline-none pb-1 border-b-2 border-white';
      tabSingle.className = 'text-sm font-normal text-white/70 hover:text-white focus:outline-none pb-1';
    }
  }

  const assignCont = document.getElementById('tx-assigned-date-container');
  if (assignCont) assignCont.classList.toggle('hidden', tipo === 'divisible');
  const divOpts = document.getElementById('divisible-options');
  if (divOpts) divOpts.classList.toggle('hidden', tipo !== 'divisible');
  renderTxDaysCarousel_();
}

function handleBagCheckbox(el) {
  if (el.checked && txModalSubtype === 'divisible') {
    setTxSubtype('single');
    const fechaEl = document.getElementById('tx-assigned-date');
    if (fechaEl) {
      fechaEl.value = hoyISO_();
      fechaEl.setAttribute('disabled', 'true');
    }
  }
}

function resetTxForm_() {
  isExplicitEditingTx_ = false;
  editingMovimientoId = null;

  const descEl = document.getElementById('tx-desc');
  if (descEl) {
    descEl.value = '';
    descEl.placeholder = 'Ej: Cena, Merienda';
  }
  const fechaEl = document.getElementById('tx-assigned-date');
  if (fechaEl) {
    fechaEl.removeAttribute('disabled');
    fechaEl.value = hoyISO_();
  }
  setMoneyValue('tx-amount', '');
  const chkBag = document.getElementById('chk-from-bag');
  if (chkBag) chkBag.checked = false;
  const daysCount = document.getElementById('tx-days-count');
  if (daysCount) daysCount.value = '';
  const divStart = document.getElementById('tx-divisible-start-date');
  if (divStart) divStart.value = '';
  const customDays = document.getElementById('tx-custom-days');
  if (customDays) customDays.value = '';
  setTxSubtype('single');

  const delBtn = document.getElementById('btn-delete-tx');
  if (delBtn) {
    delBtn.classList.add('hidden');
    delBtn.style.display = 'none';
    delBtn.setAttribute('disabled', 'true');
  }
  const saveLabel = document.getElementById('btn-save-tx-label');
  if (saveLabel) saveLabel.textContent = '+';
}

function resetCurrentTabOnly() {
  resetTxForm_();
}

function toggleModal(show, movimientoId) {
  if (show) {
    if (movimientoId) {
      prepararTxModalEdicion_(movimientoId);
    } else {
      isExplicitEditingTx_ = false;
      resetTxForm_();
    }
    const saveLabel = document.getElementById('btn-save-tx-label');
    if (saveLabel) saveLabel.textContent = '+';
    const label = document.getElementById('modal-user-label');
    if (label) label.textContent = appState.activeUser === 'Brian' ? 'B' : 'V';
    setMicroSubView('add');
  } else {
    isExplicitEditingTx_ = false;
    setMicroSubView('list');
  }
}

function prepararTxModalEdicion_(movimientoId) {
  const m = appState.movimientos.find(x => String(x.id).trim() === String(movimientoId).trim());
  if (!m) { resetTxForm_(); return; }
  isExplicitEditingTx_ = true;
  editingMovimientoId = m.id;
  setTxSubtype(m.tipo);
  setMoneyValue('tx-amount', m.monto);
  const descEl = document.getElementById('tx-desc');
  if (descEl) descEl.value = m.descripcion || '';

  const fechas = normalizarFechas_(m.fechasAfectadas);
  const assignEl = document.getElementById('tx-assigned-date');
  if (assignEl) assignEl.value = fechas[0] || hoyISO_();

  if (m.tipo === 'divisible') {
    const daysCountEl = document.getElementById('tx-days-count');
    if (daysCountEl) daysCountEl.value = fechas.length || '';
    const divStartEl = document.getElementById('tx-divisible-start-date');
    if (divStartEl) divStartEl.value = fechas[0] || hoyISO_();
    const customDaysStr = fechas.map(f => {
      const p = f.split('-').map(Number);
      return p[2];
    }).join(', ');
    const customDaysEl = document.getElementById('tx-custom-days');
    if (customDaysEl) customDaysEl.value = customDaysStr;
  }

  const chkBag = document.getElementById('chk-from-bag');
  if (chkBag) chkBag.checked = !!m.fromBag;
  const delBtn = document.getElementById('btn-delete-tx');
  if (delBtn) {
    delBtn.classList.remove('hidden');
    delBtn.style.display = '';
    delBtn.removeAttribute('disabled');
  }
  renderTxDaysCarousel_();
}

async function handleFormSubmit() {
  const idToSave = editingMovimientoId;
  const userToSave = appState.activeUser;
  const subtypeToSave = txModalSubtype;

  const monto = getMoneyValue('tx-amount');
  if (!monto || monto <= 0) { alert('Ingresá un monto válido'); return; }

  const descripcion = document.getElementById('tx-desc').value.trim();
  const fromBag = document.getElementById('chk-from-bag').checked;
  let fechasAfectadas = [];

  if (subtypeToSave === 'single') {
    const fecha = document.getElementById('tx-assigned-date').value || hoyISO_();
    fechasAfectadas = [fecha];
  } else {
    const diasCount = parseInt(document.getElementById('tx-days-count').value, 10);
    const fechaInicio = document.getElementById('tx-divisible-start-date').value;
    const customDaysRaw = document.getElementById('tx-custom-days').value.trim();

    if (customDaysRaw) {
      const base = fechaInicio ? new Date(fechaInicio + 'T00:00:00') : new Date();
      let currentMonth = base.getMonth();
      let currentYear = base.getFullYear();
      let lastDay = 0;

      fechasAfectadas = customDaysRaw.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(dia => !isNaN(dia))
        .map(dia => {
          const enDiasRestantes = (appState.diasRestantes || []).find(fStr => {
            const p = fStr.split('-').map(Number);
            return p[2] === dia;
          });
          if (enDiasRestantes) {
            const p = enDiasRestantes.split('-').map(Number);
            lastDay = p[2];
            return enDiasRestantes;
          }

          if (dia < lastDay || (lastDay === 0 && dia < base.getDate())) {
            currentMonth++;
            if (currentMonth > 11) {
              currentMonth = 0;
              currentYear++;
            }
          }
          lastDay = dia;
          return formatearFechaISOLocal_(new Date(currentYear, currentMonth, dia));
        });
    } else if (diasCount && fechaInicio) {
      const base = new Date(fechaInicio + 'T00:00:00');
      for (let i = 0; i < diasCount; i++) {
        fechasAfectadas.push(formatearFechaISOLocal_(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
      }
    } else {
      fechasAfectadas = appState.diasRestantes.slice();
    }
  }

  if (!fechasAfectadas.length) { alert('Faltan fechas para este gasto'); return; }

  toggleModal(false);

  // Update Optimista
  const idMov = idToSave || ('tx_' + Date.now());
  const nuevoMov = {
    id: idMov,
    tipo: subtypeToSave,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    montoPorFecha: monto / fechasAfectadas.length,
    descripcion: descripcion,
    usuario: userToSave,
    fromBag: fromBag
  };

  const idx = appState.movimientos.findIndex(x => String(x.id) === String(idMov));
  if (idx !== -1) {
    const movAnterior = appState.movimientos[idx];
    appState.homeBankingTotal += movAnterior.monto;
    if (movAnterior.fromBag) appState.bolsaTotal += movAnterior.monto;
    appState.movimientos[idx] = nuevoMov;
  } else {
    appState.movimientos.push(nuevoMov);
  }

  appState.homeBankingTotal -= monto;
  if (fromBag) appState.bolsaTotal -= monto;

  renderMicroView();

  callBackendBackground('guardarMovimiento', {
    id: idToSave,
    tipo: subtypeToSave,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    descripcion: descripcion,
    usuario: userToSave,
    fromBag: fromBag
  }).then(() => recargarEstadoDiario_(false));
}

async function deleteCurrentEditingTransaction() {
  const idToDelete = editingMovimientoId;
  if (!idToDelete) return;
  toggleModal(false);

  const movExistente = appState.movimientos.find(x => String(x.id) === String(idToDelete));
  if (movExistente) {
    appState.homeBankingTotal += movExistente.monto;
    if (movExistente.fromBag) appState.bolsaTotal += movExistente.monto;
    appState.movimientos = appState.movimientos.filter(x => String(x.id) !== String(idToDelete));
    renderMicroView();
  }

  callBackendBackground('eliminarMovimiento', { id: idToDelete })
    .then(() => recargarEstadoDiario_(false));
}

// ============================================================
// AUDITORÍA Y FUTUROS DÍAS (DIARIO)
// ============================================================

async function triggerSyncReload() {
  mostrarSyncToast_();
  try {
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error de sincronización');
  } finally {
    ocultarSyncToast_();
  }
}

function openBudgetAuditModal(targetDay) {
  const fecha = targetDay === 'tomorrow' ? formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1)) : hoyISO_();
  const comp = calcularComposicion_();
  const gastoDelDia = comp.gastosPorFecha[fecha] || 0;
  const disponible = comp.objetivoBase - gastoDelDia;

  const auditTitle = document.getElementById('audit-title');
  const auditSubtitle = document.getElementById('audit-subtitle');
  if (auditTitle) auditTitle.textContent = targetDay === 'tomorrow' ? 'Presupuesto de Mañana' : 'Presupuesto de Hoy';
  if (auditSubtitle) auditSubtitle.textContent = formatearFechaLegible_(fecha);

  const movimientosDelDia = appState.movimientos.filter(m => {
    if (m.fromBag) return false;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.includes(fecha);
  });

  let html = '<div class="flex justify-between items-baseline py-2 border-b border-white/20">' +
    '<span class="text-base font-bold text-white">Objetivo Diario:</span>' +
    '<span class="text-base font-bold text-white">' + formatearMoneda_(comp.objetivoBase) + '</span></div>';

  if (movimientosDelDia.length) {
    html += movimientosDelDia.map(m => (
      '<div class="flex justify-between items-baseline py-2.5 border-b border-white/10 cursor-pointer hover:opacity-90 transition-opacity" onclick="toggleBudgetAuditModal(false); toggleModal(true, \'' + m.id + '\')">' +
      '<div>' +
      '<p class="text-sm font-bold text-[#d31818]">' + (m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único')) + ': -' + formatearMoneda_(m.montoPorFecha) + '</p>' +
      '<p class="text-[11px] text-white/70 mt-0.5">' + m.usuario + '</p>' +
      '</div></div>'
    )).join('');
  } else {
    html += '<p class="text-xs text-white/60 text-center py-4">Sin egresos descontados para este día</p>';
  }

  const contentList = document.getElementById('audit-content-list');
  const totalDisplay = document.getElementById('audit-total-display');
  if (contentList) contentList.innerHTML = html;
  if (totalDisplay) totalDisplay.textContent = formatearMoneda_(disponible);

  toggleBudgetAuditModal(true);
}

function toggleBudgetAuditModal(show) {
  const modalEl = document.getElementById('budget-audit-modal');
  const dash = document.getElementById('micro-dashboard-view');
  if (show) {
    if (dash) dash.classList.add('hidden');
    if (modalEl) {
      modalEl.classList.remove('hidden');
      modalEl.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('budget-audit-modal');
  } else {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function toggleFutureDaysModal(show) {
  const modalEl = document.getElementById('future-days-modal');
  const dash = document.getElementById('micro-dashboard-view');
  if (show) {
    renderFutureDaysList_();
    if (dash) dash.classList.add('hidden');
    if (modalEl) {
      modalEl.classList.remove('hidden');
      modalEl.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('future-days-modal');
  } else {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function renderFutureDaysList_() {
  const cont = document.getElementById('future-days-list');
  if (!cont) return;
  const comp = calcularComposicion_();
  const hoyStr = hoyISO_();
  const futuros = appState.diasRestantes.filter(f => f > hoyStr);

  if (!futuros.length) {
    cont.innerHTML = '<p class="text-xs text-white/60 text-center py-4">No quedan más días en este período</p>';
    return;
  }

  cont.innerHTML = futuros.map(fecha => {
    const gasto = comp.gastosPorFecha[fecha] || 0;
    const disponible = comp.objetivoBase - gasto;
    const movs = appState.movimientos.filter(m => {
      if (m.fromBag) return false;
      const fechas = normalizarFechas_(m.fechasAfectadas);
      return fechas.includes(fecha);
    });

    let detalle = '';
    if (movs.length) {
      detalle = '<div class="mt-1 space-y-1">' +
        movs.map(m => '<button onclick="event.stopPropagation(); toggleFutureDaysModal(false); toggleModal(true, \'' + m.id + '\')" class="w-full flex justify-between text-xs text-white/80 hover:text-white p-1 rounded transition-colors text-left">' +
          '<span>• ' + (m.descripcion || 'Gasto') + '</span><span class="font-bold text-[#d31818]">-' + formatearMoneda_(m.montoPorFecha) + '</span></button>').join('') +
        '</div>';
    }

    return '<div class="py-2.5 border-b border-white/15">' +
      '<div class="flex justify-between items-baseline">' +
      '<div><span class="font-bold text-white text-sm block capitalize">' + formatearFechaLegible_(fecha) + '</span>' +
      '<span class="text-[11px] text-white/70">' + (gasto > 0 ? ('Gastados: ' + formatearMoneda_(gasto)) : 'Sin consumos asignados') + '</span></div>' +
      '<span class="font-bold text-base text-white">' + formatearMoneda_(disponible) + '</span></div>' + detalle + '</div>';
  }).join('');
}

// ============================================================
// VISTA MACRO (PROYECCIÓN MENSUAL & UI OPTIMISTA)
// ============================================================

const NOMBRES_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const NOMBRES_CORTOS_MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

let macroLoadToken_ = 0;
let macroMonthDebounceTimer = null;
let isMonthScrollingProgrammatically = false;

async function recargarEstadoMensual_() {
  const year = appState.currentMacroYear;
  const month = appState.currentMacroMonth;
  const miToken = ++macroLoadToken_;

  const cacheKey = 'cached_macro_' + year + '_' + month;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      if (miToken === macroLoadToken_ && year === appState.currentMacroYear && month === appState.currentMacroMonth) {
        appState.macroData = JSON.parse(cached);
        if (appState.currentView === 'macro') {
          renderMacroView();
        }
      }
    }
  } catch (e) {}

  try {
    const data = await callBackendConSync('getEstadoMensual', { year: year, month: month });
    if (miToken !== macroLoadToken_) return;
    if (year !== appState.currentMacroYear || month !== appState.currentMacroMonth) return;

    if (data) {
      if (Array.isArray(data.serviciosFijos)) {
        data.serviciosFijos.forEach(s => {
          if (s.unitPrice === undefined && s[''] !== undefined && s[''] !== '') {
            s.unitPrice = Number(s['']) || 0;
          }
          if (s.isDirect === undefined) {
            s.isDirect = (!s.units || s.units <= 1) && (!s.unitPrice || s.unitPrice === s.monto);
          }
          if (!s.units && s.unitPrice && s.monto) {
            s.units = Math.round(s.monto / s.unitPrice) || 1;
          }
        });
      }
      appState.macroData = data;
      try {
        localStorage.setItem(cacheKey, JSON.stringify(data));
      } catch (e) {}
      renderMacroView();
    }
  } catch (e) {
    if (miToken === macroLoadToken_) {
      console.error('Error al recargar estado mensual:', e);
    }
  }
}

function centerActiveMonthPill_(smooth = true) {
  const cont = document.getElementById('macro-month-pills');
  if (!cont) return;
  const activePill = cont.querySelector('.month-pill.active');
  if (activePill) {
    isMonthScrollingProgrammatically = true;
    try {
      activePill.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        inline: 'center',
        block: 'nearest'
      });
    } catch (e) {}
    setTimeout(() => {
      isMonthScrollingProgrammatically = false;
    }, 400);
  }
}

function handleMonthPillClick_(year, month, pillEl) {
  if (appState.currentMacroYear === year && appState.currentMacroMonth === month) {
    centerActiveMonthPill_(true);
    return;
  }

  appState.currentMacroYear = year;
  appState.currentMacroMonth = month;

  const cont = document.getElementById('macro-month-pills');
  if (cont) {
    cont.querySelectorAll('.month-pill').forEach(p => {
      p.className = 'month-pill inactive';
    });
    if (pillEl) pillEl.className = 'month-pill active';
  }

  const monthDisplay = document.getElementById('current-month-display');
  if (monthDisplay) monthDisplay.textContent = NOMBRES_MESES[month] + ' ' + year;

  centerActiveMonthPill_(true);

  if (macroMonthDebounceTimer) clearTimeout(macroMonthDebounceTimer);
  macroMonthDebounceTimer = setTimeout(() => {
    recargarEstadoMensual_();
  }, 400);
}

function handleMonthCarouselScroll_() {
  if (isMonthScrollingProgrammatically) return;

  if (macroMonthDebounceTimer) clearTimeout(macroMonthDebounceTimer);
  macroMonthDebounceTimer = setTimeout(() => {
    if (isMonthScrollingProgrammatically) return;
    const cont = document.getElementById('macro-month-pills');
    if (!cont) return;
    const contRect = cont.getBoundingClientRect();
    const contCenter = contRect.left + contRect.width / 2;

    const pills = cont.querySelectorAll('.month-pill');
    let closestPill = null;
    let minDistance = Infinity;

    pills.forEach(p => {
      const rect = p.getBoundingClientRect();
      const pCenter = rect.left + rect.width / 2;
      const dist = Math.abs(pCenter - contCenter);
      if (dist < minDistance) {
        minDistance = dist;
        closestPill = p;
      }
    });

    if (closestPill) {
      const year = parseInt(closestPill.dataset.year, 10);
      const month = parseInt(closestPill.dataset.month, 10);

      if (year !== appState.currentMacroYear || month !== appState.currentMacroMonth) {
        appState.currentMacroYear = year;
        appState.currentMacroMonth = month;

        pills.forEach(p => p.className = 'month-pill inactive');
        closestPill.className = 'month-pill active';

        const monthDisplay = document.getElementById('current-month-display');
        if (monthDisplay) monthDisplay.textContent = NOMBRES_MESES[month] + ' ' + year;

        recargarEstadoMensual_();
      }
    }
  }, 400);
}

function changeMonth(delta) {
  let m = appState.currentMacroMonth + delta;
  let y = appState.currentMacroYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  if (y < 2025) { y = 2025; m = 0; }
  if (y > 2028) { y = 2028; m = 11; }

  const cont = document.getElementById('macro-month-pills');
  const targetPill = cont ? cont.querySelector(`[data-year="${y}"][data-month="${m}"]`) : null;
  if (targetPill) {
    handleMonthPillClick_(y, m, targetPill);
  }
}

function renderMacroMonthPills_() {
  const cont = document.getElementById('macro-month-pills');
  if (!cont) return;

  const currentY = appState.currentMacroYear;
  const currentM = appState.currentMacroMonth;

  if (!cont.dataset.pillsRendered) {
    cont.dataset.pillsRendered = 'true';
    const pills = [];
    for (let y = 2025; y <= 2028; y++) {
      for (let m = 0; m < 12; m++) {
        const isActive = (y === currentY && m === currentM);
        pills.push(
          '<button type="button" data-year="' + y + '" data-month="' + m + '" ' +
          'onclick="handleMonthPillClick_(' + y + ', ' + m + ', this)" ' +
          'class="month-pill ' + (isActive ? 'active' : 'inactive') + '">' +
          '<span class="text-[13px] font-extrabold leading-tight">' + NOMBRES_CORTOS_MESES[m] + '</span>' +
          '<span class="text-[10px] font-normal leading-tight">' + y + '</span>' +
          '</button>'
        );
      }
    }
    cont.innerHTML = pills.join('');

    cont.addEventListener('scroll', handleMonthCarouselScroll_, { passive: true });
    cont.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    cont.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

    setTimeout(() => {
      centerActiveMonthPill_(false);
    }, 80);
  } else {
    cont.querySelectorAll('.month-pill').forEach(p => {
      const y = parseInt(p.dataset.year, 10);
      const m = parseInt(p.dataset.month, 10);
      const isActive = (y === currentY && m === currentM);
      p.className = 'month-pill ' + (isActive ? 'active' : 'inactive');
    });
    setTimeout(() => {
      centerActiveMonthPill_(false);
    }, 80);
  }
}

function jumpToMonth_(year, month) {
  const cont = document.getElementById('macro-month-pills');
  const targetPill = cont ? cont.querySelector(`[data-year="${year}"][data-month="${month}"]`) : null;
  if (targetPill) {
    handleMonthPillClick_(year, month, targetPill);
  }
}

function setMacroSubTab(tab, push = true) {
  // Destrucción obligatoria de formularios si había subvista de gasto fijo o servicio abierta
  const fixedModal = document.getElementById('fixed-expense-modal');
  if (fixedModal && !fixedModal.classList.contains('hidden')) {
    toggleFixedExpenseModal(false);
  }
  const srvModal = document.getElementById('service-edit-modal');
  if (srvModal && !srvModal.classList.contains('hidden')) {
    toggleServiceEditModal(false);
  }
  if (typeof resetFixedExpenseForm_ === 'function') resetFixedExpenseForm_();
  if (typeof resetServiceForm_ === 'function') resetServiceForm_();

  const pResumen = document.getElementById('macro-subpanel-resumen');
  const pBrian = document.getElementById('macro-subpanel-brian');
  const pVirginia = document.getElementById('macro-subpanel-virginia');
  const bResumen = document.getElementById('btn-subtab-resumen');
  const bBrian = document.getElementById('btn-subtab-brian');
  const bVirginia = document.getElementById('btn-subtab-virginia');

  [[pResumen, bResumen], [pBrian, bBrian], [pVirginia, bVirginia]].forEach(([p, b]) => {
    if (p) p.classList.add('hidden');
    if (b) {
      b.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] pb-1.5 flex-1 text-center focus:outline-none transition-colors';
    }
  });

  if (tab === 'brian') {
    if (pBrian) pBrian.classList.remove('hidden');
    if (bBrian) bBrian.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] pb-1.5 flex-1 text-center focus:outline-none transition-colors';
    if (push) pushModalHistory_('macro-subtab-brian');
  } else if (tab === 'virginia') {
    if (pVirginia) pVirginia.classList.remove('hidden');
    if (bVirginia) bVirginia.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] pb-1.5 flex-1 text-center focus:outline-none transition-colors';
    if (push) pushModalHistory_('macro-subtab-virginia');
  } else {
    if (pResumen) pResumen.classList.remove('hidden');
    if (bResumen) bResumen.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] pb-1.5 flex-1 text-center focus:outline-none transition-colors';
  }
}

function setResumenInnerTab(tab, push = true) {
  const cIncomes = document.getElementById('resumen-content-incomes');
  const cExpenses = document.getElementById('resumen-content-expenses');
  const bIncomes = document.getElementById('btn-resumen-incomes');
  const bExpenses = document.getElementById('btn-resumen-expenses');

  if (tab === 'expenses') {
    if (cIncomes) cIncomes.classList.add('hidden');
    if (cExpenses) cExpenses.classList.remove('hidden');
    if (bExpenses) {
      bExpenses.className = 'text-xs sm:text-sm font-black text-[#536460] py-2 text-center border-b-2 border-[#536460] focus:outline-none transition-colors';
    }
    if (bIncomes) {
      bIncomes.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] py-2 text-center border-r border-[#d9d9d9] focus:outline-none transition-colors';
    }
    if (push) pushModalHistory_('macro-inner-expenses');
  } else {
    if (cExpenses) cExpenses.classList.add('hidden');
    if (cIncomes) cIncomes.classList.remove('hidden');
    if (bIncomes) {
      bIncomes.className = 'text-xs sm:text-sm font-black text-[#536460] py-2 text-center border-r border-[#d9d9d9] border-b-2 border-[#536460] focus:outline-none transition-colors';
    }
    if (bExpenses) {
      bExpenses.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] py-2 text-center focus:outline-none transition-colors';
    }
  }
}

function toggleMacroFabMenu(force, pushHistory = true) {
  const menu = document.getElementById('macro-fab-menu');
  const backdrop = document.getElementById('macro-fab-backdrop');
  const icon = document.getElementById('macro-fab-icon');
  if (!menu) return;

  const willShow = force !== undefined ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willShow);
  if (backdrop) backdrop.classList.toggle('hidden', !willShow);
  if (icon) {
    icon.textContent = willShow ? '×' : '+';
    icon.style.transform = willShow ? 'scale(1.2)' : 'scale(1)';
  }
  if (willShow && pushHistory) {
    pushModalHistory_('macro-fab-menu');
  }
}

function renderMacroView() {
  const data = appState.macroData;
  if (!data) return;

  renderMacroMonthPills_();

  const monthDisplay = document.getElementById('current-month-display');
  if (monthDisplay) {
    monthDisplay.textContent = NOMBRES_MESES[data.month] + ' ' + data.year;
  }

  const esSacMonth = (data.month === 5 || data.month === 11);
  const esPrizeMonth = (data.month === 1 || data.month === 4 || data.month === 7 || data.month === 10);

  const sacBadge = document.getElementById('sac-badge');
  const prizeBadge = document.getElementById('prize-badge');
  const sacCard = document.getElementById('view-macro-sac-card');
  const prizeCard = document.getElementById('view-macro-prize-card');
  const prizeLabel = document.getElementById('macro-prize-label');

  if (sacBadge) sacBadge.classList.toggle('hidden', !esSacMonth);
  if (sacCard) sacCard.classList.add('hidden');

  if (prizeCard) prizeCard.classList.remove('hidden');
  if (prizeLabel) {
    prizeLabel.textContent = esPrizeMonth ? '✦ PREMIO VARIABLE Y AJUSTES' : '✦ AJUSTE DE SUELDO';
  }
  if (prizeBadge) {
    prizeBadge.textContent = esPrizeMonth ? 'Mes con Premio' : 'Ajuste de Sueldo';
    prizeBadge.classList.toggle('hidden', !esPrizeMonth && !data.premio);
  }

  const usdRate = data.usdRate || 1;

  const usdEl = document.getElementById('display-usd-rate');
  const brianEl = document.getElementById('display-salary-brian');
  const virginiaEl = document.getElementById('display-salary-virginia');
  if (usdEl && !macroDraft) usdEl.textContent = formatearMoneda_(usdRate);
  if (brianEl && !macroDraft) brianEl.textContent = formatearMoneda_(data.salaryBrian || 0);
  if (virginiaEl && !macroDraft) virginiaEl.textContent = formatearMoneda_(data.salaryVirginia || 0);

  const sacB = (data.sacBrian !== null && data.sacBrian !== undefined) ? Number(data.sacBrian) : (esSacMonth ? ((Number(data.salaryBrian) || 0) / 2) : 0);
  const sacV = (data.sacVirginia !== null && data.sacVirginia !== undefined) ? Number(data.sacVirginia) : (esSacMonth ? ((Number(data.salaryVirginia) || 0) / 2) : 0);
  const sacCalculado = sacB + sacV;
  const sacDisplay = document.getElementById('macro-sac-display');
  if (sacDisplay) sacDisplay.textContent = formatearMoneda_(sacCalculado);

  const premioBrian = data.premioBrian !== undefined ? data.premioBrian : (data.premio || 0);
  const premioVirginia = data.premioVirginia || 0;
  const premioCalculado = premioBrian + premioVirginia;
  const prizeDisplay = document.getElementById('macro-prize-display');
  if (prizeDisplay) prizeDisplay.textContent = formatearMoneda_(premioCalculado);

  const deudas = (data.gastosFijos || []).filter(g => g.tipo === 'deuda');
  let totalDeudasARS = 0;
  deudas.forEach(d => {
    if (d.esPausado) return;
    if (d.tieneExcepcionEsteMes && Number(d.monto) === 0) return;
    const monto = Number(d.monto) || 0;
    if (monto <= 0) return;
    const montoARS = d.moneda === 'USD' ? (monto * usdRate) : monto;
    if (montoARS > 0) {
      totalDeudasARS += montoARS;
    }
  });

  const totalIngresos = data.salaryBrian + data.salaryVirginia + sacCalculado + premioCalculado + totalDeudasARS;
  const incomeTotalEl = document.getElementById('macro-income-total');
  if (incomeTotalEl) incomeTotalEl.textContent = formatearMoneda_(totalIngresos);

  const gastosFijos = (data.gastosFijos || []).filter(g => g.tipo === 'gasto');
  let totalGastosFijosARS = 0;
  gastosFijos.forEach(g => {
    totalGastosFijosARS += g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
  });

  const deshabilitados = data.serviciosDeshabilitadosEsteMes || [];
  const serviciosHabilitados = (data.serviciosFijos || []).filter(s => !deshabilitados.includes(s.id));
  let totalServiciosARS = 0;
  serviciosHabilitados.forEach(s => {
    totalServiciosARS += s.moneda === 'USD' ? (s.monto * usdRate) : s.monto;
  });

  const totalGastos = totalGastosFijosARS + totalServiciosARS;
  const expensesTotalEl = document.getElementById('macro-expenses-total');
  if (expensesTotalEl) expensesTotalEl.textContent = formatearMoneda_(totalGastos);

  const restoNeto = totalIngresos - totalGastos;
  const balanceDisplay = document.getElementById('macro-net-balance-display');
  const netBalance = totalIngresos - totalGastos;
  const netBalanceEl = document.getElementById('macro-net-balance-display');
  if (netBalanceEl) {
    netBalanceEl.textContent = formatearMoneda_(netBalance);
    netBalanceEl.className = 'text-lg font-black text-[#536460]';
  }

  renderMacroIncomesList_(data, sacCalculado, premioCalculado, deudas, usdRate);
  renderMacroExpensesList_(gastosFijos, serviciosHabilitados, usdRate);
  renderMacroServicesToggleList_(data.serviciosFijos || [], deshabilitados, usdRate);
  renderMacroDebtsList_(deudas, usdRate);
  renderMacroFixedExpensesLists_(data.gastosFijos || [], usdRate);
  autoFitCircleButtons();
}

function renderMacroIncomesList_(data, sac, premio, deudas, usdRate) {
  const cont = document.getElementById('incomes-list');
  if (!cont) return;

  const pBrian = data.premioBrian !== undefined ? Number(data.premioBrian) : (Number(data.premio) || 0);
  const pVirginia = Number(data.premioVirginia) || 0;

  const esSacMonth = (data.month === 5 || data.month === 11);
  const sacBrian = (data.sacBrian !== null && data.sacBrian !== undefined)
    ? Number(data.sacBrian)
    : (esSacMonth ? ((Number(data.salaryBrian) || 0) / 2) : 0);
  const sacVirginia = (data.sacVirginia !== null && data.sacVirginia !== undefined)
    ? Number(data.sacVirginia)
    : (esSacMonth ? ((Number(data.salaryVirginia) || 0) / 2) : 0);

  let html = '';
  // 1. Líneas de Sueldo Base (exclusivamente base sin agregados inline)
  html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>Sueldo Brian:</span><span class="font-bold">' + formatearMoneda_(data.salaryBrian || 0) + '</span></div>';
  html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>Sueldo Virginia:</span><span class="font-bold">' + formatearMoneda_(data.salaryVirginia || 0) + '</span></div>';

  // 2. Ajustes de Sueldo Individuales (Sin Unificar, ÚNICAMENTE cuando !== 0)
  if (pBrian !== 0) {
    const valBrian = (pBrian > 0 ? '+ ' : '- ') + formatearMoneda_(Math.abs(pBrian));
    html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>Ajuste de Sueldo Brian:</span><span class="font-bold">' + valBrian + '</span></div>';
  }
  if (pVirginia !== 0) {
    const valVirginia = (pVirginia > 0 ? '+ ' : '- ') + formatearMoneda_(Math.abs(pVirginia));
    html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>Ajuste de Sueldo Virginia:</span><span class="font-bold">' + valVirginia + '</span></div>';
  }

  // 3. SAC / Aguinaldo Individual (Sin Unificar, ÚNICAMENTE cuando > 0)
  if (sacBrian > 0) {
    html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>SAC (Aguinaldo) Brian:</span><span class="font-bold">' + formatearMoneda_(sacBrian) + '</span></div>';
  }
  if (sacVirginia > 0) {
    html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>SAC (Aguinaldo) Virginia:</span><span class="font-bold">' + formatearMoneda_(sacVirginia) + '</span></div>';
  }

  // 4. Deudas (ÚNICAMENTE deudas activas con monto real > 0)
  (deudas || []).forEach(d => {
    if (d.esPausado) return;
    if (d.tieneExcepcionEsteMes && Number(d.monto) === 0) return;
    const monto = Number(d.monto) || 0;
    if (monto <= 0) return;
    const montoARS = d.moneda === 'USD' ? (monto * usdRate) : monto;
    if (montoARS <= 0) return;
    html += '<div class="flex justify-between py-1.5 border-b border-zinc-100"><span>Deuda ' + d.descripcion + ':</span><span class="font-bold">' + formatearMoneda_(montoARS) + '</span></div>';
  });

  cont.innerHTML = html;
}

function renderMacroExpensesList_(gastosFijos, serviciosHabilitados, usdRate) {
  const cont = document.getElementById('expenses-list');
  if (!cont) return;
  let html = '';

  gastosFijos.forEach(g => {
    const montoARS = g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
    html += '<div class="flex justify-between py-1"><span>' + g.descripcion + ' (' + g.usuario + ')</span><span class="font-bold">' + formatearMoneda_(montoARS) + '</span></div>';
  });

  serviciosHabilitados.forEach(s => {
    const montoARS = s.moneda === 'USD' ? (s.monto * usdRate) : s.monto;
    html += '<div class="flex justify-between py-1 text-zinc-500"><span>Servicio: ' + s.descripcion + '</span><span class="font-bold">' + formatearMoneda_(montoARS) + '</span></div>';
  });

  cont.innerHTML = html || '<p class="text-[10px] text-zinc-400">Sin gastos fijos proyectados</p>';
}

function renderMacroServicesToggleList_(servicios, deshabilitados, usdRate) {
  const cont = document.getElementById('macro-services-toggle-list');
  const servicesTotalDisplay = document.getElementById('macro-services-total-display');
  if (!cont) return;

  let totalServiciosHab = 0;

  cont.innerHTML = servicios.map(s => {
    const isEnabled = !deshabilitados.includes(s.id);
    const montoARS = s.moneda === 'USD' ? (s.monto * usdRate) : s.monto;
    if (isEnabled) totalServiciosHab += montoARS;

    let displayMonto = formatearMoneda_(s.monto) + ' ' + (s.moneda || 'ARS');
    if (s.moneda === 'USD') {
      displayMonto = formatearMoneda_(s.monto) + ' USD (≈ ' + formatearMoneda_(montoARS) + ')';
    }

    return '<div class="flex items-center justify-between py-1.5 border-b border-zinc-100 last:border-b-0">' +
      '<label class="flex items-center gap-2.5 cursor-pointer">' +
      '<input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' onchange="toggleServicioStatus(\'' + s.id + '\', this.checked)" class="rounded border-zinc-400 accent-[#536460] w-4 h-4">' +
      '<span class="text-xs font-semibold ' + (isEnabled ? 'text-[#536460]' : 'line-through text-zinc-400') + '">' + s.descripcion + '</span>' +
      '</label>' +
      '<span class="text-xs font-bold ' + (isEnabled ? 'text-[#536460]' : 'line-through text-zinc-400') + '">' + displayMonto + '</span>' +
      '</div>';
  }).join('');

  if (servicesTotalDisplay) servicesTotalDisplay.textContent = formatearMoneda_(totalServiciosHab);
  const toggleAll = document.getElementById('chk-toggle-all-services');
  if (toggleAll && servicios.length) {
    toggleAll.checked = servicios.every(s => !deshabilitados.includes(s.id));
  }
}

function renderMacroDebtsList_(deudas, usdRate) {
  const cont = document.getElementById('debts-list');
  const sumEl = document.getElementById('debts-total-sum');
  if (!cont) return;

  const activeDebts = (deudas || []).filter(d => !d.esPausado && !(d.tieneExcepcionEsteMes && Number(d.monto) === 0) && (Number(d.monto) || 0) > 0);
  let totalSum = 0;
  if (!activeDebts.length) {
    cont.innerHTML = '<p class="text-[10px] text-zinc-400 text-center py-1">Sin deudas a favor registradas</p>';
    if (sumEl) sumEl.textContent = '+$ 0,00';
    return;
  }

  cont.innerHTML = activeDebts.map(d => {
    const monto = Number(d.monto) || 0;
    const montoARS = d.moneda === 'USD' ? (monto * usdRate) : monto;
    totalSum += montoARS;
    return '<div class="flex justify-between items-center py-1.5 border-b border-zinc-100">' +
      '<div><span class="font-bold text-[#536460] block">' + d.descripcion + '</span>' +
      '<span class="text-[9px] text-[#8e9b98] font-medium">' + d.usuario + '</span></div>' +
      '<span class="font-bold text-[#536460]">+' + formatearMoneda_(montoARS) + '</span></div>';
  }).join('');

  if (sumEl) sumEl.textContent = '+' + formatearMoneda_(totalSum);
}

function renderMacroFixedExpensesLists_(gastosFijos, usdRate) {
  const brianCont = document.getElementById('brian-fixed-list');
  const virginiaCont = document.getElementById('virginia-fixed-list');

  const brianItems = gastosFijos.filter(g => g.usuario === 'Brian');
  const virginiaItems = gastosFijos.filter(g => g.usuario === 'Virginia');

  let brianTotalSum = 0;
  brianItems.forEach(g => {
    if (g.tipo === 'gasto' && !g.esPausado && g.monto > 0) {
      brianTotalSum += g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
    }
  });

  let virgTotalSum = 0;
  virginiaItems.forEach(g => {
    if (g.tipo === 'gasto' && !g.esPausado && g.monto > 0) {
      virgTotalSum += g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
    }
  });

  const resBrianEl = document.getElementById('resumen-brian-total');
  const resVirgEl = document.getElementById('resumen-virginia-total');
  const pBrianEl = document.getElementById('brian-panel-total');
  const pVirgEl = document.getElementById('virginia-panel-total');

  if (resBrianEl) resBrianEl.textContent = formatearMoneda_(brianTotalSum);
  if (resVirgEl) resVirgEl.textContent = formatearMoneda_(virgTotalSum);
  if (pBrianEl) pBrianEl.textContent = formatearMoneda_(brianTotalSum);
  if (pVirgEl) pVirgEl.textContent = formatearMoneda_(virgTotalSum);

  const renderItem = (g) => {
    const montoARS = g.moneda === 'USD' ? (g.monto * usdRate) : g.monto;
    const esDeuda = (g.tipo === 'deuda' || g.tipo === 'debt');
    const esDeshabilitadoEsteMes = (g.tieneExcepcionEsteMes && g.monto === 0);
    const esPausado = !!g.esPausado;
    const esInactivo = esDeshabilitadoEsteMes || esPausado;

    let etiqueta = esDeuda ? 'Deuda a favor' : 'Gasto fijo';
    if (esDeshabilitadoEsteMes) etiqueta = 'Deshabilitado este mes';
    else if (esPausado) etiqueta = 'Pausado a futuro';

    let signo = esDeuda ? '+ ' : '- ';
    if (esInactivo) signo = '';

    return '<div onclick="openFixedExpenseModal(\'' + g.usuario + '\', \'' + g.id + '\')" class="flex justify-between items-center py-2 border-b border-zinc-100 cursor-pointer hover:bg-zinc-50 px-1 rounded-lg transition-colors">' +
      '<div>' +
      '<span class="text-xs font-bold block ' + (esInactivo ? 'line-through text-zinc-400' : 'text-[#536460]') + '">' + g.descripcion + '</span>' +
      '<span class="text-[10px] ' + (esInactivo ? 'text-amber-700 font-bold' : 'text-[#8e9b98]') + '">' + etiqueta + '</span>' +
      '</div>' +
      '<span class="text-xs font-bold ' + (esInactivo ? 'line-through text-zinc-400' : (esDeuda ? 'text-emerald-700' : 'text-[#536460]')) + '">' +
      (esInactivo ? '$ 0,00' : (signo + formatearMoneda_(montoARS))) +
      '</span></div>';
  };

  if (brianCont) {
    brianCont.innerHTML = brianItems.length ? brianItems.map(renderItem).join('') : '<p class="text-xs text-[#8e9b98] py-2">Sin gastos fijos cargados</p>';
  }

  if (virginiaCont) {
    virginiaCont.innerHTML = virginiaItems.length ? virginiaItems.map(renderItem).join('') : '<p class="text-xs text-[#8e9b98] py-2">Sin gastos fijos cargados</p>';
  }
}

// Colapsables de Vista Macro
function toggleIncomesCollapse() {
  const content = document.getElementById('incomes-collapse-content');
  const arrow = document.getElementById('incomes-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleExpensesCollapse() {
  const content = document.getElementById('expenses-collapse-content');
  const arrow = document.getElementById('expenses-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleServicesCollapse() {
  const content = document.getElementById('services-collapse-content');
  const arrow = document.getElementById('services-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

function toggleDebtsCollapse() {
  const content = document.getElementById('debts-collapse-content');
  const arrow = document.getElementById('debts-collapse-arrow');
  if (content) content.classList.toggle('hidden');
  if (arrow) arrow.classList.toggle('rotate-180');
}

// TOGGLE SERVICIO INDIVIDUAL CON UI OPTIMISTA
function toggleServicioStatus(servicioId, habilitado) {
  if (!appState.macroData) return;

  // 1. UI Optimista
  let deshabilitados = appState.macroData.serviciosDeshabilitadosEsteMes || [];
  if (habilitado) {
    deshabilitados = deshabilitados.filter(id => String(id) !== String(servicioId));
  } else {
    if (!deshabilitados.includes(servicioId)) {
      deshabilitados.push(servicioId);
    }
  }
  appState.macroData.serviciosDeshabilitadosEsteMes = deshabilitados;
  renderMacroView();

  // 2. Sync en segundo plano
  callBackendBackground('toggleServicio', {
    servicioId: servicioId,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    habilitado: habilitado
  });
}

// TOGGLE MASIVO CON BATCH BKG Y UI OPTIMISTA
function toggleAllServicesCheckboxes(e) {
  e.stopPropagation();
  const data = appState.macroData;
  if (!data || !data.serviciosFijos) return;

  const deshabilitados = data.serviciosDeshabilitadosEsteMes || [];
  const hayHabilitados = data.serviciosFijos.some(s => !deshabilitados.includes(s.id));
  const nuevoEstadoHabilitar = !hayHabilitados;

  // 1. UI Optimista Instantánea
  if (nuevoEstadoHabilitar) {
    data.serviciosDeshabilitadosEsteMes = [];
  } else {
    data.serviciosDeshabilitadosEsteMes = data.serviciosFijos.map(s => s.id);
  }
  renderMacroView();

  // 2. Sync BATCH en 1 sola petición HTTP en segundo plano
  callBackendBackground('toggleAllServiciosBatch', {
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    habilitarTodos: nuevoEstadoHabilitar
  });
}

// ============================================================
// MODALES Y ACCIONES MACRO (PROYECCIÓN MENSUAL Y BORRADOR)
// ============================================================

function toggleMacroConfigModal(show) {
  const modal = document.getElementById('macro-config-modal');
  const dash = document.getElementById('macro-dashboard-view');
  if (show) {
    const data = appState.macroData || {};
    macroDraft = {
      usdRate: data.usdRate || 0,
      salaryBrian: data.salaryBrian || 0,
      salaryVirginia: data.salaryVirginia || 0,
      serviciosFijos: JSON.parse(JSON.stringify(data.serviciosFijos || [])),
      serviciosEliminados: []
    };
    renderMacroConfigDraft_();
    if (dash) dash.classList.add('hidden');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('macro-config-modal');
  } else {
    macroDraft = null;
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function renderMacroConfigDraft_() {
  if (!macroDraft) return;
  const usdEl = document.getElementById('display-usd-rate');
  const brianEl = document.getElementById('display-salary-brian');
  const virginiaEl = document.getElementById('display-salary-virginia');

  if (usdEl) usdEl.textContent = formatearMoneda_(macroDraft.usdRate);
  if (brianEl) brianEl.textContent = formatearMoneda_(macroDraft.salaryBrian);
  if (virginiaEl) virginiaEl.textContent = formatearMoneda_(macroDraft.salaryVirginia);

  renderMacroServicesConfigList_(macroDraft.serviciosFijos || []);
}

function renderMacroServicesConfigList_(servicios) {
  const cont = document.getElementById('macro-services-list');
  if (!cont) return;

  if (!servicios.length) {
    cont.innerHTML = '<p class="text-[10px] text-zinc-400 py-1">Sin servicios fijos creados</p>';
    return;
  }

  const rate = (macroDraft && macroDraft.usdRate) ? macroDraft.usdRate : (appState.macroData ? appState.macroData.usdRate : 1);

  cont.innerHTML = servicios.map(s => {
    let displayMonto = formatearMoneda_(s.monto) + ' ' + (s.moneda || 'ARS');
    if (s.moneda === 'USD') {
      displayMonto = formatearMoneda_(s.monto) + ' USD (≈ ' + formatearMoneda_(s.monto * rate) + ')';
    }
    return '<div onclick="openServiceEditModal(\'' + s.id + '\')" class="flex justify-between items-center p-2 bg-zinc-50 hover:bg-zinc-100 rounded-xl cursor-pointer border border-zinc-200/80 transition-colors">' +
      '<span class="text-xs font-bold text-zinc-800">' + s.descripcion + '</span>' +
      '<span class="text-xs font-black text-zinc-900">' + displayMonto + '</span></div>';
  }).join('');
}

function openValueEditModal(target) {
  currentEditingValueTarget = target;
  const title = document.getElementById('value-edit-modal-title');
  const label = document.getElementById('value-edit-input-label');
  const helper = document.getElementById('value-edit-helper');
  const inputId = 'generic-value-input';

  let valorActual = 0;
  const data = (macroDraft && (target === 'usd' || target === 'salary-brian' || target === 'salary-virginia'))
    ? macroDraft
    : (appState.macroData || {});

  if (helper) helper.classList.add('hidden');

  if (target === 'usd') {
    title.textContent = 'Editar Cotización Dólar';
    label.textContent = 'Dólar Oficial (ARS)';
    valorActual = data.usdRate || 0;
  } else if (target === 'salary-brian') {
    title.textContent = 'Editar Sueldo Brian';
    label.textContent = 'Sueldo Fijo Mensual ($)';
    valorActual = data.salaryBrian || 0;
  } else if (target === 'salary-virginia') {
    title.textContent = 'Editar Sueldo Virginia';
    label.textContent = 'Sueldo Fijo Mensual ($)';
    valorActual = data.salaryVirginia || 0;
  } else if (target === 'prize-brian') {
    const esPrizeMonth = (data.month === 1 || data.month === 4 || data.month === 7 || data.month === 10);
    title.textContent = esPrizeMonth ? 'Calcular Premio y Ajustes' : 'Calcular Ajuste de Sueldo';
    label.textContent = 'Total Cobrado en Bolsillo ($)';

    const sueldoBase = data.salaryBrian || 0;
    const extraPrevio = data.premio || 0;
    valorActual = extraPrevio !== 0 ? (sueldoBase + extraPrevio) : sueldoBase;

    if (helper) {
      helper.textContent = 'Sueldo base de Brian: ' + formatearMoneda_(sueldoBase) + '. Se calculará la diferencia automáticamente.';
      helper.classList.remove('hidden');
    }
  } else if (target === 'sac-value') {
    title.textContent = 'Editar SAC (Aguinaldo)';
    label.textContent = 'Monto Aguinaldo Este Mes ($)';
    valorActual = (data.sacBrian || 0) + (data.sacVirginia || 0);
  }

  attachMoneyInput(inputId, () => { });
  setMoneyValue(inputId, valorActual);
  toggleValueEditModal(true);
}

function toggleValueEditModal(show) {
  const modal = document.getElementById('value-edit-modal');
  const macroConfig = document.getElementById('macro-config-modal');
  const dash = document.getElementById('macro-dashboard-view');
  if (show) {
    if (macroConfig && !macroConfig.classList.contains('hidden')) {
      macroConfig.classList.add('hidden');
    } else if (dash) {
      dash.classList.add('hidden');
    }
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('value-edit-modal');
  } else {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (macroDraft && macroConfig) {
      macroConfig.classList.remove('hidden');
      macroConfig.classList.add('flex');
    } else if (dash) {
      dash.classList.remove('hidden');
    }
  }
}

function handleValueSubmit() {
  const monto = getMoneyValue('generic-value-input');
  toggleValueEditModal(false);

  if (macroDraft && (currentEditingValueTarget === 'usd' || currentEditingValueTarget === 'salary-brian' || currentEditingValueTarget === 'salary-virginia')) {
    if (currentEditingValueTarget === 'usd') {
      macroDraft.usdRate = monto;
    } else if (currentEditingValueTarget === 'salary-brian') {
      macroDraft.salaryBrian = monto;
    } else if (currentEditingValueTarget === 'salary-virginia') {
      macroDraft.salaryVirginia = monto;
    }
    renderMacroConfigDraft_();
    return;
  }

  if (currentEditingValueTarget === 'prize-brian') {
    const data = appState.macroData || {};
    const sueldoBase = data.salaryBrian || 0;
    let diferencia = 0;
    if (monto > 0) {
      diferencia = monto - sueldoBase;
    }

    // UI Optimista
    data.premio = diferencia;
    renderMacroView();

    callBackendBackground('guardarPremio', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      monto: diferencia
    });
  } else if (currentEditingValueTarget === 'sac-value') {
    const data = appState.macroData || {};
    data.sacBrian = monto / 2;
    data.sacVirginia = monto / 2;
    renderMacroView();

    callBackendBackground('guardarSacOverride', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      usuario: 'Brian',
      monto: monto / 2
    }).then(() => {
      callBackendBackground('guardarSacOverride', {
        year: appState.currentMacroYear,
        month: appState.currentMacroMonth,
        usuario: 'Virginia',
        monto: monto / 2
      });
    });
  }
}

// Función centralizada de reseteo: Servicios Fijos
function resetServiceForm_() {
  const form = document.getElementById('srv-edit-form');
  if (form) form.reset();

  const nameEl = document.getElementById('srv-modal-name');
  if (nameEl) nameEl.value = '';

  const unitsEl = document.getElementById('srv-modal-units');
  if (unitsEl) unitsEl.value = 1;

  setMoneyValue('srv-modal-amount', '');
  setMoneyValue('srv-modal-unit-price', '');

  const currSel = document.getElementById('srv-modal-currency');
  if (currSel) currSel.value = 'ARS';

  const chkDirect = document.getElementById('chk-srv-is-direct');
  if (chkDirect) {
    chkDirect.checked = true;
    toggleServiceModalMode(true);
  }

  currentEditingServiceId = null;

  const btnDelete = document.getElementById('btn-delete-service');
  if (btnDelete) {
    btnDelete.classList.add('hidden');
    btnDelete.style.display = 'none';
    btnDelete.setAttribute('disabled', 'true');
  }
}

// Edición de Servicios Fijos
function openServiceEditModal(serviceId) {
  if (!serviceId) {
    resetServiceForm_();
    currentEditingServiceId = null;
    const btnDel = document.getElementById('btn-delete-service');
    if (btnDel) {
      btnDel.classList.add('hidden');
      btnDel.style.display = 'none';
      btnDel.setAttribute('disabled', 'true');
    }
  } else {
    currentEditingServiceId = serviceId;
    const btnDel = document.getElementById('btn-delete-service');
    if (btnDel) {
      btnDel.removeAttribute('disabled');
      btnDel.style.display = '';
    }
  }

  const form = document.getElementById('srv-edit-form');
  const btnDelete = document.getElementById('btn-delete-service');

  attachMoneyInput('srv-modal-amount', () => { });
  attachMoneyInput('srv-modal-unit-price', () => updateServiceModalTotalFromUnits());

  const chkDirect = document.getElementById('chk-srv-is-direct');

  const list = (macroDraft && macroDraft.serviciosFijos)
    ? macroDraft.serviciosFijos
    : (appState.macroData ? appState.macroData.serviciosFijos : []);

  if (serviceId) {
    const s = list.find(x => String(x.id) === String(serviceId));
    if (s) {
      document.getElementById('srv-modal-name').value = s.descripcion;
      document.getElementById('srv-modal-currency').value = s.moneda || 'ARS';

      const isDirect = (s.isDirect !== undefined && s.isDirect !== null)
        ? aBooleano_(s.isDirect)
        : (!s.units || (s.units <= 1 && (!s.unitPrice || s.unitPrice === s.monto)));
      if (chkDirect) {
        chkDirect.checked = isDirect;
        toggleServiceModalMode(isDirect);
      }

      if (!isDirect) {
        document.getElementById('srv-modal-units').value = s.units || 1;
        setMoneyValue('srv-modal-unit-price', s.unitPrice || (s.monto / (s.units || 1)));
      } else {
        document.getElementById('srv-modal-units').value = 1;
        setMoneyValue('srv-modal-unit-price', '');
      }
      setMoneyValue('srv-modal-amount', s.monto);

      if (btnDelete) {
        btnDelete.classList.remove('hidden');
        btnDelete.style.display = '';
        btnDelete.removeAttribute('disabled');
      }
    }
  } else {
    resetServiceForm_();
    currentEditingServiceId = null;
    const btnDel = document.getElementById('btn-delete-service');
    if (btnDel) {
      btnDel.classList.add('hidden');
      btnDel.style.display = 'none';
      btnDel.setAttribute('disabled', 'true');
    }
  }

  toggleServiceEditModal(true);
}

function toggleServiceEditModal(show) {
  const modal = document.getElementById('service-edit-modal');
  const macroConfig = document.getElementById('macro-config-modal');
  const dash = document.getElementById('macro-dashboard-view');
  if (show) {
    if (macroConfig && !macroConfig.classList.contains('hidden')) {
      macroConfig.classList.add('hidden');
    } else if (dash) {
      dash.classList.add('hidden');
    }
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('service-edit-modal');
  } else {
    resetServiceForm_();
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (macroDraft && macroConfig) {
      macroConfig.classList.remove('hidden');
      macroConfig.classList.add('flex');
    } else if (dash) {
      dash.classList.remove('hidden');
    }
  }
}

function toggleServiceModalMode(isDirect) {
  const container = document.getElementById('srv-modal-units-container');
  if (container) container.classList.toggle('hidden', isDirect);
}

function updateServiceModalTotalFromUnits() {
  const units = parseInt(document.getElementById('srv-modal-units').value, 10) || 1;
  const unitPrice = getMoneyValue('srv-modal-unit-price');
  setMoneyValue('srv-modal-amount', units * unitPrice);
}

async function handleServiceSubmit() {
  const idTarget = currentEditingServiceId;
  const descripcion = document.getElementById('srv-modal-name').value.trim();
  const moneda = document.getElementById('srv-modal-currency').value;
  const isDirect = document.getElementById('chk-srv-is-direct').checked;
  const units = parseInt(document.getElementById('srv-modal-units').value, 10) || 1;
  const unitPrice = getMoneyValue('srv-modal-unit-price');
  const monto = isDirect ? getMoneyValue('srv-modal-amount') : (units * unitPrice);

  if (!descripcion) { alert('Ingresá el nombre del servicio'); return; }
  if (monto <= 0) { alert('Ingresá un monto válido'); return; }

  toggleServiceEditModal(false);
  if (typeof toggleMacroConfigModal === 'function') toggleMacroConfigModal(false);
  const macroDash = document.getElementById('macro-dashboard-view');
  if (macroDash) macroDash.classList.remove('hidden');
  if (typeof setMacroSubTab === 'function') setMacroSubTab('resumen', false);

  const servicioObj = {
    id: idTarget || ('srv_' + Date.now()),
    descripcion: descripcion,
    monto: monto,
    moneda: moneda,
    isDirect: isDirect,
    units: isDirect ? 1 : units,
    unitPrice: isDirect ? monto : unitPrice
  };

  if (appState.macroData && appState.macroData.serviciosFijos) {
    const list = appState.macroData.serviciosFijos;
    if (idTarget) {
      const idx = list.findIndex(x => String(x.id) === String(idTarget));
      if (idx !== -1) {
        list[idx] = Object.assign({}, list[idx], servicioObj);
      }
    } else {
      list.push(servicioObj);
    }
    renderMacroView();
  }

  if (macroDraft) {
    if (idTarget) {
      const idx = (macroDraft.serviciosFijos || []).findIndex(x => String(x.id) === String(idTarget));
      if (idx !== -1) {
        macroDraft.serviciosFijos[idx] = Object.assign({}, macroDraft.serviciosFijos[idx], servicioObj);
      }
    } else {
      if (!macroDraft.serviciosFijos) macroDraft.serviciosFijos = [];
      macroDraft.serviciosFijos.push(servicioObj);
    }
    renderMacroConfigDraft_();
  }

  callBackendBackground('guardarServicioFijo', servicioObj)
    .then(() => recargarEstadoMensual_());
}

async function deleteCurrentEditingService() {
  const idTarget = currentEditingServiceId;
  if (!idTarget) return;
  toggleServiceEditModal(false);
  if (typeof toggleMacroConfigModal === 'function') toggleMacroConfigModal(false);
  const macroDash = document.getElementById('macro-dashboard-view');
  if (macroDash) macroDash.classList.remove('hidden');
  if (typeof setMacroSubTab === 'function') setMacroSubTab('resumen', false);

  if (appState.macroData && appState.macroData.serviciosFijos) {
    appState.macroData.serviciosFijos = appState.macroData.serviciosFijos.filter(x => String(x.id) !== String(idTarget));
    renderMacroView();
  }

  if (macroDraft) {
    if (!idTarget.startsWith('srv_')) {
      macroDraft.serviciosEliminados.push(idTarget);
    }
    macroDraft.serviciosFijos = macroDraft.serviciosFijos.filter(x => String(x.id) !== String(idTarget));
    renderMacroConfigDraft_();
  }

  callBackendBackground('eliminarServicioFijo', { id: idTarget })
    .then(() => recargarEstadoMensual_());
}

function setBrianInnerTab(tab, triggerModal = true) {
  const bList = document.getElementById('btn-brian-tab-list');
  const bAdd = document.getElementById('btn-brian-tab-add');
  if (tab === 'add') {
    if (bList) {
      bList.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] py-2 text-center border-r border-[#d9d9d9] focus:outline-none transition-colors';
    }
    if (bAdd) {
      bAdd.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] py-2 text-center focus:outline-none transition-colors';
    }
    if (triggerModal) quickAddFixedExpense('Brian');
  } else {
    if (bList) {
      bList.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] py-2 text-center border-r border-[#d9d9d9] focus:outline-none transition-colors';
    }
    if (bAdd) {
      bAdd.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] py-2 text-center focus:outline-none transition-colors';
    }
    const modal = document.getElementById('fixed-expense-modal');
    if (modal && !modal.classList.contains('hidden') && triggerModal) {
      toggleFixedExpenseModal(false);
    }
  }
}

function setVirginiaInnerTab(tab, triggerModal = true) {
  const bList = document.getElementById('btn-virginia-tab-list');
  const bAdd = document.getElementById('btn-virginia-tab-add');
  if (tab === 'add') {
    if (bList) {
      bList.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] py-2 text-center border-r border-[#d9d9d9] focus:outline-none transition-colors';
    }
    if (bAdd) {
      bAdd.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] py-2 text-center focus:outline-none transition-colors';
    }
    if (triggerModal) quickAddFixedExpense('Virginia');
  } else {
    if (bList) {
      bList.className = 'text-xs sm:text-sm font-black text-[#536460] border-b-2 border-[#536460] py-2 text-center border-r border-[#d9d9d9] focus:outline-none transition-colors';
    }
    if (bAdd) {
      bAdd.className = 'text-xs sm:text-sm font-bold text-[#536460]/70 hover:text-[#536460] py-2 text-center focus:outline-none transition-colors';
    }
    const modal = document.getElementById('fixed-expense-modal');
    if (modal && !modal.classList.contains('hidden') && triggerModal) {
      toggleFixedExpenseModal(false);
    }
  }
}

// Función centralizada de reseteo: Gastos Fijos
function resetFixedExpenseForm_() {
  const form = document.getElementById('fixed-expense-form');
  if (form) form.reset();

  const descEl = document.getElementById('fixed-desc');
  if (descEl) descEl.value = '';

  const unitsEl = document.getElementById('fixed-units');
  if (unitsEl) unitsEl.value = 1;

  setMoneyValue('fixed-amount', '');
  setMoneyValue('fixed-unit-price', '');

  const typeSel = document.getElementById('fixed-type-select');
  if (typeSel) typeSel.value = 'gasto';

  const currSel = document.getElementById('fixed-currency');
  if (currSel) currSel.value = 'ARS';

  const chkDirect = document.getElementById('chk-fixed-is-direct');
  if (chkDirect) {
    chkDirect.checked = true;
    toggleFixedMode(true);
  }

  const chkReplicate = document.getElementById('chk-replicate-12-months');
  if (chkReplicate) chkReplicate.checked = true;

  currentEditingFixedExpenseId = null;
  currentEditingFixedExpenseUser = null;

  const cDelete = document.getElementById('container-delete-fixed');
  const cDisable = document.getElementById('container-disable-fixed');
  const cPause = document.getElementById('container-pause-fixed');
  const btnDelete = document.getElementById('btn-delete-fixed');
  const btnDisable = document.getElementById('btn-disable-fixed');
  const btnPause = document.getElementById('btn-pause-fixed');

  if (cDelete) {
    cDelete.classList.add('hidden');
    cDelete.style.display = 'none';
  }
  if (btnDelete) {
    btnDelete.classList.add('hidden');
    btnDelete.style.display = 'none';
    btnDelete.setAttribute('disabled', 'true');
  }
  if (cDisable) {
    cDisable.classList.add('hidden');
    cDisable.style.display = 'none';
  }
  if (btnDisable) {
    btnDisable.classList.add('hidden');
    btnDisable.style.display = 'none';
    btnDisable.setAttribute('disabled', 'true');
  }
  if (cPause) {
    cPause.classList.add('hidden');
    cPause.style.display = 'none';
  }
  if (btnPause) {
    btnPause.classList.add('hidden');
    btnPause.style.display = 'none';
    btnPause.setAttribute('disabled', 'true');
  }
}

// Edición de Gastos Fijos y Deudas
function openFixedExpenseModal(user, expenseId) {
  if (!expenseId) {
    resetFixedExpenseForm_();
    currentEditingFixedExpenseUser = user;
    currentEditingFixedExpenseId = null;
    const cDel = document.getElementById('container-delete-fixed');
    const cDis = document.getElementById('container-disable-fixed');
    const cPau = document.getElementById('container-pause-fixed');
    const btnDel = document.getElementById('btn-delete-fixed');
    const btnDis = document.getElementById('btn-disable-fixed');
    const btnPau = document.getElementById('btn-pause-fixed');
    if (cDel) {
      cDel.classList.add('hidden');
      cDel.style.display = 'none';
    }
    if (btnDel) {
      btnDel.classList.add('hidden');
      btnDel.style.display = 'none';
      btnDel.setAttribute('disabled', 'true');
    }
    if (cDis) {
      cDis.classList.add('hidden');
      cDis.style.display = 'none';
    }
    if (btnDis) {
      btnDis.classList.add('hidden');
      btnDis.style.display = 'none';
      btnDis.setAttribute('disabled', 'true');
    }
    if (cPau) {
      cPau.classList.add('hidden');
      cPau.style.display = 'none';
    }
    if (btnPau) {
      btnPau.classList.add('hidden');
      btnPau.style.display = 'none';
      btnPau.setAttribute('disabled', 'true');
    }
  } else {
    currentEditingFixedExpenseUser = user;
    currentEditingFixedExpenseId = expenseId;
    const btnDel = document.getElementById('btn-delete-fixed');
    if (btnDel) {
      btnDel.removeAttribute('disabled');
      btnDel.style.display = '';
    }
    const btnDis = document.getElementById('btn-disable-fixed');
    if (btnDis) {
      btnDis.removeAttribute('disabled');
      btnDis.style.display = '';
    }
    const btnPau = document.getElementById('btn-pause-fixed');
    if (btnPau) {
      btnPau.removeAttribute('disabled');
      btnPau.style.display = '';
    }
  }
  const userLabel = document.getElementById('fixed-user-label');
  if (userLabel) userLabel.textContent = user;
  const avatarLabel = document.getElementById('fixed-avatar-label');
  if (avatarLabel) avatarLabel.textContent = user === 'Virginia' ? 'V' : 'B';

  if (user === 'Brian') setBrianInnerTab(expenseId ? 'list' : 'add', false);
  if (user === 'Virginia') setVirginiaInnerTab(expenseId ? 'list' : 'add', false);

  attachMoneyInput('fixed-amount', () => { });
  attachMoneyInput('fixed-unit-price', () => updateFixedTotalFromUnits());

  const cDelete = document.getElementById('container-delete-fixed');
  const cDisable = document.getElementById('container-disable-fixed');
  const cPause = document.getElementById('container-pause-fixed');

  const btnDelete = document.getElementById('btn-delete-fixed');
  const btnDisable = document.getElementById('btn-disable-fixed');
  const btnPause = document.getElementById('btn-pause-fixed');

  if (expenseId) {
    const g = (appState.macroData && appState.macroData.gastosFijos || []).find(x => String(x.id) === String(expenseId));
    if (g) {
      const tipoVal = (g.tipo === 'debt' || g.tipo === 'deuda') ? 'deuda' : 'gasto';
      document.getElementById('fixed-type-select').value = tipoVal;
      document.getElementById('fixed-desc').value = g.descripcion || '';
      document.getElementById('fixed-currency').value = g.moneda || 'ARS';

      const isDirect = (g.isDirect !== undefined && g.isDirect !== null) ? aBooleano_(g.isDirect) : true;
      const chkDirect = document.getElementById('chk-fixed-is-direct');
      if (chkDirect) chkDirect.checked = isDirect;
      toggleFixedMode(isDirect);

      if (!isDirect) {
        document.getElementById('fixed-units').value = g.units || 1;
        setMoneyValue('fixed-unit-price', g.unitPrice || 0);
      } else {
        document.getElementById('fixed-units').value = 1;
        setMoneyValue('fixed-unit-price', '');
      }
      setMoneyValue('fixed-amount', g.monto || 0);

      if (cDelete) {
        cDelete.classList.remove('hidden');
        cDelete.style.display = '';
      }
      if (btnDelete) {
        btnDelete.classList.remove('hidden');
        btnDelete.style.display = '';
        btnDelete.removeAttribute('disabled');
      }

      if (cDisable) {
        cDisable.classList.remove('hidden');
        cDisable.style.display = '';
      }
      if (btnDisable) {
        btnDisable.classList.remove('hidden');
        btnDisable.style.display = '';
        btnDisable.removeAttribute('disabled');
        if (g.tieneExcepcionEsteMes && g.monto === 0) {
          btnDisable.textContent = 'Habilitar';
          btnDisable.title = 'Habilitar para este mes';
          btnDisable.onclick = enableFixedExpenseThisMonth;
        } else {
          btnDisable.textContent = 'Deshab.';
          btnDisable.title = 'Deshabilitar solo este mes ($ 0)';
          btnDisable.onclick = disableFixedExpenseThisMonth;
        }
      }

      if (cPause) {
        cPause.classList.remove('hidden');
        cPause.style.display = '';
      }
      const labelPause = document.getElementById('label-pause-fixed');
      if (labelPause) labelPause.textContent = 'De acá en adelante';
      if (btnPause) {
        btnPause.classList.remove('hidden');
        btnPause.style.display = '';
        btnPause.removeAttribute('disabled');
        if (g.esPausado) {
          btnPause.textContent = 'Reanudar';
          btnPause.title = 'Reanudar de acá en adelante';
          btnPause.onclick = reactivateFixedExpenseFuture;
        } else {
          btnPause.textContent = 'Pausar';
          btnPause.title = 'Pausar de acá en adelante';
          btnPause.onclick = pauseFixedExpenseFuture;
        }
      }
    }
  } else {
    resetFixedExpenseForm_();
    currentEditingFixedExpenseUser = user;
    currentEditingFixedExpenseId = null;
    const cDel = document.getElementById('container-delete-fixed');
    const cDis = document.getElementById('container-disable-fixed');
    const cPau = document.getElementById('container-pause-fixed');
    const btnDel = document.getElementById('btn-delete-fixed');
    const btnDis = document.getElementById('btn-disable-fixed');
    const btnPau = document.getElementById('btn-pause-fixed');
    if (cDel) {
      cDel.classList.add('hidden');
      cDel.style.display = 'none';
    }
    if (btnDel) {
      btnDel.classList.add('hidden');
      btnDel.style.display = 'none';
      btnDel.setAttribute('disabled', 'true');
    }
    if (cDis) {
      cDis.classList.add('hidden');
      cDis.style.display = 'none';
    }
    if (btnDis) {
      btnDis.classList.add('hidden');
      btnDis.style.display = 'none';
      btnDis.setAttribute('disabled', 'true');
    }
    if (cPau) {
      cPau.classList.add('hidden');
      cPau.style.display = 'none';
    }
    if (btnPau) {
      btnPau.classList.add('hidden');
      btnPau.style.display = 'none';
      btnPau.setAttribute('disabled', 'true');
    }
  }

  toggleFixedExpenseModal(true);
}

function toggleFixedExpenseModal(show) {
  const modal = document.getElementById('fixed-expense-modal');
  const dash = document.getElementById('macro-dashboard-view');
  if (show) {
    if (dash) dash.classList.add('hidden');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('fixed-expense-modal');
  } else {
    resetFixedExpenseForm_();
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
    setBrianInnerTab('list', false);
    setVirginiaInnerTab('list', false);
  }
}

function toggleFixedMode(isDirect) {
  const container = document.getElementById('fixed-units-container');
  if (container) container.classList.toggle('hidden', isDirect);
}

function updateFixedTotalFromUnits() {
  const units = parseInt(document.getElementById('fixed-units').value, 10) || 1;
  const unitPrice = getMoneyValue('fixed-unit-price');
  setMoneyValue('fixed-amount', units * unitPrice);
}

function handleFixedExpenseSubmit() {
  const idToSave = currentEditingFixedExpenseId;
  const userToSave = currentEditingFixedExpenseUser || appState.activeUser || 'Brian';

  const tipo = document.getElementById('fixed-type-select').value;
  const descripcion = document.getElementById('fixed-desc').value.trim();
  const isDirect = document.getElementById('chk-fixed-is-direct').checked;
  const units = parseInt(document.getElementById('fixed-units').value, 10) || 1;
  const unitPrice = getMoneyValue('fixed-unit-price');
  const monto = getMoneyValue('fixed-amount');
  const moneda = document.getElementById('fixed-currency').value;
  const replicate = document.getElementById('chk-replicate-12-months').checked;

  if (!descripcion) { alert('Ingresá una descripción'); return; }
  if (monto < 0) { alert('Ingresá un monto válido'); return; }

  toggleFixedExpenseModal(false);

  // Optimistic UI Update
  if (appState.macroData && appState.macroData.gastosFijos) {
    const list = appState.macroData.gastosFijos;
    let item = idToSave ? list.find(x => String(x.id) === String(idToSave)) : null;

    if (!item) {
      item = {
        id: idToSave || ('temp_fe_' + Date.now()),
        usuario: userToSave,
        descripcion: descripcion,
        tipo: (tipo === 'debt' || tipo === 'deuda') ? 'deuda' : 'gasto',
        isDirect: isDirect,
        units: isDirect ? 1 : units,
        unitPrice: isDirect ? monto : unitPrice,
        monto: monto,
        montoBase: monto,
        moneda: moneda,
        activoDesdeYear: appState.currentMacroYear,
        activoDesdeMonth: appState.currentMacroMonth,
        hastaYear: null,
        hastaMonth: null,
        esPausado: false,
        tieneExcepcionEsteMes: !replicate
      };
      list.push(item);
    } else {
      item.descripcion = descripcion;
      item.usuario = userToSave;
      item.tipo = (tipo === 'debt' || tipo === 'deuda') ? 'deuda' : 'gasto';
      item.isDirect = isDirect;
      item.units = isDirect ? 1 : units;
      item.unitPrice = isDirect ? monto : unitPrice;
      item.monto = monto;
      item.moneda = moneda;
      if (!replicate) item.tieneExcepcionEsteMes = true;
    }
    renderMacroView();
  }

  if (replicate) {
    callBackendBackground('guardarGastoFijo', {
      id: idToSave,
      usuario: userToSave,
      descripcion: descripcion,
      tipo: tipo,
      isDirect: isDirect,
      units: isDirect ? 1 : units,
      unitPrice: isDirect ? monto : unitPrice,
      monto: monto,
      moneda: moneda,
      activoDesdeYear: appState.currentMacroYear,
      activoDesdeMonth: appState.currentMacroMonth,
      hastaYear: null,
      hastaMonth: null
    }).then(() => recargarEstadoMensual_());
  } else {
    callBackendBackground('guardarExcepcionGastoFijo', {
      groupId: idToSave,
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      unitsOverride: isDirect ? null : units,
      montoOverride: monto
    }).then(() => recargarEstadoMensual_());
  }
}

function disableFixedExpenseThisMonth() {
  const idTarget = currentEditingFixedExpenseId;
  if (!idTarget) return;
  toggleFixedExpenseModal(false);

  if (appState.macroData && appState.macroData.gastosFijos) {
    const item = appState.macroData.gastosFijos.find(x => String(x.id) === String(idTarget));
    if (item) {
      item.monto = 0;
      item.tieneExcepcionEsteMes = true;
    }
    renderMacroView();
  }

  callBackendBackground('guardarExcepcionGastoFijo', {
    groupId: idTarget,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    montoOverride: 0
  }).then(() => recargarEstadoMensual_());
}

function enableFixedExpenseThisMonth() {
  const idTarget = currentEditingFixedExpenseId;
  if (!idTarget) return;
  toggleFixedExpenseModal(false);

  if (appState.macroData && appState.macroData.gastosFijos) {
    const item = appState.macroData.gastosFijos.find(x => String(x.id) === String(idTarget));
    if (item) {
      item.monto = item.montoBase !== undefined ? item.montoBase : item.monto;
      item.tieneExcepcionEsteMes = false;
    }
    renderMacroView();
  }

  callBackendBackground('guardarExcepcionGastoFijo', {
    groupId: idTarget,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    montoOverride: null
  }).then(() => recargarEstadoMensual_());
}

function pauseFixedExpenseFuture() {
  const idTarget = currentEditingFixedExpenseId;
  if (!idTarget) return;
  const g = (appState.macroData && appState.macroData.gastosFijos || []).find(x => String(x.id) === String(idTarget));
  if (!g) return;

  toggleFixedExpenseModal(false);

  let targetMonth = appState.currentMacroMonth - 1;
  let targetYear = appState.currentMacroYear;
  if (targetMonth < 0) {
    targetMonth = 11;
    targetYear--;
  }

  g.esPausado = true;
  g.monto = 0;
  g.hastaYear = targetYear;
  g.hastaMonth = targetMonth;
  renderMacroView();

  callBackendBackground('guardarGastoFijo', {
    id: g.id,
    usuario: g.usuario,
    descripcion: g.descripcion,
    tipo: g.tipo,
    isDirect: g.isDirect,
    units: g.units,
    unitPrice: g.unitPrice,
    monto: g.montoBase !== undefined ? g.montoBase : g.monto,
    moneda: g.moneda,
    activoDesdeYear: g.activoDesdeYear || appState.currentMacroYear,
    activoDesdeMonth: (g.activoDesdeMonth !== undefined && g.activoDesdeMonth !== null) ? g.activoDesdeMonth : 0,
    hastaYear: targetYear,
    hastaMonth: targetMonth
  }).then(() => recargarEstadoMensual_());
}

function reactivateFixedExpenseFuture() {
  const idTarget = currentEditingFixedExpenseId;
  if (!idTarget) return;
  const g = (appState.macroData && appState.macroData.gastosFijos || []).find(x => String(x.id) === String(idTarget));
  if (!g) return;

  toggleFixedExpenseModal(false);

  g.esPausado = false;
  g.monto = g.montoBase !== undefined ? g.montoBase : g.monto;
  g.hastaYear = null;
  g.hastaMonth = null;
  renderMacroView();

  callBackendBackground('guardarGastoFijo', {
    id: g.id,
    usuario: g.usuario,
    descripcion: g.descripcion,
    tipo: g.tipo,
    isDirect: g.isDirect,
    units: g.units,
    unitPrice: g.unitPrice,
    monto: g.montoBase !== undefined ? g.montoBase : g.monto,
    moneda: g.moneda,
    activoDesdeYear: g.activoDesdeYear || appState.currentMacroYear,
    activoDesdeMonth: (g.activoDesdeMonth !== undefined && g.activoDesdeMonth !== null) ? g.activoDesdeMonth : 0,
    hastaYear: null,
    hastaMonth: null
  }).then(() => recargarEstadoMensual_());
}

function deleteCurrentEditingFixedExpense() {
  const idTarget = currentEditingFixedExpenseId;
  if (!idTarget) return;
  toggleFixedExpenseModal(false);

  if (appState.macroData && appState.macroData.gastosFijos) {
    appState.macroData.gastosFijos = appState.macroData.gastosFijos.filter(x => String(x.id) !== String(idTarget));
    renderMacroView();
  }

  callBackendBackground('eliminarGastoFijo', { id: idTarget })
    .then(() => recargarEstadoMensual_());
}

// BATCH UPDATE DE MACRO CONFIG
function saveMacroConfig() {
  if (!macroDraft) {
    if (typeof toggleMacroConfigModal === 'function') toggleMacroConfigModal(false);
    return;
  }

  const draft = macroDraft;
  if (typeof toggleMacroConfigModal === 'function') {
    toggleMacroConfigModal(false);
  } else {
    const modal = document.getElementById('macro-config-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
  }

  const macroDash = document.getElementById('macro-dashboard-view');
  if (macroDash) macroDash.classList.remove('hidden');
  if (typeof setMacroSubTab === 'function') setMacroSubTab('resumen', false);

  // Optimistic UI Update
  if (appState.macroData) {
    appState.macroData.usdRate = draft.usdRate;
    appState.macroData.salaryBrian = draft.salaryBrian;
    appState.macroData.salaryVirginia = draft.salaryVirginia;
    appState.macroData.serviciosFijos = draft.serviciosFijos;
    renderMacroView();
  }

  callBackendBackground('guardarConfiguracionMacroBatch', {
    usdRate: draft.usdRate,
    salaryBrian: draft.salaryBrian,
    salaryVirginia: draft.salaryVirginia,
    serviciosFijos: draft.serviciosFijos,
    serviciosEliminados: draft.serviciosEliminados,
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth
  }).then(newMacroData => {
    if (newMacroData) {
      appState.macroData = newMacroData;
      renderMacroView();
    }
  });

  macroDraft = null;
}

// Modal de Acción Rápida (+) en Mensual
function toggleQuickAddModal(show) {
  const modal = document.getElementById('quick-add-modal');
  if (modal) {
    modal.classList.toggle('active', !!show);
  } else if (typeof toggleMacroFabMenu === 'function') {
    toggleMacroFabMenu(!!show);
  }
}

function quickAddService() {
  toggleQuickAddModal(false);
  openServiceEditModal(null);
}

function quickAddFixedExpense(user) {
  toggleQuickAddModal(false);
  openFixedExpenseModal(user, null);
}

// ============================================================
// MODAL: AJUSTES DE SUELDO UNIFICADO (BRIAN & VIRGINIA)
// ============================================================

function openSalaryAdjustModal() {
  const data = appState.macroData || {};
  const baseBrian = data.salaryBrian || 0;
  const baseVirginia = data.salaryVirginia || 0;
  const prizeBrian = data.premioBrian !== undefined ? data.premioBrian : (data.premio || 0);
  const prizeVirginia = data.premioVirginia || 0;

  const elBaseB = document.getElementById('salary-adjust-base-brian');
  const elBaseV = document.getElementById('salary-adjust-base-virginia');
  if (elBaseB) elBaseB.textContent = formatearMoneda_(baseBrian);
  if (elBaseV) elBaseV.textContent = formatearMoneda_(baseVirginia);

  // Inputs vacíos por defecto: sólo se pre-llenan si existe una diferencia explícita previamente guardada
  if (prizeBrian !== 0) {
    setMoneyValue('salary-adjust-input-brian', baseBrian + prizeBrian);
  } else {
    setMoneyValue('salary-adjust-input-brian', 0);
    const inB = document.getElementById('salary-adjust-input-brian');
    if (inB) inB.value = '';
  }

  if (prizeVirginia !== 0) {
    setMoneyValue('salary-adjust-input-virginia', baseVirginia + prizeVirginia);
  } else {
    setMoneyValue('salary-adjust-input-virginia', 0);
    const inV = document.getElementById('salary-adjust-input-virginia');
    if (inV) inV.value = '';
  }

  // SAC / Aguinaldo en Junio (mes 5) y Diciembre (mes 11)
  const esSacMonth = (data.month === 5 || data.month === 11);
  const sacSection = document.getElementById('salary-adjust-sac-section');
  if (sacSection) {
    sacSection.classList.toggle('hidden', !esSacMonth);
  }
  if (esSacMonth) {
    const elSacBaseB = document.getElementById('salary-adjust-sac-base-brian');
    const elSacBaseV = document.getElementById('salary-adjust-sac-base-virginia');
    if (elSacBaseB) elSacBaseB.textContent = formatearMoneda_(baseBrian / 2);
    if (elSacBaseV) elSacBaseV.textContent = formatearMoneda_(baseVirginia / 2);

    // Arrancan vacíos a menos que exista un valor previamente guardado
    if (data.sacBrian !== null && data.sacBrian !== undefined && data.sacBrian > 0) {
      setMoneyValue('salary-adjust-sac-input-brian', data.sacBrian);
    } else {
      setMoneyValue('salary-adjust-sac-input-brian', 0);
      const inSacB = document.getElementById('salary-adjust-sac-input-brian');
      if (inSacB) inSacB.value = '';
    }

    if (data.sacVirginia !== null && data.sacVirginia !== undefined && data.sacVirginia > 0) {
      setMoneyValue('salary-adjust-sac-input-virginia', data.sacVirginia);
    } else {
      setMoneyValue('salary-adjust-sac-input-virginia', 0);
      const inSacV = document.getElementById('salary-adjust-sac-input-virginia');
      if (inSacV) inSacV.value = '';
    }

    attachMoneyInput('salary-adjust-sac-input-brian', () => {});
    attachMoneyInput('salary-adjust-sac-input-virginia', () => {});
  }

  updateSalaryAdjustTotals_();

  attachMoneyInput('salary-adjust-input-brian', () => updateSalaryAdjustTotals_());
  attachMoneyInput('salary-adjust-input-virginia', () => updateSalaryAdjustTotals_());

  toggleSalaryAdjustModal(true);
}

function updateSalaryAdjustTotals_() {
  const data = appState.macroData || {};
  const baseBrian = data.salaryBrian || 0;
  const baseVirginia = data.salaryVirginia || 0;
  const totalIngresadoBrian = getMoneyValue('salary-adjust-input-brian');
  const totalIngresadoVirginia = getMoneyValue('salary-adjust-input-virginia');

  // Cálculo según especificación:
  // deltaBrian = totalIngresadoBrian > 0 ? (totalIngresadoBrian - baseBrian) : 0
  // deltaVirginia = totalIngresadoVirginia > 0 ? (totalIngresadoVirginia - baseVirginia) : 0
  const deltaBrian = totalIngresadoBrian > 0 ? (totalIngresadoBrian - baseBrian) : 0;
  const deltaVirginia = totalIngresadoVirginia > 0 ? (totalIngresadoVirginia - baseVirginia) : 0;

  function formatoDiferencia(delta) {
    if (delta > 0) return '+$ ' + formatearMoneda_(delta).replace('$', '').trim();
    if (delta < 0) return '-$ ' + formatearMoneda_(Math.abs(delta)).replace('$', '').trim();
    return '$ 0,00';
  }

  const elDiffB = document.getElementById('salary-adjust-diff-brian');
  const elDiffV = document.getElementById('salary-adjust-diff-virginia');
  const elTotB = document.getElementById('salary-adjust-total-brian');
  const elTotV = document.getElementById('salary-adjust-total-virginia');

  if (elDiffB) {
    elDiffB.textContent = formatoDiferencia(deltaBrian);
    elDiffB.className = deltaBrian > 0 ? 'font-bold text-emerald-600' : (deltaBrian < 0 ? 'font-bold text-rose-600' : 'font-bold text-zinc-700');
  }
  if (elDiffV) {
    elDiffV.textContent = formatoDiferencia(deltaVirginia);
    elDiffV.className = deltaVirginia > 0 ? 'font-bold text-emerald-600' : (deltaVirginia < 0 ? 'font-bold text-rose-600' : 'font-bold text-zinc-700');
  }
  if (elTotB) elTotB.textContent = formatoDiferencia(deltaBrian);
  if (elTotV) elTotV.textContent = formatoDiferencia(deltaVirginia);
}

function toggleSalaryAdjustModal(show) {
  const modal = document.getElementById('salary-adjust-modal');
  const dash = document.getElementById('macro-dashboard-view');
  if (show) {
    if (dash) dash.classList.add('hidden');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('salary-adjust-modal');
  } else {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

async function handleSalaryAdjustSubmit() {
  const data = appState.macroData || {};
  const baseBrian = data.salaryBrian || 0;
  const baseVirginia = data.salaryVirginia || 0;
  const totalIngresadoBrian = getMoneyValue('salary-adjust-input-brian');
  const totalIngresadoVirginia = getMoneyValue('salary-adjust-input-virginia');

  const deltaBrian = totalIngresadoBrian > 0 ? (totalIngresadoBrian - baseBrian) : 0;
  const deltaVirginia = totalIngresadoVirginia > 0 ? (totalIngresadoVirginia - baseVirginia) : 0;

  const esSacMonth = (data.month === 5 || data.month === 11);
  let sacBrian = null;
  let sacVirginia = null;
  if (esSacMonth) {
    sacBrian = getMoneyValue('salary-adjust-sac-input-brian');
    sacVirginia = getMoneyValue('salary-adjust-sac-input-virginia');
  }

  toggleSalaryAdjustModal(false);

  // Actualización optimista de macroData
  data.premio = deltaBrian;
  data.premioBrian = deltaBrian;
  data.premioVirginia = deltaVirginia;
  if (esSacMonth) {
    data.sacBrian = sacBrian;
    data.sacVirginia = sacVirginia;
  }
  renderMacroView();

  // Envío exclusivo de las diferencias calculadas al backend mediante guardarPremio
  callBackendBackground('guardarPremio', {
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    usuario: 'Brian',
    monto: deltaBrian
  });
  callBackendBackground('guardarPremio', {
    year: appState.currentMacroYear,
    month: appState.currentMacroMonth,
    usuario: 'Virginia',
    monto: deltaVirginia
  });

  // Envío de SAC override en meses de aguinaldo
  if (esSacMonth) {
    callBackendBackground('guardarSacOverride', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      usuario: 'Brian',
      monto: sacBrian
    });
    callBackendBackground('guardarSacOverride', {
      year: appState.currentMacroYear,
      month: appState.currentMacroMonth,
      usuario: 'Virginia',
      monto: sacVirginia
    });
  }
}

// ============================================================
// NAVEGACIÓN ANCLADA A ESTADOS DE PANTALLA (DEFINITIVA)
// ============================================================

let exitToastTimeout = null;
let lastBackPressTime = 0;

function showExitToast_() {
  const toast = document.getElementById('exit-toast');
  if (!toast) return;
  toast.textContent = 'Presioná dos veces seguidas para salir';
  toast.style.backgroundColor = 'rgba(39, 39, 42, 0.95)';
  toast.classList.add('active');
  if (exitToastTimeout) clearTimeout(exitToastTimeout);
  exitToastTimeout = setTimeout(() => {
    toast.classList.remove('active');
  }, 2000);
}

function closeAllActiveModalsWithoutSaving_() {
  if (typeof toggleHbModal === 'function') toggleHbModal(false);
  if (typeof toggleBudgetAuditModal === 'function') toggleBudgetAuditModal(false);
  if (typeof toggleFutureDaysModal === 'function') toggleFutureDaysModal(false);
  if (typeof toggleMacroConfigModal === 'function') toggleMacroConfigModal(false);
  if (typeof toggleValueEditModal === 'function') toggleValueEditModal(false);
  if (typeof toggleFixedExpenseModal === 'function') toggleFixedExpenseModal(false);
  if (typeof toggleServiceEditModal === 'function') toggleServiceEditModal(false);
  if (typeof toggleQuickAddModal === 'function') toggleQuickAddModal(false);
  if (typeof toggleSalaryAdjustModal === 'function') toggleSalaryAdjustModal(false);
  if (typeof setMicroSubView === 'function') setMicroSubView('list', false);

  // Destrucción obligatoria de estado en formularios (Zero-Draft Persistence)
  if (typeof resetTxForm_ === 'function') resetTxForm_();
  if (typeof resetFixedExpenseForm_ === 'function') resetFixedExpenseForm_();
  if (typeof resetServiceForm_ === 'function') resetServiceForm_();

  const activeModals = document.querySelectorAll('.modal-overlay.active, .modal.active');
  activeModals.forEach(m => m.classList.remove('active'));

  const microDash = document.getElementById('micro-dashboard-view');
  if (microDash && appState.currentView === 'micro') microDash.classList.remove('hidden');

  const macroDash = document.getElementById('macro-dashboard-view');
  if (macroDash && appState.currentView === 'macro') macroDash.classList.remove('hidden');

  if (appState.currentView === 'macro') {
    const pBrian = document.getElementById('macro-subpanel-brian');
    const pVirginia = document.getElementById('macro-subpanel-virginia');
    const cExpenses = document.getElementById('resumen-content-expenses');
    if (pBrian && !pBrian.classList.contains('hidden')) {
      if (typeof setMacroSubTab === 'function') setMacroSubTab('resumen', false);
    } else if (pVirginia && !pVirginia.classList.contains('hidden')) {
      if (typeof setMacroSubTab === 'function') setMacroSubTab('resumen', false);
    } else if (cExpenses && !cExpenses.classList.contains('hidden')) {
      if (typeof setResumenInnerTab === 'function') setResumenInnerTab('incomes', false);
    } else {
      if (typeof switchView === 'function') switchView('micro', false);
    }
  }
}

function closeAllActiveModals_() {
  closeAllActiveModalsWithoutSaving_();
}

function pushModalHistory_(modalId) {
  try {
    history.pushState({ subview: modalId || 'subview' }, '');
  } catch (e) {}
}

// Helper: Determina el identificador de la pantalla visible ACTUAL
function getCurrentScreenState() {
  // 1. Modales flotantes (diálogos)
  const activeModal = document.querySelector('.modal-overlay.active, .modal.active');
  if (activeModal) return 'MODAL';

  // 2. Menú FAB
  const fabMenu = document.getElementById('macro-fab-menu');
  if (fabMenu && !fabMenu.classList.contains('hidden')) return 'FAB_MENU';

  // 3. Módulo Diario -> Subvistas de tarjeta
  const viewMicro = document.getElementById('view-micro');
  const isMicroView = appState.currentView === 'micro' || (viewMicro && !viewMicro.classList.contains('hidden'));
  if (isMicroView) {
    const hbModal = document.getElementById('hb-modal');
    if (hbModal && !hbModal.classList.contains('hidden')) return 'MICRO_HB';

    const auditModal = document.getElementById('budget-audit-modal');
    if (auditModal && !auditModal.classList.contains('hidden')) return 'MICRO_AUDIT';

    const futureModal = document.getElementById('future-days-modal');
    if (futureModal && !futureModal.classList.contains('hidden')) return 'MICRO_FUTURE_DAYS';

    const panelAdd = document.getElementById('micro-panel-add');
    if (panelAdd && !panelAdd.classList.contains('hidden')) return 'MICRO_REGISTER';
  }

  // 4. Módulo Mensual -> Subvistas de tarjeta
  const viewMacro = document.getElementById('view-macro');
  const isMacroView = appState.currentView === 'macro' || (viewMacro && !viewMacro.classList.contains('hidden'));
  if (isMacroView) {
    const valModal = document.getElementById('value-edit-modal');
    const srvModal = document.getElementById('service-edit-modal');
    if (valModal && !valModal.classList.contains('hidden')) return 'MACRO_VALUE_EDIT';
    if (srvModal && !srvModal.classList.contains('hidden')) return 'MACRO_SERVICE_EDIT';

    const cfgModal = document.getElementById('macro-config-modal');
    if (cfgModal && !cfgModal.classList.contains('hidden')) return 'MACRO_CONFIG';

    const salModal = document.getElementById('salary-adjust-modal');
    if (salModal && !salModal.classList.contains('hidden')) return 'MACRO_SALARY_ADJUST';

    const fixModal = document.getElementById('fixed-expense-modal');
    if (fixModal && !fixModal.classList.contains('hidden')) return 'MACRO_FIXED_EXPENSE';

    // Subpestañas Mensual
    const pBrian = document.getElementById('macro-subpanel-brian');
    const pVirginia = document.getElementById('macro-subpanel-virginia');
    const cExpenses = document.getElementById('resumen-content-expenses');

    if (pBrian && !pBrian.classList.contains('hidden')) return 'MACRO_BRIAN';
    if (pVirginia && !pVirginia.classList.contains('hidden')) return 'MACRO_VIRGINIA';
    if (cExpenses && !cExpenses.classList.contains('hidden')) return 'MACRO_TOTAL_EXPENSES';
    return 'MACRO_HOME'; // Resumen Detalle Sueldos
  }

  // 5. Módulo Diario -> Home Principal
  return 'MICRO_HOME';
}

function initAndroidBackHistory_() {
  // Sombra inicial de freno de mano para la Home
  try {
    history.pushState({ page: 'home_guard' }, '');
  } catch (e) {}

  window.addEventListener('popstate', (e) => {
    const current = getCurrentScreenState();

    if (current === 'MICRO_HOME') {
      const now = Date.now();
      // Si presiona Back dos veces en menos de 2 segundos en la Home
      if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
        lastBackPressTime = 0;
        // Permite la salida de la app
        if (navigator.app && navigator.app.exitApp) {
          navigator.app.exitApp();
        } else if (window.App && window.App.exitApp) {
          window.App.exitApp();
        } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.exitApp();
        } else {
          history.back();
        }
        return;
      }
      lastBackPressTime = now;
      showExitToast_();
      // Re-siembra el freno de mano en Home
      try {
        history.pushState({ page: 'home_guard' }, '');
      } catch (err) {}
    } else {
      // Si estaba en una subvista o modal, el evento popstate consumió el paso del historial.
      // Simplemente cerramos la subvista activa en la interfaz sin salir de la app.
      lastBackPressTime = 0;
      closeAllActiveModalsWithoutSaving_();
    }
  });

  // Escucha de Evento backbutton de Hardware (Android / Cordova / APK / Capacitor)
  document.addEventListener('backbutton', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const current = getCurrentScreenState();
    if (current === 'MICRO_HOME') {
      const now = Date.now();
      if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
        lastBackPressTime = 0;
        if (navigator.app && navigator.app.exitApp) {
          navigator.app.exitApp();
        } else if (window.App && window.App.exitApp) {
          window.App.exitApp();
        } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.exitApp();
        } else {
          history.back();
        }
        return;
      }
      lastBackPressTime = now;
      showExitToast_();
    } else {
      lastBackPressTime = 0;
      closeAllActiveModalsWithoutSaving_();
    }
  }, false);

  // Compatibilidad con Capacitor App Plugin
  if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    try {
      window.Capacitor.Plugins.App.addListener('backButton', () => {
        const current = getCurrentScreenState();
        if (current === 'MICRO_HOME') {
          const now = Date.now();
          if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
            if (window.Capacitor.Plugins.App.exitApp) {
              window.Capacitor.Plugins.App.exitApp();
            }
            return;
          }
          lastBackPressTime = now;
          showExitToast_();
        } else {
          lastBackPressTime = 0;
          closeAllActiveModalsWithoutSaving_();
        }
      });
    } catch (err) {
      console.warn('Error inicializando Capacitor backButton listener:', err);
    }
  }
}

function initVerticalSwipeGesture_() {
  const viewport = document.getElementById('app-viewport') || document.body;
  let touchStartY = 0;
  let touchStartX = 0;
  let touchStartTime = 0;
  let didScrollDuringTouch = false;

  const onScrollDuringTouch = () => {
    didScrollDuringTouch = true;
  };

  viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartY = t.clientY;
    touchStartX = t.clientX;
    touchStartTime = Date.now();
    didScrollDuringTouch = false;

    window.addEventListener('scroll', onScrollDuringTouch, { passive: true, capture: true });
    document.addEventListener('scroll', onScrollDuringTouch, { passive: true, capture: true });
  }, { passive: true });

  viewport.addEventListener('touchend', (e) => {
    window.removeEventListener('scroll', onScrollDuringTouch, { capture: true });
    document.removeEventListener('scroll', onScrollDuringTouch, { capture: true });

    if (e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const deltaY = t.clientY - touchStartY;
    const deltaX = t.clientX - touchStartX;
    const time = Date.now() - touchStartTime;

    // 1. SOPORTE DE PULL-TO-REFRESH Y SCROLL NATIVO:
    // Los gestos hacia abajo (deltaY >= 0) NUNCA conmutan de módulo, permitiendo el scroll o recarga nativa.
    if (deltaY >= 0) return;

    // 2. Si hay un modal o subvista activa, ignorar conmutación
    if (isAnyCardSubviewOrModalActive_()) return;

    // 3. Si hubo scroll de contenido en pantalla durante el toque, no conmutar
    if (didScrollDuringTouch) return;

    // 4. Conmutación EXCLUSIVAMENTE mediante Swipe UP intencional (deltaY < -180)
    if (deltaY > -180) return;
    if (Math.abs(deltaY) < Math.abs(deltaX) * 1.5) return;
    if (time > 700) return;

    // Ignorar si el toque inició en inputs, select, botones o carruseles horizontales
    const target = document.elementFromPoint(touchStartX, touchStartY);
    if (!target) return;
    if (target.closest('#macro-month-pills, #tx-days-carousel, input, select, textarea, button')) return;

    // Si el toque ocurrió sobre una lista scrolleable que aún no llegó al fondo, respetar el scroll interno
    const scrollable = target.closest('.overflow-y-auto, #transaction-list, #incomes-list, #macro-services-toggle-list, #brian-fixed-list, #virginia-fixed-list');
    if (scrollable) {
      const isAtBottom = (scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 4);
      if (!isAtBottom) return;
    }

    // Estando en Diario conmuta a Mensual; estando en Mensual conmuta a Diario
    if (appState.currentView === 'micro') {
      switchView('macro');
    } else {
      switchView('micro');
    }
  }, { passive: true });
}

function isAnyCardSubviewOrModalActive_() {
  if (document.querySelector('.modal-overlay.active, .modal.active')) return true;
  const fab = document.getElementById('macro-fab-menu');
  if (fab && !fab.classList.contains('hidden')) return true;

  const hb = document.getElementById('hb-modal');
  if (hb && !hb.classList.contains('hidden')) return true;
  const audit = document.getElementById('budget-audit-modal');
  if (audit && !audit.classList.contains('hidden')) return true;
  const fut = document.getElementById('future-days-modal');
  if (fut && !fut.classList.contains('hidden')) return true;

  const fixed = document.getElementById('fixed-expense-modal');
  if (fixed && !fixed.classList.contains('hidden')) return true;
  const cfg = document.getElementById('macro-config-modal');
  if (cfg && !cfg.classList.contains('hidden')) return true;
  const sal = document.getElementById('salary-adjust-modal');
  if (sal && !sal.classList.contains('hidden')) return true;
  const srv = document.getElementById('service-edit-modal');
  if (srv && !srv.classList.contains('hidden')) return true;
  const val = document.getElementById('value-edit-modal');
  if (val && !val.classList.contains('hidden')) return true;

  return false;
}

function initHorizontalSwipeGesture_() {
  const viewport = document.getElementById('app-viewport') || document.body;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isValidSwipeStart = false;

  viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) {
      isValidSwipeStart = false;
      return;
    }
    const t = e.touches[0];
    const clientX = t.clientX;
    const clientY = t.clientY;

    // Margen de seguridad: ignorar toques menores a 30px del borde
    if (clientX < 30 || clientX > window.innerWidth - 30) {
      isValidSwipeStart = false;
      return;
    }

    // Si hay un modal o subvista activa, ignorar swipe
    if (isAnyCardSubviewOrModalActive_()) {
      isValidSwipeStart = false;
      return;
    }

    // Ignorar si el toque inició en inputs, select, botones, o carruseles horizontales
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.closest('#macro-month-pills, #tx-days-carousel, input, select, textarea, button')) {
      isValidSwipeStart = false;
      return;
    }

    touchStartX = clientX;
    touchStartY = clientY;
    touchStartTime = Date.now();
    isValidSwipeStart = true;
  }, { passive: true });

  viewport.addEventListener('touchend', (e) => {
    if (!isValidSwipeStart || e.changedTouches.length !== 1) return;
    isValidSwipeStart = false;

    if (isAnyCardSubviewOrModalActive_()) return;

    const t = e.changedTouches[0];
    const deltaX = t.clientX - touchStartX;
    const deltaY = t.clientY - touchStartY;
    const time = Date.now() - touchStartTime;

    // Umbral mínimo y predominancia horizontal
    if (time > 600) return;
    if (Math.abs(deltaX) < 60) return;
    if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;

    // GESTOS EN MÓDULO DIARIO
    if (appState.currentView === 'micro') {
      const panelAdd = document.getElementById('micro-panel-add');
      const isAddOpen = panelAdd && !panelAdd.classList.contains('hidden');

      if (!isAddOpen) {
        // En Movimientos Registrados: swipe izquierda pasa a Registrar Único
        if (deltaX < -60) {
          setMicroSubView('add', true);
          setTxSubtype('single');
        }
      } else {
        // En Registrar Movimiento
        if (txModalSubtype === 'single') {
          if (deltaX > 60) {
            // Swipe derecha vuelve a Movimientos Registrados
            setMicroSubView('list', true);
          } else if (deltaX < -60) {
            // Swipe izquierda pasa a Divisible
            setTxSubtype('divisible');
          }
        } else if (txModalSubtype === 'divisible') {
          if (deltaX > 60) {
            // Swipe derecha vuelve a Único
            setTxSubtype('single');
          }
        }
      }
      return;
    }

    // GESTOS EN MÓDULO MENSUAL
    if (appState.currentView === 'macro') {
      const pBrian = document.getElementById('macro-subpanel-brian');
      const pVirginia = document.getElementById('macro-subpanel-virginia');
      let currentTab = 'resumen';
      if (pBrian && !pBrian.classList.contains('hidden')) currentTab = 'brian';
      else if (pVirginia && !pVirginia.classList.contains('hidden')) currentTab = 'virginia';

      if (currentTab === 'resumen') {
        if (deltaX < -60) {
          // Swipe izquierda pasa a Brian
          setMacroSubTab('brian');
        }
      } else if (currentTab === 'brian') {
        if (deltaX > 60) {
          // Swipe derecha vuelve a Resumen
          setMacroSubTab('resumen');
        } else if (deltaX < -60) {
          // Swipe izquierda pasa a Virginia
          setMacroSubTab('virginia');
        }
      } else if (currentTab === 'virginia') {
        if (deltaX > 60) {
          // Swipe derecha vuelve a Brian
          setMacroSubTab('brian');
        }
      }
      return;
    }
  }, { passive: true });
}

function autoFitCircleButtons() {
  setTimeout(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll('.btn-circle').forEach(btn => {
        if (btn.classList.contains('hidden') || btn.style.display === 'none' || btn.offsetParent === null) {
          return;
        }
        // Ignorar íconos SVG o botones con signo '+' (ej: agregar movimiento, FAB, etc.)
        if (btn.querySelector('svg')) return;
        const text = btn.innerText ? btn.innerText.trim() : '';
        if (!text || text === '+' || text === '×' || text === '<' || text === '>' || text.includes('+')) {
          return;
        }

        btn.style.padding = '2px';
        btn.style.whiteSpace = 'nowrap';
        btn.style.overflow = 'hidden';
        btn.style.display = 'inline-flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.lineHeight = '1.1';
        btn.style.fontWeight = '700';
        btn.style.boxSizing = 'border-box';

        const isSm = btn.classList.contains('btn-circle-sm');
        const diameter = btn.clientWidth || (isSm ? 50 : 58);

        // Ancho y alto seguro dentro de la circunferencia para máxima legibilidad
        const safeWidth = Math.floor(diameter * 0.86);
        const safeHeight = Math.floor(diameter * 0.76);

        // Para botones pequeños (.btn-circle-sm), inicia en 11.5px y desciende hasta un mínimo de 8.5px
        // Para botones estándar (.btn-circle), inicia en 13px y desciende hasta un mínimo de 9.5px
        let size = isSm ? 11.5 : 13;
        const minSize = isSm ? 8.5 : 9.5;
        btn.style.fontSize = size + 'px';

        while ((btn.scrollWidth > safeWidth || btn.scrollHeight > safeHeight) && size > minSize) {
          size -= 0.5;
          btn.style.fontSize = size + 'px';
        }
      });
    });
  }, 40);
}

// ============================================================
// CARGA DE ESTADO Y BOOTSTRAP
// ============================================================

let diarioLoadToken_ = 0;

async function recargarEstadoDiario_(conToast) {
  const miToken = ++diarioLoadToken_;
  try {
    const cached = localStorage.getItem('cached_diario_state');
    if (cached && !appState.lastProcessedDate) {
      const parsed = JSON.parse(cached);
      if (miToken === diarioLoadToken_) {
        Object.assign(appState, parsed);
        if (appState.currentView === 'micro') renderMicroView();
      }
    }
  } catch (e) {}

  try {
    const data = conToast === false ? await callBackend('getEstadoDiario', {}) : await callBackendConSync('getEstadoDiario', {});
    if (miToken !== diarioLoadToken_) return;

    if (data) {
      appState.homeBankingTotal = data.homeBankingTotal;
      appState.bolsaTotal = data.bolsaTotal;
      appState.diaCobro = data.diaCobro;
      appState.diasRestantes = data.diasRestantes;
      appState.movimientos = (data.movimientos || []).map(m => {
        m.fechasAfectadas = normalizarFechas_(m.fechasAfectadas);
        return m;
      });
      appState.lastProcessedDate = data.lastProcessedDate;

      try {
        localStorage.setItem('cached_diario_state', JSON.stringify({
          homeBankingTotal: appState.homeBankingTotal,
          bolsaTotal: appState.bolsaTotal,
          diaCobro: appState.diaCobro,
          diasRestantes: appState.diasRestantes,
          movimientos: appState.movimientos,
          lastProcessedDate: appState.lastProcessedDate
        }));
      } catch (e) {}

      if (appState.currentView === 'micro') renderMicroView();
    }
  } catch (err) {
    if (miToken === diarioLoadToken_) {
      console.error('Error al recargar estado diario:', err);
    }
  }
}

async function bootstrapEstado_() {
  const miToken = ++diarioLoadToken_;
  try {
    const cached = localStorage.getItem('cached_diario_state');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (miToken === diarioLoadToken_) {
        Object.assign(appState, parsed);
        if (appState.currentView === 'micro') renderMicroView();
      }
    }
  } catch (e) {}

  try {
    const data = await callBackendConSync('getEstadoDiario', {});
    if (miToken !== diarioLoadToken_) return;

    appState.homeBankingTotal = data.homeBankingTotal;
    appState.bolsaTotal = data.bolsaTotal;
    appState.diaCobro = data.diaCobro;
    appState.diasRestantes = data.diasRestantes;
    appState.movimientos = (data.movimientos || []).map(m => {
      m.fechasAfectadas = normalizarFechas_(m.fechasAfectadas);
      return m;
    });
    appState.lastProcessedDate = data.lastProcessedDate;

    try {
      localStorage.setItem('cached_diario_state', JSON.stringify({
        homeBankingTotal: appState.homeBankingTotal,
        bolsaTotal: appState.bolsaTotal,
        diaCobro: appState.diaCobro,
        diasRestantes: appState.diasRestantes,
        movimientos: appState.movimientos,
        lastProcessedDate: appState.lastProcessedDate
      }));
    } catch (e) {}

    localStorage.setItem('accentColor_Brian', data.accentColorBrian);
    localStorage.setItem('accentColor_Virginia', data.accentColorVirginia);
    const colorActivo = appState.activeUser === 'Brian' ? data.accentColorBrian : data.accentColorVirginia;
    document.documentElement.style.setProperty('--accent-color', colorActivo);

    if (appState.currentView === 'micro') renderMicroView();
    try {
      await chequearCierreDia_();
    } catch (e) {
      console.error('Error al chequear el cierre de día:', e);
    }
  } catch (err) {
    if (miToken === diarioLoadToken_) {
      console.error('Error en bootstrapEstado_:', err);
    }
  }

  // Procesar cualquier sincronización pendiente almacenada en cola
  processPendingSyncQueue_();
}

window.diagnosticarBackend = async function() {
  console.log('--- DIAGNÓSTICO DE CONEXIÓN CON GOOGLE APPS SCRIPT ---');
  try {
    const diario = await callBackendConSync('getEstadoDiario', {});
    console.log('✅ getEstadoDiario OK:', diario);
    const now = new Date();
    const mensual = await callBackendConSync('getEstadoMensual', { year: now.getFullYear(), month: now.getMonth() });
    console.log('✅ getEstadoMensual OK:', mensual);
    showAppToast('Conexión con la base de datos OK ✅');
    return { ok: true, diario, mensual };
  } catch (err) {
    console.error('❌ Error en diagnóstico:', err);
    showAppToast('Error de conexión: ' + err.message, true);
    return { ok: false, error: err.message };
  }
};

// ============================================================
// FUNCIÓN DE RESPALDO Y EXPORTACIÓN DE ESTADO
// ============================================================
window.exportarRespaldoEstado = function() {
  const respaldo = {
    version: 'multimillonarios-v26',
    exportDate: new Date().toISOString(),
    appState: appState,
    cachedDiarioState: null,
    configLocal: {
      activeUser: appState.activeUser,
      currentView: appState.currentView,
      currentMacroYear: appState.currentMacroYear,
      currentMacroMonth: appState.currentMacroMonth
    },
    localStorage: {}
  };

  try {
    const cachedDiario = localStorage.getItem('cached_diario_state');
    if (cachedDiario) {
      respaldo.cachedDiarioState = JSON.parse(cachedDiario);
    }
  } catch (e) {
    respaldo.cachedDiarioState = localStorage.getItem('cached_diario_state');
  }

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        try {
          respaldo.localStorage[key] = JSON.parse(localStorage.getItem(key));
        } catch (e) {
          respaldo.localStorage[key] = localStorage.getItem(key);
        }
      }
    }
  } catch (e) {
    console.warn('Error al recolectar localStorage para respaldo:', e);
  }

  try {
    const jsonStr = JSON.stringify(respaldo, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fechaStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `multimillonarios_backup_${fechaStr}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  } catch (err) {
    console.error('Error al generar archivo descargable de respaldo:', err);
  }

  return respaldo;
};

document.addEventListener('DOMContentLoaded', () => {
  cargarUsuarioYColorLocal_();
  initVerticalSwipeGesture_();
  initHorizontalSwipeGesture_();
  initAndroidBackHistory_();
  autoFitCircleButtons();
  window.addEventListener('resize', autoFitCircleButtons);
  bootstrapEstado_();
});



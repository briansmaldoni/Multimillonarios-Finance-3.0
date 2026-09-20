/**
 * ============================================================
 * MINIMAL FINANCE — BACKEND OPTIMIZADO (Google Apps Script)
 * ============================================================
 */

// ============================================================
// 1. ESQUEMA DE LAS PESTAÑAS
// ============================================================

const SHEET_SCHEMAS = {
  Config: {
    columns: ['clave', 'valor'],
    types: { clave: 'string', valor: 'string' }
  },
  Movimientos: {
    columns: ['id', 'tipo', 'fechasAfectadas', 'monto', 'montoPorFecha', 'descripcion', 'usuario', 'fromBag', 'creadoEn'],
    types: {
      id: 'string', tipo: 'string', fechasAfectadas: 'json', monto: 'number',
      montoPorFecha: 'number', descripcion: 'string', usuario: 'string',
      fromBag: 'boolean', creadoEn: 'string'
    }
  },
  ServiciosFijos: {
    columns: ['id', 'descripcion', 'monto', 'moneda', 'isDirect', 'units', 'unitPrice'],
    types: { id: 'string', descripcion: 'string', monto: 'number', moneda: 'string', isDirect: 'boolean', units: 'number', unitPrice: 'number' }
  },
  ServiciosDeshabilitados: {
    columns: ['servicioId', 'year', 'month'],
    types: { servicioId: 'string', year: 'number', month: 'number' }
  },
  GastosFijos: {
    columns: ['id', 'usuario', 'descripcion', 'tipo', 'isDirect', 'units', 'unitPrice', 'monto', 'moneda', 'activoDesdeYear', 'activoDesdeMonth', 'cuotasTotales', 'hastaYear', 'hastaMonth'],
    types: {
      id: 'string', usuario: 'string', descripcion: 'string', tipo: 'string',
      isDirect: 'boolean', units: 'number', unitPrice: 'number', monto: 'number',
      moneda: 'string', activoDesdeYear: 'number', activoDesdeMonth: 'number',
      cuotasTotales: 'number', hastaYear: 'number', hastaMonth: 'number'
    }
  },
  GastosFijosExcepciones: {
    columns: ['id', 'groupId', 'year', 'month', 'unitsOverride', 'montoOverride'],
    types: {
      id: 'string', groupId: 'string', year: 'number', month: 'number',
      unitsOverride: 'number', montoOverride: 'number'
    }
  },
  Premios: {
    columns: ['id', 'year', 'month', 'usuario', 'monto'],
    types: { id: 'string', year: 'number', month: 'number', usuario: 'string', monto: 'number' }
  },
  SacOverrides: {
    columns: ['id', 'year', 'month', 'usuario', 'monto'],
    types: { id: 'string', year: 'number', month: 'number', usuario: 'string', monto: 'number' }
  },
  Feriados: {
    columns: ['id', 'year', 'month', 'day', 'descripcion'],
    types: { id: 'string', year: 'number', month: 'number', day: 'number', descripcion: 'string' }
  }
};

// ============================================================
// 2. ENTRY POINTS Y ROUTER
// ============================================================

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const resultado = ejecutarAccion_(body.action, body.payload || {});
    return responderJSON_({ ok: true, data: resultado });
  } catch (err) {
    return responderJSON_({ ok: false, error: err.message });
  }
}

function doGet(e) {
  try {
    const payload = e.parameter.payload ? JSON.parse(e.parameter.payload) : {};
    const resultado = ejecutarAccion_(e.parameter.action, payload);
    return responderJSON_({ ok: true, data: resultado });
  } catch (err) {
    return responderJSON_({ ok: false, error: err.message });
  }
}

function responderJSON_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ejecutarAccion_(accion, payload) {
  switch (accion) {
    case 'getEstadoDiario': return getEstadoDiario_();
    case 'guardarMovimiento': return guardarMovimiento_(payload);
    case 'eliminarMovimiento': return eliminarMovimiento_(payload.id);
    case 'actualizarHB': return actualizarHB_(payload);
    case 'limpiarMovimientosPendientes': return limpiarMovimientosPendientes_();
    case 'resolverCierreDia': return resolverCierreDia_(payload);
    case 'actualizarConfig': return actualizarConfig_(payload);
    case 'getEstadoMensual': return getEstadoMensual_(payload.year, payload.month);
    case 'guardarGastoFijo': return guardarGastoFijo_(payload);
    case 'guardarExcepcionGastoFijo': return guardarExcepcionGastoFijo_(payload);
    case 'eliminarGastoFijo': return eliminarGastoFijo_(payload.id);
    case 'toggleServicio': return toggleServicio_(payload.servicioId, payload.year, payload.month, payload.habilitado);
    case 'toggleAllServiciosBatch': return toggleAllServiciosBatch_(payload.year, payload.month, payload.habilitarTodos);
    case 'guardarServicioFijo': return guardarServicioFijo_(payload);
    case 'eliminarServicioFijo': return eliminarServicioFijo_(payload.id);
    case 'guardarPremio': return guardarPremio_(payload);
    case 'guardarSacOverride': return guardarSacOverride_(payload);
    case 'guardarConfiguracionMacroBatch': return guardarConfiguracionMacroBatch_(payload);
    case 'diagnosticoConexion': return diagnosticoConexion_();
    default: throw new Error('Acción desconocida: ' + accion);
  }
}

// ============================================================
// 3. HELPERS OPTIMIZADOS DE HOJAS
// ============================================================

// Memoria de ejecución para la misma petición HTTP
let _ssActiva = null;
let _sheetsCache = {};
let _configCache = null;
let _filasCache = {};
let _cabecerasVerificadas = {};

function getActiveSpreadsheet_() {
  if (!_ssActiva) {
    _ssActiva = SpreadsheetApp.getActiveSpreadsheet();
  }
  return _ssActiva;
}

function invalidarCacheSheet_(sheetName) {
  delete _filasCache[sheetName];
  if (sheetName === 'Config') {
    _configCache = null;
  }
}

function asegurarCabecerasSheet_(sheet, sheetName) {
  if (_cabecerasVerificadas[sheetName]) return;
  const schema = SHEET_SCHEMAS[sheetName];
  if (!schema || !sheet) return;

  const maxCols = sheet.getMaxColumns();
  if (maxCols < schema.columns.length) {
    sheet.insertColumnsAfter(maxCols, schema.columns.length - maxCols);
  }

  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.appendRow(schema.columns);
    sheet.setFrozenRows(1);
    _cabecerasVerificadas[sheetName] = true;
    return;
  }

  const colsToRead = Math.max(lastCol, schema.columns.length);
  const currentHeaders = sheet.getRange(1, 1, 1, colsToRead).getValues()[0];
  let changed = false;

  schema.columns.forEach((colName, idx) => {
    if (currentHeaders[idx] !== colName) {
      currentHeaders[idx] = colName;
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, currentHeaders.length).setValues([currentHeaders]);
  }
  _cabecerasVerificadas[sheetName] = true;
}

function asegurarCabeceras_(sheetName) {
  const ss = getActiveSpreadsheet_();
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    asegurarCabecerasSheet_(sheet, sheetName);
  }
}

function getSheet_(nombre, crearSiNoExiste) {
  if (_sheetsCache[nombre]) {
    return _sheetsCache[nombre];
  }
  const ss = getActiveSpreadsheet_();
  let sheet = ss.getSheetByName(nombre);
  if (!sheet && crearSiNoExiste) {
    sheet = ss.insertSheet(nombre);
    const schema = SHEET_SCHEMAS[nombre];
    if (schema) {
      sheet.appendRow(schema.columns);
      sheet.setFrozenRows(1);
      schema.columns.forEach((col, idx) => {
        const tipo = schema.types[col];
        if (tipo === 'string' || tipo === 'json') {
          sheet.getRange(2, idx + 1, 998, 1).setNumberFormat('@');
        }
      });
    }
    _sheetsCache[nombre] = sheet;
    return sheet;
  }
  if (sheet && SHEET_SCHEMAS[nombre]) {
    asegurarCabecerasSheet_(sheet, nombre);
  }
  if (sheet) {
    _sheetsCache[nombre] = sheet;
  }
  return sheet;
}

function castValor_(sheetName, col, raw) {
  const schema = SHEET_SCHEMAS[sheetName];
  const tipo = (schema && schema.types[col]) || 'string';
  if (raw === '' || raw === null || raw === undefined) {
    if (tipo === 'boolean') return false;
    if (tipo === 'number') return null;
    if (tipo === 'json') return [];
    return '';
  }
  switch (tipo) {
    case 'number': {
      const n = Number(raw);
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'json':
      if (typeof raw === 'object' && raw !== null) return raw;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (err) { return [raw]; }
      }
      return [];
    default:
      return String(raw);
  }
}

function leerFilas_(sheetName, forzarLectura = false) {
  if (!forzarLectura && _filasCache[sheetName]) {
    return _filasCache[sheetName];
  }
  const sheet = getSheet_(sheetName, true);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    _filasCache[sheetName] = [];
    return [];
  }
  const headers = values[0];
  const filas = [];
  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    const vacia = rowValues.every(v => v === '' || v === null || v === undefined);
    if (vacia) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = castValor_(sheetName, h, rowValues[idx]); });
    obj._rowIndex = i + 1;
    filas.push(obj);
  }
  _filasCache[sheetName] = filas;
  return filas;
}

function limpiarFilaParaCliente_(fila) {
  const copia = Object.assign({}, fila);
  delete copia._rowIndex;
  return copia;
}

function filaDesdeObjeto_(sheetName, obj) {
  const schema = SHEET_SCHEMAS[sheetName];
  return schema.columns.map(col => {
    const tipo = schema.types[col];
    const v = obj[col];
    if (v === undefined || v === null) return '';
    if (tipo === 'json') return JSON.stringify(v);
    return v;
  });
}

function agregarFila_(sheetName, obj) {
  const sheet = getSheet_(sheetName, true);
  const fila = filaDesdeObjeto_(sheetName, obj);
  const maxCols = sheet.getMaxColumns();
  if (maxCols < fila.length) {
    sheet.insertColumnsAfter(maxCols, fila.length - maxCols);
  }
  sheet.appendRow(fila);
  invalidarCacheSheet_(sheetName);
}

function actualizarFilaPorId_(sheetName, id, obj) {
  const sheet = getSheet_(sheetName, true);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;
  const headers = values[0];
  const idColIdx = headers.indexOf('id');
  if (idColIdx === -1) return false;

  for (let i = 1; i < values.length; i++) {
    const cellId = String(values[i][idColIdx] || '').trim();
    if (cellId === String(id).trim()) {
      const fila = filaDesdeObjeto_(sheetName, obj);
      const maxCols = sheet.getMaxColumns();
      if (maxCols < fila.length) {
        sheet.insertColumnsAfter(maxCols, fila.length - maxCols);
      }
      sheet.getRange(i + 1, 1, 1, fila.length).setValues([fila]);
      invalidarCacheSheet_(sheetName);
      return true;
    }
  }
  return false;
}

function borrarFilaPorId_(sheetName, id) {
  const sheet = getSheet_(sheetName, true);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;
  const headers = values[0];
  const idColIdx = headers.indexOf('id');
  if (idColIdx === -1) return false;

  for (let i = 1; i < values.length; i++) {
    const cellId = String(values[i][idColIdx] || '').trim();
    if (cellId === String(id).trim()) {
      sheet.deleteRow(i + 1);
      invalidarCacheSheet_(sheetName);
      return true;
    }
  }
  return false;
}

function borrarFilaPorIndice_(sheetName, rowIndex) {
  const sheet = getSheet_(sheetName, true);
  sheet.deleteRow(rowIndex);
  invalidarCacheSheet_(sheetName);
}

// ============================================================
// 4. CONFIG (clave -> valor)
// ============================================================

function leerConfig_(forzarLectura = false) {
  if (!forzarLectura && _configCache) {
    return _configCache;
  }
  const cfg = {};
  leerFilas_('Config', forzarLectura).forEach(f => { cfg[f.clave] = f.valor; });
  _configCache = cfg;
  return cfg;
}

function getConfigNumero_(cfg, clave, porDefecto) {
  const v = cfg[clave];
  if (v === undefined || v === null || v === '') return porDefecto;
  const n = Number(v);
  return isNaN(n) ? porDefecto : n;
}

function setConfigValores_(cambios) {
  const sheet = getSheet_('Config', true);
  const values = sheet.getDataRange().getValues();
  const claves = values.slice(1).map(r => r[0]);
  Object.keys(cambios).forEach(clave => {
    const valor = String(cambios[clave]);
    const idx = claves.indexOf(clave);
    if (idx !== -1) {
      sheet.getRange(idx + 2, 2).setValue(valor);
    } else {
      sheet.appendRow([clave, valor]);
      claves.push(clave);
    }
  });
  invalidarCacheSheet_('Config');
}

// ============================================================
// 5. FERIADOS ARGENTINA Y DÍA DE COBRO
// ============================================================

const FERIADOS_FIJOS = [
  { mes: 1, dia: 1, desc: 'Año Nuevo' },
  { mes: 3, dia: 24, desc: 'Día Nacional de la Memoria por la Verdad y la Justicia' },
  { mes: 4, dia: 2, desc: 'Día del Veterano y de los Caídos en la Guerra de Malvinas' },
  { mes: 5, dia: 1, desc: 'Día del Trabajador' },
  { mes: 5, dia: 25, desc: 'Día de la Revolución de Mayo' },
  { mes: 6, dia: 20, desc: 'Paso a la Inmortalidad del Gral. Belgrano' },
  { mes: 7, dia: 9, desc: 'Día de la Independencia' },
  { mes: 12, dia: 8, desc: 'Inmaculada Concepción de María' },
  { mes: 12, dia: 25, desc: 'Navidad' }
];

const FERIADOS_TRASLADABLES_BASE = [
  { mes: 6, dia: 17, desc: 'Paso a la Inmortalidad del Gral. Güemes' },
  { mes: 8, dia: 17, desc: 'Paso a la Inmortalidad del Gral. San Martín' },
  { mes: 10, dia: 12, desc: 'Día del Respeto a la Diversidad Cultural' },
  { mes: 11, dia: 20, desc: 'Día de la Soberanía Nacional' }
];

function calcularPascua_(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, mes - 1, dia);
}

function sumarDias_(fecha, dias) {
  const f = new Date(fecha.getTime());
  f.setDate(f.getDate() + dias);
  return f;
}

function mismaFecha_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function aplicarTrasladoLunes_(fecha) {
  const diaSemana = fecha.getDay();
  if (diaSemana === 2) return sumarDias_(fecha, -1);
  if (diaSemana === 3) return sumarDias_(fecha, -2);
  if (diaSemana === 4) return sumarDias_(fecha, 4);
  if (diaSemana === 5) return sumarDias_(fecha, 3);
  return fecha;
}

function calcularFeriadosDelAnio_(year) {
  const feriados = [];
  FERIADOS_FIJOS.forEach(f => feriados.push(new Date(year, f.mes - 1, f.dia)));

  const pascua = calcularPascua_(year);
  feriados.push(sumarDias_(pascua, -48));
  feriados.push(sumarDias_(pascua, -47));
  feriados.push(sumarDias_(pascua, -2));

  FERIADOS_TRASLADABLES_BASE.forEach(f => {
    feriados.push(aplicarTrasladoLunes_(new Date(year, f.mes - 1, f.dia)));
  });

  return feriados;
}

function esFeriado_(fecha, feriadosExtra) {
  const delAnio = calcularFeriadosDelAnio_(fecha.getFullYear());
  if (delAnio.some(f => mismaFecha_(f, fecha))) return true;
  return feriadosExtra.some(f => f.year === fecha.getFullYear() && f.month === fecha.getMonth() && f.day === fecha.getDate());
}

function esHabil_(fecha, feriadosExtra) {
  const diaSemana = fecha.getDay();
  if (diaSemana === 0 || diaSemana === 6) return false;
  return !esFeriado_(fecha, feriadosExtra);
}

function calcularDiaCobro_(year, month, feriadosExtra) {
  let habiles = 0;
  for (let dia = 1; dia <= 15; dia++) {
    const fecha = new Date(year, month, dia);
    if (esHabil_(fecha, feriadosExtra)) {
      habiles++;
      if (habiles === 2) return fecha;
    }
  }
  throw new Error('No se pudo calcular el día de cobro para ' + year + '-' + (month + 1));
}

function calcularProximoCobro_(desde, feriadosExtra) {
  let year = desde.getFullYear();
  let month = desde.getMonth();
  let cobro = calcularDiaCobro_(year, month, feriadosExtra);
  if (cobro <= desde) {
    month++;
    if (month > 11) { month = 0; year++; }
    cobro = calcularDiaCobro_(year, month, feriadosExtra);
  }
  return cobro;
}

function formatearFechaISO_(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function calcularDiasRestantes_(desde, feriadosExtra) {
  const cobro = calcularProximoCobro_(desde, feriadosExtra);
  const fechas = [];
  let f = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  while (f < cobro) {
    fechas.push(formatearFechaISO_(f));
    f = sumarDias_(f, 1);
  }
  return { diaCobro: formatearFechaISO_(cobro), fechas: fechas };
}

// ============================================================
// 6. MÓDULO DIARIO
// ============================================================

function getEstadoDiario_() {
  const cfg = leerConfig_();
  const feriadosExtra = leerFilas_('Feriados');
  const diasInfo = calcularDiasRestantes_(new Date(), feriadosExtra);
  const movimientos = leerFilas_('Movimientos').map(limpiarFilaParaCliente_);

  return {
    homeBankingTotal: getConfigNumero_(cfg, 'homeBankingTotal', 0),
    bolsaTotal: getConfigNumero_(cfg, 'bolsaTotal', 0),
    lastProcessedDate: cfg.lastProcessedDate || null,
    diaCobro: diasInfo.diaCobro,
    diasRestantes: diasInfo.fechas,
    movimientos: movimientos
  };
}

function guardarMovimiento_(data) {
  const monto = Number(data.monto);
  if (isNaN(monto) || monto <= 0) throw new Error('El monto debe ser un número estrictamente mayor a 0');
  if (!data.fechasAfectadas) throw new Error('Faltan fechas afectadas');

  let fechas = data.fechasAfectadas;
  if (typeof fechas === 'string') {
    try { fechas = JSON.parse(fechas); } catch(e) { fechas = [fechas]; }
  }
  if (!Array.isArray(fechas) || !fechas.length) throw new Error('Faltan fechas afectadas válidas');
  fechas = fechas.map(f => String(f).trim()).filter(Boolean);
  if (!fechas.length) throw new Error('Faltan fechas afectadas válidas');

  if (data.tipo !== 'single' && data.tipo !== 'divisible') throw new Error('Tipo inválido: ' + data.tipo);

  const cfg = leerConfig_();
  let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
  let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

  const usuario = (data.usuario && String(data.usuario).trim()) ? String(data.usuario).trim() : (cfg.usuarioDefault || 'Brian');

  const id = data.id || Utilities.getUuid();
  const filasMov = leerFilas_('Movimientos');
  const movExistente = data.id ? filasMov.find(m => String(m.id).trim() === String(data.id).trim()) : null;

  if (movExistente) {
    hbTotal += (movExistente.monto || 0);
    if (movExistente.fromBag) {
      bolsaTotal += (movExistente.monto || 0);
    }
  }

  const nuevoMonto = monto;
  const nuevoFromBag = !!data.fromBag;

  hbTotal -= nuevoMonto;
  if (nuevoFromBag) {
    bolsaTotal -= nuevoMonto;
  }

  setConfigValores_({
    homeBankingTotal: hbTotal,
    bolsaTotal: bolsaTotal
  });

  const obj = {
    id: id,
    tipo: data.tipo,
    fechasAfectadas: fechas,
    monto: nuevoMonto,
    montoPorFecha: nuevoMonto / fechas.length,
    descripcion: (data.descripcion || '').trim(),
    usuario: usuario,
    fromBag: nuevoFromBag,
    creadoEn: data.creadoEn || (movExistente ? movExistente.creadoEn : new Date().toISOString())
  };

  const actualizado = data.id ? actualizarFilaPorId_('Movimientos', id, obj) : false;
  if (!actualizado) agregarFila_('Movimientos', obj);
  return obj;
}

function eliminarMovimiento_(id) {
  const filasMov = leerFilas_('Movimientos');
  const movExistente = filasMov.find(m => String(m.id).trim() === String(id).trim());

  if (movExistente) {
    const cfg = leerConfig_();
    let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
    let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

    hbTotal += (movExistente.monto || 0);
    if (movExistente.fromBag) {
      bolsaTotal += (movExistente.monto || 0);
    }

    setConfigValores_({
      homeBankingTotal: hbTotal,
      bolsaTotal: bolsaTotal
    });

    return borrarFilaPorId_('Movimientos', id);
  }
  return false;
}

function actualizarHB_(payload) {
  const cambios = {};
  if (payload.homeBankingTotal !== undefined) cambios.homeBankingTotal = payload.homeBankingTotal;
  if (payload.bolsaTotal !== undefined) cambios.bolsaTotal = payload.bolsaTotal;
  setConfigValores_(cambios);
  return {
    homeBankingTotal: payload.homeBankingTotal,
    bolsaTotal: payload.bolsaTotal
  };
}

function limpiarMovimientosPendientes_() {
  const hoyStr = formatearFechaISO_(new Date());
  const movimientos = leerFilas_('Movimientos');
  const aBorrar = [];
  const candidatos = [];

  const cfg = leerConfig_();
  let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
  let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);
  let cambioHB = false;

  movimientos.forEach(m => {
    const fechas = castValor_('Movimientos', 'fechasAfectadas', m.fechasAfectadas);
    const afectaHoy = fechas.indexOf(hoyStr) !== -1;
    const tienePendiente = fechas.some(f => f >= hoyStr);

    if (!tienePendiente) {
      aBorrar.push(m.id);
      return;
    }
    if (m.tipo === 'single' && afectaHoy) return;
    if (m.tipo === 'divisible' && afectaHoy) {
      candidatos.push(limpiarFilaParaCliente_(m));
      return;
    }
    
    hbTotal += (m.monto || 0);
    if (m.fromBag) bolsaTotal += (m.monto || 0);
    cambioHB = true;
    aBorrar.push(m.id);
  });

  if (cambioHB) {
    setConfigValores_({ homeBankingTotal: hbTotal, bolsaTotal: bolsaTotal });
  }

  aBorrar.forEach(id => borrarFilaPorId_('Movimientos', id));
  return { borrados: aBorrar.length, candidatos: candidatos };
}

function resolverCierreDia_(payload) {
  const cfg = leerConfig_();
  let bolsaActual = getConfigNumero_(cfg, 'bolsaTotal', 0);

  if (payload.decision === 'bolsa') {
    if (payload.tipo === 'sobrante') {
      bolsaActual += payload.monto;
    } else {
      bolsaActual = Math.max(bolsaActual - payload.monto, 0);
    }
    setConfigValores_({ bolsaTotal: bolsaActual });
  }

  const hoyStr = formatearFechaISO_(new Date());
  setConfigValores_({ lastProcessedDate: hoyStr });
  return { bolsaTotal: bolsaActual, lastProcessedDate: hoyStr };
}

function actualizarConfig_(cambios) {
  setConfigValores_(cambios);
  return leerConfig_();
}

// ============================================================
// 7. MÓDULO PROYECCIÓN MENSUAL & BATCH UPDATE
// ============================================================

function gastoFijoIniciado_(gasto, year, month) {
  const aY = Number(gasto.activoDesdeYear);
  const aM = Number(gasto.activoDesdeMonth);
  if (year < aY) return false;
  if (year === aY && month < aM) return false;

  if (gasto.cuotasTotales) {
    const mesesTranscurridos = (year - aY) * 12 + (month - aM);
    if (mesesTranscurridos >= Number(gasto.cuotasTotales)) return false;
  }
  return true;
}

function esGastoFijoPausado_(gasto, year, month) {
  if (gasto.hastaYear !== null && gasto.hastaYear !== undefined && gasto.hastaYear !== '') {
    const hY = Number(gasto.hastaYear);
    const hM = Number(gasto.hastaMonth);
    if (year > hY) return true;
    if (year === hY && month > hM) return true;
  }
  return false;
}

function calcularMontoGastoFijo_(gasto, excepcion) {
  if (excepcion && excepcion.montoOverride !== null && excepcion.montoOverride !== undefined) {
    return excepcion.montoOverride;
  }
  const units = (excepcion && excepcion.unitsOverride !== null && excepcion.unitsOverride !== undefined)
    ? excepcion.unitsOverride
    : gasto.units;
  if (gasto.isDirect) return gasto.monto;
  return units * gasto.unitPrice;
}

function getEstadoMensual_(year, month) {
  const cfg = leerConfig_();

  const excepcionesDelMes = leerFilas_('GastosFijosExcepciones').filter(e => Number(e.year) === Number(year) && Number(e.month) === Number(month));
  const excepcionPorGrupo = {};
  excepcionesDelMes.forEach(e => { excepcionPorGrupo[e.groupId] = e; });

  const gastosFijos = leerFilas_('GastosFijos')
    .filter(g => gastoFijoIniciado_(g, year, month))
    .map(g => {
      const exc = excepcionPorGrupo[g.id];
      const tipoReal = (g.tipo === 'debt' || g.tipo === 'deuda') ? 'deuda' : 'gasto';
      const pausado = esGastoFijoPausado_(g, year, month);

      let montoCalculado = 0;
      if (!pausado) {
        montoCalculado = calcularMontoGastoFijo_(g, exc);
      }

      return {
        id: g.id,
        usuario: g.usuario,
        descripcion: g.descripcion,
        tipo: tipoReal,
        isDirect: g.isDirect,
        units: g.units,
        unitPrice: g.unitPrice,
        moneda: g.moneda,
        monto: montoCalculado,
        montoBase: g.monto,
        activoDesdeYear: g.activoDesdeYear,
        activoDesdeMonth: g.activoDesdeMonth,
        hastaYear: g.hastaYear,
        hastaMonth: g.hastaMonth,
        esPausado: pausado,
        tieneExcepcionEsteMes: !!exc
      };
    });

  const serviciosFijos = leerFilas_('ServiciosFijos').map(limpiarFilaParaCliente_);
  const serviciosDeshabilitadosEsteMes = leerFilas_('ServiciosDeshabilitados')
    .filter(s => Number(s.year) === Number(year) && Number(s.month) === Number(month))
    .map(s => s.servicioId);

  const premiosRows = leerFilas_('Premios').filter(p => Number(p.year) === Number(year) && Number(p.month) === Number(month));
  const premioBrian = premiosRows.find(p => !p.usuario || p.usuario === 'Brian');
  const premioVirginia = premiosRows.find(p => p.usuario === 'Virginia');
  const sacRows = leerFilas_('SacOverrides').filter(s => Number(s.year) === Number(year) && Number(s.month) === Number(month));
  const sacBrian = sacRows.find(s => s.usuario === 'Brian');
  const sacVirginia = sacRows.find(s => s.usuario === 'Virginia');

  return {
    year: year,
    month: month,
    salaryBrian: getConfigNumero_(cfg, 'salaryBrian', 0),
    salaryVirginia: getConfigNumero_(cfg, 'salaryVirginia', 0),
    usdRate: getConfigNumero_(cfg, 'usdRate', 0),
    gastosFijos: gastosFijos,
    serviciosFijos: serviciosFijos,
    serviciosDeshabilitadosEsteMes: serviciosDeshabilitadosEsteMes,
    premio: premioBrian ? premioBrian.monto : 0,
    premioBrian: premioBrian ? premioBrian.monto : 0,
    premioVirginia: premioVirginia ? premioVirginia.monto : 0,
    sacBrian: sacBrian ? sacBrian.monto : null,
    sacVirginia: sacVirginia ? sacVirginia.monto : null
  };
}

// TOGGLE MASIVO DE SERVICIOS EN 1 SOLA PETICIÓN HTTP
function toggleAllServiciosBatch_(year, month, habilitarTodos) {
  const sheet = getSheet_('ServiciosDeshabilitados', true);
  const values = sheet.getDataRange().getValues();
  
  if (values.length >= 2) {
    for (let i = values.length - 1; i >= 1; i--) {
      if (Number(values[i][1]) === Number(year) && Number(values[i][2]) === Number(month)) {
        sheet.deleteRow(i + 1);
      }
    }
  }

  if (!habilitarTodos) {
    const servicios = leerFilas_('ServiciosFijos');
    servicios.forEach(s => {
      agregarFila_('ServiciosDeshabilitados', { servicioId: s.id, year: year, month: month });
    });
  }
  return true;
}

// BATCH CONFIGURACIÓN MACRO
function guardarConfiguracionMacroBatch_(payload) {
  setConfigValores_({
    usdRate: payload.usdRate,
    salaryBrian: payload.salaryBrian,
    salaryVirginia: payload.salaryVirginia
  });

  if (Array.isArray(payload.serviciosEliminados)) {
    payload.serviciosEliminados.forEach(id => {
      borrarFilaPorId_('ServiciosFijos', id);
      leerFilas_('ServiciosDeshabilitados')
        .filter(s => String(s.servicioId).trim() === String(id).trim())
        .forEach(s => borrarFilaPorIndice_('ServiciosDeshabilitados', s._rowIndex));
    });
  }

  if (Array.isArray(payload.serviciosFijos)) {
    payload.serviciosFijos.forEach(s => {
      const esNuevo = !s.id || String(s.id).startsWith('srv_');
      const id = esNuevo ? Utilities.getUuid() : s.id;
      const isDirect = s.isDirect !== undefined ? !!s.isDirect : true;
      const units = Number(s.units) || 1;
      const unitPrice = Number(s.unitPrice) || 0;
      const monto = isDirect ? Number(s.monto) : (units * unitPrice);

      const obj = {
        id: id,
        descripcion: s.descripcion,
        monto: monto,
        moneda: s.moneda || 'ARS',
        isDirect: isDirect,
        units: units,
        unitPrice: unitPrice
      };
      const actualizado = esNuevo ? false : actualizarFilaPorId_('ServiciosFijos', id, obj);
      if (!actualizado) agregarFila_('ServiciosFijos', obj);
    });
  }

  return getEstadoMensual_(payload.year, payload.month);
}

function guardarGastoFijo_(data) {
  const isDirect = !!data.isDirect;
  const units = Number(data.units) || 1;
  const unitPrice = Number(data.unitPrice) || 0;
  const monto = isDirect ? Number(data.monto) : (units * unitPrice);
  if (isNaN(monto) || monto <= 0) throw new Error('El monto del gasto fijo debe ser un número estrictamente mayor a 0');

  const cfg = leerConfig_();
  const usuario = (data.usuario && String(data.usuario).trim()) ? String(data.usuario).trim() : (cfg.usuarioDefault || 'Brian');

  const id = data.id || Utilities.getUuid();
  const tipoReal = (data.tipo === 'debt' || data.tipo === 'deuda') ? 'deuda' : 'gasto';

  // PRESERVACIÓN DE LA FECHA DE ALTA (activoDesdeYear / activoDesdeMonth):
  // Si el gasto ya existe en la BD, ignoramos lo que venga en el payload para estos dos
  // campos y usamos siempre el valor ya guardado en la hoja. Esto evita que al editar,
  // pausar o deshabilitar un gasto existente se le "mueva" la fecha de creación hacia el
  // mes que se está viendo en ese momento, lo que lo hacía desaparecer de los meses
  // anteriores a la edición. Solo para un gasto NUEVO (sin id) se toma la fecha recibida.
  let activoDesdeYear = data.activoDesdeYear;
  let activoDesdeMonth = data.activoDesdeMonth;

  if (data.id) {
    const existente = leerFilas_('GastosFijos').find(x => String(x.id).trim() === String(data.id).trim());
    if (existente) {
      activoDesdeYear = existente.activoDesdeYear;
      activoDesdeMonth = existente.activoDesdeMonth;
    }
  }

  const obj = {
    id: id,
    usuario: usuario,
    descripcion: (data.descripcion || '').trim(),
    tipo: tipoReal,
    isDirect: isDirect,
    units: units,
    unitPrice: unitPrice,
    monto: monto,
    moneda: data.moneda || 'ARS',
    activoDesdeYear: activoDesdeYear,
    activoDesdeMonth: activoDesdeMonth,
    cuotasTotales: data.cuotasTotales || null,
    hastaYear: data.hastaYear !== undefined ? data.hastaYear : null,
    hastaMonth: data.hastaMonth !== undefined ? data.hastaMonth : null
  };
  const actualizado = data.id ? actualizarFilaPorId_('GastosFijos', id, obj) : false;
  if (!actualizado) agregarFila_('GastosFijos', obj);
  return obj;
}

function guardarExcepcionGastoFijo_(data) {
  const filas = leerFilas_('GastosFijosExcepciones');
  const existente = filas.find(e => String(e.groupId).trim() === String(data.groupId).trim() && Number(e.year) === Number(data.year) && Number(e.month) === Number(data.month));

  if (data.montoOverride === null || data.montoOverride === undefined) {
    if (existente) {
      borrarFilaPorId_('GastosFijosExcepciones', existente.id);
    }
    return true;
  }

  const id = existente ? existente.id : Utilities.getUuid();
  const obj = {
    id: id,
    groupId: data.groupId,
    year: data.year,
    month: data.month,
    unitsOverride: data.unitsOverride !== undefined ? data.unitsOverride : null,
    montoOverride: data.montoOverride !== undefined ? data.montoOverride : null
  };
  const actualizado = existente ? actualizarFilaPorId_('GastosFijosExcepciones', id, obj) : false;
  if (!actualizado) agregarFila_('GastosFijosExcepciones', obj);
  return obj;
}

function eliminarGastoFijo_(id) {
  borrarFilaPorId_('GastosFijos', id);
  leerFilas_('GastosFijosExcepciones')
    .filter(e => String(e.groupId).trim() === String(id).trim())
    .forEach(e => borrarFilaPorId_('GastosFijosExcepciones', e.id));
  return true;
}

function toggleServicio_(servicioId, year, month, habilitado) {
  const filas = leerFilas_('ServiciosDeshabilitados');
  const existente = filas.find(f => String(f.servicioId).trim() === String(servicioId).trim() && Number(f.year) === Number(year) && Number(f.month) === Number(month));

  if (habilitado) {
    if (existente) borrarFilaPorIndice_('ServiciosDeshabilitados', existente._rowIndex);
  } else {
    if (!existente) agregarFila_('ServiciosDeshabilitados', { servicioId: servicioId, year: year, month: month });
  }
  return { servicioId: servicioId, year: year, month: month, habilitado: habilitado };
}

function guardarServicioFijo_(data) {
  const isDirect = data.isDirect !== undefined ? !!data.isDirect : true;
  const units = Number(data.units) || 1;
  const unitPrice = Number(data.unitPrice) || 0;
  const monto = isDirect ? Number(data.monto) : (units * unitPrice);
  if (isNaN(monto) || monto <= 0) throw new Error('El monto del servicio debe ser un número estrictamente mayor a 0');

  const cfg = leerConfig_();
  const usuario = (data.usuario && String(data.usuario).trim()) ? String(data.usuario).trim() : (cfg.usuarioDefault || 'Brian');

  const id = data.id || Utilities.getUuid();
  const obj = {
    id: id,
    usuario: usuario,
    descripcion: (data.descripcion || '').trim(),
    monto: monto,
    moneda: data.moneda || 'ARS',
    isDirect: isDirect,
    units: units,
    unitPrice: unitPrice
  };
  const actualizado = data.id ? actualizarFilaPorId_('ServiciosFijos', id, obj) : false;
  if (!actualizado) agregarFila_('ServiciosFijos', obj);
  return obj;
}

function eliminarServicioFijo_(id) {
  borrarFilaPorId_('ServiciosFijos', id);
  leerFilas_('ServiciosDeshabilitados')
    .filter(s => String(s.servicioId).trim() === String(id).trim())
    .forEach(s => borrarFilaPorIndice_('ServiciosDeshabilitados', s._rowIndex));
  return true;
}

function guardarPremio_(data) {
  const year = data.year;
  const month = data.month;
  const monto = data.monto;
  const usuario = data.usuario || 'Brian';

  const premios = leerFilas_('Premios');
  const existente = premios.find(p => Number(p.year) === Number(year) && Number(p.month) === Number(month) && (!p.usuario || p.usuario === usuario));

  const id = existente ? existente.id : Utilities.getUuid();
  const obj = { id: id, year: year, month: month, usuario: usuario, monto: monto };

  const actualizado = existente ? actualizarFilaPorId_('Premios', id, obj) : false;
  if (!actualizado) agregarFila_('Premios', obj);
  return obj;
}

function guardarSacOverride_(data) {
  const year = data.year;
  const month = data.month;
  const usuario = data.usuario;
  const monto = data.monto;

  const sacRows = leerFilas_('SacOverrides');
  const existente = sacRows.find(s => Number(s.year) === Number(year) && Number(s.month) === Number(month) && s.usuario === usuario);

  const id = existente ? existente.id : Utilities.getUuid();
  const obj = { id: id, year: year, month: month, usuario: usuario, monto: monto };

  const actualizado = existente ? actualizarFilaPorId_('SacOverrides', id, obj) : false;
  if (!actualizado) agregarFila_('SacOverrides', obj);
  return obj;
}

// ============================================================
// 8. SETUP INICIAL
// ============================================================

function setupSheets() {
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    asegurarCabeceras_(nombre);
  });

  const cfg = leerConfig_();
  setConfigValores_({
    homeBankingTotal: cfg.homeBankingTotal || '0',
    bolsaTotal: cfg.bolsaTotal || '0',
    lastProcessedDate: cfg.lastProcessedDate || formatearFechaISO_(new Date()),
    usdRate: cfg.usdRate || '0',
    salaryBrian: cfg.salaryBrian || '0',
    salaryVirginia: cfg.salaryVirginia || '0'
  });

  limpiarConfigLegacy_();

  Logger.log('Setup completo. Pestañas creadas y aseguradas: ' + Object.keys(SHEET_SCHEMAS).join(', '));
}

function repararSheetsExistentes() {
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    asegurarCabeceras_(nombre);
    const schema = SHEET_SCHEMAS[nombre];
    const sheet = getSheet_(nombre, true);
    schema.columns.forEach((col, idx) => {
      const tipo = schema.types[col];
      if (tipo === 'string' || tipo === 'json') {
        sheet.getRange(2, idx + 1, 998, 1).setNumberFormat('@');
      }
    });
  });
  setConfigValores_({ lastProcessedDate: formatearFechaISO_(new Date()) });
  limpiarConfigLegacy_();
  Logger.log('Formatos de texto aplicados, cabeceras aseguradas y configuración legacy depurada.');
}

function limpiarConfigLegacy_() {
  const sheet = getSheet_('Config', false);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const legacyKeys = ['accentColorBrian', 'accentColorVirginia'];
  for (let i = values.length - 1; i >= 1; i--) {
    const key = String(values[i][0] || '').trim();
    if (legacyKeys.includes(key)) {
      sheet.deleteRow(i + 1);
    }
  }
  invalidarCacheSheet_('Config');
}

function diagnosticoConexion_() {
  const resultado = {};
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    const sheet = getSheet_(nombre, true);
    resultado[nombre] = {
      maxCols: sheet.getMaxColumns(),
      lastCol: sheet.getLastColumn(),
      headers: sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    };
  });
  return resultado;
}

// =====================================================================
// PRICING INTELLIGENCE PLATFORM · app.js
// Procesamiento 100% en el navegador. Tus datos nunca salen del cliente.
// =====================================================================

const App = (() => {
  // ============ STATE ============
  let RAW = null;        // Datos crudos del CSV
  let MAPPING = null;    // Mapeo de columnas detectado
  let DATASET = null;    // Dataset procesado
  let curveChart, simChart, monthlyChart, catChart, marcaChart,
      elastScatterChart, elastHistChart, segChart, execChart;
  let recFilter = 'all';

  // ============ COLUMN DETECTION HEURISTICS ============
  const COL_PATTERNS = {
    sku: [/^sku$/i, /prod[_\s]?nbr/i, /product[_\s]?id/i, /^codigo$/i, /id[_\s]?prod/i, /item[_\s]?id/i, /article/i],
    nombre: [/^name$/i, /product[_\s]?name/i, /class[_\s]?nm/i, /nombre[_\s]?prod/i, /descripcion/i, /producto/i, /^item$/i],
    categoria: [/^category$/i, /categoria/i, /^class$/i, /dept[_\s]?nm/i, /subdept/i, /^group/i],
    marca: [/^brand$/i, /marca/i, /fabricante/i, /manufacturer/i],
    precio: [/^price$/i, /precio[_\s]?unit/i, /^precio$/i, /unit[_\s]?price/i, /^sale[_\s]?price/i],
    costo: [/apparent[_\s]?unit[_\s]?cost/i, /unit[_\s]?cost/i, /^cost$/i, /^costo$/i, /costo[_\s]?unit/i],
    qty: [/^qty$/i, /^quantity$/i, /^cantidad$/i, /^unidades$/i, /^units$/i, /^vol/i],
    revenue: [/net[_\s]?sale/i, /^revenue$/i, /^ventas$/i, /^sales$/i, /venta[_\s]?total/i],
    margen: [/^margen$/i, /^margin$/i, /margin[_\s]?pct/i, /margen[_\s]?pct/i],
    utilidad: [/^utilidad$/i, /^profit$/i, /^gross[_\s]?profit/i, /utilidad[_\s]?bruta/i],
    fecha: [/^date$/i, /^fecha$/i, /fecha[_\s]?venta/i, /transaction[_\s]?date/i],
    año: [/^year$/i, /^año$/i, /^anio$/i, /^ano$/i],
    mes: [/^month$/i, /^mes$/i],
    dia: [/^day$/i, /^dia$/i, /^día$/i],
    tienda: [/store[_\s]?nm/i, /store[_\s]?nbr/i, /^tienda$/i, /^store$/i, /^sucursal$/i],
    proveedor: [/vendor[_\s]?nm/i, /^vendor$/i, /^proveedor$/i, /^supplier$/i],
  };

  function detectColumns(headers) {
    const mapping = {};
    for (const [field, patterns] of Object.entries(COL_PATTERNS)) {
      for (const h of headers) {
        if (mapping[field]) break;
        for (const p of patterns) {
          if (p.test(h)) { mapping[field] = h; break; }
        }
      }
    }
    return mapping;
  }

  // ============ UTILS ============
  const fmt = {
    money: n => {
      if (!Number.isFinite(n)) return '$0';
      const abs = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      return sign + '$' + (abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(1)+'K' : abs.toFixed(0));
    },
    money2: n => '$' + (Number.isFinite(n) ? n : 0).toLocaleString('es-MX', {minimumFractionDigits: 2, maximumFractionDigits: 2}),
    num: n => (Number.isFinite(n) ? n : 0).toLocaleString('es-MX'),
    signed: n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%'
  };

  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const item of arr) {
      const k = keyFn(item);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    }
    return m;
  }

  function quantile(arr, q) {
    const sorted = [...arr].sort((a,b) => a-b);
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base+1] - sorted[base]) : sorted[base];
  }

  // ============ ELASTICITY: LOG-LOG REGRESSION ============
  function calcElasticity(prices, qtys) {
    if (prices.length < 5) return { e: null, r2: 0 };
    const filtered = prices.map((p,i) => [p, qtys[i]]).filter(([p,q]) => p > 0 && q > 0);
    if (filtered.length < 5) return { e: null, r2: 0 };
    const logP = filtered.map(x => Math.log(x[0]));
    const logQ = filtered.map(x => Math.log(x[1]));
    const meanP = logP.reduce((a,b) => a+b, 0) / logP.length;
    const meanQ = logQ.reduce((a,b) => a+b, 0) / logQ.length;
    let stdP = 0;
    for (const p of logP) stdP += (p - meanP) ** 2;
    stdP = Math.sqrt(stdP / logP.length);
    if (stdP < 0.01) return { e: null, r2: 0 };
    // OLS
    let num = 0, den = 0;
    for (let i = 0; i < logP.length; i++) {
      num += (logP[i] - meanP) * (logQ[i] - meanQ);
      den += (logP[i] - meanP) ** 2;
    }
    const slope = num / den;
    const intercept = meanQ - slope * meanP;
    // R²
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < logP.length; i++) {
      const pred = slope * logP[i] + intercept;
      ssRes += (logQ[i] - pred) ** 2;
      ssTot += (logQ[i] - meanQ) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    return { e: slope, r2 };
  }

  // ============ MAIN PIPELINE ============
  function processData() {
    if (!RAW || !MAPPING) return null;

    const m = MAPPING;
    // Construir registros normalizados
    const records = RAW.map(r => {
      const precio = parseFloat(r[m.precio]);
      const qty = parseFloat(r[m.qty]);
      const costo = m.costo ? parseFloat(r[m.costo]) : null;
      const revenue = m.revenue ? parseFloat(r[m.revenue]) : (precio * qty);
      const utilidad = m.utilidad ? parseFloat(r[m.utilidad]) : (costo ? (precio - costo) * qty : null);
      const margen = m.margen ? parseFloat(r[m.margen]) : (costo && precio ? (precio - costo) / precio : null);
      return {
        sku: r[m.sku],
        nombre: m.nombre ? r[m.nombre] : 'SKU ' + r[m.sku],
        categoria: m.categoria ? r[m.categoria] : 'General',
        marca: m.marca ? r[m.marca] : 'Sin marca',
        tienda: m.tienda ? r[m.tienda] : null,
        proveedor: m.proveedor ? r[m.proveedor] : null,
        precio, qty, costo, revenue, utilidad, margen,
        año: m.año ? parseInt(r[m.año]) : null,
        mes: m.mes ? r[m.mes] : null,
        dia: m.dia ? parseInt(r[m.dia]) : null,
        fecha: m.fecha ? r[m.fecha] : null,
      };
    }).filter(r => Number.isFinite(r.precio) && Number.isFinite(r.qty) && r.precio > 0 && r.qty > 0 && r.sku);

    if (!records.length) return null;

    // ===== Aggregation por SKU =====
    const skuGroups = groupBy(records, r => r.sku);
    const skus = [];
    for (const [sku, items] of skuGroups) {
      const prices = items.map(i => i.precio);
      const qtys = items.map(i => i.qty);
      const costs = items.map(i => i.costo).filter(Number.isFinite);
      const margens = items.map(i => i.margen).filter(Number.isFinite);
      const rev = items.reduce((a,i) => a + (Number.isFinite(i.revenue) ? i.revenue : 0), 0);
      const util = items.reduce((a,i) => a + (Number.isFinite(i.utilidad) ? i.utilidad : 0), 0);
      const units = items.reduce((a,i) => a + i.qty, 0);
      const precioAvg = prices.reduce((a,b) => a+b, 0) / prices.length;
      const costoAvg = costs.length ? costs.reduce((a,b) => a+b, 0) / costs.length : null;
      const margenAvg = margens.length ? margens.reduce((a,b) => a+b, 0) / margens.length :
                        (costoAvg && precioAvg ? (precioAvg - costoAvg) / precioAvg : 0);
      const priceStd = (() => {
        const m = precioAvg;
        return Math.sqrt(prices.reduce((a,p) => a + (p-m)**2, 0) / prices.length);
      })();

      const { e, r2 } = calcElasticity(prices, qtys);
      const tiendas = new Set(items.map(i => i.tienda).filter(Boolean)).size;

      skus.push({
        sku: String(sku),
        nombre: items[0].nombre || ('SKU ' + sku),
        marca: items[0].marca || 'Sin marca',
        categoria: items[0].categoria || 'General',
        precio: +precioAvg.toFixed(2),
        costo: costoAvg ? +costoAvg.toFixed(2) : null,
        margen: +margenAvg.toFixed(4),
        revenue: +rev.toFixed(2),
        unidades: units,
        utilidad: +util.toFixed(2),
        elasticidad: null,  // se rellena abajo
        r2,
        confianza: 'Baja',
        segmento: null,
        accion: null,
        accion_pct: 0,
        razon: '',
        tiendas,
        priceVar: precioAvg > 0 ? +(priceStd/precioAvg).toFixed(4) : 0,
        transacciones: items.length,
        _rawElast: e
      });
    }

    // Elasticidad por categoría como fallback
    const catElast = {};
    for (const [cat, items] of groupBy(records, r => r.categoria)) {
      const { e } = calcElasticity(items.map(i => i.precio), items.map(i => i.qty));
      catElast[cat] = e !== null ? e : -1.0;
    }

    for (const s of skus) {
      s.elasticidad = s._rawElast !== null ? +s._rawElast.toFixed(3) : (catElast[s.categoria] !== undefined ? +catElast[s.categoria].toFixed(3) : -1);
      if (s.transacciones < 5) s.confianza = 'Baja';
      else if (s.r2 > 0.5) s.confianza = 'Alta';
      else if (s.r2 > 0.2) s.confianza = 'Media';
      else s.confianza = 'Baja';
      delete s._rawElast;
    }

    // ===== Segmentación =====
    const revs = skus.map(s => s.revenue);
    const mgs = skus.map(s => s.margen);
    const precios = skus.map(s => s.precio);
    const revQ75 = quantile(revs, 0.75);
    const revQ50 = quantile(revs, 0.50);
    const mgQ50 = quantile(mgs, 0.50);
    const mgQ25 = quantile(mgs, 0.25);
    const precioMed = quantile(precios, 0.50);

    for (const s of skus) {
      const rev = s.revenue, mg = s.margen, el = s.elasticidad;
      if (rev >= revQ75 && mg >= mgQ50) s.segmento = 'Hero Product';
      else if (rev >= revQ75 && mg < mgQ50) s.segmento = 'Traffic Driver';
      else if (mg >= mgQ50 && rev < revQ50 && s.precio > precioMed) s.segmento = 'Premium Product';
      else if (mg < mgQ25) s.segmento = 'Margin Killer';
      else if (Math.abs(el) > 1.5) s.segmento = 'Sensitive Product';
      else s.segmento = 'Standard';
    }

    // ===== Recomendaciones =====
    for (const s of skus) {
      const el = s.elasticidad, mg = s.margen;
      let r;
      if (Math.abs(el) < 0.5 && mg > 0.20) {
        r = { accion: 'SUBIR PRECIO', pct: 8, razon: `Elasticidad muy baja (${el.toFixed(2)}). Alta oportunidad de captura de margen sin afectar volumen.` };
      } else if (Math.abs(el) < 0.7 && mg > 0.25) {
        r = { accion: 'SUBIR PRECIO', pct: 5, razon: `Elasticidad baja (${el.toFixed(2)}), margen saludable (${(mg*100).toFixed(1)}%). Demanda poco sensible permite incremento.` };
      } else if (Math.abs(el) > 1.5 && mg < 0.20) {
        r = { accion: 'BAJAR PRECIO', pct: -3, razon: `Producto altamente elástico (${el.toFixed(2)}) con margen bajo. Reducir precio activa volumen.` };
      } else if (mg < 0.10) {
        r = { accion: 'REVISAR COSTO', pct: 0, razon: `Margen crítico (${(mg*100).toFixed(1)}%). Renegociar con proveedor o subir precio gradual.` };
      } else if (Math.abs(el) > 1.2) {
        r = { accion: 'EVITAR PROMO', pct: 0, razon: `Elasticidad alta (${el.toFixed(2)}). Promociones erosionan margen sin generar volumen incremental rentable.` };
      } else if (s.segmento === 'Hero Product') {
        r = { accion: 'MANTENER', pct: 0, razon: 'Producto estrella en balance óptimo. Monitorear sin cambios.' };
      } else {
        r = { accion: 'MANTENER', pct: 0, razon: 'Performance estable, sin oportunidad clara identificada.' };
      }
      s.accion = r.accion; s.accion_pct = r.pct; s.razon = r.razon;
    }

    // ===== Agregaciones para dashboard =====
    const totalRev = records.reduce((a,r) => a + (r.revenue || 0), 0);
    const totalUtil = records.reduce((a,r) => a + (r.utilidad || 0), 0);
    const totalUnits = records.reduce((a,r) => a + r.qty, 0);
    const avgMg = (() => {
      const arr = records.map(r => r.margen).filter(Number.isFinite);
      return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
    })();

    const kpis = {
      revenue_total: totalRev,
      utilidad_total: totalUtil,
      margen_avg: avgMg,
      unidades: totalUnits,
      transacciones: records.length,
      skus: skus.length,
      marcas: new Set(records.map(r => r.marca)).size,
      tiendas: new Set(records.map(r => r.tienda).filter(Boolean)).size,
      ticket_promedio: records.length ? totalRev / records.length : 0
    };

    // Tendencia temporal (si hay año+mes)
    let monthly = [];
    if (MAPPING.año && MAPPING.mes) {
      const monthMap = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12,
                          january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
      const grouped = groupBy(records, r => {
        let mNum;
        const mLower = String(r.mes).toLowerCase().replace('.','').replace('trim','').trim();
        mNum = monthMap[mLower] || (parseInt(r.mes) || 0);
        return r.año + '-' + String(mNum).padStart(2, '0');
      });
      monthly = [...grouped.entries()]
        .filter(([k]) => !k.includes('NaN') && !k.includes('undefined'))
        .map(([k, items]) => ({
          periodo: k,
          revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
          unidades: items.reduce((a,i) => a + i.qty, 0),
          utilidad: items.reduce((a,i) => a + (i.utilidad || 0), 0)
        }))
        .sort((a,b) => a.periodo.localeCompare(b.periodo));
    } else if (MAPPING.fecha) {
      const grouped = groupBy(records, r => {
        const d = new Date(r.fecha);
        return Number.isFinite(d.getTime()) ? d.toISOString().substring(0,7) : null;
      });
      monthly = [...grouped.entries()].filter(([k]) => k).map(([k, items]) => ({
        periodo: k,
        revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
        unidades: items.reduce((a,i) => a + i.qty, 0),
        utilidad: items.reduce((a,i) => a + (i.utilidad || 0), 0)
      })).sort((a,b) => a.periodo.localeCompare(b.periodo));
    }

    // Top categorías
    const categorias = [...groupBy(records, r => r.categoria).entries()].map(([nombre, items]) => ({
      nombre,
      revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
      unidades: items.reduce((a,i) => a + i.qty, 0),
      skus: new Set(items.map(i => i.sku)).size
    })).sort((a,b) => b.revenue - a.revenue);

    // Top marcas
    const marcas = [...groupBy(records, r => r.marca).entries()].map(([nombre, items]) => ({
      nombre,
      revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
      unidades: items.reduce((a,i) => a + i.qty, 0)
    })).sort((a,b) => b.revenue - a.revenue);

    // Top tiendas
    const tiendas = [...groupBy(records.filter(r => r.tienda), r => r.tienda).entries()].map(([nombre, items]) => ({
      nombre,
      revenue: items.reduce((a,i) => a + (i.revenue || 0), 0),
      unidades: items.reduce((a,i) => a + i.qty, 0),
      margen: (() => { const arr = items.map(i => i.margen).filter(Number.isFinite); return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; })()
    })).sort((a,b) => b.revenue - a.revenue).slice(0, 20);

    // Curvas de elasticidad (top 60 SKUs)
    const skuTopByRev = [...skus].sort((a,b) => b.revenue - a.revenue).slice(0, 60);
    const elastCurves = {};
    for (const s of skuTopByRev) {
      const items = skuGroups.get(s.sku) || skuGroups.get(parseInt(s.sku)) || [];
      if (items.length < 5) continue;
      // Bucket por precio
      const buckets = new Map();
      for (const i of items) {
        const key = Math.round(i.precio * 100) / 100;
        if (!buckets.has(key)) buckets.set(key, 0);
        buckets.set(key, buckets.get(key) + i.qty);
      }
      const sorted = [...buckets.entries()].sort((a,b) => a[0] - b[0]);
      if (sorted.length >= 3) {
        elastCurves[s.sku] = { precios: sorted.map(x => x[0]), cantidades: sorted.map(x => x[1]) };
      }
    }

    // Anomalías
    const anomalias = [];
    for (const s of skus.filter(s => s.margen < 0.05).slice(0, 8)) {
      anomalias.push({ tipo: 'critico', sku: s.sku, marca: s.marca, mensaje: `Margen crítico ${(s.margen*100).toFixed(1)}% — riesgo destrucción de margen` });
    }
    for (const s of skus.filter(s => s.priceVar > 0.3).slice(0, 8)) {
      anomalias.push({ tipo: 'warning', sku: s.sku, marca: s.marca, mensaje: `Variación de precio anormal (${(s.priceVar*100).toFixed(1)}%) entre tiendas/fechas` });
    }
    if (!anomalias.length) {
      anomalias.push({ tipo: 'info', sku: '—', marca: '—', mensaje: 'Sin anomalías críticas detectadas en este dataset.' });
    }

    // Insights
    const oppSkus = skus.filter(s => s.accion === 'SUBIR PRECIO');
    const oppRev = oppSkus.reduce((a,s) => a + s.revenue * (s.accion_pct/100) * (1 + s.elasticidad * (s.accion_pct/100)), 0);
    const pctSubir = (oppSkus.length / skus.length * 100);
    const topCat = categorias[0];
    const topMarca = marcas[0];
    const marcaShare = topMarca && totalRev ? (topMarca.revenue / totalRev * 100) : 0;

    const insights = [
      {
        titulo: `${pctSubir.toFixed(0)}% de los SKUs tienen oportunidad de incremento de precio`,
        descripcion: `Identificamos ${oppSkus.length} productos con elasticidad baja donde un ajuste al alza captura margen sin sacrificar volumen significativo.`,
        tipo: 'oportunidad',
        valor: '+' + fmt.money(Math.abs(oppRev))
      },
      topMarca ? {
        titulo: `${topMarca.nombre} es la marca dominante con ${marcaShare.toFixed(0)}% del revenue`,
        descripcion: `Concentra el mayor volumen de ventas. Optimizar pricing en esta marca tiene impacto desproporcionado en utilidad.`,
        tipo: 'estrategico',
        valor: fmt.money(topMarca.revenue)
      } : null,
      topCat ? {
        titulo: `${topCat.nombre} es la categoría #1 con ${fmt.money(topCat.revenue)} en revenue`,
        descripcion: `Concentra ${topCat.skus} SKUs activos. Categoría prioritaria para estrategia de pricing dinámico.`,
        tipo: 'categoria',
        valor: (totalRev ? (topCat.revenue/totalRev*100).toFixed(0) : '0') + '% share'
      } : null,
      anomalias.length && anomalias[0].tipo !== 'info' ? {
        titulo: `${anomalias.length} anomalías de pricing detectadas`,
        descripcion: `Productos con márgenes críticos o variación inconsistente de precio entre tiendas requieren intervención inmediata.`,
        tipo: 'riesgo',
        valor: `${anomalias.length} SKUs`
      } : null,
      totalRev > 0 ? {
        titulo: 'Potencial estimado de incremento en utilidad',
        descripcion: 'Aplicando recomendaciones de pricing en SKUs con elasticidad baja y margen saludable, sin afectar volumen relevante.',
        tipo: 'oportunidad',
        valor: '+' + (Math.abs(oppRev)/totalRev*100).toFixed(1) + '%'
      } : null
    ].filter(Boolean);

    return {
      kpis, skus, monthly, categorias, marcas, tiendas,
      elastCurves, insights, anomalias,
      meta: {
        filasTotales: records.length,
        skusTotales: skus.length,
        periodo: monthly.length ? `${monthly[0].periodo} → ${monthly[monthly.length-1].periodo}` : '—',
      }
    };
  }

  // ============ RENDER: ALL VIEWS ============
  const segColors = {
    'Hero Product': '#FFD100', 'Traffic Driver': '#4d9fff',
    'Premium Product': '#b388ff', 'Margin Killer': '#ff4d6d',
    'Sensitive Product': '#00d68f', 'Standard': '#6b6b78',
  };
  const segClass = { 'Hero Product':'hero','Traffic Driver':'traffic','Premium Product':'premium','Margin Killer':'killer','Sensitive Product':'sensitive','Standard':'standard' };
  const segDefs = {
    'Hero Product': { icon: '★', desc: 'Alto revenue + margen saludable. Producto estrella. Estrategia: mantener precio, defender posición.' },
    'Traffic Driver': { icon: '↗', desc: 'Alto volumen pero margen bajo. Atrae tráfico. Estrategia: usar para promo, cross-sell con premium.' },
    'Premium Product': { icon: '◆', desc: 'Margen alto, volumen menor. Posicionamiento aspiracional. Estrategia: defender pricing, comunicar valor.' },
    'Margin Killer': { icon: '⚠', desc: 'Margen crítico. Drena rentabilidad. Estrategia: renegociar costo, subir precio o discontinuar.' },
    'Sensitive Product': { icon: '⚡', desc: 'Demanda altamente elástica. Estrategia: evitar cambios bruscos, promo selectiva.' },
    'Standard': { icon: '•', desc: 'Performance estable, sin oportunidad clara. Mantener bajo monitoreo.' },
  };
  const actionPill = { 'SUBIR PRECIO':'pill-green','BAJAR PRECIO':'pill-blue','EVITAR PROMO':'pill-yellow','REVISAR COSTO':'pill-red','MANTENER':'pill-gray' };
  const actionArrow = { 'SUBIR PRECIO':'↑','BAJAR PRECIO':'↓','EVITAR PROMO':'⊘','REVISAR COSTO':'⚙','MANTENER':'=' };
  const insightIcons = { oportunidad: '↗', riesgo: '⚠', estrategico: '◆', categoria: '★' };

  function renderAll() {
    if (!DATASET) return;
    const k = DATASET.kpis;

    // ===== Dashboard =====
    document.getElementById('kpiGrid').innerHTML = [
      { label: 'Revenue total', value: fmt.money(k.revenue_total), meta: 'Periodo completo', accent: true },
      { label: 'Utilidad total', value: fmt.money(k.utilidad_total), meta: 'Profit acumulado' },
      { label: 'Margen promedio', value: (k.margen_avg*100).toFixed(1) + '%', meta: 'Ponderado' },
      { label: 'Unidades vendidas', value: fmt.num(k.unidades), meta: `${fmt.num(k.transacciones)} transacciones` },
      { label: 'SKUs activos', value: fmt.num(k.skus), meta: `${k.marcas} marcas` },
      ...(k.tiendas ? [{ label: 'Tiendas / canales', value: fmt.num(k.tiendas), meta: 'Cobertura' }] : []),
      { label: 'Ticket promedio', value: fmt.money2(k.ticket_promedio), meta: 'Por transacción' },
    ].map(k => `
      <div class="kpi ${k.accent ? 'accent' : ''}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-meta"><span>${k.meta}</span></div>
      </div>
    `).join('');

    document.getElementById('periodPill').textContent = DATASET.meta.periodo;

    renderCharts();
    renderElasticity();
    renderSimulator();
    renderSegmentation();
    renderRecommendations();
    renderInsights();
    renderAnomalies();
    renderSkuTable();
    renderExecutive();
  }

  // ============ CHARTS ============
  const baseScale = {
    grid: { color: 'rgba(42,42,53,0.6)', drawTicks: false },
    ticks: { color: '#6b6b78', font: { size: 10 } },
    border: { display: false }
  };
  const tooltipStyle = { backgroundColor: '#131318', borderColor: '#2a2a35', borderWidth: 1, titleColor: '#fff', bodyColor: '#a8a8b3', padding: 10 };

  function destroyCharts() {
    [curveChart, simChart, monthlyChart, catChart, marcaChart, elastScatterChart, elastHistChart, segChart, execChart].forEach(c => { try { c && c.destroy(); } catch(e){} });
  }

  function renderCharts() {
    destroyCharts();

    // Monthly
    if (DATASET.monthly.length) {
      monthlyChart = new Chart(document.getElementById('chartMonthly'), {
        type: 'line',
        data: {
          labels: DATASET.monthly.map(m => m.periodo),
          datasets: [
            { label: 'Revenue', data: DATASET.monthly.map(m => m.revenue),
              borderColor: '#FFD100',
              backgroundColor: ctx => { const g = ctx.chart.ctx.createLinearGradient(0,0,0,300); g.addColorStop(0,'rgba(255,209,0,0.3)'); g.addColorStop(1,'rgba(255,209,0,0)'); return g; },
              borderWidth: 2, tension: 0.4, fill: true, pointRadius: 0, pointHoverRadius: 5 },
            { label: 'Utilidad', data: DATASET.monthly.map(m => m.utilidad),
              borderColor: '#00d68f', borderWidth: 2, tension: 0.4, fill: false, pointRadius: 0, pointHoverRadius: 5 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8 } }, tooltip: { ...tooltipStyle, callbacks: { label: c => c.dataset.label + ': ' + fmt.money2(c.parsed.y) } } },
          scales: { x: baseScale, y: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } } }
        }
      });
    } else {
      document.getElementById('chartMonthly').parentElement.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:var(--text-3);font-size:12.5px;">Sin columnas de fecha en el dataset</div>';
    }

    // Categorías
    const cats = DATASET.categorias.slice(0, 8);
    catChart = new Chart(document.getElementById('chartCategorias'), {
      type: 'bar',
      data: { labels: cats.map(c => c.nombre.length > 18 ? c.nombre.substring(0,16)+'…' : c.nombre),
        datasets: [{ data: cats.map(c => c.revenue),
          backgroundColor: cats.map((_,i) => i === 0 ? '#FFD100' : i === 1 ? '#FFA500' : i === 2 ? '#FF7B00' : `rgba(255,209,0,${0.7 - i*0.07})`),
          borderRadius: 4 }]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...tooltipStyle, callbacks: { label: c => fmt.money2(c.parsed.x) } } },
        scales: { x: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } }, y: { ...baseScale, grid: { display: false } } }
      }
    });

    // Marcas
    const marcas = DATASET.marcas.slice(0, 10);
    marcaChart = new Chart(document.getElementById('chartMarcas'), {
      type: 'doughnut',
      data: { labels: marcas.map(m => m.nombre),
        datasets: [{ data: marcas.map(m => m.revenue),
          backgroundColor: ['#FFD100','#FFA500','#FF7B00','#4d9fff','#00d68f','#b388ff','#ff4d6d','#6b6b78','#3a3a48','#2a2a35'],
          borderColor: '#0d0d10', borderWidth: 2, hoverOffset: 6 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 }, padding: 8 } },
          tooltip: { ...tooltipStyle, callbacks: { label: c => `${c.label}: ${fmt.money(c.parsed)}` } } }
      }
    });

    // Top tiendas table
    if (DATASET.tiendas.length) {
      document.getElementById('topTiendas').innerHTML = `
        <thead><tr><th>Tienda / Canal</th><th style="text-align:right">Revenue</th><th style="text-align:right">Units</th><th style="text-align:right">Mg%</th></tr></thead>
        <tbody>${DATASET.tiendas.slice(0,12).map(t => `
          <tr><td class="strong">${String(t.nombre).substring(0,22)}</td>
          <td class="num" style="text-align:right">${fmt.money(t.revenue)}</td>
          <td class="num" style="text-align:right">${t.unidades}</td>
          <td class="num" style="text-align:right">${(t.margen*100).toFixed(1)}%</td></tr>
        `).join('')}</tbody>`;
    } else {
      document.getElementById('topTiendas').innerHTML = `<tbody><tr><td style="padding:24px;color:var(--text-3);text-align:center;">Sin columna de tienda en el dataset</td></tr></tbody>`;
    }
  }

  function renderElasticity() {
    const skus = DATASET.skus;
    const inelastic = skus.filter(s => Math.abs(s.elasticidad) < 1).length;
    const unitary = skus.filter(s => Math.abs(s.elasticidad) >= 1 && Math.abs(s.elasticidad) < 1.5).length;
    const elastic = skus.filter(s => Math.abs(s.elasticidad) >= 1.5).length;
    const avg = skus.reduce((a,s) => a + s.elasticidad, 0) / skus.length;
    document.getElementById('elasticBadges').innerHTML = `
      <div class="kpi"><div class="kpi-label">Elasticidad promedio</div><div class="kpi-value">${avg.toFixed(2)}</div><div class="kpi-meta">Portafolio agregado</div></div>
      <div class="kpi accent"><div class="kpi-label">Inelásticos · |E|&lt;1</div><div class="kpi-value">${inelastic}</div><div class="kpi-meta">Poder de pricing alto</div></div>
      <div class="kpi"><div class="kpi-label">Unitarios</div><div class="kpi-value">${unitary}</div><div class="kpi-meta">Zona neutral</div></div>
      <div class="kpi"><div class="kpi-label">Elásticos · |E|&gt;1.5</div><div class="kpi-value">${elastic}</div><div class="kpi-meta">Sensibles al precio</div></div>
    `;

    elastScatterChart = new Chart(document.getElementById('chartElasticScatter'), {
      type: 'bubble',
      data: { datasets: Object.keys(segColors).map(seg => ({
        label: seg,
        data: skus.filter(s => s.segmento === seg).map(s => ({ x: s.elasticidad, y: s.margen*100, r: Math.min(20, Math.max(3, Math.sqrt(s.revenue)/15)), sku: s })),
        backgroundColor: segColors[seg] + 'CC', borderColor: segColors[seg], borderWidth: 1
      })) },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10.5 } } },
          tooltip: { ...tooltipStyle, callbacks: { title: c => c[0].raw.sku.nombre + ' · ' + c[0].raw.sku.marca, label: c => `Elast: ${c.raw.x.toFixed(2)} · Mg: ${c.raw.y.toFixed(1)}% · Rev: ${fmt.money(c.raw.sku.revenue)}` } } },
        scales: { x: { ...baseScale, title: { display: true, text: 'Elasticidad', color: '#6b6b78' } }, y: { ...baseScale, title: { display: true, text: 'Margen %', color: '#6b6b78' } } }
      }
    });

    const bins = [-4,-3,-2.5,-2,-1.5,-1,-0.5,0,0.5];
    const histData = new Array(bins.length-1).fill(0);
    skus.forEach(s => { for (let i=0; i<bins.length-1; i++) { if (s.elasticidad >= bins[i] && s.elasticidad < bins[i+1]) { histData[i]++; break; } } });
    elastHistChart = new Chart(document.getElementById('chartElasticHist'), {
      type: 'bar',
      data: { labels: bins.slice(0,-1).map((b,i) => `${b}→${bins[i+1]}`),
        datasets: [{ data: histData,
          backgroundColor: bins.slice(0,-1).map(b => Math.abs(b) < 1 ? '#FFD100' : Math.abs(b) < 1.5 ? '#FFA500' : '#FF7B00'),
          borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipStyle },
        scales: { x: { ...baseScale, grid: { display: false } }, y: baseScale }
      }
    });

    // Curve selector
    const curveSkus = skus.filter(s => DATASET.elastCurves[s.sku]).slice(0, 60);
    const sel = document.getElementById('elastSkuSelect');
    sel.innerHTML = curveSkus.map(s => `<option value="${s.sku}">${s.nombre} · ${s.marca} · ${s.sku}</option>`).join('');
    sel.onchange = e => drawCurve(e.target.value);
    if (curveSkus.length) drawCurve(curveSkus[0].sku);
    else document.getElementById('chartCurve').parentElement.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:var(--text-3);">Insuficiente variación de precio para curvas</div>';
  }

  function drawCurve(skuId) {
    const data = DATASET.elastCurves[skuId];
    if (!data) return;
    const sku = DATASET.skus.find(s => s.sku == skuId);
    if (curveChart) curveChart.destroy();
    const pmin = Math.min(...data.precios), pmax = Math.max(...data.precios);
    const qref = data.cantidades.reduce((a,b)=>a+b,0) / data.cantidades.length;
    const pref = data.precios.reduce((a,b)=>a+b,0) / data.precios.length;
    const fittedPts = [];
    for (let i = 0; i <= 20; i++) { const p = pmin + (pmax-pmin)*i/20; fittedPts.push({x: p, y: qref * Math.pow(p/pref, sku.elasticidad)}); }
    curveChart = new Chart(document.getElementById('chartCurve'), {
      type: 'scatter',
      data: { datasets: [
        { label: 'Observaciones (precio → unidades)', data: data.precios.map((p,i) => ({x: p, y: data.cantidades[i]})),
          backgroundColor: '#FFD100DD', borderColor: '#FFD100', borderWidth: 1, pointRadius: 6, pointHoverRadius: 9 },
        { label: `Curva ajustada (E = ${sku.elasticidad.toFixed(2)})`, type: 'line', data: fittedPts,
          borderColor: '#FFA500', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false }
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8 } }, tooltip: tooltipStyle },
        scales: { x: { ...baseScale, title: { display: true, text: 'Precio ($)', color: '#6b6b78' } },
                  y: { ...baseScale, title: { display: true, text: 'Unidades demandadas', color: '#6b6b78' } } }
      }
    });
  }

  function renderSimulator() {
    const sel = document.getElementById('simSkuSelect');
    sel.innerHTML = DATASET.skus.slice(0, Math.min(200, DATASET.skus.length))
      .sort((a,b) => b.revenue - a.revenue)
      .map(s => `<option value="${s.sku}">${s.nombre} · ${s.marca} · SKU ${s.sku}</option>`).join('');
    sel.onchange = updateSim;
    document.getElementById('simPrice').oninput = updateSim;
    document.getElementById('simCost').oninput = updateSim;
    document.getElementById('simPromo').oninput = updateSim;
    document.querySelectorAll('.quick-btn[data-price]').forEach(b => b.onclick = () => { document.getElementById('simPrice').value = b.dataset.price; updateSim(); });
    updateSim();
  }

  function updateSim() {
    if (!DATASET) return;
    const sku = DATASET.skus.find(s => s.sku == document.getElementById('simSkuSelect').value);
    if (!sku) return;
    const dP = parseFloat(document.getElementById('simPrice').value) / 100;
    const dC = parseFloat(document.getElementById('simCost').value) / 100;
    const promo = parseFloat(document.getElementById('simPromo').value) / 100;
    document.getElementById('simPriceLabel').textContent = fmt.signed(dP*100);
    document.getElementById('simCostLabel').textContent = fmt.signed(dC*100);
    document.getElementById('simPromoLabel').textContent = (promo*100).toFixed(0) + '%';

    document.getElementById('simProductInfo').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
        <div><div class="label">SKU</div><div class="value">${sku.sku}</div></div>
        <div><div class="label">Marca</div><div class="value" style="font-family:'Manrope',sans-serif">${sku.marca}</div></div>
        <div><div class="label">Precio base</div><div class="value">${fmt.money2(sku.precio)}</div></div>
        <div><div class="label">Costo</div><div class="value">${sku.costo ? fmt.money2(sku.costo) : '—'}</div></div>
        <div><div class="label">Margen actual</div><div class="value">${(sku.margen*100).toFixed(1)}%</div></div>
        <div><div class="label">Elasticidad</div><div class="value">${sku.elasticidad.toFixed(2)}</div></div>
      </div>`;

    const newPrice = sku.precio * (1 + dP) * (1 - promo);
    const newCost = (sku.costo || 0) * (1 + dC);
    const profitUnit = newPrice - newCost;
    const margin = newPrice > 0 ? profitUnit / newPrice : 0;
    const totalPriceChange = (1 + dP) * (1 - promo) - 1;
    const volRatio = Math.pow(1 + totalPriceChange, sku.elasticidad);
    const baseProfit = sku.precio - (sku.costo || 0);

    const revDelta = newPrice / sku.precio - 1;
    const profDelta = baseProfit > 0 ? profitUnit / baseProfit - 1 : 0;
    const marDelta = margin - sku.margen;
    const volDelta = volRatio - 1;

    const setDelta = (id, val) => {
      const el = document.getElementById(id);
      el.textContent = fmt.signed(val*100);
      el.className = 'value-delta ' + (val > 0.005 ? 'delta-up' : val < -0.005 ? 'delta-down' : 'delta-flat');
    };
    document.getElementById('simRev').textContent = fmt.money2(newPrice);
    document.getElementById('simProfit').textContent = fmt.money2(profitUnit);
    document.getElementById('simMargin').textContent = (margin*100).toFixed(1) + '%';
    document.getElementById('simVol').textContent = (volRatio*100).toFixed(0);
    setDelta('simRevDelta', revDelta); setDelta('simProfitDelta', profDelta); setDelta('simMarginDelta', marDelta); setDelta('simVolDelta', volDelta);

    const totalProfitImpact = profitUnit * volRatio - baseProfit;
    let reco;
    if (baseProfit <= 0) reco = `<span style="color:var(--text-2);font-weight:600;">○ Sin costo válido.</span> No es posible calcular impacto en utilidad para este SKU.`;
    else if (totalProfitImpact > baseProfit * 0.05) reco = `<span style="color:var(--green);font-weight:600;">✓ Escenario favorable.</span> Impacto en utilidad estimado: ${fmt.signed((totalProfitImpact/baseProfit)*100)}. La elasticidad (${sku.elasticidad.toFixed(2)}) permite esta acción sin destruir volumen.`;
    else if (totalProfitImpact < -baseProfit * 0.05) reco = `<span style="color:var(--red);font-weight:600;">✗ Escenario desfavorable.</span> Impacto negativo de ${fmt.signed((totalProfitImpact/baseProfit)*100)}. El cambio activa una reacción de demanda que erosiona utilidad.`;
    else reco = `<span style="color:var(--text-2);font-weight:600;">○ Escenario neutro.</span> Cambio marginal. Considera otras palancas (cost-down, mix, promo selectiva).`;
    document.getElementById('simReco').innerHTML = reco;

    if (simChart) simChart.destroy();
    const pts = [];
    for (let i = -30; i <= 30; i += 2) {
      const dp = i/100;
      const np = sku.precio * (1 + dp);
      const vr = Math.pow(1 + dp, sku.elasticidad);
      pts.push({ price_change: i, np, rev: np*vr, prof: (np - (sku.costo||0)) * vr });
    }
    simChart = new Chart(document.getElementById('chartSim'), {
      type: 'line',
      data: { labels: pts.map(p => fmt.signed(p.price_change)),
        datasets: [
          { label: 'Revenue × volumen', data: pts.map(p => p.rev), borderColor: '#FFD100', tension: 0.3, pointRadius: 0, borderWidth: 2 },
          { label: 'Utilidad × volumen', data: pts.map(p => p.prof), borderColor: '#00d68f', tension: 0.3, pointRadius: 0, borderWidth: 2 },
        ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8 } },
          tooltip: { ...tooltipStyle, callbacks: { label: c => c.dataset.label + ': ' + fmt.money2(c.parsed.y) } } },
        scales: { x: { ...baseScale, title: { display: true, text: 'Cambio de precio', color: '#6b6b78' } },
                  y: { ...baseScale, ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } } }
      }
    });
  }

  function renderSegmentation() {
    const segs = ['Hero Product','Traffic Driver','Premium Product','Margin Killer','Sensitive Product','Standard'];
    document.getElementById('segGrid').innerHTML = segs.map(s => {
      const items = DATASET.skus.filter(x => x.segmento === s);
      const rev = items.reduce((a,b) => a + b.revenue, 0);
      return `<div class="seg-card ${segClass[s]}">
        <div class="seg-icon">${segDefs[s].icon}</div>
        <div class="seg-name">${s}</div>
        <div class="seg-count">${items.length}</div>
        <div class="seg-desc">${segDefs[s].desc}</div>
        <div class="seg-meta"><span>Revenue</span><span class="mono">${fmt.money(rev)}</span></div>
      </div>`;
    }).join('');

    segChart = new Chart(document.getElementById('chartSegmento'), {
      type: 'bar',
      data: { labels: segs,
        datasets: [
          { label: 'Revenue', data: segs.map(s => DATASET.skus.filter(x => x.segmento === s).reduce((a,b)=>a+b.revenue, 0)), backgroundColor: segs.map(s => segColors[s]), borderRadius: 4, yAxisID: 'y' },
          { label: '# SKUs', data: segs.map(s => DATASET.skus.filter(x => x.segmento === s).length), backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 4, yAxisID: 'y1' }
        ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8 } }, tooltip: tooltipStyle },
        scales: { x: { ...baseScale, grid: { display: false } },
                  y: { ...baseScale, position: 'left', ticks: { ...baseScale.ticks, callback: v => fmt.money(v) } },
                  y1: { ...baseScale, position: 'right', grid: { display: false } } }
      }
    });
  }

  function renderRecommendations() {
    const filtered = recFilter === 'all' ? DATASET.skus.filter(s => s.accion !== 'MANTENER') : DATASET.skus.filter(s => s.accion === recFilter);
    const sorted = filtered.sort((a,b) => b.revenue - a.revenue).slice(0, 80);
    document.getElementById('recsList').innerHTML = sorted.length ? sorted.map(s => `
      <div class="rec-row">
        <div class="rec-sku">SKU<br>${s.sku}</div>
        <div class="rec-info">
          <div class="name">${s.nombre} <span style="color: var(--text-3); font-weight: 500;">· ${s.marca}</span></div>
          <div class="meta">Precio ${fmt.money2(s.precio)} · Mg ${(s.margen*100).toFixed(1)}% · E ${s.elasticidad.toFixed(2)} · <span class="pill pill-gray" style="font-size:9.5px">${s.segmento}</span></div>
          <div class="rec-reason">${s.razon}</div>
        </div>
        <div style="text-align: center;">
          <span class="pill ${actionPill[s.accion]}">${actionArrow[s.accion]} ${s.accion}</span>
          ${s.accion_pct !== 0 ? `<div class="mono" style="font-size: 14px; font-weight: 600; margin-top: 6px; color: ${s.accion_pct > 0 ? 'var(--green)':'var(--red)'};">${s.accion_pct > 0?'+':''}${s.accion_pct}%</div>` : ''}
        </div>
        <div class="rec-impact" style="text-align: right;">
          <div style="font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 2px;">Revenue</div>
          ${fmt.money(s.revenue)}
        </div>
      </div>
    `).join('') : '<div style="padding:32px;text-align:center;color:var(--text-3);">Sin recomendaciones para este filtro</div>';

    document.querySelectorAll('[data-filter]').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('primary'));
        b.classList.add('primary');
        recFilter = b.dataset.filter;
        renderRecommendations();
      };
    });
  }

  function renderInsights() {
    document.getElementById('insightsList').innerHTML = DATASET.insights.map(i => `
      <div class="insight ${i.tipo}">
        <div class="insight-icon">${insightIcons[i.tipo]}</div>
        <div class="insight-body">
          <div class="insight-titulo">${i.titulo}</div>
          <div class="insight-desc">${i.descripcion}</div>
        </div>
        <div class="insight-valor">${i.valor}</div>
      </div>
    `).join('');
  }

  function renderAnomalies() {
    document.getElementById('anomList').innerHTML = DATASET.anomalias.map(a => `
      <div class="anomaly ${a.tipo === 'warning' ? 'warning' : a.tipo === 'info' ? 'info' : ''}">
        <div class="anomaly-icon" style="color: ${a.tipo === 'critico' ? 'var(--red)' : a.tipo === 'warning' ? 'var(--yellow)' : 'var(--blue)'};">${a.tipo === 'critico' || a.tipo === 'warning' ? '⚠' : 'ⓘ'}</div>
        <div class="anomaly-body">
          <div class="anomaly-title">${a.mensaje}</div>
          <div class="anomaly-meta">SKU ${a.sku} · ${a.marca}</div>
        </div>
        <span class="pill ${a.tipo === 'critico' ? 'pill-red' : a.tipo === 'warning' ? 'pill-yellow' : 'pill-blue'}">${a.tipo.toUpperCase()}</span>
      </div>
    `).join('');
  }

  function renderSkuTable(filter = '') {
    const f = filter.toLowerCase();
    const filtered = DATASET.skus.filter(s =>
      !f || String(s.nombre).toLowerCase().includes(f) || String(s.marca).toLowerCase().includes(f) || String(s.sku).includes(f) || String(s.segmento).toLowerCase().includes(f)
    ).sort((a,b) => b.revenue - a.revenue);
    document.getElementById('skuCount').textContent = `${filtered.length} de ${DATASET.skus.length} SKUs`;
    document.getElementById('skuTable').innerHTML = `
      <thead><tr>
        <th>SKU</th><th>Producto</th><th>Marca</th><th style="text-align:right">Precio</th>
        <th style="text-align:right">Costo</th><th style="text-align:right">Mg%</th><th style="text-align:right">Revenue</th>
        <th style="text-align:right">Unid.</th><th style="text-align:right">Elast.</th><th>Conf.</th><th>Segmento</th><th>Acción</th>
      </tr></thead>
      <tbody>${filtered.slice(0, 300).map(s => `
        <tr>
          <td class="num">${s.sku}</td>
          <td class="strong" style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.nombre}</td>
          <td>${s.marca}</td>
          <td class="num" style="text-align:right">${fmt.money2(s.precio)}</td>
          <td class="num" style="text-align:right">${s.costo ? fmt.money2(s.costo) : '—'}</td>
          <td class="num" style="text-align:right; color: ${s.margen < 0.1 ? 'var(--red)' : s.margen > 0.3 ? 'var(--green)' : 'var(--text)'};">${(s.margen*100).toFixed(1)}%</td>
          <td class="num" style="text-align:right">${fmt.money(s.revenue)}</td>
          <td class="num" style="text-align:right">${s.unidades}</td>
          <td class="num" style="text-align:right">${s.elasticidad.toFixed(2)}</td>
          <td><span class="pill ${s.confianza === 'Alta' ? 'pill-green' : s.confianza === 'Media' ? 'pill-yellow' : 'pill-gray'}">${s.confianza}</span></td>
          <td><span class="pill ${segClass[s.segmento] === 'hero' ? 'pill-yellow' : segClass[s.segmento] === 'traffic' ? 'pill-blue' : segClass[s.segmento] === 'premium' ? 'pill-purple' : segClass[s.segmento] === 'killer' ? 'pill-red' : 'pill-gray'}">${s.segmento}</span></td>
          <td><span class="pill ${actionPill[s.accion]}">${actionArrow[s.accion]} ${s.accion.split(' ')[0]}</span></td>
        </tr>
      `).join('')}</tbody>
    `;
  }

  function renderExecutive() {
    const k = DATASET.kpis;
    const opp = DATASET.skus.filter(s => s.accion === 'SUBIR PRECIO');
    const oppRev = opp.reduce((a,s) => a + s.revenue * (s.accion_pct/100), 0);
    document.getElementById('execSubtitle').textContent = `Análisis de ${DATASET.meta.skusTotales} SKUs sobre ${fmt.num(DATASET.meta.filasTotales)} transacciones. Decisiones priorizadas con impacto cuantificado.`;
    document.getElementById('execStats').innerHTML = `
      <div class="exec-stat"><div class="exec-stat-value" style="color: var(--yellow);">${fmt.money(k.revenue_total)}</div><div class="exec-stat-label">Revenue analizado</div></div>
      <div class="exec-stat"><div class="exec-stat-value" style="color: var(--green);">+${fmt.money(Math.abs(oppRev))}</div><div class="exec-stat-label">Oportunidad estimada</div></div>
      <div class="exec-stat"><div class="exec-stat-value">${opp.length}</div><div class="exec-stat-label">SKUs para acción</div></div>
      <div class="exec-stat"><div class="exec-stat-value" style="color: var(--red);">${DATASET.skus.filter(s => s.margen < 0.1).length}</div><div class="exec-stat-label">Margen crítico</div></div>
    `;
    const top = opp.sort((a,b) => b.revenue - a.revenue).slice(0, 5);
    document.getElementById('execActions').innerHTML = top.length ? top.map(s => `
      <div style="background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; gap: 14px; align-items: center;">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--yellow-dim);color:var(--yellow);display:grid;place-items:center;font-size:18px;font-weight:700;">↑</div>
        <div style="flex: 1;">
          <div style="font-size: 13.5px; font-weight: 600;">${s.nombre} · ${s.marca}</div>
          <div style="font-size: 11.5px; color: var(--text-3); margin-top: 2px;">SKU ${s.sku} · ${fmt.money2(s.precio)} → ${fmt.money2(s.precio*(1+s.accion_pct/100))}</div>
        </div>
        <div style="text-align: right;">
          <div class="mono" style="font-size: 14px; font-weight: 600; color: var(--green);">+${s.accion_pct}%</div>
          <div style="font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;">Precio</div>
        </div>
      </div>
    `).join('') : '<div style="padding:20px;color:var(--text-3);text-align:center;">Sin acciones prioritarias detectadas</div>';

    const counts = {};
    DATASET.skus.forEach(s => counts[s.accion] = (counts[s.accion]||0) + 1);
    execChart = new Chart(document.getElementById('chartExec'), {
      type: 'doughnut',
      data: { labels: Object.keys(counts),
        datasets: [{ data: Object.values(counts),
          backgroundColor: Object.keys(counts).map(a => a === 'SUBIR PRECIO' ? '#00d68f' : a === 'BAJAR PRECIO' ? '#4d9fff' : a === 'EVITAR PROMO' ? '#FFD100' : a === 'REVISAR COSTO' ? '#ff4d6d' : '#6b6b78'),
          borderColor: '#0d0d10', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 8, font: { size: 10.5 } } }, tooltip: tooltipStyle } }
    });
  }

  // ============ FILE PARSING ============
  function parseFile(file) {
    const status = document.getElementById('uploadStatus');
    status.innerHTML = `<div style="display:flex;align-items:center;gap:10px;color:var(--text-2);font-size:13px;"><span class="spinner"></span> Procesando ${file.name}...</div>`;

    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'csv' || ext === 'tsv') {
      Papa.parse(file, {
        header: true, dynamicTyping: false, skipEmptyLines: true,
        complete: results => handleParsed(results.data, file, results.errors),
        error: err => showError(err.message)
      });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          handleParsed(data, file, []);
        } catch (err) { showError('Error al leer Excel: ' + err.message); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      showError('Formato no soportado. Usa CSV, TSV, XLSX o XLS.');
    }
  }

  function showError(msg) {
    document.getElementById('uploadStatus').innerHTML = `<div class="upload-error"><strong>Error:</strong> ${msg}</div>`;
  }

  function handleParsed(data, file, errors) {
    if (!data || !data.length) { showError('Archivo vacío o sin filas válidas.'); return; }
    RAW = data;
    const headers = Object.keys(data[0]);
    MAPPING = detectColumns(headers);

    document.getElementById('uploadStatus').innerHTML = `
      <div class="upload-success">
        <div class="check">✓</div>
        <div><strong>${file.name}</strong><span>${data.length.toLocaleString()} filas · ${headers.length} columnas · ${(file.size/1024).toFixed(1)} KB</span></div>
      </div>`;

    // Mostrar card de validación
    const card = document.getElementById('validationCard');
    card.style.display = '';
    document.getElementById('emptyHelper').style.display = 'none';

    // Validación
    const requiredFields = ['sku', 'precio', 'qty'];
    const missing = requiredFields.filter(f => !MAPPING[f]);
    const validations = [];
    validations.push({ ok: true, msg: `${data.length.toLocaleString()} filas leídas correctamente`, detail: errors.length ? `${errors.length} warnings menores` : 'Sin errores de parsing' });
    validations.push({ ok: missing.length === 0, msg: missing.length === 0 ? 'Columnas obligatorias detectadas' : `Faltan columnas: ${missing.join(', ')}`, detail: 'SKU · Precio · Cantidad son obligatorios' });
    validations.push({ ok: !!MAPPING.costo, msg: MAPPING.costo ? 'Columna de costo detectada' : 'Sin columna de costo', detail: MAPPING.costo ? 'Permitirá cálculo preciso de margen' : 'Se calculará margen si existe (parcial)' });
    validations.push({ ok: true, msg: `${headers.length} columnas detectadas`, detail: 'Tipos inferidos automáticamente' });
    if (MAPPING.fecha || (MAPPING.año && MAPPING.mes)) validations.push({ ok: true, msg: 'Columnas temporales detectadas', detail: 'Análisis de tendencia disponible' });

    document.getElementById('validationList').innerHTML = validations.map(v => `
      <div style="display: flex; align-items: center; gap: 10px; padding: 8px 0;">
        <div style="width: 24px; height: 24px; border-radius: 50%; background: ${v.ok ? 'var(--green-dim)' : 'var(--red-dim)'}; color: ${v.ok ? 'var(--green)':'var(--red)'}; display: grid; place-items: center; font-weight: 700; font-size: 12px;">${v.ok ? '✓' : '×'}</div>
        <div style="flex: 1;"><div style="font-size: 13px; color: var(--text);">${v.msg}</div><div style="font-size: 11.5px; color: var(--text-3); margin-top: 1px;">${v.detail}</div></div>
      </div>`).join('');

    // Mapping grid
    const fields = [
      { key: 'sku', label: 'SKU / Código de producto', required: true },
      { key: 'precio', label: 'Precio unitario', required: true },
      { key: 'qty', label: 'Cantidad vendida', required: true },
      { key: 'costo', label: 'Costo unitario' },
      { key: 'revenue', label: 'Revenue / Ventas' },
      { key: 'margen', label: 'Margen' },
      { key: 'utilidad', label: 'Utilidad / Profit' },
      { key: 'nombre', label: 'Nombre del producto' },
      { key: 'categoria', label: 'Categoría' },
      { key: 'marca', label: 'Marca' },
      { key: 'tienda', label: 'Tienda / Canal' },
      { key: 'proveedor', label: 'Proveedor' },
      { key: 'fecha', label: 'Fecha' },
      { key: 'año', label: 'Año' },
      { key: 'mes', label: 'Mes' },
    ];
    document.getElementById('mappingGrid').innerHTML = fields.map(f => `
      <div class="mapping-grid">
        <div class="map-detected">${MAPPING[f.key] || '<i style="color:var(--text-3)">no detectada</i>'}</div>
        <div class="map-arrow">→</div>
        <div class="map-mapped ${!MAPPING[f.key] && f.required ? 'missing' : ''}">${f.label}${f.required ? ' <span style="color:var(--yellow);font-size:10px;">obligatorio</span>' : ''}</div>
      </div>`).join('');

    document.getElementById('mappingSubtitle').textContent = `${Object.keys(MAPPING).length} de ${fields.length} campos mapeados automáticamente`;

    if (missing.length === 0) {
      document.getElementById('processBtn').style.display = '';
      document.getElementById('processBtn').onclick = processAndUnlock;
    } else {
      document.getElementById('processBtn').style.display = 'none';
    }
  }

  function processAndUnlock() {
    document.getElementById('processBtn').innerHTML = '<span class="spinner"></span> Procesando...';
    setTimeout(() => {
      try {
        DATASET = processData();
        if (!DATASET || !DATASET.skus.length) { showError('No se pudieron procesar registros válidos. Verifica que precio y cantidad sean numéricos > 0.'); return; }
        renderAll();
        unlockAll();
        // Ir al dashboard
        document.querySelector('[data-view="dashboard"]').click();
      } catch (e) {
        showError('Error en procesamiento: ' + e.message);
        console.error(e);
      }
      document.getElementById('processBtn').innerHTML = '<span>Procesar y generar análisis</span><span style="margin-left:6px;">→</span>';
    }, 100);
  }

  function unlockAll() {
    document.querySelectorAll('.nav-item.locked').forEach(n => { n.classList.remove('locked'); n.classList.add('unlocked'); });
    document.getElementById('globalSearchWrap').style.display = '';
    const badge = document.getElementById('liveBadge');
    badge.className = 'badge badge-live';
    badge.textContent = 'LIVE · datos cargados';
    document.getElementById('meta-info').textContent = `${DATASET.meta.filasTotales.toLocaleString()} filas · ${DATASET.meta.skusTotales} SKUs · ${DATASET.meta.periodo}`;
  }

  // ============ NAVIGATION ============
  function setupNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('locked')) return;
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        const view = item.dataset.view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + view).classList.add('active');
        document.getElementById('crumb').textContent = item.textContent.trim();
        // Ocultar overlay
        document.getElementById('lockedOverlay').classList.remove('show');
        window.scrollTo(0, 0);
      });
    });

    document.getElementById('skuSearch').addEventListener('input', e => renderSkuTable(e.target.value));
    document.getElementById('globalSearch').addEventListener('input', e => {
      if (e.target.value.length > 1 && DATASET) {
        document.querySelector('[data-view="skus"]').click();
        document.getElementById('skuSearch').value = e.target.value;
        renderSkuTable(e.target.value);
      }
    });
  }

  // ============ UPLOAD HANDLERS ============
  function setupUpload() {
    const input = document.getElementById('fileInput');
    const zone = document.getElementById('uploadZone');
    input.addEventListener('change', e => { if (e.target.files[0]) parseFile(e.target.files[0]); });
    zone.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') input.click(); });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) parseFile(e.dataTransfer.files[0]);
    });
  }

  // ============ EXPORT ============
  function exportData(type) {
    if (!DATASET) { alert('Carga un archivo primero'); return; }
    let content, fname, mime;
    if (type === 'csv') {
      const header = ['sku','nombre','marca','categoria','precio','costo','margen','revenue','unidades','elasticidad','confianza','segmento','accion','accion_pct','razon'].join(',');
      const rows = DATASET.skus.map(s => [s.sku, '"'+(s.nombre||'').replace(/"/g,"'")+'"', '"'+(s.marca||'').replace(/"/g,"'")+'"', '"'+(s.categoria||'').replace(/"/g,"'")+'"', s.precio, s.costo, s.margen, s.revenue, s.unidades, s.elasticidad, s.confianza, '"'+s.segmento+'"', '"'+s.accion+'"', s.accion_pct, '"'+s.razon.replace(/"/g,"'")+'"'].join(','));
      content = header + '\n' + rows.join('\n');
      fname = 'pricing_intelligence_skus.csv'; mime = 'text/csv';
    } else if (type === 'json') {
      content = JSON.stringify(DATASET, null, 2);
      fname = 'pricing_intelligence_full.json'; mime = 'application/json';
    } else {
      const k = DATASET.kpis;
      const lines = [
        'EXECUTIVE SUMMARY · PRICING INTELLIGENCE PLATFORM',
        '='.repeat(60), '',
        `SKUs analizados: ${DATASET.meta.skusTotales}`,
        `Transacciones: ${DATASET.meta.filasTotales.toLocaleString()}`,
        `Periodo: ${DATASET.meta.periodo}`, '',
        'KPIs PRINCIPALES', '-'.repeat(40),
        `Revenue total: ${fmt.money2(k.revenue_total)}`,
        `Utilidad total: ${fmt.money2(k.utilidad_total)}`,
        `Margen promedio: ${(k.margen_avg*100).toFixed(2)}%`,
        `Unidades: ${k.unidades.toLocaleString()}`, '',
        'INSIGHTS EJECUTIVOS', '-'.repeat(40),
        ...DATASET.insights.map(i => `• ${i.titulo}\n  ${i.descripcion}\n  Valor: ${i.valor}`), '',
        'TOP 10 RECOMENDACIONES', '-'.repeat(40),
        ...DATASET.skus.filter(s => s.accion !== 'MANTENER').sort((a,b)=>b.revenue-a.revenue).slice(0,10).map((s,i) =>
          `${i+1}. ${s.nombre} · ${s.marca}\n   Acción: ${s.accion} (${s.accion_pct >= 0 ? '+' : ''}${s.accion_pct}%) · Revenue ${fmt.money(s.revenue)}\n   ${s.razon}`
        )
      ];
      content = lines.join('\n');
      fname = 'executive_summary.txt'; mime = 'text/plain';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
  }

  // ============ INIT ============
  function init() {
    setupNav();
    setupUpload();
  }

  return { init, exportData };
})();

document.addEventListener('DOMContentLoaded', App.init);

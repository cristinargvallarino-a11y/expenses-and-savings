// Grupos y categorías de gastos/ingresos + clasificación automática por palabras clave.

const GROUPS = {
  necesarios:    { label: 'Necesarios',            color: 'var(--g-necesarios)',    want: false },
  social:        { label: 'Social y ocio',         color: 'var(--g-social)',        want: true },
  viajes:        { label: 'Viajes',                color: 'var(--g-viajes)',        want: true },
  compras:       { label: 'Compras y caprichos',   color: 'var(--g-compras)',       want: true },
  suscripciones: { label: 'Suscripciones',         color: 'var(--g-suscripciones)', want: true },
  otros:         { label: 'Otros',                 color: 'var(--g-otros)',         want: true },
};

const EXPENSE_CATEGORIES = [
  { id: 'vivienda',      label: 'Vivienda (alquiler / hipoteca)', group: 'necesarios',
    keywords: ['alquiler', 'hipoteca', 'comunidad', 'ibi', 'casero', 'renta piso'] },
  { id: 'supermercado',  label: 'Supermercado',                   group: 'necesarios',
    keywords: ['mercadona', 'carrefour', 'lidl', 'aldi', 'dia ', 'eroski', 'alcampo', 'consum', 'hipercor', 'bonpreu', 'supermercado', 'super ', 'fruteria', 'frutería', 'carniceria', 'carnicería', 'panaderia', 'panadería', 'ahorramas', 'caprabo', 'compra semanal'] },
  { id: 'facturas',      label: 'Luz, agua, gas e internet',      group: 'necesarios',
    keywords: ['luz', 'iberdrola', 'endesa', 'naturgy', 'repsol luz', 'agua', 'gas ', 'internet', 'fibra', 'movistar', 'vodafone', 'orange', 'digi ', 'pepephone', 'movil', 'móvil', 'telefono', 'teléfono', 'factura'] },
  { id: 'transporte',    label: 'Transporte',                     group: 'necesarios',
    keywords: ['metro', 'bus ', 'autobus', 'abono', 'renfe', 'cercanias', 'cercanías', 'gasolina', 'gasolinera', 'repsol', 'cepsa', 'bp ', 'shell', 'parking', 'peaje', 'taxi', 'uber', 'cabify', 'bolt', 'bicimad', 'itv', 'taller'] },
  { id: 'salud',         label: 'Salud y farmacia',               group: 'necesarios',
    keywords: ['farmacia', 'medico', 'médico', 'dentista', 'clinica', 'clínica', 'hospital', 'fisio', 'optica', 'óptica', 'psicolog'] },
  { id: 'seguros',       label: 'Seguros',                        group: 'necesarios',
    keywords: ['seguro', 'mapfre', 'sanitas', 'adeslas', 'axa ', 'allianz', 'mutua', 'dkv'] },
  { id: 'educacion',     label: 'Formación',                      group: 'necesarios',
    keywords: ['curso', 'academia', 'matricula', 'matrícula', 'universidad', 'libros texto', 'master', 'máster'] },

  { id: 'restaurantes',  label: 'Restaurantes, bares y cafés',    group: 'social',
    keywords: ['restaurante', 'bar ', 'cena', 'comida fuera', 'almuerzo', 'brunch', 'cafe', 'café', 'cafeteria', 'cafetería', 'starbucks', 'glovo', 'just eat', 'uber eats', 'deliveroo', 'telepizza', 'burger', 'mcdonald', 'kfc', 'cañas', 'cervezas', 'vermut', 'tapas', 'sushi', 'pizzeria', 'pizzería'] },
  { id: 'ocio',          label: 'Planes y ocio',                  group: 'social',
    keywords: ['cine', 'concierto', 'entradas', 'teatro', 'museo', 'discoteca', 'fiesta', 'copas', 'festival', 'bolera', 'escape room', 'ticketmaster', 'padel', 'pádel', 'partido', 'cumpleaños', 'boda', 'despedida'] },
  { id: 'regalos',       label: 'Regalos',                        group: 'social',
    keywords: ['regalo', 'detalle para', 'flores'] },

  { id: 'vuelos',        label: 'Vuelos',                         group: 'viajes',
    keywords: ['vuelo', 'ryanair', 'vueling', 'iberia', 'easyjet', 'air europa', 'wizz', 'volotea', 'lufthansa', 'klm', 'air france', 'tap ', 'binter', 'skyscanner', 'aeropuerto', 'billete avion', 'billete avión', 'emirates', 'qatar', 'level'] },
  { id: 'hoteles',       label: 'Hoteles y alojamiento',          group: 'viajes',
    keywords: ['hotel', 'booking', 'airbnb', 'hostal', 'hostel', 'apartamento turistico', 'apartamento turístico', 'alojamiento', 'expedia', 'parador', 'nh ', 'melia', 'meliá', 'riu '] },
  { id: 'viaje_otros',   label: 'Otros gastos de viaje',          group: 'viajes',
    keywords: ['viaje', 'excursion', 'excursión', 'tour', 'alquiler coche', 'rent a car', 'europcar', 'hertz', 'sixt', 'tren viaje', 'ave ', 'ouigo', 'iryo', 'blablacar', 'visado', 'seguro de viaje', 'souvenir', 'vacaciones'] },

  { id: 'ropa',          label: 'Ropa y compras',                 group: 'compras',
    keywords: ['zara', 'mango', 'h&m', 'primark', 'pull', 'bershka', 'stradivarius', 'massimo dutti', 'uniqlo', 'decathlon', 'ropa', 'zapatos', 'zapatillas', 'amazon', 'aliexpress', 'shein', 'el corte ingles', 'el corte inglés', 'fnac', 'media markt', 'ikea', 'sephora', 'druni', 'primor'] },
  { id: 'caprichos',     label: 'Caprichos y cuidado personal',   group: 'compras',
    keywords: ['capricho', 'peluqueria', 'peluquería', 'uñas', 'manicura', 'estetica', 'estética', 'masaje', 'spa ', 'tattoo', 'tatuaje'] },

  { id: 'suscripciones', label: 'Suscripciones y gimnasio',       group: 'suscripciones',
    keywords: ['netflix', 'spotify', 'hbo', 'max ', 'disney', 'prime video', 'amazon prime', 'apple', 'icloud', 'google one', 'youtube premium', 'dazn', 'filmin', 'gimnasio', 'gym', 'basic fit', 'basic-fit', 'suscripcion', 'suscripción', 'chatgpt', 'claude', 'patreon', 'audible', 'kindle'] },

  { id: 'otros',         label: 'Otros',                          group: 'otros', keywords: [] },
];

const INCOME_CATEGORIES = [
  { id: 'nomina',      label: 'Nómina',                  keywords: ['nomina', 'nómina', 'salario', 'sueldo', 'paga'] },
  { id: 'extra',       label: 'Freelance / trabajos extra', keywords: ['freelance', 'factura cliente', 'proyecto', 'extra', 'bonus', 'bono'] },
  { id: 'rendimientos', label: 'Rendimientos de inversión', keywords: ['dividendo', 'intereses', 'interes', 'interés', 'rendimiento', 'cupon', 'cupón'] },
  { id: 'otros_ing',   label: 'Otros ingresos',          keywords: ['bizum', 'devolucion', 'devolución', 'reembolso', 'venta', 'wallapop', 'vinted', 'regalo'] },
];

const CATEGORY_BY_ID = Object.fromEntries(
  [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((c) => [c.id, c])
);

function normalize(text) {
  // Pads with spaces so keywords like "bar " or "dia " only match whole words.
  return ' ' + text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ';
}

/**
 * Suggests a category id from a free-text description.
 * Returns null when nothing matches. Longer keyword matches win so that
 * e.g. "seguro de viaje" beats "seguro".
 */
function classify(description, type) {
  const text = normalize(description || '');
  const list = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  let best = null;
  let bestLen = 0;
  for (const cat of list) {
    for (const kw of cat.keywords) {
      const k = normalize(kw).trim();
      const needle = kw.endsWith(' ') ? ' ' + k + ' ' : k;
      if (text.includes(needle) && k.length > bestLen) {
        best = cat.id;
        bestLen = k.length;
      }
    }
  }
  return best;
}

if (typeof module !== 'undefined') {
  module.exports = { GROUPS, EXPENSE_CATEGORIES, INCOME_CATEGORIES, CATEGORY_BY_ID, classify };
}

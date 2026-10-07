# 💶 Mis Finanzas

App web para registrar **gastos, ingresos, ahorro e inversión**. Sin instalación ni dependencias: abre `index.html` en el navegador. Los datos se guardan solo en tu navegador (`localStorage`); desde **Ajustes** puedes descargar/restaurar una copia.

## Usarla en el iPhone

1. Abre **https://cristinargvallarino-a11y.github.io/expenses-and-savings/** en **Safari**.
2. Pulsa **Compartir → Añadir a pantalla de inicio**.
3. Ábrela siempre desde ese icono: se abre a pantalla completa y funciona sin conexión.

> Ojo: la app instalada en la pantalla de inicio y la que abres en Safari guardan los datos por separado. Usa siempre la misma.

## Qué hace

**Resumen (por mes)**
- Ingresos, gastos, ahorro y tasa de ahorro, comparados con el mes anterior.
- ¿A dónde va tu dinero? Gasto por tipo: *Necesarios, Social y ocio, Viajes, Compras y caprichos, Suscripciones, Otros*.
- **Viajes por separado**: vuelos, hoteles y otros gastos de viaje, del mes y acumulado del año.
- Comparación con la regla 50/30/20, top categorías y evolución de los últimos 6 meses.

**Movimientos**
- Añade gastos e ingresos; la categoría **se sugiere sola** según la descripción (p. ej. "Mercadona" → Supermercado, "Ryanair" → Vuelos, "Booking" → Hoteles). Siempre puedes cambiarla.
- Editar / borrar, copiar los gastos fijos (vivienda, facturas, seguros) del mes anterior.
- Importar el CSV del banco (fecha, descripción, importe; negativo = gasto): se clasifica automáticamente.

**Ahorro e inversión**
- Tu **ritmo de ahorro** = media de (ingresos − gastos) de los últimos meses cerrados (configurable, o fijado a mano).
- Objetivos con importe, lo que ya tienes, aportación mensual (o tu ritmo), rentabilidad anual esperada y fecha límite opcional.
- Para cada objetivo: **cuánto tardarás en llegar y en qué mes**, y si llegas a tiempo a la fecha límite (y cuánto necesitarías al mes).
- Simulador "¿y si ahorrase X € más al mes?" y gráfico de proyección con interés compuesto.

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html` | Interfaz |
| `styles.css` | Estilos (modo claro y oscuro) |
| `categories.js` | Grupos, categorías y clasificador por palabras clave |
| `finance.js` | Cálculos: resúmenes, ritmo de ahorro, tiempo hasta objetivo |
| `app.js` | Estado, vistas y gráficos |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalación en el móvil y uso sin conexión |

Para añadir palabras a la clasificación automática, edita las listas `keywords` de `categories.js`.

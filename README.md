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
- Importar el extracto del banco en **CSV o Excel**: detecta solo las columnas (fecha, concepto, importe o cargo/abono; ignora el saldo), muestra una vista previa, evita duplicados y recuerda el formato de cada banco.

**Ahorro e inversión**
- Tu **ritmo de ahorro** = media de (ingresos − gastos) de los últimos meses cerrados (configurable, o fijado a mano).
- Objetivos con importe, lo que ya tienes, aportación mensual (o tu ritmo), rentabilidad anual esperada y fecha límite opcional.
- Para cada objetivo: **cuánto tardarás en llegar y en qué mes**, y si llegas a tiempo a la fecha límite (y cuánto necesitarías al mes).
- Simulador "¿y si ahorrase X € más al mes?" y gráfico de proyección con interés compuesto.

## Guardar en Google (varios dispositivos y usuarios)

Con **Entrar con Google**, los datos se guardan en una carpeta oculta del Google Drive de cada usuario (solo esta app puede usarla) y se sincronizan entre dispositivos. Cada persona entra con su cuenta y solo ve sus datos.

Para activarlo hay que poner el *ID de cliente* de Google Cloud en `config.js`.

## Seguridad y privacidad

- **Dónde están tus datos:** en el almacenamiento de tu navegador y, si entras con Google, en la carpeta oculta de la app en tu Google Drive (solo esta app puede leerla; ni siquiera aparece en tu Drive). El repositorio y la web solo contienen código.
- **Google:** permisos mínimos (`drive.appdata`, tu email); el acceso caduca cada hora y se renueva solo. Cada sesión se comprueba antes de sincronizar para no mezclar cuentas.
- **Todo lo que entra se valida** (copias restauradas, archivo de Drive, datos guardados) y todo lo que se muestra se escapa: un texto de un extracto o un archivo manipulado no puede ejecutar código.
- **Política de seguridad (CSP):** la página solo puede cargar sus propios archivos y hablar con la API de Google; aunque se colara código, no podría ejecutarse ni enviar datos fuera.
- **Excel** se lee en un proceso aislado (Web Worker), porque la librería SheetJS 0.18.5 tiene fallos conocidos con archivos manipulados.
- **Sin terceros:** sin analítica ni publicidad; las tipografías están alojadas en la propia app.
- **Dispositivos compartidos:** usa "Cerrar sesión" al terminar y cierra también tu sesión de Google en ese navegador.

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html` | Interfaz |
| `styles.css` | Estilos (modo claro y oscuro) |
| `categories.js` | Grupos, categorías y clasificador por palabras clave |
| `finance.js` | Cálculos: resúmenes, ritmo de ahorro, tiempo hasta objetivo |
| `app.js` | Estado, vistas y gráficos |
| `importer.js` | Lectura de extractos bancarios (CSV/Excel) |
| `lib/xlsx.full.min.js` | [SheetJS](https://sheetjs.com) 0.18.5 (Apache 2.0) para leer Excel |
| `validate.js` | Validación de datos que entran (copias, Drive, navegador) |
| `xlsx-worker.js` | Lectura de Excel en un proceso aislado |
| `fonts.css`, `fonts/` | Tipografías Fraunces y DM Sans (SIL OFL) alojadas en la app |
| `sync.js` | Inicio de sesión con Google y sincronización con Drive |
| `config.js` | Configuración (ID de cliente de Google) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalación en el móvil y uso sin conexión |

Para añadir palabras a la clasificación automática, edita las listas `keywords` de `categories.js`.

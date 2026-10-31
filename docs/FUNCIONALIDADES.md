# Funcionalidades y decisiones de diseño

Este documento lista las funcionalidades de Rounded Window Corners Plane y,
sobre todo, **por qué** se implementaron de la forma en que están. La idea es
que antes de cambiar algo se pueda saber qué problema resolvía, para no
reintroducirlo.

Cada entrada tiene:

- **Qué hace**: el comportamiento visible.
- **Por qué**: el problema que motivó la implementación.
- **Dónde**: archivos principales.

Al agregar o cambiar una funcionalidad, actualiza su entrada o agrega una
nueva en la sección de historial.

---

## Renderizado

### Efecto: buffer propio a la escala real más un efecto de espacio para la sombra

- **Qué hace**: el efecto dibuja la ventana en un buffer offscreen a la escala
  real del monitor, alineado a la cuadrícula de píxeles de la pantalla; el
  shader la recorta a su forma redondeada y dibuja el borde, la sombra y el
  contorno. `ShadowRoomEffect` va antes y solo agranda el paint volume para que
  el buffer tenga espacio para la sombra. Hay un solo buffer por ventana y
  escala; el de otra escala se suelta a los 5 s sin usarse, y todos al
  desactivar el efecto.
- **Por qué**: es el diseño de
  [Rounded Window Corners Native](https://github.com/ztrahmet/rounded-window-corners).
  Con él gnome-shell usaba 200–450 MiB menos de VRAM que con el renderizador
  propio y el consumo era estable (ver el
  [historial](#historial-de-buffers-offscreen)). Mientras la ventana no se
  repinta, el buffer se reutiliza y solo vuelve a correr el shader, así que
  cambiar uniformes (foco, fundidos) no re-renderiza la ventana.
- **Por qué no `Clutter.ShaderEffect`**: Native lo usa, pero su buffer va a
  `ceil(escala)` (2x a 150 %) y luego se reduce, lo que deja el texto borroso.
  A la escala real el buffer además es más chico (1,5² en vez de 2²).
- **Dónde**: `src/effect/rounded_corners_effect.ts`.

### Los efectos se agregan una vez y luego solo se apagan

- **Qué hace**: cuando el aspecto de la ventana no dibuja nada (por ejemplo,
  maximizada con el estilo de libadwaita), el efecto y el espacio de sombra se
  desactivan en vez de quitarse.
- **Por qué**: así quedan antes de efectos offscreen que se agregan después,
  como el atenuador de GNOME Shell detrás de un diálogo; si se volvieran a
  agregar, quedarían dentro de su buffer y la sombra se cortaría. Un efecto
  desactivado no tiene buffer, así que esas ventanas no cuestan nada.

### Sombra calculada como en GTK

- **Qué hace**: cada capa de `box-shadow` (hasta seis) se dibuja con su
  desplazamiento, spread, desenfoque y color, en el orden de GTK, con el
  algoritmo de `gskgpuboxshadow.glsl`. Las esquinas se integran por separado.
- **Por qué**: la sombra anterior era una aproximación de una sola capa negra y
  no coincidía con la de las apps libadwaita.
- **Dónde**: `shader/rounded_corners.frag`, `src/effect/shadow.ts`.

### Reemplazo del borde de la app

- **Qué hace**: el shader pinta sobre el borde fino de 1 px que dibujan las
  apps GTK3/adw-gtk3 con el color de un poco más adentro, para que se vea un
  solo contorno. A escala fraccional llega un poco más adentro porque ese
  borde se difumina. No se hace cuando hay margen, porque el borde de la app
  queda dentro del margen recortado.
- **Por qué**: sin esto se veían dos contornos, el de la app y el del efecto.

### Compatibilidad con efectos que deforman la ventana

- **Qué hace**: las ventanas gelatinosas de *Compiz windows effect* y la
  lámpara mágica de *Compiz alike magic lamp effect* deforman la ventana ya
  redondeada, con borde incluido. La sombra se oculta durante la deformación y
  reaparece con un fundido de 150 ms.
- **Por qué**: Clutter aplica los efectos en el orden en que se agregaron, y
  cada uno envuelve a los que se agregaron después. Esos efectos se agregan
  después del nuestro, así que la máscara recortaba la ventana deformada en el
  marco original (se veía "cortada por dentro", también en Native). Por eso,
  al detectar un `Clutter.DeformEffect` activo después del nuestro, se mueven
  el espacio de sombra y el efecto detrás de él, y los demás efectos que
  estaban detrás (como el atenuador) se mantienen detrás. La sombra se oculta
  porque el buffer del efecto de deformación se dimensiona con los efectos que
  van antes que él y no tiene espacio para ella.
- **Dónde**: `#checkDeformation`, `#moveAfterDeformations` en
  `rounded_corners_effect.ts`. Se probó con `Clutter.PageTurnEffect`.

### Soporte de GNOME Shell 51

- **Qué hace**: el efecto se basa en `Clutter.Effect`, un `Cogl.Pipeline`
  propio y `Cogl.Snippet`.
- **Por qué**: GNOME 51 eliminó `Shell.GLSLEffect`, que era la base del efecto
  original.

---

## Estilo: se sigue a GTK

### Radio, borde, contorno, sombra y margen desde libadwaita y `gtk.css`

- **Qué hace**: el estilo de la ventana se calcula como GTK lo hace para una
  ventana libadwaita: la hoja de libadwaita, el color de acento y
  `~/.config/gtk-4.0/gtk.css` (con sus `@import`) encima, con las reglas de
  cascada y especificidad de GTK. Claro, oscuro y alto contraste se eligen con
  las mismas media queries. Los cambios en `gtk.css` se aplican en vivo.
- **Por qué**: antes había que replicar en las preferencias lo que ya estaba en
  `gtk.css` (radio, colores de borde con y sin foco, sombras, margen), y las
  apps libadwaita y las demás quedaban distintas. Ahora hay una sola fuente.
- **Límites**: el borde se dibuja en un solo color (el de arriba); los anchos
  por lado sí se respetan. Los radios elípticos se dibujan como círculos.
- **Dónde**: `src/style/`. GNOME Shell no puede cargar libadwaita, así que
  `adw_probe.js` imprime su hoja con `gjs`; si falla se usa una copia de sus
  reglas de ventana (`FALLBACK_CSS`).

### Estados de la ventana con las clases de GTK

- **Qué hace**: cada ventana se estiliza con las clases que GTK le daría:
  `maximized`, `fullscreen` o `tiled-top/bottom/left/right` (los bordes en
  mosaico como en Wayland, calculados con el área de trabajo y la ventana
  emparejada), además de `:backdrop` sin foco. Así una regla como
  `window.tiled { margin: 2px }` o `window.maximized { border-radius: 16px }`
  aplica a todas las apps.
- **Maximizada y pantalla completa también llevan los cuatro `tiled-*`**:
  Mutter le dice a la app que está acoplada en todos los bordes, así que GTK
  aplica también las reglas de mosaico (por ejemplo su `margin`). Como GTK no
  deja espacio fuera de esas ventanas, lo que se dibujaría más allá del marco
  (la sombra, o el anillo de 1 px que libadwaita le pone sin foco por su regla
  `tiled-*:backdrop`) se recorta, y si solo quedaría eso el efecto se apaga.
- **Como en libadwaita**, el aspecto cambia cuando la app ya dibujó su nuevo
  tamaño, no cuando cambia el estado, para no mostrar un frame con el tamaño
  viejo y el aspecto nuevo. Si el tamaño no cambia (por ejemplo pantalla
  completa sobre una ventana que ya la llenaba), se aplica a los 300 ms.
- **Dónde**: `#stateClasses`, `sync` en `src/manager/window_tracker.ts`.

### Margen de la ventana

- **Qué hace**: el `margin` del estilo se recorta dentro del marco de la
  ventana, y la ventana conserva su tamaño, como hace GTK con sus propias
  ventanas.
- **Por qué**: reemplaza la opción "margen exterior", que reservaba espacio en
  el área de trabajo de GNOME parcheando `Meta.Workspace.set_builtin_struts`.
  Con el margen tomado de `gtk.css` ya no hay que configurarlo dos veces, cada
  estado puede tener el suyo y no se parchea nada de GNOME Shell. Las apps
  libadwaita aplican ese mismo margen dentro de su ventana, así que reservar
  además espacio en el área de trabajo lo duplicaba en ellas.
- **Contrapartida**: en apps no libadwaita se recortan esos píxeles del borde
  del contenido.

---

## Comportamiento de ventanas

### Ocultar efectos al mover o redimensionar

- **Qué hace**: opcional (activado por defecto). Mientras una ventana se mueve
  o cambia de tamaño con el puntero, el efecto se desactiva; al terminar vuelve
  con un fundido de 180 ms. Un clic en la barra de título no lo oculta.
- **Por qué**: durante el arrastre la geometría cambia en cada frame. Se
  respeta la preferencia de GNOME de desactivar animaciones.
- **Dónde**: `beginGrab`, `#geometryChanged`, `endGrab`, `#fadeIn` en
  `window_tracker.ts`.

### Lista negra y lista blanca de aplicaciones

- **Qué hace**: excluir aplicaciones (lista negra) o limitar el efecto a
  algunas (lista blanca) por `wmClass`.
- **Por qué**: algunas aplicaciones dibujan sus propias esquinas o se ven mal
  recortadas. Se usa `wmClass` porque es estable.
- **Dónde**: `isListed` en `window_tracker.ts`,
  `src/preferences/pages/blacklist.ts`.

### Las apps libadwaita se omiten siempre

- **Qué hace**: no se aplica el efecto a ventanas cuyo proceso cargó
  `libadwaita-1.so` (se lee `/proc/<pid>/maps`).
- **Por qué**: ya dibujan su propio radio, borde y sombra desde el mismo CSS;
  aplicarlo duplicaba borde y sombra. Ya no es una opción.

### Selector de ventanas en las preferencias

- **Qué hace**: en las preferencias se puede hacer clic en una ventana para
  obtener su clase.
- **Por qué**: las preferencias corren en un proceso aislado sin acceso a
  GNOME Shell. Un servicio D-Bus exportado por la extensión abre el selector
  de Looking Glass y devuelve la clase de la ventana elegida.
- **Dónde**: `src/window_picker/`.

---

## Quitado al seguir a GTK

Para no volver a agregarlo sin motivo:

- **Radio, color de borde con y sin foco, ancho de borde, suavizado
  (squircle), sombras con y sin foco, padding y ajustes por aplicación**: salen
  de `gtk.css`. El squircle no existe en CSS.
- **Mantener esquinas o sombra al maximizar o en pantalla completa**: se
  escribe en `gtk.css` con `window.maximized` / `window.fullscreen`.
- **Presupuesto de VRAM, LRU, `System.gc()` forzado, descarte por monitor y
  ajuste a píxeles físicos**: eran del renderizador propio.
- **Ajuste para Kitty y refresco tras desminimizar Chromium**: los límites del
  efecto salen del tamaño de la textura y de los rectángulos de buffer y marco
  en cada cambio de tamaño, no del tamaño del actor, que era lo que fallaba.
- **Omitir apps libhandy**: estaba desactivado por defecto y Native no lo hace.

---

## Historial de buffers offscreen

La forma de renderizar las ventanas offscreen cambió varias veces. Este es el
orden y la razón de cada cambio:

1. **`Clutter.OffscreenEffect` por ventana** (heredado de Reborn). Un buffer
   por ventana, renderizado a `ceil(escala)`. Texto borroso con escalado
   fraccional y la sombra en un actor aparte, también offscreen a 2x.
2. **Efecto propio a la escala real, un buffer por ventana.** Resuelve la
   nitidez, pero el consumo de VRAM llegó a **varios GB**: un buffer por
   ventana y por escala sin límite, más texturas descartadas que GJS no
   liberaba hasta una recolección de basura.
3. **Un único buffer compartido por escala** (commit `045db50`). La VRAM baja
   al tamaño de una ventana por escala. Efecto secundario: el overview se ve
   cortado y pausado, porque cada ventana (y cada clon de las miniaturas) se
   vuelve a renderizar en el buffer en cada frame, con un `flush()` a la GPU
   entre ventanas.
4. **Buffer por ventana con presupuesto de 512 MiB y reemplazo LRU**. Las
   ventanas conservan su render mientras quepan en el presupuesto; la VRAM de
   estos buffers tiene un tope fijo, y si no alcanza se degrada al
   comportamiento del paso 3 en vez de crecer. La recolección de basura
   forzada sigue activa para que las texturas descartadas no se acumulen.
5. **Sin `LinearFilterEffect` en el overview**. Con el paso 4
   el overview seguía con tirones y gnome-shell llegaba a 4 GB de VRAM. El
   responsable era el filtro lineal de las vistas previas, que creaba un FBO
   a 2x con mipmaps por ventana en cada apertura del overview, fuera del
   presupuesto (ver "Vistas previas del overview sin efectos extra"). Sin
   él, las vistas previas reutilizan el buffer de cada ventana.
6. **Sin buffers para monitores que no muestran la ventana**. Al contar el
   coste real (8 B/píxel) y liberar por temporizador, la VRAM no bajaba: los
   logs mostraron que cada ventana se pintaba también en los monitores donde
   estaba fuera de pantalla, con un buffer por escala.
   Con eso el coste de la extensión pasó de ~470 MiB a ~110–190 MiB.
7. **Deformaciones a la escala del monitor**. Al maximizar con *Compiz
   windows effect*, el efecto creaba un buffer extra a 2x de unos 113 MiB por
   ventana; ahora reutiliza el de la ventana. Antes se probó no pintar las
   ventanas tapadas, pero no se puede saber si una ventana es opaca (ver
   "Probado y descartado").
8. **Todo pintado offscreen a la escala del monitor**. Otra animación seguía
   pintando todas las ventanas a 2x (416 MiB de pico).
9. **`Clutter.ShaderEffect`, como Rounded Window Corners Native**. Medido con `nvidia-smi` en el mismo escritorio: gnome-shell usaba
   1292 MiB con Native y 1510–1743 MiB con el paso 8, que además variaba entre
   mediciones porque las texturas soltadas esperaban al recolector de GJS. El
   texto a 150 % no se veía distinto en la práctica, y redimensionar era más
   fluido con Native. Se adoptó su efecto, su lector de CSS y su sombra, y se
   eliminaron el presupuesto, el LRU, la recolección forzada y el descarte por
   monitor: Clutter dimensiona y libera el buffer en C.
10. **Buffer propio a la escala real**. Con `ShaderEffect` el
   texto se veía borroso a 150 %, igual que con Native. Se volvió a un buffer
   propio a la escala del monitor y alineado a los píxeles de la pantalla, pero
   uno solo por ventana y escala, sin presupuesto ni LRU, y soltado al
   desactivar el efecto. En una prueba a 125 % el interior de la ventana quedó
   idéntico píxel a píxel con y sin el efecto.
11. **Nada de GPU retenido desde JS al pintar** (estado actual). Con el paso 10
   gnome-shell llegaba a 15 GB de VRAM al arrastrar ventanas con Compiz wobbly
   y Chrome abierto, y todo daba tirones; en reposo volvía a ~850 MiB. Cada
   objeto de GPU que `vfunc_paint` tocaba desde JS quedaba vivo hasta que
   pasaba el recolector de GJS:
   - el framebuffer del efecto que deforma la ventana, que Clutter asigna de
     nuevo en cada frame mientras cambia de tamaño;
   - el buffer actual de la app, que Chrome cambia en cada frame;
   - el pipeline, que Cogl copiaba entero al modificarlo mientras los nodos de
     pintado guardaban copias suyas.

   Ahora el efecto no pide el framebuffer mientras la ventana está deformada,
   la escala de la app se mide solo al cambiar de tamaño o de monitor, y cada
   pintado usa su propia copia del pipeline, que no se vuelve a tocar. Con eso
   la VRAM al arrastrar queda plana, como con Native. Además se conservan los
   buffers al reordenar los efectos, al apagar el efecto unos segundos y en
   ventanas quietas, y con el modo debug se registra cada buffer asignado.
